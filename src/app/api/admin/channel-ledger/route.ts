// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/channel-ledger
//
// GET  ?channel_key=&from=&to=   → asientos del libro de un canal.
// POST { action: 'create' | 'update' | 'delete', ... }
//
// Los canales por API (coinsbuy / unipayment) son SOLO LECTURA acá: su libro
// lo escribe el cron de las 00:00 UTC contra el saldo real del proveedor, y
// un asiento a mano solo podría descuadrarlo. La regla vive en
// channel-ledger.ts (validateEntry) para que la UI y el endpoint no puedan
// discrepar, y se revalida server-side en cada escritura.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth, verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import {
  validateEntry,
  isAutoLedger,
  hasLedger,
  type LedgerEntryInput,
} from '@/lib/channel-ledger';

const SELECT_COLS =
  'id, company_id, channel_key, entry_date, kind, source, concept, category, reference, amount, notes, created_by, created_at, updated_at';

/**
 * Escrituras: mismo criterio que `canAdd` en el cliente (admin o auditor).
 * `hr` pasa el gate genérico de verifyAdminAuth pero no tiene nada que hacer
 * en tesorería, así que se rechaza explícitamente.
 */
async function verifyWriteAccess(request: NextRequest) {
  const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES });
  if (auth instanceof NextResponse) return auth;
  if (auth.role === 'hr') {
    return NextResponse.json(
      { success: false, error: 'Permiso insuficiente para modificar balances' },
      { status: 403 },
    );
  }
  return auth;
}

export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request);
  if (auth instanceof NextResponse) return auth;

  const params = request.nextUrl.searchParams;
  const channelKey = params.get('channel_key');
  const from = params.get('from');
  const to = params.get('to');

  const admin = createAdminClient();
  let query = admin
    .from('channel_ledger_entries')
    .select(SELECT_COLS)
    .eq('company_id', auth.companyId);

  if (channelKey) query = query.eq('channel_key', channelKey);
  if (from) query = query.gte('entry_date', from);
  if (to) query = query.lte('entry_date', to);

  // El saldo inicial queda FUERA del filtro `from`: sin él, el saldo corrido
  // del rango arrancaría en cero y todas las filas mostrarían un saldo que
  // no es el del canal. Se trae aparte y se antepone.
  const { data, error } = await query
    .order('entry_date', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(5000);

  if (error) return apiError('admin/channel-ledger', error, { status: 500 });

  let opening: unknown[] = [];
  if (from && channelKey) {
    const { data: op } = await admin
      .from('channel_ledger_entries')
      .select(SELECT_COLS)
      .eq('company_id', auth.companyId)
      .eq('channel_key', channelKey)
      .lt('entry_date', from);
    opening = op ?? [];
  }

  return NextResponse.json({
    success: true,
    entries: data ?? [],
    // Asientos anteriores al rango, para que el front calcule el saldo de
    // arranque sin tener que traerse el libro entero.
    priorEntries: opening,
  });
}

