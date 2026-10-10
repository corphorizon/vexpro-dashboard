// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/wallet-preference
//
// POST { walletId: string | null }
//   → Persist the active company's preferred Coinsbuy wallet id (or clear
//     it for "Todas las wallets" mode by passing null/empty). Stored on
//     companies.default_wallet_id (added in migration 031). Used by the
//     /movimientos banner so the wallet filter survives reloads.
//
//   → 409 { success:false, error } si la wallet está fijada como INTERNA
//     (pinned_coinsbuy_wallets.role): una interna puede mirarse, pero no ser
//     el punto de partida de /movimientos. La página la aplica en sesión igual.
//
// Auth: verifyAdminAuth (admin / auditor / hr OR superadmin viewing-as).
// Service-role write so RLS doesn't get in the way of platform_users
// updating tenant rows.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import { normalizePinnedWalletRole } from '@/lib/pinned-wallet-roles';

export async function POST(request: NextRequest) {
  const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['movements'] });
  if (auth instanceof NextResponse) return auth;

  let body: { walletId?: string | null };
  try {
    body = (await request.json()) as { walletId?: string | null };
  } catch {
    return NextResponse.json({ success: false, error: 'Body JSON inválido' }, { status: 400 });
  }

  // Empty string and the literal 'all' both clear the preference (= no
  // wallet filter on the Movimientos page).
  const raw = body.walletId;
  const next: string | null =
    raw && typeof raw === 'string' && raw !== 'all' && raw.length > 0
      ? raw
      : null;

  const admin = createAdminClient();

  // Una wallet fijada como INTERNA (solo balance) no puede ser la default de
  // Movimientos: el banner abriría en una wallet que no recibe depósitos y la
  // tarjeta «Coinsbuy · Depósitos» mostraría $0 con tilde verde (AP Markets,
  // 2026-10-05 → 10). El registro de roles es uno solo: pinned_coinsbuy_wallets.
  // Se rechaza con 409 y la selección sigue valiendo para la sesión (la página
  // la aplica antes de persistir); al recargar, el banner arranca en una operativa.
  //
  // Lectura directa de la tabla y no fetchPinnedWallets(): esa helper devuelve
  // [] ante un error de DB, y acá "no encontré el pin" dejaría pasar una
  // interna como default en silencio. Un error de lectura tiene que ser 500.
  if (next) {
    const { data: pin, error: pinErr } = await admin
      .from('pinned_coinsbuy_wallets')
      .select('role')
      .eq('company_id', auth.companyId)
      .eq('wallet_id', next)
      .maybeSingle<{ role: string | null }>();
    if (pinErr) {
      return apiError('admin/wallet-preference', pinErr, { status: 500, clientMessage: 'Error validando wallet' });
    }
    if (pin && normalizePinnedWalletRole(pin.role) === 'internal') {
      return NextResponse.json(
        {
          success: false,
          error:
            'Esa wallet está fijada como interna (solo balance): puede mirarse, pero no quedar como wallet por defecto de Movimientos.',
        },
        { status: 409 },
      );
    }
  }

  const { error } = await admin
    .from('companies')
    .update({ default_wallet_id: next })
    .eq('id', auth.companyId);

  if (error) {
    return apiError('admin/wallet-preference', error, { status: 500, clientMessage: 'Error guardando wallet' });
  }

  // Audit best-effort.
  await admin.from('audit_logs').insert({
    company_id: auth.companyId,
    user_id: auth.userId,
    action: 'update',
    module: 'movimientos_wallet_preference',
    details: JSON.stringify({ wallet_id: next }),
  });

  return NextResponse.json({ success: true, wallet_id: next });
}
