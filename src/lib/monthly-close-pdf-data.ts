// ─────────────────────────────────────────────────────────────────────────────
// Informe de Cierre Mensual — los DATOS del PDF, en funciones puras.
//
// POR QUÉ EXISTE (Kevin, 2026-10-05: «el informe de cierre muestra datos en 0
// o no los muestra»). Vex Pro, septiembre 2026:
//
//   1. «Broker P&L» y «Prop Firm» salían en $0,00 con unos Ingresos Netos de
//      $263.469,99. La página leía `sum.operatingIncome.broker_pnl` y
//      `sum.propFirmNetIncome`: las tablas MANUALES, vacías desde agosto 2026
//      porque esos dos renglones pasaron a automático (BROKER_PNL_AUTO_DESDE en
//      broker-pnl.ts, `pfAutoByPeriod` en data-context). La cadena de
//      distribución SÍ los tenía, en `desglose`. El papel decía que los
//      ingresos salían de la nada — un número plausible y otro equivocado al
//      lado, el modo de falla del §1.2.
//      Medido: brokerPnl 226.605,20 + propFirmNetIncome 13.248,27 +
//      investmentProfits 23.616,52 + other 0 = 263.469,99 = ingresosNetos.
//      Ahora la cascada sale SOLO de `desglose` (el mismo objeto que calcula
//      `ingresosNetos`) y, si alguna vez los sumandos no dan el total, imprime
//      «Diferencia no explicada» en vez de esconderla.
//
//   2. Pay-Pros no aparecía en el flujo de clientes: la página tenía su propia
//      lista de slugs (coinsbuy-deposits / fairpay / unipayment y
//      coinsbuy-withdrawals). Faltaban $93.968,69 de depósitos y $10.302,17 de
//      retiros (payouts) de sep-2026. Ahora se recorren los REGISTROS
//      (`API_DEPOSIT_CHANNELS`, `API_WITHDRAWAL_CHANNELS`).
//
//   3. «Egresos del mes $-208,084.45»: el signo iba después del símbolo.
//
// Todo lo que decide un número del informe vive acá, sin jsPDF, para poder
// fijarlo con tests (monthly-close-pdf-data.test.ts). pdf-export.ts solo dibuja.
//
// DESCARTADO
//   · Seguir leyendo las tablas manuales «cuando tengan dato»: es la segunda
//     fuente que ya divergió. El desglose de la cadena es la única.
//   · Recalcular los sumandos acá a partir de getPeriodSummary: sería la
//     segunda copia de la fórmula de distribution.ts.
//   · Imprimir «$0,00» en los canales sin movimiento: un renglón en cero es
//     ruido; un canal SIN DATO (dataset ausente) se imprime «sin datos» y se
//     avisa, porque no es lo mismo que cero (§1.3).
// ─────────────────────────────────────────────────────────────────────────────

import { formatNumber, round2 } from './utils';
import { MONTH_LABELS } from './types';
import type { ProviderDataset } from './api-integrations/types';
import { computeProviderTotals } from './api-integrations/totals';
import {
  API_DEPOSIT_CHANNELS,
  type DepositChannel,
} from './deposit-channels';
import {
  API_WITHDRAWAL_CHANNELS,
  apiWithdrawalsFromDatasets,
  type WithdrawalChannel,
} from './withdrawal-channels';
import type { CrmMonthlyMetricDef } from './crm-monthly';

/** Tolerancia de los controles de cuadre: un centavo. */
export const CLOSE_TOLERANCE = 0.01;

// ─── Dinero ──────────────────────────────────────────────────────────────────

/**
 * Importe para el PDF: «$1,234.56» y, en negativo, «-$1,234.56».
 *
 * Antes era `$${formatNumber(n)}` y un negativo salía «$-208,084.45» (el signo
 * pegado al número, después del símbolo). Un importe que redondea a cero se
 * imprime «$0.00», nunca «-$0.00».
 *
 * Los separadores siguen siendo los de `formatNumber` (en-US), los mismos de
 * toda la app y de los demás PDFs: cambiarlos solo acá haría que el informe y
 * la pantalla escriban distinto el mismo número.
 */
