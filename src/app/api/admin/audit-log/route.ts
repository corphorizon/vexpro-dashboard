import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

// ---------------------------------------------------------------------------
// POST /api/admin/audit-log
//
// Persists an audit entry to the audit_logs table. Called from the browser
// helper `src/lib/audit-log.ts` on every user-visible action (login,
// logout, CRUD on egresos/upload/users, exports, etc.).
//
// SECURITY — anti-spoofing hardening:
// Previous version accepted `user_id` and `user_name` from the request body,
// letting any authenticated caller forge audit entries attributed to anyone.
// Now the caller is identified exclusively from the verified token via
// verifyAuth(); body-supplied identity fields are IGNORED. company_id is
// also taken from the token — never from the body.
//
// Why verifyAuth() and not verifyAdminAuth()? The endpoint logs normal-user
// actions (login, self-profile updates, CSV exports, etc.). Restricting to
// admin-only would silently drop every non-admin login/logout from the
// audit trail, which is the opposite of what auditors want.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { action, module, details } = body as {
      action?: string;
      module?: string;
      details?: string;
    };

    if (!action || !module) {
      return NextResponse.json(
        { success: false, error: 'action y module son requeridos' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const { error } = await admin.from('audit_logs').insert({
      // Identity + tenancy come from the verified token — never from body.
      user_id: auth.userId,
      user_name: auth.name || auth.email,
      company_id: auth.companyId,
      action,
      module,
      details: details || '',
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error('[audit-log] insert failed:', error.message);
      return NextResponse.json({ success: false }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    console.error('[audit-log] unhandled:', msg);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/audit-log
//
// Consulta del Registro de Actividad (/logs). Filtros combinables:
//   from, to      → rango de fechas (YYYY-MM-DD, inclusive los dos extremos)
//   module        → clave del módulo
//   action        → create | update | delete | login | logout | export | ...
//   user          → coincidencia parcial sobre el nombre
//   q             → búsqueda libre en el detalle
//   page, limit   → paginación (limit tope 200)
//
// Devuelve además `facets`: los valores de módulo y acción realmente
// presentes en la empresa, para poblar los selectores sin hardcodear una
// lista que se desactualice (los módulos del log NO son los mismos que los
// del menú: acá aparecen cosas como `integrations_sync` o `auth`).
//
// Solo lectura y siempre acotado a la empresa del token: `company_id` sale de
// verifyAuth, nunca del query string.
// ---------------------------------------------------------------------------

const MAX_LIMIT = 200;

export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request);
  if (auth instanceof NextResponse) return auth;

  const p = request.nextUrl.searchParams;
  const from = p.get('from');
  const to = p.get('to');
  const moduleKey = p.get('module');
  const action = p.get('action');
  const user = p.get('user');
  const q = p.get('q');

  const page = Math.max(1, Number(p.get('page')) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(p.get('limit')) || 50));

  const admin = createAdminClient();

  let query = admin
    .from('audit_logs')
    .select('id, user_id, user_name, action, module, details, ip_address, created_at', {
      count: 'exact',
    })
    .eq('company_id', auth.companyId);

  // `to` se extiende al final del día: filtrar por '2026-08-06' contra un
  // timestamptz dejaría fuera todo lo del propio día salvo la medianoche.
  if (from) query = query.gte('created_at', `${from}T00:00:00.000Z`);
  if (to) query = query.lte('created_at', `${to}T23:59:59.999Z`);
  if (moduleKey) query = query.eq('module', moduleKey);
  if (action) query = query.eq('action', action);
  if (user) query = query.ilike('user_name', `%${user}%`);
  if (q) query = query.ilike('details', `%${q}%`);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (error) return apiError('admin/audit-log', error, { status: 500 });

  // Facetas: se calculan sobre el rango de fechas pero SIN aplicar los
  // filtros de módulo/acción, para que elegir uno no vacíe el otro selector.
  let facetQuery = admin
    .from('audit_logs')
    .select('module, action, user_name')
    .eq('company_id', auth.companyId)
    .limit(5000);
  if (from) facetQuery = facetQuery.gte('created_at', `${from}T00:00:00.000Z`);
  if (to) facetQuery = facetQuery.lte('created_at', `${to}T23:59:59.999Z`);
  const { data: facetRows } = await facetQuery;

  const modules = new Set<string>();
  const actions = new Set<string>();
  const users = new Set<string>();
  for (const row of (facetRows ?? []) as Array<{ module: string; action: string; user_name: string | null }>) {
    if (row.module) modules.add(row.module);
    if (row.action) actions.add(row.action);
    if (row.user_name) users.add(row.user_name);
  }

  return NextResponse.json({
    success: true,
    entries: data ?? [],
    total: count ?? 0,
    page,
    limit,
    facets: {
      modules: [...modules].sort(),
      actions: [...actions].sort(),
      users: [...users].sort(),
    },
  });
}
