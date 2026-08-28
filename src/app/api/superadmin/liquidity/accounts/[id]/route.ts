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
import { calcularSaldoALaFecha } from '@/lib/liquidity/connection-snapshot';

export const dynamic = 'force-dynamic';
// El PATCH puede recalcular el PnL mensual y el saldo a la conexión, y eso son
// dos consultas a MT5 por el túnel. Sin este margen el servidor corta la
// operación a mitad de camino, con la fecha ya movida y el PnL a medio rehacer.
export const maxDuration = 120;

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
      equity_at_connection?: unknown;
      balance_liquidez?: unknown;
    };
    const tocaNota = 'note' in body;
    const tocaFecha = 'connection_date' in body;
    const tocaEquity = 'equity_at_connection' in body;
    const tocaLiquidez = 'balance_liquidez' in body;
    if (!tocaNota && !tocaFecha && !tocaEquity && !tocaLiquidez) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Sólo se pueden editar la nota, la fecha de conexión, el equity a la conexión ' +
            'y el equity a liquidez.',
        },
        { status: 400 },
      );
    }

    /** Un monto que llega del formulario. Acepta coma decimal. */
    function montoDelFormulario(crudo: unknown): number | null | 'invalido' {
      if (crudo === null || crudo === '') return null;
      const n = typeof crudo === 'number' ? crudo : Number(String(crudo).replace(',', '.'));
      if (!Number.isFinite(n)) return 'invalido';
      return Math.round(n * 100) / 100;
    }

    const admin = createAdminClient();

    // Se lee la cuenta primero: el recálculo necesita su empresa y su login, y
    // además así el 404 sale antes de escribir nada.
    const { data: cuenta, error: eLectura } = await admin
      .from('platform_liquidity_accounts')
      .select('id, company_id, mt5_account, connection_date, connection_values_manual')
      .eq('id', id)
      .maybeSingle();
    if (eLectura) return apiError('superadmin/liquidity/accounts PATCH', eLectura, { status: 500 });
    if (!cuenta) {
      return NextResponse.json({ success: false, error: 'Cuenta no encontrada.' }, { status: 404 });
    }

    const avisos: string[] = [];
    const cambios: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (tocaNota) {
      cambios.note = body.note === null || body.note === '' ? null : String(body.note);
    }

    // El equity a la conexión se puede escribir a mano: cuando había posiciones
    // abiertas en ese instante, el flotante no se puede reconstruir y el único
    // que tiene el número real es quien lo saca del reporte de MT5.
    //
    // Al escribirlo se marca `connection_values_manual`. Sin esa marca, un
    // recálculo posterior pisaría el valor cargado a mano y nadie se enteraría
    // —el campo seguiría teniendo un número con cara de correcto.
    if (tocaEquity) {
      const v = montoDelFormulario(body.equity_at_connection);
      if (v === 'invalido') {
        return NextResponse.json(
          { success: false, error: 'El equity a la conexión tiene que ser un número.' },
          { status: 400 },
        );
      }
      // Vaciarlo es volver a "no lo sabemos", y con eso se suelta la marca: el
      // próximo cálculo automático vuelve a mandar.
      cambios.equity_at_connection = v;
      cambios.connection_values_manual = v !== null;
    }

    // ── Equity a Liquidez ─────────────────────────────────────────────────
    // Es cuánto aporta la cuenta al pool. Lo propone el análisis de duplicados
    // al dar de alta, pero el monto REAL que se envió lo sabe la persona, así
    // que se puede corregir.
    //
    // Es seguro dejarlo editable porque el refresh nunca lo tocó: si lo
    // recalculara en cada corrida, una transferencia detectada hace un mes se
    // descontaría de nuevo y el pool encogería solo hasta cero. Esa regla sigue
    // intacta; esto sólo agrega quién más puede escribirlo.
    if (tocaLiquidez) {
      const v = montoDelFormulario(body.balance_liquidez);
      if (v === 'invalido') {
        return NextResponse.json(
          { success: false, error: 'El equity a liquidez tiene que ser un número.' },
          { status: 400 },
        );
      }
      if (v === null) {
        // Vaciarlo suelta la marca, pero NO recalcula: rehacer el análisis de
        // duplicados acá volvería a descontar transferencias ya aplicadas. Se
        // deja el valor que había y se devuelve el control.
        cambios.liquidez_manual = false;
      } else {
        cambios.balance_liquidez = v;
        cambios.liquidez_manual = true;
      }
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

      // El saldo a la conexión también depende de la fecha: dejarlo con el de
      // la fecha vieja sería un número correcto para un día que ya no es el que
      // dice la ficha.
      //
      // Salvo que esté cargado a mano —y no lo estén reescribiendo en esta
      // misma llamada—: ahí manda la persona, que es justamente para lo que
      // existe la marca.
      const respetarManual = Boolean(cuenta.connection_values_manual) && !tocaEquity;
      if (!respetarManual) {
        try {
          const saldo = await calcularSaldoALaFecha(
            String(cuenta.company_id),
            String(cuenta.mt5_account),
            fechaNueva,
          );
          if (saldo) {
            cambios.balance_at_connection = saldo.balance;
            if (!tocaEquity) cambios.equity_at_connection = saldo.balance;
            cambios.connection_open_positions = saldo.posicionesAbiertas;
            if (!tocaEquity) cambios.connection_values_manual = false;
          }
        } catch {
          // El saldo a la conexión es informativo; el PnL es el número que
          // manda y ése ya se recalculó bien. Cortar acá obligaría a repetir
          // todo por un dato secundario.
          avisos.push('No se pudo recalcular el saldo de la fecha de conexión. Editalo a mano si lo necesitás.');
        }
      }
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

    return NextResponse.json({ success: true, monthsRecalculated: meses, warnings: avisos });
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
