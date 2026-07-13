import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

// ---------------------------------------------------------------------------
// POST /api/admin/data — dispatcher server-side de escrituras de datos.
//
// Por qué (2026-07-13): escribir desde el browser con el cliente supabase-js se
// cuelga de forma recurrente — supabase-js intenta refrescar el token de auth
// antes de cada request y ese refresh se estanca (navigator.locks/red), aunque
// la DB responde en ms. Moviendo TODAS las escrituras acá, el browser hace un
// fetch simple con su cookie de sesión (sin refresh-token dance) y el server
// corre la operación con el admin client. Elimina la clase entera de cuelgues.
//
// Seguridad: verifyAdminAuth resuelve company_id desde el JWT (nunca del body).
// El admin client bypassa RLS, así que TODA operación por id filtra además por
// company_id para prevenir IDOR cross-tenant. Los inserts fuerzan company_id
// del token. Las RPC replace_period_* tienen bypass de service_role.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;
    const companyId = auth.companyId;
    const admin = createAdminClient();

    const body = await request.json();
    const op = body?.op as string;

    // Helper: devuelve error 500 con el detalle logueado si `error` existe.
    const fail = (error: unknown, ctx: string) => apiError(`admin/data:${ctx}`, error, { status: 500 });

    switch (op) {
      // ── Period-scoped replaces (RPC atómica) ──
      case 'deposits': {
        const { error } = await admin.rpc('replace_period_deposits', {
          p_company_id: companyId, p_period_id: body.periodId, p_rows: body.rows ?? [],
        });
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'withdrawals': {
        const { error } = await admin.rpc('replace_period_withdrawals', {
          p_company_id: companyId, p_period_id: body.periodId, p_rows: body.rows ?? [],
        });
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Single-row-per-period upserts ──
      case 'operating_income': {
        const { error } = await admin.from('operating_income').upsert(
          { company_id: companyId, period_id: body.periodId, prop_firm: body.income.prop_firm, broker_pnl: body.income.broker_pnl, other: body.income.other },
          { onConflict: 'company_id,period_id' },
        );
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'prop_firm_sales': {
        const { error } = await admin.from('prop_firm_sales').upsert(
          { company_id: companyId, period_id: body.periodId, amount: body.amount },
          { onConflict: 'company_id,period_id' },
        );
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'p2p_transfers': {
        const { error } = await admin.from('p2p_transfers').upsert(
          { company_id: companyId, period_id: body.periodId, amount: body.amount },
          { onConflict: 'company_id,period_id' },
        );
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'channel_balance': {
        const { error } = await admin.from('channel_balances').upsert(
          { company_id: companyId, snapshot_date: body.snapshotDate, channel_key: body.channelKey, amount: body.amount, source: body.source ?? 'manual' },
          { onConflict: 'company_id,snapshot_date,channel_key' },
        );
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Liquidity movements ──
      case 'liquidity_insert': {
        const { data, error } = await admin.from('liquidity_movements')
          .insert({ company_id: companyId, ...body.movement }).select('id').single();
        if (error) return fail(error, op);
        return NextResponse.json({ success: true, id: data.id });
      }
      case 'liquidity_update': {
        const { data, error } = await admin.from('liquidity_movements')
          .update(body.updates).eq('id', body.id).eq('company_id', companyId).select('id');
        if (error) return fail(error, op);
        if (!data?.length) return NextResponse.json({ error: 'No se actualizó ninguna fila' }, { status: 404 });
        return NextResponse.json({ success: true });
      }
      case 'liquidity_delete': {
        const { error } = await admin.from('liquidity_movements').delete().eq('id', body.id).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Investments ──
      case 'investment_insert': {
        const { data, error } = await admin.from('investments')
          .insert({ company_id: companyId, ...body.investment }).select('id').single();
        if (error) return fail(error, op);
        return NextResponse.json({ success: true, id: data.id });
      }
      case 'investment_update': {
        const { data, error } = await admin.from('investments')
          .update(body.updates).eq('id', body.id).eq('company_id', companyId).select('id');
        if (error) return fail(error, op);
        if (!data?.length) return NextResponse.json({ error: 'No se actualizó ninguna fila' }, { status: 404 });
        return NextResponse.json({ success: true });
      }
      case 'investment_delete': {
        const { error } = await admin.from('investments').delete().eq('id', body.id).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Partners ──
      case 'partner_create': {
        const { data, error } = await admin.from('partners')
          .insert({ company_id: companyId, name: body.name, email: body.email, percentage: body.percentage }).select('id').single();
        if (error) return fail(error, op);
        return NextResponse.json({ success: true, id: data.id });
      }
      case 'partner_update': {
        const { data, error } = await admin.from('partners')
          .update(body.updates).eq('id', body.id).eq('company_id', companyId).select('id');
        if (error) return fail(error, op);
        if (!data?.length) return NextResponse.json({ error: 'No se actualizó ninguna fila' }, { status: 404 });
        return NextResponse.json({ success: true });
      }
      case 'partner_delete': {
        // Borrar distribuciones del socio primero (scoped a la empresa).
        const { error: distErr } = await admin.from('partner_distributions').delete().eq('partner_id', body.id).eq('company_id', companyId);
        if (distErr) return fail(distErr, op);
        const { error } = await admin.from('partners').delete().eq('id', body.id).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Periods ──
      case 'period_status': {
        const { error } = await admin.from('periods').update({ is_closed: body.isClosed }).eq('id', body.periodId).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'period_reserve': {
        const { error } = await admin.from('periods').update({ reserve_pct: body.reservePct }).eq('id', body.periodId).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'period_reserve_all': {
        const { error } = await admin.from('periods').update({ reserve_pct: body.reservePct }).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Pinned Coinsbuy wallets ──
      case 'pin_wallet': {
        const { error } = await admin.from('pinned_coinsbuy_wallets')
          .insert({ company_id: companyId, wallet_id: body.walletId, wallet_label: body.walletLabel });
        if (error && error.code !== '23505') return fail(error, op); // 23505 = ya fijada
        return NextResponse.json({ success: true });
      }
      case 'unpin_wallet': {
        const { error } = await admin.from('pinned_coinsbuy_wallets').delete().eq('company_id', companyId).eq('wallet_id', body.walletId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      // ── Expense ordering + templates ──
      case 'expense_order': {
        const ids: string[] = body.ids ?? [];
        const results = await Promise.all(
          ids.map((id, i) => admin.from('expenses')
            .update({ sort_order: i + 1, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', companyId)),
        );
        const firstErr = results.find((r) => r.error)?.error;
        if (firstErr) return fail(firstErr, op);
        return NextResponse.json({ success: true });
      }
      case 'expense_template_set_active': {
        const { error } = await admin.from('expense_templates').update({ active: !!body.active }).eq('id', body.id).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }
      case 'expense_template_delete': {
        const { error } = await admin.from('expense_templates').delete().eq('id', body.id).eq('company_id', companyId);
        if (error) return fail(error, op);
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: `Operación desconocida: ${op}` }, { status: 400 });
    }
  } catch (err) {
    return apiError('admin/data', err, { status: 500 });
  }
}
