// ─────────────────────────────────────────────────────────────────────────────
// Los totales del mes que ya están en el CRM y hoy alguien teclea a mano.
//
// ── QUÉ ES «EL TOTAL DE TRANSFERENCIAS P2P DEL MES» ────────────────────────
// La pregunta obvia —¿IN, OUT o las dos?— tiene una respuesta medida. Una
// transferencia P2P deja DOS filas en `wallettransfers` por el MISMO dinero:
// un OUT en la billetera que manda y un IN en la que recibe. Sumar las dos
// duplica. Medido sobre los 2.892 movimientos P2P de Vex Pro (2026-08-27),
// restringiendo a las transferencias que `transferp2ps` da por COMPLETED:
//
//     mes        OUT netAmount     IN netAmount
//     2025-11        9.787,04         9.787,04
//     2025-12      136.213,42       136.213,42
//     2026-01       53.834,68        53.834,68
//     2026-02       76.693,78        76.693,78
//     2026-03       36.422,03        36.422,03
//     2026-05       21.270,04        21.270,04
//     2026-06       39.474,91        39.474,91
//
// Idénticos, como tenía que ser. Y el desempate contra lo que Kevin cargó a
// mano: `p2p_transfers` tiene UN período cargado en toda la historia de Vex
// Pro, 2025-11 = $9.787,04 — exactamente esa cifra, y NO el bruto del mes
// ($9.885,90). O sea: `netAmount`, un solo lado.
//
// Se elige **OUT** por tres razones, en orden:
//   1. Es la transferencia que se HIZO: la pata del que la manda.
//   2. Es el lado más completo: 1.451 patas OUT contra 1.441 IN.
//   3. Es lo que el repo ya decía querer (el viejo `orion-crm/totals.ts`, hoy eliminado: "P2P
//      transfers (withdrawals side)"), escrito antes de que hubiera datos.
//
// ── LO QUE HAY QUE EXCLUIR, Y POR QUÉ NO SE PUEDE MIRAR SÓLO wallettransfers ─
// Un P2P RECHAZADO también mueve plata: sale de la billetera del que manda y
// vuelve. Caso medido en AP Markets, transferencia 0eb70d64 del 2026-07-25:
//   OUT  $1.980  (userId 3543cac8…, 00:36:55)
//   IN   $2.000  (EL MISMO userId,  00:46:38)
// Contarla como transferencia del mes infla julio en $2.000 de dinero que
// nunca cambió de dueño. Por eso el estado manda, y el estado NO está en
// `wallettransfers`: está en `transferp2ps.transferStatus`. Vex Pro tiene
// $33.024,66 en 79 patas OUT de transferencias no completadas — el 6,6% del
// total —, casi todo concentrado en 2026-07 y 2026-08.
//
// Y al revés: 8 patas OUT ($3.858,56) no tienen documento en `transferp2ps`.
// Sin estado no se puede afirmar que se completaron, así que quedan FUERA y
// se informan en `excluded_*`: una exclusión silenciosa es indistinguible de
// un cruce roto.
//
// ── VENTAS DE PROP FIRM: `amountPaid`, no `price` ──────────────────────────
// La regla de la casa es que lo que se reparte es lo COBRADO. `price` es la
// lista, `discountAmount` el descuento y `amountPaid` lo que entró — y en
// 1.483 de 1.559 documentos price = amountPaid + discountAmount.
//
// La verificación es contra la billetera (`PROP_FIRM_PURCHASE`), que es otro
// registro del mismo hecho. Por mes, `userpropfirms.amountPaid` contra la
// pata de billetera:
//     2026-01  16.778,00 = 16.778,00      2026-02  51.409,65 = 51.409,65
//     2026-03  16.091,10 = 16.091,10      2026-04  10.705,15 = 10.705,15
//     2026-05  10.273,00 = 10.273,00      2026-07  14.645,20 = 14.645,20
//     2026-08  11.198,70 = 11.198,70      2026-06  13.830,20 ≠ 13.731,20
// El único mes que no cierra es junio, por $99 en 5 compras que no pasaron
// por la billetera. Se guarda la cifra de la billetera en `detail` para que
// la diferencia se vea sin volver a Mongo.
//
// El mes es el de `createdAt` y NO el de `startDate`: `startDate` es null en
// 46 de 1.559 documentos y `createdAt` nunca lo es. Da lo mismo para el
// dinero (los dos caen en el mismo mes en 1.512 de 1.513 casos con fecha) y
// evita un bucket "null" con $15.394 de precio de lista adentro.
//
// ── RETIROS DE PROP FIRM: `profitUserValue`, NO `requestedAmount` ──────────
// Lo que SALE de la empresa es la parte del trader, no la ganancia bruta del
// ciclo. El desempate contra lo que Kevin carga a mano en
// `withdrawals(category='prop_firm')`, medido el 2026-08-27:
//
//     mes        requestedAmount   profitUserValue   cargado a mano
//     2025-11        4.112,14          2.115,30         2.115,30
//     2025-12        7.209,60          5.416,20         5.416,20
//     2026-06        7.517,69          5.754,15         5.754,15
//     2026-07        6.985,74          5.511,98         5.511,00
//
// Cuatro meses clavados contra `profitUserValue` y ninguno contra
// `requestedAmount`, que se pasa entre un 20% y un 40% todos los meses. El
// bruto queda en `detail.requested` para poder ver la parte de la empresa.
//
// ── Y DESDE ORION, NO DESDE EL ESPEJO ──────────────────────────────────────
// `propfirm_withdrawal_queue` ya espeja estos retiros… pero sólo 180 días
// (DIAS en risk/propfirm-queue.ts). Como serie mensual eso se ENCOGE sola:
// medido el 2026-08-27, marzo de 2026 tenía 34 aprobados por $5.533,46 en el
// espejo y 36 por $6.480,46 en Orion — $947 ya se habían caído por el borde
// de la ventana, sin ningún error. La serie se calcula contra Orion, que
// tiene la historia entera y son ~250 documentos: leerlos cuesta nada.
//
// El mes es el de `authorizedDate` (cuándo se pagó), no el de la solicitud:
// un retiro pedido el 31 y pagado el 1 es plata que salió el mes siguiente.
//
// ── MONEDA ─────────────────────────────────────────────────────────────────
// USD en el 100% de las colecciones de Orion (verificado en la sesión de
// producción IB). Todo lo que sale de este módulo va etiquetado 'USD'.
//
// ── POR QUÉ ESTE ARCHIVO ESTÁ SEPARADO DEL SYNC ────────────────────────────
// Todo lo de acá es PURO y tiene que poder importarse desde el navegador: la
// pantalla /finanzas/crm necesita el registro de métricas. El sync vive en
// `crm-sync/monthly-totals.ts` porque arrastra el lector de Mongo, que es
// `server-only` — un import desde un componente cliente rompe el BUILD, no el
// typecheck ni los tests, así que se descubre tarde y en Vercel.
// ─────────────────────────────────────────────────────────────────────────────

