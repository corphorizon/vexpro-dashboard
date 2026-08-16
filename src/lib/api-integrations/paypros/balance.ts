// ─────────────────────────────────────────────────────────────────────────────
// Pay-Pros — Balance del merchant (por tenant)
//
// GET {baseUrl}v2/getBalance
//   · Auth: Basic base64(merchantID:apiKey)  ← NO es el sign_key del webhook.
//   · Header User-Agent OBLIGATORIO: sin él Pay-Pros rechaza la llamada.
//   · Pay-Pros exige que la IP de origen esté whitelisteada. Vercel no tiene
//     IP fija, por eso la llamada sale por `proxiedFetch` (proxy SOCKS5 Fixie,
//     misma IP estática que ya usan Coinsbuy y UniPayment). Sin FIXIE_URL
//     (local) `proxiedFetch` cae al fetch normal y la API va a responder con
//     error de IP: es lo esperado en dev.
//
// PARSEO DEFENSIVO A PROPÓSITO
// ----------------------------
// La documentación pública describe el request pero se corta antes de mostrar
// el cuerpo de la respuesta de getBalance. Lo único seguro es el sobre común
// de la API: {"status":"E00","response":"OK","datetime":"..."} donde E00 =
// éxito (el resto de los códigos están en developers.pay-pros.com/error-codes).
//
// Por eso NO inventamos un shape y lo damos por cierto: probamos las formas
// plausibles en orden y, si ninguna da un número, devolvemos un error con el
// JSON crudo (truncado) para ajustar el parser con la PRIMERA respuesta real
// en vez de asentar un saldo inventado. Un saldo mal parseado entra al libro
// por canal como ajuste de conciliación: es plata en los reportes.
// ─────────────────────────────────────────────────────────────────────────────

import { resolvePayprosCredentials } from '../credentials';
import { proxiedFetch } from '../proxy';
import { withRetry } from '../retry';

const LOG = '[paypros-balance]';

/** El cron no puede colgarse por un proveedor: 10 s y afuera. */
const TIMEOUT_MS = 10_000;

/** Pay-Pros exige User-Agent; mandamos uno identificable. */
const USER_AGENT = 'SmartDashboard/1.0 (+https://dashboard.horizonconsulting.ai)';

/** Código de éxito del sobre común de la API. */
const OK_STATUS = 'E00';

export interface PayprosBalanceResult {
  balance: number | null;
  currency: string | null;
  isMock: false;
  error?: string;
  /** JSON crudo cuando el shape no se reconoce, para ajustar el parser. */
  raw?: unknown;
  /** No hay credenciales para este tenant: no es una falla que valga avisar. */
  notConfigured?: boolean;
}

// ── Helpers de parseo ──────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Convierte a número tolerando strings numéricos: el webhook de Pay-Pros
 * manda los importes como texto ("10"), así que es probable que el balance
 * venga igual. Devuelve null para cualquier cosa que no sea un número finito.
 */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readCurrency(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().toUpperCase();
  }
  return null;
}

/**
 * Busca un balance reconocible dentro de la respuesta.
 *
 * FORMATO REAL (primera llamada a prod, 2026-08-16, Vex Pro):
 *   {"status":"E00","response":"OK","datetime":"...",
 *    "balaces":[{"currency":"USD","available_balance":6073}]}
 * Sí: la clave viene con el typo "balaces" (sic) del lado de Pay-Pros, y el
 * campo es "available_balance". Ninguna doc pública lo mostraba: lo destapó
 * el mensaje de "shape no reconocible" del cron. Se acepta ese formato
 * PRIMERO, y también "balances" bien escrito por si algún día lo corrigen.
 *
 * Después, formas genéricas de respaldo (de la más simple a la más anidada):
 *   { balance: 123 } · { balance: {available|amount|balance} } ·
 *   { available: 123 } · { amount: 123 }
 *
 * Todas aceptan el número como string. Devuelve null si nada califica.
 */
