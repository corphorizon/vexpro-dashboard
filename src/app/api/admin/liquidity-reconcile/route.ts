// ---------------------------------------------------------------------------
// /api/admin/liquidity-reconcile — conciliación de movimientos de liquidez.
//
// GET  → cuentas MT + movimientos pendientes (sin cuenta o con varias juntas).
// POST { action:'assign', id, account_id }         → atribuye a una cuenta.
// POST { action:'split',  id, parts:[…] }          → parte en una fila por cuenta.
// POST { action:'create_account', mt_number, label }
//
// POR QUÉ HACE FALTA ESTO
// `mt_account` era texto libre y terminó guardando listas ("141103, 142156,
// 141661, …"), y 19 de 35 movimientos no tenían ninguna cuenta. Con eso no se
// puede conciliar contra los extractos de MT. La migración 062 creó el
// catálogo y ató lo que se podía atar solo; el resto necesita que una persona
// diga cuánto va a cada cuenta — ese dato no existe en ningún lado.
//
// EL SPLIT NO PUEDE PERDER NI INVENTAR PLATA: la suma de las partes tiene que
// dar exactamente el importe original. Se valida server-side y se hace dentro
// de una transacción vía RPC, porque son un DELETE y varios INSERT.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';

/** Tolerancia de centavo: los importes vienen de inputs decimales. */
const CENT = 0.01;

async function guard(request: NextRequest) {
  const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['liquidity'] });
  if (auth instanceof NextResponse) return auth;
  if (auth.role === 'hr') {
    return NextResponse.json(
      { success: false, error: 'Permiso insuficiente para conciliar liquidez' },
      { status: 403 },
    );
  }
  return auth;
}

export async function GET(request: NextRequest) {
  const auth = await guard(request);
  if (auth instanceof NextResponse) return auth;

  const admin = createAdminClient();

  const [accountsRes, pendingRes, assignedRes] = await Promise.all([
    admin.from('liquidity_accounts')
      .select('id, mt_number, label, is_active')
      .eq('company_id', auth.companyId)
      .order('mt_number'),
    admin.from('liquidity_movements')
      .select('id, date, mt_account, deposit, withdrawal, notes, needs_split, account_id')
      .eq('company_id', auth.companyId)
      .is('account_id', null)
      .order('date', { ascending: false }),
    // Resumen por cuenta de lo YA conciliado: sirve para ver el avance.
    admin.from('liquidity_movements')
      .select('account_id, deposit, withdrawal')
      .eq('company_id', auth.companyId)
      .not('account_id', 'is', null),
  ]);

  if (accountsRes.error) return apiError('liquidity-reconcile', accountsRes.error, { status: 500 });
  if (pendingRes.error) return apiError('liquidity-reconcile', pendingRes.error, { status: 500 });

  const byAccount: Record<string, number> = {};
  for (const r of (assignedRes.data ?? []) as Array<{ account_id: string; deposit: number; withdrawal: number }>) {
    byAccount[r.account_id] = (byAccount[r.account_id] ?? 0)
      + (Number(r.deposit) || 0) - (Number(r.withdrawal) || 0);
  }

  return NextResponse.json({
    success: true,
    accounts: accountsRes.data ?? [],
    pending: pendingRes.data ?? [],
    balancesByAccount: byAccount,
  });
}

