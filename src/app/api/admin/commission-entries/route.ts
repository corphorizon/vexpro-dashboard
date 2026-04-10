import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// POST — upsert commission entries { period_id, head_id, entries[] }
// Uses individual upserts to avoid accidentally deleting entries not in the batch

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;

    const { period_id, head_id, entries } = await request.json();
    if (!period_id || !head_id || !entries?.length) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    // Always use the caller's verified company — never trust body.company_id
    const company_id = auth.companyId;
    const admin = createAdminClient();

    for (const entry of entries) {
      const row = {
        company_id,
        period_id,
        head_id,
        profile_id: entry.profile_id,
        net_deposit_current: entry.net_deposit_current ?? 0,
        net_deposit_accumulated: entry.net_deposit_accumulated ?? 0,
        net_deposit_total: entry.net_deposit_current ?? 0,
        division: entry.division ?? 0,
        base_amount: entry.base_amount ?? 0,
        commissions_earned: entry.commissions_earned ?? 0,
        real_payment: entry.real_payment ?? 0,
        accumulated_out: entry.accumulated_out ?? 0,
        salary_paid: entry.salary_paid ?? 0,
        total_earned: entry.total_earned ?? 0,
        pnl_current: 0,
        pnl_accumulated: 0,
        pnl_total: 0,
        bonus: 0,
      };

      // Upsert: check if exists, then update or insert
      const { data: existing } = await admin
        .from('commercial_monthly_results')
        .select('id')
        .eq('profile_id', entry.profile_id)
        .eq('period_id', period_id)
        .eq('head_id', head_id)
        .maybeSingle();

      if (existing) {
        // If any field is null, preserve existing value from DB
        const hasFlags = [row.net_deposit_current, row.accumulated_out, row.net_deposit_accumulated, row.division, row.base_amount].some(v => v === null);
        if (hasFlags) {
          const { data: current } = await admin
            .from('commercial_monthly_results')
            .select('net_deposit_current, net_deposit_accumulated, accumulated_out, division, base_amount')
            .eq('id', existing.id)
            .single();
          if (row.net_deposit_current === null) row.net_deposit_current = current?.net_deposit_current ?? 0;
          if (row.net_deposit_total === null) row.net_deposit_total = row.net_deposit_current;
          if (row.net_deposit_accumulated === null) row.net_deposit_accumulated = current?.net_deposit_accumulated ?? 0;
          if (row.division === null) row.division = current?.division ?? 0;
          if (row.base_amount === null) row.base_amount = current?.base_amount ?? 0;
          if (row.accumulated_out === null) row.accumulated_out = current?.accumulated_out ?? 0;
        }
        const { error } = await admin
          .from('commercial_monthly_results')
          .update(row)
          .eq('id', existing.id);
        if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      } else {
        // For new inserts, replace null flags with 0
        if (row.net_deposit_current === null) row.net_deposit_current = 0;
        if (row.net_deposit_total === null) row.net_deposit_total = 0;
        if (row.net_deposit_accumulated === null) row.net_deposit_accumulated = 0;
        if (row.division === null) row.division = 0;
        if (row.base_amount === null) row.base_amount = 0;
        if (row.accumulated_out === null) row.accumulated_out = 0;
        const { error } = await admin
          .from('commercial_monthly_results')
          .insert(row);
        if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
