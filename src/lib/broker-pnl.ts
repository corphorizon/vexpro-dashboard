// ─────────────────────────────────────────────────────────────────────────────
// Broker P&L — DE DÓNDE SALE EL NÚMERO. Registro único.
//
// ── QUÉ PROBLEMA RESUELVE (Kevin, 2026-08-31: "dejalo automatizado, eliminemos
//    lo manual") ───────────────────────────────────────────────────────────────
// Hasta hoy el "Broker P&L" de /resumen-general y de la cadena de distribución
// era un número TECLEADO en Carga de Datos (`operating_income.broker_pnl`).
// Agosto 2026 de Vex Pro tenía $671.000 escritos a mano contra $386.665,54 que
// da el cierre diario del CRM: $284.334,46 de diferencia sobre un número que
// entra a la base distribuible de los socios.
//
// Desde la migración 106 existe `crm_daily_pnl`, con backfill completo desde
// 2025-10: el PNL DEL CLIENTE por día UTC. Este módulo es el único lugar donde
// se decide qué número se muestra y de dónde salió.
//
// ── LAS TRES REGLAS ────────────────────────────────────────────────────────
//
// 1. PERÍODO CERRADO → EL NÚMERO CONGELADO, SIEMPRE.
//    El cierre congela los INSUMOS (§2.3 de las reglas del proyecto) y la
//    plata de esos meses ya se repartió. Recalcularlos con la serie del CRM
//    reescribiría lo distribuido: Vex Pro tiene NUEVE períodos cerrados
//    (Oct 25 – Jun 26) y ninguno coincide con la serie automática. Por eso
//    `resolveBrokerPnl` devuelve el manual sin mirar el CRM cuando el período
//    está cerrado — y así, además, `getSnapshotDrifts` no reporta una deriva
//    falsa en los nueve.
//
// 2. PERÍODO ABIERTO → LA SERIE DEL CRM.
//    El corte es por ESTADO del período, no por fecha: un mes que se cierre
//    mañana se congela con lo que la serie diga ese día, y uno que se reabra
//    vuelve a la serie. No hay una fecha de corte que mantener sincronizada en
//    dos lugares.
//
// 3. SIN DATOS ≠ CERO.
//    Un período abierto sin una sola fila en `crm_daily_pnl` NO vale 0: eso
//    diría "el bróker no ganó nada", que es una afirmación que no tenemos.
//    `resolveBrokerPnl` devuelve `value: null` con `source: 'none'` y la
//    pantalla muestra "sin datos". Para la CADENA DE DISTRIBUCIÓN, que necesita
//    un número sí o sí, `brokerPnlForChain` cae al valor manual heredado —
//    nunca a 0, porque cero achicaría la base distribuible y le pagaría de
//    menos a los socios en silencio.
//
// ── HUECOS ─────────────────────────────────────────────────────────────────
// Un mes puede tener datos y estar incompleto: Vex Pro 2025-10 tiene 27 de 31
// días, AP Markets 2026-06 tiene 9 de 30. El total se muestra igual —es el
// mejor dato que hay— pero viaja con `daysWithData` / `daysInMonth` para que
// la pantalla pueda decir sobre cuántos días se calculó. Un acumulado de 31
// días construido con 27 es un número más chico y perfectamente creíble.
//
// ── EL SIGNO, Y POR QUÉ NO SE IMPORTA `brokerPnlFromClients` ───────────────
// `crm_daily_pnl.pnl_usd` es el PNL del CLIENTE (negativo = ganó el bróker).
// La inversión se hace UNA sola vez, acá abajo.
//
// Lo natural sería importar `brokerPnlFromClients` de `crm-sync/daily-pnl.ts`,
// que es donde vive esa decisión. NO SE PUEDE: ese módulo importa
// `mt5-sync/pnl.ts` por `PNL_CATEGORIES`, y `mt5-sync/pnl.ts` arrastra
// `mt5-sql/client.ts`, que tiene `import 'server-only'`. Este archivo lo lee
// el data-context, que es cliente: el import rompería el BUILD (no el
// typecheck, no los tests — se descubre tarde y en Vercel).
//
// La copia del signo está atada con un test: `broker-pnl.test.ts` compara
// `monthlyBrokerPnl` contra el `brokerPnlFromClients` de verdad, así que el
// día que una de las dos cambie, el test rompe. Una copia sin ese amarre sería
// el modo de falla número uno de este repo.
// ─────────────────────────────────────────────────────────────────────────────

import { round2 } from './utils';

/** De dónde salió el número que se está mostrando. */
export type BrokerPnlSource =
  /** Serie automática del CRM (`crm_daily_pnl`). */
  | 'crm'
  /** Período cerrado: el número congelado al cerrar. Inmutable. */
  | 'frozen'
  /** Período abierto sin serie del CRM: no lo sabemos. */
  | 'none';

export interface BrokerPnlMonth {
  year: number;
  month: number;
  /** Ganancia del BRÓKER en USD (signo ya invertido). `null` = ni un día con dato. */
  brokerPnl: number | null;
  /** Días del mes con fila y con `pnl_usd` no nulo. */
  daysWithData: number;
  /** Días que tiene el mes. `daysWithData < daysInMonth` ⇒ el mes está incompleto. */
  daysInMonth: number;
  /** El `computed_at` más reciente de las filas del mes. */
  computedAt: string | null;
}

