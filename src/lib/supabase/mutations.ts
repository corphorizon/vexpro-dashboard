import { withActiveCompany, apiFetch } from '@/lib/api-fetch';
import type { PinnedWalletRole } from '@/lib/pinned-wallet-roles';

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

/**
 * Cerrar congela los totales del período y bloquea sus escrituras (migr. 061).
 * Reabrir EXIGE motivo: es deshacer un cierre contable y tiene que quedar
 * dicho por qué. El servidor lo revalida — esto no es solo cosmética de UI.
 */
export async function updatePeriodStatus(
  periodId: string,
  isClosed: boolean,
  reason?: string,
): Promise<void> {
  await postData('period_status', { periodId, isClosed, reason });
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
  // UNA fila por categoría (migración 065). /upload concatena la tabla base
  // con los "extras" y podía mandar la misma categoría dos veces; con filas
  // duplicadas, tres pantallas leían tres montos distintos del mismo mes
  // (.find() tomaba la primera, el índice de la cadena la última y el
  // consolidado las sumaba — auditoría 2026-08-06, C5). Se consolida acá,
  // el único punto de paso, y el UNIQUE de la base lo garantiza para siempre.
  const byCategory = new Map<string, { category: string; amount: number; description: string | null }>();
  for (const w of withdrawals) {
    const prev = byCategory.get(w.category);
    if (prev) {
      prev.amount += w.amount;
      if (w.description) {
        prev.description = prev.description ? `${prev.description} · ${w.description}` : w.description;
      }
    } else {
      byCategory.set(w.category, { category: w.category, amount: w.amount, description: w.description ?? null });
    }
  }
  await postData('withdrawals', { periodId, rows: [...byCategory.values()] });
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
  expenses: { concept: string; amount: number; paid: number; pending: number; is_fixed?: boolean; category?: string | null; expense_date?: string | null; payment_order_id?: string | null; reference?: string | null; attachment_bucket?: string | null; attachment_path?: string | null; attachment_name?: string | null; attachment_mime?: string | null; attachment_size?: number | null; attachment_uploaded_at?: string | null }[]
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
    // migration-056. La RPC re-inserta el período entero desde este payload:
    // si la fecha no viaja acá, se pierde en el próximo guardado.
    expense_date: e.expense_date || null,
    // Mismo motivo que expense_date: la RPC re-inserta el período entero desde
    // este payload. Si el vínculo con la orden de pago no viaja acá, el link
    // de "OP-2026-0001" en Egresos desaparece al primer guardado del mes.
    payment_order_id: e.payment_order_id || null,
    // migration-060, mismo motivo que los dos de arriba: la RPC re-inserta el
    // período entero desde este payload. Si la referencia y el adjunto no
    // viajan acá, el comprobante del egreso se borra solo al guardar el mes.
    reference: e.reference || null,
    attachment_bucket: e.attachment_bucket || null,
    attachment_path: e.attachment_path || null,
    attachment_name: e.attachment_name || null,
    attachment_mime: e.attachment_mime || null,
    attachment_size: e.attachment_size ?? null,
    attachment_uploaded_at: e.attachment_uploaded_at || null,
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

// ─── Egresos fijos: edición "de este mes en adelante" ───
//
// Kevin (2026-08-06): editar un egreso FIJO desde el mes que está mirando debe
// cambiar ese mes y todos los siguientes, sin tocar los meses cerrados (sus
// cifras ya se reportaron).
//
// El matching es por CONCEPTO viejo: `expenses` no guarda template_id, la
// materialización de fijos empareja plantilla↔egreso por concepto (ver
// materialize_fixed_expenses en migration-050). Por eso hay que mandar
// `old_concept` aunque el usuario lo haya renombrado.
export async function applyFixedExpenseForward(params: {
  periodId: string;
  oldConcept: string;
  concept: string;
  amount: number;
  category?: string | null;
  apply: 'this' | 'forward';
}): Promise<{ updatedPeriods: number }> {
  const res = await apiFetch('/api/admin/expenses/fixed-forward', {
    method: 'POST',
    body: JSON.stringify({
      period_id: params.periodId,
      old_concept: params.oldConcept,
      concept: params.concept,
      amount: params.amount,
      category: params.category ?? null,
      apply: params.apply,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `Error propagando el egreso fijo (${res.status})`);
  }
  return { updatedPeriods: Number(data?.updatedPeriods ?? 0) };
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
  walletLabel: string,
  /** 'operating' (default) cuenta como depósitos/retiros de clientes;
   *  'internal' solo suma al balance. Ver migración 084. */
  role: PinnedWalletRole = 'operating'
): Promise<void> {
  await postData('pin_wallet', { walletId, walletLabel, role });
}

/** Cambia el rol de una wallet ya fijada (Operativa ↔ Interna). */
export async function setPinnedWalletRole(
  companyId: string,
  walletId: string,
  role: PinnedWalletRole
): Promise<void> {
  await postData('pin_wallet_role', { walletId, role });
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
  investment: { date: string; concept: string | null; responsible: string | null; deposit: number; withdrawal: number; profit: number; balance: number; movement_type?: string | null }
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
