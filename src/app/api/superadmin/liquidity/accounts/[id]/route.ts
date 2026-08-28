// ─────────────────────────────────────────────────────────────────────────────
// /api/superadmin/liquidity/accounts/[id]
//
//   PATCH  → editar la nota y la fecha de conexión
//   DELETE → sacar la cuenta del pool
//
// ── QUÉ SE PUEDE EDITAR Y QUÉ NO ───────────────────────────────────────────
// Balance, equity y grupo los manda MT5; el `balance_liquidez` lo decide el
// análisis de duplicados. Dejarlos editables a mano crearía dos verdades sobre
// el mismo número y ganaría la última que alguien tocó.
//
// La fecha de conexión sí, porque no es un dato leído sino una DECISIÓN: desde
// cuándo esta cuenta cuenta para el pool. Sirve para dar de alta cuentas que ya
// venían operando y recuperarles la historia.
//
// ── LO QUE ARRASTRA CAMBIARLA ──────────────────────────────────────────────
// El PnL mensual es un derivado de esta fecha, guardado en otra tabla. Cambiar
// la fecha sin rehacerlo dejaría meses del rango viejo sumando al total. Por
// eso el recálculo NO es opcional acá: si falla, el PATCH falla y la fecha no
// se mueve. Guardar la fecha nueva con el PnL viejo daría un total plausible y
// equivocado, que es peor que un error.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import { validarFechaConexion } from '@/lib/liquidity/connection-date';
import { recalcularPnlMensual } from '@/lib/liquidity/monthly-pnl-calculator';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const body = (await request.json().catch(() => ({}))) as {
      note?: unknown;
      connection_date?: unknown;
    };
    const tocaNota = 'note' in body;
    const tocaFecha = 'connection_date' in body;
    if (!tocaNota && !tocaFecha) {
      return NextResponse.json(
        { success: false, error: 'Sólo se pueden editar la nota y la fecha de conexión.' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    // Se lee la cuenta primero: el recálculo necesita su empresa y su login, y
    // además así el 404 sale antes de escribir nada.
    const { data: cuenta, error: eLectura } = await admin
      .from('platform_liquidity_accounts')
      .select('id, company_id, mt5_account, connection_date')
      .eq('id', id)
      .maybeSingle();
    if (eLectura) return apiError('superadmin/liquidity/accounts PATCH', eLectura, { status: 500 });
    if (!cuenta) {
      return NextResponse.json({ success: false, error: 'Cuenta no encontrada.' }, { status: 404 });
    }

    const cambios: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (tocaNota) {
      cambios.note = body.note === null || body.note === '' ? null : String(body.note);
    }

    let fechaNueva: Date | null = null;
    if (tocaFecha) {
      const v = validarFechaConexion(body.connection_date);
      if (!v.ok) return NextResponse.json({ success: false, error: v.error }, { status: 400 });
      // Se comparan INSTANTES, no días. Reguardar la misma fecha exacta no
      // dispara nada —no tiene por qué costar una consulta a una tabla de 68
      // millones de filas—, pero una cuenta guardada con el ancla vieja de
      // mediodía sí se recalcula al reguardarla: el día es el mismo y el
      // instante no, así que la pantalla la repara sola.
      const antes = new Date(String(cuenta.connection_date)).getTime();
      if (v.fecha.getTime() !== antes) fechaNueva = v.fecha;
    }

    // El recálculo va PRIMERO y puede cortar. Si MT5 no responde, la fecha no
    // se mueve y la cuenta queda coherente con el PnL que ya tenía.
    let meses: number | null = null;
    if (fechaNueva) {
      try {
        meses = await recalcularPnlMensual(
          admin,
          { id: String(cuenta.id), company_id: String(cuenta.company_id), mt5_account: String(cuenta.mt5_account) },
          fechaNueva,
        );
      } catch (err) {
        return NextResponse.json(
          {
            success: false,
            error:
              `No se pudo recalcular el PnL con la fecha nueva, así que la fecha no se cambió: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          },
          { status: 502 },
        );
      }
      cambios.connection_date = fechaNueva.toISOString();
    }

    const { data, error } = await admin
      .from('platform_liquidity_accounts')
      .update(cambios)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) return apiError('superadmin/liquidity/accounts PATCH', error, { status: 500 });
    if (!data) {
      return NextResponse.json({ success: false, error: 'Cuenta no encontrada.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, monthsRecalculated: meses });
  } catch (err) {
    return apiError('superadmin/liquidity/accounts PATCH', err, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();

    // El PnL mensual y las transferencias caen por ON DELETE CASCADE. Lo que
    // NO cae es el id dentro de `related_account_ids` de otras cuentas: es un
    // array sin integridad referencial, así que se limpia acá.
    const { data: relacionadas } = await admin
      .from('platform_liquidity_accounts')
      .select('id, related_account_ids')
      .contains('related_account_ids', [id]);
    for (const r of relacionadas ?? []) {
      const limpio = (r.related_account_ids as string[] | null ?? []).filter((x) => x !== id);
      await admin
        .from('platform_liquidity_accounts')
        .update({ related_account_ids: limpio.length > 0 ? limpio : null })
        .eq('id', r.id);
    }

    const { error } = await admin.from('platform_liquidity_accounts').delete().eq('id', id);
    if (error) return apiError('superadmin/liquidity/accounts DELETE', error, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError('superadmin/liquidity/accounts DELETE', err, { status: 500 });
  }
}
