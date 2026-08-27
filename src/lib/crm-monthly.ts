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

// ─────────────────────────────────────────────────────────────────────────────
// Registro ÚNICO de métricas. Agregar una es agregar una fila acá; la tabla
// `crm_monthly_totals` no repite la lista a propósito (listas duplicadas que
// se desincronizan en silencio son el modo de falla número uno de este repo).
// ─────────────────────────────────────────────────────────────────────────────

export interface CrmMonthlyMetricDef {
  key: string;
  labelEs: string;
  labelEn: string;
  /** Con qué se compara en pantalla, para que nadie las sume por error. */
  manualSource: string;
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
] as const satisfies readonly CrmMonthlyMetricDef[];

export type CrmMonthlyMetric = (typeof METRIC_DEFS)[number]['key'];

export const CRM_MONTHLY_METRICS: CrmMonthlyMetricDef[] = METRIC_DEFS.map((m) => ({ ...m }));
export const CRM_MONTHLY_METRIC_KEYS: string[] = CRM_MONTHLY_METRICS.map((m) => m.key);

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
