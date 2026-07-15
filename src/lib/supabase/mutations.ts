import { withActiveCompany, apiFetch } from '@/lib/api-fetch';

// Todas las ESCRITURAS de datos van server-side vía /api/admin/data (dispatcher)
// para evitar el cuelgue recurrente del auth-refresh del cliente supabase-js del
// browser. postData hace un fetch simple con la cookie de sesión y devuelve el
// JSON del server ({ success, id? } o { error }). Ver src/app/api/admin/data.
async function postData<T = { success: boolean; id?: string }>(
  op: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const res = await apiFetch('/api/admin/data', {
    method: 'POST',
    body: JSON.stringify({ op, ...payload }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `Error guardando (${op}) — ${res.status}`);
  }
  return data as T;
}

// ─── Period Status ───

export async function updatePeriodStatus(periodId: string, isClosed: boolean): Promise<void> {
  await postData('period_status', { periodId, isClosed });
}

// ─── Period Reserve Percentage ───

export async function updatePeriodReservePct(periodId: string, reservePct: number): Promise<void> {
  await postData('period_reserve', { periodId, reservePct });
}

export async function updateAllPeriodsReservePct(_companyId: string, reservePct: number): Promise<void> {
  await postData('period_reserve_all', { reservePct });
}

// ─── Partners CRUD ───

export async function createPartner(
  _companyId: string,
  name: string,
  email: string | null,
  percentage: number
): Promise<string> {
  const { id } = await postData('partner_create', { name, email, percentage });
  return id!;
}

export async function updatePartner(
  id: string,
  updates: { name: string; email: string | null; percentage: number }
): Promise<void> {
  await postData('partner_update', { id, updates });
}

export async function deletePartner(id: string): Promise<void> {
  await postData('partner_delete', { id });
}

// ─── Deposits (delete + reinsert for the period) ───

// ATÓMICO vía RPC (migración 044). Antes era DELETE + INSERT en dos llamadas
// HTTP: un fallo/timeout entre ambas dejaba el período sin depósitos (misma
// clase de bug que vació los egresos de VexPro May 2026). El filtro de
// montos = 0 vive en la función SQL.
export async function upsertDeposits(
  _companyId: string,
  periodId: string,
  deposits: { channel: string; amount: number }[]
): Promise<void> {
  await postData('deposits', { periodId, rows: deposits.map(d => ({ channel: d.channel, amount: d.amount })) });
}

// ─── Withdrawals (reemplazo atómico del período vía RPC, migración 044) ───

export async function upsertWithdrawals(
  _companyId: string,
  periodId: string,
  withdrawals: { category: string; amount: number; description?: string | null }[]
): Promise<void> {
  await postData('withdrawals', {
    periodId,
    rows: withdrawals.map(w => ({ category: w.category, amount: w.amount, description: w.description ?? null })),
  });
}

// ─── Expenses (delete + reinsert for the period) ───
//
// Bug fixed 2026-04-22: the previous implementation ran a sequential N+1
// loop over every `is_fixed` expense to sync `expense_templates` (one
// SELECT + one UPDATE/INSERT per row). With 17 fixed expenses that was
// 34 round-trips AFTER the main save, all inside the caller's await. Any
// slow request or transient RLS hiccup left the button spinning forever
// because none of those queries were wrapped in try/catch and they
// blocked the function from returning.
//
// New behaviour:
//   1. DELETE + bulk INSERT of the period's expenses (unchanged contract).
//   2. Template sync uses a single `.upsert(..., { onConflict })` call —
//      one round-trip total — and runs fire-and-forget. Failures here
//      log but don't break the main save.
//   3. A hard 20s timeout on the main save so a stuck network never
//      locks the UI button in a "Guardando..." state.

export async function upsertExpenses(
  _companyId: string,
  periodId: string,
  expenses: { concept: string; amount: number; paid: number; pending: number; is_fixed?: boolean; category?: string | null }[]
): Promise<void> {
  // Guardado SERVER-SIDE vía /api/admin/expenses (2026-07-13). Antes esto
  // llamaba supabase.rpc() desde el browser y se colgaba >12s de forma
  // recurrente: el cliente supabase-js intenta refrescar el token de auth
  // antes de cada request y ese refresh se estancaba (navigator.locks/red),
  // aunque la DB responde en ~9ms. Ahora el browser hace un fetch simple con
  // su cookie de sesión; el server valida auth (company_id del JWT) y corre la
  // RPC atómica replace_period_expenses + el sync de plantillas. Elimina la
  // clase de cuelgues del auth-lock del cliente. company_id se resuelve
  // server-side desde el token — el param del cliente se ignora.
  const rows = expenses.map((e) => ({
    concept: e.concept,
    amount: e.amount,
    paid: e.paid,
    pending: e.pending,
    is_fixed: !!e.is_fixed,
    category: e.category ?? null,
  }));

  const res = await apiFetch('/api/admin/expenses', {
    method: 'POST',
    body: JSON.stringify({ periodId, rows }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `Error guardando egresos (${res.status})`);
  }
}

// ─── Expense ordering (drag-and-drop in /upload) ───
//
// Updates ONLY the `sort_order` column for a list of expense ids. The
// caller passes ids in the new display order; this helper assigns 1..N.
//
// Runs as N parallel UPDATEs (one per row) rather than a delete+reinsert
// because reorder happens on every drop — we want it cheap and we
// explicitly don't want to touch amount/paid/pending fields. At the
// scale we care about (~30 rows) parallel UPDATE takes ~300ms end-to-end.
// ---------------------------------------------------------------------------

export async function updateExpenseOrder(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await postData('expense_order', { ids });
}

// ─── Expense Templates (CRUD) ───

export async function deactivateExpenseTemplate(id: string): Promise<void> {
  await postData('expense_template_set_active', { id, active: false });
}

export async function activateExpenseTemplate(id: string): Promise<void> {
  await postData('expense_template_set_active', { id, active: true });
}

export async function deleteExpenseTemplate(id: string): Promise<void> {
  await postData('expense_template_delete', { id });
}

// Ocultar/mostrar una plantilla fija en UN período (migration-050).
export async function hideExpenseTemplateForPeriod(templateId: string, periodId: string): Promise<void> {
  await postData('expense_template_hide', { templateId, periodId });
}

export async function unhideExpenseTemplateForPeriod(templateId: string, periodId: string): Promise<void> {
  await postData('expense_template_unhide', { templateId, periodId });
}

// ─── Channel Balances (snapshots por dia) ───

// Upsert nativo en UNA llamada (ON CONFLICT sobre el UNIQUE existente).
// Antes: SELECT + (UPDATE|INSERT) en dos llamadas — no atómico.
export async function upsertChannelBalance(
  companyId: string,
  snapshotDate: string,
  channelKey: string,
  amount: number,
  source: 'manual' | 'api' | 'derived' = 'manual'
): Promise<void> {
  await postData('channel_balance', { snapshotDate, channelKey, amount, source });
}

// ─── Pinned Coinsbuy Wallets ───

export async function pinCoinsbuyWallet(
  companyId: string,
  walletId: string,
  walletLabel: string
): Promise<void> {
  await postData('pin_wallet', { walletId, walletLabel });
}

export async function unpinCoinsbuyWallet(
  companyId: string,
  walletId: string
): Promise<void> {
  await postData('unpin_wallet', { walletId });
}

// ─── Operating Income (upsert single row per period) ───

// Upsert nativo en UNA llamada (ON CONFLICT sobre UNIQUE company_id+period_id).
// Antes: SELECT + (UPDATE|INSERT) en dos llamadas — no atómico.
export async function upsertOperatingIncome(
  companyId: string,
  periodId: string,
  income: { prop_firm: number; broker_pnl: number; other: number }
): Promise<void> {
  await postData('operating_income', { periodId, income });
}

// ─── Liquidity Movements ───

export async function insertLiquidityMovement(
  companyId: string,
  movement: { date: string; user_email: string | null; mt_account: string | null; deposit: number; withdrawal: number; balance: number }
): Promise<string> {
  // id generado en el cliente → INSERT idempotente y reintentable (ver
  // insertInvestment / resilientWrite). Un reintento con el mismo id choca
  // con la PK (23505) y se trata como éxito: sin duplicados, sin cuelgue 25s.
  const { id } = await postData('liquidity_insert', { movement });
  return id!;
}

export async function updateLiquidityMovement(
  id: string,
  updates: { date: string; user_email: string | null; mt_account: string | null; deposit: number; withdrawal: number; balance: number }
): Promise<void> {
  await postData('liquidity_update', { id, updates });
}

export async function deleteLiquidityMovement(id: string): Promise<void> {
  await postData('liquidity_delete', { id });
}

// ─── Investments ───

export async function insertInvestment(
  companyId: string,
  investment: { date: string; concept: string | null; responsible: string | null; deposit: number; withdrawal: number; profit: number; balance: number }
): Promise<string> {
  // id generado en el cliente para volver el INSERT idempotente y por lo tanto
  // reintentable (ver resilientWrite): si un intento se estanca en la red y se
  // reintenta, el segundo insert con el MISMO id choca con la PK (código 23505)
  // y lo tratamos como éxito → nunca se duplica la fila y ya no cuelga 25s.
  const { id } = await postData('investment_insert', { investment });
  return id!;
}

export async function updateInvestment(
  id: string,
  updates: { date: string; concept: string | null; responsible: string | null; deposit: number; withdrawal: number; profit: number; balance: number }
): Promise<void> {
  await postData('investment_update', { id, updates });
}

export async function deleteInvestment(id: string): Promise<void> {
  await postData('investment_delete', { id });
}

// ─── Prop Firm Sales (upsert single row per period) ───

// Upsert nativo en UNA llamada (UNIQUE company_id+period_id — migración 044).
export async function upsertPropFirmSales(
  companyId: string,
  periodId: string,
  amount: number
): Promise<void> {
  await postData('prop_firm_sales', { periodId, amount });
}

// ─── P2P Transfers (upsert single row per period) ───

// Upsert nativo en UNA llamada (UNIQUE company_id+period_id — migración 044).
export async function upsertP2PTransfers(
  companyId: string,
  periodId: string,
  amount: number
): Promise<void> {
  await postData('p2p_transfers', { periodId, amount });
}

// ─── Commission Entries ───

export interface CommissionEntryRow {
  profile_id: string;
  head_id?: string;
  net_deposit_current: number | null;
  net_deposit_accumulated: number | null;
  division: number;
  base_amount: number;
  commissions_earned: number;
  real_payment: number;
  accumulated_out: number;
  salary_paid: number;
  total_earned: number;
  bonus?: number;
  pnl_current?: number;
}

export async function upsertCommissionEntries(
  companyId: string,
  periodId: string,
  headId: string,
  entries: CommissionEntryRow[],
): Promise<void> {
  const res = await fetch(withActiveCompany('/api/admin/commission-entries'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company_id: companyId,
      period_id: periodId,
      head_id: headId,
      entries,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Error guardando comisiones');
}

// ─── Commercial Profiles CRUD ───

export interface CommercialProfileInput {
  name: string;
  email: string;
  role: string;
  head_id: string | null;
  net_deposit_pct: number | null;
  pnl_pct: number | null;
  commission_per_lot: number | null;
  salary: number | null;
  extra_pct: number | null;
  benefits: string | null;
  comments: string | null;
  hire_date: string | null;
  birthday: string | null;
  status: string;
  termination_date: string | null;
  termination_reason: string | null;
  termination_category: string | null;
  terminated_by: string | null;
  pnl_special_mode?: boolean;
}

// ─── Commercial Profiles via API route (bypasses RLS with service role) ───

async function profileApi(body: Record<string, unknown>) {
  const res = await fetch(withActiveCompany('/api/admin/commercial-profiles'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Error en operación');
  return data;
}

export async function createCommercialProfile(
  companyId: string,
  profile: Omit<CommercialProfileInput, 'status'>,
): Promise<string> {
  const data = await profileApi({ action: 'create', company_id: companyId, ...profile });
  return data.id || '';
}

export async function updateCommercialProfile(
  id: string,
  updates: Partial<CommercialProfileInput>,
): Promise<void> {
  await profileApi({ action: 'update', id, ...updates });
}

export async function deleteCommercialProfile(id: string): Promise<void> {
  await profileApi({ action: 'delete', id });
}

export async function deleteEmployee(id: string): Promise<void> {
  const res = await fetch(withActiveCompany('/api/admin/employees'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Request failed: ${res.status}`);
}

// ─── Employees create / update ───
// Antes el form del tab Empleados en /rrhh sólo tocaba state local. Estos
// helpers hacen el round-trip a BD vía /api/admin/employees (admin client,
// bypassea RLS para superadmin viewing-as).

import type { Employee } from '@/lib/types';

type EmployeeWritable = Omit<Employee, 'id' | 'company_id'>;

export async function createEmployee(employee: EmployeeWritable): Promise<Employee> {
  const res = await fetch(withActiveCompany('/api/admin/employees'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', employee }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Request failed: ${res.status}`);
  return data.employee as Employee;
}

export async function updateEmployee(id: string, employee: Partial<EmployeeWritable>): Promise<Employee> {
  const res = await fetch(withActiveCompany('/api/admin/employees'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update', id, employee }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Request failed: ${res.status}`);
  return data.employee as Employee;
}
