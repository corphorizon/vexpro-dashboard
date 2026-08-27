// ─────────────────────────────────────────────────────────────────────────────
// Espejo de la producción IB del CRM: lotes pagados, comisión, PNL, cantidad de
// pagos y el desglose forex / sintéticos.
//
// ── POR QUÉ ESPEJO Y NO CONSULTA AL VUELO (con las cifras) ─────────────────
// Medido en el Mongo de Orion el 2026-08-27:
//
//   `ib_reward_daily`     37.146 docs · 2025-10 → 2026-08 · ~5.500 por mes
//   `ibrewards`       11.829.132 docs · 2026-08-13 → 2026-08-27 · QUINCE DÍAS
//
// Por `ib_reward_daily` sola no haría falta espejar nada: son cuatro pantallas
// de datos y un $group al vuelo cuesta menos de un segundo. Lo que obliga son
// las otras dos cosas:
//
//   1. `ibrewards` es la ÚNICA que tiene símbolo, y agregarla al vuelo por mes
//      tarda minutos sobre 11,8M docs. La pantalla la abre una persona.
//   2. `ibrewards` SE PURGA a los quince días. Lo que no se copie hoy no se
//      puede recuperar mañana: sin este espejo el desglose forex/sintéticos
//      nunca va a tener más de dos semanas de historia.
//
// Lo que se guarda es diminuto porque el desglose son DOS clases: el día más
// movido tuvo 240 IB con actividad → ~500 filas/día, ~15.000 al mes. Se cambia
// una agregación de 11,8M docs por una lectura de 15.000 filas.
//
// ── EL DÍA ES EL DE LA OPERACIÓN, NO EL DEL PAGO ──────────────────────────
// El cron de premios acredita de madrugada lo del día anterior. Si se usara la
// fecha de acreditación toda la serie quedaría corrida un día y los bordes de
// mes se irían al mes equivocado. `ib_reward_daily.day` ya es el día del deal.
//
// ── LAS CENT YA VIENEN CONVERTIDAS ────────────────────────────────────────
// Verificado a escala sobre `commissiontrades` (rawLite.Volume ÷ lots por
// grupo, 2.279 filas): grupos normales 10.000 EXACTO en las 1.351 filas, grupos
// cent 1.000.000 EXACTO en las 928. Cien veces más, o sea que el lote cent ya
// está dividido por 100 en el campo `lots`. Acá no se divide nada; si alguien
// vuelve a dividir, los lotes cent quedan en cero contable.
//
// Moneda: USD en el 100% de las filas de las dos colecciones (verificado). Todo
// lo que sale de este módulo está en USD.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withOrionMongo } from '@/lib/api-integrations/orion-mongo/client';
import { classifyAssetClass, type AssetClass } from './asset-class';

/** Los ÚNICOS campos que se piden de cada colección. La proyección es la aduana. */
export const ORION_IB_REWARD_DAILY_FIELDS = [
  'ibUserId', 'day', 'totalLots', 'totalCommission', 'totalPnl', 'rewardsCount',
] as const;

/**
 * Cuántos días hacia atrás se recalcula el desglose aunque ya estén espejados.
 *
 * Tres, y no uno: el pipeline del bróker sigue escribiendo premios de un día
 * durante las horas siguientes (el día 2026-08-27 tenía 77.650 premios a las
 * 10:00 y la ventana seguía abierta), y `ibrewards` recibe además reprocesos.
 * Con uno solo, el último día del mes quedaba congelado a medias.
 */
export const REDO_DAYS = 3;

/**
 * Techo de días de desglose por corrida. El primer arranque tiene quince días
 * de `ibrewards` para procesar y cada día son entre 25.000 y 1.950.000 premios:
 * hacerlos todos en una invocación se come los 300 s de la función. Se hacen de
 * a cuatro y las corridas siguientes terminan el trabajo — un espejo a medias
 * es visible (la pantalla dice de qué días hay dato), un timeout no.
 */
export const MAX_SYMBOL_DAYS_PER_RUN = 4;

/**
 * Hasta dónde mirar hacia atrás buscando días de desglose sin espejar.
 * `ibrewards` cubrió 15 días completos el 2026-08-27 (2026-08-13 → 2026-08-27);
 * 21 deja margen si el bróker afloja la purga sin avisar, y acota el trabajo si
 * la aprieta.
 */
export const SYMBOL_LOOKBACK_DAYS = 21;

