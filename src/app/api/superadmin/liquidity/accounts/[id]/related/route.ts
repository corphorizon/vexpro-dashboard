// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/liquidity/accounts/[id]/related
//
// Las otras cuentas del mismo cliente, con las transferencias detectadas entre
// ellas. Es la pantalla que explica POR QUÉ una cuenta aporta menos al pool que
// su balance de MT5 — sin esto, ese número parece un error.
//
// El vínculo se resuelve por CORREO y no por `related_account_ids`: ese array
// se llena al agregar la cuenta y no se actualiza si después aparece una
// tercera. El correo siempre está al día.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

export async function GET(
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
      .select('id, company_id, mt5_account, mt5_email')
      .eq('id', id)
      .maybeSingle();
    if (e1) return apiError('superadmin/liquidity/related', e1, { status: 500 });
    if (!cuenta) {
      return NextResponse.json({ success: false, error: 'Cuenta no encontrada.' }, { status: 404 });
    }

    // Sin correo no hay forma de vincular: se devuelve vacío DICIÉNDOLO, para
    // que la pantalla no muestre «no tiene otras cuentas» cuando en realidad
    // no se pudo saber.
    if (!cuenta.mt5_email) {
      return NextResponse.json({
        success: true,
        related: [],
        transfers: [],
        note: 'La cuenta no tiene correo en MT5: no se pueden vincular otras cuentas del mismo cliente.',
      });
    }

    const { data: related, error: e2 } = await admin
      .from('platform_liquidity_accounts')
      .select('id, mt5_account, mt5_group, balance, balance_liquidez, status, connection_date, deactivated_reason')
      .eq('company_id', cuenta.company_id)
      .eq('mt5_email', cuenta.mt5_email)
      .neq('id', id)
      .order('connection_date', { ascending: true });
    if (e2) return apiError('superadmin/liquidity/related', e2, { status: 500 });

    // Transferencias en las dos direcciones: la cuenta puede haber recibido o
    // haber cedido saldo, y las dos explican su aporte al pool.
    const ids = [id, ...(related ?? []).map((r) => String(r.id))];
    const { data: transfers } = await admin
      .from('platform_liquidity_transfers')
      .select('from_account_id, to_account_id, amount, detection_method, detected_at')
      .or(`from_account_id.in.(${ids.join(',')}),to_account_id.in.(${ids.join(',')})`)
      .order('detected_at', { ascending: false });

    return NextResponse.json({
      success: true,
      related: related ?? [],
      transfers: transfers ?? [],
    });
  } catch (err) {
    return apiError('superadmin/liquidity/related', err, { status: 500 });
  }
}
