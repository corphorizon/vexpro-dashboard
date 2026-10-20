import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  leerNetDelCrm,
  leerPnlInputDelCrm,
  type CrmNetRow,
  type CrmPnlInputRow,
} from './crm-net-server';

// ─────────────────────────────────────────────────────────────────────────────
// La cache de los insumos CRM de /comisiones — REGISTRO ÚNICO del cómputo.
//
// ── POR QUÉ (dueño, 2026-10-20) ────────────────────────────────────────────
// GET /api/admin/commission-net-input corría EN VIVO, por visita, las dos RPC
// pesadas (`hr_net_deposit_by_profile` y `hr_pnl_input_by_profile`, ésta
// última es la que lee `crm_ib_reward_daily`). Cada una tiene 30 s de
// statement_timeout y el cliente reintenta tres veces: una visita mala eran
// ~95 s de «Cargando…» y después «sin datos». Si alguien guardaba en esa
// ventana, FIJABA valores incompletos — septiembre se cerró con grupos a
// medias. Ver la cabecera de supabase/migration-132-insumos-comisiones-cache.sql.
//
// ── QUÉ HAY ACÁ ────────────────────────────────────────────────────────────
//   · `recomputarInsumosComisiones`: corre las MISMAS dos RPC que corría el
//     GET (las de crm-net-server.ts, no una copia), en paralelo, y escribe el
//     resultado en `hr_insumos_comisiones` con merge por columna. La llaman el
//     cron sync-crm, el botón «Actualizar» y el fallback del GET. Nadie más
//     escribe esa tabla.
//   · `leerInsumosDeCache`: devuelve lo guardado con LA MISMA FORMA que
//     devuelven las RPC (`CrmNetRow[]`, `CrmPnlInputRow[]`), para que el GET
//     arme la respuesta por el mismo camino de siempre — `separarNetDelCrm` +
//     `buildRollup` + la inversión del signo — sin saber de dónde vino.
//
// ── LA SEMÁNTICA QUE SE COPIA DEL GET, EXACTA ─────────────────────────────
//   · Las RPC corren en PARALELO: la del PnL no empuja el tiempo de la del ND.
//   · Un error del PnL NO tumba el ND (son dos grupos de gente distintos). Acá
//     eso quiere decir: cada métrica que falla deja sus columnas COMO ESTABAN
//     y anota el error; la que llegó se escribe igual.
//   · El signo del PnL NO se toca: se guarda crudo. El único punto de
//     inversión sigue siendo el GET.
//   · null ≠ 0: lo que la RPC no trajo viaja `null` y queda NULL.
//
// ── MERGE POR COLUMNA (la decisión que pidió el dueño) ─────────────────────
// Si una RPC falló entera, su métrica viaja `null` a la función SQL y sus
// columnas NO se tocan: un timeout a las 03:35 no degrada a NULLs una cache
// que estaba buena a las 23:35. La que llegó se reemplaza ENTERA para el mes
// (quien ya no viene pierde su valor). Si fallan LAS DOS no se llama a la
// función: no hay nada que escribir y la cache queda intacta. La regla vive
// en SQL (`hr_insumos_comisiones_aplicar`, una transacción); acá sólo se
// decide QUÉ métrica viaja — no hay una segunda implementación del merge.
//
// DESCARTADO: DELETE+INSERT del mes entero desde TypeScript. Sin transacción
// entre las tres escrituras un lector ve un mes a medio armar, y con un
// DELETE previo un timeout del PnL borraría el PnL bueno.
// ─────────────────────────────────────────────────────────────────────────────

/** PostgREST corta en 1.000 filas SIN AVISAR. Hoy son ~126 perfiles por mes. */
const PAGE = 1000;

/**
 * `2026-07` o `2026-07-DD` → `2026-07-01`; cualquier otra cosa → null.
 *
 * Era el `parseMonth` privado del GET (mismo regex, mismo resultado); se mudó
 * acá porque ahora lo usan también el refresh y el recomputo, y tres copias de
 * un regex de fechas son tres lugares donde un mes mal formado puede pasar.
 */
export function parseMesInsumos(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(raw)) return null;
  return `${raw.slice(0, 7)}-01`;
}

