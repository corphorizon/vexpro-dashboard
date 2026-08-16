// ─────────────────────────────────────────────────────────────────────────────
// FairPay — Balance de la cuenta (por tenant)
//
// HISTORIA (importa para no volver a caer): hasta 2026-08-17 este archivo
// pegaba a POST portal.fairpay.online/api/v1/getBalance, un endpoint ADIVINADO
// a partir del naming de FairPay (getTransactionList, getTransaction…). Nunca
// existió: devolvía 404 todos los días y el cron guardaba el error. El balance
// no vive en el portal de cobros.
//
// FairPay tiene DOS sistemas separados:
//   · portal.fairpay.online  → cobros/depósitos (ver ./transactions.ts).
//   · banking.fairpay.online → cuentas bancarias, y ACÁ está el balance.
// Credenciales distintas: provider 'fairpay' vs 'fairpay_banking'.
//
// Endpoint verificado contra producción (2026-08-17, credencial real):
//
//   GET {baseUrl}/api/v1/accounts     con Authorization: Bearer <JWT>
//   → [
//       {"id":26716,"account_number":"FP20227712","account_type":"Corporate Account",
//        "currency":"USD","balance":"0.00","status":1,"opening_balance":"0.00", …},
//       …
//     ]
//
// Dos detalles del proveedor:
//   · `balance` viene como STRING ("0.00"), no como número.
//   · El tenant puede tener VARIAS cuentas (Vex Pro tiene 4: Personal EUR,
//     Personal USD, Corporate EUR, Corporate USD).
//
// POR QUÉ DEVOLVEMOS UNA SOLA CUENTA EN `balances`
// ------------------------------------------------
// El cron (src/app/api/cron/daily-balance-snapshot/route.ts) SUMA todas las
// entradas de `balances` en un único total y lo asienta como el saldo del
// canal 'fairpay'. Si devolviéramos las 4 cuentas, sumaría euros con dólares
// y asentaría un número que no existe. Por eso `balances` trae SOLO la cuenta
// elegida, y el resto viaja en `otherAccounts`, que es informativo y nadie
// suma.
//
// ORDEN DE SELECCIÓN DE CUENTA (documentado a propósito):
//   1. Cuenta CORPORATE en la moneda de la empresa (companies.currency,
//      default 'USD') — es la cuenta operativa del negocio.
//   2. Si no hay, la PRIMERA cuenta Corporate en cualquier moneda.
//   3. Si no hay ninguna Corporate, la primera cuenta en la moneda de la
//      empresa.
//   4. Si nada de lo anterior aplica → error explícito con el crudo. NO se
//      cae a "la primera cuenta que haya": elegir a ciegas entre cuentas de
//      distinta moneda/titularidad es exactamente cómo se asienta plata
//      inventada en el libro.
//
// Mismo criterio que Pay-Pros: ante un shape desconocido devolvemos error con
// el JSON crudo truncado, nunca un número inventado.
// ─────────────────────────────────────────────────────────────────────────────

import { createAdminClient } from '@/lib/supabase/admin';
import {
  getFairpayBankingToken,
  getFairpayBankingBaseUrl,
  isFairpayBankingEnabled,
  fairpayBankingHeaders,
} from './banking-auth';

const LOG = '[fairpay-banking]';

/** El cron no puede colgarse por un proveedor. */
const TIMEOUT_MS = 12_000;

const ACCOUNTS_ENDPOINT = '/api/v1/accounts';

/** Cómo llama FairPay a la cuenta corporativa (comparación case-insensitive). */
const CORPORATE_MARKER = 'corporate';

export interface FairpayBalanceEntry {
  currency: string;
  availableBalance: number;
  rawCurrencyAmount?: number;
  /** Nº de cuenta del banking (ej. 'FP20227712'). Informativo. */
  accountNumber?: string;
  /** 'Corporate Account' | 'Personal Account' | lo que devuelva FairPay. */
  accountType?: string;
}

