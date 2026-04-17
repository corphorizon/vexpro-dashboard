import { NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { proxiedFetch, isProxyEnabled } from '@/lib/api-integrations/proxy';

// ---------------------------------------------------------------------------
// GET /api/integrations/debug-ip
//
// Returns the outbound IP as seen by api.ipify.org when calling via the same
// proxied fetch Coinsbuy uses. Helps verify Fixie is routing as expected.
// Admin-only; remove after debugging.
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;

    const results: Record<string, unknown> = {
      proxyEnabled: isProxyEnabled(),
      fixieUrlSet: !!process.env.FIXIE_URL,
    };

    // 1) Call ipify via proxiedFetch to see which IP goes out
    try {
      const res = await proxiedFetch('https://api.ipify.org?format=json');
      results.viaProxy = {
        status: res.status,
        body: await res.json(),
      };
    } catch (err) {
      results.viaProxy = {
        error: err instanceof Error ? err.message : 'unknown',
      };
    }

    // 2) Native fetch for comparison (should be Vercel's IP)
    try {
      const res = await fetch('https://api.ipify.org?format=json');
      results.viaNative = {
        status: res.status,
        body: await res.json(),
      };
    } catch (err) {
      results.viaNative = {
        error: err instanceof Error ? err.message : 'unknown',
      };
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
