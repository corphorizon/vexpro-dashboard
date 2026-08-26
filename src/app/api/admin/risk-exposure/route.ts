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
import { loadRiskSnapshot, loadPnlLive, loadPnlHistory } from '@/lib/mt5-sync/risk-query';
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

    // Rango del histórico de PNL. Por defecto los últimos 30 días UTC: el
    // suficiente para ver una racha sin traer un año a una pantalla.
    const DIA = 86_400_000;
    const hoy = new Date().toISOString().slice(0, 10);
    const pedido = (k: string) => {
      const v = request.nextUrl.searchParams.get(k);
      return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    };
    const to = pedido('to') ?? hoy;
    const from = pedido('from') ?? new Date(Date.parse(to) - 29 * DIA).toISOString().slice(0, 10);
    if (from > to) {
      return NextResponse.json(
        { success: false, error: 'El rango de fechas empieza después de terminar.' },
        { status: 400 },
      );
    }

    const [snapshot, pnlLive, pnlHistory] = await Promise.all([
      loadRiskSnapshot(admin, auth.companyId),
      loadPnlLive(admin, auth.companyId),
      loadPnlHistory(admin, auth.companyId, from, to),
    ]);

    return NextResponse.json({
      success: true,
      ...snapshot,
      pnl: { ...pnlLive, range: { from, to }, history: pnlHistory },
      // Contrato explícito: el dinero de MT5 no es comparable entre familias.
      moneyNotice:
        'El dinero va por familia de cuenta y NO sumado: las Cent están en centavos y las ' +
        'PropFirm llevan capital virtual de desafío. Las posiciones y los lotes sí se pueden sumar.',
      pnlNotice:
        'El PNL cuenta SÓLO cuentas live que además existen en el CRM: lo que está en MetaTrader ' +
        'y no en el CRM es de prueba y queda fuera. Por eso los totales de PNL y los de exposición ' +
        'no tienen por qué cuadrar. Los cortes del día son UTC.',
    });
  } catch (err) {
    return apiError('admin/risk-exposure', err, { status: 500 });
  }
}
