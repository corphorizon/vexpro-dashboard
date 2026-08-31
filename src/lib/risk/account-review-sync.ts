// ─────────────────────────────────────────────────────────────────────────────
// Espejo del diagnóstico operativo por cuenta.
//
// ── EL ALCANCE: LAS CUENTAS DE QUIEN PIDIÓ UN RETIRO INSTANTÁNEO ───────────
// Arrancamos por ahí a pedido de Stiven (2026-08-27), y la razón es la misma
// que separa esa pestaña en la cola: en un instantáneo el dinero YA SALIÓ sin
// que nadie lo mirara. Saber cómo opera ese cliente es lo único que queda por
// hacer, y hoy no se ve en ningún lado.
//
// Se miran las cuentas de tipo BROKER (trading) y SOCIAL. Las FUNDING quedan
// fuera a propósito: son prop firm y ya tienen su propia revisión, con su
// reglamento y su ciclo — pasarles ADEMÁS estas señales sería contar dos veces
// lo mismo con dos vocabularios distintos.
//
// ── DOS CAMINOS, Y EL PRINCIPAL ES EL BOTÓN (2026-08-31) ───────────────────
// Al principio esto era sólo un cron: se espejaban todas las cuentas y la ficha
// leía del espejo, porque abrir el túnel a MT5 cuesta ~3,5 s y emparejar
// posiciones por `PositionID` —que NO está en el índice— cuesta ~0,28 s por
// cuenta. La regla G10 del repo lo dice: nunca se consulta MT5 en vivo desde
// una pantalla.
//
// No alcanzó. Medido sobre ocho corridas reales, ninguna pasó de 80 cuentas y
// varias quedaron en 7 o 9: no las frenaba el techo, se quedaban sin tiempo y
// Vercel las mataba con `504`. Un cliente nuevo esperaba hasta hora y media, o
// sea que para un retiro PENDIENTE el diagnóstico llegaba después de la
// decisión — lo único para lo que servía.
//
// Y el fondo del problema era otro: se mantenían ~1.023 diagnósticos rotando y
// casi ninguno se leía. Mucho trabajo sobre un enlace frágil, para datos que
// nadie abría.
//
// Ahora:
//   · `revisarCuentasDeCliente` — el botón de la ficha. Calcula las cuentas de
//     UN cliente en el momento. Es lo que se usa cuando hace falta de verdad.
//   · `syncAccountReviews` — el cron, ahora cobertura de fondo con un techo que
//     sí se alcanza (60), para que la corrida TERMINE en vez de morir a los
//     300 s ocupando el enlace.
//
// G10 sigue en pie: apunta a la carga AUTOMÁTICA, una conexión por visita. El
// botón es un clic explícito con su espera a la vista, igual que el refresco
// del pool de liquidez.
//
// Los dos comparten `evaluarYGuardar`: la diferencia entre ellos es QUÉ cuentas
// entran, no cómo se evalúan.
//
// Ningún recorte es silencioso: `skipped` y los avisos viajan en el resultado.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadTradesByLogin,
  evaluateAccount,
  MAX_POSICIONES,
  type AccountReview,
} from '@/lib/risk/account-review';
import type { Trade } from '@/lib/risk/types';
import { esCuentaDemoCrm } from '@/lib/mt5-groups';
import { evaluarToxicidad } from '@/lib/risk/broker-toxicity';

/** Techo de logins por consulta a MT5. Ver también PRESUPUESTO_POSICIONES. */
export const LOGIN_BATCH = 40;

/**
 * Posiciones que puede traer UNA consulta.
 *
 * ── POR QUÉ LOS LOTES NO PUEDEN SER DE TAMAÑO FIJO (medido, 2026-08-28) ────
 * Porque las cuentas no se parecen entre sí: la mediana tiene 29 posiciones y
 * el máximo 25.000. Un lote de 40 cuentas chicas trae 1.000 filas; uno que
 * agarre varias grandes intenta traer un millón, y la función se queda sin
 * tiempo antes de terminar.
 *
 * El síntoma era una cadencia errática —corridas de 200 cuentas alternadas con
 * corridas de 2— que no se explicaba por nada visible: dependía de qué cuentas
 * caían juntas en el lote.
 *
 * Con presupuesto por volumen, cada consulta trae más o menos lo mismo pase lo
 * que pase: un lote puede ser de 40 cuentas chicas o de una sola enorme.
 */
