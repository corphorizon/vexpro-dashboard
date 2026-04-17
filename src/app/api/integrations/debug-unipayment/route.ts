import { NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { getUnipaymentToken } from '@/lib/api-integrations/unipayment/auth';
import { proxiedFetch } from '@/lib/api-integrations/proxy';

// ---------------------------------------------------------------------------
// GET /api/integrations/debug-unipayment
//
// Calls /v1.0/invoices WITHOUT a status filter and counts transactions by
// status + date range, so we can see what UniPayment actually returns in
// production. Admin-only; remove after debugging.
// ---------------------------------------------------------------------------

const BASE_URL =
  process.env.UNIPAYMENT_BASE_URL ?? 'https://api.unipayment.io';

export async function GET() {
  try {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;

    const token = await getUnipaymentToken();

    // No status filter, get first page (up to 100)
    const params = new URLSearchParams({
      page_size: '100',
      page_no: '1',
      is_asc: 'false',
    });

    const res = await proxiedFetch(`${BASE_URL}/v1.0/invoices?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return NextResponse.json({
        success: false,
        status: res.status,
        body: errBody.slice(0, 500),
      });
    }

    const rawJson = await res.text();
    let json: {
      data?: {
        models?: Array<{
          invoice_id: string;
          status: string;
          create_time: string;
          price_amount: number;
          price_currency: string;
        }>;
        total?: number;
        page_count?: number;
      };
      msg?: string;
      code?: string;
    } = {};
    try {
      json = JSON.parse(rawJson);
    } catch {
      return NextResponse.json({
        success: false,
        error: 'Invalid JSON from UniPayment',
        raw: rawJson.slice(0, 1000),
      });
    }

    const models = json.data?.models ?? [];

    // Count by status
    const byStatus: Record<string, number> = {};
    const byMonth: Record<string, number> = {};
    let minDate: string | null = null;
    let maxDate: string | null = null;

    for (const m of models) {
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
      const month = (m.create_time ?? '').slice(0, 7);
      byMonth[month] = (byMonth[month] ?? 0) + 1;
      if (!minDate || m.create_time < minDate) minDate = m.create_time;
      if (!maxDate || m.create_time > maxDate) maxDate = m.create_time;
    }

    return NextResponse.json({
      success: true,
      envUrl: process.env.UNIPAYMENT_BASE_URL ?? '(default)',
      clientIdPreview: (process.env.UNIPAYMENT_CLIENT_ID ?? '').slice(0, 8) + '...',
      rawResponseSample: rawJson.slice(0, 500),
      response: {
        msg: json.msg,
        code: json.code,
        totalFromApi: json.data?.total,
        pageCount: json.data?.page_count,
        modelsOnThisPage: models.length,
      },
      statusBreakdown: byStatus,
      monthBreakdown: byMonth,
      dateRange: { min: minDate, max: maxDate },
      sample: models.slice(0, 3).map((m) => ({
        id: m.invoice_id,
        status: m.status,
        created: m.create_time,
        amount: m.price_amount,
        currency: m.price_currency,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
