import { NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import {
  resolveOrionCrmConfig,
  orionHeaders,
  isMockFallbackEnabled,
} from '@/lib/api-integrations/orion-crm/auth';
import { proxiedFetch } from '@/lib/api-integrations/proxy';

// ---------------------------------------------------------------------------
// GET /api/integrations/orion-crm/ping
//
// Connection health check used by the superadmin "Probar conexión" button
// in the API credentials panel. Does NOT return any business data — only
// verifies that the stored credentials can successfully round-trip
// against the Orion CRM API.
//
// Three possible outcomes:
//   · 200 { connected: true, message } — creds OK, API responded 2xx
//   · 200 { connected: false, message } — creds missing OR API unreachable
//     (never 4xx/5xx: the UI expects the shape to stay consistent)
//   · 401 — caller isn't authenticated as admin/auditor/hr
//
// The mock fallback path reports { connected: false, message: 'mock mode' }
// so the superadmin clearly sees "credentials not installed yet" instead
// of a misleading green check.
// ---------------------------------------------------------------------------

const ENDPOINT_PING = '/v1/ping';

export async function GET() {
  try {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;

    const config = await resolveOrionCrmConfig(auth.companyId);

    if (!config) {
      return NextResponse.json({
        connected: false,
        message: isMockFallbackEnabled()
          ? 'Sin credenciales configuradas (usando datos mock)'
          : 'Sin credenciales configuradas',
        isMock: isMockFallbackEnabled(),
      });
    }

    try {
      const res = await proxiedFetch(`${config.baseUrl}${ENDPOINT_PING}`, {
        method: 'GET',
        headers: orionHeaders(config),
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        return NextResponse.json({
          connected: false,
          message: `La API respondió ${res.status} ${res.statusText}`,
          isMock: false,
        });
      }

      return NextResponse.json({
        connected: true,
        message: 'Conexión exitosa',
        isMock: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de red';
      return NextResponse.json({
        connected: false,
        message: `No se pudo contactar la API: ${msg}`,
        isMock: false,
      });
    }
  } catch (err) {
    console.error('[orion-crm/ping] unhandled:', err);
    return NextResponse.json(
      { connected: false, message: 'Error interno', isMock: false },
      { status: 500 },
    );
  }
}
