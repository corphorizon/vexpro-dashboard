import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import { isEditable, STATUS_LABELS, type PaymentOrderStatus } from '@/lib/payment-orders/types';
import {
  ORDER_COLUMNS,
  actorName,
  beneficiaryPayloadFromOrder,
  normalizeOrder,
  orderFieldsFromInput,
  beneficiaryBelongsToCompany,
  upsertBeneficiary,
  validateOrderInput,
} from '@/lib/payment-orders/server';

// ---------------------------------------------------------------------------
// GET    /api/admin/payment-orders/[id]  → una orden
// PATCH  /api/admin/payment-orders/[id]  → editar (SOLO draft / rejected)
// DELETE /api/admin/payment-orders/[id]  → borrar (SOLO draft)
//
// Toda query por id filtra además por company_id: el admin client bypassa RLS,
// así que sin ese filtro un admin de la empresa A podría leer/editar/borrar
// órdenes de la empresa B pasando su UUID.
//
// Por qué no se puede borrar lo que ya se envió: una orden que salió a
// aprobación es un documento del circuito de tesorería. El "borrado" de un
// documento emitido es la ANULACIÓN (transición → cancelled), que deja rastro.
// ---------------------------------------------------------------------------

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES });
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('payment_orders')
      .select(ORDER_COLUMNS)
      .eq('id', id)
      .eq('company_id', auth.companyId)
      .maybeSingle();

    if (error) return apiError('admin/payment-orders/[id] GET', error, { status: 500 });
    if (!data) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      order: normalizeOrder(data as Record<string, unknown>),
    });
  } catch (err) {
    return apiError('admin/payment-orders/[id] GET', err, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES });
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();
    const companyId = auth.companyId;

    const { data: current } = await admin
      .from('payment_orders')
      .select('id, status, order_number, beneficiary_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!current) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }

    const status = current.status as PaymentOrderStatus;
    if (!isEditable(status)) {
      return NextResponse.json(
        {
          success: false,
          error: `Una orden en estado "${STATUS_LABELS.es[status]}" no se puede editar. Anulala y emití una nueva.`,
        },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => null);
    const validated = validateOrderInput(body);
    if ('error' in validated) {
      return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
    }

    // El beneficiario referenciado tiene que ser de ESTA empresa: el admin
    // client no pasa por RLS, así que sin este chequeo un id ajeno vinculaba
    // la orden al beneficiario de otro tenant (auditoría 2026-08-06).
    if (!(await beneficiaryBelongsToCompany(admin, auth.companyId, validated.input.beneficiary_id))) {
      return NextResponse.json(
        { success: false, error: 'Beneficiario no encontrado' },
        { status: 404 },
      );
    }

    // Solo campos del payload: status, order_number, company_id y el bloque de
    // auditoría no se tocan desde acá (para eso está /transition).
    const { data, error } = await admin
      .from('payment_orders')
      .update({ ...orderFieldsFromInput(validated), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
      .select(ORDER_COLUMNS)
      .maybeSingle();

    if (error) return apiError('admin/payment-orders/[id] PATCH', error, { status: 500 });
    if (!data) {
      return NextResponse.json(
        { success: false, error: 'No se actualizó ninguna fila' },
        { status: 404 },
      );
    }

    const order = normalizeOrder(data as Record<string, unknown>);

    if (validated.input.save_beneficiary) {
      const beneficiary = await upsertBeneficiary(
        admin,
        companyId,
        beneficiaryPayloadFromOrder(validated),
      );
      if (beneficiary && !order.beneficiary_id) {
        await admin
          .from('payment_orders')
          .update({ beneficiary_id: beneficiary.id })
          .eq('id', order.id)
          .eq('company_id', companyId);
        order.beneficiary_id = beneficiary.id;
      }
    }

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'update',
      module: 'payment-orders',
      details: `Editó la orden de pago ${order.order_number} — ${order.beneficiary_name} — ${order.currency} ${order.total}`,
    });

    return NextResponse.json({ success: true, order });
  } catch (err) {
    return apiError('admin/payment-orders/[id] PATCH', err, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES });
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();
    const companyId = auth.companyId;

    const { data: current } = await admin
      .from('payment_orders')
      .select('id, status, order_number, beneficiary_name')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!current) {
      return NextResponse.json(
        { success: false, error: 'Orden de pago no encontrada' },
        { status: 404 },
      );
    }

    if (current.status !== 'draft') {
      return NextResponse.json(
        {
          success: false,
          error: 'Solo se pueden eliminar borradores. Una orden ya enviada se anula, no se borra.',
        },
        { status: 400 },
      );
    }

    const { error } = await admin
      .from('payment_orders')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId);

    if (error) return apiError('admin/payment-orders/[id] DELETE', error, { status: 500 });

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'delete',
      module: 'payment-orders',
      details: `Eliminó el borrador de orden de pago ${current.order_number} — ${current.beneficiary_name}`,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError('admin/payment-orders/[id] DELETE', err, { status: 500 });
  }
}
