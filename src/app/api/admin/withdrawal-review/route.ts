// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/withdrawal-review — cola de retiros pendientes con score.
//
// Filtros por query string:
//   ?minAmount=  &maxAmount=      importe solicitado
//   ?band=low|medium|high         banda de RIESGO (se aplica sobre el score)
//   ?processor=  &coin=           procesador / moneda
//   ?olderThanDays=N              sólo lo que lleva más de N días esperando
//   ?q=texto                      username, email o id de retiro
//   ?calibration=recent_6m|full_history   (default recent_6m — ver score.ts)
//
// Auth: FINANCE_ROLES (admin / auditor; hr NO está en la lista) + módulo
// 'risk'. Lectura y escritura piden lo mismo a propósito: quien no puede
// registrar una decisión tampoco tiene por qué ver el historial financiero
// completo de un cliente.
//
// EL SCORE NO DECIDE NADA. Esta ruta ordena la cola y explica por qué; la
// aprobación la firma una persona en la ficha, y ni siquiera eso ejecuta el
// retiro en el CRM (somos solo-lectura sobre Mongo).
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { WITHDRAWAL_REVIEW_READ_ROLES } from '@/lib/roles';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import { loadQueue, type QueueFilters } from '@/lib/withdrawal-risk/query';
import { bandsFor, calibrationFromParam, type RiskBand } from '@/lib/withdrawal-risk/score';

const BANDS: readonly string[] = ['low', 'medium', 'high'];

/** Un número mal formado no debe convertirse en 0 (filtraría de más). */
function numParam(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: WITHDRAWAL_REVIEW_READ_ROLES, modules: ['risk'] });
    if (auth instanceof NextResponse) return auth;

    const p = request.nextUrl.searchParams;
    const bandRaw = p.get('band');
    const filters: QueueFilters = {
      minAmount: numParam(p.get('minAmount')),
      maxAmount: numParam(p.get('maxAmount')),
      band: bandRaw && BANDS.includes(bandRaw) ? (bandRaw as RiskBand) : null,
      processor: p.get('processor'),
      coin: p.get('coin'),
      olderThanDays: numParam(p.get('olderThanDays')),
      q: p.get('q'),
    };

    const cal = calibrationFromParam(p.get('calibration'));
    const admin = createAdminClient();
    const queue = await loadQueue(admin, auth.companyId, filters, cal);

    return NextResponse.json({
      success: true,
      items: queue.items,
      totalPending: queue.totalPending,
      counts: queue.counts,
      calibration: {
        id: cal.id,
        window: cal.window,
        n: cal.n,
        baseRejectionRate: cal.baseRejectionRate,
        bands: bandsFor(cal),
      },
      // Contrato explícito para la UI: el score es orientación, no una orden.
      disclaimer:
        'El score es orientativo y no decide. Ninguna acción de esta pantalla ejecuta el retiro en el CRM.',
    });
  } catch (err) {
    return apiError('admin/withdrawal-review GET', err, { status: 500 });
  }
}
