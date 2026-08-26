// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/withdrawal-review — cola de retiros pendientes con score.
//
// Filtros por query string:
//   ?minAmount=  &maxAmount=      importe solicitado
//   ?band=low|medium|high         banda de RIESGO (se aplica sobre el score)
//   ?processor=  &coin=           procesador / moneda
//   ?olderThanDays=N              sólo lo que lleva más de N días esperando
//   ?q=texto                      username, email o id de retiro
//   ?from=YYYY-MM-DD &to=...      rango de fechas de SOLICITUD; aplica a las
//                                 TRES secciones a la vez
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
import type { QueueResponse } from '@/lib/withdrawal-risk/api';
import { bandsFor, calibrationFromParam, type RiskBand } from '@/lib/withdrawal-risk/score';

const BANDS: readonly string[] = ['low', 'medium', 'high'];

/** Una fecha mal formada se ignora en vez de filtrar por basura. */
function fecha(v: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

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
      from: fecha(p.get('from')),
      to: fecha(p.get('to')),
    };

    const cal = calibrationFromParam(p.get('calibration'));
    const admin = createAdminClient();
    const queue = await loadQueue(admin, auth.companyId, filters, cal);

    // ── EL TIPO ES OBLIGATORIO ACÁ ──────────────────────────────────────
    // Este objeto se armaba a mano y sin tipar, y por eso `instant` se agregó
    // a `QueueResponse` y a `loadQueue` pero NUNCA a la respuesta: el cliente
    // recibía `undefined`, caía al `?? []` y la pestaña de instantáneos salía
    // vacía con 167 retiros del otro lado. TypeScript no dijo nada porque
    // `NextResponse.json()` acepta cualquier cosa.
    //
    // Con la anotación, olvidarse de un campo no compila.
    const body: QueueResponse & { success: true } = {
      success: true,
      items: queue.items,
      // Aprobados solos por el sistema. Van aparte y SIN tope temporal.
      instant: queue.instant,
      // Los que ya cambiaron de estado, con el estado en el que quedaron.
      resolved: queue.resolved,
      totalPending: queue.totalPending,
      counts: queue.counts,
      truncated: queue.truncated,
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
    };
    return NextResponse.json(body);
  } catch (err) {
    return apiError('admin/withdrawal-review GET', err, { status: 500 });
  }
}