export function pdfMoney(n: number): string {
  const v = round2(n);
  if (Math.abs(v) < 0.005) return `$${formatNumber(0)}`;
  return v < 0 ? `-$${formatNumber(-v)}` : `$${formatNumber(v)}`;
}

// ─── Período ─────────────────────────────────────────────────────────────────

/**
 * «Septiembre 2026», derivado de year/month. El `label` del período suele ser
 * corto («Sep 26») y en un documento para socios se lee como un código.
 * Sin year/month válidos cae al label tal cual.
 */
export function longPeriodLabel(p: { year?: number | null; month?: number | null; label?: string | null }): string {
  const name = p.month ? MONTH_LABELS[p.month] : undefined;
  if (name && p.year) return `${name} ${p.year}`;
  return p.label ?? '';
}

/** «Generado el 5 de octubre de 2026». */
export function generatedOnLabel(d: Date = new Date()): string {
  return `Generado el ${d.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

// ─── Cascada: cómo se llega al resultado ─────────────────────────────────────

export interface CloseDesglose {
  brokerPnl: number;
  propFirmNetIncome: number;
  investmentProfits: number;
  other: number;
}

export type WaterfallKind = 'income' | 'expense' | 'total';

export interface WaterfallRow {
  label: string;
  /** Importe con su signo económico (un egreso va negativo). */
  amount: number;
  kind: WaterfallKind;
}

export interface WaterfallInput {
  desglose: CloseDesglose;
  ingresosNetos: number;
  egresos: number;
  saldo: number;
  reservaMes: number;
  /** Fracción 0..1 del período (para el rótulo). */
  reservePct?: number | null;
  deudaEntrada: number;
  montoDistribuir: number;
  /** Rótulo de `other`: en una empresa de servicios es la facturación cobrada. */
  otherLabel?: string;
}

export interface WaterfallResult {
  rows: WaterfallRow[];
  /** Σ componentes − ingresosNetos, o null si cuadra (|dif| ≤ 1 centavo). */
  diferenciaIngresos: number | null;
  /** Resultado − deuda cubierta − reserva − a distribuir, o null si cuadra. */
  diferenciaDistribucion: number | null;
  /** Mes negativo: la pérdida pasa como deuda al mes siguiente. */
  deudaQuePasa: number;
  /** Avisos para imprimir tal cual debajo de la cascada. */
  warnings: string[];
}

const pctLabel = (p: number | null | undefined) =>
  p == null ? '' : ` (${(p * 100).toFixed(p * 100 === Math.round(p * 100) ? 0 : 1)}%)`;

/**
 * Las filas de «Cómo se llega al resultado», con su signo.
 *
 * Orden: componentes → = Ingresos netos → − Egresos → = Resultado →
 * − Deuda arrastrada cubierta → − Reserva → = A distribuir. La deuda va ANTES
 * que la reserva porque así la aplica `computeDistributionChain` (primero se
 * cubre la deuda, la reserva sale del remanente); invertirlas en el papel haría
 * que la reserva impresa no sea el % del renglón de arriba.
 *
 * Renglones de detalle en cero se omiten; los totales se imprimen siempre.
 */
export function buildCloseWaterfall(input: WaterfallInput): WaterfallResult {
  const { desglose } = input;
  const rows: WaterfallRow[] = [];
  const warnings: string[] = [];
  const push = (label: string, amount: number, kind: WaterfallKind) => {
    if (kind !== 'total' && Math.abs(amount) < 0.005) return;
    rows.push({ label, amount: round2(amount), kind });
  };

  push('Broker P&L', desglose.brokerPnl, 'income');
  push('Prop Firm neto', desglose.propFirmNetIncome, 'income');
  push('Ganancias de inversiones', desglose.investmentProfits, 'income');
  push(input.otherLabel ?? 'Otros ingresos', desglose.other, 'income');
  push('Ingresos netos', input.ingresosNetos, 'total');

  const suma = round2(
    desglose.brokerPnl + desglose.propFirmNetIncome + desglose.investmentProfits + desglose.other,
  );
  const difIng = round2(suma - input.ingresosNetos);
  const diferenciaIngresos = Math.abs(difIng) > CLOSE_TOLERANCE ? difIng : null;
  if (diferenciaIngresos !== null) {
    warnings.push(`Diferencia no explicada: ${pdfMoney(diferenciaIngresos)}`);
  }

  push('Egresos del mes', -input.egresos, 'expense');
  push('Resultado del mes', input.saldo, 'total');

  let deudaQuePasa = 0;
  let diferenciaDistribucion: number | null = null;
  if (input.saldo > 0) {
    const deudaCubierta = Math.min(input.deudaEntrada, input.saldo);
    push('Deuda arrastrada cubierta', -deudaCubierta, 'expense');
    push(`Reserva del mes${pctLabel(input.reservePct)}`, -input.reservaMes, 'expense');
    const dif = round2(input.saldo - deudaCubierta - input.reservaMes - input.montoDistribuir);
    diferenciaDistribucion = Math.abs(dif) > CLOSE_TOLERANCE ? dif : null;
    if (input.deudaEntrada > input.saldo) {
      deudaQuePasa = round2(input.deudaEntrada - input.saldo);
    }
  } else {
    // Mes negativo: no se distribuye y la reserva no se drena; la pérdida más
    // la deuda previa pasan al mes siguiente (modelo de distribution.ts).
    deudaQuePasa = round2(input.deudaEntrada + Math.abs(input.saldo));
    if (Math.abs(input.montoDistribuir) > CLOSE_TOLERANCE) {
      diferenciaDistribucion = round2(-input.montoDistribuir);
    }
  }
  push('A distribuir', input.montoDistribuir, 'total');

  if (diferenciaDistribucion !== null) {
    warnings.push(`Diferencia no explicada en la distribución: ${pdfMoney(diferenciaDistribucion)}`);
  }
  if (deudaQuePasa > 0) {
    warnings.push(`Deuda que pasa al mes siguiente: ${pdfMoney(deudaQuePasa)}`);
  }

  return { rows, diferenciaIngresos, diferenciaDistribucion, deudaQuePasa, warnings };
}

/** «Broker + Prop Firm + Inversiones»: qué componentes tienen dato. */
export function incomeSourcesLabel(d: CloseDesglose, otherShort = 'Otros'): string {
  const parts: string[] = [];
  if (Math.abs(d.brokerPnl) >= 0.005) parts.push('Broker');
  if (Math.abs(d.propFirmNetIncome) >= 0.005) parts.push('Prop Firm');
  if (Math.abs(d.investmentProfits) >= 0.005) parts.push('Inversiones');
  if (Math.abs(d.other) >= 0.005) parts.push(otherShort);
  return parts.join(' + ');
}

// ─── Egresos ─────────────────────────────────────────────────────────────────

export type ExpenseStatus = 'pagado' | 'pendiente' | 'parcial';

export interface CloseExpenseInput {
  concept: string;
  amount: number;
  paid: number;
  pending: number;
}

export interface CloseExpenseRow {
  concept: string;
  amount: number;
  status: ExpenseStatus;
  /** Fracción 0..1 del total de egresos. */
  share: number;
}

export interface CloseExpensesResult {
  top: CloseExpenseRow[];
  /** Lo que quedó fuera del top. `null` si no quedó nada afuera. */
  others: { count: number; amount: number; share: number } | null;
  total: number;
  count: number;
  paidCount: number;
}

export function expenseStatus(e: Pick<CloseExpenseInput, 'amount' | 'paid' | 'pending'>): ExpenseStatus {
  const paid = Number(e.paid) || 0;
  const pending = Number(e.pending) || 0;
  if (pending <= 0.005 && paid > 0.005) return 'pagado';
  if (paid <= 0.005) return 'pendiente';
  return 'parcial';
}

/**
 * Top N de egresos por monto + una fila «Otros N egresos» con el resto, de
 * modo que la columna sume el total. Antes el top 10 se imprimía con el total
 * del mes debajo y la columna no sumaba: lo que faltaba no estaba en ningún
 * renglón.
 */
export function buildCloseExpenses(expenses: CloseExpenseInput[], topN = 10): CloseExpensesResult {
  const total = round2(expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0));
  const share = (a: number) => (total > 0 ? a / total : 0);
  const sorted = [...expenses].sort((a, b) => b.amount - a.amount);
  const top = sorted.slice(0, topN).map((e) => ({
    concept: e.concept,
    amount: round2(e.amount),
    status: expenseStatus(e),
    share: share(e.amount),
  }));
  const rest = sorted.slice(topN);
  const restAmount = round2(rest.reduce((s, e) => s + (Number(e.amount) || 0), 0));
  return {
    top,
    others: rest.length > 0 ? { count: rest.length, amount: restAmount, share: share(restAmount) } : null,
    total,
    count: expenses.length,
    paidCount: expenses.filter((e) => expenseStatus(e) === 'pagado').length,
  };
}

// ─── Flujo de clientes ───────────────────────────────────────────────────────

export interface FlowRow {
  label: string;
  /** `null` = sin datos (el dataset del canal no llegó). Nunca se suma. */
  amount: number | null;
}

export interface ClientFlow {
  deposits: FlowRow[];
  withdrawals: FlowRow[];
  depositsTotal: number;
  withdrawalsTotal: number;
  netFlow: number;
  warnings: string[];
}

export interface ClientFlowInput {
  /** ¿El período usa la regla derivada (abr-2026+)? Si no, mandan los manuales guardados. */
  derived: boolean;
  /** `datasets` de /api/integrations/persisted-movements (vacío si no se pudo leer). */
  datasets: readonly ProviderDataset[];
  /** `hiddenChannels` del mismo endpoint: canales apagados para la empresa. */
  hiddenChannels: readonly string[];
  /** `truncatedSlugs` del mismo endpoint. */
  truncatedSlugs?: readonly string[];
  /** La lectura falló entera (red, 500). */
  fetchFailed?: boolean;
  /** Depósitos manuales del período (`summary.deposits`). */
  manualDeposits: ReadonlyArray<{ channel: string; amount: number }>;
  /** Retiros manuales del período (`summary.withdrawals`). */
  manualWithdrawals: ReadonlyArray<{ category: string; amount: number }>;
  depositLabel: (channel: DepositChannel) => string;
  withdrawalLabel: (channel: WithdrawalChannel) => string;
  /** Rótulo de una categoría manual de retiro (WITHDRAWAL_LABELS). */
  withdrawalCategoryLabel: (category: string) => string;
}

const nz = (n: number | null) => n === null || Math.abs(n) >= 0.005;

/**
 * Depósitos y retiros de clientes del mes, por canal, desde los REGISTROS.
 *
 * Período derivado (abr-2026+), con la MISMA regla que /movimientos
 * (`computeDerivedNetDeposit` en broker-logic.ts):
 *   · Depósitos = Σ canales de API (API + manual del canal) + manual 'other'.
 *   · Retiros   = Σ canales de API + manual «Broker» (retiros Coinsbuy que la
 *     API no alcanzó a reportar). Comisiones IB, Prop Firm y Otros NO suman:
 *     son informativas en /movimientos (Kevin, 2026-06-06). El PDF viejo las
 *     sumaba y su «Total retiros» no coincidía con la pantalla.
 * Período histórico: mandan los manuales guardados, como en /movimientos.
 *
 * Canal apagado para la empresa (hiddenChannels) ⇒ no se imprime. Canal
 * encendido sin dataset ⇒ «sin datos» + aviso; no suma.
 */
export function buildClientFlow(input: ClientFlowInput): ClientFlow {
  const hidden = new Set(input.hiddenChannels);
  const warnings: string[] = [];
  const manualDep = (ch: string) =>
    input.manualDeposits.filter((d) => d.channel === ch).reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const manualWd = (cat: string) =>
    input.manualWithdrawals.filter((w) => w.category === cat).reduce((s, w) => s + (Number(w.amount) || 0), 0);

  const deposits: FlowRow[] = [];
  const withdrawals: FlowRow[] = [];

  if (input.derived) {
    const canRead = !input.fetchFailed;
    for (const { channel, slug } of API_DEPOSIT_CHANNELS) {
      if (hidden.has(channel)) continue;
      const ds = input.datasets.find((d) => d.slug === slug);
      const manual = manualDep(channel);
      if (!ds || !canRead) {
        // Sin dataset: lo manual se sabe, lo de la API no.
        deposits.push({ label: input.depositLabel(channel), amount: manual > 0 ? manual : null });
        if (!(manual > 0)) warnings.push(`${input.depositLabel(channel)}: sin datos de la API`);
        continue;
      }
      deposits.push({ label: input.depositLabel(channel), amount: round2(computeProviderTotals(ds).total + manual) });
    }
    const otherManual = manualDep('other');
    deposits.push({ label: input.depositLabel('other'), amount: round2(otherManual) });

    const byChannel = canRead ? apiWithdrawalsFromDatasets(input.datasets) : {};
    for (const { key } of API_WITHDRAWAL_CHANNELS) {
      if (hidden.has(key)) continue;
      const v = byChannel[key];
      if (v === null || v === undefined || !Number.isFinite(v)) {
        withdrawals.push({ label: input.withdrawalLabel(key), amount: null });
        warnings.push(`${input.withdrawalLabel(key)} (retiros): sin datos de la API`);
        continue;
      }
      withdrawals.push({ label: input.withdrawalLabel(key), amount: round2(v) });
    }
    const brokerManual = manualWd('broker');
    withdrawals.push({ label: `${input.withdrawalCategoryLabel('broker')} (manual)`, amount: round2(brokerManual) });

    for (const slug of input.truncatedSlugs ?? []) {
      warnings.push(`Datos de ${slug} recortados por el límite de filas: el total puede estar corto`);
    }
    if (input.fetchFailed) {
      warnings.push('No se pudieron leer los movimientos de la API: el flujo muestra solo lo cargado a mano');
    }
  } else {
    const channels = Array.from(new Set(input.manualDeposits.map((d) => d.channel)));
    for (const ch of channels) {
      if (hidden.has(ch)) continue;
      deposits.push({ label: input.depositLabel(ch as DepositChannel), amount: round2(manualDep(ch)) });
    }
    const cats = Array.from(new Set(input.manualWithdrawals.map((w) => w.category)));
    for (const cat of cats) {
      withdrawals.push({ label: input.withdrawalCategoryLabel(cat), amount: round2(manualWd(cat)) });
    }
  }

  const sum = (rows: FlowRow[]) => round2(rows.reduce((s, r) => s + (r.amount ?? 0), 0));
  const depositsTotal = sum(deposits);
  const withdrawalsTotal = sum(withdrawals);
  return {
    // Renglones en cero fuera (los "sin datos" se quedan: son un aviso).
    deposits: deposits.filter((r) => nz(r.amount)),
    withdrawals: withdrawals.filter((r) => nz(r.amount)),
    depositsTotal,
    withdrawalsTotal,
    netFlow: round2(depositsTotal - withdrawalsTotal),
    warnings,
  };
}

// ─── Datos del CRM (informativo) ─────────────────────────────────────────────

export interface CrmInfoRow {
  label: string;
  amount: number;
}

/**
 * Métricas del espejo del CRM del mes que NO suman al resultado (ver
 * `CRM_MONTHLY_OUTSIDE_RESULT_METRICS`). `auto: null` o sin fila = sin dato ⇒
 * se omite; si no queda ninguna, el informe no imprime la sección.
 */
export function buildCrmInfoRows(
  rows: ReadonlyArray<{ year: number; month: number; metric: string; auto: number | null }>,
  metrics: readonly CrmMonthlyMetricDef[],
  year: number,
  month: number,
): CrmInfoRow[] {
  const out: CrmInfoRow[] = [];
  for (const m of metrics) {
    const hits = rows.filter((r) => r.metric === m.key && r.year === year && r.month === month && r.auto != null);
    if (hits.length === 0) continue;
    const amount = round2(hits.reduce((s, r) => s + Number(r.auto), 0));
    if (Math.abs(amount) < 0.005) continue;
    out.push({ label: m.labelEs, amount });
  }
  return out;
}
