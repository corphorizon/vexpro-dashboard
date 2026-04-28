import { createClient } from './client';
import { withActiveCompany } from '@/lib/api-fetch';

const supabase = createClient();

// ─── Period Status ───

export async function updatePeriodStatus(
  periodId: string,
  isClosed: boolean
): Promise<void> {
  const { error } = await supabase
    .from('periods')
    .update({ is_closed: isClosed })
    .eq('id', periodId);

  if (error) throw new Error(`Error actualizando estado del período: ${error.message}`);
}

// ─── Period Reserve Percentage ───

export async function updatePeriodReservePct(
  periodId: string,
  reservePct: number
): Promise<void> {
  const { error } = await supabase
    .from('periods')
    .update({ reserve_pct: reservePct })
    .eq('id', periodId);

  if (error) throw new Error(`Error actualizando respaldo del período: ${error.message}`);
}

export async function updateAllPeriodsReservePct(
  companyId: string,
  reservePct: number
): Promise<void> {
  const { error } = await supabase
    .from('periods')
    .update({ reserve_pct: reservePct })
    .eq('company_id', companyId);

  if (error) throw new Error(`Error actualizando respaldo de todos los períodos: ${error.message}`);
}

// ─── Partners CRUD ───

export async function createPartner(
  companyId: string,
  name: string,
  email: string | null,
  percentage: number
): Promise<string> {
  const { data, error } = await supabase
    .from('partners')
    .insert({ company_id: companyId, name, email, percentage })
    .select('id')
    .single();

  if (error) throw new Error(`Error creando socio: ${error.message}`);
  return data.id;
}

export async function updatePartner(
  id: string,
  updates: { name: string; email: string | null; percentage: number }
): Promise<void> {
  const { error } = await supabase
    .from('partners')
    .update(updates)
    .eq('id', id);

  if (error) throw new Error(`Error actualizando socio: ${error.message}`);
}

export async function deletePartner(id: string): Promise<void> {
  // Delete related distributions first
  const { error: distError } = await supabase
    .from('partner_distributions')
    .delete()
    .eq('partner_id', id);

  if (distError) throw new Error(`Error eliminando distribuciones del socio: ${distError.message}`);

  const { error } = await supabase
    .from('partners')
    .delete()
    .eq('id', id);

  if (error) throw new Error(`Error eliminando socio: ${error.message}`);
}

// ─── Deposits (delete + reinsert for the period) ───

export async function upsertDeposits(
  companyId: string,
  periodId: string,
  deposits: { channel: string; amount: number }[]
): Promise<void> {
  // Delete existing deposits for this period
  const { error: delError } = await supabase
    .from('deposits')
    .delete()
    .eq('company_id', companyId)
    .eq('period_id', periodId);

  if (delError) throw new Error(`Error borrando depósitos: ${delError.message}`);

  // Insert new rows (skip zero amounts)
  const rows = deposits
    .filter(d => d.amount > 0)
    .map(d => ({
      company_id: companyId,
      period_id: periodId,
      channel: d.channel,
      amount: d.amount,
    }));

  if (rows.length > 0) {
    const { error: insError } = await supabase.from('deposits').insert(rows);
    if (insError) throw new Error(`Error guardando depósitos: ${insError.message}`);
  }
}

// ─── Withdrawals (delete + reinsert for the period) ───

