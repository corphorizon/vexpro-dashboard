import { NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { proxiedFetch, isProxyEnabled } from '@/lib/api-integrations/proxy';

// ---------------------------------------------------------------------------
// GET /api/integrations/debug-uni-token
//
// Attempts to fetch a UniPayment token with full request/response capture
// so we can see exactly what Cloudflare is saying on the 403.
// ---------------------------------------------------------------------------

const BASE_URL =
  process.env.UNIPAYMENT_BASE_URL ?? 'https://api.unipayment.io';

export async function GET() {
  try {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;

    const results: Record<string, unknown> = {
      proxyEnabled: isProxyEnabled(),
      clientIdSet: !!process.env.UNIPAYMENT_CLIENT_ID,
    };

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.UNIPAYMENT_CLIENT_ID ?? '',
      client_secret: process.env.UNIPAYMENT_CLIENT_SECRET ?? '',
    });

    try {
      const res = await proxiedFetch(`${BASE_URL}/connect/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });

      // Capture full response details
      const headersObj: Record<string, string> = {};
      res.headers.forEach((value: string, key: string) => {
        headersObj[key] = value;
      });
      const responseBody = await res.text();

      results.request = {
        url: `${BASE_URL}/connect/token`,
        method: 'POST',
      };
      results.response = {
        status: res.status,
        statusText: res.statusText,
        headers: headersObj,
        body: responseBody,
      };
    } catch (err) {
      results.fetchError = err instanceof Error ? err.message : String(err);
    }

    return NextResponse.json({ success: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
