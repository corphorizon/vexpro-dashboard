import { NextResponse } from 'next/server';
import { fetchAggregatedMovements } from '@/lib/api-integrations';

// ---------------------------------------------------------------------------
// GET /api/integrations/movements
//
// Returns aggregated deposits + withdrawals from all configured providers.
// Falls back to mock data when API credentials are not set.
// Frontend (Movimientos page) polls this every REFRESH_INTERVAL_MS.
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const data = await fetchAggregatedMovements();
    return NextResponse.json({ success: true, ...data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[API Integrations] Unhandled error:', message);
    return NextResponse.json(
      { success: false, error: message, deposits: [], withdrawals: [], fetchedAt: new Date().toISOString() },
      { status: 500 },
    );
  }
}
