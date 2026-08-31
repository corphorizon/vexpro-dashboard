// ─────────────────────────────────────────────────────────────────────────────
// Cuánto aporta al pool una cuenta que se está agregando.
//
// ── EL PROBLEMA QUE RESUELVE ───────────────────────────────────────────────
// El «Balance Liquidez» NO es el balance de MT5: es lo que Horizon tiene que
// reservar. Si un cliente mueve su dinero de una cuenta propia a otra, ese
// dinero YA está reservado — contarlo dos veces infla el pool con plata que no
// existe.
//
// ── LOS CUATRO ESCENARIOS (decisión de Stiven, 2026-08-28) ─────────────────
//
//   1. Cliente nuevo, sin cuentas previas
//        → aporta su balance completo.
//
//   2. Tiene una cuenta previa con balance CERO
//        → esa cuenta se desactiva (`superseded_by` apunta a la nueva) y la
//          nueva aporta su balance completo. El dinero se mudó, no se duplicó.
//
//   3. Se detecta una transferencia en Mongo (total o parcial)
//        → a la cuenta VIEJA se le RESTA lo transferido de su balance_liquidez
//          y la nueva aporta CERO por ese monto: el dinero ya estaba contado.
//          Queda una fila en platform_liquidity_transfers con la evidencia.
//
//   4. Tiene cuentas previas pero NO se detecta transferencia
//        → se cuenta el balance completo (parece dinero nuevo) y las dos
//          cuentas quedan marcadas con `has_multiple_accounts_warning`.
//          Es un aviso para que lo mire una persona, no una conclusión.
//
// ── POR QUÉ ESTO SÓLO CORRE AL AGREGAR ─────────────────────────────────────
// Si el balance_liquidez se recalculara en cada refresh, una transferencia
// vieja volvería a descontarse cada media hora y el pool encogería solo hasta
// cero. El refresh toca el balance REAL de MT5; el aporte al pool se fija una
// vez y se corrige a mano si hace falta.
//
// ── LO QUE ESTE MÓDULO NO AFIRMA ───────────────────────────────────────────
// No dice que el cliente hizo trampa. Dice que dos cuentas suyas movieron
// dinero entre sí, con qué evidencia y por cuánto. Mover plata entre cuentas
// propias es normal; lo que no puede pasar es contarla dos veces en el pool.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withOrionMongo } from '@/lib/api-integrations/orion-mongo/client';

/** Ventana hacia atrás para buscar movimientos, desde el día del alta. */
export const DIAS_VENTANA = 30;

/**
 * Conceptos de `wallettransfers` que representan movimiento de plata entre la
 * billetera y una cuenta de trading.
 *
 * Salen del uso que ya hace el repo de esa colección. NO se usan como filtro
 * duro en la consulta a propósito — ver `buscarTransferencias`.
 */
export const CONCEPTOS_TRANSFERENCIA = ['TRANSFER_FUNDS', 'WALLET_TRANSFER'] as const;

export type Escenario =
  | 'cliente_nuevo'
  | 'previa_en_cero'
  | 'transferencia_detectada'
  | 'sin_transferencia';

export interface CuentaPrevia {
  id: string;
  mt5_account: string;
  balance: number;
  balance_liquidez: number;
  status: string;
}

export interface TransferenciaDetectada {
  fromAccountId: string;
  amount: number;
  detectionMethod: string;
  evidence: Record<string, unknown>;
}

