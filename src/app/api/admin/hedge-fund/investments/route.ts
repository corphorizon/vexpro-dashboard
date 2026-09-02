// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/hedge-fund/investments?fund=&status=&due_before=
//
// La lista de clientes con capital en el fondo, con el perfil del CRM pegado
// (username, email, nombre) para que la fila diga QUIÉN y no un uuid.
//
// ── EL CRUCE CONTRA `crm_user_snapshots` ───────────────────────────────────
// `hedgefundinvestments.userId` es EXACTAMENTE el mismo valor que
// `crm_user_snapshots.user_external_id` (la llave que ya usa RRHH desde
// `hr/crm-net-server.ts`). No hay traducción: se pide por `.in()` en lotes y se
// arma un índice.
//
// Un perfil que no aparece NO borra la inversión ni la disfraza: la fila sale
// con `client: null` y la respuesta CUENTA cuántas quedaron sin perfil
// (`withoutProfile`). Un cruce roto que se ve como una lista más corta es el
// fallo que este repo persigue (§1.2).
//
// ── LOS FILTROS ────────────────────────────────────────────────────────────
// Se aplican EN MEMORIA, sobre el espejo ya leído, y no en la consulta. Con 22
// inversiones eso no cuesta nada, y compra que el conteo de excluidos y el
// universo total sean siempre los mismos números vengan los filtros que
// vengan: si el filtro fuera SQL, «0 resultados» y «0 filas porque el filtro se
// escribió mal» se verían idénticos.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { daysUntil } from '@/lib/hedge-fund/aggregate';
import { mirrorIsStale, readHedgeFundMirror } from '@/lib/hedge-fund/server';

export const dynamic = 'force-dynamic';

/** userIds por `.in()`. PostgREST manda el filtro en la URL. */
const LOTE = 200;

interface Perfil {
  user_external_id: string;
  username: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAuth(request, { modules: ['hedge_fund'] });
  if (auth instanceof NextResponse) return auth;

  try {
    const admin = createAdminClient();
    const mirror = await readHedgeFundMirror(admin, auth.companyId, {
      investments: true, certificates: true,
    });

    const url = new URL(request.url);
    const fund = url.searchParams.get('fund');
    const status = url.searchParams.get('status');
    const dueBeforeRaw = url.searchParams.get('due_before');
    // Sólo `YYYY-MM-DD` exacto. Una fecha a medias comparada como texto no da
    // error: da una lista distinta, que es peor.
    const dueBefore = dueBeforeRaw && /^\d{4}-\d{2}-\d{2}$/.test(dueBeforeRaw) ? dueBeforeRaw : null;
    const invalidDueBefore = Boolean(dueBeforeRaw) && dueBefore === null;

    let filas = mirror.investments;
    if (fund) filas = filas.filter((i) => i.fund_key === fund);
    if (status) filas = filas.filter((i) => i.status === status);
    if (dueBefore) filas = filas.filter((i) => !!i.end_date && i.end_date.slice(0, 10) < dueBefore);

    // ── El perfil del cliente ────────────────────────────────────────────
    const ids = [...new Set(filas.map((i) => i.user_external_id).filter((v): v is string => !!v))];
    const perfiles = new Map<string, Perfil>();
    for (let i = 0; i < ids.length; i += LOTE) {
      const { data, error } = await admin
        .from('crm_user_snapshots')
        .select('user_external_id, username, email, first_name, last_name')
        .eq('company_id', auth.companyId)
        .in('user_external_id', ids.slice(i, i + LOTE));
      if (error) throw new Error(`crm_user_snapshots: ${error.message}`);
      for (const p of (data ?? []) as Perfil[]) perfiles.set(p.user_external_id, p);
    }

    // El certificado más reciente por inversión: es un dato de fila, no una
    // lista. Si hubiera varios, gana el último enviado.
    const certPorInversion = new Map<string, { number: string | null; sentAt: string | null }>();
    for (const c of mirror.certificates) {
      if (!c.investment_id) continue;
      const previo = certPorInversion.get(c.investment_id);
      if (!previo || (c.sent_at ?? '') > (previo.sentAt ?? '')) {
        certPorInversion.set(c.investment_id, { number: c.number, sentAt: c.sent_at });
      }
    }

    const ahora = new Date();
    let withoutProfile = 0;
    const investments = filas.map((i) => {
      const p = i.user_external_id ? perfiles.get(i.user_external_id) : undefined;
      if (!p) withoutProfile++;
      return {
        investmentId: i.investment_id,
        ref: i.ref,
        userExternalId: i.user_external_id,
        client: p
          ? {
              username: p.username,
              email: p.email,
              name: [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
            }
          : null,
        fundKey: i.fund_key,
        program: i.program,
        principal: i.principal,
        balance: i.balance,
        currency: i.currency,
        startDate: i.start_date,
        endDate: i.end_date,
        // Negativo = ya venció y sigue abierta. `null` = sin fecha de fin, que
        // NO es «vence hoy».
        daysLeft: daysUntil(i.end_date, ahora),
        status: i.status,
        approvedAt: i.approved_at,
        certificate: certPorInversion.get(i.investment_id) ?? null,
      };
    });

    return NextResponse.json({
      success: true,
      investments,
      /** Total del espejo SIN filtros: para que la pantalla sepa si filtró. */
      totalInMirror: mirror.investments.length,
      withoutProfile,
      excluded: mirror.excluded,
      invalidDueBefore,
      lastSyncedAt: mirror.lastSyncedAt,
      stale: mirrorIsStale(mirror.lastSyncedAt),
    });
  } catch (err) {
    return apiError('admin/hedge-fund/investments', err, { status: 500 });
  }
}