import { HEDGE_FUND_CONCEPTS, conceptsOf, type WalletConceptGroup } from './crm-wallet-concepts';

// ─────────────────────────────────────────────────────────────────────────────
// Registro ÚNICO de métricas. Agregar una es agregar una fila acá; la tabla
// `crm_monthly_totals` no repite la lista a propósito (listas duplicadas que
// se desincronizan en silencio son el modo de falla número uno de este repo).
// ─────────────────────────────────────────────────────────────────────────────

export interface CrmMonthlyMetricDef {
  key: string;
  labelEs: string;
  labelEn: string;
  /**
   * Con qué se compara en pantalla, para que nadie las sume por error.
   * `null` SÓLO en las métricas informativas: no tienen contraparte manual
   * porque no entran a ninguna cifra de finanzas (ver `informational`).
   */
  manualSource: string | null;
  /**
   * `true` = el número es DATO, no finanzas. No se compara con nada, no se
   * suma a nada y la pantalla lo muestra aparte, con la advertencia.
   * El porqué está en el bloque «MÉTRICAS INFORMATIVAS» más abajo.
   */
  informational?: boolean;
  /** Explicación corta de por qué no cuenta. Sólo en las informativas. */
  whyNotFinanceEs?: string;
  whyNotFinanceEn?: string;
  /**
   * Columnas EXTRA que la tabla informativa muestra leyendo `detail[key]`.
   *
   * Existen porque el hedge fund no es un número: son tres hechos distintos
   * (capital invertido, rendimiento acreditado, capital devuelto) y meterlos
   * en una sola cifra neta daría un número plausible que no significa nada —
   * el modo de falla de este repo. La lista vive acá, en el registro, y no en
   * el JSX, para que agregar una serie sea agregar una fila y no tocar la
   * pantalla.
   *
   * `undefined` en el `detail` se muestra "—" (no lo sabemos), nunca $0.
   */
  detailColumns?: readonly { key: string; labelEs: string; labelEn: string }[];
}

