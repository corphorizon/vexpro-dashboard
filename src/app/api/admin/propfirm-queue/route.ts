// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/propfirm-queue
//
// La cola de retiros de prop firm ya revisada. Lee el espejo, nunca Orion ni
// MetaTrader en vivo: la revisión cuesta 28 s y sería una por visita.
//
// Auth: módulo 'risk' y los mismos roles que la cola de retiros normales.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { WITHDRAWAL_REVIEW_READ_ROLES } from '@/lib/roles';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const COLS =
  'withdraw_id, login, username, user_email, program_name, requested_amount, requested_date, ' +
  'status, profit_share_pct, authorized_date, authorized_by, reviewed_at, review_outcome, ' +
  'review_violations, review_unverifiable, review_checks, review_facts, review_cycle, review_error';

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, {
      roles: WITHDRAWAL_REVIEW_READ_ROLES,
      modules: ['risk'],
    });
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('propfirm_withdrawal_queue')
      .select(COLS)
      .eq('company_id', auth.companyId)
      .order('requested_date', { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) throw new Error(error.message);

    // El tipo que infiere PostgREST con una lista larga de columnas no es
    // usable; se afirma la forma que la consulta pide, que es la que hay.
    const filas = (data ?? []) as unknown as Array<Record<string, unknown>>;
    return NextResponse.json({
      success: true,
      pending: filas.filter((r) => r.status === 'PENDING'),
      resolved: filas.filter((r) => r.status !== 'PENDING'),
      // Contrato explícito, igual que en la cola normal: el veredicto es lo
      // que dice el reglamento, no una decisión tomada.
      disclaimer:
        'El veredicto es lo que dice el reglamento para ese número de violaciones. No aprueba ni ' +
        'rechaza nada: eso se sigue firmando en el CRM. Y las reglas marcadas «sin comprobar» NO ' +
        'están cumplidas — están sin mirar.',
    });
  } catch (err) {
    return apiError('admin/propfirm-queue', err, { status: 500 });
  }
}
