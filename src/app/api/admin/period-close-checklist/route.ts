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
import { features } from '@/lib/business-model';

export interface ChecklistItem {
  key: string;
  label: string;
  count: number;
  detail: string | null;
}

/** Consulta que el modelo de negocio no admite: cuenta 0 y no toca la base.
 *  Devolver la misma forma que PostgREST evita un `if` por ítem más abajo. */
const SKIPPED = Promise.resolve({ count: 0, data: [] as unknown[] });

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

  // El checklist tiene que hablar del negocio que cierra el mes. Una
  // consultora no tiene cuentas MT ni inversiones: esos dos ítems le daban
  // 0 SIEMPRE — ruido que enseña a cerrar sin leer — mientras que el único
  // que le importa (lo facturado y no cobrado) no estaba. Mismo registro
  // que el resto del dashboard: business-model.ts decide, no esta pantalla.
  const { data: companyRow } = await admin
    .from('companies')
    .select('business_model')
    .eq('id', auth.companyId)
    .maybeSingle();
  const f = features((companyRow as { business_model?: unknown } | null)?.business_model);

  // Un broker también factura servicios sueltos, pero su cierre pivota sobre
  // depósitos y liquidez: agregarle un ítem cambiaría la pantalla que su
  // equipo mira todos los meses. El ítem nuevo es para el modelo donde la
  // facturación ES el ingreso — ahí lo no cobrado no se reparte.
  const billingIsTheIncome = f.incomeLines && !f.deposits;

  const [expNoProof, liqPending, opsApproved, invMixed, incomePending] = await Promise.all([
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
    f.liquidity
      ? admin.from('liquidity_movements')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', auth.companyId)
          .is('account_id', null)
          .gte('date', monthStart)
          .lte('date', monthEnd)
      : SKIPPED,
    // Órdenes aprobadas sin pagar (globales — el compromiso no entiende de
    // meses, pero cerrar sin saberlo es cerrar a ciegas).
    admin.from('payment_orders')
      .select('order_number, beneficiary_name, total', { count: 'exact' })
      .eq('company_id', auth.companyId)
      .eq('status', 'approved')
      .limit(5),
    // Inversiones `mixed` del mes: ganancia y retiro en la misma fila,
    // pendientes de separar (migración 062).
    f.investments
      ? admin.from('investments')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', auth.companyId)
          .eq('movement_type', 'mixed')
          .gte('date', monthStart)
          .lte('date', monthEnd)
      : SKIPPED,
    // Líneas facturadas del período que siguen sin cobrarse. Para una
    // empresa de servicios ES el pendiente del cierre: lo que no se cobró no
    // entra en el saldo a favor y por lo tanto no se reparte — cerrar el mes
    // sin mirarlo es congelar una distribución con plata que todavía está
    // afuera. (Horizon cerraba agosto con 14.900 sin cobrar y nadie avisaba.)
    billingIsTheIncome
      ? admin.from('income_lines')
          .select('concept, client, pending', { count: 'exact' })
          .eq('company_id', auth.companyId)
          .eq('period_id', periodId)
          .gt('pending', 0)
          .order('pending', { ascending: false })
      : SKIPPED,
  ]);

  const pendingLines = (incomePending.data ?? []) as Array<{
    concept: string; client: string | null; pending: number | string;
  }>;
  const pendingTotal = pendingLines.reduce((s, l) => s + (Number(l.pending) || 0), 0);

  const items: ChecklistItem[] = [
    {
      key: 'expenses_no_proof',
      label: 'Egresos sin referencia ni comprobante',
      count: expNoProof.count ?? 0,
      detail: (expNoProof.data ?? []).map((e) => (e as { concept: string }).concept).join(' · ') || null,
    },
  ];

  if (billingIsTheIncome) {
    items.push({
      key: 'income_lines_uncollected',
      label: 'Facturado sin cobrar',
      count: incomePending.count ?? 0,
      detail:
        pendingLines.length > 0
          ? `Total $${pendingTotal.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} — ` +
            pendingLines
              .slice(0, 5)
              .map((l) => `${l.client?.trim() || 'sin cliente'}: $${(Number(l.pending) || 0).toLocaleString('es-AR')}`)
              .join(' · ')
          : null,
    });
  }

  if (f.liquidity) {
    items.push({
      key: 'liquidity_unreconciled',
      label: 'Movimientos de liquidez sin cuenta MT',
      count: liqPending.count ?? 0,
      detail: null,
    });
  }

  items.push({
    key: 'orders_approved_unpaid',
    label: 'Órdenes aprobadas sin pagar',
    count: opsApproved.count ?? 0,
    detail: (opsApproved.data ?? [])
      .map((o) => `${(o as { order_number: string }).order_number} $${Number((o as { total: number }).total).toLocaleString()}`)
      .join(' · ') || null,
  });

  if (f.investments) {
    items.push({
      key: 'investments_mixed',
      label: 'Inversiones mixtas sin separar',
      count: invMixed.count ?? 0,
      detail: null,
    });
  }

  return NextResponse.json({
    success: true,
    period: { id: period.id, label: period.label },
    items,
    clean: items.every((i) => i.count === 0),
  });
}