export const PRESUPUESTO_POSICIONES = 120_000;
/**
 * Techo por corrida.
 *
 * ── POR QUÉ BAJÓ DE 200 A 60 (2026-08-31) ─────────────────────────────────
 * El techo era teórico: medido sobre ocho corridas reales, ninguna pasó de 80
 * y varias quedaron en 7, 9 o 22. No las frenaba el techo — se quedaban sin
 * tiempo y Vercel las mataba con `504` a los 300 s. Un techo que nunca se
 * alcanza no limita nada; sólo esconde que la corrida no terminó.
 *
 * Con 60, la corrida TERMINA. Rinde parecido —el trabajo real por corrida no
 * cambia— pero deja el enlace a MT5 libre en vez de ocuparlo hasta que la
 * matan, que es lo que competía con todo lo demás.
 *
 * Lo urgente ya no depende de esto: la ficha del retiro tiene un botón que
 * calcula en el momento. El cron pasó a ser cobertura de fondo.
 */
export const MAX_POR_CORRIDA = 60;
/** Tipos de cuenta que entran. FUNDING queda fuera (tiene su propio módulo). */
export const TIPOS = ['BROKER', 'SOCIAL'] as const;

/**
 * Cuánto vale el diagnóstico de una cuenta prioritaria antes de rehacerlo.
 *
 * ── LA INANICIÓN QUE ESTO ARREGLA (medido, 2026-08-28) ─────────────────────
 * «Prioritaria» tiene que significar «entra primero cuando le hace falta», no
 * «se rehace en todas las corridas». Sin este corte, los 202 pendientes contra
 * un techo de 200 dejaron CERO lugar para el resto durante horas: las mismas
 * 202 cuentas se recalcularon en cada corrida y las otras 700 quedaron
 * congeladas, sin que nada avisara.
 *
 * Dos horas porque la operativa de una cuenta no cambia en treinta minutos: lo
 * que importa es que un pendiente NUEVO entre en la corrida siguiente, y eso
 * se cumple igual (nunca calculada = siempre prioritaria).
 */
export const FRESCURA_PRIORITARIA_MS = 2 * 60 * 60 * 1000;

/**
 * Parte del cupo reservada SIEMPRE a la rotación, aunque sobren prioritarias.
 *
 * Es la red contra la inanición, no el mecanismo principal: aun con el corte de
 * frescura, un pico de pendientes podría volver a llenar el cupo. Con esto, el
 * resto del universo avanza siempre — más lento, pero avanza.
 */
export const RESERVA_ROTACION = 0.25;

export interface AccountReviewSyncResult {
  candidates: number;
  reviewed: number;
  skipped: number;
  failed: number;
  elapsedMs: number;
  warnings: string[];
}

interface CuentaCandidata {
  login: number;
  user_external_id: string | null;
  email: string | null;
  account_type: string | null;
  group_name: string | null;
  /**
   * Demo o real. El CRM lo distingue por ACÁ, no por `group_name` — ese guarda
   * un nombre corto (`SYNTHETICS`) que es igual en las dos. Ver `mt5-groups.ts`.
   */
  is_live: boolean | null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Lee todas las páginas de una consulta.
 *
 * PostgREST corta en 1.000 filas EN SILENCIO. Sin esto se miraría siempre el
 * mismo primer millar de cuentas y la rotación no rotaría nada.
 */
async function fetchAll<T>(
  // El builder de PostgREST es un thenable, no una Promise: PromiseLike es lo
  // que acepta a los dos sin castear en cada call site.
  run: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let desde = 0; ; desde += PAGE) {
    const { data, error } = await run(desde, desde + PAGE - 1);
    if (error) throw new Error(error.message);
    const filas = data ?? [];
    out.push(...filas);
    if (filas.length < PAGE) break;
  }
  return out;
}

/**
 * Calcula (o recalcula) el diagnóstico de las cuentas de los clientes que
 * pidieron retiros instantáneos.
 *
 * `noticias` es opcional y se pasa entera: la señal de calendario se resuelve
 * por cuenta contra la misma lista. Sin ella, esa señal queda «no comprobada»
 * en vez de darse por cumplida.
 */