const METRIC_DEFS = [
  {
    key: 'p2p_transfers',
    labelEs: 'Transferencias P2P',
    labelEn: 'P2P transfers',
    manualSource: 'p2p_transfers.amount',
  },
  {
    key: 'propfirm_sales',
    labelEs: 'Ventas Prop Firm',
    labelEn: 'Prop firm sales',
    manualSource: 'prop_firm_sales.amount',
  },
  {
    key: 'propfirm_withdrawals',
    labelEs: 'Retiros Prop Firm aprobados',
    labelEn: 'Approved prop firm withdrawals',
    manualSource: "withdrawals.amount (category 'prop_firm')",
  },
  // ── MÉTRICAS INFORMATIVAS (decisión de Kevin, 2026-08-28) ────────────────
  //
  // El dashboard de finanzas es BASE CAJA. Estas tres mueven la BILLETERA del
  // cliente o del IB, no la caja del bróker:
  //
  //   · La comisión IB acreditada es DEUDA INTERNA. La caja se mueve el día
  //     que el IB retira — y ese retiro YA se cuenta en los egresos. Sumar la
  //     acreditación al resultado sería contar el mismo dólar dos veces.
  //   · El social trading fee es el mismo caso: se acredita en la billetera
  //     del gestor y sale, si sale, como retiro.
  //   · El fee debt recovery es plata que se DESCUENTA de una billetera para
  //     cancelar un fee que había quedado adeudado. No entra ni sale de la
  //     caja: cambia de bolsillo dentro del CRM.
  //
  // Se muestran porque el dato sirve (cuánto se le debe al canal IB, cuánto
  // generó social trading), separadas y con la advertencia visible.
  {
    key: 'ib_commissions',
    labelEs: 'Comisiones IB acreditadas',
    labelEn: 'IB commissions credited',
    manualSource: null,
    informational: true,
    whyNotFinanceEs:
      'Es deuda interna con el IB: la caja se mueve cuando el IB retira, y ese retiro ya se cuenta como egreso.',
    whyNotFinanceEn:
      'It is internal debt owed to the IB: cash only moves when the IB withdraws, and that withdrawal is already counted as an outflow.',
  },
  {
    key: 'social_trading_fees',
    labelEs: 'Social trading fees',
    labelEn: 'Social trading fees',
    manualSource: null,
    informational: true,
    whyNotFinanceEs:
      'Se acredita en la billetera del gestor, no en la caja: sale recién cuando se retira, y ese retiro ya se cuenta.',
    whyNotFinanceEn:
      'Credited to the manager’s wallet, not to cash: it only leaves when withdrawn, and that withdrawal is already counted.',
  },
  {
    key: 'fee_debt_recovery',
    labelEs: 'Fee debt recovery',
    labelEn: 'Fee debt recovery',
    manualSource: null,
    informational: true,
    whyNotFinanceEs:
      'Descuenta de la billetera del cliente un fee que había quedado adeudado: cambia de bolsillo dentro del CRM, no entra a la caja.',
    whyNotFinanceEn:
      'Debits a previously owed fee from the customer’s wallet: it moves between pockets inside the CRM, it does not reach cash.',
  },
  // ── Hedge fund (decisión de Kevin, 2026-08-31) ──────────────────────────
  // Cuarta serie informativa, mismo patrón que las tres de arriba.
  //
  // POR QUÉ NO ES UNA SERIE NETA: mirando los documentos reales del 2026-08-31,
  // la familia tiene tres hechos que no se cancelan entre sí. El capital sale
  // de la billetera (INVEST, OUT), el rendimiento entra (REWARD, IN) y el
  // capital vuelve cuando el cliente rescata (RETURN, IN). Netearlos daría
  // $23.928,88 − $927,10 − $302,00 = $22.699,78 para AP Markets, un número que
  // no responde ninguna pregunta: ni cuánto hay colocado, ni cuánto rindió.
  // La columna principal es el CAPITAL INVERTIDO y las otras dos van al lado,
  // en `detailColumns`.
  //
  // POR QUÉ NO CUENTA EN EL RESULTADO: es el mismo argumento de las otras tres.
  // El cliente mueve plata de su billetera a un fondo; la caja del bróker no
  // se movió. El día que el fondo pague o devuelva, ese movimiento sale como
  // retiro y YA se cuenta como egreso.
  {
    key: 'hedge_fund',
    labelEs: 'Hedge fund',
    labelEn: 'Hedge fund',
    manualSource: null,
    informational: true,
    whyNotFinanceEs:
      'El cliente mueve capital de su billetera a un fondo: no entra ni sale de la caja del bróker. Lo que sí toca la caja es el retiro, que ya se cuenta como egreso.',
    whyNotFinanceEn:
      'The customer moves capital from their wallet into a fund: it neither enters nor leaves the broker’s cash. What does touch cash is the withdrawal, already counted as an outflow.',
    detailColumns: [
      { key: 'rewards', labelEs: 'Rendimientos acreditados', labelEn: 'Rewards credited' },
      { key: 'rewardsReversed', labelEs: 'Rendimientos revertidos', labelEn: 'Rewards reversed' },
      { key: 'capitalReturned', labelEs: 'Capital devuelto', labelEn: 'Capital returned' },
    ],
  },
] as const satisfies readonly CrmMonthlyMetricDef[];

export type CrmMonthlyMetric = (typeof METRIC_DEFS)[number]['key'];

export const CRM_MONTHLY_METRICS: CrmMonthlyMetricDef[] = METRIC_DEFS.map((m) => ({ ...m }));
export const CRM_MONTHLY_METRIC_KEYS: string[] = CRM_MONTHLY_METRICS.map((m) => m.key);