export function parsePayprosBalance(
  data: unknown,
): { balance: number; currency: string | null } | null {
  if (!isRecord(data)) return null;

  const topCurrency = readCurrency(data.currency, data.currency_code);

  // 0) Formato real de Pay-Pros: lista por moneda bajo "balaces" (typo suyo)
  //    o "balances", con available_balance. Primera entrada reconocible —
  //    hoy liquidan en una sola moneda por merchant.
  const list = Array.isArray(data.balaces) ? data.balaces
             : Array.isArray(data.balances) ? data.balances
             : null;
  if (list) {
    for (const item of list) {
      if (!isRecord(item)) continue;
      const n = toNumber(item.available_balance) ?? toNumber(item.available)
             ?? toNumber(item.amount) ?? toNumber(item.balance);
      if (n !== null) {
        return { balance: n, currency: readCurrency(item.currency, item.currency_code, topCurrency) };
      }
    }
  }

  // 1) balance escalar
  const flat = toNumber(data.balance);
  if (flat !== null) return { balance: flat, currency: topCurrency };

  // 2) balance como objeto
  if (isRecord(data.balance)) {
    const b = data.balance;
    const n = toNumber(b.available) ?? toNumber(b.amount) ?? toNumber(b.balance);
    if (n !== null) {
      return { balance: n, currency: readCurrency(b.currency, b.currency_code, topCurrency) };
    }
  }

  // 3) available en la raíz
  const available = toNumber(data.available);
  if (available !== null) return { balance: available, currency: topCurrency };

  // 4) amount en la raíz
  const amount = toNumber(data.amount);
  if (amount !== null) return { balance: amount, currency: topCurrency };

  return null;
}

/** Recorta el crudo para que quepa en un mensaje de error / notificación. */
function truncateRaw(value: unknown, max = 500): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── Fetch principal ────────────────────────────────────────────────────────

export async function fetchPayprosBalance(
  companyId?: string | null,
): Promise<PayprosBalanceResult> {
  const creds = await resolvePayprosCredentials(companyId);
  if (!creds) {
    // Sin credenciales no se llama a nada: la empresa simplemente no usa
    // Pay-Pros. El cron lo distingue de una falla real con `notConfigured`.
    return { balance: null, currency: null, isMock: false, error: 'not_configured', notConfigured: true };
  }

  // baseUrl termina en '/' (default de credentials.ts), pero un override por
  // tenant podría no hacerlo: normalizamos antes de resolver con URL para no
  // duplicar ni comerse la barra.
  const base = creds.baseUrl.endsWith('/') ? creds.baseUrl : `${creds.baseUrl}/`;
  const url = new URL('v2/getBalance', base).toString();

  const auth = Buffer.from(`${creds.merchantId}:${creds.apiKey}`).toString('base64');

  try {
    const { status, body } = await withRetry(async () => {
      const res = await proxiedFetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const text = await res.text().catch(() => '');
      if (!res.ok) {
        // 403 acá casi siempre es "IP no whitelisteada": el mensaje crudo lo
        // aclara y no contiene secretos (la credencial va en el header).
        throw new Error(
          `Pay-Pros getBalance ${res.status} ${res.statusText}: ${truncateRaw(text, 200)}`,
        );
      }
      return { status: res.status, body: text };
    });

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      const msg = `Pay-Pros getBalance (HTTP ${status}) respondió algo que no es JSON: ${truncateRaw(body)}`;
      console.warn(`${LOG} respuesta no-JSON`, { companyId, snippet: truncateRaw(body, 200) });
      return { balance: null, currency: null, isMock: false, error: msg, raw: body };
    }

    // Sobre común de la API: status 'E00' = OK. Si viene otro código, es un
    // error de negocio devuelto con HTTP 200 y NO hay que parsear balance.
    if (isRecord(json) && typeof json.status === 'string' && json.status !== OK_STATUS) {
      const msg =
        `Pay-Pros getBalance devolvió status=${json.status}` +
        (typeof json.response === 'string' ? ` response=${json.response}` : '') +
        ' (ver developers.pay-pros.com/error-codes)';
      console.warn(`${LOG} status de error`, { companyId, status: json.status });
      return { balance: null, currency: null, isMock: false, error: msg, raw: json };
    }

    const parsed = parsePayprosBalance(json);
    if (!parsed) {
      const msg =
        'Pay-Pros getBalance respondió OK pero el shape no contiene un balance reconocible. ' +
        'Actualizar parsePayprosBalance() en src/lib/api-integrations/paypros/balance.ts con la respuesta real. ' +
        `Crudo: ${truncateRaw(json)}`;
      console.warn(`${LOG} shape desconocido`, { companyId, raw: truncateRaw(json) });
      return { balance: null, currency: null, isMock: false, error: msg, raw: json };
    }

    return { balance: parsed.balance, currency: parsed.currency, isMock: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error desconocido consultando Pay-Pros';
    console.error(`${LOG} fallo de red`, { companyId, error: msg });
    return { balance: null, currency: null, isMock: false, error: msg };
  }
}
