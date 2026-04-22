import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { buildReportData } from '@/lib/reports/data';

// ---------------------------------------------------------------------------
// GET /api/reports/consolidated?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Thin wrapper around `buildReportData()` so the /finanzas/reportes page
// and the cron jobs share the exact same data contract. Keep this route
// skinny — every business rule lives in `src/lib/reports/data.ts`.
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  try {
    const auth = await verifyAuth();
    if (auth instanceof NextResponse) return auth;

    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    if (!from || !to) {
      return NextResponse.json(
        { success: false, error: 'from and to required' },
        { status: 400 },
      );
    }

    const data = await buildReportData(auth.companyId, from, to);
    return NextResponse.json({ success: true, ...data });
  } catch (err) {
    console.error('[reports/consolidated] unhandled:', err);
    return NextResponse.json(
      { success: false, error: 'Error interno' },
      { status: 500 },
    );
  }
}
