import { createClient } from './client';
import { withActiveCompany, apiFetch } from '@/lib/api-fetch';

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

// ATÓMICO vía RPC (migración 044). Antes era DELETE + INSERT en dos llamadas
// HTTP: un fallo/timeout entre ambas dejaba el período sin depósitos (misma
// clase de bug que vació los egresos de VexPro May 2026). El filtro de
// montos = 0 vive en la función SQL.
export async function upsertDeposits(
  companyId: string,
  periodId: string,
  deposits: { channel: string; amount: number }[]
): Promise<void> {
  await resilientWrite(async () => {
    const { error } = await supabase.rpc('replace_period_deposits', {
      p_company_id: companyId,
      p_period_id: periodId,
      p_rows: deposits.map(d => ({ channel: d.channel, amount: d.amount })),
    });
    if (error) throw new Error(`Error guardando depósitos: ${error.message}`);
  }, 'Guardar depósitos');
}

// ─── Withdrawals (reemplazo atómico del período vía RPC, migración 044) ───

export async function upsertWithdrawals(
  companyId: string,
  periodId: string,
  withdrawals: { category: string; amount: number; description?: string | null }[]
): Promise<void> {
  await resilientWrite(async () => {
    const { error } = await supabase.rpc('replace_period_withdrawals', {
      p_company_id: companyId,
      p_period_id: periodId,
      p_rows: withdrawals.map(w => ({
        category: w.category,
        amount: w.amount,
        description: w.description ?? null,
      })),
    });
    if (error) throw new Error(`Error guardando retiros: ${error.message}`);
  }, 'Guardar retiros');
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

// ─── Escritura resiliente (timeout corto + reintento) ───
//
// CAUSA RAÍZ del cuelgue ">25s" (2026-07-12, diagnosticado con datos): la DB
// responde estos writes en <100ms (medido en pg_stat_statements: RPC
// replace_period_expenses 13.9ms avg / 82.7ms max sobre 63 llamadas). El
// cuelgue era 100% del cliente: el request de supabase-js se estancaba (red
// dormida, wifi cambiante, socket muerto que el browser no detecta) y el
// fetch NO tiene timeout por defecto → colgaba hasta el ceiling de 25s.
//
// FIX: cada intento tiene un timeout CORTO (12s). Si se estanca, reintentamos
// UNA vez. Esto es 100% seguro porque TODAS las mutaciones que usan este
// wrapper son idempotentes: los `replace_period_*` reemplazan el período
// entero (mismo input → mismo resultado) y los upsert usan ON CONFLICT. Un
// request estancado falla en 12s y el reintento — un fetch nuevo — resuelve
// al instante, en vez de que el usuario espere 25s y vea un error.
const WRITE_TIMEOUT_MS = 12_000;
const WRITE_RETRIES = 1;

async function resilientWrite<T>(op: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
    try {
      return await Promise.race([
        op(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${label} tardó demasiado (>${WRITE_TIMEOUT_MS / 1000}s)`)),
            WRITE_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      lastErr = err;
      if (attempt < WRITE_RETRIES) {
        // Pequeño backoff antes del reintento (deja que un blip de red pase).
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  throw lastErr;
}

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

// Upsert nativo en UNA llamada (ON CONFLICT sobre el UNIQUE existente).
// Antes: SELECT + (UPDATE|INSERT) en dos llamadas — no atómico.
export async function upsertChannelBalance(
  companyId: string,
  snapshotDate: string,
  channelKey: string,
  amount: number,
  source: 'manual' | 'api' | 'derived' = 'manual'
): Promise<void> {
  const { error } = await supabase
    .from('channel_balances')
    .upsert(
      {
        company_id: companyId,
        snapshot_date: snapshotDate,
        channel_key: channelKey,
        amount,
        source,
      },
      { onConflict: 'company_id,snapshot_date,channel_key' },
    );
  if (error) throw new Error(`Error guardando balance del canal: ${error.message}`);
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

// Upsert nativo en UNA llamada (ON CONFLICT sobre UNIQUE company_id+period_id).
// Antes: SELECT + (UPDATE|INSERT) en dos llamadas — no atómico.
export async function upsertOperatingIncome(
  companyId: string,
  periodId: string,
  income: { prop_firm: number; broker_pnl: number; other: number }
): Promise<void> {
  await resilientWrite(async () => {
    const { error } = await supabase
      .from('operating_income')
      .upsert(
        {
          company_id: companyId,
          period_id: periodId,
          prop_firm: income.prop_firm,
          broker_pnl: income.broker_pnl,
          other: income.other,
        },
        { onConflict: 'company_id,period_id' },
      );
    if (error) throw new Error(`Error guardando ingresos: ${error.message}`);
  }, 'Guardar ingresos');
}

// ─── Liquidity Movements ───

export async function insertLiquidityMovement(
  companyId: string,
  movement: { date: string; user_email: string | null; mt_account: string | null; deposit: number; withdrawal: number; balance: number }
): Promise<string> {
  // id generado en el cliente → INSERT idempotente y reintentable (ver
  // insertInvestment / resilientWrite). Un reintento con el mismo id choca
  // con la PK (23505) y se trata como éxito: sin duplicados, sin cuelgue 25s.
  const id = crypto.randomUUID();
  await resilientWrite(async () => {
    const { error } = await supabase
      .from('liquidity_movements')
      .insert({
        id,
        company_id: companyId,
        date: movement.date,
        user_email: movement.user_email,
        mt_account: movement.mt_account,
        deposit: movement.deposit,
        withdrawal: movement.withdrawal,
        balance: movement.balance,
      });
    if (error && error.code !== '23505') {
      throw new Error(`Error guardando movimiento de liquidez: ${error.message}`);
    }
  }, 'Guardar movimiento de liquidez');
  return id;
}

export async function updateLiquidityMovement(
  id: string,
  updates: { date: string; user_email: string | null; mt_account: string | null; deposit: number; withdrawal: number; balance: number }
): Promise<void> {
  await updateWithAbort('liquidity_movements', id, updates, 'Actualizar liquidez');
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
  // id generado en el cliente para volver el INSERT idempotente y por lo tanto
  // reintentable (ver resilientWrite): si un intento se estanca en la red y se
  // reintenta, el segundo insert con el MISMO id choca con la PK (código 23505)
  // y lo tratamos como éxito → nunca se duplica la fila y ya no cuelga 25s.
  const id = crypto.randomUUID();
  await resilientWrite(async () => {
    const { error } = await supabase
      .from('investments')
      .insert({ id, company_id: companyId, ...investment });
    if (error && error.code !== '23505') {
      throw new Error(`Error guardando inversión: ${error.message}`);
    }
  }, 'Guardar inversión');
  return id;
}

// Stiven (2026-06-19): updateInvestment / updateLiquidityMovement se colgaban
// 25s sin avisar nada útil. Causa raíz: el cliente JS de Supabase puede
// quedarse esperando un auth-refresh atascado ANTES de salir la petición HTTP,
// así que ni un `.abortSignal()` ni un `withRowTimeout` externo del caller
// llegan a interrumpir el bloqueo — la promesa nunca avanza.
//
// Defensa en 3 capas para que el usuario vea SIEMPRE un error útil en <15s:
//   1. Check de sesión con timeout de 5s. Si auth está bloqueado, falla rápido
//      con "sesión expirada — recarga la página".
//   2. Mutación con AbortSignal de 12s — cancela la HTTP request si llega a
//      salir y se cuelga del lado del servidor.
//   3. Promise.race con timeout de 13s como red de seguridad — por si el
//      abort signal no se honra (Supabase a veces ignora abort si la respuesta
//      ya está streamando).
//   + `.select('id')` para confirmar que el UPDATE afectó una fila (cazaría
//     denegaciones silenciosas por RLS).
async function updateWithAbort<T extends Record<string, unknown>>(
  table: string,
  id: string,
  updates: T,
  errLabel: string,
): Promise<void> {
  // Capa 1: verificar que la sesión está viva — sin esto, una sesión vencida
  // hace que el primer `.from()` se cuelgue en el lock de refresh hasta el
  // timeout del wrapper externo (25s).
  const sessionRace = await Promise.race([
    supabase.auth.getSession(),
    new Promise<{ data: { session: null } }>((_, reject) =>
      setTimeout(() => reject(new Error(`${errLabel}: el cliente de autenticación está bloqueado (>5s). Recarga la página con Ctrl+Shift+R.`)), 5_000),
    ),
  ]);
  if (!sessionRace.data?.session) {
    throw new Error(`${errLabel}: tu sesión expiró. Cierra sesión y vuelve a iniciar.`);
  }

  // Capa 2 + 3: mutación con abort interno + race externo
  const ctrl = new AbortController();
  const start = Date.now();
  const abortTid = setTimeout(() => ctrl.abort(), 12_000);

  const mutationPromise = supabase
    .from(table)
    .update(updates)
    .eq('id', id)
    .select('id')
    .abortSignal(ctrl.signal);

  const safetyTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      ctrl.abort();
      reject(new Error(`${errLabel}: la petición no respondió en 13s. Tu sesión puede estar caducando — recarga la página (Ctrl+Shift+R).`));
    }, 13_000),
  );

  try {
    const { data, error } = await Promise.race([mutationPromise, safetyTimeout]);
    if (error) {
      if (error.message.toLowerCase().includes('abort')) {
        throw new Error(`${errLabel}: petición cancelada tras ${Math.round((Date.now() - start) / 1000)}s. Sesión posiblemente expirada.`);
      }
      throw new Error(`${errLabel}: ${error.message}`);
    }
    if (!data || data.length === 0) {
      throw new Error(`${errLabel}: no se actualizó ninguna fila. Posible causa: permisos RLS o ID inexistente.`);
    }
  } finally {
    clearTimeout(abortTid);
  }
}

export async function updateInvestment(
  id: string,
  updates: { date: string; concept: string | null; responsible: string | null; deposit: number; withdrawal: number; profit: number; balance: number }
): Promise<void> {
  await updateWithAbort('investments', id, updates, 'Actualizar inversión');
}

export async function deleteInvestment(id: string): Promise<void> {
  const { error } = await supabase
    .from('investments')
    .delete()
    .eq('id', id);

  if (error) throw new Error(`Error eliminando inversión: ${error.message}`);
}

// ─── Prop Firm Sales (upsert single row per period) ───

// Upsert nativo en UNA llamada (UNIQUE company_id+period_id — migración 044).
export async function upsertPropFirmSales(
  companyId: string,
  periodId: string,
  amount: number
): Promise<void> {
  await resilientWrite(async () => {
    const { error } = await supabase
      .from('prop_firm_sales')
      .upsert(
        { company_id: companyId, period_id: periodId, amount },
        { onConflict: 'company_id,period_id' },
      );
    if (error) throw new Error(`Error guardando ventas prop firm: ${error.message}`);
  }, 'Guardar ventas prop firm');
}

// ─── P2P Transfers (upsert single row per period) ───

// Upsert nativo en UNA llamada (UNIQUE company_id+period_id — migración 044).
export async function upsertP2PTransfers(
  companyId: string,
  periodId: string,
  amount: number
): Promise<void> {
  await resilientWrite(async () => {
    const { error } = await supabase
      .from('p2p_transfers')
      .upsert(
        { company_id: companyId, period_id: periodId, amount },
        { onConflict: 'company_id,period_id' },
      );
    if (error) throw new Error(`Error guardando P2P: ${error.message}`);
  }, 'Guardar P2P');
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
