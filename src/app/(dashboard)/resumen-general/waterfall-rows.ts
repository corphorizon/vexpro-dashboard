// ─────────────────────────────────────────────────────────────────────────────
// waterfall-rows — la cascada del resultado de /resumen-general, en filas de
// tabla, SIN React (rediseño «Libro mayor», 2026-10-12).
//
// POR QUÉ: la pantalla mostraba Ingresos, Egresos y Neto en tres tarjetas y
// el desglose de ingresos en una cuarta, sin la reserva, la deuda arrastrada
// ni el monto a distribuir; el informe de cierre (PDF) sí tenía «Cómo se llega
// al resultado». Dos maneras de contar el mismo mes. La tanda pide que la
// pantalla tenga LAS MISMAS FILAS que el PDF, así que la cascada sale de
// `buildCloseWaterfall` (monthly-close-pdf-data.ts) — la misma función, los
// mismos renglones, los mismos controles de cuadre — y acá sólo se le pone
// clave, signo y rótulo traducible a cada fila.
//
// Las claves salen del rótulo que imprime el PDF (castellano fijo). Si
// alguien renombra un renglón allá, `waterfallKey` cae a 'unknown' y el test
// de este archivo falla: el rótulo traducido no puede desincronizarse en
// silencio del renglón que representa.
//
// DESCARTADO:
//   · Reescribir la fórmula acá (ingresos − egresos − deuda − reserva): sería
//     la tercera copia después de distribution.ts y el PDF (§1.1).
//   · Cascada en consolidado: la deuda cubierta y la reserva de N meses no se
//     suman (un mes negativo no drena la reserva, §2.2), y el control
//     «resultado − deuda − reserva = a distribuir» daría una «diferencia»
//     falsa. En consolidado la pantalla lo dice en vez de inventarla.
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildCloseWaterfall,
  type WaterfallInput,
  type WaterfallKind,
  type WaterfallResult,
} from '@/lib/monthly-close-pdf-data';

export type WaterfallKey =
  | 'brokerPnl'
  | 'propFirm'
  | 'investments'
  | 'other'
  | 'ingresos'
  | 'egresos'
  | 'resultado'
  | 'deuda'
  | 'reserva'
  | 'distribuir'
  | 'unknown';

export interface WaterfallTableRow {
  key: WaterfallKey;
  /** Rótulo del PDF, tal cual (respaldo si falta la traducción). */
  pdfLabel: string;
  /** null = sin datos del CRM (o depende de un dato que no llegó). Nunca 0. */
  amount: number | null;
  kind: WaterfallKind;
  /** «+», «−» o «=» delante del rótulo: cómo entra la fila a la cuenta. */
  op: '+' | '−' | '=';
  /** Total intermedio → fila `group-row`. */
  isTotal: boolean;
  /** El signo ES la noticia (resultado, a distribuir): `tone="sign"`. */
  signTone: boolean;
}

/** Rótulos fijos del PDF → clave. Los que llevan parámetro se reconocen por prefijo. */
const FIXED: Record<string, WaterfallKey> = {
  'Broker P&L': 'brokerPnl',
  'Prop Firm neto': 'propFirm',
  'Ganancias de inversiones': 'investments',
  'Ingresos netos': 'ingresos',
  'Egresos del mes': 'egresos',
  'Resultado del mes': 'resultado',
  'Deuda arrastrada cubierta': 'deuda',
  'A distribuir': 'distribuir',
};

export function waterfallKey(label: string, otherLabel?: string): WaterfallKey {
  if (label in FIXED) return FIXED[label];
  if (label.startsWith('Reserva del mes')) return 'reserva';
  if (label === (otherLabel ?? 'Otros ingresos')) return 'other';
  return 'unknown';
}

/** Filas de la tabla desde el resultado de `buildCloseWaterfall`. */
export function waterfallTableRows(result: WaterfallResult, otherLabel?: string): WaterfallTableRow[] {
  return result.rows.map((r) => {
    const key = waterfallKey(r.label, otherLabel);
    const isTotal = r.kind === 'total';
    return {
      key,
      pdfLabel: r.label,
      amount: r.amount,
      kind: r.kind,
      op: isTotal ? '=' : r.kind === 'expense' ? '−' : '+',
      isTotal,
      signTone: key === 'resultado',
    };
  });
}

/** Diferencias de cuadre para el aviso `bad`. Vacío = cuadra (o no se pudo controlar). */
export function waterfallMismatches(
  result: Pick<WaterfallResult, 'diferenciaIngresos' | 'diferenciaDistribucion'>,
): Array<{ key: 'ingresos' | 'distribucion'; amount: number }> {
  const out: Array<{ key: 'ingresos' | 'distribucion'; amount: number }> = [];
  if (result.diferenciaIngresos !== null) out.push({ key: 'ingresos', amount: result.diferenciaIngresos });
  if (result.diferenciaDistribucion !== null) out.push({ key: 'distribucion', amount: result.diferenciaDistribucion });
  return out;
}

/** Período de la cadena, con lo que la cascada necesita (SaldoInfo lo cumple). */
export interface WaterfallChainEntry {
  desglose: WaterfallInput['desglose'];
  ingresosNetos: number;
  egresosNetos: number;
  saldoAFavor: number;
  reserveThisPeriod: number;
  deudaArrastradaEntrada: number;
  montoDistribuir: number;
  incompleto: NonNullable<WaterfallInput['completeness']>['incompleto'];
  incompletoEstado: NonNullable<WaterfallInput['completeness']>['incompletoEstado'];
  heredaIncompleto: boolean;
}