export async function POST(request: NextRequest) {
  const auth = await guard(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({}));
  const action = (body as { action?: string }).action;
  const admin = createAdminClient();

  // ── Alta de cuenta ─────────────────────────────────────────────────────
  if (action === 'create_account') {
    const { mt_number, label } = body as { mt_number?: string; label?: string };
    const num = (mt_number ?? '').trim();
    if (!num) {
      return NextResponse.json({ success: false, error: 'El número de cuenta es requerido' }, { status: 400 });
    }
    const { data, error } = await admin.from('liquidity_accounts')
      .insert({ company_id: auth.companyId, mt_number: num, label: (label ?? '').trim() || null })
      .select('id, mt_number, label, is_active')
      .single();
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ success: false, error: `La cuenta ${num} ya existe` }, { status: 409 });
      }
      return apiError('liquidity-reconcile', error, { status: 500 });
    }
    await serverAuditLog(admin, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'create',
      module: 'liquidity',
      details: `Cuenta de liquidez ${num} creada${data?.label ? ` (${data.label})` : ''}`,
    });
    return NextResponse.json({ success: true, account: data });
  }

  const id = (body as { id?: string }).id;
  if (!id) {
    return NextResponse.json({ success: false, error: 'Falta el movimiento' }, { status: 400 });
  }

  // Se relee el movimiento con scope de empresa: el admin client saltea RLS,
  // así que confiar en el id del body permitiría tocar otro tenant.
  const { data: mov, error: readErr } = await admin
    .from('liquidity_movements')
    .select('id, company_id, date, mt_account, deposit, withdrawal, notes, user_email')
    .eq('id', id)
    .maybeSingle();
  if (readErr) return apiError('liquidity-reconcile', readErr, { status: 500 });
  if (!mov || mov.company_id !== auth.companyId) {
    return NextResponse.json({ success: false, error: 'Movimiento no encontrado' }, { status: 404 });
  }

  /** Valida que la cuenta exista y sea de esta empresa. */
  const accountBelongs = async (accountId: string) => {
    const { data } = await admin.from('liquidity_accounts')
      .select('id, mt_number').eq('id', accountId).eq('company_id', auth.companyId).maybeSingle();
    return data;
  };

  // ── Atribuir a una sola cuenta ─────────────────────────────────────────
  if (action === 'assign') {
    const { account_id } = body as { account_id?: string };
    if (!account_id) {
      return NextResponse.json({ success: false, error: 'Elegí una cuenta' }, { status: 400 });
    }
    const acc = await accountBelongs(account_id);
    if (!acc) {
      return NextResponse.json({ success: false, error: 'Cuenta no encontrada' }, { status: 404 });
    }

    const { error } = await admin.from('liquidity_movements')
      .update({ account_id, needs_split: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('company_id', auth.companyId);
    if (error) return apiError('liquidity-reconcile', error, { status: 500 });

    await serverAuditLog(admin, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'update',
      module: 'liquidity',
      details: `Movimiento del ${mov.date} atribuido a la cuenta ${acc.mt_number}`,
    });
    return NextResponse.json({ success: true });
  }

  // ── Partir en una fila por cuenta ──────────────────────────────────────
  if (action === 'split') {
    const { parts } = body as {
      parts?: Array<{ account_id: string; deposit: number; withdrawal: number }>;
    };
    if (!Array.isArray(parts) || parts.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Un movimiento se parte en dos o más cuentas' },
        { status: 400 },
      );
    }

    const origDep = Number(mov.deposit) || 0;
    const origWit = Number(mov.withdrawal) || 0;
    let sumDep = 0, sumWit = 0;

    for (const part of parts) {
      const acc = await accountBelongs(part.account_id);
      if (!acc) {
        return NextResponse.json({ success: false, error: 'Hay una cuenta que no existe' }, { status: 400 });
      }
      const d = Number(part.deposit) || 0;
      const w = Number(part.withdrawal) || 0;
      if (d < 0 || w < 0) {
        return NextResponse.json({ success: false, error: 'Los importes no pueden ser negativos' }, { status: 400 });
      }
      sumDep += d;
      sumWit += w;
    }

    // La suma DEBE dar el original: partir no puede crear ni perder plata.
    if (Math.abs(sumDep - origDep) > CENT || Math.abs(sumWit - origWit) > CENT) {
      return NextResponse.json(
        {
          success: false,
          error:
            `Las partes no cuadran con el movimiento original. ` +
            `Depósitos: ${sumDep.toFixed(2)} vs ${origDep.toFixed(2)}. ` +
            `Retiros: ${sumWit.toFixed(2)} vs ${origWit.toFixed(2)}.`,
        },
        { status: 400 },
      );
    }

    const { error } = await admin.rpc('split_liquidity_movement', {
      p_company_id: auth.companyId,
      p_movement_id: id,
      p_parts: parts,
    });
    if (error) return apiError('liquidity-reconcile', error, { status: 500 });

    await serverAuditLog(admin, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'update',
      module: 'liquidity',
      details: `Movimiento del ${mov.date} dividido en ${parts.length} cuentas`,
    });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Acción no válida' }, { status: 400 });
}
