// ─────────────────────────────────────────────────────────────────────────────
// Insumos de la cadena de distribución — CONSTRUCTOR ÚNICO.
//
// Antes esta construcción (índices por período + armado del PeriodDistInput)
// estaba copiada TRES veces en data-context.tsx: computeSaldoChain (lo que ven
// /balances y /finanzas), getDistributionInputs (el forecast) y
// getSnapshotDrifts (el aviso de deriva). Eran ~35 líneas idénticas: cualquier
// corrección en una —sumar en vez de pisar los retiros de prop firm, cómo se
// fecha una inversión— tenía que replicarse a mano en las otras dos, y ese es
// el modo de falla número uno de este repo (ver BUG-01 en distribution.ts).
//
// Acá se arma UNA vez. La fórmula sigue viviendo en distribution.ts; esto solo
// decide QUÉ números entran.
//
// Import-safe desde cliente y servidor: no toca React ni Supabase.
// ─────────────────────────────────────────────────────────────────────────────

import type { PeriodDistInput } from './distribution';
import { features } from './business-model';

/** Lo mínimo que el constructor necesita de un período. */
export interface PeriodForInputs {
  id: string;
  year: number;
  month: number;
  label?: string | null;
  is_closed?: boolean;
  reserve_pct: number | null;
}

export interface OperatingIncomeLike {
  period_id: string;
  broker_pnl: number;
  other: number;
}
export interface PropFirmSaleLike {
  period_id: string;
  amount: number;
}
export interface WithdrawalLike {
  period_id: string;
  category: string;
  amount: number;
}
export interface ExpenseLike {
  period_id: string;
  amount: number;
}
export interface InvestmentLike {
  date?: string | null;
  profit?: number | string | null;
}

export interface DistributionSources {
  operatingIncome: OperatingIncomeLike[];
  propFirmSales: PropFirmSaleLike[];
  /** Solo se leen los de categoría `prop_firm`: los demás no son ingreso ni egreso de la cadena. */
  withdrawals: WithdrawalLike[];
  expenses: ExpenseLike[];
  investments: InvestmentLike[];
  /**
   * Modelo de negocio de la empresa ('broker' | 'company'). Ver la nota de
   * neutralización abajo. Ausente ⇒ default histórico ('broker').
   */
  businessModel?: unknown;
}

/**
 * Insumo enriquecido con la metadata de período que necesita el forecast.
 * Es un superset de PeriodDistInput: la fórmula ignora los campos extra y
 * applySnapshotOverrides los preserva, así que un solo tipo sirve a los tres
 * consumidores.
 */
export interface PeriodDistInputWithMeta extends PeriodDistInput {
  year: number;
  month: number;
  label: string;
  isClosed: boolean;
}

/**
 * Arma los insumos VIVOS de la cadena, EN ORDEN, uno por período recibido.
 *
 * No aplica el congelador de cierre: eso es responsabilidad de
 * `applySnapshotOverrides` en el llamador — getSnapshotDrifts necesita
 * justamente lo vivo para poder compararlo contra lo congelado.
 */
export function buildDistributionInputs(
  periods: PeriodForInputs[],
  sources: DistributionSources,
): PeriodDistInputWithMeta[] {
  const { operatingIncome, propFirmSales, withdrawals, expenses, investments } = sources;

  // Índices O(1) de las primitivas por período.
  const oiIndex = new Map(operatingIncome.map(o => [o.period_id, o]));
  // Una fila por período (la carga sobrescribe, no appendea): índice directo.
  const pfsIndex = new Map(propFirmSales.map(p => [p.period_id, Number(p.amount) || 0]));
  const pfwIndex = new Map<string, number>();
  for (const w of withdrawals) {
    // Suma, no set: con filas duplicadas de categoría (posible antes de la
    // migración 065) "la última gana" hacía que esta cadena difiera de
    // getPeriodSummary y del consolidado. Sumar es la única lectura que
    // coincide con las otras dos pase lo que pase.
    if (w.category === 'prop_firm') {
      pfwIndex.set(w.period_id, (pfwIndex.get(w.period_id) || 0) + (Number(w.amount) || 0));
    }
  }
  const expIndex = new Map<string, number>();
  for (const e of expenses) {
    expIndex.set(e.period_id, (expIndex.get(e.period_id) || 0) + (Number(e.amount) || 0));
  }
  // investmentProfits por período — las inversiones son date-keyed (no
  // period_id): se asignan al período cuyo año/mes coincide con inv.date.
  // Misma lógica que getPeriodSummary.investmentProfits.
  const invIndex = new Map<string, number>();
  for (const inv of investments) {
    if (!inv.date) continue;
    const [y, m] = String(inv.date).split('-').map(Number);
    const per = periods.find(p => p.year === y && p.month === m);
    if (per) invIndex.set(per.id, (invIndex.get(per.id) || 0) + (Number(inv.profit) || 0));
  }

  // ── Neutralización por modelo de negocio ────────────────────────────────
  // Una empresa que factura servicios ('company') no tiene P&L de broker ni
  // circuito de prop firm: sus ingresos son las líneas de facturación
  // COBRADAS, que ya viajan en operating_income.other. Pero si la entidad
  // nació como 'broker' y después se cambió el modelo, las filas viejas de
  // operating_income.broker_pnl, prop_firm_sales y retiros de prop firm
  // siguen en la base — y seguían entrando a la cadena aunque NINGUNA
  // pantalla las muestre (blockedConsolidatedColumns las esconde). El
  // resultado era plata fantasma: un "Monto a Distribuir" que no se puede
  // explicar con nada visible. Con el modelo sin brokerPnl, esos dos términos
  // entran en cero.
  //
  // OJO: esto es sobre los insumos VIVOS. Un período CERRADO conserva lo
  // congelado en closing_snapshot (la inmutabilidad del cierre manda), y la
  // diferencia aparece como deriva en getSnapshotDrifts — que es exactamente
  // el aviso que uno quiere ver al cambiar de modelo con historia cerrada.
  const brokerPnlApplies = features(sources.businessModel).brokerPnl;

  return periods.map(period => {
    const oi = oiIndex.get(period.id);
    const pfs = pfsIndex.get(period.id) || 0;
    const pfW = pfwIndex.get(period.id) || 0;
    return {
      periodId: period.id,
      year: period.year,
      month: period.month,
      label: period.label ?? `${period.month}/${period.year}`,
      isClosed: !!period.is_closed,
      brokerPnl: brokerPnlApplies ? (oi?.broker_pnl || 0) : 0,
      other: oi?.other || 0,
      propFirmNetIncome: brokerPnlApplies ? pfs - pfW : 0,
      investmentProfits: invIndex.get(period.id) || 0,
      totalExpenses: expIndex.get(period.id) || 0,
      reservePct: period.reserve_pct,
    };
  });
}
