import { createClient } from './client';
import type {
  Company,
  Period,
  Deposit,
  Withdrawal,
  PropFirmSale,
  P2PTransfer,
  Expense,
  PreoperativeExpense,
  OperatingIncome,
  BrokerBalance,
  FinancialStatus,
  Partner,
  PartnerDistribution,
  LiquidityMovement,
  Investment,
  Employee,
  CommercialProfile,
  CommercialMonthlyResult,
} from '../types';

const supabase = createClient();

// ─── Company ───

// `slug` is required — removed the default 'vexprofx' so we can't
// accidentally load the wrong tenant when a caller forgets the arg.
// fetchCompanyById is the preferred entry point; this one is kept for
// subdomain-based lookups if/when we re-enable per-tenant subdomains.
export async function fetchCompany(slug: string): Promise<Company | null> {
  const { data, error } = await supabase
    .from('companies')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error) {
    console.error('Error fetching company:', error.message);
    return null;
  }
  return data;
}

export async function fetchCompanyById(companyId: string): Promise<Company | null> {
  const { data, error } = await supabase
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .single();

  if (error) {
    console.error('Error fetching company by id:', error.message);
    return null;
  }
  return data;
}

// ─── Periods ───

export async function fetchPeriods(companyId: string): Promise<Period[]> {
  const { data, error } = await supabase
    .from('periods')
    .select('*')
    .eq('company_id', companyId)
    .order('year', { ascending: true })
    .order('month', { ascending: true });

  if (error) {
    console.error('Error fetching periods:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Deposits ───

export async function fetchDeposits(companyId: string, periodIds?: string[]): Promise<Deposit[]> {
  let query = supabase
    .from('deposits')
    .select('*')
    .eq('company_id', companyId);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching deposits:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Withdrawals ───

export async function fetchWithdrawals(companyId: string, periodIds?: string[]): Promise<Withdrawal[]> {
  let query = supabase
    .from('withdrawals')
    .select('*')
    .eq('company_id', companyId);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching withdrawals:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Expenses ───

export async function fetchExpenses(companyId: string, periodIds?: string[]): Promise<Expense[]> {
  let query = supabase
    .from('expenses')
    .select('*')
    .eq('company_id', companyId)
    .order('sort_order', { ascending: true });

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching expenses:', error.message);
    return [];
  }
  // Defensive default: ensure is_fixed is always boolean even if column missing in older rows
  return (data ?? []).map((e) => ({ ...e, is_fixed: !!e.is_fixed }));
}

// ─── Expense Templates (Egresos Fijos plantillas) ───

export async function fetchExpenseTemplates(companyId: string): Promise<import('../types').ExpenseTemplate[]> {
  const { data, error } = await supabase
    .from('expense_templates')
    .select('*')
    .eq('company_id', companyId)
    .order('sort_order', { ascending: true });

  if (error) {
    console.error('Error fetching expense templates:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Channel Balances (snapshots por dia) ───
//
// Resolution rules (matched in /balances UI):
//   · With `date`: return one row per channel_key — the latest snapshot
//     where snapshot_date <= date. So a manual entry on D persists through
//     D+1, D+2 … until a newer row exists. Backed by the SQL function
//     `channel_balances_as_of` (migration 026).
//   · Without `date`: return ALL historical rows (used by audit / reports).

export async function fetchChannelBalances(
  companyId: string,
  date?: string
): Promise<import('../types').ChannelBalance[]> {
  if (date) {
    const { data, error } = await supabase.rpc('channel_balances_as_of', {
      p_company_id: companyId,
      p_date: date,
    });
    if (error) {
      console.error('Error fetching channel balances (as_of):', error.message);
      return [];
    }
    return (data ?? []) as import('../types').ChannelBalance[];
  }

  const { data, error } = await supabase
    .from('channel_balances')
    .select('*')
    .eq('company_id', companyId)
    .order('snapshot_date', { ascending: false });

  if (error) {
    console.error('Error fetching channel balances:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Pinned Coinsbuy Wallets ───

export async function fetchPinnedCoinsbuyWallets(
  companyId: string
): Promise<import('../types').PinnedCoinsbuyWallet[]> {
  const { data, error } = await supabase
    .from('pinned_coinsbuy_wallets')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching pinned wallets:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Preoperative Expenses ───

export async function fetchPreoperativeExpenses(companyId: string): Promise<PreoperativeExpense[]> {
  const { data, error } = await supabase
    .from('preoperative_expenses')
    .select('*')
    .eq('company_id', companyId)
    .order('sort_order', { ascending: true });

  if (error) {
    console.error('Error fetching preoperative expenses:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Operating Income ───

export async function fetchOperatingIncome(companyId: string, periodIds?: string[]): Promise<OperatingIncome[]> {
  let query = supabase
    .from('operating_income')
    .select('*')
    .eq('company_id', companyId);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching operating income:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Broker Balance ───

export async function fetchBrokerBalance(companyId: string, periodIds?: string[]): Promise<BrokerBalance[]> {
  let query = supabase
    .from('broker_balance')
    .select('*')
    .eq('company_id', companyId);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching broker balance:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Financial Status ───

export async function fetchFinancialStatus(companyId: string, periodIds?: string[]): Promise<FinancialStatus[]> {
  let query = supabase
    .from('financial_status')
    .select('*')
    .eq('company_id', companyId);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching financial status:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Partners ───

export async function fetchPartners(companyId: string): Promise<Partner[]> {
  const { data, error } = await supabase
    .from('partners')
    .select('*')
    .eq('company_id', companyId);

  if (error) {
    console.error('Error fetching partners:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Partner Distributions ───

export async function fetchPartnerDistributions(companyId: string, periodIds?: string[]): Promise<PartnerDistribution[]> {
  let query = supabase
    .from('partner_distributions')
    .select('*')
    .eq('company_id', companyId);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching partner distributions:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Prop Firm Sales ───

export async function fetchPropFirmSales(companyId: string, periodIds?: string[]): Promise<PropFirmSale[]> {
  let query = supabase
    .from('prop_firm_sales')
    .select('*')
    .eq('company_id', companyId);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching prop firm sales:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── P2P Transfers ───

export async function fetchP2PTransfers(companyId: string, periodIds?: string[]): Promise<P2PTransfer[]> {
  let query = supabase
    .from('p2p_transfers')
    .select('*')
    .eq('company_id', companyId);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching P2P transfers:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Liquidity Movements ───

export async function fetchLiquidityMovements(companyId: string): Promise<LiquidityMovement[]> {
  const { data, error } = await supabase
    .from('liquidity_movements')
    .select('*')
    .eq('company_id', companyId)
    .order('date', { ascending: true });

  if (error) {
    console.error('Error fetching liquidity movements:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── Investments ───

export async function fetchInvestments(companyId: string): Promise<Investment[]> {
  const { data, error } = await supabase
    .from('investments')
    .select('*')
    .eq('company_id', companyId)
    .order('date', { ascending: true });

  if (error) {
    console.error('Error fetching investments:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── HR: Employees ───

export async function fetchEmployees(companyId: string): Promise<Employee[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('company_id', companyId)
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching employees:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── HR: Commercial Profiles ───

export async function fetchCommercialProfiles(companyId: string): Promise<CommercialProfile[]> {
  const { data, error } = await supabase
    .from('commercial_profiles')
    .select('*')
    .eq('company_id', companyId)
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching commercial profiles:', error.message);
    return [];
  }
  return data ?? [];
}

// ─── HR: Commercial Monthly Results ───

export async function fetchCommercialMonthlyResults(
  companyId: string,
  periodIds?: string[]
): Promise<CommercialMonthlyResult[]> {
  // Commercial monthly results reference profile_id rather than company_id directly,
  // so we first fetch the profile IDs for the company, then query results.
  const profiles = await fetchCommercialProfiles(companyId);
  if (profiles.length === 0) return [];

  const profileIds = profiles.map((p) => p.id);

  let query = supabase
    .from('commercial_monthly_results')
    .select('*')
    .in('profile_id', profileIds);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching commercial monthly results:', error.message);
    return [];
  }
  return data ?? [];
}
