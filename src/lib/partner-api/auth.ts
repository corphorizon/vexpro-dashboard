// ─────────────────────────────────────────────────────────────────────────────
// Autenticación de los aplicativos que consumen nuestra API (Atlas y compañía).
//
// NO son sesiones de usuario: son máquinas hablando con máquinas. Cada
// aplicativo tiene su token, atado a UNA empresa y a una lista de permisos.
//
// ── LO QUE ESTE MÓDULO PROTEGE ─────────────────────────────────────────────
//  · El token nunca se guarda: se guarda su SHA-256. La búsqueda es POR el
//    hash, así que no hay comparación de secretos en nuestro código y no hay
//    donde filtrar tiempo.
//  · El `company_id` sale SIEMPRE del token, jamás de un parámetro. Es la
//    única forma de que un token de Atlas para Vex Pro no pueda pedir datos de
//    otra organización cambiando un query param.
//  · Un token revocado o inactivo se rechaza aunque el hash exista.
//  · Los permisos se piden explícitos: un token sin `scopes` no puede nada.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Prefijo visible del token. Ayuda a reconocerlo en un log sin revelarlo. */
const TOKEN_PREFIX = 'sdk_';
/** Bytes de entropía. 32 bytes = 256 bits: no se adivina por fuerza bruta. */
const TOKEN_BYTES = 32;

export type PartnerScope = 'mt5:read';

export interface PartnerAuth {
  tokenId: string;
  companyId: string;
  appName: string;
  scopes: string[];
}

export interface GeneratedToken {
  /** El token en claro. Se muestra UNA vez y no se puede recuperar. */
  token: string;
  prefix: string;
  hash: string;
}

/** Genera un token nuevo. El llamador guarda `hash` y `prefix`, nunca `token`. */
export function generatePartnerToken(): GeneratedToken {
  const secret = randomBytes(TOKEN_BYTES).toString('base64url');
  const token = `${TOKEN_PREFIX}${secret}`;
  return { token, prefix: token.slice(0, 12), hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Verifica el token de la petición.
 *
 * Devuelve un `NextResponse` de error cuando no pasa, siguiendo el mismo
 * patrón que `verifyAdminAuth`. Los mensajes son deliberadamente genéricos: a
 * un cliente que no está autenticado no se le cuenta si el token no existe,
 * está revocado o le falta un permiso — eso sólo ayudaría a quien sondea.
 * El motivo real va al log del servidor.
 */
export async function verifyPartnerAuth(
  request: NextRequest,
  admin: SupabaseClient,
  required: PartnerScope[],
): Promise<PartnerAuth | NextResponse> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token || !token.startsWith(TOKEN_PREFIX)) {
    return unauthorized('sin token o con formato inválido');
  }

  const { data, error } = await admin
    .from('partner_api_tokens')
    .select('id, company_id, app_name, scopes, is_active, revoked_at, request_count')
    .eq('token_hash', hashToken(token))
    .maybeSingle();

  if (error) {
    console.error('[partner-api] fallo al resolver el token:', error.message);
    return NextResponse.json({ success: false, error: 'Error interno' }, { status: 500 });
  }
  if (!data) return unauthorized('token desconocido');
  if (!data.is_active || data.revoked_at) return unauthorized(`token revocado (${data.app_name})`);

  const scopes = Array.isArray(data.scopes) ? data.scopes.map(String) : [];
  const missing = required.filter((s) => !scopes.includes(s));
  if (missing.length > 0) {
    return unauthorized(`a ${data.app_name} le falta el permiso ${missing.join(', ')}`);
  }

  // Rastro de uso. No bloquea la respuesta: si falla, la petición sigue — pero
  // se registra, porque un contador que deja de subir en silencio hace creer
  // que un token está muerto cuando está vivo.
  void admin
    .from('partner_api_tokens')
    .update({
      last_used_at: new Date().toISOString(),
      last_used_ip: clientIp(request),
      request_count: Number(data.request_count ?? 0) + 1,
    })
    .eq('id', data.id)
    .then(({ error: upErr }) => {
      if (upErr) console.warn('[partner-api] no se pudo registrar el uso:', upErr.message);
    });

  return {
    tokenId: String(data.id),
    companyId: String(data.company_id),
    appName: String(data.app_name),
    scopes,
  };
}

function unauthorized(reason: string): NextResponse {
  console.warn('[partner-api] rechazado:', reason);
  return NextResponse.json(
    { success: false, error: 'No autorizado' },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
  );
}

export function clientIp(request: NextRequest): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0]!.trim() : request.headers.get('x-real-ip');
}
