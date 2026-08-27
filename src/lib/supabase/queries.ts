import { createClient } from './client';
import { normalizePinnedWalletRole } from '../pinned-wallet-roles';
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

// ─────────────────────────────────────────────────────────────────────────────
// ABORTO REAL DE LAS CONSULTAS DEL ARRANQUE (2026-08-28)
//
// Hasta hoy no había NI UN AbortController en este archivo. El timeout del
// DataProvider era un `Promise.race` contra un `setTimeout`: cuando vencía,
// la promesa perdedora seguía viva, el fetch seguía abierto y el reintento
// salía sobre la MISMA conexión muerta. Medido: el usuario esperaba 31,5s
// (15s + 1,5s + 15s) para ver "La carga tardó demasiado".
//
// Cada fetch acepta ahora un `signal`. supabase-js lo pasa al fetch subyacente
// vía `.abortSignal()`, así que al vencer el timeout la conexión se cierra de
// verdad y el intento siguiente arranca con una señal NUEVA.
//
// Y un aborto NO es "no hay datos": `rethrowIfAborted` lo propaga como error
// en vez de devolver `[]`. Un `[]` mudo por timeout es exactamente el fallo
// que no da error del que habla docs/reglas-del-proyecto.md §1.2 — se vería
// igual que una empresa sin depósitos.
// ─────────────────────────────────────────────────────────────────────────────

/** Opciones comunes de las consultas de lectura. */
export interface QueryOpts {
  /** Señal de aborto del intento en curso. Al vencer, la consulta se cancela. */
  signal?: AbortSignal;
}

/**
 * Encadena `.abortSignal()` sólo cuando hay señal — sin señal, todo se comporta
 * exactamente igual que antes. Devuelve el MISMO tipo que recibe para que el
 * `await` siga infiriendo `{ data, error }` con las filas tipadas.
 */
function withSignal<T extends PromiseLike<unknown>>(query: T, opts?: QueryOpts): T {
  if (!opts?.signal) return query;
  const chainable = query as T & { abortSignal?: (signal: AbortSignal) => T };
  return typeof chainable.abortSignal === 'function' ? chainable.abortSignal(opts.signal) : query;
}

/**
 * Un aborto tiene que SUBIR. Si lo tragáramos devolviendo `[]`, el timeout de
 * carga sería indistinguible de "esta empresa no tiene filas".
 */
function rethrowIfAborted(opts: QueryOpts | undefined, error: { message?: string } | null): never | void {
  if (opts?.signal?.aborted) {
    throw new Error('La consulta se canceló por timeout de carga');
  }
  // `AbortError` también puede llegar por el mensaje del propio fetch.
  if (error?.message && /abort/i.test(error.message)) {
    throw new Error('La consulta se canceló por timeout de carga');
  }
}

const supabase = createClient();

// ─── Company ───

// `slug` is required — removed the default 'vexprofx' so we can't
// accidentally load the wrong tenant when a caller forgets the arg.
// fetchCompanyById is the preferred entry point; this one is kept for
// subdomain-based lookups if/when we re-enable per-tenant subdomains.
export async function fetchCompany(slug: string, opts?: QueryOpts): Promise<Company | null> {
  const { data, error } = await withSignal(supabase
    .from('companies')
    .select('*')
    .eq('slug', slug)
    .single(), opts);

  if (error) {
    console.error('Error fetching company:', error.message);
    rethrowIfAborted(opts, error);
    return null;
  }
  return data;
}

export async function fetchCompanyById(companyId: string, opts?: QueryOpts): Promise<Company | null> {
  const { data, error } = await withSignal(supabase
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .single(), opts);

  if (error) {
    console.error('Error fetching company by id:', error.message);
    rethrowIfAborted(opts, error);
    return null;
  }
  return data;
}

// ─── Periods ───

