// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/wallet-preference
//
// POST { walletId: string | null }
//   → Persist the active company's preferred Coinsbuy wallet id (or clear
//     it for "Todas las wallets" mode by passing null/empty). Stored on
//     companies.default_wallet_id (added in migration 031). Used by the
//     /movimientos banner so the wallet filter survives reloads.
//
// Auth: verifyAdminAuth (admin / auditor / hr OR superadmin viewing-as).
// Service-role write so RLS doesn't get in the way of platform_users
// updating tenant rows.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(request: NextRequest) {
  const auth = await verifyAdminAuth(request);
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
  const { error } = await admin
    .from('companies')
    .update({ default_wallet_id: next })
    .eq('id', auth.companyId);

  if (error) {
    return NextResponse.json(
      { success: false, error: `Error guardando wallet: ${error.message}` },
      { status: 500 },
    );
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