export async function upsertWithdrawals(
  companyId: string,
  periodId: string,
  withdrawals: { category: string; amount: number; description?: string | null }[]
): Promise<void> {
  const { error: delError } = await supabase
    .from('withdrawals')
    .delete()
    .eq('company_id', companyId)
    .eq('period_id', periodId);

  if (delError) throw new Error(`Error borrando retiros: ${delError.message}`);

  const rows = withdrawals
    .filter(w => w.amount > 0)
    .map(w => ({
      company_id: companyId,
      period_id: periodId,
      category: w.category,
      amount: w.amount,
      description: w.description ?? null,
    }));

  if (rows.length > 0) {
    const { error: insError } = await supabase.from('withdrawals').insert(rows);
    if (insError) throw new Error(`Error guardando retiros: ${insError.message}`);
  }
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

const MAIN_SAVE_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} tardó demasiado (>${ms / 1000}s)`)), ms),
    ),
  ]);
}

async function syncExpenseTemplates(
  companyId: string,
  fixedExpenses: { concept: string; amount: number }[],
): Promise<void> {
  if (fixedExpenses.length === 0) return;
  // `expense_templates` has UNIQUE (company_id, concept) — one bulk upsert
  // replaces the old N+1 select-then-update/insert loop.
  const { error } = await supabase
    .from('expense_templates')
    .upsert(
      fixedExpenses.map((fx) => ({
        company_id: companyId,
        concept: fx.concept,
        amount: fx.amount,
        active: true,
      })),
      { onConflict: 'company_id,concept' },
    );
  if (error) throw new Error(error.message);
}

export async function upsertExpenses(
  companyId: string,
  periodId: string,
  expenses: { concept: string; amount: number; paid: number; pending: number; is_fixed?: boolean; category?: string | null }[]
): Promise<void> {
  const mainSave = (async () => {
    const { error: delError } = await supabase
      .from('expenses')
      .delete()
      .eq('company_id', companyId)
      .eq('period_id', periodId);

    if (delError) throw new Error(`Error borrando egresos: ${delError.message}`);

    if (expenses.length > 0) {
      const rows = expenses.map((e, i) => ({
        company_id: companyId,
        period_id: periodId,
        concept: e.concept,
        amount: e.amount,
        paid: e.paid,
        pending: e.pending,
        is_fixed: !!e.is_fixed,
        category: e.category ?? null,
        sort_order: i + 1,
      }));

      const { error: insError } = await supabase.from('expenses').insert(rows);
      if (insError) throw new Error(`Error guardando egresos: ${insError.message}`);
    }
  })();

  await withTimeout(mainSave, MAIN_SAVE_TIMEOUT_MS, 'upsertExpenses');

  // Fire-and-forget template sync — never blocks the return. If it fails
  // we log and move on; the user still sees a successful save, and next
  // save will reconcile.
  const fixedExpenses = expenses
    .filter((e) => e.is_fixed && e.concept.trim())
    .map((e) => ({ concept: e.concept, amount: e.amount }));
  void syncExpenseTemplates(companyId, fixedExpenses).catch((err) => {
    console.error('[upsertExpenses] template sync failed (non-fatal):', err);
  });
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
  const results = await Promise.all(
    ids.map((id, i) =>
      supabase
        .from('expenses')
        .update({ sort_order: i + 1, updated_at: new Date().toISOString() })
        .eq('id', id),
    ),
  );
  const firstError = results.find((r) => r.error)?.error;
  if (firstError) {
    throw new Error(`Error reordenando egresos: ${firstError.message}`);
  }
}

// ─── Expense Templates (CRUD) ───

export async function deactivateExpenseTemplate(id: string): Promise<void> {
  const { error } = await supabase
    .from('expense_templates')
    .update({ active: false })
    .eq('id', id);
  if (error) throw new Error(`Error desactivando plantilla: ${error.message}`);
}

export async function activateExpenseTemplate(id: string): Promise<void> {
  const { error } = await supabase
    .from('expense_templates')
    .update({ active: true })
    .eq('id', id);
  if (error) throw new Error(`Error activando plantilla: ${error.message}`);
}

export async function deleteExpenseTemplate(id: string): Promise<void> {
  const { error } = await supabase
    .from('expense_templates')
    .delete()
    .eq('id', id);
  if (error) throw new Error(`Error eliminando plantilla: ${error.message}`);
}

// ─── Channel Balances (snapshots por dia) ───

export async function upsertChannelBalance(
  companyId: string,
  snapshotDate: string,
  channelKey: string,
  amount: number,
  source: 'manual' | 'api' | 'derived' = 'manual'
): Promise<void> {
  const { data: existing } = await supabase
    .from('channel_balances')
    .select('id')
    .eq('company_id', companyId)
    .eq('snapshot_date', snapshotDate)
    .eq('channel_key', channelKey)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('channel_balances')
      .update({ amount, source })
      .eq('id', existing.id);
    if (error) throw new Error(`Error actualizando balance del canal: ${error.message}`);
  } else {
    const { error } = await supabase
      .from('channel_balances')
      .insert({
        company_id: companyId,
        snapshot_date: snapshotDate,
        channel_key: channelKey,
        amount,
        source,
      });
    if (error) throw new Error(`Error guardando balance del canal: ${error.message}`);
  }
}

// ─── Pinned Coinsbuy Wallets ───

export async function pinCoinsbuyWallet(
  companyId: string,
  walletId: string,
  walletLabel: string
): Promise<void> {
  const { error } = await supabase
    .from('pinned_coinsbuy_wallets')
    .insert({ company_id: companyId, wallet_id: walletId, wallet_label: walletLabel });
  if (error) {
    if (error.code === '23505') return; // Already pinned — ignore duplicate
    throw new Error(`Error fijando wallet: ${error.message}`);
  }
}

export async function unpinCoinsbuyWallet(
  companyId: string,
  walletId: string
): Promise<void> {
  const { error } = await supabase
    .from('pinned_coinsbuy_wallets')
    .delete()
    .eq('company_id', companyId)
    .eq('wallet_id', walletId);
  if (error) throw new Error(`Error quitando wallet fijada: ${error.message}`);
}

// ─── Operating Income (upsert single row per period) ───

export async function upsertOperatingIncome(
  companyId: string,
  periodId: string,
  income: { prop_firm: number; broker_pnl: number; other: number }
): Promise<void> {
  // Check if row exists. `maybeSingle()` returns null without erroring when
  // there's no match — `single()` would raise PGRST116 on an empty table and
  // the swallowed error path made first-time saves flaky.
  const { data: existing } = await supabase
    .from('operating_income')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_id', periodId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('operating_income')
      .update({ prop_firm: income.prop_firm, broker_pnl: income.broker_pnl, other: income.other })
      .eq('id', existing.id);
    if (error) throw new Error(`Error actualizando ingresos: ${error.message}`);
  } else {
    const { error } = await supabase
      .from('operating_income')
      .insert({
        company_id: companyId,
        period_id: periodId,
        prop_firm: income.prop_firm,
        broker_pnl: income.broker_pnl,
        other: income.other,
      });
    if (error) throw new Error(`Error guardando ingresos: ${error.message}`);
  }
}

// ─── Liquidity Movements ───

export async function insertLiquidityMovement(
  companyId: string,
  movement: { date: string; user_email: string | null; mt_account: string | null; deposit: number; withdrawal: number; balance: number }
): Promise<string> {
  const { data, error } = await supabase
    .from('liquidity_movements')
    .insert({
      company_id: companyId,
      date: movement.date,
      user_email: movement.user_email,
      mt_account: movement.mt_account,
      deposit: movement.deposit,
      withdrawal: movement.withdrawal,
      balance: movement.balance,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Error guardando movimiento de liquidez: ${error.message}`);
  return data.id;
}

