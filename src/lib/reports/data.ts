// ─────────────────────────────────────────────────────────────────────────────
// Report data builder — used by both /api/reports/consolidated (the page)
// AND the daily/weekly/monthly cron jobs that send emails.
//
// Kept decoupled from any HTTP layer so crons can import it directly
// without a self-fetch. Fan-out uses Promise.allSettled so one flaky
// provider doesn't take the whole report down.
// ─────────────────────────────────────────────────────────────────────────────

import { createAdminClient } from '@/lib/supabase/admin';
import { getOperatingWalletIds } from '@/lib/pinned-wallets';
// `orion-crm/users` y `orion-crm/prop-trading` YA NO SE IMPORTAN: sus endpoints
// REST no existen para ningún inquilino y caían a datos falsos. Las dos
// secciones salen del espejo (./crm-mirror.ts). Sólo `broker-pnl` sobrevive
// como fallback para el inquilino sin ningún día en `crm_daily_pnl`.
import { fetchOrionCrmBrokerPnl } from '@/lib/api-integrations/orion-crm/broker-pnl';
import { ACCEPTED_STATUS as PROVIDER_ACCEPTED_STATUS } from '@/lib/api-integrations/totals';
import {
  withWithdrawalStatuses,
  withdrawalChannelOfRow,
  type WithdrawalChannel,
} from '@/lib/withdrawal-channels';
import { buildBalancesByChannel, type ReportBalancesByChannel } from './balances-by-channel';
import { loadCrmUsersFromMirror, loadPropTradingFromMirror } from './crm-mirror';
import { loadCrmDailyPnl, type CrmDailyPnlSeries } from '@/lib/crm-sync/daily-pnl-query';
import { features } from '@/lib/business-model';
import {
  buildCompanyResult,
  periodsInRange,
  type CompanyResultReport,
  type IncomeLineRow,
} from './company-report';

interface DepositRow {
  channel: string;
  amount: number | string;
}
interface WithdrawalRow {
  category: string;
  amount: number | string;
}
type ApiTx = {
  provider: string;
  amount: number | string;
  status?: string;
  transaction_date: string;
  wallet_id?: string | null;
  /** Transferencia interna entre wallets propias (txid null en Coinsbuy).
   *  No cuenta en Retiros Totales ni Net Deposit. */
  internal?: boolean | null;
};

// Accepted-status whitelist — matches /balances y
// /api/integrations/period-totals exactamente porque SALE DEL MISMO SITIO:
// `ACCEPTED_STATUS` de api-integrations/totals.ts, que es el registro único.
//
// Antes era una copia literal acá, y cuando entró Pay-Pros (2026-07-22) esta
// copia no se enteró: el informe por mail mandaba los depósitos SIN Pay-Pros
// mientras el libro del canal sí los contaba. Mismo bug que la tarjeta de
// /movimientos, otra copia. Un proveedor que no esté en el mapa se descarta
// entero (el `if (!accepted) continue` de abajo), que es justo el descarte
// silencioso que el repo prohíbe.
//
// ── EL MISMO BUG, OTRA ÉPOCA (CORRECCIÓN 2026-08-31) ───────────────────────
// El párrafo de arriba narra el bug de los depósitos y da a entender que quedó
// cerrado. No quedó: el LADO DE LOS RETIROS tenía exactamente la misma forma.
// `PROVIDER_ACCEPTED_STATUS` solo conoce el status de ENTRADA de cada
// proveedor ('paid' en Pay-Pros), así que las filas 'payout_paid' —retiros—
// caían en el `if (r.status && !accepted.includes(r.status)) continue`, y más
// abajo el único proveedor tratado como salida era 'coinsbuy-withdrawals'.
// Resultado medido al 2026-08-31: los 6 retiros de Pay-Pros por US$ 2.617,62
// que el espejo del CRM proyecta (paypros/withdrawals-from-crm.ts) NO
// aparecían como retiro en pantalla, ni en el PDF, ni en el mail — y por lo
// tanto inflaban el Net Deposit del informe, en silencio.
//
// La lista de canales de retiro NO se escribe acá: sale de
// `withdrawal-channels.ts`, el registro único creado el 2026-08-31 justamente
// para que las dos puntas (pantalla de movimientos y persistencia) dejaran de
// discrepar. Éste es el tercer consumidor y hereda el dato en vez de copiarlo.
const ACCEPTED_STATUS: Record<string, string[]> = withWithdrawalStatuses(
  Object.fromEntries(
    Object.entries(PROVIDER_ACCEPTED_STATUS).map(([slug, status]) => [slug, [status]]),
  ),
);

