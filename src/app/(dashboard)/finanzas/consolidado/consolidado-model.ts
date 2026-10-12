// ─────────────────────────────────────────────────────────────────────────────
// /finanzas/consolidado — lo que la tabla decide sobre el aporte de la API,
// sacado del componente para poder fijarlo con tests.
//
// ── EL BUG (2026-10-12, migración «Libro mayor») ───────────────────────────
// La lectura de /api/integrations/period-totals tenía, literal:
//     } catch {
//       // Silent — fallback es 0 y aún se ven los datos manuales.
//     }
// y además ignoraba en silencio un `success: false`. En los meses DERIVADOS
// (Abr 2026+, broker-logic.ts) depósitos y retiros son API + manual: si la API
// no respondía, la fila mostraba SÓLO lo manual con la misma cara que un mes
// completo. Es el mismo bug que se corrigió en Balances (auditoría de
// finanzas, ítem 13: «Silent — channel shows $0 on error»): un $0 nunca puede
// ser el estado de error, porque se lee como una afirmación sobre la plata.
// Mientras la respuesta todavía no llegó pasaba lo mismo, por un instante.
//
// Ahora el aporte de la API es `null` («no lo sabemos») mientras carga o si
// falló, y `rowMoney` devuelve `null` en las tres cifras de un mes derivado:
// la celda muestra «—», el total de la columna también (una suma con un
// sumando desconocido no es un total), y la pantalla pone un Notice `bad`
// «No se pudo leer el aporte de la API: los totales no lo incluyen».
//
// Los meses HISTÓRICOS (≤ Mar 2026) no dependen de la API — sus totales se
// cargaron a mano — y siguen mostrándose aunque la API falle.
//
// Un mes que la API devolvió bien pero SIN entrada en `months` sí es cero: la
// RPC sólo devuelve meses con movimiento (comportamiento de antes, sin tocar).
//
// DESCARTADO:
//   · Seguir mostrando lo manual con un asterisco: el número sigue siendo
//     plausible y equivocado, y el asterisco no viaja al CSV.
//   · Reintentar solo: un reintento silencioso que vuelve a fallar es el mismo
//     silencio; el aviso pide recargar.
// ─────────────────────────────────────────────────────────────────────────────

import { computeDerivedNetDeposit } from '@/lib/broker-logic';

export interface ApiMonthTotals {
  deposits: number;
  withdrawals: number;
}

/** Estado de la lectura de totales de la API para el rango de la tabla. */
export type ApiTotalsState =
  | { status: 'loading' }
  | { status: 'ok'; months: Record<string, ApiMonthTotals> }
  | { status: 'failed' };

/**
 * Aporte de la API para un mes (`'2026-04'`). `null` = no lo sabemos (cargando
 * o falló). Un mes ausente en una respuesta OK es 0: la RPC sólo lista meses
 * con movimiento.
 */
export function apiForMonth(
  state: ApiTotalsState,
  monthKey: string,
): { deposits: number | null; withdrawals: number | null } {
  if (state.status !== 'ok') return { deposits: null, withdrawals: null };
  const m = state.months[monthKey];
  return m ? { deposits: m.deposits, withdrawals: m.withdrawals } : { deposits: 0, withdrawals: 0 };
}

/** Lo que `rowMoney` necesita de una fila (subconjunto de PeriodRowContext). */
export interface RowMoneyInput {
  summary: {
    totalDeposits?: number;
    totalWithdrawals?: number;
    netDeposit?: number;
    withdrawals?: Array<{ category: string; amount: number }>;
  } | null | undefined;
  apiDeposits: number | null;
  apiWithdrawals: number | null;
  /** ¿El mes se rige por la regla «broker derivado de la API» (Abr 2026+)? */
  isDerived: boolean;
}

export interface RowMoney {
  totalDeposits: number | null;
  totalWithdrawals: number | null;
  netDeposit: number | null;
}

/**
 * Los tres números de depósitos/retiros/ND de una fila, por el ÚNICO camino
 * canónico (`computeDerivedNetDeposit`), respetando si el período es derivado.
 *
 * ── EL BUG (auditoría de finanzas, ítem 16) ────────────────────────────────
 * Esta tabla tenía la CUARTA reimplementación inline del Net Deposit
 * (`apiDeposits + summary.totalDeposits` para TODOS los períodos) y no miraba
 * `isDerivedBrokerPeriod`. Medido el 2026-08-31 sobre Vex Pro: marzo 2026
 * —cerrado, con sus totales cargados a mano— mostraba $1.157.152,72 acá contra
 * $1.046.382 en /balances, porque le sumaba encima las 381 filas de UniPayment
 * de 2026-03 que la API tiene persistidas ($110.770,72). El mismo mes cerrado,
 * dos números, en dos pantallas del mismo menú.
 *
 * (Movida tal cual desde page.tsx el 2026-10-12; lo único nuevo es que un mes
 * derivado sin dato de la API devuelve `null` en vez de sumar un 0 inventado.)
 */
export function rowMoney(c: RowMoneyInput): RowMoney {
  const manualBroker = c.summary?.withdrawals?.find((w) => w.category === 'broker')?.amount ?? 0;

  if (!c.isDerived) {
    // Meses históricos (≤ Mar 2026): manda lo cargado a mano, igual que
    // /balances (que usa `summary.netDeposit` para estos períodos).
    return {
      totalDeposits: c.summary?.totalDeposits ?? 0,
      totalWithdrawals: c.summary?.totalWithdrawals ?? 0,
      netDeposit: c.summary?.netDeposit ?? 0,
    };
  }

  // Mes derivado sin el aporte de la API: no hay número que mostrar.
  if (c.apiDeposits === null || c.apiWithdrawals === null) {
    return { totalDeposits: null, totalWithdrawals: null, netDeposit: null };
  }

  return computeDerivedNetDeposit({
    apiDeposits: c.apiDeposits,
    manualDepositsTotal: c.summary?.totalDeposits ?? 0,
    apiWithdrawals: c.apiWithdrawals,
    manualBroker,
  });
}

export type TotalRule = 'sum' | 'last' | 'none';

/**
 * Total de una columna sobre los meses visibles, con la regla de antes
 * ('sum' suma; 'last' toma el último mes; 'none' no tiene total).
 * Nuevo: si algún sumando es `null`, el total es `null` («—»). Una suma que
 * saltea un mes sin dato es exactamente el número plausible y equivocado.
 * Sin meses, 'sum' y 'last' dan 0 (como antes: el CSV escribe `0.00`).
 */
export function columnTotal(values: ReadonlyArray<number | null>, rule: TotalRule): number | null | undefined {
  if (rule === 'none') return undefined;
  if (rule === 'last') {
    return values.length === 0 ? 0 : values[values.length - 1];
  }
  let acc = 0;
  for (const v of values) {
    if (v === null) return null;
    acc += v;
  }
  return acc;
}

/** Celda de CSV: `toFixed(2)` como siempre; vacía si no lo sabemos (un 0 se sumaría en la planilla). */
export function csvAmount(value: number | null | undefined): string {
  return value == null ? '' : value.toFixed(2);
}

/** ¿Cuántos meses visibles dependen de la API y quedaron sin dato? Para el aviso. */
export function monthsMissingApi(rows: ReadonlyArray<RowMoneyInput>): number {
  return rows.filter((r) => r.isDerived && (r.apiDeposits === null || r.apiWithdrawals === null)).length;
}
