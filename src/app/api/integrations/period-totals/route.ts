import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// GET /api/integrations/period-totals
//
// Returns API deposit and withdrawal totals grouped by calendar month, read
// from the persisted api_transactions table. Used by /balances to populate
// the running "Balance Actual Disponible" for derived-broker periods
// (April 2026+), where real numbers live in api_transactions instead of
// the manual `deposits` / `withdrawals` tables.
//
// Response shape:
//   {
//     success: true,
//     months: {
//       '2026-04': { deposits: 12345.67, withdrawals: 2345.67 },
//       '2026-03': { ... },
//       ...
//     }
//   }
// ---------------------------------------------------------------------------

const ACCEPTED_STATUS: Record<string, string[]> = {
  'coinsbuy-deposits': ['Confirmed'],
  'coinsbuy-withdrawals': ['Approved'],
  fairpay: ['Completed'],
  unipayment: ['Completed'],
};

export async function GET(request: Request) {
  try {
    const auth = await verifyAuth();
    if (auth instanceof NextResponse) return auth;

    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    const admin = createAdminClient();
    let query = admin
      .from('api_transactions')
      .select('provider, amount, status, transaction_date')
      .eq('company_id', auth.companyId);

    if (from) query = query.gte('transaction_date', `${from}T00:00:00.000Z`);
    if (to) query = query.lte('transaction_date', `${to}T23:59:59.999Z`);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json(
        { success: false, error: error.message, months: {} },
        { status: 500 },
      );
    }

    const months: Record<string, { deposits: number; withdrawals: number }> = {};
    for (const row of data ?? []) {
      const accepted = ACCEPTED_STATUS[row.provider];
      if (!accepted) continue;
      if (row.status && !accepted.includes(row.status)) continue;

      // Bucket by YYYY-MM of transaction_date (UTC).
      const key = String(row.transaction_date).slice(0, 7);
      if (!months[key]) months[key] = { deposits: 0, withdrawals: 0 };

      const amount = Number(row.amount) || 0;
      if (row.provider === 'coinsbuy-withdrawals') {
        months[key].withdrawals += amount;
      } else {
        months[key].deposits += amount;
      }
    }

    return NextResponse.json({ success: true, months });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[period-totals] Unhandled error:', message);
    return NextResponse.json(
      { success: false, error: message, months: {} },
      { status: 500 },
    );
  }
}
