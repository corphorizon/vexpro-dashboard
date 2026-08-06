import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import type { PaymentBeneficiary } from '@/lib/payment-orders/types';
import {
  actorName,
  findBeneficiaryByName,
  upsertBeneficiary,
  type BeneficiaryPayload,
} from '@/lib/payment-orders/server';

// ---------------------------------------------------------------------------
// GET  /api/admin/payment-beneficiaries  → libreta de la empresa (?q= filtro)
// POST /api/admin/payment-beneficiaries  → alta o actualización por nombre
//
// La libreta es el control anti-fraude más efectivo del módulo: re-tipear una
// wallet en cada orden es la forma más común de mandar fondos a la nada (no hay
// reversa). El match del upsert es (company_id, name) case-insensitive, así que
// "Proveedor SA" y "proveedor sa" son el mismo beneficiario y no se duplican.
//
// company_id sale del JWT en las dos operaciones — nunca del body.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const q = (request.nextUrl.searchParams.get('q') ?? '').trim();

    let query = admin
      .from('payment_beneficiaries')
      .select('*')
      .eq('company_id', auth.companyId)
      .order('name', { ascending: true });

    if (q) {
      // Escapar comodines de LIKE para que un "%" tipeado no liste todo.
      query = query.ilike('name', `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }

    const { data, error } = await query;
    if (error) return apiError('admin/payment-beneficiaries GET', error, { status: 500 });

    return NextResponse.json({
      success: true,
      beneficiaries: (data ?? []) as PaymentBeneficiary[],
    });
  } catch (err) {
    return apiError('admin/payment-beneficiaries GET', err, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => null)) as BeneficiaryPayload | null;
    const name = (body?.name ?? '').trim();
    if (!name) {
      return NextResponse.json(
        { success: false, error: 'El nombre del beneficiario es obligatorio.' },
        { status: 400 },
      );
    }

    const method = body?.default_payment_method;
    if (method != null && method !== 'crypto' && method !== 'bank') {
      return NextResponse.json(
        { success: false, error: 'El medio de pago por defecto debe ser "crypto" o "bank".' },
        { status: 400 },
      );
    }
    // Los datos de pago son opcionales en la libreta (se puede guardar un
    // beneficiario mientras se consiguen), pero si se declara un medio, los
    // campos que lo hacen utilizable tienen que estar.
    if (method === 'crypto' && !(body?.crypto_wallet ?? '').trim()) {
      return NextResponse.json(
        { success: false, error: 'Para el medio cripto se requiere la wallet.' },
        { status: 400 },
      );
    }
    if (method === 'bank' && !(body?.bank_account_number ?? '').trim()) {
      return NextResponse.json(
        { success: false, error: 'Para el medio bancario se requiere el número de cuenta / IBAN.' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const existing = await findBeneficiaryByName(admin, auth.companyId, name);

    const beneficiary = await upsertBeneficiary(admin, auth.companyId, { ...body, name });
    if (!beneficiary) {
      return apiError('admin/payment-beneficiaries POST', new Error('upsert sin fila'), {
        status: 500,
        clientMessage: 'No se pudo guardar el beneficiario.',
      });
    }

    await serverAuditLog(admin, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: existing ? 'update' : 'create',
      module: 'payment-orders',
      details: `${existing ? 'Actualizó' : 'Creó'} el beneficiario "${beneficiary.name}" en la libreta`,
    });

    return NextResponse.json({ success: true, beneficiary }, { status: existing ? 200 : 201 });
  } catch (err) {
    return apiError('admin/payment-beneficiaries POST', err, { status: 500 });
  }
}
