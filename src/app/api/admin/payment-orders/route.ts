import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import type { PaymentOrderStatus } from '@/lib/payment-orders/types';
import {
  ORDER_COLUMNS,
  actorName,
  beneficiaryPayloadFromOrder,
  normalizeOrder,
  normalizeOrders,
  orderFieldsFromInput,
  beneficiaryBelongsToCompany,
  upsertBeneficiary,
  validateOrderInput,
} from '@/lib/payment-orders/server';

// ---------------------------------------------------------------------------
// GET  /api/admin/payment-orders        → listado de la empresa (?status=…)
// POST /api/admin/payment-orders        → alta de un borrador
//
// Mismo patrón que /api/admin/data: verifyAdminAuth resuelve company_id desde
// el JWT (NUNCA del body) y toda query filtra por company_id — el admin client
// bypassa RLS, así que sin ese filtro habría IDOR cross-tenant.
//
// Dos cosas que el cliente NO decide nunca:
//   · el correlativo → RPC next_payment_order_number (atómica, en DB);
//   · los totales    → computeTotals() server-side sobre las líneas.
// ---------------------------------------------------------------------------

const VALID_STATUSES: PaymentOrderStatus[] = [
  'draft', 'pending', 'approved', 'paid', 'rejected', 'cancelled',
];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['payment_orders'] });
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const params = request.nextUrl.searchParams;

    // ?status=pending  |  ?status=pending,approved
    const statusParam = params.get('status');
    const statuses = (statusParam ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as PaymentOrderStatus[];
    const invalid = statuses.find((s) => !VALID_STATUSES.includes(s));
    if (invalid) {
      return NextResponse.json(
        { success: false, error: `Estado desconocido: ${invalid}` },
        { status: 400 },
      );
    }

    const rawLimit = Number(params.get('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

    let query = admin
      .from('payment_orders')
      .select(ORDER_COLUMNS)
      .eq('company_id', auth.companyId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (statuses.length === 1) query = query.eq('status', statuses[0]);
    else if (statuses.length > 1) query = query.in('status', statuses);

    const { data, error } = await query;
    if (error) return apiError('admin/payment-orders GET', error, { status: 500 });

    return NextResponse.json({ success: true, orders: normalizeOrders(data) });
  } catch (err) {
    return apiError('admin/payment-orders GET', err, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['payment_orders'] });
    if (auth instanceof NextResponse) return auth;

    const body = await request.json().catch(() => null);
    const validated = validateOrderInput(body);
    if ('error' in validated) {
      return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
    }

    const admin = createAdminClient();
    const companyId = auth.companyId;
    if (!(await beneficiaryBelongsToCompany(admin, auth.companyId, validated.input.beneficiary_id))) {
      return NextResponse.json(
        { success: false, error: 'Beneficiario no encontrado' },
        { status: 404 },
      );
    }

    const fields = orderFieldsFromInput(validated);

    // ── Correlativo + insert, con reintento ante colisión ──
    // La RPC serializa con un advisory lock de transacción, pero ese lock se
    // libera al terminar la RPC (PostgREST = una transacción por request), no
    // al terminar nuestro insert. La red de contención real es el UNIQUE
    // (company_id, order_number): ante 23505 pedimos el siguiente número.
    let created: Record<string, unknown> | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      const { data: orderNumber, error: rpcErr } = await admin.rpc(
        'next_payment_order_number',
        { p_company_id: companyId },
      );
      if (rpcErr || !orderNumber) {
        return apiError('admin/payment-orders POST:rpc', rpcErr ?? new Error('sin número'), {
          status: 500,
        });
      }

      const { data, error } = await admin
        .from('payment_orders')
        .insert({
          company_id: companyId,
          order_number: orderNumber as string,
          status: 'draft',
          ...fields,
          created_by: auth.userId,
          created_by_name: actorName(auth),
        })
        .select(ORDER_COLUMNS)
        .single();

      if (!error) {
        created = data as Record<string, unknown>;
        break;
      }
      lastError = error;
      if (error.code !== '23505') break; // no es colisión de correlativo
    }

    if (!created) {
      return apiError('admin/payment-orders POST', lastError, { status: 500 });
    }

    const order = normalizeOrder(created);

    // ── Libreta de beneficiarios (best-effort) ──
    // Si falla, la orden ya está creada y tiene su propia foto de los datos:
    // no tiene sentido hacer fallar el alta por la libreta.
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
      action: 'create',
      module: 'payment-orders',
      details: `Creó la orden de pago ${order.order_number} — ${order.beneficiary_name} — ${order.currency} ${order.total}`,
    });

    return NextResponse.json({ success: true, order }, { status: 201 });
  } catch (err) {
    return apiError('admin/payment-orders POST', err, { status: 500 });
  }
}
