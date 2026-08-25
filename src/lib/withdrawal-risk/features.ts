// ─────────────────────────────────────────────────────────────────────────────
// Features de riesgo de un retiro — PUNTO EN EL TIEMPO, sin I/O.
//
// POR QUÉ ESTE ARCHIVO ES PURO:
// el score tiene que ser reproducible y testeable sin base de datos. Toda la
// aritmética del comportamiento del cliente vive acá; `query.ts` sólo se ocupa
// de traer las filas y `score.ts` de ponderarlas.
//
// LA REGLA QUE NO SE NEGOCIA — PUNTO EN EL TIEMPO:
// el comportamiento de un cliente se mide sumando SÓLO los movimientos
// ANTERIORES a `requestedAt` del retiro que se está evaluando. Nunca con los
// contadores lifetime del CRM (`totalDepositLifetime` / `totalWithdrawLifetime`,
// trampa 2 de la migración 088): esos contadores sólo se acumulan cuando el
// movimiento se completa, así que los 915 rechazos del histórico caen todos en
// "neto 0" y el modelo aprendería que "neto 0 = rechazo", que es circular y
// falso. Acá se vuelve a filtrar por fecha aunque la consulta ya lo haga:
// defensa en profundidad y hace que el test de punto-en-el-tiempo signifique
// algo.
//
// SEÑALES QUE MIRAMOS Y SEÑALES QUE NO — ver la cabecera de `score.ts`. Este
// módulo también deriva las tres señales DESCARTADAS (KYC, deuda de comisiones,
// dirección compartida), pero las deja aparte en `context`, fuera del objeto
// que puntúa, justamente para que sea imposible sumarlas al score por accidente.
// ─────────────────────────────────────────────────────────────────────────────

/** Un movimiento del histórico del cliente (depósito completado o retiro aprobado). */
export interface Movement {
  /** Importe en USD. En depósitos SIEMPRE `amount_paid` (trampa 1: `deposit_value` está corrupto). */
  amount: number | null;
  /** Fecha del movimiento. ISO string o Date. */
  at: string | Date | null;
}

export interface FeatureInput {
  /** Importe solicitado del retiro que se evalúa. */
  amount: number | null;
  /** Fecha de la solicitud: el corte del "punto en el tiempo". */
  requestedAt: string | Date | null;
  /** Depósitos COMPLETADOS del cliente (se filtran por fecha acá adentro). */
  depositsBefore: Movement[];
  /** Retiros ya APROBADOS del cliente (se filtran por fecha acá adentro). */
  withdrawalsApprovedBefore: Movement[];
  /** Cuántos retiros previos del cliente terminaron en REJECTED antes de esta solicitud. */
  rejectedCountBefore: number;
  /** Alta del cliente en el CRM. */
  registerDate: string | Date | null;
  // ── Contexto informativo: NO puntúa (ver score.ts) ────────────────────────
  kycStatus: string | null;
  pendingFeeDebt: number | null;
  /** Cuántos usuarios distintos usaron esta misma dirección de destino. */
  sharedAddressUserCount: number | null;
  // ── Origen del dinero: SÍ puntúa (ver P2pBucket) ──────────────────────────
  /** Total recibido por transferencia P2P de otros usuarios. */
  p2pReceived?: number | null;
  /** Correo del cliente: decide si es personal del broker. */
  email?: string | null;
}

/** Tramos medidos del ratio pedido/depositado. `no_deposits` = sin depósitos previos. */
export type RatioBucket = 'lt_0_5' | 'b_0_5_1' | 'b_1_2' | 'gt_2' | 'no_deposits';
/** Tramos medidos de antigüedad de la cuenta al pedir. `unknown` = sin fecha de alta. */
export type AgeBucket = 'lt_1d' | 'b_1_7d' | 'b_7_30d' | 'gt_30d' | 'unknown';
/** Tramos medidos del neto real (depositado − retirado) antes de la solicitud. */
export type NetBucket = 'lt_m1000' | 'm1000_0' | 'b_0_500' | 'gt_500' | 'no_deposits';
/** Tramos medidos de rechazos previos. */
export type RejectionBucket = 'r0' | 'r1' | 'r2' | 'r3plus';

