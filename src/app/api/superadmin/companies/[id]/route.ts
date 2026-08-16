import { NextRequest, NextResponse } from 'next/server';
import { blockedModules, isBusinessModel, normalizeBusinessModel } from '@/lib/business-model';
import { sanitizeModuleKeys } from '@/lib/modules';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

// ---------------------------------------------------------------------------
// PATCH /api/superadmin/companies/:id
//
// Update a tenant's editable fields. Whitelist of fields kept tight — name,
// logo, colors, modules, status. Slug and subdomain are NOT mutable here to
// avoid breaking bookmarks / integrations.
// ---------------------------------------------------------------------------

/**
 * ¿La entidad NO era 'company' todavía? Solo entonces el cambio de modelo
 * apaga datos que hoy cuentan — re-guardar el mismo modelo no debe avisar nada.
 */
async function isChangingToCompany(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
): Promise<boolean> {
  const { data } = await admin
    .from('companies')
    .select('business_model')
    .eq('id', id)
    .maybeSingle();
  return (data?.business_model ?? 'broker') !== 'company';
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const body = await request.json();
    const allowed: Record<string, unknown> = {};
    const FIELDS = [
      'name', 'logo_url', 'logo_url_white', 'logo_icon_url', 'color_primary', 'color_secondary',
      'active_modules', 'reserve_pct', 'currency', 'status',
      'default_wallet_id', 'business_model',
    ] as const;
    for (const f of FIELDS) {
      if (f in body) allowed[f] = (body as Record<string, unknown>)[f];
    }

    if (Object.keys(allowed).length === 0) {
      return NextResponse.json(
        { success: false, error: 'Ningún campo válido para actualizar' },
        { status: 400 },
      );
    }

    // Un modelo fuera del catálogo lo rechazaría el CHECK de la tabla con un
    // error crudo de Postgres; mejor un mensaje que se entienda.
    if ('business_model' in allowed && !isBusinessModel(allowed.business_model)) {
      return NextResponse.json(
        { success: false, error: 'El modelo de negocio no es válido' },
        { status: 400 },
      );
    }

    if (allowed.status && !['active', 'inactive'].includes(allowed.status as string)) {
      return NextResponse.json(
        { success: false, error: 'status debe ser active o inactive' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    // ── Módulos: saneados y filtrados por el modelo de negocio ──────────────
    // Sin esto se podía guardar cualquier clave inventada, y también módulos
    // que blockedModules esconde igual: la empresa "tenía" pantallas que nadie
    // ve pero que sí se ofrecían al asignar permisos a sus usuarios.
    if ('active_modules' in allowed) {
      const currentModel = allowed.business_model ?? (
        await admin.from('companies').select('business_model').eq('id', id).maybeSingle()
      ).data?.business_model;
      const blocked = new Set(blockedModules(normalizeBusinessModel(currentModel)));
      allowed.active_modules = sanitizeModuleKeys(allowed.active_modules)
        .filter((m) => !blocked.has(m));
    }

    // ── Aviso de datos que dejan de contar ──────────────────────────────────
    // Pasar a 'company' apaga el P&L de broker y el circuito de prop firm en
    // la cadena de distribución (ver la neutralización en
    // src/lib/distribution-inputs.ts) y esconde depósitos/retiros de toda
    // pantalla. Si la entidad ya tiene esa data cargada, el cambio le mueve
    // el "Monto a Distribuir" sin que ninguna pantalla explique por qué. Se
    // avisa ANTES de que pase por sorpresa; no bloquea el cambio.
    let warning: string | null = null;
    if (allowed.business_model === 'company' && (await isChangingToCompany(admin, id))) {
      const countOf = async (table: string) => {
        const { count } = await admin
          .from(table)
          .select('id', { count: 'exact', head: true })
          .eq('company_id', id);
        return count ?? 0;
      };
      const [deps, withs, pfs] = await Promise.all([
        countOf('deposits'),
        countOf('withdrawals'),
        countOf('prop_firm_sales'),
      ]);
      if (deps + withs + pfs > 0) {
        const partes = [
          deps > 0 ? `${deps} depósito${deps === 1 ? '' : 's'}` : null,
          withs > 0 ? `${withs} retiro${withs === 1 ? '' : 's'}` : null,
          pfs > 0 ? `${pfs} venta${pfs === 1 ? '' : 's'} de prop firm` : null,
        ].filter(Boolean) as string[];
        const detalle =
          partes.length > 1
            ? `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`
            : partes[0];
        warning =
          `La empresa tiene ${detalle} cargados que dejarán de contar en la ` +
          `distribución y de verse en las pantallas. Los períodos ya cerrados ` +
          `conservan sus insumos congelados.`;
      }
    }

    const { data, error } = await admin
      .from('companies')
      .update({ ...allowed, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      return apiError('superadmin/companies/[id]', error, { status: 404, clientMessage: 'No se encontró la entidad' });
    }

    return NextResponse.json({ success: true, company: data, ...(warning ? { warning } : {}) });
  } catch (err) {
    return apiError('superadmin/companies/[id]', err, { status: 500 });
  }
}
