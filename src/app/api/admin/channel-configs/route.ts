// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/channel-configs
//
// GET                               → list all channel_configs rows for the
//                                     caller's company (admins see their own
//                                     company; superadmin can pass ?company_id=…).
// POST { action:'upsert', ... }     → create or update one channel_config.
// POST { action:'delete', key }     → delete a custom channel (is_custom=true).
//                                     Built-ins can't be deleted.
// POST { action:'create_custom',
//        label, initialBalance? }   → append a new custom channel.
//
// All writes are admin-gated and include an audit_logs insert.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  newCustomChannelKey,
  BUILTIN_CHANNELS,
  type ChannelType,
} from '@/lib/channel-configs';

const BUILTIN_KEYS = new Set(BUILTIN_CHANNELS.map((c) => c.key));

async function resolveCompanyAndAuth(
  explicitCompanyId: string | null,
): Promise<{ companyId: string; userId: string } | NextResponse> {
  if (explicitCompanyId) {
    const sa = await verifySuperadminAuth();
    if (sa instanceof NextResponse) return sa;
    return { companyId: explicitCompanyId, userId: sa.userId };
  }
  const auth = await verifyAdminAuth();
  if (auth instanceof NextResponse) return auth;
  if (auth.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Solo administradores pueden configurar canales' },
      { status: 403 },
    );
  }
  return { companyId: auth.companyId, userId: auth.userId };
}

export async function GET(request: NextRequest) {
  const explicit = request.nextUrl.searchParams.get('company_id');
  const ctx = await resolveCompanyAndAuth(explicit);
  if (ctx instanceof NextResponse) return ctx;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('channel_configs')
    .select('id, channel_key, custom_label, channel_type, is_visible, is_custom, sort_order')
    .eq('company_id', ctx.companyId)
    .order('sort_order', { ascending: true });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, rows: data ?? [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const explicit =
    request.nextUrl.searchParams.get('company_id') ||
    (body as { company_id?: string }).company_id ||
    null;
  const ctx = await resolveCompanyAndAuth(explicit);
  if (ctx instanceof NextResponse) return ctx;

  const admin = createAdminClient();
  const action = (body as { action?: string }).action;

  if (action === 'upsert') {
    const {
      channel_key,
      custom_label,
      is_visible,
      sort_order,
    } = body as {
      channel_key?: string;
      custom_label?: string | null;
      is_visible?: boolean;
      sort_order?: number;
    };
    if (!channel_key || typeof channel_key !== 'string') {
      return NextResponse.json({ success: false, error: 'channel_key requerido' }, { status: 400 });
    }
    const isBuiltin = BUILTIN_KEYS.has(channel_key);
    // For built-ins we lock channel_type to the hardcoded value and don't
    // allow renaming API-sourced channels (coinsbuy / unipayment) because
    // their label comes from the provider itself.
    const builtin = BUILTIN_CHANNELS.find((c) => c.key === channel_key);
    const apiChannel = builtin && builtin.type === 'auto' && ['coinsbuy', 'unipayment'].includes(channel_key);

    const payload: Record<string, unknown> = {
      company_id: ctx.companyId,
      channel_key,
      is_visible: typeof is_visible === 'boolean' ? is_visible : true,
      updated_at: new Date().toISOString(),
    };
    if (!apiChannel) {
      payload.custom_label = typeof custom_label === 'string' ? custom_label.trim() || null : null;
    }
    if (typeof sort_order === 'number') payload.sort_order = sort_order;
    if (isBuiltin) {
      payload.channel_type = builtin!.type;
      payload.is_custom = false;
    }

    const { error } = await admin
      .from('channel_configs')
      .upsert(payload, { onConflict: 'company_id,channel_key' });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    await admin.from('audit_logs').insert({
      company_id: ctx.companyId,
      user_id: ctx.userId,
      action: 'update',
      module: 'balances_channel_config',
      details: JSON.stringify({ channel_key, is_visible, custom_label }),
    });
    return NextResponse.json({ success: true });
  }

  if (action === 'create_custom') {
    const { label, initial_balance, as_of } = body as {
      label?: string;
      initial_balance?: number;
      as_of?: string;
    };
    const clean = (label ?? '').trim();
    if (!clean) {
      return NextResponse.json({ success: false, error: 'El nombre del canal es requerido' }, { status: 400 });
    }
    const channel_key = newCustomChannelKey();
    const channel_type: ChannelType = 'manual';

    const { error } = await admin.from('channel_configs').insert({
      company_id: ctx.companyId,
      channel_key,
      custom_label: clean,
      channel_type,
      is_visible: true,
      is_custom: true,
      sort_order: 200,
    });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    // Optional initial balance snapshot.
    const todayISO = () => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    if (typeof initial_balance === 'number' && initial_balance !== 0) {
      await admin.from('channel_balances').upsert(
        {
          company_id: ctx.companyId,
          snapshot_date: as_of && /^\d{4}-\d{2}-\d{2}$/.test(as_of) ? as_of : todayISO(),
          channel_key,
          amount: initial_balance,
          source: 'manual',
        },
        { onConflict: 'company_id,snapshot_date,channel_key' },
      );
    }

    await admin.from('audit_logs').insert({
      company_id: ctx.companyId,
      user_id: ctx.userId,
      action: 'create',
      module: 'balances_channel_config',
      details: JSON.stringify({ channel_key, label: clean, initial_balance }),
    });
    return NextResponse.json({ success: true, channel_key });
  }

  if (action === 'delete') {
    const { channel_key } = body as { channel_key?: string };
    if (!channel_key) {
      return NextResponse.json({ success: false, error: 'channel_key requerido' }, { status: 400 });
    }
    if (BUILTIN_KEYS.has(channel_key)) {
      return NextResponse.json(
        { success: false, error: 'Los canales predefinidos no se pueden eliminar — ocúltalos con el toggle' },
        { status: 400 },
      );
    }
    const { error } = await admin
      .from('channel_configs')
      .delete()
      .eq('company_id', ctx.companyId)
      .eq('channel_key', channel_key)
      .eq('is_custom', true);
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    // Also clean up any stored balances for this key so they don't linger.
    await admin
      .from('channel_balances')
      .delete()
      .eq('company_id', ctx.companyId)
      .eq('channel_key', channel_key);

    await admin.from('audit_logs').insert({
      company_id: ctx.companyId,
      user_id: ctx.userId,
      action: 'delete',
      module: 'balances_channel_config',
      details: JSON.stringify({ channel_key }),
    });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Acción no válida' }, { status: 400 });
}