export async function syncAccountReviews(
  admin: SupabaseClient,
  companyId: string,
  opts: {
    noticias?: Array<{ at: number; name: string; currency: string | null }> | null;
    instantFee?: number;
  } = {},
): Promise<AccountReviewSyncResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const instantFee = opts.instantFee ?? 5;

  // ── 1. Los clientes cuyo retiro hay que entender ────────────────────────
  // Dos poblaciones, por razones opuestas y las dos válidas:
  //
  //   INSTANTÁNEOS (fee = 5) — el dinero YA SALIÓ sin que nadie lo mirara.
  //     Entender al cliente es lo único que queda por hacer.
  //   PENDIENTES (status_norm = 'pending') — el dinero TODAVÍA NO SALIÓ y hay
  //     una decisión por tomar. Acá el diagnóstico llega a tiempo de servir.
  //
  // Se agregaron los pendientes el 2026-08-27: son 45 usuarios, de los cuales
  // 36 no tenían ningún instantáneo, y suman 232 cuentas. El universo pasa de
  // ~655 a ~887 — cuatro o cinco corridas de rotación, no un problema.
  const [instantaneos, pendientes] = await Promise.all([
    fetchAll<{ user_external_id: string | null }>((d, h) =>
      admin
        .from('crm_withdrawals')
        .select('user_external_id')
        .eq('company_id', companyId)
        .eq('fee', instantFee)
        .not('user_external_id', 'is', null)
        .order('requested_at', { ascending: false })
        .range(d, h),
    ),
    fetchAll<{ user_external_id: string | null }>((d, h) =>
      admin
        .from('crm_withdrawals')
        .select('user_external_id')
        .eq('company_id', companyId)
        .eq('status_norm', 'pending')
        .not('user_external_id', 'is', null)
        .order('requested_at', { ascending: false })
        .range(d, h),
    ),
  ]);
  const usuarios = [
    ...new Set([...instantaneos, ...pendientes].map((r) => r.user_external_id).filter(Boolean)),
  ] as string[];
  if (usuarios.length === 0) {
    return { candidates: 0, reviewed: 0, skipped: 0, failed: 0, elapsedMs: Date.now() - started, warnings };
  }

  // ── 2. Sus cuentas de trading y sociales ────────────────────────────────
  // El `in(...)` de PostgREST viaja en la URL, así que va por lotes.
  const cuentas: CuentaCandidata[] = [];
  for (const lote of chunk(usuarios, 300)) {
    const filas = await fetchAll<CuentaCandidata>((d, h) =>
      admin
        .from('crm_trading_accounts')
        .select('login, user_external_id, email, account_type, group_name, is_live')
        .eq('company_id', companyId)
        .in('user_external_id', lote)
        .in('account_type', TIPOS as unknown as string[])
        .range(d, h),
    );
    cuentas.push(...filas);
  }
  // ── Las demo no se revisan ──────────────────────────────────────────────
  // No son dinero real: diagnosticarlas gasta presupuesto de consultas a MT5 y
  // ensucia la pantalla de retiros con señales sobre saldos que no existen.
  // Medido en Vex Pro: 2.290 cuentas demo, 1.496 sólo en `demo\Broker\Synthetics`.
  //
  // Se filtra por `is_live`, NO por `group_name`. El del CRM es un nombre corto
  // —`SYNTHETICS`— que es idéntico en la demo y en la real: filtrarlo con la
  // regla de MT5 (`empieza con demo`) devuelve `false` para todas y deja pasar
  // las demo enteras. Ese fue el primer intento, el 2026-08-29, y no dio ningún
  // error: simplemente no filtró nada.
  //
  // Se cuenta cuántas se dejaron afuera y se avisa. Un recorte silencioso es
  // indistinguible de «no había más cuentas».
  const porLogin = new Map<number, CuentaCandidata>();
  let demoOmitidas = 0;
  for (const c of cuentas) {
    const n = Number(c.login);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (esCuentaDemoCrm(c)) { demoOmitidas += 1; continue; }
    porLogin.set(n, c);
  }
  if (demoOmitidas > 0) {
    warnings.push(`${demoOmitidas} cuenta(s) demo omitidas: no son dinero real.`);
  }
  if (porLogin.size === 0) {
    return { candidates: 0, reviewed: 0, skipped: 0, failed: 0, elapsedMs: Date.now() - started, warnings };
  }

  // ── 3. Rotación: las nunca calculadas primero, después las más viejas ───
  const yaCalculadas = await fetchAll<{ login: number; computed_at: string; positions: number }>((d, h) =>
    admin
      .from('mt5_account_review')
      .select('login, computed_at, positions')
      .eq('company_id', companyId)
      .range(d, h),
  );
  const calculadoEn = new Map<number, string>();
  // Tamaño conocido de cada cuenta: es lo que permite presupuestar los lotes
  // por volumen en vez de por cantidad. Ver PRESUPUESTO_POSICIONES.
  const posicionesDe = new Map<number, number>();
  for (const r of yaCalculadas) {
    calculadoEn.set(Number(r.login), r.computed_at);
    posicionesDe.set(Number(r.login), Number(r.positions) || 0);
  }

  // ── LOS PENDIENTES VAN PRIMERO, SIEMPRE ─────────────────────────────────
  // Un retiro en Solicitados NO se queda ahí: alguien lo toca y pasa a otro
  // estado. Si su diagnóstico esperara el turno de la rotación —cuatro o cinco
  // corridas, más de dos horas— llegaría DESPUÉS de la decisión, que es la
  // única para la que servía.
  //
  // Los instantáneos no tienen esa urgencia: el dinero ya salió, así que lo que
  // se mira es historia y puede esperar su turno.
  //
  // Mismo criterio que el sync del CRM con los retiros pendientes.
  const usuariosPendientes = new Set(
    pendientes.map((r) => r.user_external_id).filter(Boolean) as string[],
  );
  // Una prioritaria recién calculada NO vuelve a entrar: ver
  // FRESCURA_PRIORITARIA_MS. Sin este corte, las mismas cuentas se rehacían en
  // cada corrida y el resto del universo no avanzaba nunca.
  const ahoraMs = Date.now();
  const estaFresca = (login: number) => {
    const c = calculadoEn.get(login);
    if (!c) return false; // nunca calculada: siempre prioritaria
    const t = new Date(c).getTime();
    return Number.isFinite(t) && ahoraMs - t < FRESCURA_PRIORITARIA_MS;
  };
  const esPrioritaria = (login: number) => {
    const uid = porLogin.get(login)?.user_external_id;
    if (!uid || !usuariosPendientes.has(uid)) return false;
    return !estaFresca(login);
  };
  // Dentro de cada grupo, lo más viejo primero. La cadena vacía ordena antes
  // que cualquier fecha: las nunca-calculadas encabezan.
  const porAntiguedad = (a: number, b: number) =>
    (calculadoEn.get(a) ?? '').localeCompare(calculadoEn.get(b) ?? '');

  const todas = [...porLogin.keys()];
  const prioritarias = todas.filter(esPrioritaria).sort(porAntiguedad);
  const resto = todas.filter((l) => !esPrioritaria(l)).sort(porAntiguedad);

  // Las prioritarias entran primero pero NO pueden ocupar el cupo entero: se
  // reserva una parte para la rotación. Lo que no entra de las prioritarias va
  // al final — no se pierde, entra en la corrida siguiente.
  const cupoPrioritarias = Math.max(1, Math.floor(MAX_POR_CORRIDA * (1 - RESERVA_ROTACION)));
  const orden = [
    ...prioritarias.slice(0, cupoPrioritarias),
    ...resto,
    ...prioritarias.slice(cupoPrioritarias),
  ];
  if (prioritarias.length > cupoPrioritarias) {
    warnings.push(
      `${prioritarias.length} cuenta(s) prioritarias para ${cupoPrioritarias} lugares: ` +
      `las demás van después de la rotación para no congelarla.`,
    );
  }
  const tanda = orden.slice(0, MAX_POR_CORRIDA);
  const skipped = orden.length - tanda.length;
  if (skipped > 0) {
    warnings.push(
      `Quedaron ${skipped} cuenta(s) para la próxima corrida (techo de ${MAX_POR_CORRIDA}).`,
    );
  }

  // ── 4. Traer operaciones y evaluar ──────────────────────────────────────
  let reviewed = 0;
  let failed = 0;

  // Lotes por VOLUMEN, no por cantidad. Ver PRESUPUESTO_POSICIONES: con lotes
  // de tamaño fijo, uno que agarre varias cuentas enormes intenta traer un
  // millón de filas y la función se queda sin tiempo.
  const TAMANO_DESCONOCIDO = 500;
  const lotes: number[][] = [];
  let actual: number[] = [];
  let acumulado = 0;
  for (const login of tanda) {
    const tam = posicionesDe.get(login) ?? TAMANO_DESCONOCIDO;
    // Una cuenta sola que supere el presupuesto va igual: sin esto quedaría
    // afuera para siempre y su diagnóstico no se calcularía nunca.
    if (actual.length > 0 && (acumulado + tam > PRESUPUESTO_POSICIONES || actual.length >= LOGIN_BATCH)) {
      lotes.push(actual);
      actual = [];
      acumulado = 0;
    }
    actual.push(login);
    acumulado += tam;
  }
  if (actual.length > 0) lotes.push(actual);

  for (const lote of lotes) {
    const r = await evaluarYGuardar(admin, companyId, lote, porLogin, opts.noticias ?? null);
    reviewed += r.reviewed;
    failed += r.failed;
    warnings.push(...r.warnings);
  }

  return {
    candidates: orden.length,
    reviewed,
    skipped,
    failed,
    elapsedMs: Date.now() - started,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluar un lote de cuentas y guardar el resultado.
//
// Lo comparten el cron y el botón de «analizar ahora». Estaba escrito dentro
// del bucle del cron, y duplicarlo para el botón habría dejado dos evaluaciones
// que se desincronizan en silencio — el modo de falla número uno de este repo.
// La diferencia entre los dos llamadores es QUÉ cuentas entran, no cómo se
// evalúan.
// ─────────────────────────────────────────────────────────────────────────────
async function evaluarYGuardar(
  admin: SupabaseClient,
  companyId: string,
  lote: number[],
  porLogin: Map<number, CuentaCandidata>,
  noticias: Array<{ at: number; name: string; currency: string | null }> | null,
): Promise<{ reviewed: number; failed: number; warnings: string[] }> {
  const warnings: string[] = [];
  const ahora = new Date().toISOString();

  let porCuenta: Map<number, Trade[]>;
  try {
    porCuenta = await loadTradesByLogin(companyId, lote);
  } catch (err) {
    // Un lote que falla no tira la corrida entera: las demás cuentas siguen.
    warnings.push(`Lote de ${lote.length} cuenta(s) falló: ${err instanceof Error ? err.message : String(err)}`);
    return { reviewed: 0, failed: lote.length, warnings };
  }

  {
    const filas = lote.map((login) => {
      const meta = porLogin.get(login)!;
      const trades = porCuenta.get(login) ?? [];
      const truncated = trades.length >= MAX_POSICIONES;
      // Las mismas operaciones, dos lecturas distintas. Ninguna influye en la
      // otra: mezclarlas daría un puntaje que no significa nada.
      const tox = evaluarToxicidad(trades);
      const rev: AccountReview = evaluateAccount(login, trades, {
        noticias,
        // La detección de copia necesita las aperturas de TODAS las cuentas del
        // período y hoy vive en el módulo de prop firm. Se deja sin comprobar
        // a propósito en vez de darla por limpia.
        sincronizadas: null,
        truncated,
      });
      return {
        company_id: companyId,
        login,
        user_external_id: meta.user_external_id,
        email: meta.email,
        account_type: meta.account_type,
        group_name: meta.group_name,
        positions: rev.facts.positions,
        first_trade_at: rev.facts.firstTradeAt?.toISOString() ?? null,
        last_trade_at: rev.facts.lastTradeAt?.toISOString() ?? null,
        net_result: rev.facts.netResult,
        avg_duration_sec: rev.facts.avgDurationSec,
        under_1min: rev.facts.under1min,
        under_5min: rev.facts.under5min,
        won: rev.facts.won,
        lost: rev.facts.lost,
        lots_total: rev.facts.lotsTotal,
        max_drawdown: rev.facts.maxDrawdown,
        top_symbols: rev.facts.topSymbols,
        durations: rev.facts.durations,
        checks: rev.signals,
        violations: rev.flagged,
        unverifiable: rev.unverifiable,
        risk: rev.risk,
        computed_at: ahora,
        truncated: rev.truncated,
        warnings: rev.warnings,
        // ── Toxicidad hacia el bróker ─────────────────────────────────────
        // Eje SEPARADO de `risk`: aquél dice cómo opera el cliente, éste dice
        // cuánto le cuesta a la casa. Sale de las mismas operaciones ya
        // cargadas, así que no cuesta una vuelta más a MT5.
        origen: tox.origen,
        ejecucion: tox.ejecucion,
        toxic_signals: tox.senales,
        toxic_level: tox.level,
        toxic_flagged: tox.flagged,
      };
    });

    const { error } = await admin
      .from('mt5_account_review')
      .upsert(filas, { onConflict: 'company_id,login' });
    if (error) {
      warnings.push(`mt5_account_review: ${error.message}`);
      return { reviewed: 0, failed: filas.length, warnings };
    }
    return { reviewed: filas.length, failed: 0, warnings };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BAJO DEMANDA: las cuentas de UN cliente, ahora.
//
// ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────
// El cron mantiene ~1.023 diagnósticos rotando, y casi ninguno se lee. Medido
// el 2026-08-31: las corridas procesan entre 7 y 80 cuentas contra un techo de
// 200 —no llegan, se quedan sin tiempo— así que un cliente nuevo espera entre
// media hora y hora y media. Para un retiro PENDIENTE eso llega después de la
// decisión, que era lo único para lo que servía.
//
// Con el botón se calcula lo que alguien va a leer, en el momento en que lo va
// a leer. Es una consulta a MT5 por clic y no cientos por hora sin lector.
//
// ── LA REGLA G10 SIGUE EN PIE ──────────────────────────────────────────────
// «Nunca consultar MT5 en vivo desde una PANTALLA» es contra la carga
// automática: una conexión al broker por cada visita. Esto es un clic
// explícito, con su espera visible — el mismo criterio que el botón de
// refrescar del pool de liquidez.
// ─────────────────────────────────────────────────────────────────────────────

export interface RevisionBajoDemandaResult {
  /** Cuentas del cliente que entraron (reales, BROKER/SOCIAL). */
  candidates: number;
  reviewed: number;
  failed: number;
  /** Cuentas demo que se dejaron afuera. */
  demoSkipped: number;
  elapsedMs: number;
  warnings: string[];
}

export async function revisarCuentasDeCliente(
  admin: SupabaseClient,
  companyId: string,
  userExternalId: string,
  opts: { noticias?: Array<{ at: number; name: string; currency: string | null }> | null } = {},
): Promise<RevisionBajoDemandaResult> {
  const started = Date.now();
  const warnings: string[] = [];

  const cuentas = await fetchAll<CuentaCandidata>((d, h) =>
    admin
      .from('crm_trading_accounts')
      .select('login, user_external_id, email, account_type, group_name, is_live')
      .eq('company_id', companyId)
      .eq('user_external_id', userExternalId)
      .in('account_type', TIPOS as unknown as string[])
      .range(d, h),
  );

  const porLogin = new Map<number, CuentaCandidata>();
  let demoSkipped = 0;
  for (const c of cuentas) {
    const n = Number(c.login);
    if (!Number.isFinite(n) || n <= 0) continue;
    // Misma regla que el cron: `is_live`, no `group_name`. Ver `mt5-groups.ts`.
    if (esCuentaDemoCrm(c)) { demoSkipped += 1; continue; }
    porLogin.set(n, c);
  }
  if (demoSkipped > 0) {
    warnings.push(`${demoSkipped} cuenta(s) demo omitidas: no son dinero real.`);
  }
  if (porLogin.size === 0) {
    return { candidates: 0, reviewed: 0, failed: 0, demoSkipped, elapsedMs: Date.now() - started, warnings };
  }

  // Un cliente tiene pocas cuentas, pero el techo se respeta igual: si alguna
  // vez aparece uno con cincuenta, no se lo lleva todo en una sola consulta.
  const logins = [...porLogin.keys()].slice(0, LOGIN_BATCH);
  if (porLogin.size > logins.length) {
    warnings.push(
      `El cliente tiene ${porLogin.size} cuentas; se revisaron las primeras ${logins.length}.`,
    );
  }

  const { reviewed, failed, warnings: avisos } = await evaluarYGuardar(
    admin, companyId, logins, porLogin, opts.noticias ?? null,
  );
  warnings.push(...avisos);

  return {
    candidates: logins.length,
    reviewed,
    failed,
    demoSkipped,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
