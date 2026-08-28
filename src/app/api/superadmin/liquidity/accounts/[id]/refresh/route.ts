// ─────────────────────────────────────────────────────────────────────────────
// POST /api/superadmin/liquidity/accounts/[id]/refresh
//
// Refresca UNA cuenta contra MT5 y recalcula su PnL mensual.
//
// ── LO QUE EL REFRESH NO TOCA: `balance_liquidez` ──────────────────────────
// Y es la regla más importante de este módulo. El aporte al pool se fija UNA
// vez, al agregar la cuenta, después de analizar si ese dinero ya estaba
// contado. Si el refresh lo recalculara, una transferencia detectada hace un
// mes volvería a descontarse en cada corrida y el pool encogería solo hasta
// cero, sin que nadie lo note.
//
// Acá se actualiza lo que MT5 sabe hoy: balance, equity, grupo y correo.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import { fetchMt5Account } from '@/lib/liquidity/mt5-account';
import { calculateMonthlyPnL } from '@/lib/liquidity/monthly-pnl-calculator';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();
    const { data: cuenta, error: e1 } = await admin
      .from('platform_liquidity_accounts')
      .select('id, company_id, mt5_account, connection_date, balance_liquidez')
      .eq('id', id)
      .maybeSingle();
    if (e1) return apiError('superadmin/liquidity/refresh', e1, { status: 500 });
    if (!cuenta) {
      return NextResponse.json({ success: false, error: 'Cuenta no encontrada.' }, { status: 404 });
    }

    const warnings: string[] = [];
    let mt5: Awaited<ReturnType<typeof fetchMt5Account>> = null;
    let syncError: string | null = null;
    try {
      mt5 = await fetchMt5Account(cuenta.company_id, Number(cuenta.mt5_account));
      if (!mt5) syncError = `La cuenta ${cuenta.mt5_account} ya no existe en MT5.`;
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
    }

    if (syncError) {
      // Se marca el error pero NO se ponen los saldos en cero: un fallo de
      // conexión no es «el cliente se quedó sin plata», y confundirlos vaciaría
      // el pool por un problema de red.
      await admin
        .from('platform_liquidity_accounts')
        .update({
          status: 'error',
          sync_error: syncError,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);
      return NextResponse.json({ success: false, error: syncError, warnings }, { status: 502 });
    }

    const { error: e2 } = await admin
      .from('platform_liquidity_accounts')
      .update({
        // `balance_liquidez` NO está acá a propósito. Ver la cabecera.
        balance: mt5!.balance,
        equity: mt5!.equity,
        mt5_group: mt5!.group,
        mt5_email: mt5!.email,
        status: mt5!.balance > 0 ? 'active' : 'inactive',
        sync_error: null,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (e2) return apiError('superadmin/liquidity/refresh', e2, { status: 500 });

    // El PnL sí se recalcula: son hechos de MT5, no una decisión sobre el pool.
    let meses = 0;
    try {
      const pnl = await calculateMonthlyPnL(
        cuenta.company_id,
        String(cuenta.mt5_account),
        new Date(cuenta.connection_date),
      );
      if (pnl.length > 0) {
        const { error } = await admin.from('platform_liquidity_monthly_pnl').upsert(
          pnl.map((m) => ({ account_id: id, ...m })),
          { onConflict: 'account_id,year,month' },
        );
        if (error) warnings.push(`No se pudo guardar el PnL: ${error.message}`);
        else meses = pnl.length;
      }
    } catch (err) {
      warnings.push(`No se pudo calcular el PnL: ${err instanceof Error ? err.message : String(err)}`);
    }

    return NextResponse.json({ success: true, monthsCalculated: meses, warnings });
  } catch (err) {
    return apiError('superadmin/liquidity/refresh', err, { status: 500 });
  }
}
