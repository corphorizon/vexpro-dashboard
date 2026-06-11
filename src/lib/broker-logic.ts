// ─────────────────────────────────────────────────────────────────────────────
// Broker withdrawal logic — manual vs derived
//
// Historical periods (≤ March 2026) stored the "broker" withdrawal amount as a
// manually-entered value in Supabase. Starting April 2026, that field is no
// longer entered by hand: it is DERIVED on-screen as the difference between
// the total Coinsbuy API withdrawals for the period and the other manual
// withdrawal categories (IB, Prop Firm, Otros).
//
// Historical rows in the database are NEVER rewritten by this change. This
// module is pure UI logic: given a period, it decides whether to display the
// stored value (historical) or the derived value (April 2026+). The cutoff
// is intentionally expressed as a date so that the same function can be
// called from any page without needing extra flags on the period record.
// ─────────────────────────────────────────────────────────────────────────────

export interface BrokerLogicPeriod {
  year: number;
  month: number; // 1-12
}

/**
 * Cutoff = April 2026. Any period from this month onward uses the new
 * "broker is derived from API withdrawals" rule. Earlier periods keep
 * their manually-entered broker value untouched.
 */
export const BROKER_DERIVED_FROM_YEAR = 2026;
export const BROKER_DERIVED_FROM_MONTH = 4;

export function isDerivedBrokerPeriod(period: BrokerLogicPeriod): boolean {
  if (period.year > BROKER_DERIVED_FROM_YEAR) return true;
  if (
    period.year === BROKER_DERIVED_FROM_YEAR &&
    period.month >= BROKER_DERIVED_FROM_MONTH
  ) {
    return true;
  }
  return false;
}

/**
 * True only when every period in `periods` is on the new rule. We require
 * "all" (not "some") so that a consolidated view that mixes historical and
 * current months falls back to the stored values and leaves history intact.
 */
export function allPeriodsUseDerivedBroker(
  periods: BrokerLogicPeriod[]
): boolean {
  if (periods.length === 0) return false;
  return periods.every(isDerivedBrokerPeriod);
}

/**
 * Derived broker = max(0, API withdrawals − IB − Prop Firm − Otros).
 * Clamped at zero so a misconfigured period never shows a negative broker.
 */
export function computeDerivedBroker(input: {
  apiWithdrawalsTotal: number;
  ibCommissions: number;
  propFirm: number;
  other: number;
}): number {
  const derived =
    input.apiWithdrawalsTotal -
    input.ibCommissions -
    input.propFirm -
    input.other;
  return derived > 0 ? derived : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// FÓRMULA CANÓNICA DE NET DEPOSIT (era derived-broker, Abr 2026+).
//
// ÚNICA fuente de verdad — importada por /movimientos, /balances y los
// reportes. Antes cada uno la reimplementaba y divergían (bug del 2026-06-07:
// /balances inflaba retiros sumando ib/prop/other; /movimientos no). Tenerla
// acá + tests hace IMPOSIBLE que vuelvan a desincronizarse.
//
// Decisión final de Kevin (2026-06-06):
//   · Depósitos totales = API (cb+fp+up, scoped a wallets pinneadas)
//                       + TODO el manual cargado en /upload (cb+fp+up+otros)
//   · Retiros totales   = API withdrawals (Coinsbuy payouts, pinned-scoped)
//                       + manual Broker (suplemento Coinsbuy que la API no
//                         alcanzó a reportar)
//   · Comisiones IB / Prop Firm / Otros manuales son INFORMATIVAS — el
//     usuario las carga pero NO se suman al total de retiros.
//   · Net Deposit = depósitos − retiros
// ─────────────────────────────────────────────────────────────────────────────

export interface DerivedNetDepositInput {
  /** Suma de depósitos reportados por las APIs (Coinsbuy+FairPay+UniPayment),
   *  ya scopeada a las wallets pinneadas. */
  apiDeposits: number;
  /** Suma de TODOS los depósitos manuales del período (todos los canales,
   *  incl. "otros"). En la práctica = summary.totalDeposits. */
  manualDepositsTotal: number;
  /** Retiros reportados por la API de Coinsbuy (payouts), pinned-scoped. */
  apiWithdrawals: number;
  /** Manual de la categoría "broker" — suplemento Coinsbuy. */
  manualBroker: number;
}

export interface DerivedNetDepositResult {
  totalDeposits: number;
  totalWithdrawals: number;
  netDeposit: number;
}

export function computeDerivedNetDeposit(
  input: DerivedNetDepositInput,
): DerivedNetDepositResult {
  const totalDeposits = input.apiDeposits + input.manualDepositsTotal;
  const totalWithdrawals = input.apiWithdrawals + input.manualBroker;
  return {
    totalDeposits,
    totalWithdrawals,
    netDeposit: totalDeposits - totalWithdrawals,
  };
}