export interface ReportDepositRow {
  channel: string;
  count: number;
  amount: number;
}
export interface ReportWithdrawalRow {
  category: string;
  count: number;
  amount: number;
}

export interface ReportBucket {
  deposits: ReportDepositRow[];
  withdrawals: ReportWithdrawalRow[];
  total_deposits: number;
  total_withdrawals: number;
  net_deposit: number;
}

/**
 * El PNL que el CRM da como cerrado, listo para el correo.
 *
 * Todos los importes ya están en DÓLARES y con el signo del BRÓKER (positivo =
 * ganó el bróker). En la tabla se guarda el del cliente, que es el signo del
 * panel de Orion; la inversión ocurre UNA vez, acá, y no en cada plantilla.
 */
export interface ReportCrmPnl {
  /** El día que cerró y su resultado. Para el reporte DIARIO es "el" número. */
  last_day: string | null;
  last_broker_pnl: number | null;
  /** Acumulado del rango del reporte (semanal/mensual). */
  broker_pnl_range: number | null;
  volume_lots_range: number;
  deals_range: number;
  /** Sobre cuántos días se calculó, y cuáles faltan. Un total incompleto
   *  tiene que poder decirlo: si no, es un número más chico y creíble. */
  days_with_data: number;
  days_missing: string[];
}

export interface ReportData {
  range: { from: string; to: string };
  this_month: { from: string; to: string };
  prev_month: { from: string; to: string };
  deposits_withdrawals: {
    range: ReportBucket;
    month: ReportBucket;
    prev_month: {
      total_deposits: number;
      total_withdrawals: number;
      net_deposit: number;
    };
  };
  crm_users: {
    new_users_in_range: number;
    new_users_this_month: number;
    total_users: number;
    connected: boolean;
    isMock: boolean;
  };
  broker_pnl: {
    /**
     * `null` = NO LO SABEMOS. Hasta el 2026-08-31 esto colapsaba a 0 con un
     * `?? 0`, y el correo mostraba «Broker P&L $0,00» en verde mientras el
     * bloque de abajo, honesto, decía «29 días sin dato». Dos afirmaciones
     * contradictorias en la misma pantalla, y la que se lee primero era la
     * falsa. AP Markets tiene 29 días faltantes: ese cero era una mentira
     * bien formateada (§1.3).
     */
    pnl_range: number | null;
    pnl_month: number | null;
    pnl_prev_month: number | null;
    connected: boolean;
    isMock: boolean;
    /**
     * El cierre diario que da el CRM (`crm_daily_pnl`, migración 106).
     *
     * `null` cuando el tenant todavía no tiene ni un día guardado — y ahí, y
     * sólo ahí, los tres números de arriba siguen viniendo del endpoint REST
     * de Orion (que para Vex Pro no está configurado y devuelve datos falsos).
     * Cuando hay dato, los tres SALEN DE ACÁ y `isMock` es false.
     */
    crm: ReportCrmPnl | null;
  };
  /**
   * Prop Trading, desde `crm_monthly_totals` (ver reports/crm-mirror.ts).
   *
   * TODO numérico es `number | null` porque el espejo es MENSUAL: para un
   * informe diario, «las ventas del 15 de agosto» no existen en esa tabla y
   * repartir el mes entre sus días sería fabricar un número. `products` es
   * `null` y no `[]` por la misma razón: el espejo guarda el total del mes,
   * no qué se vendió, y una lista vacía se lee como «no se vendió nada».
   */
  prop_trading: {
    products: Array<{ name: string; quantity: number; amount: number }> | null;
    total_sales_range: number | null;
    total_sales_month: number | null;
    prop_withdrawals_range: number | null;
    prop_withdrawals_count_range: number | null;
    pnl_range: number | null;
    pnl_month: number | null;
    pnl_prev_month: number | null;
    connected: boolean;
    isMock: boolean;
  };
  balances_by_channel: ReportBalancesByChannel;
  /**
   * Facturación / egresos / resultado de una empresa de servicios.
   *
   * `null` para un broker: su reporte ya responde esa pregunta con Net
   * Deposit y Broker P&L. Para una consultora es AL REVÉS — sin esto, su
   * reporte diario salía con "Balances por Canal" y nada más, sin una sola
   * cifra de lo que factura (que es todo su negocio).
   */
  company_result: CompanyResultReport | null;
  /** True if any of the Orion sections returned mock data — the report
   *  surfaces this as a subtle notice so readers know the numbers aren't
   *  fully live yet. */
  anyMock: boolean;
  /** Sources that failed outright. Used by the cron to add a "could not
   *  reach X" note in the email footer. */
  failures: string[];
}

function monthBounds(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}

