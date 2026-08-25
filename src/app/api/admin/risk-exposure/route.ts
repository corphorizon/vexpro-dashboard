// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/risk-exposure
//
// El riesgo vivo del bróker: qué hay abierto, en qué está concentrado, y qué
// cuentas pueden liquidarse.
//
// Lee la última foto del espejo (se toma cada 15 min), nunca MT5 en vivo:
// abrir el túnel tarda ~3,5 s y sería una conexión al broker por cada visita.
//
// Auth: módulo 'risk' y los mismos roles que la cola de retiros. Es información
// de riesgo del negocio, no del cliente, pero la ve la misma gente.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { WITHDRAWAL_REVIEW_READ_ROLES } from '@/lib/roles';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadRiskSnapshot } from '@/lib/mt5-sync/risk-query';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, {
      roles: WITHDRAWAL_REVIEW_READ_ROLES,
      modules: ['risk'],
    });
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const snapshot = await loadRiskSnapshot(admin, auth.companyId);

    return NextResponse.json({
      success: true,
      ...snapshot,
      // Contrato explícito: el dinero de MT5 no es comparable entre familias.
      moneyNotice:
        'El dinero va por familia de cuenta y NO sumado: las Cent están en centavos y las ' +
        'PropFirm llevan capital virtual de desafío. Las posiciones y los lotes sí se pueden sumar.',
    });
  } catch (err) {
    return apiError('admin/risk-exposure', err, { status: 500 });
  }
}
