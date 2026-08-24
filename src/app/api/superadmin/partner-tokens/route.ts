// ─────────────────────────────────────────────────────────────────────────────
// Gestión de los tokens de aplicativos (Atlas y compañía).
//
// Sólo superadmin: un token de estos abre datos del bróker de una organización
// entera, así que no es una llave que deba poder crear un admin de empresa.
//
// ── EL TOKEN SE MUESTRA UNA VEZ Y NO SE PUEDE RECUPERAR ────────────────────
// Guardamos el SHA-256, nunca el token. Eso significa que si alguien lo
// pierde, la única salida es rotarlo — y es a propósito: si pudiéramos
// mostrarlo de nuevo, es que lo tendríamos guardado, y entonces esta tabla
// filtrada sería suficiente para llamar a la API.
//
// El listado devuelve el PREFIJO, que alcanza para decir "el token de Atlas
// que empieza en sdk_VMbD…" sin revelar nada.
//
// ── REVOCAR NO BORRA ──────────────────────────────────────────────────────
// Un token revocado se marca, no se elimina. Borrarlo perdería el rastro de
// que existió, cuántas veces se usó y cuándo se cortó — que es justo lo que
// se quiere mirar después de un incidente.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { generatePartnerToken } from '@/lib/partner-api/auth';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

/** Permisos que se pueden conceder hoy. Un token sin ninguno no puede nada. */
const SCOPES_VALIDOS = ['mt5:read'] as const;

const COLS =
  'id, company_id, app_name, token_prefix, scopes, is_active, revoked_at, revoked_reason, ' +
  'created_at, created_by_name, last_used_at, last_used_ip, request_count';

export async function GET() {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('partner_api_tokens')
      .select(`${COLS}, companies(name)`)
      .order('created_at', { ascending: false });
    if (error) return apiError('superadmin/partner-tokens GET', error, { status: 500 });

    return NextResponse.json({ success: true, tokens: data ?? [], scopes: SCOPES_VALIDOS });
  } catch (err) {
    return apiError('superadmin/partner-tokens GET', err, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => ({}))) as {
      company_id?: string;
      app_name?: string;
      scopes?: string[];
    };

    const companyId = typeof body.company_id === 'string' ? body.company_id.trim() : '';
    const appName = typeof body.app_name === 'string' ? body.app_name.trim().slice(0, 60) : '';
    if (!/^[0-9a-f-]{36}$/i.test(companyId)) {
      return NextResponse.json({ success: false, error: 'Elegí una empresa.' }, { status: 400 });
    }
    if (!appName) {
      return NextResponse.json(
        { success: false, error: 'Poné un nombre de aplicativo (atlas, assistant…). Sirve para saber a quién cortarle el acceso.' },
        { status: 400 },
      );
    }

    // Un token sin permisos no puede hacer nada: es el default correcto, pero
    // crear uno así casi siempre es un olvido, no una intención.
    const scopes = (Array.isArray(body.scopes) ? body.scopes : []).filter((s): s is string =>
      (SCOPES_VALIDOS as readonly string[]).includes(s),
    );
    if (scopes.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Marcá al menos un permiso: un token sin permisos no puede leer nada.' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const t = generatePartnerToken();
    const { data, error } = await admin
      .from('partner_api_tokens')
      .insert({
        company_id: companyId,
        app_name: appName,
        token_prefix: t.prefix,
        token_hash: t.hash,
        scopes,
        created_by: auth.userId,
        created_by_name: auth.name,
      })
      .select(COLS)
      .single();
    if (error) return apiError('superadmin/partner-tokens POST', error, { status: 500 });

    return NextResponse.json({
      success: true,
      token: data,
      // La ÚNICA vez que este valor sale del servidor.
      secret: t.token,
      warning:
        'Copialo ahora: no se guarda y no se puede volver a ver. Si se pierde, hay que revocarlo y crear otro.',
    });
  } catch (err) {
    return apiError('superadmin/partner-tokens POST', err, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => ({}))) as { id?: string; reason?: string };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json({ success: false, error: 'Token inválido.' }, { status: 400 });
    }

    const admin = createAdminClient();
    // Se marca, no se borra: perder el rastro de que existió es lo contrario
    // de lo que se quiere después de un incidente.
    const { data, error } = await admin
      .from('partner_api_tokens')
      .update({
        is_active: false,
        revoked_at: new Date().toISOString(),
        revoked_reason: typeof body.reason === 'string' ? body.reason.slice(0, 300) : null,
      })
      .eq('id', id)
      .select(COLS)
      .single();
    if (error) return apiError('superadmin/partner-tokens PATCH', error, { status: 500 });

    return NextResponse.json({ success: true, token: data });
  } catch (err) {
    return apiError('superadmin/partner-tokens PATCH', err, { status: 500 });
  }
}
