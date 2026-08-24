// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/withdrawal-review/[id]   —  `id` = external_id del retiro (withdrawId).
//
// GET  → ficha completa: el retiro, las features punto-en-el-tiempo, el score
//        con sus factores, historial de depósitos y de retiros del cliente, el
//        perfil, y el contexto informativo (KYC, deuda, dirección compartida)
//        marcado `affectsScore: false`.
// POST → registra la DECISIÓN del equipo en `withdrawal_reviews`, congelando
//        score / banda / factores tal como se vieron.
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ ESTO NO EJECUTA EL RETIRO.                                                ║
// ║ El dashboard es SOLO LECTURA sobre el Mongo del CRM: no hay escritura, ni ║
// ║ siquiera potencial, hacia el broker. Un POST acá deja asentado qué        ║
// ║ resolvió el equipo y por qué; la aprobación o el rechazo efectivo se      ║
// ║ siguen haciendo en el CRM, a mano. La respuesta lo dice explícitamente    ║
// ║ (`executedInCrm: false`) para que ninguna UI pueda dar a entender otra    ║
// ║ cosa.                                                                     ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
//
// POR QUÉ SE CONGELAN SCORE Y FACTORES EN LA FILA:
// la calibración se va a re-medir (la tasa de rechazo del mes se mueve entre
// 2% y 26%). Si mañana el modelo cambia, una decisión vieja tiene que poder
// justificarse con el número que el analista TENÍA A LA VISTA, no con el que
// el modelo daría hoy. Por eso `score`, `score_band` y `factors` se guardan
// como datos, no se recalculan al leer.
//
// Auth: FINANCE_ROLES (admin / auditor — 'hr' no está en la lista) + módulo
// 'risk', igual en lectura y en escritura.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import { loadWithdrawalDetail } from '@/lib/withdrawal-risk/query';
import { bandsFor, calibrationFromParam, scoreWithdrawal } from '@/lib/withdrawal-risk/score';

/** Mismo check que la migración 088. */
const DECISIONS = ['approve', 'reject', 'escalate', 'pending'] as const;
type Decision = (typeof DECISIONS)[number];

const NOTES_MAX = 4000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['risk'] });
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const cal = calibrationFromParam(request.nextUrl.searchParams.get('calibration'));
    const admin = createAdminClient();
    const detail = await loadWithdrawalDetail(admin, auth.companyId, decodeURIComponent(id), cal);

    if (!detail) {
      return NextResponse.json({ success: false, error: 'Retiro no encontrado' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      detail,
      calibration: {
        id: cal.id,
        window: cal.window,
        n: cal.n,
        baseRejectionRate: cal.baseRejectionRate,
        bands: bandsFor(cal),
      },
      disclaimer:
        'El score es orientativo y no decide. Registrar una decisión acá NO ejecuta el retiro en el CRM.',
    });
  } catch (err) {
    return apiError('admin/withdrawal-review/[id] GET', err, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['risk'] });
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;
    const externalId = decodeURIComponent(id);

    const body = (await request.json().catch(() => ({}))) as {
      decision?: string;
      notes?: string;
      calibration?: string;
    };

    const decision = body.decision as Decision | undefined;
    if (!decision || !DECISIONS.includes(decision)) {
      return NextResponse.json(
        { success: false, error: 'Decisión inválida. Valores: approve, reject, escalate, pending.' },
        { status: 400 },
      );
    }
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, NOTES_MAX) : null;

    // Rechazar y escalar SIEMPRE necesitan una razón escrita: es lo único que
    // le queda al próximo analista (y a compliance) para entender la decisión,
    // porque el score de mañana puede ser otro.
    if ((decision === 'reject' || decision === 'escalate') && !notes) {
      return NextResponse.json(
        { success: false, error: 'Rechazar o escalar requiere una nota que explique el motivo.' },
        { status: 400 },
      );
    }

    const cal = calibrationFromParam(body.calibration ?? null);
    const admin = createAdminClient();

    // El score se RECALCULA server-side y no se toma del cliente: si viniera
    // en el body, cualquiera podría archivar un 99 junto a una aprobación
    // dudosa y el registro dejaría de servir como evidencia.
    const detail = await loadWithdrawalDetail(admin, auth.companyId, externalId, cal);
    if (!detail) {
      return NextResponse.json({ success: false, error: 'Retiro no encontrado' }, { status: 404 });
    }
    const fresh = scoreWithdrawal(detail.features, cal);

    const now = new Date().toISOString();
    const { data: saved, error } = await admin
      .from('withdrawal_reviews')
      .upsert(
        {
          company_id: auth.companyId,
          withdrawal_external_id: externalId,
          score: fresh.approvalScore,
          score_band: fresh.band,
          factors: {
            calibrationId: fresh.calibrationId,
            logOdds: fresh.logOdds,
            items: fresh.factors,
            // Se congela también lo que NO puntuó, para que dentro de un año
            // se pueda demostrar que estas tres señales estaban a la vista y
            // que aun así no movieron el número.
            informative: detail.informative,
          },
          decision,
          decided_by: auth.userId,
          decided_by_name: auth.name,
          decided_at: now,
          notes,
          updated_at: now,
        },
        { onConflict: 'company_id,withdrawal_external_id' },
      )
      .select('withdrawal_external_id, score, score_band, decision, decided_by_name, decided_at, notes')
      .single();

    if (error) return apiError('admin/withdrawal-review/[id] POST', error, { status: 500 });

    await serverAuditLog(admin, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: auth.name,
      action: 'update',
      module: 'risk',
      details:
        `Revisión de retiro ${externalId} (${detail.withdrawal.username ?? 's/u'}, ` +
        `${detail.withdrawal.requested_amount ?? 0} ${detail.withdrawal.coin ?? ''}): ` +
        `decisión "${decision}", score ${fresh.approvalScore} (${fresh.band}, ${fresh.calibrationId}). ` +
        `Registro interno: NO ejecuta el retiro en el CRM.` +
        (notes ? ` Nota: ${notes.slice(0, 300)}` : ''),
    });

    return NextResponse.json({
      success: true,
      review: saved,
      /** Contrato con la UI: esto quedó asentado, pero el CRM no se tocó. */
      executedInCrm: false,
      message:
        'Decisión registrada. El retiro NO se ejecutó ni se rechazó en el CRM: ' +
        'el dashboard es solo-lectura sobre el CRM y la acción efectiva se hace allá.',
    });
  } catch (err) {
    return apiError('admin/withdrawal-review/[id] POST', err, { status: 500 });
  }
}
