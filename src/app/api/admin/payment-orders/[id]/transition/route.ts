import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import {
  canTransition,
  STATUS_LABELS,
  type PaymentOrderStatus,
} from '@/lib/payment-orders/types';
import {
  ORDER_COLUMNS,
  actorName,
  createExpenseForPaidOrder,
  normalizeOrder,
} from '@/lib/payment-orders/server';

// ---------------------------------------------------------------------------
// POST /api/admin/payment-orders/[id]/transition
//   body: { to, reason?, payment_reference?, payment_date?, create_expense?,
//           expense_category? }
//
// Único punto por el que cambia el estado de una orden. Concentra los tres
// controles que le dan valor al documento:
//
//   1. MÁQUINA DE ESTADOS — canTransition() (types.ts) es la autoridad; la UI
//      usa la misma tabla solo para decidir qué botones muestra.
//   2. SEGREGACIÓN DE FUNCIONES — quien creó la orden no puede aprobarla, y
//      aprobar/rechazar exige rol admin estricto (auditor/hr quedan afuera).
//      El trigger payment_orders_guard repite el control en DB.
//   3. TRAZABILIDAD — cada transición sella quién y cuándo, con el nombre
//      desnormalizado para que el PDF histórico no cambie después.
// ---------------------------------------------------------------------------

const VALID_STATUSES: PaymentOrderStatus[] = [
  'draft', 'pending', 'approved', 'paid', 'rejected', 'cancelled',
];

interface TransitionBody {
  to?: PaymentOrderStatus;
  reason?: string | null;
  payment_reference?: string | null;
  payment_date?: string | null;
  create_expense?: boolean;
  /** Categoría del egreso generado (solo aplica con create_expense). */
  expense_category?: string | null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = (await request.json().catch(() => null)) as TransitionBody | null;
    const to = body?.to;

    if (!to || !VALID_STATUSES.includes(to)) {
      return NextResponse.json(
        { success: false, error: 'Estado destino inválido.' },
        { status: 400 },
      );
    }

    // Aprobación abierta (decisión Kevin 2026-08-05): cualquier usuario con
    // acceso al módulo puede aprobar/rechazar, incluida su propia orden. La
    // trazabilidad (approved_by/at) reemplaza al bloqueo como control.
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const { id } = await params;
    const admin = createAdminClient();
    const companyId = auth.companyId;

    const { data: current, error: readErr } = await admin
      .from('payment_orders')
      .select(ORDER_COLUMNS)
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (readErr) return apiError('admin/payment-orders/transition:read', readErr, { status: 500 });
    if (!current) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }

    const order = normalizeOrder(current as Record<string, unknown>);
    const from = order.status;

    if (!canTransition(from, to)) {
      return NextResponse.json(
        {
          success: false,
          error: `Transición no permitida: una orden "${STATUS_LABELS.es[from]}" no puede pasar a "${STATUS_LABELS.es[to]}".`,
        },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();
    const who = actorName(auth);
    const reason = (body?.reason ?? '').trim();
    const reference = (body?.payment_reference ?? '').trim();
    const updates: Record<string, unknown> = { status: to, updated_at: now };

    switch (to) {
      case 'pending': {
        updates.submitted_at = now;
        break;
      }

      case 'approved': {
        // Sin maker-checker (ver arriba). Una autoaprobación queda registrada
        // igual: approved_by === created_by es visible en el historial.
        updates.approved_by = auth.userId;
        updates.approved_by_name = who;
        updates.approved_at = now;
        // Una aprobación limpia el rastro de un rechazo anterior del ciclo.
        updates.rejected_by = null;
        updates.rejected_by_name = null;
        updates.rejected_at = null;
        updates.rejection_reason = null;
        break;
      }

      case 'rejected': {
        if (!reason) {
          return NextResponse.json(
            { success: false, error: 'Debe indicar el motivo del rechazo.' },
            { status: 400 },
          );
        }
        updates.rejected_by = auth.userId;
        updates.rejected_by_name = who;
        updates.rejected_at = now;
        updates.rejection_reason = reason;
        break;
      }

      case 'paid': {
        if (!reference) {
          return NextResponse.json(
            {
              success: false,
              error: 'Para marcar la orden como pagada se requiere la referencia del pago (txid o referencia bancaria).',
            },
            { status: 400 },
          );
        }
        const payDate = (body?.payment_date ?? '').trim();
        if (payDate && !/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
          return NextResponse.json(
            { success: false, error: 'La fecha de pago debe tener formato YYYY-MM-DD.' },
            { status: 400 },
          );
        }
        updates.paid_at = now;
        updates.paid_by = auth.userId;
        updates.paid_by_name = who;
        updates.payment_reference = reference;
        updates.payment_date = payDate || now.slice(0, 10);
        break;
      }

      case 'cancelled': {
        updates.cancelled_by = auth.userId;
        updates.cancelled_by_name = who;
        updates.cancelled_at = now;
        updates.cancellation_reason = reason || null;
        break;
      }

      case 'draft': {
        // Vuelve a edición (desde pending o rejected): se limpia el envío y el
        // rechazo para que el próximo ciclo arranque sin rastros del anterior.
        updates.submitted_at = null;
        updates.rejected_by = null;
        updates.rejected_by_name = null;
        updates.rejected_at = null;
        updates.rejection_reason = null;
        break;
      }
    }

    const { data: updated, error } = await admin
      .from('payment_orders')
      .update(updates)
      .eq('id', id)
      .eq('company_id', companyId)
      .select(ORDER_COLUMNS)
      .maybeSingle();

    if (error) {
      // El trigger payment_orders_guard levanta excepciones de negocio
      // (inmutabilidad post-aprobación) — se devuelven como 400.
      const msg = error.message ?? '';
      if (/inmutable/i.test(msg)) {
        return NextResponse.json({ success: false, error: msg }, { status: 400 });
      }
      return apiError('admin/payment-orders/transition', error, { status: 500 });
    }
    if (!updated) {
      return NextResponse.json(
        { success: false, error: 'No se actualizó ninguna fila' },
        { status: 404 },
      );
    }

    let result = normalizeOrder(updated as Record<string, unknown>);
    let warning: string | null = null;

    // ── Egreso automático al pagar (opcional) ──
    // Si no hay período abierto NO se rompe la transición: la orden ya está
    // pagada en la realidad. Se devuelve un warning para que la UI lo diga.
    if (to === 'paid' && body?.create_expense === true && !result.expense_id) {
      const { expenseId, warning: w } = await createExpenseForPaidOrder(admin, companyId, {
        id: result.id,
        order_number: result.order_number,
        beneficiary_name: result.beneficiary_name,
        total: result.total,
      }, body?.expense_category ?? null);
      warning = w;
      if (expenseId) {
        const { data: linked } = await admin
          .from('payment_orders')
          .update({ expense_id: expenseId })
          .eq('id', result.id)
          .eq('company_id', companyId)
          .select(ORDER_COLUMNS)
          .maybeSingle();
        if (linked) result = normalizeOrder(linked as Record<string, unknown>);
        else result.expense_id = expenseId;
      }
    }

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: who,
      action: 'update',
      module: 'payment-orders',
      details:
        `Orden ${result.order_number}: ${STATUS_LABELS.es[from]} → ${STATUS_LABELS.es[to]}` +
        (reason ? ` — motivo: ${reason}` : '') +
        (reference ? ` — ref: ${reference}` : ''),
    });

    return NextResponse.json({ success: true, order: result, warning });
  } catch (err) {
    return apiError('admin/payment-orders/transition', err, { status: 500 });
  }
}
