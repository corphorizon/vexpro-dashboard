// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/business-units
//
// GET    → unidades de negocio de la empresa (?include_inactive=1 para todas).
// POST   → alta (sin id) o edición (con id) de una unidad.
// DELETE → baja de una unidad (?id=…).
//
// `counts_to_fund` es lo que decide si el saldo de esa unidad entra en el
// fondo — el "ahorro real" — o se lleva aparte. Vive por unidad y no por
// ubicación para que dos wallets de la misma unidad no puedan discrepar.
//
// company_id sale SIEMPRE del JWT: el admin client saltea RLS, así que el
// filtro por empresa de cada query es la única barrera entre inquilinos.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, verifyAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import type { BusinessUnit } from '@/lib/cash-locations';

const COLUMNS = 'id, company_id, name, counts_to_fund, is_active, sort_order';

function actorName(auth: { name?: string; email?: string }): string {
  return auth.name?.trim() || auth.email || 'Sistema';
}

export async function GET(request: NextRequest) {
  try {
    // Lectura abierta a cualquier miembro de la empresa: la RLS de esta tabla
    // ya deja leer a todo el tenant y exigir FINANCE_ROLES acá solo lograba
    // que un socio con el módulo asignado viera la pantalla vacía o con
    // "sin asignar" falso. Escritura (POST/DELETE) sigue en FINANCE_ROLES.
    const auth = await verifyAuth(request);
    if (auth instanceof NextResponse) return auth;

    const includeInactive = request.nextUrl.searchParams.get('include_inactive') === '1';

    let query = createAdminClient()
      .from('business_units')
      .select(COLUMNS)
      .eq('company_id', auth.companyId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    // Una unidad archivada sigue teniendo ubicaciones colgando: la pantalla
    // necesita poder nombrarlas, así que por defecto se listan igual.
    if (!includeInactive) query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) return apiError('admin/business-units GET', error, { status: 500 });

    return NextResponse.json({ success: true, units: (data ?? []) as BusinessUnit[] });
  } catch (err) {
    return apiError('admin/business-units GET', err, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES });
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => null)) as {
      id?: string;
      name?: string;
      counts_to_fund?: boolean;
      is_active?: boolean;
      sort_order?: number;
    } | null;

    const name = (body?.name ?? '').trim();
    if (!name) {
      return NextResponse.json(
        { success: false, error: 'El nombre de la unidad de negocio es obligatorio.' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const payload = {
      name,
      counts_to_fund: typeof body?.counts_to_fund === 'boolean' ? body.counts_to_fund : true,
      is_active: typeof body?.is_active === 'boolean' ? body.is_active : true,
      sort_order: Number.isFinite(body?.sort_order) ? Number(body!.sort_order) : 0,
      updated_at: new Date().toISOString(),
    };

    const isUpdate = typeof body?.id === 'string' && body.id.length > 0;
    const query = isUpdate
      ? admin
          .from('business_units')
          .update(payload)
          .eq('id', body!.id!)
          .eq('company_id', auth.companyId)
          .select(COLUMNS)
          .maybeSingle()
      : admin
          .from('business_units')
          .insert({ ...payload, company_id: auth.companyId })
          .select(COLUMNS)
          .maybeSingle();

    const { data, error } = await query;
    if (error) {
      // El unique (company_id, name) es intencional: dos unidades con el
      // mismo nombre harían ilegible el desglose por unidad.
      const duplicate = typeof error.code === 'string' && error.code === '23505';
      return apiError('admin/business-units POST', error, {
        status: duplicate ? 409 : 500,
        clientMessage: duplicate ? 'Ya existe una unidad de negocio con ese nombre.' : undefined,
      });
    }
    if (!data) {
      return NextResponse.json(
        { success: false, error: 'La unidad de negocio no existe en esta empresa.' },
        { status: 404 },
      );
    }

    await serverAuditLog(admin, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: isUpdate ? 'update' : 'create',
      module: 'balances_business_units',
      details: `${isUpdate ? 'Actualizó' : 'Creó'} la unidad de negocio "${name}" (fondo: ${payload.counts_to_fund ? 'sí' : 'no'})`,
    });

    return NextResponse.json(
      { success: true, unit: data as BusinessUnit },
      { status: isUpdate ? 200 : 201 },
    );
  } catch (err) {
    return apiError('admin/business-units POST', err, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES });
    if (auth instanceof NextResponse) return auth;

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, error: 'Falta el id de la unidad.' }, { status: 400 });
    }

    const admin = createAdminClient();
    // Las ubicaciones que apuntaban acá quedan sin unidad (FK on delete set
    // null) y siguen contando en el fondo: su plata no desaparece.
    const { data, error } = await admin
      .from('business_units')
      .delete()
      .eq('id', id)
      .eq('company_id', auth.companyId)
      .select('name')
      .maybeSingle();

    if (error) return apiError('admin/business-units DELETE', error, { status: 500 });
    if (!data) {
      return NextResponse.json(
        { success: false, error: 'La unidad de negocio no existe en esta empresa.' },
        { status: 404 },
      );
    }

    await serverAuditLog(admin, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'delete',
      module: 'balances_business_units',
      details: `Eliminó la unidad de negocio "${data.name}"`,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError('admin/business-units DELETE', err, { status: 500 });
  }
}