export async function updateLiquidityMovement(
  id: string,
  updates: { date: string; user_email: string | null; mt_account: string | null; deposit: number; withdrawal: number; balance: number }
): Promise<void> {
  const { error } = await supabase
    .from('liquidity_movements')
    .update(updates)
    .eq('id', id);

  if (error) throw new Error(`Error actualizando movimiento de liquidez: ${error.message}`);
}

export async function deleteLiquidityMovement(id: string): Promise<void> {
  const { error } = await supabase
    .from('liquidity_movements')
    .delete()
    .eq('id', id);

  if (error) throw new Error(`Error eliminando movimiento de liquidez: ${error.message}`);
}

// ─── Investments ───

export async function insertInvestment(
  companyId: string,
  investment: { date: string; concept: string | null; responsible: string | null; deposit: number; withdrawal: number; profit: number; balance: number }
): Promise<string> {
  const { data, error } = await supabase
    .from('investments')
    .insert({
      company_id: companyId,
      ...investment,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Error guardando inversión: ${error.message}`);
  return data.id;
}

export async function updateInvestment(
  id: string,
  updates: { date: string; concept: string | null; responsible: string | null; deposit: number; withdrawal: number; profit: number; balance: number }
): Promise<void> {
  const { error } = await supabase
    .from('investments')
    .update(updates)
    .eq('id', id);

  if (error) throw new Error(`Error actualizando inversión: ${error.message}`);
}

export async function deleteInvestment(id: string): Promise<void> {
  const { error } = await supabase
    .from('investments')
    .delete()
    .eq('id', id);

  if (error) throw new Error(`Error eliminando inversión: ${error.message}`);
}

// ─── Prop Firm Sales (upsert single row per period) ───

export async function upsertPropFirmSales(
  companyId: string,
  periodId: string,
  amount: number
): Promise<void> {
  const { data: existing } = await supabase
    .from('prop_firm_sales')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_id', periodId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('prop_firm_sales')
      .update({ amount })
      .eq('id', existing.id);
    if (error) throw new Error(`Error actualizando ventas prop firm: ${error.message}`);
  } else {
    const { error } = await supabase
      .from('prop_firm_sales')
      .insert({ company_id: companyId, period_id: periodId, amount });
    if (error) throw new Error(`Error guardando ventas prop firm: ${error.message}`);
  }
}

// ─── P2P Transfers (upsert single row per period) ───

export async function upsertP2PTransfers(
  companyId: string,
  periodId: string,
  amount: number
): Promise<void> {
  const { data: existing } = await supabase
    .from('p2p_transfers')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_id', periodId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('p2p_transfers')
      .update({ amount })
      .eq('id', existing.id);
    if (error) throw new Error(`Error actualizando P2P: ${error.message}`);
  } else {
    const { error } = await supabase
      .from('p2p_transfers')
      .insert({ company_id: companyId, period_id: periodId, amount });
    if (error) throw new Error(`Error guardando P2P: ${error.message}`);
  }
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