/** Las que se comparan contra lo cargado a mano (la tabla de arriba). */
export const CRM_MONTHLY_COMPARED_METRICS: CrmMonthlyMetricDef[] =
  CRM_MONTHLY_METRICS.filter((m) => m.informational !== true);

/** Las que son DATO y no cuentan en el resultado (la sección de abajo). */
export const CRM_MONTHLY_INFO_METRICS: CrmMonthlyMetricDef[] =
  CRM_MONTHLY_METRICS.filter((m) => m.informational === true);

/** Los ÚNICOS campos que se piden de cada colección. La proyección es la aduana. */
export const ORION_P2P_LEG_FIELDS = [
  'concept', 'walletTransferType', 'netAmount', 'grossAmount', 'walletTransferDate', 'relatedConceptId',
] as const;
export const ORION_TRANSFER_P2P_FIELDS = ['transferId', 'transferStatus'] as const;
export const ORION_USER_PROPFIRM_FIELDS = [
  'userPropFirmId', 'price', 'amountPaid', 'discountAmount', 'createdAt', 'startDate',
] as const;
/**
 * Subconjunto de la proyección de `risk/propfirm-queue.ts`
 * (ORION_WITHDRAWAL_FIELDS). No se importa de allá a propósito: ese módulo
 * arrastra el cliente de MT5 y el motor de revisión, y esto tiene que poder
 * correr —y testearse— sin nada de eso.
 */
export const ORION_PROPFIRM_WITHDRAWAL_FIELDS = [
  'withdrawId', 'requestedAmount', 'profitUserValue', 'profitSharePercent',
  'requestedDate', 'status', 'authorizedDate',
] as const;

/** Concepto de la pata de billetera de una compra de prop firm. */
export const PROPFIRM_PURCHASE_CONCEPT = 'PROP_FIRM_PURCHASE';

/** El único estado de `transferp2ps` en el que el dinero cambió de dueño. */
export const P2P_COMPLETED = 'COMPLETED';

/** El único estado de `withdrawalpropfirms` en el que el retiro se pagó. */
export const PROPFIRM_WITHDRAWAL_APPROVED = 'APPROVED';

// ─────────────────────────────────────────────────────────────────────────────
// Núcleo PURO — es la parte que decide, y por eso es la que se testea.
// ─────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM` en UTC. `new Date(texto).getMonth()` depende de la zona del
 *  proceso: en producción acertaba de casualidad (ver G4 en las reglas). */