export interface FairpayBalanceResult {
  /**
   * SOLO la cuenta elegida. El cron suma este array: más de una entrada
   * mezclaría monedas. Ver "ORDEN DE SELECCIÓN" arriba.
   */
  balances: FairpayBalanceEntry[];
  error?: string;
  /**
   * Legado del endpoint adivinado (ya borrado). El cron todavía lo mira para
   * mandar un aviso a Sentry; hoy NUNCA se setea porque el endpoint real
   * existe y está verificado. Se deja para no romper su tipado.
   */
  endpointMissing?: boolean;
  /** No hay credenciales para este tenant: no es una falla que valga avisar. */
  notConfigured?: boolean;
  /**
   * Las demás cuentas del tenant (otras monedas / personales). Informativo:
   * nadie las suma ni las asienta.
   */
  otherAccounts?: FairpayBalanceEntry[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** El banking manda los importes como string ("0.00"). Tolera número también. */
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

/**
 * Normaliza una fila de /api/v1/accounts. Devuelve null si no tiene un
 * balance numérico usable: una cuenta sin importe reconocible no puede
 * asentar nada.
 */
export function parseFairpayAccount(raw: unknown): FairpayBalanceEntry | null {
  if (!isRecord(raw)) return null;
  const balance = toNumber(raw.balance);
  if (balance === null) return null;
  const currency =
    typeof raw.currency === 'string' && raw.currency.trim()
      ? raw.currency.trim().toUpperCase()
      : 'USD';
  return {
    currency,
    availableBalance: balance,
    accountNumber: typeof raw.account_number === 'string' ? raw.account_number : undefined,
    accountType: typeof raw.account_type === 'string' ? raw.account_type : undefined,
  };
}

/**
 * Extrae la lista de cuentas tolerando array directo (lo que devuelve prod)
 * o envuelto en {data:[…]} (por si algún día lo cambian, como el portal de
 * cobros). Devuelve null cuando no hay lista reconocible.
 */
export function extractAccountList(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (isRecord(json) && Array.isArray(json.data)) return json.data;
  return null;
}

const isCorporate = (e: FairpayBalanceEntry) =>
  (e.accountType ?? '').toLowerCase().includes(CORPORATE_MARKER);

/**
 * Elige la cuenta a asentar. Ver "ORDEN DE SELECCIÓN DE CUENTA" en la cabecera
 * del archivo — el orden es parte del contrato, no un detalle interno.
 */
export function selectFairpayAccount(
  accounts: FairpayBalanceEntry[],
  companyCurrency: string,
): FairpayBalanceEntry | null {
  const cur = companyCurrency.toUpperCase();
  return (
    accounts.find((a) => isCorporate(a) && a.currency === cur) ??
    accounts.find(isCorporate) ??
    accounts.find((a) => a.currency === cur) ??
    null
  );
}

/**
 * Moneda de la empresa (companies.currency). Se lee con el admin client
 * porque el cron corre sin sesión de usuario. Cualquier problema → 'USD',
 * que es el default de la columna en la DB.
 */
async function getCompanyCurrency(companyId: string): Promise<string> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('companies')
      .select('currency')
      .eq('id', companyId)
      .maybeSingle<{ currency: string | null }>();
    if (error || !data?.currency) return 'USD';
    return data.currency.trim().toUpperCase() || 'USD';
  } catch {
    return 'USD';
  }
}

// ── Fetch principal ────────────────────────────────────────────────────────

export async function fetchFairpayBalances(
  companyId?: string | null,
): Promise<FairpayBalanceResult> {
  // Sin credencial no se llama a nada. El cron distingue este caso con
  // `notConfigured` y NO lo cuenta como falla (route.ts: `if (!fp.notConfigured)`).
  if (!(await isFairpayBankingEnabled(companyId))) {
    return {
      balances: [],
      error: 'FairPay Banking no está configurado para esta empresa',
      notConfigured: true,
    };
  }

  try {
    const baseUrl = await getFairpayBankingBaseUrl(companyId);
    const token = await getFairpayBankingToken(companyId);

    const response = await fetch(`${baseUrl}${ACCOUNTS_ENDPOINT}`, {
      method: 'GET',
      // El User-Agent de navegador va en fairpayBankingHeaders: sin él el
      // banking corta con 403 antes de llegar a la aplicación.
      headers: fairpayBankingHeaders(token),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await response.text().catch(() => '');

    if (!response.ok) {
      console.warn(`${LOG} accounts no-OK`, { companyId, status: response.status });
      return {
        balances: [],
        error: `FairPay Banking ${ACCOUNTS_ENDPOINT} → ${response.status} ${response.statusText}: ${truncateRaw(text, 200)}`,
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        balances: [],
        error: `FairPay Banking ${ACCOUNTS_ENDPOINT}: la respuesta no es JSON. Crudo: ${truncateRaw(text)}`,
      };
    }

    const list = extractAccountList(json);
    if (!list) {
      console.warn(`${LOG} shape desconocido`, { companyId, raw: truncateRaw(json, 200) });
      return {
        balances: [],
        error:
          `FairPay Banking ${ACCOUNTS_ENDPOINT} respondió OK pero no trae una lista de cuentas reconocible. ` +
          `Actualizar extractAccountList() en src/lib/api-integrations/fairpay/balances.ts. Crudo: ${truncateRaw(json)}`,
      };
    }

    const accounts = list
      .map(parseFairpayAccount)
      .filter((a): a is FairpayBalanceEntry => a !== null);

    if (accounts.length === 0) {
      console.warn(`${LOG} sin cuentas parseables`, { companyId, raw: truncateRaw(json, 200) });
      return {
        balances: [],
        error:
          `FairPay Banking ${ACCOUNTS_ENDPOINT} respondió OK pero ninguna cuenta trae un balance numérico. ` +
          `Crudo: ${truncateRaw(json)}`,
      };
    }

    const currency = companyId ? await getCompanyCurrency(companyId) : 'USD';
    const chosen = selectFairpayAccount(accounts, currency);

    if (!chosen) {
      // Hay cuentas pero ninguna califica (ni Corporate, ni en la moneda de
      // la empresa). Preferimos avisar antes que elegir una al azar.
      return {
        balances: [],
        error:
          `FairPay Banking: ninguna cuenta califica para asentar (moneda de la empresa: ${currency}; ` +
          `cuentas: ${accounts.map((a) => `${a.accountNumber ?? '?'}/${a.accountType ?? '?'}/${a.currency}`).join(', ')}).`,
        otherAccounts: accounts,
      };
    }

    return {
      balances: [chosen],
      otherAccounts: accounts.filter((a) => a !== chosen),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error desconocido consultando FairPay Banking';
    console.error(`${LOG} fallo consultando balance`, { companyId, error: msg });
    return { balances: [], error: msg };
  }
}
