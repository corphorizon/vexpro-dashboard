// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/location-units
//
// GET  → reparto de cada ubicación entre unidades de negocio (migración 071).
//        ?channel_key=… acota a una sola ubicación.
// POST → reemplaza COMPLETO el reparto de una ubicación: { channel_key, units }.
//
// El reemplazo total es a propósito: un PATCH parcial dejaría filas viejas
// conviviendo con las nuevas y el reparto sumaría más de 100% sin que nadie lo
// pida. Mandar `units: []` deja la ubicación sin reparto, y ahí vuelve a mandar
// `channel_configs.business_unit_id`.
//
// La suma NO se exige igual a 1: durante una reasignación hay estados
// intermedios y bloquearlos obligaría a borrar todo antes de reasignar. La
// pantalla avisa; el cálculo (src/lib/cash-locations.ts) reparte el sobrante a
// "sin unidad" para que el total siga cerrando.
//
// company_id sale SIEMPRE del JWT: el admin client saltea RLS, así que el
// filtro por empresa de cada query es la única barrera entre inquilinos.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, verifyAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import type { UnitShare } from '@/lib/cash-locations';

const COLUMNS = 'channel_key, business_unit_id, share';

function actorName(auth: { name?: string; email?: string }): string {
  return auth.name?.trim() || auth.email || 'Sistema';
}

export async function GET(request: NextRequest) {
  try {
    // Lectura abierta a cualquier miembro de la empresa: la RLS de esta tabla
    // ya deja leer a todo el tenant y exigir FINANCE_ROLES acá solo lograba
    // que un socio con el módulo asignado viera la pantalla vacía o con
    // "sin asignar" falso. Escritura (POST/DELETE) sigue en FINANCE_ROLES.
    const auth = await verifyAuth(request, { modules: ['balances'] });
    if (auth instanceof NextResponse) return auth;

    const channelKey = request.nextUrl.searchParams.get('channel_key');

    let query = createAdminClient()
      .from('location_business_units')
      .select(COLUMNS)
      .eq('company_id', auth.companyId);
    if (channelKey) query = query.eq('channel_key', channelKey);

    const { data, error } = await query;
    if (error) return apiError('admin/location-units GET', error, { status: 500 });

    return NextResponse.json({
      success: true,
      rows: (data ?? []) as Array<UnitShare & { channel_key: string }>,
    });
  } catch (err) {
    return apiError('admin/location-units GET', err, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['balances'] });
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => null)) as {
      channel_key?: string;
      units?: Array<{ business_unit_id?: string; share?: number }>;
    } | null;

    const channelKey = (body?.channel_key ?? '').trim();
    if (!channelKey) {
      return NextResponse.json(
        { success: false, error: 'Falta la ubicación (channel_key).' },
        { status: 400 },
      );
    }

    // Una misma unidad dos veces rompería el unique y, peor, contaría doble:
    // se queda la última parte cargada para esa unidad.
    const byUnit = new Map<string, number>();
    for (const raw of body?.units ?? []) {
      const unitId = (raw?.business_unit_id ?? '').trim();
      const share = Number(raw?.share);
      if (!unitId) continue;
      if (!Number.isFinite(share) || share < 0 || share > 1) {
        return NextResponse.json(
          { success: false, error: 'Cada porcentaje tiene que estar entre 0% y 100%.' },
          { status: 400 },
        );
      }
      if (share > 0) byUnit.set(unitId, share);
    }

    const admin = createAdminClient();

    // El admin client saltea RLS: sin este chequeo se podría colgar una
    // ubicación propia de la unidad de otro inquilino (IDOR).
    if (byUnit.size > 0) {
      const { data: owned, error: unitsError } = await admin
        .from('business_units')
        .select('id')
        .eq('company_id', auth.companyId)
        .in('id', [...byUnit.keys()]);
      if (unitsError) return apiError('admin/location-units POST', unitsError, { status: 500 });
      if ((owned ?? []).length !== byUnit.size) {
        return NextResponse.json(
          { success: false, error: 'Alguna unidad de negocio no existe en esta empresa.' },
          { status: 400 },
        );
      }
    }

    const { error: deleteError } = await admin
      .from('location_business_units')
      .delete()
      .eq('company_id', auth.companyId)
      .eq('channel_key', channelKey);
    if (deleteError) return apiError('admin/location-units POST', deleteError, { status: 500 });

    if (byUnit.size > 0) {
      const { error: insertError } = await admin.from('location_business_units').insert(
        [...byUnit.entries()].map(([business_unit_id, share]) => ({
          company_id: auth.companyId,
          channel_key: channelKey,
          business_unit_id,
          share,
        })),
      );
      if (insertError) return apiError('admin/location-units POST', insertError, { status: 500 });
    }

    await serverAuditLog(admin, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: actorName(auth),
      action: 'update',
      module: 'balances_location_units',
      details: `Repartió la ubicación "${channelKey}" entre ${byUnit.size} unidad(es) de negocio`,
    });

    return NextResponse.json({
      success: true,
      rows: [...byUnit.entries()].map(([business_unit_id, share]) => ({ business_unit_id, share })),
    });
  } catch (err) {
    return apiError('admin/location-units POST', err, { status: 500 });
  }
}
