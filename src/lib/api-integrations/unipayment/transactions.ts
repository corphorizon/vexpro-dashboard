// ─────────────────────────────────────────────────────────────────────────────
// UniPayment — Invoices (Deposits) service
//
// GET /v1.0/invoices → paginated invoices with proper deposit fields
//
// Only invoices with status "Complete" are included.
// The invoices endpoint has the real deposit data: price_amount, pay_amount,
// paid_amount, status, order_id, etc.
//
// When credentials are not configured, falls back to mock data.
// ─────────────────────────────────────────────────────────────────────────────

import { getUnipaymentToken, isUnipaymentEnabled, getUnipaymentBaseUrl } from './auth';
import { proxiedFetch } from '../proxy';
import { withRetry } from '../retry';
import { generateUnipaymentDeposits } from '../mocks';
import { filterByDateRange } from '../totals';
import type { UnipaymentDepositTx, ProviderDataset } from '../types';

// Per-tenant base URL resolved at call time via getUnipaymentBaseUrl().

const PROVIDER = 'unipayment' as const;
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // 4740 invoices ÷ 100 = 48 pages

// ── API response shapes ─────────────────────────────────────────────────────

interface InvoiceResource {
  invoice_id: string;
  app_id?: string;
  order_id: string;
  price_amount: number;       // requested amount (gross)
  price_currency: string;     // e.g. "USD"
  pay_currency?: string;      // crypto currency used
  pay_amount?: number;        // amount in crypto
  paid_amount?: number;       // amount actually paid
  network?: string;
  address?: string;
  status: string;             // "New", "Paid", "Confirmed", "Complete", "Expired", "Invalid"
  error_status?: string;      // "None", "UnderPaid", "OverPaid"
  create_time: string;        // ISO datetime
  expiration_time?: string;
  confirm_speed?: string;
  // Possible fee fields — UniPayment's invoices API doesn't have a single
  // documented fee field, but their response sometimes includes one of the
  // names below depending on app config / merchant settings. We try them
  // all in order and use the first non-zero value (see `pickFee` below).
  // The hardcoded 1% fallback was the previous behaviour — kept as a last
  // resort so the fee column never lands as zero on a real invoice.
  fee?: number | string;
  fee_amount?: number | string;
  service_fee?: number | string;
  processing_fee?: number | string;
  merchant_fee?: number | string;
  network_fee?: number | string;
  mdr?: number | string;
  // Catch-all: keep ANY other field UniPayment returns so we can inspect
  // the real shape via the persisted `raw` column post-sync. This is how
  // we'll discover the actual fee field name without another deploy.
  [key: string]: unknown;
}

/**
 * UniPayment doesn't ship per-invoice fee info under a single, documented
 * field name across all merchant accounts. Try the most common candidates
 * and use the first one that has a positive numeric value. If none match,
 * the caller falls back to the platform default (1%).
 */