/**
 * Returns the list of calendar months fully covered by [from, to].
 *
 * The `deposits` / `withdrawals` tables store MONTHLY aggregates (one row
 * per channel per period). They only contribute to a range when the range
 * spans entire months — a sub-month range (e.g. "Today", "Last 7 days")
 * cannot meaningfully pull in a whole month's aggregate.
 *
 *   fullMonthsInRange('2026-04-01', '2026-04-30')  → [{y:2026, m:4}]
 *   fullMonthsInRange('2026-04-01', '2026-05-31')  → [4, 5]
 *   fullMonthsInRange('2026-04-15', '2026-04-20')  → []  // sub-month
 *   fullMonthsInRange('2026-04-22', '2026-04-22')  → []  // single day
 */
function fullMonthsInRange(
  from: string,
  to: string,
): Array<{ year: number; month: number }> {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return [];
  if (fd !== 1) return [];
  const lastDay = new Date(ty, tm, 0).getDate();
  if (td !== lastDay) return [];
  const out: Array<{ year: number; month: number }> = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ year: y, month: m });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

function groupRows<T extends { amount: number | string }>(
  rows: T[],
  keyFn: (r: T) => string,
): Array<{ key: string; count: number; amount: number }> {
  const map = new Map<string, { count: number; amount: number }>();
  for (const r of rows) {
    const k = keyFn(r);
    const amt = Number(r.amount) || 0;
    const prev = map.get(k) ?? { count: 0, amount: 0 };
    map.set(k, { count: prev.count + 1, amount: prev.amount + amt });
  }
  return Array.from(map, ([key, v]) => ({ key, ...v }));
}

function groupApiTx(
  rows: ApiTx[],
  /** Set of Coinsbuy wallet_id strings the user has pinned. Coinsbuy rows
   *  whose wallet_id is not in this set are SKIPPED. When the set is
   *  null we count every Coinsbuy row (the tenant hasn't pinned any
   *  wallet yet, so showing the full picture is the only sensible
   *  fallback). FairPay / UniPayment ignore this set — they don't carry
   *  wallet semantics in the same way. */
  pinnedCoinsbuyIds: Set<string> | null = null,
) {
  const depositsByChannel = new Map<string, { count: number; amount: number }>();
  const withdrawalsByChannel = new Map<WithdrawalChannel, { count: number; amount: number }>();
  for (const r of rows) {
    const accepted = ACCEPTED_STATUS[r.provider];
    if (!accepted) continue;
    if (r.status && !accepted.includes(r.status)) continue;

    // Wallet scoping for Coinsbuy. The user expects reports to reflect
    // ONLY their pinned wallets — historically this rolled up every
    // wallet the API returned (including orphan / closed / test
    // accounts), inflating both deposits and withdrawals.
    if (
      pinnedCoinsbuyIds &&
      (r.provider === 'coinsbuy-deposits' || r.provider === 'coinsbuy-withdrawals')
    ) {
      const wid = r.wallet_id ? String(r.wallet_id) : null;
      if (!wid || !pinnedCoinsbuyIds.has(wid)) continue;
    }

    // Transferencias internas entre wallets propias (txid null en Coinsbuy):
    // no cuentan en Retiros Totales ni Net Deposit. Solo aplica al lado de
    // retiros — el lado receptor no aparece como depósito (verificado).
    if (r.provider === 'coinsbuy-withdrawals' && r.internal === true) continue;

    const amt = Number(r.amount) || 0;
    const wdrChannel = withdrawalChannelOfRow(r);
    if (wdrChannel) {
      const prev = withdrawalsByChannel.get(wdrChannel) ?? { count: 0, amount: 0 };
      withdrawalsByChannel.set(wdrChannel, { count: prev.count + 1, amount: prev.amount + amt });
    } else {
      const channel = r.provider.replace('-deposits', '');
      const prev = depositsByChannel.get(channel) ?? { count: 0, amount: 0 };
      depositsByChannel.set(channel, {
        count: prev.count + 1,
        amount: prev.amount + amt,
      });
    }
  }
  return {
    depositsByChannel: Array.from(depositsByChannel, ([channel, v]) => ({
      key: channel,
      ...v,
    })),
    // Una fila por canal de retiro. Antes era un único acumulador llamado
    // `withdrawals` que solo podía contener Coinsbuy; con dos canales, sumarlos
    // en una sola línea rotulada «Coinsbuy (API)» habría sido el mismo tipo de
    // mentira que la línea de regularización del libro.
    withdrawalsByChannel: Array.from(withdrawalsByChannel, ([key, v]) => ({ key, ...v })),
  };
}