/**
 * Cuántos IB por consulta a Mongo.
 *
 * ── POR QUÉ NO SE PUEDE AGREGAR `ibrewards` DE UNA ─────────────────────────
 * El lector compartido de Orion cierra el socket a los 15 s a propósito
 * (ORION_MONGO_SOCKET_TIMEOUT_MS), y CUALQUIER agregación que filtre por fecha
 * sobre `ibrewards` es un barrido completo: los índices de la colección son
 * `{ibUserId,dealTime}`, `{traderUserId,dealTime}`, `{loginAccount,dealTime}`,
 * `{dealId,ibLevel}` y `{normalizedDealKey}` — NINGUNO empieza por `dealTime`.
 * Medido: un $min/$max de `dealTime` sobre los 11.829.132 documentos se pasa de
 * los 15 s y la corrida muere entera.
 *
 * Con `ibUserId` al frente el mismo trabajo entra por el índice
 * `{ibUserId:1, dealTime:-1}` y cada consulta toca sólo el rango de un IB. Se
 * mandan de a 12 para que hasta el IB más grande del día (816.009 premios
 * repartidos entre 240 IB) entre cómodo en la ventana de 15 s.
 */
export const IB_BATCH = 12;

/**
 * Presupuesto de tiempo de la corrida. La función del cron tiene
 * `maxDuration = 300`; se corta en 200 s para dejarle aire al resto del sync,
 * y lo que quede pendiente lo levanta la corrida siguiente.
 */
export const DEFAULT_BUDGET_MS = 200_000;

