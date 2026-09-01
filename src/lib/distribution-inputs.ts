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
import { features, normalizeBusinessModel } from './business-model';

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
  /** Devengado: lo que se facturó, esté pagado o no. */
  amount: number;
  /**
   * Pagado: lo que efectivamente salió de la caja. Ver la nota de base CAJA
   * abajo — solo lo lee el modelo 'company'. Ausente (no `0`, que es un dato
   * real) ⇒ se cae al devengado: preferimos restar de más antes que inflar la
   * base distribuible porque el llamador no trajo la columna.
   */
  paid?: number | string | null;
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
  /**
   * Serie MENSUAL de ganancia del bróker calculada desde `crm_daily_pnl`
   * (decisión de Kevin, 2026-08-31: "dejalo automatizado, eliminemos lo
   * manual"). Ver `src/lib/broker-pnl.ts` para las tres reglas.
   *
   * Sólo se usa en períodos ABIERTOS: los cerrados conservan el número
   * congelado (`operating_income.broker_pnl`, que es el mismo que quedó en
   * `closing_snapshot`). Si se usara también en los cerrados,
   * `getSnapshotDrifts` reportaría deriva en los nueve períodos cerrados de
   * Vex Pro, donde lo tecleado nunca coincidió con la serie del CRM — un aviso
   * de nada, todos los días.
   *
   * Ausente (llamador que no la trajo, tests viejos) ⇒ se sigue leyendo
   * `operating_income.broker_pnl`, exactamente como antes.
   */
  brokerPnlByPeriod?: ReadonlyMap<string, number>;
  /**
   * Prop firm AUTOMÁTICO del CRM por período ABIERTO (ventas y retiros de
   * crm_monthly_totals: propfirm_sales / propfirm_withdrawals). Mismo patrón
   * que brokerPnlByPeriod: los cerrados nunca entran acá; y el MANUAL cargado
   * (>0) gana como override — el mapa solo pisa lo que está en cero.
   * Kevin (2026-09-01): «en agosto no está sumando el resultado entre ventas
   * y retiros de propfirm» — agosto tenía $11.981,70/$2.819,04 automáticos y
   * la cadena leía la tabla manual vacía.
   */
  pfAutoByPeriod?: ReadonlyMap<string, { sales: number; withdrawals: number }>;
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
  // ── Base CAJA para los egresos, SOLO en modelo 'company' ────────────────
  // La base era mixta y por eso mentía: del lado del ingreso entra lo COBRADO
  // (income_lines.received, materializado en operating_income.other) pero del
  // lado del egreso entraba lo DEVENGADO (expenses.amount, que incluye
  // facturas todavía NO pagadas). Un mes daba negativo por plata que aún no
  // salió de la caja, y esa deuda ficticia se arrastraba a los meses
  // siguientes. En 'company' los dos lados pasan a ser caja: entra lo cobrado,
  // sale lo pagado (expenses.paid).
  //
  // POR QUÉ SOLO 'company': se verificó en producción que AP Markets (broker)
  // tiene ~$24.900 de egresos con paid = 0 — ese equipo no usa el campo
  // "pagado", carga todo en `amount`. Aplicar caja al broker le llevaría los
  // egresos casi a cero e INFLARÍA su base distribuible, que es exactamente el
  // error de dinero que este archivo existe para evitar. En 'broker' no se
  // cambia nada: sigue mandando el devengado.
  const cashBasisExpenses = normalizeBusinessModel(sources.businessModel) === 'company';
  const expIndex = new Map<string, number>();
  for (const e of expenses) {
    const accrued = Number(e.amount) || 0;
    // `paid` ausente/null ⇒ devengado (ver ExpenseLike). `paid: 0` es un dato
    // real: en caja, una factura sin pagar no resta.
    const value = cashBasisExpenses && e.paid != null ? (Number(e.paid) || 0) : accrued;
    expIndex.set(e.period_id, (expIndex.get(e.period_id) || 0) + value);
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
  //
  // MISMO MOTIVO para las inversiones: con features().investments en false el
  // módulo /inversiones está bloqueado (blockedModules) y la columna
  // investmentProfits ni aparece en el consolidado
  // (blockedConsolidatedColumns) — pero la ganancia de inversiones seguía
  // entrando a la base distribuible. Era la misma plata fantasma que arriba,
  // dejada a medias: un "Monto a Distribuir" que ninguna pantalla explica.
  const brokerPnlApplies = features(sources.businessModel).brokerPnl;
  const investmentsApply = features(sources.businessModel).investments;

  return periods.map(period => {
    const oi = oiIndex.get(period.id);
    const pfsManual = pfsIndex.get(period.id) || 0;
    const pfWManual = pfwIndex.get(period.id) || 0;
    // Automático solo en abiertos y solo donde no hay manual (>0 = override).
    const pfAuto = period.is_closed ? undefined : sources.pfAutoByPeriod?.get(period.id);
    const pfs = pfsManual > 0 ? pfsManual : (pfAuto?.sales ?? pfsManual);
    const pfW = pfWManual > 0 ? pfWManual : (pfAuto?.withdrawals ?? pfWManual);
    // Broker P&L: automático en los períodos ABIERTOS, congelado en los
    // cerrados. Ver `brokerPnlByPeriod` arriba y `src/lib/broker-pnl.ts`.
    const auto = period.is_closed ? undefined : sources.brokerPnlByPeriod?.get(period.id);
    const brokerPnlValue = auto === undefined ? (oi?.broker_pnl || 0) : auto;
    return {
      periodId: period.id,
      year: period.year,
      month: period.month,
      label: period.label ?? `${period.month}/${period.year}`,
      isClosed: !!period.is_closed,
      brokerPnl: brokerPnlApplies ? brokerPnlValue : 0,
      other: oi?.other || 0,
      propFirmNetIncome: brokerPnlApplies ? pfs - pfW : 0,
      investmentProfits: investmentsApply ? (invIndex.get(period.id) || 0) : 0,
      totalExpenses: expIndex.get(period.id) || 0,
      reservePct: period.reserve_pct,
    };
  });
}
