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
  // Queda en verifyAuth (cualquier rol) porque la tarjeta de Balances la ven
  // todos los roles que tienen el módulo — el filtro que faltaba era el
  // módulo, no el rol. El GET del libro completo (../route.ts) sigue igual.
  const auth = await verifyAuth(request, { modules: ['balances'] });
  if (auth instanceof NextResponse) return auth;

  const asof = request.nextUrl.searchParams.get('asof');
  if (!asof || !/^\d{4}-\d{2}-\d{2}$/.test(asof)) {
    return NextResponse.json(
      { success: false, error: 'Parámetro asof inválido (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const [balRes, lastRes] = await Promise.all([
    admin.rpc('get_channel_ledger_balances', {
      p_company_id: auth.companyId,
      p_asof: asof,
    }),
    // Fecha del último asiento de cada canal (migración 112). Es lo que
    // permite decir en pantalla de CUÁNDO es el saldo de una ubicación manual
    // — ver ítem 23 de la auditoría de finanzas.
    admin.rpc('get_channel_ledger_last_entry', {
      p_company_id: auth.companyId,
      p_asof: asof,
    }),
  ]);

  if (balRes.error) return apiError('admin/channel-ledger/balances', balRes.error, { status: 500 });

  const balances: Record<string, number> = {};
  for (const row of (balRes.data ?? []) as Array<{ channel_key: string; balance: number | string }>) {
    balances[row.channel_key] = Number(row.balance) || 0;
  }

  // La antigüedad NO es fatal: si la RPC todavía no está aplicada o falla, la
  // pantalla muestra los saldos sin el cartel de "viejo" — que es exactamente
  // como estaba antes. Lo que no puede pasar es que un saldo desaparezca por
  // no poder fecharlo.
  const lastEntry: Record<string, string> = {};
  if (lastRes.error) {
    console.warn('[admin/channel-ledger/balances] último asiento:', lastRes.error.message);
  } else {
    for (const row of (lastRes.data ?? []) as Array<{
      channel_key: string;
      last_entry_date: string | null;
    }>) {
      if (row.last_entry_date) lastEntry[row.channel_key] = row.last_entry_date;
    }
  }

  return NextResponse.json({ success: true, asof, balances, lastEntry });
}