/** Filas de retiro por API, con la categoría que la UI/PDF/mail ya rotulan. */
function apiWithdrawalRows(
  byChannel: Array<{ key: WithdrawalChannel; count: number; amount: number }>,
): ReportWithdrawalRow[] {
  return byChannel
    .filter((w) => w.amount > 0)
    .map((w) => ({ category: `${w.key}_api`, count: w.count, amount: w.amount }));
}

function mergeDeposits(
  manual: Array<{ key: string; count: number; amount: number }>,
  api: Array<{ key: string; count: number; amount: number }>,
): ReportDepositRow[] {
  const map = new Map<string, { count: number; amount: number }>();
  for (const r of [...manual, ...api]) {
    const prev = map.get(r.key) ?? { count: 0, amount: 0 };
    map.set(r.key, { count: prev.count + r.count, amount: prev.amount + r.amount });
  }
  return Array.from(map, ([channel, v]) => ({ channel, ...v }));
}

const sumRows = (rows: Array<{ amount: number }>) =>
  rows.reduce((s, r) => s + r.amount, 0);

/**
 * Resultado del período para una empresa de servicios. Devuelve `null`
 * cuando el modelo de negocio no lo admite (un broker) — así el email decide
 * con la presencia del bloque y no con otro flag paralelo.
 *
 * Los números NO se calculan acá: salen de `buildCompanyResult`, el mismo
 * `buildBilling`/`buildExpenses` que arma la pantalla de reportes. Lo único
 * que hace esta función es traer las filas.
 */
async function buildCompanyResultFor(
  companyId: string,
  from: string,
  to: string,
): Promise<CompanyResultReport | null> {
  const admin = createAdminClient();
  const { data: companyRow } = await admin
    .from('companies')
    .select('business_model')
    .eq('id', companyId)
    .maybeSingle();

  // Sin depósitos de clientes y facturando servicios = la contabilidad que
  // este bloque cuenta. Es el mismo registro que apaga las otras secciones.
  const f = features((companyRow as { business_model?: unknown } | null)?.business_model);
  if (f.deposits || !f.incomeLines) return null;

  const { data: periodRows } = await admin
    .from('periods')
    .select('id, year, month, label')
    .eq('company_id', companyId);

  const covered = periodsInRange(
    ((periodRows ?? []) as Array<{ id: string; year: number; month: number; label: string | null }>),
    from,
    to,
  );
  // Rango fuera de la contabilidad cargada: el bloque igual va, en cero y
  // sin meses — decir "no hay datos de este rango" es información, esconderlo
  // parecería que el reporte se rompió.
  if (covered.length === 0) return buildCompanyResult([], [], []);

  const periodIds = covered.map((p) => p.id);
  const [linesRes, expensesRes] = await Promise.all([
    admin
      .from('income_lines')
      .select('period_id, concept, client, amount, received, pending')
      .eq('company_id', companyId)
      .in('period_id', periodIds),
    admin
      .from('expenses')
      .select('period_id, category, amount, paid, pending')
      .eq('company_id', companyId)
      .in('period_id', periodIds),
  ]);

  const expenses = ((expensesRes.data ?? []) as Array<{
    period_id: string; category: string | null; amount: number | string; paid: number | string; pending: number | string;
  }>).map((e) => ({
    period_id: e.period_id,
    category: e.category,
    amount: Number(e.amount) || 0,
    paid: Number(e.paid) || 0,
    pending: Number(e.pending) || 0,
  }));

  return buildCompanyResult(covered, (linesRes.data ?? []) as IncomeLineRow[], expenses);
}

/**
 * Builds the full report payload for a company + date range. Pure data —
 * no HTML rendering or email sending. `referenceDate` lets callers pin
 * "this month" / "previous month" to a specific day (used by the cron
 * when it processes yesterday's data at 00:05 UTC and needs the month
 * context relative to yesterday, not today).
 */
