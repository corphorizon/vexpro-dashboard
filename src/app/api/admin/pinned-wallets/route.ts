// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/pinned-wallets
//
// Las wallets de Coinsbuy fijadas de la empresa ACTIVA.
//
// ── POR QUÉ EXISTE (Kevin, 2026-09-02: «estoy intentando pinnear las 4 wallets
//    y no me deja») ─────────────────────────────────────────────────────────
// Sí lo dejaba: las cuatro de AP Markets estaban guardadas en la base. Lo que
// fallaba era la LECTURA de la pantalla, y la causa es la asimetría clásica de
// este repo: la escritura va por `/api/admin/data` (servidor, empresa del
// token, service role) y la lectura iba por el cliente del navegador contra
// `pinned_coinsbuy_wallets` con RLS. Ese camino no conoce la empresa ACTIVA
// del superadmin — es el mismo motivo por el que el repo ya había prohibido el
// `fetch` pelado en otras pantallas («rompe el ver como del superadmin»).
//
// Resultado: escribías en AP y leías en el vacío, con la pantalla diciendo
// «0 fijadas» sin ningún error. Un fallo que no da error, otra vez.
//
// Usa el MISMO lector canónico que el resto del servidor (`fetchPinnedWallets`
// de src/lib/pinned-wallets.ts), así la pantalla no puede divergir del número
// que usan los balances y el Net Deposit.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { fetchPinnedWallets } from '@/lib/pinned-wallets';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { modules: ['balances'] });
    if (auth instanceof NextResponse) return auth;

    const wallets = await fetchPinnedWallets(auth.companyId);
    return NextResponse.json({ success: true, wallets });
  } catch (err) {
    return apiError('admin/pinned-wallets', err, { status: 500 });
  }
}
