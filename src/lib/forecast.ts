// ─────────────────────────────────────────────────────────────────────────────
// Forecast de caja — proyección determinista sobre la fórmula REAL.
//
// El producto entero miraba hacia atrás (auditoría 2026-08-06): ninguna
// pantalla respondía "¿qué va a pasar?". Esto proyecta los próximos meses
// con una decisión de diseño central: los meses proyectados se APPENDEAN a
// los insumos reales y se pasan por computeDistributionChain — LA MISMA
// fórmula que usa /socios, con el mismo arrastre de deuda y reserva. Una
// fórmula paralela "de forecast" habría divergido de la real, que es el modo
// de falla número uno de este repo.
//
// Supuestos (visibles en pantalla, no escondidos):
//   · Ingresos proyectados = promedio de los últimos N meses reales
//     (broker + otros + prop firm neto + inversiones), por escenario.
//   · Egresos proyectados = promedio de egresos de los últimos N meses.
//   · El escenario ajusta SOLO los ingresos: los egresos de este negocio son
//     mayormente fijos y castigarlos igual que a los ingresos maquilla el
//     escenario pesimista.
// ─────────────────────────────────────────────────────────────────────────────

import {
  computeDistributionChain,
  type PeriodDistInput,
} from './distribution';
import { round2 } from './utils';

export interface RealMonth extends PeriodDistInput {
  year: number;
  month: number;
  label: string;
  isClosed: boolean;
}

export type Scenario = 'pesimista' | 'base' | 'optimista';

/** Multiplicador de ingresos por escenario. */
export const SCENARIO_INCOME_FACTOR: Record<Scenario, number> = {
  pesimista: 0.8,
  base: 1,
  optimista: 1.2,
};

export interface ForecastMonth {
  label: string;
  year: number;
  month: number;
  /** Ingresos netos proyectados (ya con el factor de escenario). */
  income: number;
  expenses: number;
  saldo: number;
  reserve: number;
  /** Lo que la fórmula real distribuiría a socios ese mes. */
  distribuir: number;
  /** Deuda que el mes arrastra al siguiente (negativa o cero). */
  debtOut: number;
}

export interface ForecastResult {
  months: ForecastMonth[];
  /** Promedios usados, para mostrarlos como supuestos. */
  assumptions: {
    avgIncome: number;
    avgExpenses: number;
    sampleMonths: string[];
    scenario: Scenario;
    incomeFactor: number;
  };
}

const MONTH_LABELS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

export function incomeOf(m: PeriodDistInput): number {
  return m.brokerPnl + m.other + m.propFirmNetIncome + m.investmentProfits;
}

/**
 * Proyecta `monthsAhead` meses a partir del historial real.
 *
 * `history` debe venir EN ORDEN cronológico y COMPLETO desde el inicio de la
 * cadena: la deuda y la reserva arrastradas solo son correctas si la fórmula
 * recorre todos los meses reales antes de entrar en los proyectados.
 *
 * El mes ABIERTO en curso se excluye del promedio (está a medias: entraría
 * como un mes flojo falso) pero SÍ queda en la cadena, para que el arrastre
 * hacia los proyectados salga de donde realmente está parado el negocio.
 */
export function projectCashflow(
  history: RealMonth[],
  opts: {
    monthsAhead?: number;
    sampleSize?: number;
    scenario?: Scenario;
    /** Reserva a usar en los meses proyectados. Default: la del último mes real. */
    reservePct?: number | null;
  } = {},
): ForecastResult {
  const monthsAhead = opts.monthsAhead ?? 6;
  const sampleSize = opts.sampleSize ?? 3;
  const scenario = opts.scenario ?? 'base';
  const factor = SCENARIO_INCOME_FACTOR[scenario];

  if (history.length === 0) {
    return {
      months: [],
      assumptions: { avgIncome: 0, avgExpenses: 0, sampleMonths: [], scenario, incomeFactor: factor },
    };
  }

  // Muestra: los últimos N meses CERRADOS (el abierto está a medias).
  const closed = history.filter((m) => m.isClosed);
  const sample = (closed.length >= sampleSize ? closed : history).slice(-sampleSize);
  const avgIncome = round2(sample.reduce((s, m) => s + incomeOf(m), 0) / sample.length);
  const avgExpenses = round2(sample.reduce((s, m) => s + m.totalExpenses, 0) / sample.length);

  const last = history[history.length - 1];
  const reservePct = opts.reservePct ?? last.reservePct ?? 0.1;

  // Meses proyectados: mismos campos que un mes real, ingresos en brokerPnl
  // (a la fórmula solo le importa la suma de ingresos).
  const projected: Array<PeriodDistInput & { year: number; month: number; label: string }> = [];
  let cursor = { year: last.year, month: last.month };
  for (let i = 0; i < monthsAhead; i++) {
    cursor = nextMonth(cursor.year, cursor.month);
    projected.push({
      periodId: `forecast-${cursor.year}-${cursor.month}`,
      year: cursor.year,
      month: cursor.month,
      label: `${MONTH_LABELS[cursor.month - 1]} ${String(cursor.year).slice(2)}`,
      brokerPnl: round2(avgIncome * factor),
      other: 0,
      propFirmNetIncome: 0,
      investmentProfits: 0,
      totalExpenses: avgExpenses,
      reservePct,
    });
  }

  // LA fórmula real, corrida sobre historia completa + proyección.
  const chain = computeDistributionChain([...history, ...projected]);

  const months: ForecastMonth[] = projected.map((p) => {
    const r = chain.get(p.periodId)!;
    return {
      label: p.label,
      year: p.year,
      month: p.month,
      income: p.brokerPnl,
      expenses: p.totalExpenses,
      saldo: r.saldoAFavor,
      reserve: r.reserveThisPeriod,
      distribuir: r.montoDistribuir,
      debtOut: r.deudaArrastradaSalida,
    };
  });

  return {
    months,
    assumptions: {
      avgIncome,
      avgExpenses,
      sampleMonths: sample.map((m) => m.label),
      scenario,
      incomeFactor: factor,
    },
  };
}
