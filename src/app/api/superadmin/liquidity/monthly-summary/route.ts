// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/liquidity/monthly-summary?company_id=...&year=YYYY&month=MM
//
// Qué cuentas aportaron PnL en un mes y cuánto. Es la vista que responde
// «cuánto rindió el pool en julio», que por cuenta no se ve.
//
// Incluye las cuentas con PnL CERO de ese mes: una cuenta que estuvo en el pool
// y no operó es parte de la respuesta. Filtrarlas haría parecer que el pool
// tenía menos cuentas de las que tenía.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const sp = request.nextUrl.searchParams;
    const companyId = sp.get('company_id');
    const year = Number(sp.get('year'));
    const month = Number(sp.get('month'));

    if (!companyId) {
      return NextResponse.json({ success: false, error: 'Falta company_id.' }, { status: 400 });
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return NextResponse.json({ success: false, error: 'Año inválido.' }, { status: 400 });
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ success: false, error: 'Mes inválido.' }, { status: 400 });
    }

    const admin = createAdminClient();

    // Dos consultas y no un join: PostgREST no expone LATERAL, y con decenas de
    // cuentas traer las dos listas y cruzarlas en memoria es más simple que
    // pelear con la sintaxis de embebidos.
    const { data: cuentas, error: e1 } = await admin
      .from('platform_liquidity_accounts')
      .select('id, mt5_account, mt5_email, mt5_group, balance, balance_liquidez, status')
      .eq('company_id', companyId);
    if (e1) return apiError('superadmin/liquidity/monthly-summary', e1, { status: 500 });

    const ids = (cuentas ?? []).map((c) => String(c.id));
    if (ids.length === 0) {
      return NextResponse.json({ success: true, year, month, rows: [], total: 0, operations: 0 });
    }

    const { data: pnl, error: e2 } = await admin
      .from('platform_liquidity_monthly_pnl')
      .select('account_id, pnl, operations_count, is_partial')
      .eq('year', year)
      .eq('month', month)
      .in('account_id', ids);
    if (e2) return apiError('superadmin/liquidity/monthly-summary', e2, { status: 500 });

    const porCuenta = new Map(
      (pnl ?? []).map((p) => [String(p.account_id), p]),
    );

    const rows = (cuentas ?? [])
      // Sólo las que tienen fila de ese mes: una cuenta agregada en agosto no
      // "aportó cero" en julio — sencillamente no existía en el pool.
      .filter((c) => porCuenta.has(String(c.id)))
      .map((c) => {
        const p = porCuenta.get(String(c.id))!;
        return {
          account_id: c.id,
          mt5_account: c.mt5_account,
          mt5_email: c.mt5_email,
          mt5_group: c.mt5_group,
          balance: Number(c.balance) || 0,
          balance_liquidez: Number(c.balance_liquidez) || 0,
          status: c.status,
          pnl: Number(p.pnl) || 0,
          operations_count: Number(p.operations_count) || 0,
          is_partial: Boolean(p.is_partial),
        };
      })
      .sort((a, b) => b.pnl - a.pnl);

    return NextResponse.json({
      success: true,
      year,
      month,
      rows,
      total: Math.round(rows.reduce((s, r) => s + r.pnl, 0) * 100) / 100,
      operations: rows.reduce((s, r) => s + r.operations_count, 0),
    });
  } catch (err) {
    return apiError('superadmin/liquidity/monthly-summary', err, { status: 500 });
  }
}
