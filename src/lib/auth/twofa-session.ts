// ─────────────────────────────────────────────────────────────────────────────
// SELLO DE SESIÓN 2FA  (auditoría 2026-08 — hallazgo crítico de login)
//
// EL PROBLEMA QUE RESUELVE
// La sesión de Supabase la creaba el NAVEGADOR (`supabase.auth.
// signInWithPassword`) DESPUÉS de que el servidor validara el PIN. El token
// resultante es indistinguible de uno creado sin pasar por ningún control:
// no lleva claim, cookie ni flag de "pasé el 2FA". Cualquiera con la
// contraseña podía hacer
//     POST https://<proyecto>.supabase.co/auth/v1/token?grant_type=password
// con la anon key (pública, viaja en el bundle) y entrar: sin PIN, sin
// bloqueo de cuenta y sin throttle por IP. El 2FA era decorativo para quien
// no usara la UI.
//
// LA SOLUCIÓN
// Un SELLO fuera del JWT: una cookie httpOnly firmada con HMAC-SHA256 por el
// servidor, que sólo se emite en los puntos donde el usuario PROBÓ el segundo
// factor (o donde probadamente no le corresponde). El guardián
// (`updateSession` + `verifyAuth`/`verifyAdminAuth`/`verifySuperadminAuth`)
// exige el sello cuando `twofa_enabled = true`. El atacante no tiene la clave
// HMAC (nunca sale del servidor), así que no puede fabricarlo: su token de
// GoTrue ya no le alcanza para nada.
//
// POR QUÉ NO `app_metadata` (opción "a" del encargo)
//   · Sólo entra al JWT en el PRÓXIMO token, y el token lo pide el navegador
//     — el orden es frágil.
//   · Peor: una vez escrito, TODO token futuro de ese usuario lo lleva,
//     incluido el que se saca el atacante con `grant_type=password`. Un sello
//     pegado al USUARIO no distingue sesiones; el agujero seguiría abierto.
//   · Atarlo a `session_id` exigiría una allow-list en la DB consultada en
//     cada request (un round-trip por navegación).
//
// POR QUÉ NO mover el sign-in al servidor (opción "b")
//   Mover `signInWithPassword` al servidor NO cierra nada por sí solo: GoTrue
//   sigue siendo accesible con la anon key, así que el atacante se sigue
//   fabricando la sesión igual. Sólo cambia QUIÉN pide el token. Encima toca
//   toda la escritura de cookies de auth — la superficie más peligrosa del
//   sistema. El sello es ortogonal y funciona con el flujo actual intacto.
//
// POR QUÉ NO el MFA nativo (AAL2, opción "c")
//   Es lo correcto a futuro (el `aal` viaja firmado en el JWT), pero exige
//   migrar los secretos TOTP existentes a `auth.mfa_factors` — cada usuario
//   re-enrolando su authenticator. Es un proyecto aparte, no un parche de
//   seguridad urgente.
//
// FAIL-SAFE
//   · Sin material de clave → `twofaSealAvailable()` es false y NADIE queda
//     afuera (se registra un error). Preferimos "usable" a "todos bloqueados".
//   · Interruptor de emergencia: TWOFA_SESSION_ENFORCE=off desactiva el
//     control sin tocar código, por si algo sale mal en producción.
// ─────────────────────────────────────────────────────────────────────────────

/** Nombre de la cookie del sello. httpOnly: el JS de la página no la ve. */
export const TWOFA_COOKIE = 'fd_2fa';

/**
 * Vida del sello. El auto-logout por inactividad es de 2 h, así que 12 h es
 * holgado: en la práctica la sesión muere antes que el sello y nadie ve un
 * pedido de PIN "sorpresa" a mitad de la jornada.
 */
export const TWOFA_TTL_MS = 12 * 60 * 60 * 1000;

const VERSION = 'v1';

/**
 * Material de clave. `TWOFA_SESSION_SECRET` es opcional y preferido; si no
 * está, caemos a la service role key — que YA es obligatoria en este proyecto
 * (`createAdminClient` no arranca sin ella) y nunca se expone al cliente.
 *
 * Deliberado: NO inventamos una variable de entorno nueva y obligatoria. Si
 * faltara en producción, el login se caería para todos — exactamente el
 * desastre que este cambio tiene prohibido causar.
 */
function secretMaterial(): string | null {
  const s = process.env.TWOFA_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return s && s.length > 0 ? s : null;
}

/** Interruptor de emergencia: TWOFA_SESSION_ENFORCE=off apaga el control. */
export function twofaEnforcementDisabled(): boolean {
  return (process.env.TWOFA_SESSION_ENFORCE || '').toLowerCase() === 'off';
}

/**
 * ¿Se puede aplicar el control? False = falta la clave o está el kill switch.
 * En ese caso los guardianes NO bloquean a nadie (fail-open explícito).
 */
export function twofaSealAvailable(): boolean {
  if (twofaEnforcementDisabled()) return false;
  if (!secretMaterial()) {
    console.error(
      '[twofa-session] Sin material de clave (TWOFA_SESSION_SECRET / SUPABASE_SERVICE_ROLE_KEY): el sello 2FA NO se está aplicando.',
    );
    return false;
  }
  return true;
}

// WebCrypto y no `node:crypto`: funciona igual en el runtime Node (Next 16
// corre el proxy/middleware en Node por defecto) y en Edge, por si algún día
// este módulo se importa desde ahí. Node 20+ expone globalThis.crypto.
async function hmac(payload: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(payload));
  return base64url(new Uint8Array(sig));
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Comparación en tiempo constante (evita filtrar la firma por timing). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Emite el sello para un `auth.users.id`. Devuelve null si no hay clave
 * (el caller simplemente no setea la cookie; nadie queda bloqueado porque
 * `twofaSealAvailable()` también es false y el guardián no exige nada).
 */
export async function mintTwofaSeal(
  authUserId: string,
  now: number = Date.now(),
): Promise<string | null> {
  const key = secretMaterial();
  if (!key) return null;
  const exp = now + TWOFA_TTL_MS;
  const payload = `${VERSION}.${authUserId}.${exp}`;
  const sig = await hmac(payload, key);
  return `${authUserId}.${exp}.${sig}`;
}

/**
 * ¿Este sello es válido PARA ESTE usuario y todavía no venció?
 * Cualquier anomalía (formato, otro usuario, vencido, firma mala) es false.
 */
export async function verifyTwofaSeal(
  token: string | undefined | null,
  authUserId: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const key = secretMaterial();
  if (!key) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [sub, expRaw, sig] = parts;

  // Atado al usuario: un sello robado de otra cuenta no sirve.
  if (sub !== authUserId) return false;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) return false;

  const expected = await hmac(`${VERSION}.${sub}.${exp}`, key);
  return safeEqual(sig, expected);
}

/** Opciones de la cookie. Mismo objeto para setear y para borrar. */
export function twofaCookieOptions(maxAgeSeconds?: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds ?? Math.floor(TWOFA_TTL_MS / 1000),
  };
}