export interface IbProductionResult {
  /** Filas de `ib_reward_daily` espejadas. */
  dailyRows: number;
  /** Días de desglose por símbolo procesados en esta corrida. */
  symbolDays: number;
  /** Filas de desglose escritas. */
  symbolRows: number;
  /** Días que `ibrewards` cubre hoy y que todavía no están espejados. */
  symbolDaysPending: number;
  /** Símbolos distintos vistos, y cuántos cayeron en cada clase. */
  symbols: number;
  syntheticSymbols: number;
  elapsedMs: number;
  warnings: string[];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** `2026-08-13` a partir de un Date UTC. Sin zona horaria de por medio. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * `day` viene como string `YYYY-MM-DD` en `ib_reward_daily` (verificado), pero
 * hay un `dayDate` gemelo que es Date. Se acepta cualquiera de las dos formas y
 * se rechaza lo que no sea un día reconocible: una fila con fecha rara escrita
 * como `null` en la PK haría fallar el upsert entero.
 */
function normalizeDay(v: unknown): string | null {
  if (v instanceof Date) return isoDay(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function syncIbProduction(
  admin: SupabaseClient,
  companyId: string,
  budgetMs: number = DEFAULT_BUDGET_MS,
): Promise<IbProductionResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const now = new Date().toISOString();

  // ── 1. El rollup diario por IB, entero ───────────────────────────────────
  // Son 37.146 docs y crecen ~5.500 por mes: recorrerlo completo en cada
  // corrida completa cuesta segundos y se autorrepara solo si el bróker
  // reprocesa un día viejo. Un cursor incremental acá sería complejidad sin
  // beneficio medible.
  const daily = await withOrionMongo(companyId, async ({ db }) =>
    db.collection('ib_reward_daily')
      .aggregate([
        { $project: Object.fromEntries(ORION_IB_REWARD_DAILY_FIELDS.map((f) => [f, 1])) as Record<string, 1> },
        {
          $group: {
            // Agrupado y no leído fila a fila: la PK del espejo es
            // (empresa, día, IB) y si el origen tuviera dos documentos para el
            // mismo par el upsert los pisaría en vez de sumarlos.
            _id: { d: '$day', u: '$ibUserId' },
            lots: { $sum: '$totalLots' },
            commission: { $sum: '$totalCommission' },
            pnl: { $sum: '$totalPnl' },
            rewards: { $sum: '$rewardsCount' },
          },
        },
      ], { allowDiskUse: true, maxTimeMS: 180_000 })
      .toArray(),
  );

  const dailyPayload: Record<string, unknown>[] = [];
  let sinDia = 0;
  for (const r of daily) {
    const id = r._id as { d?: unknown; u?: unknown };
    const day = normalizeDay(id?.d);
    const ib = typeof id?.u === 'string' ? id.u : null;
    if (!day || !ib) { sinDia++; continue; }
    dailyPayload.push({
      company_id: companyId,
      day,
      ib_user_id: ib,
      lots: num(r.lots),
      commission: num(r.commission),
      pnl: num(r.pnl),
      rewards_count: Math.round(num(r.rewards)),
      synced_at: now,
    });
  }
  if (sinDia > 0) warnings.push(`ib_reward_daily: ${sinDia} filas sin día o sin ibUserId, salteadas`);

  for (const part of chunk(dailyPayload, 500)) {
    const { error } = await admin
      .from('crm_ib_reward_daily')
      .upsert(part, { onConflict: 'company_id,day,ib_user_id' });
    if (error) throw new Error(`crm_ib_reward_daily: ${error.message}`);
  }


  // ── 2. El desglose por clase de activo ───────────────────────────────────
  //
  // ── LOS DÍAS CANDIDATOS SALEN DEL ESPEJO DIARIO, NO DE `ibrewards` ───────
  // Lo natural sería preguntarle a `ibrewards` qué ventana cubre hoy. No se
  // puede: un $min/$max de `dealTime` sobre 11.829.132 documentos es un barrido
  // completo (ningún índice empieza por `dealTime`) y se pasa de los 15 s del
  // lector compartido — probado, mata la corrida entera. `crm_ib_reward_daily`
  // ya tiene exactamente los mismos días y los tiene en Postgres.
  //
  // Se recorre del más nuevo al más viejo y se corta en el primer día que
  // vuelve vacío: `ibrewards` es una ventana rodante CONTIGUA (2026-08-13 →
  // 2026-08-27 el día que se midió), así que el primer día sin premios es el
  // borde de la purga y todo lo anterior también está purgado.
  let symbolDays = 0;
  let symbolRows = 0;
  let symbolDaysPending = 0;
  let symbols = 0;
  let syntheticSymbols = 0;
  let purgedFrom: string | null = null;

  const desdeLookback = isoDay(new Date(Date.now() - SYMBOL_LOOKBACK_DAYS * 86_400_000));
  const candidatos = [...new Set(
    dailyPayload
      .map((r) => String(r.day))
      .filter((d) => d >= desdeLookback),
  )].sort((a, b) => (a < b ? 1 : -1));

  // Qué días ya están espejados. `.range()` + `.order()`: PostgREST corta en
  // 1.000 filas sin avisar, y acá "no está espejado" se traduce en volver a
  // recorrer los premios de un día entero al pedo.
  const yaHechos = new Set<string>();
  if (candidatos.length > 0) {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from('crm_ib_reward_symbol_daily')
        .select('day')
        .eq('company_id', companyId)
        .gte('day', candidatos[candidatos.length - 1])
        .lte('day', candidatos[0])
        .order('day', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`crm_ib_reward_symbol_daily lectura: ${error.message}`);
      for (const r of data ?? []) yaHechos.add(String(r.day).slice(0, 10));
      if (!data || data.length < PAGE) break;
    }
  }

  // Los REDO_DAYS más recientes se rehacen aunque ya estén: el día en curso y
  // los dos anteriores siguen recibiendo premios.
  const rehacer = new Set(candidatos.slice(0, REDO_DAYS));
  const pendientes = candidatos.filter((d) => rehacer.has(d) || !yaHechos.has(d));
  symbolDaysPending = pendientes.length;

  // Los IB activos de cada día, sacados del espejo que se acaba de escribir.
  // Es la clave para entrar por el índice `{ibUserId:1, dealTime:-1}` en vez de
  // barrer la colección.
  const ibsPorDia = new Map<string, string[]>();
  for (const r of dailyPayload) {
    const d = String(r.day);
    const list = ibsPorDia.get(d);
    if (list) list.push(String(r.ib_user_id));
    else ibsPorDia.set(d, [String(r.ib_user_id)]);
  }

  let procesados = 0;
  for (const day of pendientes) {
    if (procesados >= MAX_SYMBOL_DAYS_PER_RUN) break;
    if (Date.now() - started > budgetMs) {
      warnings.push('desglose: se agotó el presupuesto de tiempo de la corrida');
      break;
    }

    const ibs = ibsPorDia.get(day) ?? [];
    const desde = new Date(`${day}T00:00:00.000Z`);
    const hasta = new Date(desde.getTime() + 86_400_000);

    // Acumulador (IB → clase) del día. La clasificación se hace ACÁ, en
    // TypeScript, con el registro único (`classifyAssetClass`): Mongo agrupa por
    // símbolo crudo y no sabe nada de familias de sintéticos. Una segunda copia
    // de esa lista dentro de un $cond se desincronizaría en silencio, que es el
    // modo de fallo #1 de este repo.
    const acc = new Map<string, { lots: number; commission: number; n: number }>();
    const vistos = new Set<string>();
    let filasDelDia = 0;
    // Un día que no se pudo leer entero NO se escribe. Escribir lo que alcanzó
    // a leerse dejaría en la tabla un desglose que no suma el total del día, y
    // esa mentira es peor que la falta: la pantalla sabe decir "sin dato".
    let dayFailed: string | null = null;

    for (const lote of chunk(ibs, IB_BATCH)) {
      if (Date.now() - started > budgetMs) { dayFailed = 'presupuesto'; break; }
      try {
        const grupos = await withOrionMongo(companyId, async ({ db }) =>
          db.collection('ibrewards')
            .aggregate([
              // `ibUserId` PRIMERO: es el prefijo del índice. Con el $in, Mongo
              // hace una búsqueda por rango por cada IB del lote en vez de leer
              // los 11,8M documentos.
              { $match: { ibUserId: { $in: lote }, dealTime: { $gte: desde, $lt: hasta } } },
              {
                $group: {
                  _id: { u: '$ibUserId', s: '$symbol' },
                  lots: { $sum: '$lots' },
                  commission: { $sum: '$commission' },
                  n: { $sum: 1 },
                },
              },
            ], { allowDiskUse: true, maxTimeMS: 12_000 })
            .toArray(),
        );

        for (const g of grupos) {
          const id = g._id as { u?: unknown; s?: unknown };
          const ib = typeof id?.u === 'string' ? id.u : null;
          if (!ib) continue;
          const simbolo = typeof id?.s === 'string' ? id.s : '';
          vistos.add(simbolo);
          const clase: AssetClass = classifyAssetClass(simbolo);
          const k = `${ib}|${clase}`;
          const prev = acc.get(k) ?? { lots: 0, commission: 0, n: 0 };
          prev.lots += num(g.lots);
          prev.commission += num(g.commission);
          prev.n += num(g.n);
          acc.set(k, prev);
          filasDelDia++;
        }
      } catch (err) {
        // Los días viejos son los más pesados (hasta 1.953.214 premios) y algún
        // lote puede pasarse de los 15 s del lector de Orion. Que un día no
        // entre NO puede matar la corrida: el espejo diario ya se escribió y el
        // resto de los días se sigue intentando.
        dayFailed = err instanceof Error ? err.message : 'unknown';
        break;
      }
    }

    if (dayFailed) {
      warnings.push(`desglose ${day}: no se pudo completar (${dayFailed}); no se escribió nada`);
      procesados++;
      continue;
    }

    // Día sin un solo premio: es el borde de la purga de `ibrewards`. No se
    // escribe NADA — una fila en cero diría "no operó" y lo cierto es "ya no
    // está el dato". Se corta el recorrido: lo anterior también está purgado.
    if (filasDelDia === 0) {
      purgedFrom = day;
      break;
    }

    symbols = Math.max(symbols, vistos.size);
    syntheticSymbols = Math.max(
      syntheticSymbols,
      [...vistos].filter((s) => classifyAssetClass(s) === 'synthetic').length,
    );

    const payload = [...acc].map(([k, v]) => {
      const [ib, clase] = k.split('|');
      return {
        company_id: companyId,
        day,
        ib_user_id: ib,
        asset_class: clase,
        lots: v.lots,
        commission: v.commission,
        rewards_count: Math.round(v.n),
        synced_at: now,
      };
    });

    for (const part of chunk(payload, 500)) {
      const { error } = await admin
        .from('crm_ib_reward_symbol_daily')
        .upsert(part, { onConflict: 'company_id,day,ib_user_id,asset_class' });
      if (error) throw new Error(`crm_ib_reward_symbol_daily: ${error.message}`);
    }

    procesados++;
    symbolDays++;
    symbolRows += payload.length;
  }

  if (purgedFrom) {
    warnings.push(`desglose: ${purgedFrom} y anteriores ya no están en ibrewards (purgados)`);
  }
  if (symbolDaysPending > symbolDays && !purgedFrom) {
    warnings.push(
      `desglose: quedaron ${symbolDaysPending - symbolDays} días pendientes; ` +
      'los completa la corrida siguiente',
    );
  }

  return {
    dailyRows: dailyPayload.length,
    symbolDays,
    symbolRows,
    symbolDaysPending,
    symbols,
    syntheticSymbols,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
