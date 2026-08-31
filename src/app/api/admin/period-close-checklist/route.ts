// ---------------------------------------------------------------------------
// GET /api/admin/period-close-checklist?period_id=…
//
// Los pendientes que conviene mirar ANTES de cerrar un período (P1-4 del
// benchmark, auditoría 2026-08-06): hasta ahora /periodos cerraba a ciegas y
// el descuadre aparecía después, con el mes ya congelado.
//
// Casi todo son ADVERTENCIAS, no bloqueos: cerrar con pendientes es una
// decisión legítima (p. ej. una orden aprobada que se paga el mes que viene).
// El checklist existe para que sea una decisión informada, no un descuido.
// La única excepción es el orden cronológico (`earlier_periods_open`), que es
// BLOQUEANTE y lo rechaza también la RPC `close_period` (migración 111).
//
// LAS ETIQUETAS NO VIVEN ACÁ. Estaban hardcodeadas en castellano y esta era la
// única pantalla del dashboard que no hablaba inglés. Ahora cada ítem viaja
// con su clave de i18n desde el registro único (src/lib/period-close-checklist)
// y la traduce quien lo muestra.
//
// Las consultas están en src/lib/period-close-checklist-data.ts porque el
// mismo cálculo es el que se CONGELA al cerrar (auditoría de finanzas, ítem
// 22a): «qué estaba pendiente cuando se cerró junio» tenía que poder
// contestarse, y hasta ahora se computaba en vivo.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { buildPeriodCloseChecklist } from '@/lib/period-close-checklist-data';

export type { ChecklistItem } from '@/lib/period-close-checklist';

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES });
  if (auth instanceof NextResponse) return auth;

  const periodId = request.nextUrl.searchParams.get('period_id');
  if (!periodId) {
    return NextResponse.json({ success: false, error: 'period_id requerido' }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const result = await buildPeriodCloseChecklist(admin, auth.companyId, periodId);
    if (!result) {
      return NextResponse.json({ success: false, error: 'Período no encontrado' }, { status: 404 });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return apiError('period-close-checklist', err, { status: 500 });
  }
}
