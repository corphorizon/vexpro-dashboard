// ─────────────────────────────────────────────────────────────────────────────
// FairPay BANKING — Autenticación (por tenant)
//
// OJO: esto NO es el portal de cobros. FairPay tiene DOS sistemas distintos,
// con credenciales distintas:
//
//   · portal.fairpay.online   → cobros/depósitos (getTransactionList).
//                               Credencial provider 'fairpay'. Ver ./auth.ts.
//   · banking.fairpay.online  → cuentas bancarias, y es DONDE VIVE EL BALANCE.
//                               Credencial provider 'fairpay_banking'.
//
// Por eso este módulo tiene su propio caché de token y NO reusa el de
// ./auth.ts: mezclarlos haría que un tenant mande el JWT del portal de cobros
// al banking (o al revés) y coma 401 sin explicación evidente.
//
// Flujo verificado contra producción (2026-08-17, credencial real de Vex Pro):
//
//   POST {baseUrl}/api/auth/getAccessToken
//     Content-Type: application/x-www-form-urlencoded
//     body: api_key=<apiKey>
//   → {"result":true,"access_token":"<JWT de 3 segmentos>"}
//
//   Luego: Authorization: Bearer <JWT>
//
// Detalles que NO son opcionales (los tres se verificaron rompiendo):
//   1. El sobre del banking es {result, access_token} — NO el {status, code,
//      data:{scalar}} del portal de cobros.
//   2. Mandar la api_key CRUDA como Bearer devuelve 401 "Wrong number of
//      segments": hay que canjearla por el JWT sí o sí. Por eso validamos que
//      el token tenga 3 segmentos antes de cachearlo — un token trunco
//      cacheado 50 minutos serían 50 minutos de 401 silenciosos.
//   3. El banking responde 403 (antes de llegar a la app) a curl y a cualquier
//      User-Agent con pinta de bot. Va un UA de navegador.
//
// IPv4: mismo motivo que ./auth.ts y UniPayment — el host puede no responder
// bien por IPv6 desde el runtime de Vercel.
// ─────────────────────────────────────────────────────────────────────────────

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import {
  resolveFairpayBankingCredentials,
  FAIRPAY_BANKING_DEFAULT_BASE_URL,
} from '../credentials';

const LOG = '[fairpay-banking]';

/**
 * User-Agent de navegador. El banking corta con 403 en el borde a los UA
 * "de herramienta" (curl, node-fetch, el nuestro identificable tipo Pay-Pros):
 * la petición ni siquiera llega a la aplicación. No es una preferencia
 * estética, es la diferencia entre 200 y 403.
 */
export const FAIRPAY_BANKING_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** El cron no puede colgarse por un proveedor. */
const TIMEOUT_MS = 12_000;

/**
 * TTL del caché. No sabemos la expiración real que declara el JWT del banking
 * (no la firma nadie en la doc, que no existe), así que usamos el mismo
 * criterio conservador que el portal de cobros: 50 minutos.
 */
const TOKEN_TTL_MS = 50 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/** Caché por tenant. Sin fallback a env: no existe credencial global de banking. */
const tokenCache = new Map<string, CachedToken>();

/** Cabeceras comunes a toda llamada al banking (incluida la de auth). */
export function fairpayBankingHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': FAIRPAY_BANKING_USER_AGENT,
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Un JWT tiene 3 segmentos separados por punto. Menos que eso el banking lo rechaza. */
function looksLikeJwt(value: unknown): value is string {
  return typeof value === 'string' && value.split('.').length === 3 && value.trim().length > 0;
}

/**
 * True cuando el tenant tiene credencial de FairPay Banking cargada.
 * Async porque la credencial vive en la DB (api_credentials).
 */
export async function isFairpayBankingEnabled(
  companyId?: string | null,
): Promise<boolean> {
  const creds = await resolveFairpayBankingCredentials(companyId);
  return !!creds;
}

/**
 * Base URL del banking para el tenant (override en extra_config.base_url,
 * si no el default). Sin barra final — `resolveFairpayBankingCredentials`
 * ya la recorta.
 */
export async function getFairpayBankingBaseUrl(
  companyId?: string | null,
): Promise<string> {
  const creds = await resolveFairpayBankingCredentials(companyId);
  return creds?.baseUrl ?? FAIRPAY_BANKING_DEFAULT_BASE_URL;
}

/** Vacía el caché de tokens. Solo para tests. */
export function __clearFairpayBankingTokenCache(): void {
  tokenCache.clear();
}

/**
 * Devuelve (o canjea) el access token del banking para el tenant.
 *
 * Lanza con mensajes descriptivos —y SIN volcar la api_key ni el token— para
 * que el cron los guarde en `fairpay_error` y sean legibles por un humano.
 */
export async function getFairpayBankingToken(
  companyId?: string | null,
): Promise<string> {
  const now = Date.now();
  const key = companyId ?? '';

  // Margen de 60 s para no usar un token que expira en mitad de la request.
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - now > 60_000) {
    return cached.accessToken;
  }

  const creds = await resolveFairpayBankingCredentials(companyId);
  if (!creds) {
    throw new Error('FairPay Banking no está configurado para esta empresa');
  }

  const body = new URLSearchParams({ api_key: creds.apiKey });

  let response: Response;
  try {
    response = await fetch(`${creds.baseUrl}/api/auth/getAccessToken`, {
      method: 'POST',
      headers: {
        ...fairpayBankingHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'error de red';
    // Nunca la api_key en el log: solo el tenant y el motivo.
    console.error(`${LOG} fallo de red pidiendo token`, { companyId, reason });
    throw new Error(`FairPay Banking getAccessToken: fallo de red — ${reason}`);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    // 403 acá = User-Agent bloqueado en el borde; 401 = api_key inválida.
    console.warn(`${LOG} getAccessToken no-OK`, { companyId, status: response.status });
    throw new Error(
      `FairPay Banking getAccessToken → ${response.status} ${response.statusText}: ${errBody.slice(0, 200)}`,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error('FairPay Banking getAccessToken: la respuesta no es JSON');
  }

  const envelope = (json ?? {}) as { result?: unknown; access_token?: unknown; message?: unknown };

  if (envelope.result === false) {
    const msg = typeof envelope.message === 'string' ? envelope.message : 'result=false';
    throw new Error(`FairPay Banking getAccessToken: ${msg}`);
  }

  if (!looksLikeJwt(envelope.access_token)) {
    // No imprimimos el valor: podría ser un token parcial (secreto igual).
    throw new Error(
      'FairPay Banking getAccessToken: la respuesta no trae un access_token con forma de JWT (3 segmentos)',
    );
  }

  const fresh: CachedToken = {
    accessToken: envelope.access_token,
    expiresAt: now + TOKEN_TTL_MS,
  };
  tokenCache.set(key, fresh);
  return fresh.accessToken;
}