/**
 * Los meses que el cron recalcula: el ANTERIOR y el EN CURSO, en ese orden.
 *
 * Los dos porque las comisiones se liquidan a mes vencido: el día 5 se paga
 * el mes anterior, y ese número tiene que estar fresco aunque el mes ya haya
 * terminado (el CRM sigue asentando retiros y PnL de los últimos días). El
 * anterior va PRIMERO: si el presupuesto de tiempo del cron se acaba, que se
 * pierda el que todavía no se liquida.
 *
 * En UTC, igual que el día 1 que reciben las RPC.
 */
export function mesesDeLiquidacion(ahora: Date): [anterior: string, enCurso: string] {
  const y = ahora.getUTCFullYear();
  const m = ahora.getUTCMonth(); // 0-11
  const fmt = (yy: number, mm: number) => `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
  const anterior = m === 0 ? fmt(y - 1, 11) : fmt(y, m - 1);
  return [anterior, fmt(y, m)];
}

// ── Payloads hacia la función SQL ──────────────────────────────────────────

export type PayloadNd = {
  /** Net de los clientes sin perfil. `null` = la RPC no trajo fila huérfana. */
  huerfano: number | null;
  filas: { profile_id: string; nd: number | string | null; nd_clients: number | string | null }[];
};

export type PayloadPnl = {
  filas: {
    profile_id: string;
    pnl_crm: number | string | null;
    lotes: number | string | null;
    usuarios_red: number | string | null;
  }[];
};

/**
 * Las filas de `hr_net_deposit_by_profile` → lo que guarda la cache.
 *
 * Los valores viajan CRUDOS (texto o número, como los dio PostgREST): el cast
 * a `numeric` lo hace Postgres, sin pasar por un float de JS.
 *
 * La única conversión es la del huérfano, y es la MISMA que hace
 * `separarNetDelCrm` al leer (`Number(net) || 0`, sumado): así lo que se
 * reconstruye da el mismo `unassigned` que daba la RPC en vivo.
 *
 * Un `profile_id` repetido gana el último — lo mismo que el `Map.set` de
 * `separarNetDelCrm` — y es además lo que exige el `on conflict` de la
 * función (un INSERT no puede tocar dos veces la misma fila).
 */
export function armarPayloadNd(rows: readonly CrmNetRow[]): PayloadNd {
  const porPerfil = new Map<string, PayloadNd['filas'][number]>();
  let huerfano: number | null = null;
  for (const r of rows) {
    if (r.profile_id) {
      porPerfil.set(r.profile_id, {
        profile_id: r.profile_id,
        nd: r.net ?? null,
        nd_clients: r.clients ?? null,
      });
    } else {
      huerfano = (huerfano ?? 0) + (Number(r.net) || 0);
    }
  }
  return { huerfano, filas: [...porPerfil.values()] };
}

/** Las filas de `hr_pnl_input_by_profile` → lo que guarda la cache. Signo CRUDO. */
export function armarPayloadPnl(rows: readonly CrmPnlInputRow[]): PayloadPnl {
  const porPerfil = new Map<string, PayloadPnl['filas'][number]>();
  for (const r of rows) {
    if (!r.profile_id) continue;
    porPerfil.set(r.profile_id, {
      profile_id: r.profile_id,
      // CRUDO: negativo = los clientes perdieron. NO se invierte acá.
      pnl_crm: r.pnl_crm ?? null,
      lotes: r.com_lotes ?? null,
      usuarios_red: r.usuarios_red ?? null,
    });
  }
  return { filas: [...porPerfil.values()] };
}

// ── Recomputar ─────────────────────────────────────────────────────────────

export type InsumosCrudos = {
  /** `null` = la RPC del ND falló. */
  netRows: CrmNetRow[] | null;
  /** `null` = la RPC del PnL falló. */
  pnlRows: CrmPnlInputRow[] | null;
};

export type ResultadoRecomputo = {
  /** Filas del mes en la cache DESPUÉS de escribir (0 si no se escribió). */
  filas: number;
  /** Mensajes fijos, sin el error de Postgres (que va al log del servidor). */
  errores: string[];
  /** ¿Se escribió algo? `false` con las dos RPC caídas o con la escritura caída. */
  escrito: boolean;
  /** Hora de ESTA escritura; `null` si no se escribió. */
  computedAt: string | null;
  /** Frescura por métrica según la cabecera, después de escribir. */
  ndComputedAt: string | null;
  pnlComputedAt: string | null;
  /** Lo que devolvieron las RPC, para el GET cuando la cache no se pudo escribir. */
  crudos: InsumosCrudos;
  /** Lo que tardó todo (RPC + escritura). Para el presupuesto del cron. */
  ms: number;
};

export const ERROR_ND = 'nd: la RPC hr_net_deposit_by_profile falló; se conserva el ND anterior de la cache';
export const ERROR_PNL = 'pnl: la RPC hr_pnl_input_by_profile falló; se conserva el PnL anterior de la cache';
export const ERROR_ESCRITURA = 'cache: no se pudo escribir hr_insumos_comisiones (¿migración 132 aplicada?)';

/**
 * Recalcula los insumos CRM de un mes y los deja en la cache.
 *
 * @param mes `YYYY-MM-01`. Cualquier otra forma lanza: un mes mal formado
 *   llegaría a las RPC como otro mes, o como ninguno, sin dar error.
 */
export async function recomputarInsumosComisiones(
  admin: SupabaseClient,
  companyId: string,
  mes: string,
): Promise<ResultadoRecomputo> {
  if (parseMesInsumos(mes) !== mes) {
    throw new Error(`recomputarInsumosComisiones: mes inválido «${mes}» (se espera YYYY-MM-01)`);
  }
  const t0 = Date.now();

  // En paralelo, como el GET: son independientes y la del PnL no puede
  // empujar el tiempo de la del ND. Las dos devuelven null al fallar, nunca [].
  const [netRows, pnlRows] = await Promise.all([
    leerNetDelCrm(admin, companyId, mes),
    leerPnlInputDelCrm(admin, companyId, mes),
  ]);
  const crudos: InsumosCrudos = { netRows, pnlRows };

  const errores: string[] = [];
  if (!netRows) errores.push(ERROR_ND);
  if (!pnlRows) errores.push(ERROR_PNL);

  const sinEscribir = (): ResultadoRecomputo => ({
    filas: 0,
    errores,
    escrito: false,
    computedAt: null,
    ndComputedAt: null,
    pnlComputedAt: null,
    crudos,
    ms: Date.now() - t0,
  });

  // Las dos cayeron: no hay nada que escribir y la cache queda como estaba.
  if (!netRows && !pnlRows) return sinEscribir();

  let data: unknown;
  try {
    const res = await admin.rpc('hr_insumos_comisiones_aplicar', {
      p_company_id: companyId,
      p_mes: mes,
      // `null` = esa RPC falló → la función NO toca sus columnas.
      p_nd: netRows ? armarPayloadNd(netRows) : null,
      p_pnl: pnlRows ? armarPayloadPnl(pnlRows) : null,
    });
    if (res.error) {
      console.error('[insumos-comisiones] escritura falló:', res.error);
      errores.push(ERROR_ESCRITURA);
      return sinEscribir();
    }
    data = res.data;
  } catch (err) {
    console.error('[insumos-comisiones] escritura lanzó:', err);
    errores.push(ERROR_ESCRITURA);
    return sinEscribir();
  }

  const out = (data ?? {}) as {
    filas?: number;
    descartadas?: number;
    computed_at?: string;
    nd_computed_at?: string | null;
    pnl_computed_at?: string | null;
  };
  // Filas cuyo perfil no es de esta empresa (o se borró entre la RPC y la
  // escritura). La función las descarta para no tumbar el mes entero; acá se
  // CUENTAN y se dicen: una exclusión silenciosa es indistinguible de un cruce
  // roto (§1.2).
  if (out.descartadas && out.descartadas > 0) {
    errores.push(`cache: ${out.descartadas} fila(s) de la RPC con un perfil que no es de esta empresa; no se guardaron`);
  }

  return {
    filas: Number(out.filas) || 0,
    errores,
    escrito: true,
    computedAt: out.computed_at ?? new Date().toISOString(),
    ndComputedAt: out.nd_computed_at ?? null,
    pnlComputedAt: out.pnl_computed_at ?? null,
    crudos,
    ms: Date.now() - t0,
  };
}

// ── Leer ───────────────────────────────────────────────────────────────────

/** Lo que el GET necesita para armar la respuesta, venga de la cache o en vivo. */
export type InsumosDelMes = {
  /** `null` = no hay ND (la RPC falló y no había cache). */
  netRows: CrmNetRow[] | null;
  /** `null` = no hay PnL: el GET responde `pnlEntries: null` + `pnlError`. */
  pnlRows: CrmPnlInputRow[] | null;
  ndComputedAt: string | null;
  pnlComputedAt: string | null;
};

export type LecturaCache =
  | { estado: 'ok'; insumos: InsumosDelMes }
  /** No hay cabecera, o el ND nunca salió bien: hay que calcular en vivo. */
  | { estado: 'sin-cache' }
  /** La lectura falló (p. ej. la 132 todavía no está aplicada). */
  | { estado: 'error' };

type FilaCache = {
  profile_id: string;
  nd: number | string | null;
  nd_clients: number | string | null;
  pnl_crm: number | string | null;
  lotes: number | string | null;
  usuarios_red: number | string | null;
  en_rpc_nd: boolean;
  en_rpc_pnl: boolean;
};

/**
 * Lo guardado para (empresa, mes), con la forma de las RPC.
 *
 * Sólo trae lo que cada RPC trajo (`en_rpc_nd` / `en_rpc_pnl`): un perfil que
 * no es del grupo PnL NO aparece en `pnlRows`, igual que en vivo. Si el PnL
 * nunca salió bien (`pnl_computed_at` NULL), `pnlRows` es `null` — el mismo
 * «falló» que en vivo, nunca un `[]` que diría «no hay perfiles PnL».
 */
export async function leerInsumosDeCache(
  admin: SupabaseClient,
  companyId: string,
  mes: string,
): Promise<LecturaCache> {
  try {
    const cab = await admin
      .from('hr_insumos_comisiones_mes')
      .select('nd_huerfano, nd_computed_at, pnl_computed_at')
      .eq('company_id', companyId)
      .eq('mes', mes)
      .maybeSingle();
    if (cab.error) {
      console.error('[insumos-comisiones] cabecera falló:', cab.error);
      return { estado: 'error' };
    }
    const c = cab.data as {
      nd_huerfano: number | string | null;
      nd_computed_at: string | null;
      pnl_computed_at: string | null;
    } | null;
    if (!c || !c.nd_computed_at) return { estado: 'sin-cache' };

    const filas: FilaCache[] = [];
    for (let from = 0; ; from += PAGE) {
      const res = await admin
        .from('hr_insumos_comisiones')
        .select('profile_id, nd, nd_clients, pnl_crm, lotes, usuarios_red, en_rpc_nd, en_rpc_pnl')
        .eq('company_id', companyId)
        .eq('mes', mes)
        // Orden obligatorio al paginar: sin él una página repite una fila y
        // se salta otra, sin dar error.
        .order('profile_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (res.error) {
        console.error('[insumos-comisiones] filas falló:', res.error);
        return { estado: 'error' };
      }
      const page = (res.data ?? []) as FilaCache[];
      filas.push(...page);
      if (page.length < PAGE) break;
    }

    const netRows: CrmNetRow[] = filas
      .filter((f) => f.en_rpc_nd)
      // `?? 0` es la MISMA conversión que hace `separarNetDelCrm`
      // (`Number(net) || 0`) un paso después: no es un cero nuevo, es el tipo.
      .map((f) => ({ profile_id: f.profile_id, net: f.nd ?? 0, clients: f.nd_clients }));
    if (c.nd_huerfano !== null && c.nd_huerfano !== undefined) {
      netRows.push({ profile_id: null, net: c.nd_huerfano });
    }

    const pnlRows: CrmPnlInputRow[] | null = c.pnl_computed_at
      ? filas
          .filter((f) => f.en_rpc_pnl)
          .map((f) => ({
            profile_id: f.profile_id,
            pnl_crm: f.pnl_crm,
            com_lotes: f.lotes,
            usuarios_red: f.usuarios_red,
          }))
      : null;

    return {
      estado: 'ok',
      insumos: {
        netRows,
        pnlRows,
        ndComputedAt: c.nd_computed_at,
        pnlComputedAt: c.pnl_computed_at,
      },
    };
  } catch (err) {
    console.error('[insumos-comisiones] lectura lanzó:', err);
    return { estado: 'error' };
  }
}

/**
 * La hora que se le muestra al usuario: la del dato MÁS VIEJO en pantalla.
 *
 * Con el merge por columna el ND puede ser de hoy y el PnL de ayer; decir la
 * hora del ND haría pasar por fresco un PnL viejo. Las métricas ausentes
 * (`null`) no cuentan: ya se avisan por su lado (`pnlError`).
 */
export function computedAtMasViejo(...fechas: (string | null | undefined)[]): string | null {
  let min: string | null = null;
  let minMs = Infinity;
  for (const f of fechas) {
    if (!f) continue;
    const ms = Date.parse(f);
    if (!Number.isFinite(ms)) continue;
    if (ms < minMs) {
      minMs = ms;
      min = f;
    }
  }
  return min;
}
