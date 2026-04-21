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
        // UniPayment invoices don't have an explicit fee field — net = gross
        const fee = 0;
        const netAmount = grossAmount;

        if (netAmount <= 0) continue;

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
