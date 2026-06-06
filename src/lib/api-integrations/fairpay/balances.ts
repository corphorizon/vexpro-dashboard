// ─────────────────────────────────────────────────────────────────────────────
// FairPay — Balance fetcher (per-tenant)
//
// Kevin (2026-06-06): el cron daily-balance-snapshot necesita un balance
// diario para FairPay además de Coinsbuy/UniPayment. La documentación
// pública de FairPay no expone un endpoint de balance estandarizado
// (a diferencia de UniPayment que tiene /v1.0/wallet/balance), así que
// esta implementación es defensiva:
//
//   1. Intenta POST /api/v1/getBalance (mejor adivinanza basada en su
//      patrón de naming — getTransactionList, getTransaction, etc.).
//   2. Si la API responde con balance estructurado, lo devuelve.
//   3. Si responde 404 / 401 / shape no esperada → devuelve
//      `{ balances: [], error: 'FairPay no expone balance público...' }`
//      sin throw. El cron ya captura el `error` y lo guarda en `entry.fairpay_error`
//      para revisión humana sin romper el resto del snapshot.
//
// Cuando FairPay confirme el endpoint oficial o expongan documentación,
// reemplazar `BALANCE_ENDPOINT` por el correcto y ajustar el parser.
// ─────────────────────────────────────────────────────────────────────────────

import { getFairpayToken, getFairpayBaseUrl, isFairpayEnabled } from './auth';

const BALANCE_ENDPOINT = '/api/v1/getBalance';

export interface FairpayBalanceEntry {
  currency: string;
  availableBalance: number;
  rawCurrencyAmount?: number;
}

export interface FairpayBalanceResult {
  balances: FairpayBalanceEntry[];
  error?: string;
  /** True when the credentials are configured but the endpoint returned
   * an unexpected response (404, malformed payload, etc.). Lets the cron
   * distinguish "not configured" from "configured but FairPay didn't
   * cooperate" for better alerting. */
  endpointMissing?: boolean;
}

// FairPay's docs show responses shaped like `{ status, code, data: { ... } }`,
// where `data` may be either a scalar, an object, or an array depending on
// the endpoint. The parser below is tolerant: it accepts any of:
//   { data: { available_balance: 123, currency: 'USD' } }
//   { data: [{ currency: 'USD', available_balance: 123 }, ...] }
//   { data: { wallets: [...] } }
// and returns an empty list when nothing recognizable is found.
interface RawBalanceResponse {
  status?: boolean;
  code?: number;
  data?: unknown;
  message?: string;
}

function parseBalances(json: RawBalanceResponse): FairpayBalanceEntry[] {
  const entries: FairpayBalanceEntry[] = [];
  if (!json || json.status === false || !json.data) return entries;

  const pushEntry = (raw: Record<string, unknown>) => {
    const currency = typeof raw.currency === 'string' ? raw.currency.toUpperCase() : 'USD';
    const candidate =
      (typeof raw.available_balance === 'number' && raw.available_balance) ||
      (typeof raw.availableBalance === 'number' && raw.availableBalance) ||
      (typeof raw.balance === 'number' && raw.balance) ||
      (typeof raw.amount === 'number' && raw.amount);
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      entries.push({ currency, availableBalance: candidate });
    }
  };

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      pushEntry(obj);
      // Common nested keys we might encounter once the API is known.
      for (const key of ['wallets', 'balances', 'accounts']) {
        if (key in obj) visit(obj[key]);
      }
    }
  };
  visit(json.data);
  return entries;
}

export async function fetchFairpayBalances(
  companyId?: string | null,
): Promise<FairpayBalanceResult> {
  if (!(await isFairpayEnabled(companyId))) {
    return { balances: [], error: 'FairPay no está configurado para esta empresa' };
  }

  try {
    const baseUrl = await getFairpayBaseUrl(companyId);
    const token = await getFairpayToken(companyId);

    const response = await fetch(`${baseUrl}${BALANCE_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      // FairPay's spec uses empty form bodies for "list" calls; we mirror
      // that so the request looks identical to known-working ones.
      body: '',
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 404) {
      return {
        balances: [],
        endpointMissing: true,
        error: `FairPay no expone ${BALANCE_ENDPOINT} (404). Si FairPay publicó otro endpoint para balance, actualizar BALANCE_ENDPOINT en src/lib/api-integrations/fairpay/balances.ts. Mientras tanto, captura el saldo manualmente en /balances.`,
      };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        balances: [],
        error: `FairPay /getBalance → ${response.status} ${response.statusText}: ${body.slice(0, 200)}`,
      };
    }

    let json: RawBalanceResponse;
    try {
      json = (await response.json()) as RawBalanceResponse;
    } catch (err) {
      return {
        balances: [],
        error: `FairPay /getBalance: respuesta no es JSON (${err instanceof Error ? err.message : 'parse error'})`,
      };
    }

    if (json.status === false) {
      return {
        balances: [],
        error: `FairPay /getBalance: ${json.message ?? 'status=false'}`,
      };
    }

    const balances = parseBalances(json);
    if (balances.length === 0) {
      return {
        balances: [],
        error:
          'FairPay respondió OK pero el shape no contiene balance reconocible. Capturar el response real y actualizar parseBalances() en src/lib/api-integrations/fairpay/balances.ts.',
      };
    }

    return { balances };
  } catch (err) {
    return {
      balances: [],
      error: err instanceof Error ? err.message : 'Unknown error fetching FairPay balance',
    };
  }
}