export async function fetchPeriods(companyId: string, opts?: QueryOpts): Promise<Period[]> {
  const { data, error } = await withSignal(supabase
    .from('periods')
    .select('*')
    .eq('company_id', companyId)
    .order('year', { ascending: true })
    .order('month', { ascending: true }), opts);

  if (error) {
    console.error('Error fetching periods:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Deposits ───

export async function fetchDeposits(companyId: string, periodIds?: string[], opts?: QueryOpts): Promise<Deposit[]> {
  let query = supabase
    .from('deposits')
    .select('*')
    .eq('company_id', companyId)
    // PERF-02: cota defensiva. El volumen real es minúsculo (cientos de filas
    // en toda la historia), pero evita un fetch sin límite ante un futuro
    // patológico. NO es paginación — es un techo de seguridad.
    .limit(10_000);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await withSignal(query, opts);

  if (error) {
    console.error('Error fetching deposits:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Withdrawals ───

export async function fetchWithdrawals(companyId: string, periodIds?: string[], opts?: QueryOpts): Promise<Withdrawal[]> {
  let query = supabase
    .from('withdrawals')
    .select('*')
    .eq('company_id', companyId)
    // PERF-02: cota defensiva. El volumen real es minúsculo (cientos de filas
    // en toda la historia), pero evita un fetch sin límite ante un futuro
    // patológico. NO es paginación — es un techo de seguridad.
    .limit(10_000);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await withSignal(query, opts);

  if (error) {
    console.error('Error fetching withdrawals:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Expenses ───

export async function fetchExpenses(companyId: string, periodIds?: string[], opts?: QueryOpts): Promise<Expense[]> {
  let query = supabase
    .from('expenses')
    .select('*')
    .eq('company_id', companyId)
    .order('sort_order', { ascending: true })
    .limit(10_000); // PERF-02: cota defensiva (ver comentario en fetchDeposits)

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await withSignal(query, opts);

  if (error) {
    console.error('Error fetching expenses:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  // Defensive default: ensure is_fixed is always boolean even if column missing in older rows
  return (data ?? []).map((e) => ({ ...e, is_fixed: !!e.is_fixed }));
}

// ─── Expense Templates (Egresos Fijos plantillas) ───

export async function fetchExpenseTemplates(companyId: string, opts?: QueryOpts): Promise<import('../types').ExpenseTemplate[]> {
  const { data, error } = await withSignal(supabase
    .from('expense_templates')
    .select('*')
    .eq('company_id', companyId)
    .order('sort_order', { ascending: true }), opts);

  if (error) {
    console.error('Error fetching expense templates:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// Ocultamientos por período de plantillas fijas (migration-050). Cada fila
// = una plantilla oculta en un período específico.
export async function fetchExpenseTemplateHidden(
  companyId: string,
  opts?: QueryOpts,
): Promise<import('../types').ExpenseTemplateHidden[]> {
  const { data, error } = await withSignal(supabase
    .from('expense_template_period_hidden')
    .select('id, company_id, template_id, period_id')
    .eq('company_id', companyId), opts);

  if (error) {
    console.error('Error fetching expense template hidden overrides:', error.message);
    rethrowIfAborted(opts, error);
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
  date?: string,
  opts?: QueryOpts,
): Promise<import('../types').ChannelBalance[]> {
  if (date) {
    const { data, error } = await withSignal(
      supabase.rpc('channel_balances_as_of', { p_company_id: companyId, p_date: date }),
      opts,
    );
    if (error) {
      console.error('Error fetching channel balances (as_of):', error.message);
      rethrowIfAborted(opts, error);
      return [];
    }
    return (data ?? []) as import('../types').ChannelBalance[];
  }

  const { data, error } = await withSignal(supabase
    .from('channel_balances')
    .select('*')
    .eq('company_id', companyId)
    .order('snapshot_date', { ascending: false }), opts);

  if (error) {
    console.error('Error fetching channel balances:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Pinned Coinsbuy Wallets ───

export async function fetchPinnedCoinsbuyWallets(
  companyId: string,
  opts?: QueryOpts,
): Promise<import('../types').PinnedCoinsbuyWallet[]> {
  const { data, error } = await withSignal(supabase
    .from('pinned_coinsbuy_wallets')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: true }), opts);

  if (error) {
    console.error('Error fetching pinned wallets:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  // `role` normalizado acá para que la UI nunca tenga que adivinar: las filas
  // escritas antes de la migración 084 no traen la columna y su rol histórico
  // es 'operating' (eran las que ya contaban para los totales).
  return (data ?? []).map((row) => ({
    ...row,
    role: normalizePinnedWalletRole((row as { role?: unknown }).role),
  })) as import('../types').PinnedCoinsbuyWallet[];
}

// ─── Preoperative Expenses ───

export async function fetchPreoperativeExpenses(companyId: string, opts?: QueryOpts): Promise<PreoperativeExpense[]> {
  const { data, error } = await withSignal(supabase
    .from('preoperative_expenses')
    .select('*')
    .eq('company_id', companyId)
    .order('sort_order', { ascending: true }), opts);

  if (error) {
    console.error('Error fetching preoperative expenses:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Operating Income ───

export async function fetchOperatingIncome(companyId: string, periodIds?: string[], opts?: QueryOpts): Promise<OperatingIncome[]> {
  let query = supabase
    .from('operating_income')
    .select('*')
    .eq('company_id', companyId)
    // PERF-02: cota defensiva. El volumen real es minúsculo (cientos de filas
    // en toda la historia), pero evita un fetch sin límite ante un futuro
    // patológico. NO es paginación — es un techo de seguridad.
    .limit(10_000);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await withSignal(query, opts);

  if (error) {
    console.error('Error fetching operating income:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Broker Balance ───

export async function fetchBrokerBalance(companyId: string, periodIds?: string[], opts?: QueryOpts): Promise<BrokerBalance[]> {
  let query = supabase
    .from('broker_balance')
    .select('*')
    .eq('company_id', companyId)
    // PERF-02: cota defensiva. El volumen real es minúsculo (cientos de filas
    // en toda la historia), pero evita un fetch sin límite ante un futuro
    // patológico. NO es paginación — es un techo de seguridad.
    .limit(10_000);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await withSignal(query, opts);

  if (error) {
    console.error('Error fetching broker balance:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Financial Status ───

export async function fetchFinancialStatus(companyId: string, periodIds?: string[], opts?: QueryOpts): Promise<FinancialStatus[]> {
  let query = supabase
    .from('financial_status')
    .select('*')
    .eq('company_id', companyId)
    // PERF-02: cota defensiva. El volumen real es minúsculo (cientos de filas
    // en toda la historia), pero evita un fetch sin límite ante un futuro
    // patológico. NO es paginación — es un techo de seguridad.
    .limit(10_000);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await withSignal(query, opts);

  if (error) {
    console.error('Error fetching financial status:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Partners ───

export async function fetchPartners(companyId: string, opts?: QueryOpts): Promise<Partner[]> {
  const { data, error } = await withSignal(supabase
    .from('partners')
    .select('*')
    .eq('company_id', companyId), opts);

  if (error) {
    console.error('Error fetching partners:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Partner Distributions ───

export async function fetchPartnerDistributions(companyId: string, periodIds?: string[], opts?: QueryOpts): Promise<PartnerDistribution[]> {
  let query = supabase
    .from('partner_distributions')
    .select('*')
    .eq('company_id', companyId)
    // PERF-02: cota defensiva. El volumen real es minúsculo (cientos de filas
    // en toda la historia), pero evita un fetch sin límite ante un futuro
    // patológico. NO es paginación — es un techo de seguridad.
    .limit(10_000);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await withSignal(query, opts);

  if (error) {
    console.error('Error fetching partner distributions:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Prop Firm Sales ───

export async function fetchPropFirmSales(companyId: string, periodIds?: string[], opts?: QueryOpts): Promise<PropFirmSale[]> {
  let query = supabase
    .from('prop_firm_sales')
    .select('*')
    .eq('company_id', companyId)
    // PERF-02: cota defensiva. El volumen real es minúsculo (cientos de filas
    // en toda la historia), pero evita un fetch sin límite ante un futuro
    // patológico. NO es paginación — es un techo de seguridad.
    .limit(10_000);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await withSignal(query, opts);

  if (error) {
    console.error('Error fetching prop firm sales:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── P2P Transfers ───

export async function fetchP2PTransfers(companyId: string, periodIds?: string[], opts?: QueryOpts): Promise<P2PTransfer[]> {
  let query = supabase
    .from('p2p_transfers')
    .select('*')
    .eq('company_id', companyId)
    // PERF-02: cota defensiva. El volumen real es minúsculo (cientos de filas
    // en toda la historia), pero evita un fetch sin límite ante un futuro
    // patológico. NO es paginación — es un techo de seguridad.
    .limit(10_000);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await withSignal(query, opts);

  if (error) {
    console.error('Error fetching P2P transfers:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Liquidity Movements ───

export async function fetchLiquidityMovements(companyId: string, opts?: QueryOpts): Promise<LiquidityMovement[]> {
  // PERF-02: cota defensiva (ver comentario en fetchDeposits)
  const { data, error } = await withSignal(
    supabase
      .from('liquidity_movements')
      .select('*')
      .eq('company_id', companyId)
      .order('date', { ascending: true })
      .limit(10_000),
    opts,
  );

  if (error) {
    console.error('Error fetching liquidity movements:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── Investments ───

export async function fetchInvestments(companyId: string, opts?: QueryOpts): Promise<Investment[]> {
  // PERF-02: cota defensiva (ver comentario en fetchDeposits)
  const { data, error } = await withSignal(
    supabase
      .from('investments')
      .select('*')
      .eq('company_id', companyId)
      .order('date', { ascending: true })
      .limit(10_000),
    opts,
  );

  if (error) {
    console.error('Error fetching investments:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── HR: Employees ───

export async function fetchEmployees(companyId: string, opts?: QueryOpts): Promise<Employee[]> {
  const { data, error } = await withSignal(supabase
    .from('employees')
    .select('*')
    .eq('company_id', companyId)
    .order('name', { ascending: true }), opts);

  if (error) {
    console.error('Error fetching employees:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── HR: Commercial Profiles ───

export async function fetchCommercialProfiles(companyId: string, opts?: QueryOpts): Promise<CommercialProfile[]> {
  const { data, error } = await withSignal(supabase
    .from('commercial_profiles')
    .select('*')
    .eq('company_id', companyId)
    .order('name', { ascending: true }), opts);

  if (error) {
    console.error('Error fetching commercial profiles:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}

// ─── HR: Commercial Monthly Results ───

export async function fetchCommercialMonthlyResults(
  companyId: string,
  periodIds?: string[],
  opts?: QueryOpts,
): Promise<CommercialMonthlyResult[]> {
  // Filter by `company_id` directly (column added by migration 006). The old
  // implementation fetched all commercial_profiles first, extracted IDs, then
  // queried with `IN [...]` — that ran in parallel with the same
  // `fetchCommercialProfiles` call from data-context's loadAllData(), causing
  // a redundant double-fetch on every cold load AND on every silent refresh
  // after a save. With 49 profiles + 262 monthly_results rows that's not
  // huge today but it scales linearly and was a measurable contributor to
  // the "Cargando..." hang Kevin reported on 2026-05-01.
  //
  // Defensive .limit(10000) — typical month has <100 rows, so 10K covers
  // ~8 years of growth before we'd need pagination.
  let query = supabase
    .from('commercial_monthly_results')
    .select('*')
    .eq('company_id', companyId)
    .limit(10000);

  if (periodIds) {
    query = query.in('period_id', periodIds);
  }

  const { data, error } = await withSignal(query, opts);

  if (error) {
    console.error('Error fetching commercial monthly results:', error.message);
    rethrowIfAborted(opts, error);
    return [];
  }
  return data ?? [];
}