export async function POST(request: NextRequest) {
  const auth = await verifyWriteAccess(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({}));
  const action = (body as { action?: string }).action;
  const admin = createAdminClient();

  // ── Alta ───────────────────────────────────────────────────────────────
  if (action === 'create') {
    const input = body as Partial<LedgerEntryInput>;
    const invalid = validateEntry(input);
    if (invalid) {
      return NextResponse.json({ success: false, error: invalid }, { status: 400 });
    }

    const { data, error } = await admin
      .from('channel_ledger_entries')
      .insert({
        company_id: auth.companyId,
        channel_key: input.channel_key,
        entry_date: input.entry_date,
        kind: input.kind,
        source: 'manual',
        concept: input.concept!.trim(),
        category: input.category?.trim() || null,
        reference: input.reference?.trim() || null,
        amount: input.amount,
        notes: input.notes?.trim() || null,
        created_by: auth.userId,
      })
      .select(SELECT_COLS)
      .single();

    if (error) {
      // Índice único parcial: ya hay un saldo inicial para este canal.
      if (error.code === '23505') {
        return NextResponse.json(
          { success: false, error: 'Este canal ya tiene un saldo inicial — editá el existente' },
          { status: 409 },
        );
      }
      return apiError('admin/channel-ledger', error, { status: 500 });
    }

    await admin.from('audit_logs').insert({
      company_id: auth.companyId,
      user_id: auth.userId,
      action: 'create',
      module: 'channel_ledger',
      details: JSON.stringify({
        channel_key: input.channel_key,
        entry_date: input.entry_date,
        kind: input.kind,
        amount: input.amount,
        concept: input.concept,
      }),
    });

    return NextResponse.json({ success: true, entry: data });
  }

  // ── Edición y baja ─────────────────────────────────────────────────────
  // Las dos empiezan igual: hay que releer el asiento para confirmar que es
  // de esta empresa y que no lo escribió el cron. Confiar en el id del body
  // permitiría tocar el libro de otro tenant.
  const id = (body as { id?: string }).id;
  if (action === 'update' || action === 'delete') {
    if (!id) {
      return NextResponse.json({ success: false, error: 'Falta el id del asiento' }, { status: 400 });
    }

    const { data: existing, error: readError } = await admin
      .from('channel_ledger_entries')
      .select('id, company_id, channel_key, source, kind')
      .eq('id', id)
      .maybeSingle();

    if (readError) return apiError('admin/channel-ledger', readError, { status: 500 });
    if (!existing || existing.company_id !== auth.companyId) {
      return NextResponse.json({ success: false, error: 'Asiento no encontrado' }, { status: 404 });
    }
    if (existing.source === 'api' || isAutoLedger(existing.channel_key)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Este asiento lo genera la sincronización automática y no se edita a mano',
        },
        { status: 403 },
      );
    }
    if (!hasLedger(existing.channel_key)) {
      return NextResponse.json(
        { success: false, error: 'Este canal no lleva libro' },
        { status: 400 },
      );
    }

    if (action === 'delete') {
      const { error } = await admin.from('channel_ledger_entries').delete().eq('id', id);
      if (error) return apiError('admin/channel-ledger', error, { status: 500 });

      await admin.from('audit_logs').insert({
        company_id: auth.companyId,
        user_id: auth.userId,
        action: 'delete',
        module: 'channel_ledger',
        details: JSON.stringify({ id, channel_key: existing.channel_key }),
      });
      return NextResponse.json({ success: true });
    }

    const input = body as Partial<LedgerEntryInput>;
    // El saldo inicial conserva su `kind`: cambiarlo a 'out' lo volvería un
    // egreso y dejaría al canal sin punto de partida.
    const kind = existing.kind === 'opening' ? 'opening' : input.kind;
    const invalid = validateEntry({ ...input, kind, channel_key: existing.channel_key });
    if (invalid) {
      return NextResponse.json({ success: false, error: invalid }, { status: 400 });
    }

    const { data, error } = await admin
      .from('channel_ledger_entries')
      .update({
        entry_date: input.entry_date,
        kind,
        concept: input.concept!.trim(),
        category: input.category?.trim() || null,
        reference: input.reference?.trim() || null,
        amount: input.amount,
        notes: input.notes?.trim() || null,
      })
      .eq('id', id)
      .select(SELECT_COLS)
      .single();

    if (error) return apiError('admin/channel-ledger', error, { status: 500 });

    await admin.from('audit_logs').insert({
      company_id: auth.companyId,
      user_id: auth.userId,
      action: 'update',
      module: 'channel_ledger',
      details: JSON.stringify({ id, channel_key: existing.channel_key, amount: input.amount }),
    });

    return NextResponse.json({ success: true, entry: data });
  }

  return NextResponse.json({ success: false, error: 'Acción no válida' }, { status: 400 });
}
