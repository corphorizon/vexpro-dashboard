// ─────────────────────────────────────────────────────────────────────────────
// Report data builder — used by both /api/reports/consolidated (the page)
// AND the daily/weekly/monthly cron jobs that send emails.
//
// Kept decoupled from any HTTP layer so crons can import it directly
// without a self-fetch. Fan-out uses Promise.allSettled so one flaky
// provider doesn't take the whole report down.
// ─────────────────────────────────────────────────────────────────────────────

import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOrionCrmTotals } from '@/lib/api-integrations/orion-crm/totals';
import { fetchOrionCrmUsers } from '@/lib/api-integrations/orion-crm/users';
import { fetchOrionCrmBrokerPnl } from '@/lib/api-integrations/orion-crm/broker-pnl';
import { fetchOrionCrmPropTrading } from '@/lib/api-integrations/orion-crm/prop-trading';

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
};

// Accepted-status whitelist — matches /balances and
// /api/integrations/period-totals exactly.
const ACCEPTED_STATUS: Record<string, string[]> = {
  'coinsbuy-deposits': ['Confirmed'],
  'coinsbuy-withdrawals': ['Approved'],
  fairpay: ['Completed'],
  unipayment: ['Completed'],
};

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
    pnl_range: number;
    pnl_month: number;
    pnl_prev_month: number;
    connected: boolean;
    isMock: boolean;
  };
  prop_trading: {
    products: Array<{ name: string; quantity: number; amount: number }>;
    total_sales_range: number;
    total_sales_month: number;
    prop_withdrawals_range: number;
    prop_withdrawals_count_range: number;
    pnl_range: number;
    pnl_month: number;
    pnl_prev_month: number;
    connected: boolean;
    isMock: boolean;
  };
  orion_totals: {
    propFirmSales: number;
    p2pTransfer: number;
    connected: boolean;
    isMock: boolean;
  };
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

