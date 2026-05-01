// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/channel-balances
//
// POST { channel_key, snapshot_date, amount, source? }
//   → Upsert one row of channel_balances. Service-role write so the call
//     bypasses RLS — auth is enforced at the route layer via
//     `verifyAdminAuth(request)` (admin / auditor / hr OR superadmin
//     viewing-as via ?company_id=). Audited.
//
// Why an explicit endpoint instead of the previous browser-side
// `upsertChannelBalance` mutation:
//   1. Browser writes lacked a deterministic timeout — a stalled Supabase
//      request left the UI "loading forever" with no surface error.
//   2. Browser writes inherit the user's auth.uid() so they couldn't be
//      shared with the cron path. The service-role write here is the same
//      path the daily 00:00 UTC snapshot already uses.
//   3. Tenant scoping for "viewing as" superadmins is a single helper
//      (`verifyAdminAuth(request)`) instead of trusting RLS through the
//      browser client.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

type Body = {
  channel_key?: string;
  snapshot_date?: string;
  amount?: number;
  source?: 'manual' | 'api' | 'derived';
};

// YYYY-MM-DD — same shape the channel_balances.snapshot_date column uses.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: NextRequest) {
  const auth = await verifyAdminAuth(request);
  if (auth instanceof NextResponse) return auth;

  // Only admin/auditor are allowed to write balances. HR roles can hit other
  // /api/admin/* routes but should not edit financial snapshots.
  if (auth.role !== 'admin' && auth.role !== 'auditor') {
    return NextResponse.json(
      { success: false, error: 'Permiso insuficiente — se requiere rol admin o auditor' },
      { status: 403 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ success: false, error: 'Body JSON inválido' }, { status: 400 });
  }

  const { channel_key, snapshot_date, amount, source } = body;

  if (!channel_key || typeof channel_key !== 'string') {
    return NextResponse.json({ success: false, error: 'channel_key requerido' }, { status: 400 });
  }
  if (!snapshot_date || !ISO_DATE_RE.test(snapshot_date)) {
    return NextResponse.json(
      { success: false, error: 'snapshot_date debe tener formato YYYY-MM-DD' },
      { status: 400 },
    );
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return NextResponse.json(
      { success: false, error: 'amount debe ser un número finito' },
      { status: 400 },
    );
  }
  const safeSource: 'manual' | 'api' | 'derived' =
    source === 'api' || source === 'derived' ? source : 'manual';

  const admin = createAdminClient();

  // Upsert by the (company_id, snapshot_date, channel_key) natural key. The
  // table has a unique constraint backing this — if it ever drifts the call
  // surfaces the constraint name in the error so it's debuggable.
  const { error } = await admin
    .from('channel_balances')
    .upsert(
      {
        company_id: auth.companyId,
        snapshot_date,
        channel_key,
        amount,
        source: safeSource,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,snapshot_date,channel_key' },
    );

  if (error) {
    return NextResponse.json(
      { success: false, error: `Error guardando balance: ${error.message}` },
      { status: 500 },
    );
  }

  // Audit. Best-effort — don't fail the response if audit insert errors.
  await admin.from('audit_logs').insert({
    company_id: auth.companyId,
    user_id: auth.userId,
    action: 'update',
    module: 'balances_channel_balance',
    details: JSON.stringify({ channel_key, snapshot_date, amount, source: safeSource }),
  });

  return NextResponse.json({ success: true });
}
