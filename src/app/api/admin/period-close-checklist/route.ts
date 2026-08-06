// ---------------------------------------------------------------------------
// GET /api/admin/period-close-checklist?period_id=…
//
// Los pendientes que conviene mirar ANTES de cerrar un período (P1-4 del
// benchmark, auditoría 2026-08-06): hasta ahora /periodos cerraba a ciegas y
// el descuadre aparecía después, con el mes ya congelado.
//
// Son ADVERTENCIAS, no bloqueos: cerrar con pendientes es una decisión
// legítima (p. ej. una orden aprobada que se paga el mes que viene). El
// checklist existe para que sea una decisión informada, no un descuido.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

export interface ChecklistItem {
  key: string;
  label: string;
  count: number;
  detail: string | null;
}

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES });
  if (auth instanceof NextResponse) return auth;

  const periodId = request.nextUrl.searchParams.get('period_id');
  if (!periodId) {
    return NextResponse.json({ success: false, error: 'period_id requerido' }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: period, error: perErr } = await admin
    .from('periods')
    .select('id, company_id, year, month, label')
    .eq('id', periodId)
    .eq('company_id', auth.companyId)
    .maybeSingle();
  if (perErr) return apiError('period-close-checklist', perErr, { status: 500 });
  if (!period) {
    return NextResponse.json({ success: false, error: 'Período no encontrado' }, { status: 404 });
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const monthStart = `${period.year}-${pad(period.month)}-01`;
  const monthEnd = `${period.year}-${pad(period.month)}-${pad(new Date(period.year, period.month, 0).getDate())}`;

  const [expNoProof, liqPending, opsApproved, invMixed] = await Promise.all([
    // Egresos del período sin referencia NI comprobante — lo primero que
    // pide cualquier contador al revisar el mes.
    admin.from('expenses')
      .select('id, concept', { count: 'exact' })
      .eq('company_id', auth.companyId)
      .eq('period_id', periodId)
      .is('reference', null)
      .is('attachment_path', null)
      .limit(5),
    // Movimientos de liquidez del mes calendario sin cuenta MT atribuida.
    admin.from('liquidity_movements')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', auth.companyId)
      .is('account_id', null)
      .gte('date', monthStart)
      .lte('date', monthEnd),
    // Órdenes aprobadas sin pagar (globales — el compromiso no entiende de
    // meses, pero cerrar sin saberlo es cerrar a ciegas).
    admin.from('payment_orders')
      .select('order_number, beneficiary_name, total', { count: 'exact' })
      .eq('company_id', auth.companyId)
      .eq('status', 'approved')
      .limit(5),
    // Inversiones `mixed` del mes: ganancia y retiro en la misma fila,
    // pendientes de separar (migración 062).
    admin.from('investments')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', auth.companyId)
      .eq('movement_type', 'mixed')
      .gte('date', monthStart)
      .lte('date', monthEnd),
  ]);

  const items: ChecklistItem[] = [
    {
      key: 'expenses_no_proof',
      label: 'Egresos sin referencia ni comprobante',
      count: expNoProof.count ?? 0,
      detail: (expNoProof.data ?? []).map((e) => (e as { concept: string }).concept).join(' · ') || null,
    },
    {
      key: 'liquidity_unreconciled',
      label: 'Movimientos de liquidez sin cuenta MT',
      count: liqPending.count ?? 0,
      detail: null,
    },
    {
      key: 'orders_approved_unpaid',
      label: 'Órdenes aprobadas sin pagar',
      count: opsApproved.count ?? 0,
      detail: (opsApproved.data ?? [])
        .map((o) => `${(o as { order_number: string }).order_number} $${Number((o as { total: number }).total).toLocaleString()}`)
        .join(' · ') || null,
    },
    {
      key: 'investments_mixed',
      label: 'Inversiones mixtas sin separar',
      count: invMixed.count ?? 0,
      detail: null,
    },
  ];

  return NextResponse.json({
    success: true,
    period: { id: period.id, label: period.label },
    items,
    clean: items.every((i) => i.count === 0),
  });
}
