// ─────────────────────────────────────────────────────────────────────────────
// POST /api/superadmin/liquidity/refresh-all?company_id=...
//
// Refresca todas las cuentas del pool contra MT5.
//
// ── SECUENCIAL Y CON TECHO, A PROPÓSITO ────────────────────────────────────
// Cada cuenta abre su consulta a MT5 por el mismo túnel; paralelizarlas
// multiplicaría las conexiones contra la base de producción del broker, que es
// exactamente lo que el resto del repo evita.
//
// El techo existe porque esto corre en una función con presupuesto limitado. Y
// NO es silencioso: lo que no entró viaja en la respuesta. Un recorte que no se
// cuenta es indistinguible de «ya estaban todas al día».
//
// Igual que el refresh individual: NO toca `balance_liquidez`. El aporte al
// pool se fija al agregar la cuenta.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import { fetchMt5Account } from '@/lib/liquidity/mt5-account';
import { calculateMonthlyPnL } from '@/lib/liquidity/monthly-pnl-calculator';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Cuentas por corrida. El costo es lineal y el presupuesto de la función no. */
const MAX_POR_CORRIDA = 60;

export async function POST(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const companyId = request.nextUrl.searchParams.get('company_id');
    if (!companyId) {
      return NextResponse.json({ success: false, error: 'Falta company_id.' }, { status: 400 });
    }

    const admin = createAdminClient();
    // Las más desactualizadas primero: así corridas sucesivas cubren todo sin
    // repetir siempre las mismas.
    const { data: cuentas, error } = await admin
      .from('platform_liquidity_accounts')
      .select('id, company_id, mt5_account, connection_date')
      .eq('company_id', companyId)
      .order('last_synced_at', { ascending: true, nullsFirst: true });
    if (error) return apiError('superadmin/liquidity/refresh-all', error, { status: 500 });

    const todas = cuentas ?? [];
    const tanda = todas.slice(0, MAX_POR_CORRIDA);
    const warnings: string[] = [];
    if (todas.length > tanda.length) {
      warnings.push(
        `Quedaron ${todas.length - tanda.length} cuenta(s) sin refrescar (techo de ${MAX_POR_CORRIDA} por corrida). Volvé a ejecutar para seguir.`,
      );
    }

    let ok = 0;
    let fallidas = 0;
    for (const c of tanda) {
      try {
        const mt5 = await fetchMt5Account(c.company_id, Number(c.mt5_account));
        if (!mt5) {
          fallidas += 1;
          await admin
            .from('platform_liquidity_accounts')
            .update({
              status: 'error',
              sync_error: `La cuenta ${c.mt5_account} ya no existe en MT5.`,
              last_synced_at: new Date().toISOString(),
            })
            .eq('id', c.id);
          continue;
        }
        await admin
          .from('platform_liquidity_accounts')
          .update({
            balance: mt5.balance,
            equity: mt5.equity,
            mt5_group: mt5.group,
            mt5_email: mt5.email,
            status: mt5.balance > 0 ? 'active' : 'inactive',
            sync_error: null,
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', c.id);

        const pnl = await calculateMonthlyPnL(
          c.company_id,
          String(c.mt5_account),
          new Date(c.connection_date),
        );
        if (pnl.length > 0) {
          await admin.from('platform_liquidity_monthly_pnl').upsert(
            pnl.map((m) => ({ account_id: c.id, ...m })),
            { onConflict: 'account_id,year,month' },
          );
        }
        ok += 1;
      } catch (err) {
        // Una cuenta que falla no tira la corrida: las demás siguen.
        fallidas += 1;
        const m = err instanceof Error ? err.message : String(err);
        warnings.push(`Cuenta ${c.mt5_account}: ${m}`);
        await admin
          .from('platform_liquidity_accounts')
          .update({ status: 'error', sync_error: m, last_synced_at: new Date().toISOString() })
          .eq('id', c.id);
      }
    }

    return NextResponse.json({
      success: true,
      total: todas.length,
      refreshed: ok,
      failed: fallidas,
      warnings,
    });
  } catch (err) {
    return apiError('superadmin/liquidity/refresh-all', err, { status: 500 });
  }
}
