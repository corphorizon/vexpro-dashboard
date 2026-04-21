// ─────────────────────────────────────────────────────────────────────────────
// FairPay — Deposits service
//
// POST /api/v1/getTransactionList with form data:
//   start_date=YYYY-MM-DD
//   end_date=YYYY-MM-DD
//
// Response shape (per the official Postman docs):
//   {
//     status: true,
//     code: 200,
//     data: [
//       {
//         main_order_id: "bp_xxx" | null,
//         order_id: "fp1736467",
//         amount_usd: 10,
//         amount: 176,           // local-currency amount
//         status: 0 | 1,         // 0 = pending, 1 = completed
//         created_at: "2024-04-30T09:44:49.000000Z"
//       },
//       ...
//     ]
//   }
//
// IMPORTANT — gaps vs the user's spec:
//   • The list endpoint does NOT include customer_email, mdr (fee), id, billed,
//     net or currency. Only the fields above.
//   • Status is numeric (0/1), not the string "Completed". We map 1 → Completed.
//   • There is no documented pagination — the API returns every transaction in
//     the date range in a single response (this is what the docs show).
//   • To get full per-transaction detail (email, MDR, currency, etc) you must
//     call getTransaction one-by-one with the order_id, which would require
//     N extra requests and bump against the 60 req/min rate limit.
//
// Mapping used here (best-effort given the available fields):
//   id           ← order_id
//   createdAt    ← created_at
//   customerEmail← '' (not available from list)
//   billed       ← amount_usd
//   mdr          ← 0 (not available from list)
//   net          ← amount_usd  (canonical USD value, what we sum for totals)
//   currency     ← 'USD'
//   status       ← status === 1 ? 'Completed' : 'Pending'
//
// When credentials are missing, falls back to mock data with the full field
// set so the UI can still be exercised.
// ─────────────────────────────────────────────────────────────────────────────

import { getFairpayToken, getFairpayBaseUrl, isFairpayEnabled } from './auth';
import { withRetry } from '../retry';
import { generateFairpayDeposits } from '../mocks';
import { filterByDateRange } from '../totals';
import type { FairpayDepositTx, ProviderDataset } from '../types';

const PROVIDER = 'fairpay' as const;

interface ListTransactionRow {
  main_order_id: string | null;
  order_id: string;
  amount_usd: number | string;
  amount: number | string;
  // Production API also returns `currency` even though Postman docs omit it.
  currency?: string;
  // Observed in production: 0 = Pending, 1 = Completed, 2 = Failed/Rejected.
  status: number;
  created_at: string;
}

interface ListTransactionResponse {
  status: boolean;
  code: number;
  data?: ListTransactionRow[];
  message?: string;
}

interface FetchOptions {
  from?: string;
  to?: string;
  /** Resolves per-tenant API credentials. Null / undefined → env fallback. */
  companyId?: string | null;
}

// Default window when no dates are supplied (last 90 days).
function defaultDateRange(): { from: string; to: string } {
  const today = new Date();
  const past = new Date(today);
  past.setDate(today.getDate() - 90);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(past), to: fmt(today) };
}

export async function fetchFairpayDeposits(
  options: FetchOptions = {},
): Promise<ProviderDataset<FairpayDepositTx>> {
  const now = new Date().toISOString();
  const { companyId } = options;

  // No credentials → return empty error dataset rather than faking numbers.
  if (!(await isFairpayEnabled(companyId))) {
    return {
      slug: 'fairpay',
      provider: PROVIDER,
      kind: 'deposits',
      transactions: [],
      fetchedAt: now,
      status: 'error',
      isMock: false,
      errorMessage: 'FairPay no está configurado (falta FAIRPAY_API_KEY)',
    };
  }

  // ── Live mode ──
  try {
    const { from: defaultFrom, to: defaultTo } = defaultDateRange();
    // Business rule: FairPay history only goes back to 2026-04-01.
    // Never request anything earlier than that regardless of the requested
    // range — keeps the UI from showing pre-launch noise.
    const FAIRPAY_MIN_DATE = '2026-04-01';
    const clampFrom = (d: string) => (d < FAIRPAY_MIN_DATE ? FAIRPAY_MIN_DATE : d);
    const startDate = clampFrom(options.from ?? defaultFrom);
    const endDate = clampFrom(options.to ?? defaultTo);

    const token = await getFairpayToken(companyId);
    const baseUrl = await getFairpayBaseUrl(companyId);

    const body = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
    });

    const json: ListTransactionResponse = await withRetry(async () => {
      const res = await fetch(
        `${baseUrl}/api/v1/getTransactionList`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(12_000),
        },
      );

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(
          `FairPay getTransactionList ${res.status}: ${errBody.slice(0, 200)}`,
        );
      }

      return res.json() as Promise<ListTransactionResponse>;
    }, { maxAttempts: 2 });

    if (!json.status) {
      throw new Error(
        `FairPay returned status=false: ${json.message ?? JSON.stringify(json).slice(0, 200)}`,
      );
    }

    const rows = json.data ?? [];
    const transactions: FairpayDepositTx[] = rows.map((row): FairpayDepositTx => {
      const amountUsd = Number(row.amount_usd ?? 0);
      // Map numeric status: 1 = Completed, 0 = Pending. Anything else falls
      // back to Failed so it never gets summed into totals.
      let status: FairpayDepositTx['status'];
      if (row.status === 1) status = 'Completed';
      else if (row.status === 0) status = 'Pending';
      else status = 'Failed';

      return {
        id: String(row.order_id),
        provider: PROVIDER,
        kind: 'deposit',
        createdAt: row.created_at,
        customerEmail: '', // Not available from the list endpoint
        billed: amountUsd,
        mdr: 0,           // Not available from the list endpoint
        net: amountUsd,   // Without MDR data, net == billed (USD)
        currency: row.currency ?? 'USD',
        status,
      };
    });

    return {
      slug: 'fairpay',
      provider: PROVIDER,
      kind: 'deposits',
      transactions,
      fetchedAt: now,
      status: 'fresh',
      isMock: false,
    };
  } catch (err) {
    return {
      slug: 'fairpay',
      provider: PROVIDER,
      kind: 'deposits',
      transactions: [],
      fetchedAt: now,
      status: 'error',
      isMock: false,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
