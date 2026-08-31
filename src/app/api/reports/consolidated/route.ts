import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { buildReportData, referenceDateFor } from '@/lib/reports/data';

// ---------------------------------------------------------------------------
// GET /api/reports/consolidated?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Thin wrapper around `buildReportData()` so the /finanzas/reportes page
// and the cron jobs share the exact same data contract. Keep this route
// skinny — every business rule lives in `src/lib/reports/data.ts`.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    // Este endpoint devuelve depósitos/retiros/P&L/balances consolidados: es
    // dato financiero sensible. verifyAuth dejaba pasar CUALQUIER rol (incluido
    // un invitado de solo lectura). Se exige rol financiero (admin/auditor); el
    // superadmin pasa como 'admin' apuntando al tenant con ?company_id=...
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['reports'] });
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

    // Mismo criterio que los crons: «este mes» es el mes del último día del
    // rango elegido, no el del reloj del servidor. Ver `referenceDateFor`.
    const data = await buildReportData(auth.companyId, from, to, referenceDateFor(to));
    return NextResponse.json({ success: true, ...data });
  } catch (err) {
    console.error('[reports/consolidated] unhandled:', err);
    return NextResponse.json(
      { success: false, error: 'Error interno' },
      { status: 500 },
    );
  }
}