export async function buildReportData(
  companyId: string,
  from: string,
  to: string,
  referenceDate: Date = new Date(),
): Promise<ReportData> {
  const thisMonth = monthBounds(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth() + 1,
  );
  const prevMonthDate = new Date(
    Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() - 1, 1),
  );
  const prevMonth = monthBounds(
    prevMonthDate.getUTCFullYear(),
    prevMonthDate.getUTCMonth() + 1,
  );

  const admin = createAdminClient();

  // Manual deposits/withdrawals are monthly aggregates. We only include
  // them in the range totals when the range covers entire calendar months.
  // For intra-month ranges (today, yesterday, last 7d) we only count the
  // per-transaction api_transactions rows (which have real timestamps).
  const rangeMonths = fullMonthsInRange(from, to);
  const fetchManualDepsForMonths = async (months: typeof rangeMonths): Promise<DepositRow[]> => {
    if (months.length === 0) return [];
    const results = await Promise.all(
      months.map((mo) =>
        admin
          .from('deposits')
          .select('channel, amount, periods!inner(year, month)')
          .eq('company_id', companyId)
          .eq('periods.year', mo.year)
          .eq('periods.month', mo.month),
      ),
    );
    return results.flatMap((r) => (r.data as DepositRow[] | null) ?? []);
  };
  const fetchManualWdrForMonths = async (months: typeof rangeMonths): Promise<WithdrawalRow[]> => {
    if (months.length === 0) return [];
    const results = await Promise.all(
      months.map((mo) =>
        admin
          .from('withdrawals')
          .select('category, amount, periods!inner(year, month)')
          .eq('company_id', companyId)
          .eq('periods.year', mo.year)
          .eq('periods.month', mo.month),
      ),
    );
    return results.flatMap((r) => (r.data as WithdrawalRow[] | null) ?? []);
  };

  const [
    manualDepositsRange,
    manualWithdrawalsRange,
    manualDepositsMonth,
    manualWithdrawalsMonth,
    manualDepositsPrevMonth,
    manualWithdrawalsPrevMonth,
    apiTransactionsRange,
    apiTransactionsMonth,
    apiTransactionsPrevMonth,
    crmUsers,
    crmBrokerPnl,
    crmPropTrading,
    balancesByChannel,
    companyResult,
    crmPnlRange,
    crmPnlMonth,
    crmPnlPrevMonth,
  ] = await Promise.allSettled([
    fetchManualDepsForMonths(rangeMonths),
    fetchManualWdrForMonths(rangeMonths),
    admin
      .from('deposits')
      .select('channel, amount, periods!inner(year, month)')
      .eq('company_id', companyId)
      .eq('periods.year', referenceDate.getUTCFullYear())
      .eq('periods.month', referenceDate.getUTCMonth() + 1),
    admin
      .from('withdrawals')
      .select('category, amount, periods!inner(year, month)')
      .eq('company_id', companyId)
      .eq('periods.year', referenceDate.getUTCFullYear())
      .eq('periods.month', referenceDate.getUTCMonth() + 1),
    admin
      .from('deposits')
      .select('channel, amount, periods!inner(year, month)')
      .eq('company_id', companyId)
      .eq('periods.year', prevMonthDate.getUTCFullYear())
      .eq('periods.month', prevMonthDate.getUTCMonth() + 1),
    admin
      .from('withdrawals')
      .select('category, amount, periods!inner(year, month)')
      .eq('company_id', companyId)
      .eq('periods.year', prevMonthDate.getUTCFullYear())
      .eq('periods.month', prevMonthDate.getUTCMonth() + 1),
    admin
      .from('api_transactions')
      .select('provider, amount, status, transaction_date, wallet_id, internal')
      .eq('company_id', companyId)
      .gte('transaction_date', `${from}T00:00:00.000Z`)
      .lte('transaction_date', `${to}T23:59:59.999Z`)
      .limit(10000),
    admin
      .from('api_transactions')
      .select('provider, amount, status, transaction_date, wallet_id, internal')
      .eq('company_id', companyId)
      .gte('transaction_date', `${thisMonth.from}T00:00:00.000Z`)
      .lte('transaction_date', `${thisMonth.to}T23:59:59.999Z`)
      .limit(10000),
    admin
      .from('api_transactions')
      .select('provider, amount, status, transaction_date, wallet_id, internal')
      .eq('company_id', companyId)
      .gte('transaction_date', `${prevMonth.from}T00:00:00.000Z`)
      .lte('transaction_date', `${prevMonth.to}T23:59:59.999Z`)
      .limit(10000),
    // Usuarios y Prop Trading salen del ESPEJO, no del REST (auditoría
    // 2026-08-31): `api_credentials` no tiene ninguna fila `orion_crm` en
    // producción, así que los fetchers REST caían a mock/ceros y el informe
    // salía con números inventados bajo un título real. Ver reports/crm-mirror.ts.
    loadCrmUsersFromMirror(admin, companyId, from, to, thisMonth.from, thisMonth.to),
    fetchOrionCrmBrokerPnl(companyId, from, to),
    loadPropTradingFromMirror(
      admin,
      companyId,
      from,
      to,
      { year: referenceDate.getUTCFullYear(), month: referenceDate.getUTCMonth() + 1 },
      { year: prevMonthDate.getUTCFullYear(), month: prevMonthDate.getUTCMonth() + 1 },
    ),
    buildBalancesByChannel(companyId, to),
    buildCompanyResultFor(companyId, from, to),
    // El PNL que el CRM da como cerrado (migración 106). Tres rangos porque el
    // correo compara el rango contra el mes y contra el anterior, igual que
    // hacía el endpoint REST al que reemplaza.
    loadCrmDailyPnl(admin, companyId, from, to),
    loadCrmDailyPnl(admin, companyId, thisMonth.from, thisMonth.to),
    loadCrmDailyPnl(admin, companyId, prevMonth.from, prevMonth.to),
  ]);

  const safeData = <T>(
    r: PromiseSettledResult<{ data: T[] | null; error: unknown } | T[] | unknown>,
  ): T[] => {
    if (r.status !== 'fulfilled') return [];
    if (Array.isArray(r.value)) return r.value as T[];
    const v = r.value as { data?: T[] | null } | null | undefined;
    return v?.data ?? [];
  };
  const unwrap = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === 'fulfilled' ? r.value : fallback;

  const failures: string[] = [];
  if (manualDepositsRange.status !== 'fulfilled') failures.push('deposits');
  if (manualWithdrawalsRange.status !== 'fulfilled') failures.push('withdrawals');
  if (apiTransactionsRange.status !== 'fulfilled') failures.push('api_transactions');
  if (crmUsers.status !== 'fulfilled') failures.push('crm_user_snapshots');
  if (crmBrokerPnl.status !== 'fulfilled') failures.push('orion_crm_broker_pnl');
  if (crmPropTrading.status !== 'fulfilled') failures.push('crm_monthly_totals');
  if (balancesByChannel.status !== 'fulfilled') failures.push('balances_by_channel');
  if (companyResult.status !== 'fulfilled') failures.push('company_result');

  const manualDepRange = groupRows(safeData<DepositRow>(manualDepositsRange), (r) => r.channel);
  const manualWdrRange = groupRows(safeData<WithdrawalRow>(manualWithdrawalsRange), (r) => r.category);
  const manualDepMonth = groupRows(safeData<DepositRow>(manualDepositsMonth), (r) => r.channel);
  const manualWdrMonth = groupRows(safeData<WithdrawalRow>(manualWithdrawalsMonth), (r) => r.category);
  const manualDepPrev = groupRows(safeData<DepositRow>(manualDepositsPrevMonth), (r) => r.channel);
  const manualWdrPrev = groupRows(safeData<WithdrawalRow>(manualWithdrawalsPrevMonth), (r) => r.category);

  // Scope every Coinsbuy aggregation to the tenant's OPERATING wallets.
  //
  // Kevin (2026-06-06): "los informes están mandando también los depósitos
  // y retiros de otra wallet". El fallback antiguo era "si no hay pinned,
  // contar TODAS las wallets" — y eso filtraba datos cross-tenant a los
  // reportes. Nuevo orden de fallback:
  //   1. wallets pineadas OPERATIVAS si hay → usar ese set
  //   2. companies.default_wallet_id si está seteado → usar solo esa wallet
  //   3. null (todas las wallets) → único caso legacy donde no hay nada
  //      configurado, advertimos por logs.
  //
  // Operativas y no "todas las pineadas" (migración 084): el reporte informa
  // depósitos y retiros de CLIENTES. Las wallets internas (Vex Pro: 1087
  // "Savings" $400.014,00 y 1705 "Egresos Vex" $62.779,85 en agosto 2026)
  // suman al balance pero mover plata ahí no es un retiro — contarlas dejaba
  // el Net Deposit del reporte en −$231.127.
  const operatingWalletIds = await getOperatingWalletIds(companyId);
  let pinnedCoinsbuyIds: Set<string> | null = null;
  if (operatingWalletIds.length > 0) {
    pinnedCoinsbuyIds = new Set(operatingWalletIds);
  } else {
    const { data: companyRow } = await admin
      .from('companies')
      .select('default_wallet_id')
      .eq('id', companyId)
      .maybeSingle();
    if (companyRow?.default_wallet_id) {
      pinnedCoinsbuyIds = new Set([String(companyRow.default_wallet_id)]);
    } else {
      // Hardened (Kevin 2026-06-06 code review): el fallback antiguo era
      // "count-all" silencioso, que filtraba data cross-wallet a los
      // reportes y solo se notaba via console.warn. Ahora bloqueamos
      // todas las wallets Coinsbuy (Set vacío → filter exige match
      // estricto, nada pasa) y elevamos a Sentry para que el operador
      // configure pinned o default_wallet_id explícitamente.
      pinnedCoinsbuyIds = new Set();
      try {
        const Sentry = await import('@sentry/nextjs');
        Sentry.captureMessage('Report wallet scope missing', {
          level: 'warning',
          tags: { area: 'reports.data', kind: 'no-wallet-scope' },
          extra: { companyId },
        });
      } catch {
        // Sentry not available — fall back to console.error so it
        // still ends up in Vercel logs.
        console.error(
          `[reports] company ${companyId} has no OPERATING pinned wallet and no default_wallet_id — Coinsbuy totals will be 0 until one is set. Refusing to count all wallets to prevent cross-tenant data in reports.`,
        );
      }
    }
  }

  const apiRange = groupApiTx(safeData<ApiTx>(apiTransactionsRange), pinnedCoinsbuyIds);
  const apiMonth = groupApiTx(safeData<ApiTx>(apiTransactionsMonth), pinnedCoinsbuyIds);
  const apiPrev = groupApiTx(safeData<ApiTx>(apiTransactionsPrevMonth), pinnedCoinsbuyIds);

  const depositsRange = mergeDeposits(manualDepRange, apiRange.depositsByChannel);
  const depositsMonth = mergeDeposits(manualDepMonth, apiMonth.depositsByChannel);
  const depositsPrev = mergeDeposits(manualDepPrev, apiPrev.depositsByChannel);

  const withdrawalsRange: ReportWithdrawalRow[] = [
    ...manualWdrRange.map((w) => ({ category: w.key, count: w.count, amount: w.amount })),
    ...apiWithdrawalRows(apiRange.withdrawalsByChannel),
  ];
  const withdrawalsMonth: ReportWithdrawalRow[] = [
    ...manualWdrMonth.map((w) => ({ category: w.key, count: w.count, amount: w.amount })),
    ...apiWithdrawalRows(apiMonth.withdrawalsByChannel),
  ];
  const withdrawalsPrev: ReportWithdrawalRow[] = [
    ...manualWdrPrev.map((w) => ({ category: w.key, count: w.count, amount: w.amount })),
    ...apiWithdrawalRows(apiPrev.withdrawalsByChannel),
  ];

  const totalDepositsRange = sumRows(depositsRange);
  const totalWithdrawalsRange = sumRows(withdrawalsRange);
  const totalDepositsMonth = sumRows(depositsMonth);
  const totalWithdrawalsMonth = sumRows(withdrawalsMonth);
  const totalDepositsPrev = sumRows(depositsPrev);
  const totalWithdrawalsPrev = sumRows(withdrawalsPrev);

  const crmUsersResult = unwrap(crmUsers, {
    new_users_in_range: 0,
    new_users_this_month: 0,
    total_users: 0,
    connected: false,
    isMock: false,
  });
  const brokerPnlResult = unwrap(crmBrokerPnl, {
    pnl_range: 0,
    pnl_month: 0,
    pnl_prev_month: 0,
    connected: false,
    isMock: false,
    errorMessage: null,
  });
  const propTradingResult = unwrap(crmPropTrading, {
    // El fallback de una LECTURA FALLIDA es «no lo sabemos», no cero: si la
    // consulta al espejo se cayó, escribir $0,00 en «Ventas Prop Firm» es
    // afirmar que no se vendió nada (§1.3).
    products: null,
    total_sales_range: null,
    total_sales_month: null,
    prop_withdrawals_range: null,
    prop_withdrawals_count_range: null,
    pnl_range: null,
    pnl_month: null,
    pnl_prev_month: null,
    connected: false,
    isMock: false,
  });
  const balancesByChannelResult = unwrap(balancesByChannel, {
    channels: [],
    total: 0,
    asOf: to,
  });

  // ── El PNL del bróker, ahora con el número real del CRM ─────────────────
  //
  // Kevin, 2026-08-31: «debemos tomar el dato que da el crm». Hasta hoy esta
  // sección salía de `fetchOrionCrmBrokerPnl`, que pega contra un endpoint
  // REST `/v1/broker-pnl` de Orion. Vex Pro NO tiene la credencial `orion_crm`
  // cargada (ocho credenciales configuradas ese día, y esa no está), así que
  // la llamada caía al generador de datos falsos y el correo salía con un
  // número inventado bajo el título "Broker P&L".
  //
  // Cuando hay aunque sea un día guardado en `crm_daily_pnl`, los tres números
  // salen de ahí. Si no hay ninguno se conserva el camino viejo: quitarlo
  // dejaría sin sección a un tenant que sí tenga el endpoint.
  //
  // EL SIGNO SE INVIERTE ACÁ Y SÓLO ACÁ. La tabla guarda el PNL del CLIENTE
  // (el signo del panel de Orion); "Broker P&L" es lo contrario. Hacerlo una
  // vez, en un lugar con nombre, evita que la mitad de las plantillas termine
  // mostrando la ganancia del cliente con el rótulo del bróker.
  const serieVacia: CrmDailyPnlSeries = {
    range: { from, to },
    rows: [],
    daysMissing: [],
    totals: {
      clientsPnl: null, brokerPnl: null, volumeLots: 0,
      dealsCount: 0, daysWithData: 0, unmatchedAccounts: 0,
    },
    last: null,
  };
  const crmRango = unwrap(crmPnlRange, serieVacia);
  const crmMes = unwrap(crmPnlMonth, serieVacia);
  const crmMesPrevio = unwrap(crmPnlPrevMonth, serieVacia);
  if (crmPnlRange.status !== 'fulfilled') failures.push('crm_daily_pnl');

  const hayCrmPnl =
    crmRango.totals.daysWithData > 0 ||
    crmMes.totals.daysWithData > 0 ||
    crmMesPrevio.totals.daysWithData > 0;

  const crmPnl: ReportCrmPnl | null = hayCrmPnl
    ? {
        last_day: crmRango.last?.utc_day ?? null,
        last_broker_pnl:
          crmRango.last == null || crmRango.last.pnl_usd === null
            ? null
            : -crmRango.last.pnl_usd,
        broker_pnl_range: crmRango.totals.brokerPnl,
        volume_lots_range: crmRango.totals.volumeLots,
        deals_range: crmRango.totals.dealsCount,
        days_with_data: crmRango.totals.daysWithData,
        days_missing: crmRango.daysMissing,
      }
    : null;

  // `?? 0` NO: el total del CRM ya distingue «no hay ningún día con dato»
  // (null) de «los días dan cero». Colapsarlo acá era lo que hacía que el
  // correo dijera «Broker P&L $0,00» en verde arriba y «29 días sin dato»
  // abajo, en la misma pantalla (AP Markets, 2026-08).
  const brokerPnlFinal = crmPnl
    ? {
        pnl_range: crmRango.totals.brokerPnl,
        pnl_month: crmMes.totals.brokerPnl,
        pnl_prev_month: crmMesPrevio.totals.brokerPnl,
        connected: true,
        isMock: false,
        crm: crmPnl,
      }
    : {
        pnl_range: brokerPnlResult.pnl_range,
        pnl_month: brokerPnlResult.pnl_month,
        pnl_prev_month: brokerPnlResult.pnl_prev_month,
        connected: brokerPnlResult.connected,
        isMock: brokerPnlResult.isMock,
        crm: null,
      };

  const anyMock =
    crmUsersResult.isMock ||
    brokerPnlFinal.isMock ||
    propTradingResult.isMock;

  return {
    range: { from, to },
    this_month: thisMonth,
    prev_month: prevMonth,
    deposits_withdrawals: {
      range: {
        deposits: depositsRange,
        withdrawals: withdrawalsRange,
        total_deposits: totalDepositsRange,
        total_withdrawals: totalWithdrawalsRange,
        net_deposit: totalDepositsRange - totalWithdrawalsRange,
      },
      month: {
        deposits: depositsMonth,
        withdrawals: withdrawalsMonth,
        total_deposits: totalDepositsMonth,
        total_withdrawals: totalWithdrawalsMonth,
        net_deposit: totalDepositsMonth - totalWithdrawalsMonth,
      },
      prev_month: {
        total_deposits: totalDepositsPrev,
        total_withdrawals: totalWithdrawalsPrev,
        net_deposit: totalDepositsPrev - totalWithdrawalsPrev,
      },
    },
    crm_users: {
      new_users_in_range: crmUsersResult.new_users_in_range,
      new_users_this_month: crmUsersResult.new_users_this_month,
      total_users: crmUsersResult.total_users,
      connected: crmUsersResult.connected,
      isMock: crmUsersResult.isMock,
    },
    broker_pnl: brokerPnlFinal,
    prop_trading: {
      products: propTradingResult.products,
      total_sales_range: propTradingResult.total_sales_range,
      total_sales_month: propTradingResult.total_sales_month,
      prop_withdrawals_range: propTradingResult.prop_withdrawals_range,
      prop_withdrawals_count_range: propTradingResult.prop_withdrawals_count_range,
      pnl_range: propTradingResult.pnl_range,
      pnl_month: propTradingResult.pnl_month,
      pnl_prev_month: propTradingResult.pnl_prev_month,
      connected: propTradingResult.connected,
      isMock: propTradingResult.isMock,
    },
    balances_by_channel: balancesByChannelResult,
    company_result: unwrap<CompanyResultReport | null>(companyResult, null),
    anyMock,
    failures,
  };
}
