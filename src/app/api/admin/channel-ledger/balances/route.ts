// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/channel-ledger/balances?asof=YYYY-MM-DD
//
// Saldo del libro de CADA canal al cierre de `asof`. Lo consume la tarjeta
// "Balances por Canal" para pintar el saldo histórico sin traerse el libro
// entero de cada canal (el de Coinsbuy solo ya son cientos de asientos).
//
// La suma vive en la RPC get_channel_ledger_balances, no acá: el saldo de un
// canal tiene que dar lo mismo lo pida quien lo pida.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';

export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request);
  if (auth instanceof NextResponse) return auth;

  const asof = request.nextUrl.searchParams.get('asof');
  if (!asof || !/^\d{4}-\d{2}-\d{2}$/.test(asof)) {
    return NextResponse.json(
      { success: false, error: 'Parámetro asof inválido (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('get_channel_ledger_balances', {
    p_company_id: auth.companyId,
    p_asof: asof,
  });

  if (error) return apiError('admin/channel-ledger/balances', error, { status: 500 });

  const balances: Record<string, number> = {};
  for (const row of (data ?? []) as Array<{ channel_key: string; balance: number | string }>) {
    balances[row.channel_key] = Number(row.balance) || 0;
  }

  return NextResponse.json({ success: true, asof, balances });
}