export function monthKeyUtc(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function splitMonthKey(key: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `null` NO es `0`. `Number(null)` devuelve 0, así que un importe ausente se
 * colaría como "el mes fue de cero" en vez de "esta fila no tiene importe".
 * Es la misma clase de bug que la regla §1.3 de las reglas del proyecto.
 */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface MonthlyBucket {
  amount: number;
  count: number;
  excludedCount: number;
  excludedAmount: number;
  /** Números de contraste: el otro lado, la otra fuente. */
  cross: Record<string, number>;
}

export interface P2pLeg {
  walletTransferType?: unknown;
  netAmount?: unknown;
  grossAmount?: unknown;
  walletTransferDate?: unknown;
  relatedConceptId?: unknown;
}

/**
 * El total P2P de cada mes a partir de las patas de billetera y del estado de
 * cada transferencia. Pura: recibe los documentos ya leídos.
 *
 * `cross.inSide` es el mismo total por el otro lado. Tiene que dar ~igual; si
 * un mes se separa, es que hay patas huérfanas y el número hay que mirarlo.
 */
export function aggregateP2pByMonth(
  legs: readonly P2pLeg[],
  statusByTransferId: ReadonlyMap<string, string>,
): Map<string, MonthlyBucket> {
  const out = new Map<string, MonthlyBucket>();
  const bucket = (key: string): MonthlyBucket => {
    let b = out.get(key);
    if (!b) {
      b = { amount: 0, count: 0, excludedCount: 0, excludedAmount: 0, cross: { inSide: 0, inCount: 0, noStatusCount: 0, noStatusAmount: 0 } };
      out.set(key, b);
    }
    return b;
  };

  for (const leg of legs) {
    const key = monthKeyUtc(leg.walletTransferDate as string);
    if (!key) continue;
    const dir = String(leg.walletTransferType ?? '');
    if (dir !== 'IN' && dir !== 'OUT') continue;

    const neto = numOrNull(leg.netAmount);
    if (neto === null) continue;

    const b = bucket(key);
    const status = statusByTransferId.get(String(leg.relatedConceptId ?? ''));

    if (status === P2P_COMPLETED) {
      if (dir === 'OUT') {
        b.amount += neto;
        b.count += 1;
      } else {
        b.cross.inSide += neto;
        b.cross.inCount += 1;
      }
      continue;
    }

    // Fuera del total, pero contado: rechazadas, pendientes, canceladas y las
    // que no tienen documento de estado.
    if (dir === 'OUT') {
      b.excludedCount += 1;
      b.excludedAmount += neto;
      if (!status) {
        b.cross.noStatusCount += 1;
        b.cross.noStatusAmount += neto;
      }
    }
  }

  for (const b of out.values()) {
    b.amount = round2(b.amount);
    b.excludedAmount = round2(b.excludedAmount);
    b.cross.inSide = round2(b.cross.inSide);
    b.cross.noStatusAmount = round2(b.cross.noStatusAmount);
  }
  return out;
}

export interface PropfirmPurchase {
  amountPaid?: unknown;
  price?: unknown;
  discountAmount?: unknown;
  createdAt?: unknown;
}

/**
 * Ventas de prop firm por mes: lo COBRADO (`amountPaid`).
 *
 * Una compra con `amountPaid = 0` (cupón del 100%, o compra que no llegó a
 * pagarse) NO es una venta: entra a `excluded_*` con su precio de lista, para
 * que "vendimos 245 cuentas" y "cobramos por 140" sean dos números visibles y
 * distintos.
 */
export function aggregatePropfirmSalesByMonth(
  purchases: readonly PropfirmPurchase[],
): Map<string, MonthlyBucket> {
  const out = new Map<string, MonthlyBucket>();
  for (const p of purchases) {
    const key = monthKeyUtc(p.createdAt as string);
    if (!key) continue;
    let b = out.get(key);
    if (!b) {
      b = { amount: 0, count: 0, excludedCount: 0, excludedAmount: 0, cross: { listPrice: 0, discount: 0, wallet: 0 } };
      out.set(key, b);
    }
    const pagado = numOrNull(p.amountPaid);
    b.cross.listPrice += numOrNull(p.price) ?? 0;
    b.cross.discount += numOrNull(p.discountAmount) ?? 0;
    if (pagado !== null && pagado > 0) {
      b.amount += pagado;
      b.count += 1;
    } else {
      b.excludedCount += 1;
      b.excludedAmount += numOrNull(p.price) ?? 0;
    }
  }
  for (const b of out.values()) {
    b.amount = round2(b.amount);
    b.excludedAmount = round2(b.excludedAmount);
    b.cross.listPrice = round2(b.cross.listPrice);
    b.cross.discount = round2(b.cross.discount);
  }
  return out;
}

export interface PropfirmWithdrawalDoc {
  status?: unknown;
  /** Ganancia bruta del ciclo. NO es lo que sale de la empresa. */
  requestedAmount?: unknown;
  /** La parte del trader: esto SÍ es lo que sale. */
  profitUserValue?: unknown;
  authorizedDate?: unknown;
  requestedDate?: unknown;
}

/**
 * Retiros de prop firm por mes de PAGO, medidos por la parte del trader
 * (`profitUserValue`). Los no aprobados se cuentan aparte: un rechazado por
 * $30.093 (marzo 2026) puesto en la misma columna que lo pagado sería un
 * egreso inventado.
 */
export function aggregatePropfirmWithdrawalsByMonth(
  docs: readonly PropfirmWithdrawalDoc[],
): Map<string, MonthlyBucket> {
  const out = new Map<string, MonthlyBucket>();
  const bucket = (key: string): MonthlyBucket => {
    let b = out.get(key);
    if (!b) {
      b = { amount: 0, count: 0, excludedCount: 0, excludedAmount: 0, cross: { requested: 0 } };
      out.set(key, b);
    }
    return b;
  };

  for (const d of docs) {
    const aprobado = String(d.status ?? '') === PROPFIRM_WITHDRAWAL_APPROVED;
    // Un aprobado sin fecha de autorización no puede caer en ningún mes de
    // pago: se lo cuenta como excluido en el mes de la solicitud, que sí
    // existe. Inventarle un mes sería un egreso que nadie hizo.
    const key = monthKeyUtc((d.authorizedDate as string) ?? (d.requestedDate as string));
    if (!key) continue;
    const bruto = numOrNull(d.requestedAmount);
    const pagado = numOrNull(d.profitUserValue);
    if (bruto === null && pagado === null) continue;
    const b = bucket(key);
    if (aprobado && d.authorizedDate && pagado !== null) {
      b.amount += pagado;
      b.count += 1;
    } else {
      // Sin `profitUserValue` no se sabe cuánto salió: el bruto es una cota
      // superior, no el dato. Va a excluido con lo que se tenga.
      b.excludedCount += 1;
      b.excludedAmount += pagado ?? bruto ?? 0;
    }
    b.cross.requested += bruto ?? 0;
  }
  for (const b of out.values()) {
    b.amount = round2(b.amount);
    b.excludedAmount = round2(b.excludedAmount);
    b.cross.requested = round2(b.cross.requested);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// MÉTRICAS INFORMATIVAS — comisiones IB, social trading fees, fee debt
// recovery.
//
// ── DE DÓNDE SALEN ─────────────────────────────────────────────────────────
// De `wallettransfers`, la misma colección que ya alimenta el P2P. Sondeadas
// contra los documentos REALES el 2026-08-28 (Vex Pro: 32 combinaciones de
// concepto × dirección; AP Markets: 19). Los conceptos NO se adivinaron: el
// registro único está en `crm-wallet-concepts.ts` y estas listas se DERIVAN
// de él.
//
// ── LA DIRECCIÓN ES PARTE DE LA DEFINICIÓN ─────────────────────────────────
// Comisiones IB y social trading fees son patas **IN** (dinero que entra a la
// billetera de alguien). Fee debt recovery es una pata **OUT** (dinero que se
// le descuenta al cliente). Contar las dos direcciones juntas mezcla el
// crédito con su corrección.
//
// Las patas de la dirección CONTRARIA no se tiran: van a `excluded_*`. Son
// pocas y son correcciones reales — medidas en Vex Pro:
//   · 3 patas OUT de IB_REWARDS_BROKER por $1.843,74 ("IB REWARDS
//     (Correction)" ×2 en 2026-01 y "Ajuste mar-26" en 2026-04).
//   · 1 pata OUT de SOCIAL_PERFORMANCE_FEE por $51,55 en 2026-06.
//   · 0 patas IN de FEE_DEBT_RECOVERY.
// Una exclusión silenciosa es indistinguible de un cruce roto.
//
// ── `netAmount`, NUNCA `grossAmount` ───────────────────────────────────────
// La trampa más cara de estas tres. En `IB_PROP_FIRM_REWARD` el bruto es el
// precio de la cuenta de prop firm y el neto es la parte del IB: 5.286
// documentos, gross $629.868,70 contra net $22.357,85 — VEINTIOCHO veces.
// Usar el bruto convertiría $871.632 en $1.479.143. El bruto se guarda en
// `detail.gross` para que la diferencia se vea sin volver a Mongo.
//
// ── ¿QUÉ ESTADOS SE CUENTAN? NINGUNO: NO HAY ESTADO ────────────────────────
// La pregunta obligada («¿sólo los completados?») tiene respuesta medida y es
// que NO APLICA. `wallettransfers` no tiene campo de estado: las 19 claves
// distintas de una muestra de 3.000 documentos son _id, walletTransferId,
// walletId, walletType, userId, concept, relatedConceptId,
// relatedConceptName, grossAmount, fee, netAmount, walletTransferType,
// walletTransferDate, couponId, couponName, discountApplied, createdAt,
// updatedAt y __v. La fila ES el asiento: si existe, el movimiento ya se
// aplicó al saldo. Es distinto del P2P, donde el estado vive en otra
// colección (`transferp2ps`) porque una transferencia puede quedar pendiente
// o rechazarse; acá la corrección se escribe como OTRO movimiento, y por eso
// las patas contrarias se cuentan como excluidas en vez de filtrarse.
//
// ── EL REVERSO NO ES UN FEE ────────────────────────────────────────────────
// `PERFORMANCE_FEE_REVERSAL` y `PERFORMANCE_FEE_REVERSAL_ADJUSTMENT` son 35
// movimientos, todos del 2026-07-26, por $1.630,90. Su propio `internalNote`
// dice qué son: "Reverso perf-fee fantasma (bug balance EOD congelado en
// retiro, fix eb3dd1a1)". Sumarlos daría $144.596,58 de social trading fees
// donde lo cobrado fue $142.965,68 — y encima cargados a julio, un mes en el
// que los fees revertidos ni siquiera se cobraron. Van a `detail.reversals`,
// visibles y sin sumar.
//
// ── LA CONCILIACIÓN ────────────────────────────────────────────────────────
// Contra la medición de la sesión anterior (2026-08-27), Vex Pro:
//   · social trading fees   142.965,68 acumulado hoy · 142.964,83 al corte
//     del 27 → el número de la sesión anterior ($142.965) es EXACTO.
//   · comisiones IB         871.632,72 acumulado hoy · 864.426,33 al corte
//     del 27 y 869.702,66 al del 28 → los $868.757 de la sesión anterior caen
//     dentro del día 27, que es cuando se midió. IB_REWARDS_BROKER acredita
//     todos los días (105.961 documentos sólo en agosto): la serie se mueve
//     sola, no hay discrepancia.
//   · fee debt recovery     2.336,27 en 32 movimientos (2026-06 a 2026-08).
// AP Markets tiene IB ($1.045,75) y social ($1.212,42) pero CERO
// FEE_DEBT_RECOVERY: esa métrica no escribe ninguna fila para AP, que es
// "sin datos" y no "$0".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Una fila ya agrupada por Mongo: (concepto, dirección, mes). Se agrupa allá
 * y no acá porque las comisiones IB de Vex Pro son 225.569 documentos —
 * traerlos enteros para sumarlos en JS cuesta memoria y red por nada. Lo que
 * SÍ decide esta capa (qué concepto cuenta, en qué dirección, qué es
 * contraste y qué queda sin clasificar) es puro y está testeado.
 */
export interface WalletConceptMonthRow {
  concept: string;
  /** 'IN' | 'OUT' tal como viene de `walletTransferType`. */
  direction: string;
  /** 'YYYY-MM' en UTC, o null si la fecha del documento no se pudo convertir. */
  monthKey: string | null;
  count: number;
  net: number;
  gross: number;
}

export interface WalletMetricSpec {
  metric: string;
  /**
   * La familia del registro de conceptos de la que sale la métrica. El sync
   * le pasa TODAS las filas del grupo, no sólo las de `concepts`: así, si
   * mañana alguien agrega un concepto a la familia sin decidir si suma, cae
   * en `unclassified` y avisa, en vez de desaparecer.
   */
  group: WalletConceptGroup;
  /** Los conceptos que suman a `amount`. */
  concepts: readonly string[];
  /** La dirección que suma. La contraria va a `excluded_*`. */
  direction: 'IN' | 'OUT';
  /** Conceptos que NO suman y se informan aparte (los reversos). */
  contrastConcepts?: readonly string[];
  /** Con qué nombre van al `detail`. */
  contrastKey?: string;
  /**
   * Series HERMANAS de la métrica: conceptos de la MISMA familia que no suman
   * al total pero tampoco son un reverso del total — son otro hecho.
   *
   * Nació con el hedge fund: `HEDGE_FUND_REWARD` (IN) y `HEDGE_FUND_RETURN`
   * (IN) conviven con `HEDGE_FUND_INVEST` (OUT) y no se pueden meter en
   * `contrastConcepts`, que suma todo en UNA sola clave y mezclaría el
   * rendimiento con el capital devuelto.
   *
   * Cada entrada va a `detail[key]` (importe) y `detail[key + 'Count']`
   * (movimientos). Un concepto declarado acá que llegue con una dirección que
   * ninguna entrada declara NO se traga en silencio: cae en `unclassified` y
   * el sync avisa, igual que un concepto nuevo del bróker.
   */
  extraSeries?: readonly { key: string; concepts: readonly string[]; direction: 'IN' | 'OUT' }[];
}

export interface WalletMetricResult {
  buckets: Map<string, MonthlyBucket>;
  /**
   * Conceptos que llegaron y la spec no conoce, con su monto. NO se los traga
   * en silencio: el sync los convierte en aviso. Un concepto nuevo del broker
   * tiene que verse, no desaparecer.
   */
  unclassified: Map<string, { count: number; amount: number }>;
  /** Filas sin mes utilizable. Inventarles uno sería un dato falso. */
  noMonth: { count: number; amount: number };
}

/** Las specs, DERIVADAS del registro de conceptos. Nunca literales sueltos. */
export const WALLET_METRIC_SPECS: WalletMetricSpec[] = [
  {
    metric: 'ib_commissions',
    group: 'ib',
    concepts: conceptsOf('ib', 'credit'),
    direction: 'IN',
  },
  {
    metric: 'social_trading_fees',
    group: 'social',
    concepts: conceptsOf('social', 'credit'),
    direction: 'IN',
    contrastConcepts: conceptsOf('social', 'reversal'),
    contrastKey: 'reversals',
  },
  {
    metric: 'fee_debt_recovery',
    group: 'feeDebt',
    concepts: conceptsOf('feeDebt', 'credit'),
    direction: 'OUT',
  },
  {
    metric: 'hedge_fund',
    group: 'hedgeFund',
    // El total de la serie es el CAPITAL INVERTIDO: sale de la billetera (OUT).
    concepts: conceptsOf('hedgeFund', 'credit'),
    direction: 'OUT',
    extraSeries: [
      { key: 'rewards', concepts: [HEDGE_FUND_CONCEPTS.reward], direction: 'IN' },
      { key: 'rewardsReversed', concepts: [HEDGE_FUND_CONCEPTS.reward], direction: 'OUT' },
      { key: 'capitalReturned', concepts: [HEDGE_FUND_CONCEPTS.capitalReturn], direction: 'IN' },
    ],
  },
];

/**
 * Todos los conceptos que hay que traer de Mongo para las tres métricas: la
 * familia ENTERA de cada una, no sólo los que suman. Ver `group` en la spec.
 */
export const WALLET_METRIC_CONCEPTS: string[] = [
  ...new Set(WALLET_METRIC_SPECS.flatMap((s) => conceptsOf(s.group))),
];

/**
 * Agrega las filas ya agrupadas en la serie mensual de UNA métrica.
 *
 * Un mes existe si tuvo algún movimiento de la métrica —contado, excluido o
 * de contraste—. Un mes sin ninguno NO se inventa en cero: la empresa que no
 * tiene la serie no escribe filas, y eso es "sin datos".
 */
export function aggregateWalletMetricByMonth(
  rows: readonly WalletConceptMonthRow[],
  spec: WalletMetricSpec,
): WalletMetricResult {
  const counted = new Set(spec.concepts);
  const contrast = new Set(spec.contrastConcepts ?? []);
  const contrastKey = spec.contrastKey ?? 'contrast';
  const extras = spec.extraSeries ?? [];
  // Un mismo concepto puede aparecer en varias entradas con direcciones
  // distintas (HEDGE_FUND_REWARD va a `rewards` en IN y a `rewardsReversed`
  // en OUT), así que el índice es concepto → lista.
  const extraByConcept = new Map<string, typeof extras>();
  for (const e of extras) {
    for (const c of e.concepts) {
      extraByConcept.set(c, [...(extraByConcept.get(c) ?? []), e]);
    }
  }

  const out = new Map<string, MonthlyBucket>();
  const unclassified = new Map<string, { count: number; amount: number }>();
  const noMonth = { count: 0, amount: 0 };

  const bucket = (key: string): MonthlyBucket => {
    let b = out.get(key);
    if (!b) {
      b = {
        amount: 0,
        count: 0,
        excludedCount: 0,
        excludedAmount: 0,
        cross: { gross: 0, [contrastKey]: 0, contraCount: 0 },
      };
      // Las series hermanas arrancan en 0 —no `undefined`— porque el mes
      // existe justamente porque la familia tuvo movimiento: se leyó entera y
      // esa serie no tuvo ninguno. Eso ES cero, no "no lo sabemos".
      for (const e of extras) {
        b.cross[e.key] = 0;
        b.cross[`${e.key}Count`] = 0;
      }
      out.set(key, b);
    }
    return b;
  };

  for (const r of rows) {
    const esContado = counted.has(r.concept);
    const esContraste = contrast.has(r.concept);
    const hermanas = extraByConcept.get(r.concept);
    // Serie hermana: va a su propia clave del `detail`, no al total.
    if (!esContado && !esContraste && hermanas) {
      const destino = hermanas.find((e) => e.direction === r.direction);
      const neto = numOrNull(r.net);
      if (!destino || neto === null) {
        // Dirección que ninguna entrada declara (o importe ausente): NO se
        // traga en silencio. Ver el comentario de `extraSeries`.
        const prev = unclassified.get(r.concept) ?? { count: 0, amount: 0 };
        prev.count += r.count;
        prev.amount = round2(prev.amount + (neto ?? 0));
        unclassified.set(r.concept, prev);
        continue;
      }
      if (!r.monthKey || !splitMonthKey(r.monthKey)) {
        noMonth.count += r.count;
        noMonth.amount = round2(noMonth.amount + neto);
        continue;
      }
      const b = bucket(r.monthKey);
      b.cross[destino.key] += neto;
      b.cross[`${destino.key}Count`] += r.count;
      continue;
    }
    if (!esContado && !esContraste) {
      // Ni de la métrica ni de su contraste: se cuenta y se avisa.
      const prev = unclassified.get(r.concept) ?? { count: 0, amount: 0 };
      prev.count += r.count;
      prev.amount = round2(prev.amount + (numOrNull(r.net) ?? 0));
      unclassified.set(r.concept, prev);
      continue;
    }

    const neto = numOrNull(r.net);
    if (neto === null) continue;

    if (!r.monthKey || !splitMonthKey(r.monthKey)) {
      // Sin mes no puede caer en ninguna fila. Se cuenta y se avisa.
      noMonth.count += r.count;
      noMonth.amount = round2(noMonth.amount + neto);
      continue;
    }

    const b = bucket(r.monthKey);

    if (esContraste) {
      b.cross[contrastKey] += neto;
      continue;
    }

    if (r.direction === spec.direction) {
      b.amount += neto;
      b.count += r.count;
      b.cross.gross += numOrNull(r.gross) ?? 0;
    } else {
      // La pata contraria es la CORRECCIÓN del crédito. Fuera del total,
      // pero contada y con monto.
      b.excludedCount += r.count;
      b.excludedAmount += neto;
      b.cross.contraCount += r.count;
    }
  }

  for (const b of out.values()) {
    b.amount = round2(b.amount);
    b.excludedAmount = round2(b.excludedAmount);
    for (const k of Object.keys(b.cross)) b.cross[k] = round2(b.cross[k]);
  }

  return { buckets: out, unclassified, noMonth };
}

/** Total por mes de las patas de billetera de compras de prop firm. */
export function aggregateWalletPropfirmByMonth(legs: readonly P2pLeg[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const leg of legs) {
    const key = monthKeyUtc(leg.walletTransferDate as string);
    if (!key) continue;
    if (String(leg.walletTransferType ?? '') !== 'OUT') continue;
    const n = numOrNull(leg.netAmount);
    if (n === null) continue;
    out.set(key, (out.get(key) ?? 0) + n);
  }
  for (const [k, v] of out) out.set(k, round2(v));
  return out;
}
