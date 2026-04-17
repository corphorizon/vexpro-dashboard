// ─────────────────────────────────────────────────────────────────────────────
// Coinsbuy v3 — Wallet balances service
//
// Fetches wallet balances from the Coinsbuy v3 JSON:API endpoint
// at GET /wallet/. Resolves currency info from the included array.
//
// When credentials are not configured, falls back to mock data.
// ─────────────────────────────────────────────────────────────────────────────

import { getCoinsbuyToken, isCoinsbuyV3Enabled } from './auth';
import { withRetry } from '../retry';

const COINSBUY_BASE_URL =
  process.env.COINSBUY_BASE_URL ?? 'https://v3.api.coinsbuy.com';

// ── Public types ───────────────────────────────────────────────────────────

export interface CoinsbuyWallet {
  id: string;
  label: string;
  status: number;
  balanceConfirmed: number;
  balancePending: number;
  currencyCode: string;
  currencyName: string;
}

// ── JSON:API response shapes ───────────────────────────────────────────────

interface JsonApiCurrencyAttributes {
  name: string;
  alpha: string;
  alias: string | null;
}

interface JsonApiCurrencyResource {
  id: string;
  type: 'currency';
  attributes: JsonApiCurrencyAttributes;
}

interface JsonApiWalletAttributes {
  label: string;
  status: number;
  balance_confirmed: string;
  balance_pending: string;
}

interface JsonApiWalletResource {
  id: string;
  type: 'wallet';
  attributes: JsonApiWalletAttributes;
  relationships: {
    currency: {
      data: { type: 'currency'; id: string };
    };
  };
}

interface JsonApiResponse {
  data: JsonApiWalletResource[];
  included: JsonApiCurrencyResource[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildCurrencyMap(
  included: JsonApiCurrencyResource[],
): Map<string, JsonApiCurrencyResource> {
  const map = new Map<string, JsonApiCurrencyResource>();
  for (const resource of included) {
    if (resource.type === 'currency') {
      map.set(resource.id, resource);
    }
  }
  return map;
}

function processWallets(response: JsonApiResponse): CoinsbuyWallet[] {
  const currencyMap = buildCurrencyMap(response.included ?? []);
  const results: CoinsbuyWallet[] = [];

  for (const wallet of response.data) {
    // Only include active wallets (status 3)
    if (wallet.attributes.status !== 3) continue;

    const currencyId = wallet.relationships?.currency?.data?.id;
    const currency = currencyId ? currencyMap.get(currencyId) : undefined;

    results.push({
      id: wallet.id,
      label: wallet.attributes.label ?? `Wallet ${currency?.attributes.alpha ?? wallet.id}`,
      status: wallet.attributes.status,
      balanceConfirmed: Number(wallet.attributes.balance_confirmed),
      balancePending: Number(wallet.attributes.balance_pending),
      currencyCode: currency?.attributes.alias ?? currency?.attributes.alpha ?? 'UNKNOWN',
      currencyName: currency?.attributes.name ?? 'Unknown',
    });
  }

  return results;
}

// ── Mock data ──────────────────────────────────────────────────────────────

const MOCK_WALLETS: CoinsbuyWallet[] = [
  { id: 'mock-1', label: 'Main USDT TRC20', status: 3, balanceConfirmed: 12500.50, balancePending: 200, currencyCode: 'USDT', currencyName: 'Tether' },
  { id: 'mock-2', label: 'BTC Wallet', status: 3, balanceConfirmed: 0.45, balancePending: 0, currencyCode: 'BTC', currencyName: 'Bitcoin' },
  { id: 'mock-3', label: 'ETH Wallet', status: 3, balanceConfirmed: 3.2, balancePending: 0.1, currencyCode: 'ETH', currencyName: 'Ethereum' },
];

// ── Main fetch ─────────────────────────────────────────────────────────────

export async function fetchCoinsbuyWallets(): Promise<{
  wallets: CoinsbuyWallet[];
  isMock: boolean;
  fetchedAt: string;
  error?: string;
}> {
  const now = new Date().toISOString();

  // Mock mode: return static wallet data.
  if (!isCoinsbuyV3Enabled()) {
    return {
      wallets: MOCK_WALLETS,
      isMock: true,
      fetchedAt: now,
    };
  }

  // Live mode: fetch from the v3 JSON:API endpoint.
  try {
    const token = await getCoinsbuyToken();
    const url = `${COINSBUY_BASE_URL}/wallet/?include=currency&page[size]=100`;

    const response: JsonApiResponse = await withRetry(async () => {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/vnd.api+json',
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        throw new Error(
          `Coinsbuy v3 wallets ${res.status}: ${await res.text()}`,
        );
      }

      return res.json() as Promise<JsonApiResponse>;
    });

    const wallets = processWallets(response);

    return {
      wallets,
      isMock: false,
      fetchedAt: now,
    };
  } catch (err) {
    return {
      wallets: [],
      isMock: false,
      fetchedAt: now,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
