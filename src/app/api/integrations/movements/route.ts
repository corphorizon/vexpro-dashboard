import { NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import {
  fetchAggregatedMovements,
  fetchProviderBySlug,
  type ProviderSlug,
} from '@/lib/api-integrations';

// ---------------------------------------------------------------------------
// GET /api/integrations/movements
//
// Query params (all optional):
//   from=YYYY-MM-DD   inclusive lower bound
//   to=YYYY-MM-DD     inclusive upper bound
//   slug=<provider>   return a single dataset instead of all four
//                     valid: coinsbuy-deposits | coinsbuy-withdrawals |
//                            fairpay | unipayment
//
// Falls back to mock data when provider credentials are not configured.
// This endpoint is server-side only — credentials are never exposed to the
// browser.
// ---------------------------------------------------------------------------

const VALID_SLUGS: ProviderSlug[] = [
  'coinsbuy-deposits',
  'coinsbuy-withdrawals',
  'fairpay',
  'unipayment',
];

export async function GET(request: Request) {
  try {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;

    const url = new URL(request.url);
    const from = url.searchParams.get('from') ?? undefined;
    const to = url.searchParams.get('to') ?? undefined;
    const slug = url.searchParams.get('slug');

    if (slug) {
      if (!VALID_SLUGS.includes(slug as ProviderSlug)) {
        return NextResponse.json(
          { success: false, error: `Invalid slug: ${slug}` },
          { status: 400 },
        );
      }
      const dataset = await fetchProviderBySlug(slug as ProviderSlug, { from, to });
      return NextResponse.json({ success: true, dataset });
    }

    const data = await fetchAggregatedMovements({ from, to });
    return NextResponse.json({ success: true, ...data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[API Integrations] Unhandled error:', message);
    return NextResponse.json(
      {
        success: false,
        error: message,
        datasets: [],
        fetchedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
