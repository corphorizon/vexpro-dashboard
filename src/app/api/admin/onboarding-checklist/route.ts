import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

// ---------------------------------------------------------------------------
// /api/admin/onboarding-checklist — checklist de contratación por comercial,
// scopeado por company_id. RLS bypass via admin client (verifyAdminAuth ya
// valida que el caller es admin/hr o un superadmin con ?company_id=...).
//
//   GET   → todas las filas de la empresa.
//   POST  → upsert de la fila de un perfil (por company_id + profile_id).
// ---------------------------------------------------------------------------

const BOOL_FIELDS = [
  'propuesta', 'acepto_propuesta', 'contrato', 'acepto_contrato', 'accesos',
] as const;

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('onboarding_checklist')
      .select('*')
      .eq('company_id', auth.companyId);

    if (error) return apiError('admin/onboarding-checklist', error, { status: 500 });
    return NextResponse.json({ success: true, rows: data ?? [] });
  } catch (err) {
    return apiError('admin/onboarding-checklist', err, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json()) as Record<string, unknown>;
    const profile_id = body.profile_id;
    if (!profile_id || typeof profile_id !== 'string') {
      return NextResponse.json(
        { success: false, error: 'profile_id es requerido' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    // Validar que el perfil pertenece a la empresa del caller (anti cross-tenant).
    const { data: prof } = await admin
      .from('commercial_profiles')
      .select('id')
      .eq('id', profile_id)
      .eq('company_id', auth.companyId)
      .maybeSingle();
    if (!prof) {
      return NextResponse.json(
        { success: false, error: 'Perfil no encontrado en esta empresa' },
        { status: 404 },
      );
    }

    const row: Record<string, unknown> = {
      company_id: auth.companyId,
      profile_id,
      updated_at: new Date().toISOString(),
    };
    for (const f of BOOL_FIELDS) if (f in body) row[f] = !!body[f];
    if ('salario_fijo' in body) {
      const v = body.salario_fijo;
      row.salario_fijo = v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
    }
    if ('sponsor' in body) {
      const v = body.sponsor;
      row.sponsor = v === null || v === '' ? null : String(v);
    }

    const { error } = await admin
      .from('onboarding_checklist')
      .upsert(row, { onConflict: 'company_id,profile_id' });

    if (error) return apiError('admin/onboarding-checklist', error, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError('admin/onboarding-checklist', err, { status: 500 });
  }
}