function pickFee(inv: InvoiceResource): number | null {
  const candidates: Array<unknown> = [
    inv.fee_amount,
    inv.service_fee,
    inv.processing_fee,
    inv.merchant_fee,
    inv.fee,
    inv.network_fee,
    inv.mdr,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

interface InvoicesResponse {
  msg: string;
  code: string;
  data: {
    models: InvoiceResource[];
    page_no: number;
    page_size: number;
    page_count: number;
    total: number;
  };
}

// ── Main fetch ──────────────────────────────────────────────────────────────

export async function fetchUnipaymentDepositsV2(
  options: { from?: string; to?: string; companyId?: string | null } = {},
): Promise<ProviderDataset<UnipaymentDepositTx>> {
  const now = new Date().toISOString();
  const { companyId } = options;

  // No credentials → empty error dataset. Keeps fake demo data out of the UI.
  if (!(await isUnipaymentEnabled(companyId))) {
    return {
      slug: 'unipayment',
      provider: PROVIDER,
      kind: 'deposits',
      transactions: [],
      fetchedAt: now,
      status: 'error',
      isMock: false,
      errorMessage: 'UniPayment no está configurado (faltan credenciales)',
    };
  }

  // Live mode
  try {
    const token = await getUnipaymentToken(companyId);
    const baseUrl = await getUnipaymentBaseUrl(companyId);
    const allTransactions: UnipaymentDepositTx[] = [];

    let pageNo = 1;
    let totalPages = 1;

    do {
      const params = new URLSearchParams();
      params.set('page_size', String(PAGE_SIZE));
      params.set('page_no', String(pageNo));
      params.set('is_asc', 'false'); // newest first
      // Filter only completed invoices server-side
      params.set('status', 'Complete');

      const url = `${baseUrl}/v1.0/invoices?${params.toString()}`;

      const response: InvoicesResponse = await withRetry(async () => {
        const res = await proxiedFetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          signal: AbortSignal.timeout(12_000),
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          throw new Error(
            `UniPayment invoices ${res.status}: ${errBody.slice(0, 200)}`,
          );
        }

        return res.json() as Promise<InvoicesResponse>;
      }, { maxAttempts: 2 });

      const models = response.data?.models ?? [];

      for (const inv of models) {
        const grossAmount = Number(inv.price_amount ?? 0);
        // Fee resolution. The /v1.0/invoices endpoint does NOT include
        // a per-invoice commission field — verified 2026-05-02 by capturing
        // _originalResponse in api_transactions.raw and inspecting:
        // {price_amount, paid_amount, pay_amount, status, ...} but no fee.
        // The merchant-dashboard Excel export DOES carry SettledAmount /
        // Commission / NetAmount via a different (currently unmapped)
        // endpoint. Until that endpoint is plumbed in, we fall back to an
        // empirically-calibrated rate.
        //
        // Calibration (Kevin 2026-05-02 export): 687 invoices Mar-Apr,
        // total commission = $14,339.37 / total settled = $155,672.35
        // → effective 9.21%. Bumped from the previous 1% guess which
        // understated fees by ~9x.
        //
        // The pickFee fallback chain (fee_amount, service_fee, etc.)
        // remains in case UniPayment ever ships a per-invoice fee field.
        const realFee = pickFee(inv);
        const UNIPAYMENT_DEFAULT_FEE_RATE = 0.09; // 9% empirical aggregate.
        const fee =
          realFee !== null
            ? Math.round(realFee * 100) / 100
            : Math.round(grossAmount * UNIPAYMENT_DEFAULT_FEE_RATE * 100) / 100;
        const netAmount = Math.max(0, grossAmount - fee);

        if (grossAmount <= 0) continue;

        const createdAt = inv.create_time ?? '';

        // Date range filter (client-side)
        if (options.from && createdAt < `${options.from}T00:00:00`) continue;
        if (options.to && createdAt > `${options.to}T23:59:59`) continue;

        allTransactions.push({
          id: inv.invoice_id,
          provider: PROVIDER,
          kind: 'deposit',
          createdAt,
          email: inv.order_id ?? '',
          orderId: inv.order_id ?? inv.invoice_id,
          grossAmount,
          fee,
          netAmount,
          currency: inv.price_currency ?? 'USD',
          status: 'Completed',
          // Capture the FULL UniPayment response so we can discover the
          // real fee field name from the persisted `raw` column post-sync.
          // Once we confirm which field carries the fee, `pickFee()` can
          // be narrowed and this can be removed.
          _originalResponse: inv as unknown as Record<string, unknown>,
        });
      }

      totalPages = response.data?.page_count ?? 1;
      pageNo++;
    } while (pageNo <= totalPages && pageNo <= MAX_PAGES);

    return {
      slug: 'unipayment',
      provider: PROVIDER,
      kind: 'deposits',
      transactions: allTransactions,
      fetchedAt: now,
      status: 'fresh',
      isMock: false,
    };
  } catch (err) {
    return {
      slug: 'unipayment',
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