/** Lo mínimo que hace falta de una fila de `crm_daily_pnl`. */
export interface BrokerPnlDailyLike {
  utc_day: string;
  /** PNL del CLIENTE. `null` = el día no se pudo calcular (≠ cerró en cero). */
  pnl_usd: number | null;
  computed_at?: string | null;
}

/** Días de un mes, con años bisiestos incluidos (`Date.UTC(y, m, 0)`). */
export function daysInMonthUtc(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;

/**
 * La serie MENSUAL de ganancia del bróker a partir del cierre diario.
 *
 * Pura: es la decisión que hay que poder testear sin base de datos.
 *
 * Un día con `pnl_usd: null` cuenta como día SIN dato, no como día en cero —
 * ver la regla 3 de la cabecera. Un mes cuyas filas son todas nulas devuelve
 * `brokerPnl: null`, no 0.
 */
export function monthlyBrokerPnl(rows: readonly BrokerPnlDailyLike[]): BrokerPnlMonth[] {
  interface Acc {
    year: number;
    month: number;
    clientsPnl: number;
    daysWithData: number;
    computedAt: string | null;
  }
  const porMes = new Map<string, Acc>();

  for (const r of rows) {
    const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(r.utc_day ?? ''));
    if (!m) continue; // Una fecha ilegible no se mete en un mes cualquiera.
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) continue;
    const key = monthKey(year, month);
    const acc =
      porMes.get(key) ?? { year, month, clientsPnl: 0, daysWithData: 0, computedAt: null };
    porMes.set(key, acc);

    const computed = r.computed_at ? String(r.computed_at) : null;
    if (computed && (acc.computedAt === null || computed > acc.computedAt)) {
      acc.computedAt = computed;
    }

    if (r.pnl_usd === null || r.pnl_usd === undefined) continue;
    const n = Number(r.pnl_usd);
    if (!Number.isFinite(n)) continue;
    acc.clientsPnl += n;
    acc.daysWithData += 1;
  }

  return [...porMes.values()]
    .sort((a, b) => monthKey(a.year, a.month).localeCompare(monthKey(b.year, b.month)))
    .map((a) => ({
      year: a.year,
      month: a.month,
      // Un mes cuyas filas existen pero no tienen un solo pnl utilizable es
      // "no lo sabemos", no "cerró plano".
      // El signo se invierte UNA vez, acá. Ver el bloque «EL SIGNO» arriba.
      brokerPnl: a.daysWithData === 0 ? null : round2(-round2(a.clientsPnl)),
      daysWithData: a.daysWithData,
      daysInMonth: daysInMonthUtc(a.year, a.month),
      computedAt: a.computedAt,
    }));
}

/** Índice `YYYY-MM` → mes, para que el resolver sea O(1). */
export function indexBrokerPnlMonths(
  months: readonly BrokerPnlMonth[],
): Map<string, BrokerPnlMonth> {
  return new Map(months.map((m) => [monthKey(m.year, m.month), m]));
}

export interface BrokerPnlPeriodLike {
  year: number;
  month: number;
  is_closed?: boolean | null;
}

export interface ResolvedBrokerPnl {
  /** El número a mostrar. `null` = SIN DATOS; la pantalla no muestra $0. */
  value: number | null;
  source: BrokerPnlSource;
  /** Sólo con `source: 'crm'`. Sirve para avisar que el mes está incompleto. */
  daysWithData: number | null;
  daysInMonth: number | null;
  computedAt: string | null;
}

/**
 * El Broker P&L de UN período, con su procedencia.
 *
 * `manual` es lo que hay hoy en `operating_income.broker_pnl` (o el congelado
 * del cierre, que es el mismo número): sólo se usa si el período está CERRADO.
 */
export function resolveBrokerPnl(
  period: BrokerPnlPeriodLike,
  monthsByKey: ReadonlyMap<string, BrokerPnlMonth>,
  manual: number | null | undefined,
): ResolvedBrokerPnl {
  // Regla 1: cerrado manda el congelado, sin mirar el CRM.
  if (period.is_closed) {
    return {
      value: manual === null || manual === undefined ? null : Number(manual),
      source: 'frozen',
      daysWithData: null,
      daysInMonth: null,
      computedAt: null,
    };
  }

  const mes = monthsByKey.get(monthKey(period.year, period.month));
  // Regla 3: sin serie, o con serie sin un solo día utilizable, es SIN DATOS.
  if (!mes || mes.brokerPnl === null) {
    return { value: null, source: 'none', daysWithData: 0, daysInMonth: null, computedAt: null };
  }

  return {
    value: mes.brokerPnl,
    source: 'crm',
    daysWithData: mes.daysWithData,
    daysInMonth: mes.daysInMonth,
    computedAt: mes.computedAt,
  };
}

/**
 * El mismo número, pero para la CADENA DE DISTRIBUCIÓN, que no admite `null`.
 *
 * Separada de `resolveBrokerPnl` a propósito: la pantalla tiene que poder
 * decir "sin datos" y la cadena tiene que dar un número. Si las dos usaran la
 * misma función, o la pantalla mostraría un 0 falso o la cadena reventaría.
 *
 * El fallback de un período abierto sin serie es el MANUAL heredado, nunca 0:
 * cero achicaría la base distribuible y le pagaría de menos a los socios en
 * silencio, que es exactamente la clase de error que este repo persigue.
 */
export function brokerPnlForChain(
  resolved: ResolvedBrokerPnl,
  manual: number | null | undefined,
): number {
  if (resolved.value !== null) return resolved.value;
  const m = Number(manual);
  return Number.isFinite(m) ? m : 0;
}
