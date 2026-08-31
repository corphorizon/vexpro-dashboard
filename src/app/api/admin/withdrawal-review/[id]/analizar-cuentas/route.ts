// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/withdrawal-review/[id]/analizar-cuentas
//
// Calcula AHORA el diagnóstico operativo de las cuentas del cliente de este
// retiro, en vez de esperar el turno del cron.
//
// ── POR QUÉ ESTO EXISTE ────────────────────────────────────────────────────
// El cron mantiene ~1.023 diagnósticos rotando cada 30 minutos y casi ninguno
// se lee. Medido el 2026-08-31: cada corrida alcanza a procesar entre 7 y 80
// cuentas contra un techo de 200 —no llega, se queda sin tiempo— así que un
// cliente nuevo espera entre media hora y hora y media.
//
// Para un retiro instantáneo da igual: el dinero ya salió y lo que se mira es
// historia. Para un PENDIENTE, el diagnóstico llegaba después de la decisión.
//
// Con este endpoint se calcula lo que alguien va a leer, cuando lo va a leer.
//
// ── LA REGLA G10 SIGUE EN PIE ──────────────────────────────────────────────
// «Nunca consultar MT5 en vivo desde una pantalla» apunta a la carga
// AUTOMÁTICA: una conexión al broker por cada visita. Esto es un clic
// explícito, con su espera a la vista — el mismo criterio que el botón de
// refrescar del pool de liquidez.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import { revisarCuentasDeCliente } from '@/lib/risk/account-review-sync';
import { WITHDRAWAL_REVIEW_READ_ROLES } from '@/lib/roles';

export const dynamic = 'force-dynamic';
// Un cliente tiene pocas cuentas, pero el túnel a MT5 cuesta y el enlace viene
// inestable. 120 s es el mismo margen que usa el resto de lo que habla con MT5.
export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // El MISMO guard que la ficha del retiro: quien puede ver el diagnóstico
    // puede pedir que se calcule. Repetir el par rol/módulo de `[id]/route.ts`
    // es a propósito — dos permisos distintos para la misma pantalla se
    // desincronizan y aparece un botón que siempre da 403.
    const auth = await verifyAdminAuth(request, {
      roles: WITHDRAWAL_REVIEW_READ_ROLES,
      modules: ['risk'],
    });
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();

    // Se busca por `external_id`, que es el que viaja en la URL de la ficha —
    // no por la clave interna. El `company_id` sale del token, nunca del
    // cliente: con el admin client no hay RLS que cubra.
    const { data: retiro, error } = await admin
      .from('crm_withdrawals')
      .select('external_id, user_external_id')
      .eq('company_id', auth.companyId)
      .eq('external_id', decodeURIComponent(id))
      .maybeSingle();
    if (error) return apiError('withdrawal-review/analizar-cuentas', error, { status: 500 });
    if (!retiro) {
      return NextResponse.json({ success: false, error: 'Retiro no encontrado.' }, { status: 404 });
    }
    if (!retiro.user_external_id) {
      return NextResponse.json(
        { success: false, error: 'El retiro no tiene cliente asociado, así que no hay cuentas que analizar.' },
        { status: 400 },
      );
    }

    const r = await revisarCuentasDeCliente(
      admin,
      auth.companyId,
      String(retiro.user_external_id),
    );

    return NextResponse.json({ success: true, ...r });
  } catch (err) {
    return apiError('withdrawal-review/analizar-cuentas', err, { status: 500 });
  }
}
