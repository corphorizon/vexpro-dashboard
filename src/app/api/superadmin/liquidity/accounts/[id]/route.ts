// ─────────────────────────────────────────────────────────────────────────────
// /api/superadmin/liquidity/accounts/[id]
//
//   PATCH  → editar la nota (lo único editable a mano)
//   DELETE → sacar la cuenta del pool
//
// ── POR QUÉ SÓLO LA NOTA ES EDITABLE ───────────────────────────────────────
// Balance, equity y grupo los manda MT5; el `balance_liquidez` lo decide el
// análisis de duplicados. Dejarlos editables a mano crearía dos verdades sobre
// el mismo número y ganaría la última que alguien tocó.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const body = (await request.json().catch(() => ({}))) as { note?: unknown };
    if (!('note' in body)) {
      return NextResponse.json(
        { success: false, error: 'Sólo se puede editar la nota.' },
        { status: 400 },
      );
    }
    const note = body.note === null || body.note === '' ? null : String(body.note);

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('platform_liquidity_accounts')
      .update({ note, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) return apiError('superadmin/liquidity/accounts PATCH', error, { status: 500 });
    if (!data) {
      return NextResponse.json({ success: false, error: 'Cuenta no encontrada.' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError('superadmin/liquidity/accounts PATCH', err, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();

    // El PnL mensual y las transferencias caen por ON DELETE CASCADE. Lo que
    // NO cae es el id dentro de `related_account_ids` de otras cuentas: es un
    // array sin integridad referencial, así que se limpia acá.
    const { data: relacionadas } = await admin
      .from('platform_liquidity_accounts')
      .select('id, related_account_ids')
      .contains('related_account_ids', [id]);
    for (const r of relacionadas ?? []) {
      const limpio = (r.related_account_ids as string[] | null ?? []).filter((x) => x !== id);
      await admin
        .from('platform_liquidity_accounts')
        .update({ related_account_ids: limpio.length > 0 ? limpio : null })
        .eq('id', r.id);
    }

    const { error } = await admin.from('platform_liquidity_accounts').delete().eq('id', id);
    if (error) return apiError('superadmin/liquidity/accounts DELETE', error, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError('superadmin/liquidity/accounts DELETE', err, { status: 500 });
  }
}