/**
 * La cascada de un período: MISMO armado de insumos que el «PDF mes» y el
 * «Cierre mensual» de /socios (desglose, ingresos, egresos, saldo, reserva,
 * deuda de entrada, monto a distribuir y completitud de la cadena).
 */
export function waterfallForPeriod(
  entry: WaterfallChainEntry,
  reservePct: number | null | undefined,
  otherLabel?: string,
): { result: WaterfallResult; rows: WaterfallTableRow[] } {
  const result = buildCloseWaterfall({
    desglose: entry.desglose,
    ingresosNetos: entry.ingresosNetos,
    egresos: entry.egresosNetos,
    saldo: entry.saldoAFavor,
    reservaMes: entry.reserveThisPeriod,
    reservePct: reservePct ?? 0.1,
    deudaEntrada: entry.deudaArrastradaEntrada,
    montoDistribuir: entry.montoDistribuir,
    otherLabel,
    completeness: {
      incompleto: entry.incompleto,
      incompletoEstado: entry.incompletoEstado,
      heredaIncompleto: entry.heredaIncompleto,
    },
  });
  return { result, rows: waterfallTableRows(result, otherLabel) };
}

/**
 * Consolidado (N meses): sólo la parte de la cascada que SÍ se suma entre
 * meses — componentes → Ingresos netos → Egresos → Resultado. La deuda
 * cubierta, la reserva y el monto a distribuir se calculan mes a mes (un mes
 * negativo no drena la reserva, §2.2) y no se reconstruyen sumando: esas
 * filas y su control de cuadre se descartan. Sigue usando `buildCloseWaterfall`
 * (mismos rótulos, mismo control de ingresos); sólo se le pasan sumas.
 *
 * Un sumando automático es null si falta en CUALQUIER mes: la suma de los
 * que llegaron sería un número más chico y perfectamente creíble.
 */
export function waterfallForRange(
  entries: ReadonlyArray<WaterfallChainEntry>,
  otherLabel?: string,
): { result: WaterfallResult; rows: WaterfallTableRow[] } {
  const sum = (pick: (e: WaterfallChainEntry) => number) => entries.reduce((s, e) => s + pick(e), 0);
  const sumNullable = (pick: (e: WaterfallChainEntry) => number | null) =>
    entries.some((e) => pick(e) === null) ? null : entries.reduce((s, e) => s + (pick(e) as number), 0);
  const incompleto = Array.from(new Set(entries.flatMap((e) => e.incompleto)));
  const estados = entries.map((e) => e.incompletoEstado);
  const full = buildCloseWaterfall({
    desglose: {
      brokerPnl: sumNullable((e) => e.desglose.brokerPnl),
      propFirmNetIncome: sumNullable((e) => e.desglose.propFirmNetIncome),
      investmentProfits: sum((e) => e.desglose.investmentProfits),
      other: sum((e) => e.desglose.other),
    },
    ingresosNetos: sum((e) => e.ingresosNetos),
    egresos: sum((e) => e.egresosNetos),
    saldo: sum((e) => e.saldoAFavor),
    reservaMes: 0,
    deudaEntrada: 0,
    montoDistribuir: 0,
    otherLabel,
    completeness: {
      incompleto,
      incompletoEstado: estados.includes('failed') ? 'failed' : estados.includes('loading') ? 'loading' : null,
      heredaIncompleto: false,
    },
  });
  const cut = full.rows.findIndex((r) => r.label === 'Resultado del mes');
  const result: WaterfallResult = {
    ...full,
    rows: cut >= 0 ? full.rows.slice(0, cut + 1) : full.rows,
    diferenciaDistribucion: null,
    deudaQuePasa: 0,
    // Los avisos de distribución/deuda no aplican a una suma de meses.
    warnings: full.diferenciaIngresos !== null ? full.warnings.slice(0, 1) : [],
    distribucionConocida: false,
  };
  return { result, rows: waterfallTableRows(result, otherLabel) };
}

// ─── Egresos por categoría ───────────────────────────────────────────────────

export interface ExpenseCategoryTableRow {
  key: string;
  /** `null` = sin categoría (la etiqueta la pone la pantalla). */
  category: string | null;
  amount: number;
  paid: number;
  pending: number;
  count: number;
  /** % del total de egresos cargados (0..100). null si el total no es positivo. */
  sharePct: number | null;
}

/**
 * Filas de «Egresos por categoría» desde `buildExpenses` (company-report.ts,
 * la misma agrupación del reporte de /finanzas/reportes). Sólo agrega el %.
 */
export function expenseCategoryRows(
  categories: ReadonlyArray<{ category: string; amount: number; paid: number; pending: number; count: number }>,
  total: number,
  uncategorizedKey: string,
): ExpenseCategoryTableRow[] {
  return categories.map((c) => ({
    key: c.category,
    category: c.category === uncategorizedKey ? null : c.category,
    amount: c.amount,
    paid: c.paid,
    pending: c.pending,
    count: c.count,
    sharePct: total > 0 ? (c.amount / total) * 100 : null,
  }));
}

/**
 * ¿La tabla de egresos (lo CARGADO, devengado) suma distinto del egreso que
 * usa el resultado? Pasa en `company` (base caja: `paid`) y en meses cerrados
 * (congelado al cierre). Devuelve la diferencia para decirla, o null.
 */
export function expenseBasisGap(loadedTotal: number, chainExpenses: number | null): number | null {
  if (chainExpenses === null) return null;
  const gap = Math.round((loadedTotal - chainExpenses) * 100) / 100;
  return Math.abs(gap) > 0.01 ? gap : null;
}