/**
 * De dónde salió el dinero que está retirando.
 *
 * Medido sobre 9.828 retiros decididos en 6 meses (base 4,95%):
 *   staff         1,70%   personal del broker: cobran comisiones, retirar sin
 *                         haber depositado es su forma normal de operar
 *   none          3,90%   nunca recibió una transferencia de otro usuario
 *   partial       8,35%   recibió P2P por menos de lo que retira
 *   covers       11,62%   el P2P recibido alcanza para cubrir el retiro entero
 *
 * Monótona y con volumen. Es la señal más fuerte del módulo.
 */
export type P2pBucket = 'staff' | 'none' | 'partial' | 'covers';

/** Contexto que se MUESTRA en la ficha pero que NO mueve el score. */
export interface InformativeContext {
  kycStatus: string | null;
  pendingFeeDebt: number;
  sharedAddressUserCount: number;
  /** true si la dirección de destino la usaron otros clientes además de éste. */
  addressShared: boolean;
}

export interface WithdrawalFeatures {
  amount: number;
  requestedAt: Date | null;
  /** Suma de `amount_paid` de los depósitos completados ANTERIORES a la solicitud. */
  depositedBefore: number;
  /** Suma de los retiros ya aprobados ANTERIORES a la solicitud. */
  withdrawnBefore: number;
  /** depositedBefore − withdrawnBefore. Negativo = el cliente ya sacó más de lo que puso. */
  netBefore: number;
  depositCountBefore: number;
  withdrawalCountBefore: number;
  hasDeposits: boolean;
  /** amount / depositedBefore. `null` cuando no hay depósitos previos (división imposible). */
  ratio: number | null;
  /** Días entre el alta del cliente y la solicitud. `null` si no hay fecha de alta. */
  accountAgeDays: number | null;
  rejectedCountBefore: number;
  lastDepositAt: Date | null;
  firstDepositAt: Date | null;
  // Tramos: lo que consume el scorecard.
  ratioBucket: RatioBucket;
  ageBucket: AgeBucket;
  netBucket: NetBucket;
  rejectionBucket: RejectionBucket;
  p2pBucket: P2pBucket;
  /** Cuánto entró por P2P, para poder explicarlo en la ficha. */
  p2pReceived: number;
  /** Personal del broker: la comparación depósitos-retiros no le aplica. */
  isStaff: boolean;
  /** Deliberadamente FUERA de todo lo que puntúa. */
  context: InformativeContext;
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Filtra los movimientos ESTRICTAMENTE anteriores al corte.
 *
 * Si no hay corte (retiro sin `requested_at`, que en el espejo existe) se
 * devuelve la lista vacía en vez de todo el histórico: preferimos un cliente
 * "sin historia" —que cae en los tramos neutros— antes que contar movimientos
 * posteriores y fabricar un score optimista con información del futuro.
 */
function before(movements: Movement[], cut: Date | null): { sum: number; count: number; dates: Date[] } {
  if (!cut) return { sum: 0, count: 0, dates: [] };
  let sum = 0;
  let count = 0;
  const dates: Date[] = [];
  for (const m of movements) {
    const at = toDate(m.at);
    if (!at || at.getTime() >= cut.getTime()) continue;
    sum += num(m.amount);
    count += 1;
    dates.push(at);
  }
  return { sum, count, dates };
}

export function ratioBucketOf(ratio: number | null, hasDeposits: boolean): RatioBucket {
  if (!hasDeposits || ratio === null) return 'no_deposits';
  if (ratio < 0.5) return 'lt_0_5';
  if (ratio < 1) return 'b_0_5_1';
  if (ratio < 2) return 'b_1_2';
  return 'gt_2';
}

export function ageBucketOf(days: number | null): AgeBucket {
  if (days === null) return 'unknown';
  if (days < 1) return 'lt_1d';
  if (days < 7) return 'b_1_7d';
  if (days < 30) return 'b_7_30d';
  return 'gt_30d';
}

export function netBucketOf(net: number, hasDeposits: boolean): NetBucket {
  if (!hasDeposits) return 'no_deposits';
  if (net < -1000) return 'lt_m1000';
  if (net < 0) return 'm1000_0';
  if (net < 500) return 'b_0_500';
  return 'gt_500';
}

/**
 * El tramo de P2P. `isStaff` gana sobre todo lo demás: a un BDM que cobra
 * comisiones no se le mide el dinero recibido como si fuera sospechoso.
 */
export function p2pBucketOf(
  p2pReceived: number,
  withdrawalAmount: number,
  isStaff: boolean,
): P2pBucket {
  if (isStaff) return 'staff';
  if (!(p2pReceived > 0)) return 'none';
  return p2pReceived >= withdrawalAmount ? 'covers' : 'partial';
}

export function rejectionBucketOf(n: number): RejectionBucket {
  if (n <= 0) return 'r0';
  if (n === 1) return 'r1';
  if (n === 2) return 'r2';
  return 'r3plus';
}

/**
 * Deriva las features de UN retiro. Función pura: mismas entradas → misma
 * salida, sin red, sin reloj (la "fecha de hoy" no interviene: todo se mide
 * contra `requestedAt`, así que un retiro viejo puntúa igual hoy que hace un
 * mes — condición para poder congelar el score en `withdrawal_reviews`).
 */
export function computeFeatures(input: FeatureInput): WithdrawalFeatures {
  const requestedAt = toDate(input.requestedAt);
  const amount = num(input.amount);

  const deps = before(input.depositsBefore ?? [], requestedAt);
  const wds = before(input.withdrawalsApprovedBefore ?? [], requestedAt);

  const depositedBefore = deps.sum;
  const withdrawnBefore = wds.sum;
  const netBefore = depositedBefore - withdrawnBefore;

  // "Tiene depósitos" = depositó plata de verdad. Un cliente con depósitos
  // completados por importe 0 (existen en el espejo) NO puede dividir, así que
  // cae en el mismo tramo que el que nunca depositó.
  const hasDeposits = deps.count > 0 && depositedBefore > 0;
  const ratio = hasDeposits ? amount / depositedBefore : null;

  const registerDate = toDate(input.registerDate);
  const accountAgeDays =
    registerDate && requestedAt
      ? Math.max(0, (requestedAt.getTime() - registerDate.getTime()) / 86_400_000)
      : null;

  const sorted = deps.dates.slice().sort((a, b) => a.getTime() - b.getTime());
  const rejectedCountBefore = Math.max(0, Math.trunc(num(input.rejectedCountBefore)));
  const p2pReceived = Math.max(0, num(input.p2pReceived) ?? 0);
  // Los dominios del broker se comprueban acá y no en la capa de datos para
  // que la regla viaje con el cálculo: quien lea features.ts ve por qué a un
  // BDM no se le mide el dinero recibido como sospechoso.
  const mail = (input.email ?? '').trim().toLowerCase();
  const isStaff = mail.endsWith('@vexprofx.com') || mail.endsWith('@mail.vexprofx.com');

  const sharedAddressUserCount = Math.max(0, Math.trunc(num(input.sharedAddressUserCount)));

  return {
    amount,
    requestedAt,
    depositedBefore,
    withdrawnBefore,
    netBefore,
    depositCountBefore: deps.count,
    withdrawalCountBefore: wds.count,
    hasDeposits,
    ratio,
    accountAgeDays,
    rejectedCountBefore,
    firstDepositAt: sorted[0] ?? null,
    lastDepositAt: sorted[sorted.length - 1] ?? null,
    ratioBucket: ratioBucketOf(ratio, hasDeposits),
    ageBucket: ageBucketOf(accountAgeDays),
    netBucket: netBucketOf(netBefore, hasDeposits),
    rejectionBucket: rejectionBucketOf(rejectedCountBefore),
    p2pBucket: p2pBucketOf(p2pReceived, amount, isStaff),
    p2pReceived,
    isStaff,
    context: {
      kycStatus: input.kycStatus ?? null,
      pendingFeeDebt: num(input.pendingFeeDebt),
      sharedAddressUserCount,
      addressShared: sharedAddressUserCount > 1,
    },
  };
}
