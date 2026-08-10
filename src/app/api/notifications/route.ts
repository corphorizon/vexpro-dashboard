// ---------------------------------------------------------------------------
// GET   /api/notifications        → bandeja del usuario (?company_id, ?limit)
// PATCH /api/notifications        → marcar leídas ({ ids } | { all: true })
//
// Este endpoint NO usa verifyAdminAuth ni el admin client, y es a propósito:
//
//   · La bandeja es del USUARIO, no de la empresa. Con el cliente normal, RLS
//     (`user_id = auth.uid()`) hace el filtro — el endpoint no puede
//     equivocarse y mostrar de más.
//   · verifyAdminAuth le exige `?company_id=` al superadmin y devuelve 400 sin
//     él. Su bandeja tiene que funcionar aunque no esté "viendo" ninguna
//     empresa, así que ese camino no sirve acá.
//
// El `?company_id=` es un FILTRO opcional, no una autorización: lo agrega solo
// el superadmin en modo "viendo como" (via apiFetch) para no mezclar los
// avisos de varias empresas en una misma lista.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError } from '@/lib/api-error';
import type { AppNotification } from '@/lib/notifications/catalog';

/** Tope de la bandeja. Más allá de esto nadie scrollea; hay que marcar leído. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * El `company_id` termina interpolado dentro de un `.or()` de PostgREST, que es
 * un mini-lenguaje con comas y paréntesis: un valor con `,` inyecta condiciones
 * extra en el filtro. Acá la RLS impide cualquier fuga, pero el patrón no puede
 * quedar como ejemplo copiable, así que se valida la forma antes de armar el or.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ success: false, error: 'No autenticado' }, { status: 401 });
    }

    const companyId = request.nextUrl.searchParams.get('company_id');
    const rawLimit = Number(request.nextUrl.searchParams.get('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

    let query = supabase
      .from('notifications')
      .select('id, company_id, type, severity, params, link, read_at, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    // Filtro de empresa: solo tiene efecto para quien recibe de varias
    // (el superadmin). Se dejan pasar las de company_id null, que son avisos
    // de plataforma y no pertenecen a ningún tenant.
    if (companyId) {
      if (!UUID_RE.test(companyId)) {
        return NextResponse.json({ success: false, error: 'Empresa inválida' }, { status: 400 });
      }
      query = query.or(`company_id.eq.${companyId},company_id.is.null`);
    }

    const { data, error } = await query;
    if (error) return apiError('notifications GET', error, { status: 500 });

    const notifications = (data ?? []) as AppNotification[];
    return NextResponse.json({
      success: true,
      notifications,
      unread: notifications.filter((n) => !n.read_at).length,
    });
  } catch (err) {
    return apiError('notifications GET', err, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ success: false, error: 'No autenticado' }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as { ids?: string[]; all?: boolean };
    const now = new Date().toISOString();

    // RLS acota el UPDATE a las filas propias, así que no hace falta (ni
    // serviría) filtrar por user_id acá.
    let query = supabase.from('notifications').update({ read_at: now }).is('read_at', null);
    if (body.all !== true) {
      const ids = Array.isArray(body.ids) ? body.ids.filter((i) => typeof i === 'string') : [];
      if (ids.length === 0) {
        return NextResponse.json({ success: false, error: 'Nada para marcar' }, { status: 400 });
      }
      query = query.in('id', ids);
    }

    const { error } = await query;
    if (error) return apiError('notifications PATCH', error, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError('notifications PATCH', err, { status: 500 });
  }
}
