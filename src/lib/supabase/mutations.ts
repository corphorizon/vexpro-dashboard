import { createClient } from './client';

const supabase = createClient();

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
  withdrawals: { category: string; amount: number }[]
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
    }));

  if (rows.length > 0) {
    const { error: insError } = await supabase.from('withdrawals').insert(rows);
    if (insError) throw new Error(`Error guardando retiros: ${insError.message}`);
  }
}

// ─── Expenses (delete + reinsert for the period) ───

export async function upsertExpenses(
  companyId: string,
  periodId: string,
  expenses: { concept: string; amount: number; paid: number; pending: number }[]
): Promise<void> {
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
      sort_order: i + 1,
    }));

    const { error: insError } = await supabase.from('expenses').insert(rows);
    if (insError) throw new Error(`Error guardando egresos: ${insError.message}`);
  }
}

// ─── Operating Income (upsert single row per period) ───

export async function upsertOperatingIncome(
  companyId: string,
  periodId: string,
  income: { prop_firm: number; broker_pnl: number; other: number }
): Promise<void> {
  // Check if row exists
  const { data: existing } = await supabase
    .from('operating_income')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_id', periodId)
    .single();

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
    .single();

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
    .single();

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