function groupApiTx(rows: ApiTx[]) {
  const depositsByChannel = new Map<string, { count: number; amount: number }>();
  const withdrawals = { count: 0, amount: 0 };
  for (const r of rows) {
    const accepted = ACCEPTED_STATUS[r.provider];
    if (!accepted) continue;
    if (r.status && !accepted.includes(r.status)) continue;
    const amt = Number(r.amount) || 0;
    if (r.provider === 'coinsbuy-withdrawals') {
      withdrawals.count += 1;
      withdrawals.amount += amt;
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
    withdrawals,
  };
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
    crmTotals,
  ] = await Promise.allSettled([
    admin
      .from('deposits')
      .select('channel, amount, periods!inner(year, month)')
      .eq('company_id', companyId)
      .gte('periods.year', parseInt(from.slice(0, 4), 10))
      .lte('periods.year', parseInt(to.slice(0, 4), 10)),
    admin
      .from('withdrawals')
      .select('category, amount, periods!inner(year, month)')
      .eq('company_id', companyId)
      .gte('periods.year', parseInt(from.slice(0, 4), 10))
      .lte('periods.year', parseInt(to.slice(0, 4), 10)),
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
      .select('provider, amount, status, transaction_date')
      .eq('company_id', companyId)
      .gte('transaction_date', `${from}T00:00:00.000Z`)
      .lte('transaction_date', `${to}T23:59:59.999Z`),
    admin
      .from('api_transactions')
      .select('provider, amount, status, transaction_date')
      .eq('company_id', companyId)
      .gte('transaction_date', `${thisMonth.from}T00:00:00.000Z`)
      .lte('transaction_date', `${thisMonth.to}T23:59:59.999Z`),
    admin
      .from('api_transactions')
      .select('provider, amount, status, transaction_date')
      .eq('company_id', companyId)
      .gte('transaction_date', `${prevMonth.from}T00:00:00.000Z`)
      .lte('transaction_date', `${prevMonth.to}T23:59:59.999Z`),
    fetchOrionCrmUsers(companyId, from, to),
    fetchOrionCrmBrokerPnl(companyId, from, to),
    fetchOrionCrmPropTrading(companyId, from, to),
    fetchOrionCrmTotals(companyId, from, to),
  ]);

  const safeData = <T>(
    r: PromiseSettledResult<{ data: T[] | null; error: unknown } | unknown>,
  ): T[] => {
    if (r.status !== 'fulfilled') return [];
    const v = r.value as { data?: T[] | null } | null | undefined;
    return v?.data ?? [];
  };
  const unwrap = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === 'fulfilled' ? r.value : fallback;

  const failures: string[] = [];
  if (manualDepositsRange.status !== 'fulfilled') failures.push('deposits');
  if (manualWithdrawalsRange.status !== 'fulfilled') failures.push('withdrawals');
  if (apiTransactionsRange.status !== 'fulfilled') failures.push('api_transactions');
  if (crmUsers.status !== 'fulfilled') failures.push('orion_crm_users');
  if (crmBrokerPnl.status !== 'fulfilled') failures.push('orion_crm_broker_pnl');
  if (crmPropTrading.status !== 'fulfilled') failures.push('orion_crm_prop_trading');
  if (crmTotals.status !== 'fulfilled') failures.push('orion_crm_totals');

  const manualDepRange = groupRows(safeData<DepositRow>(manualDepositsRange), (r) => r.channel);
  const manualWdrRange = groupRows(safeData<WithdrawalRow>(manualWithdrawalsRange), (r) => r.category);
  const manualDepMonth = groupRows(safeData<DepositRow>(manualDepositsMonth), (r) => r.channel);
  const manualWdrMonth = groupRows(safeData<WithdrawalRow>(manualWithdrawalsMonth), (r) => r.category);
  const manualDepPrev = groupRows(safeData<DepositRow>(manualDepositsPrevMonth), (r) => r.channel);
  const manualWdrPrev = groupRows(safeData<WithdrawalRow>(manualWithdrawalsPrevMonth), (r) => r.category);

  const apiRange = groupApiTx(safeData<ApiTx>(apiTransactionsRange));
  const apiMonth = groupApiTx(safeData<ApiTx>(apiTransactionsMonth));
  const apiPrev = groupApiTx(safeData<ApiTx>(apiTransactionsPrevMonth));

  const depositsRange = mergeDeposits(manualDepRange, apiRange.depositsByChannel);
  const depositsMonth = mergeDeposits(manualDepMonth, apiMonth.depositsByChannel);
  const depositsPrev = mergeDeposits(manualDepPrev, apiPrev.depositsByChannel);

  const withdrawalsRange: ReportWithdrawalRow[] = [
    ...manualWdrRange.map((w) => ({ category: w.key, count: w.count, amount: w.amount })),
    ...(apiRange.withdrawals.amount > 0
      ? [{ category: 'coinsbuy_api', count: apiRange.withdrawals.count, amount: apiRange.withdrawals.amount }]
      : []),
  ];
  const withdrawalsMonth: ReportWithdrawalRow[] = [
    ...manualWdrMonth.map((w) => ({ category: w.key, count: w.count, amount: w.amount })),
    ...(apiMonth.withdrawals.amount > 0
      ? [{ category: 'coinsbuy_api', count: apiMonth.withdrawals.count, amount: apiMonth.withdrawals.amount }]
      : []),
  ];
  const withdrawalsPrev: ReportWithdrawalRow[] = [
    ...manualWdrPrev.map((w) => ({ category: w.key, count: w.count, amount: w.amount })),
    ...(apiPrev.withdrawals.amount > 0
      ? [{ category: 'coinsbuy_api', count: apiPrev.withdrawals.count, amount: apiPrev.withdrawals.amount }]
      : []),
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
    errorMessage: null,
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
    products: [],
    total_sales_range: 0,
    total_sales_month: 0,
    prop_withdrawals_range: 0,
    prop_withdrawals_count_range: 0,
    pnl_range: 0,
    pnl_month: 0,
    pnl_prev_month: 0,
    connected: false,
    isMock: false,
    errorMessage: null,
  });
  const orionTotalsResult = unwrap(crmTotals, {
    propFirmSales: 0,
    p2pTransfer: 0,
    connected: false,
    isMock: false,
    lastSync: null,
    errorMessage: null,
  });

  const anyMock =
    crmUsersResult.isMock ||
    brokerPnlResult.isMock ||
    propTradingResult.isMock ||
    orionTotalsResult.isMock;

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
    broker_pnl: {
      pnl_range: brokerPnlResult.pnl_range,
      pnl_month: brokerPnlResult.pnl_month,
      pnl_prev_month: brokerPnlResult.pnl_prev_month,
      connected: brokerPnlResult.connected,
      isMock: brokerPnlResult.isMock,
    },
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
    orion_totals: {
      propFirmSales: orionTotalsResult.propFirmSales,
      p2pTransfer: orionTotalsResult.p2pTransfer,
      connected: orionTotalsResult.connected,
      isMock: orionTotalsResult.isMock,
    },
    anyMock,
    failures,
  };
}