export interface ResultadoAnalisis {
  escenario: Escenario;
  /** Lo que la cuenta NUEVA aporta al pool. */
  balanceLiquidez: number;
  /** Cuentas previas del mismo cliente (todas, activas o no). */
  previas: CuentaPrevia[];
  /** Cuentas a desactivar, con su motivo. Escenario 2 y 3-total. */
  aDesactivar: Array<{ id: string; reason: string }>;
  /** Descuentos a aplicar sobre el balance_liquidez de cuentas viejas. */
  aDescontar: Array<{ id: string; nuevoBalanceLiquidez: number }>;
  /** Transferencias a registrar para trazabilidad. */
  transferencias: TransferenciaDetectada[];
  /** Escenario 4: hay varias cuentas y no se explicó el dinero. */
  warning: boolean;
  /** Todo lo que quedó sin poder comprobarse. Nunca se traga en silencio. */
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Movimientos del cliente en la ventana, con el detalle crudo.
 *
 * ── POR QUÉ NO SE FILTRA POR `concept` EN LA CONSULTA ──────────────────────
 * Porque un nombre de concepto que no exista devolvería CERO documentos sin
 * error, y eso se leería como «no hubo transferencia» — la conclusión opuesta
 * a la verdadera, y con plata de por medio. Se trae la ventana entera del
 * cliente (son pocos documentos) y el filtrado se hace acá, donde se puede
 * contar cuántos había ANTES de filtrar y avisar si el criterio no matcheó
 * nada.
 */
async function buscarTransferencias(
  companyId: string,
  userId: string,
  desde: Date,
): Promise<{ docs: Record<string, unknown>[]; total: number }> {
  return withOrionMongo(companyId, async ({ db }) => {
    const docs = await db
      .collection('wallettransfers')
      .find(
        { userId, createdAt: { $gte: desde } },
        {
          projection: {
            walletTransferId: 1, walletId: 1, userId: 1, concept: 1,
            relatedConceptId: 1, relatedConceptName: 1,
            grossAmount: 1, netAmount: 1, fee: 1,
            walletTransferType: 1, walletTransferDate: 1, createdAt: 1,
          },
        },
      )
      .limit(500)
      .toArray();
    return { docs: docs as unknown as Record<string, unknown>[], total: docs.length };
  });
}

/** El `userId` de Orion a partir del correo. Sin él no hay dónde buscar. */
async function buscarUserId(
  companyId: string,
  email: string,
): Promise<{ userId: string | null; crmEmail: string | null }> {
  return withOrionMongo(companyId, async ({ db }) => {
    const u = await db
      .collection('tradingaccounts')
      .findOne(
        { userEmail: email },
        { projection: { userId: 1, userEmail: 1 } },
      );
    if (u) return { userId: String(u.userId ?? ''), crmEmail: u.userEmail ? String(u.userEmail) : null };
    const byUser = await db
      .collection('users')
      .findOne({ email }, { projection: { userId: 1, email: 1 } });
    return byUser
      ? { userId: String(byUser.userId ?? ''), crmEmail: byUser.email ? String(byUser.email) : null }
      : { userId: null, crmEmail: null };
  });
}

/**
 * Decide cuánto aporta al pool la cuenta que se agrega.
 *
 * NO escribe nada: devuelve las acciones para que el endpoint las aplique en
 * un solo lugar. Así la decisión se puede testear sin base de datos.
 */
export async function analizarCuentaNueva(
  admin: SupabaseClient,
  companyId: string,
  nueva: { mt5Account: string; email: string | null; balance: number },
): Promise<ResultadoAnalisis> {
  const warnings: string[] = [];
  const base: ResultadoAnalisis = {
    escenario: 'cliente_nuevo',
    balanceLiquidez: round2(nueva.balance),
    previas: [],
    aDesactivar: [],
    aDescontar: [],
    transferencias: [],
    warning: false,
    warnings,
  };

  // Sin correo no hay forma de vincular cuentas del mismo cliente. Se cuenta
  // completo y se avisa: es una decisión, no un silencio.
  if (!nueva.email) {
    warnings.push('La cuenta no tiene correo en MT5: no se pudo buscar cuentas previas del mismo cliente.');
    base.warning = true;
    return base;
  }

  // ── Cuentas previas del mismo correo ────────────────────────────────────
  // Todas, no sólo las activas: una desactivada sigue siendo contexto para
  // quien mira, y su balance_liquidez ya está contado en el pool.
  const { data: previasRaw, error } = await admin
    .from('platform_liquidity_accounts')
    .select('id, mt5_account, balance, balance_liquidez, status')
    .eq('company_id', companyId)
    .eq('mt5_email', nueva.email)
    .neq('mt5_account', nueva.mt5Account);
  if (error) throw new Error(`platform_liquidity_accounts: ${error.message}`);

  const previas: CuentaPrevia[] = (previasRaw ?? []).map((p) => ({
    id: String(p.id),
    mt5_account: String(p.mt5_account),
    balance: Number(p.balance) || 0,
    balance_liquidez: Number(p.balance_liquidez) || 0,
    status: String(p.status),
  }));
  base.previas = previas;

  // ── Escenario 1: cliente nuevo ──────────────────────────────────────────
  if (previas.length === 0) return base;

  // ── Escenario 2: alguna previa quedó en cero ────────────────────────────
  // El dinero se mudó de cuenta. La vieja se desactiva y la nueva aporta todo.
  const enCero = previas.filter((p) => p.balance === 0 && p.status !== 'inactive');
  if (enCero.length > 0) {
    return {
      ...base,
      escenario: 'previa_en_cero',
      aDesactivar: enCero.map((p) => ({
        id: p.id,
        reason: `Balance MT5 en 0 al agregar la cuenta ${nueva.mt5Account}`,
      })),
    };
  }

  // ── Escenarios 3 y 4: hay que mirar Mongo ───────────────────────────────
  let userId: string | null = null;
  let movimientos: Record<string, unknown>[] = [];
  let totalEnVentana = 0;
  try {
    const u = await buscarUserId(companyId, nueva.email);
    userId = u.userId;
    if (!userId) {
      warnings.push(`No se encontró el cliente ${nueva.email} en el CRM: no se pudo buscar transferencias.`);
    } else {
      const desde = new Date(Date.now() - DIAS_VENTANA * 86_400_000);
      const r = await buscarTransferencias(companyId, userId, desde);
      movimientos = r.docs;
      totalEnVentana = r.total;
    }
  } catch (err) {
    // Sin Mongo NO se puede afirmar «no hubo transferencia». Se cae al
    // escenario 4 (contar completo) y se avisa, que es el lado seguro para el
    // pool: se reserva de más, nunca de menos.
    warnings.push(
      `No se pudo consultar el CRM para buscar transferencias: ${err instanceof Error ? err.message : String(err)}. ` +
      'El balance se contó completo — revisar a mano.',
    );
  }

  // Movimientos que apuntan a la cuenta nueva: el dinero ENTRÓ acá.
  const cuentaNueva = String(nueva.mt5Account);
  const haciaLaNueva = movimientos.filter((m) => {
    const rel = String(m.relatedConceptId ?? '');
    const relName = String(m.relatedConceptName ?? '');
    return rel === cuentaNueva || relName.includes(cuentaNueva);
  });

  // Si había movimientos en la ventana pero ninguno menciona la cuenta nueva,
  // eso es informativo: el criterio corrió y no matcheó. Distinto de no haber
  // podido mirar.
  if (totalEnVentana > 0 && haciaLaNueva.length === 0) {
    warnings.push(
      `Se revisaron ${totalEnVentana} movimiento(s) del cliente en ${DIAS_VENTANA} días y ninguno menciona la cuenta ${cuentaNueva}.`,
    );
  }

  if (haciaLaNueva.length === 0) {
    // ── Escenario 4 ──
    return {
      ...base,
      escenario: 'sin_transferencia',
      warning: true,
      warnings: [
        ...warnings,
        `El cliente ya tiene ${previas.length} cuenta(s) en el módulo y no se detectó transferencia: ` +
        'el balance se contó como dinero nuevo. Verificar que no esté duplicado en el pool.',
      ],
    };
  }

  // ── Escenario 3: transferencia detectada ────────────────────────────────
  // Se descuenta de las cuentas viejas, empezando por la que más aporta, hasta
  // cubrir lo transferido. Repartirlo a prorrata escondería de cuál salió.
  const montoTransferido = round2(
    haciaLaNueva.reduce((s, m) => s + (Number(m.netAmount ?? m.grossAmount) || 0), 0),
  );

  const aDescontar: ResultadoAnalisis['aDescontar'] = [];
  const transferencias: TransferenciaDetectada[] = [];
  const aDesactivar: ResultadoAnalisis['aDesactivar'] = [];

  let restante = montoTransferido;
  for (const p of [...previas].sort((a, b) => b.balance_liquidez - a.balance_liquidez)) {
    if (restante <= 0) break;
    const descuento = Math.min(p.balance_liquidez, restante);
    if (descuento <= 0) continue;
    const nuevoBL = round2(p.balance_liquidez - descuento);
    aDescontar.push({ id: p.id, nuevoBalanceLiquidez: nuevoBL });
    transferencias.push({
      fromAccountId: p.id,
      amount: round2(descuento),
      detectionMethod: 'mongo_wallettransfer',
      evidence: {
        userId,
        ventanaDias: DIAS_VENTANA,
        movimientosEnVentana: totalEnVentana,
        // Los documentos crudos que dispararon el match: es lo que permite
        // auditar el descuento seis meses después.
        matches: haciaLaNueva.slice(0, 20),
      },
    });
    // Transfirió todo y quedó vacía: se desactiva.
    if (p.balance === 0) {
      aDesactivar.push({
        id: p.id,
        reason: `Transfirió su saldo a la cuenta ${nueva.mt5Account}`,
      });
    }
    restante = round2(restante - descuento);
  }

  if (restante > 0) {
    warnings.push(
      `Se detectaron ${montoTransferido} transferidos pero las cuentas previas sólo tenían ` +
      `${round2(montoTransferido - restante)} contados en el pool: la diferencia se cuenta como dinero nuevo.`,
    );
  }

  // Lo que la nueva aporta: su balance MENOS lo que ya estaba contado.
  const aporte = Math.max(0, round2(nueva.balance - (montoTransferido - restante)));

  return {
    escenario: 'transferencia_detectada',
    balanceLiquidez: aporte,
    previas,
    aDesactivar,
    aDescontar,
    transferencias,
    warning: false,
    warnings,
  };
}
