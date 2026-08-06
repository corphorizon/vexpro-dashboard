// ─────────────────────────────────────────────────────────────────────────────
// Snapshot de cierre → insumos de la cadena de distribución.
//
// La migración 061 congela los INSUMOS del período en periods.closing_snapshot
// al cerrarlo, pero hasta ahora ese snapshot era write-only: la cadena seguía
// recalculando desde las tablas vivas (auditoría 2026-08-06, C2). Editar una
// inversión fechada en un mes cerrado, o el reserve_pct, cambiaba el resultado
// de ese mes, la cadena posterior y lo ya distribuido — el cierre daba una
// falsa sensación de inmutabilidad.
//
// Este módulo hace al snapshot la FUENTE DE VERDAD del mes cerrado:
//   · applySnapshotOverrides reemplaza los insumos vivos por los congelados
//     en todo período cerrado que tenga snapshot.
//   · Además reporta la DERIVA: en qué campos lo vivo ya difiere de lo
//     congelado. Ninguna edición retroactiva vuelve a pasar desapercibida.
//
// El período cerrado SIN snapshot (no debería existir tras el backfill de la
// 061, pero un tenant nuevo podría) sigue con los insumos vivos: peor sería
// tratarlo como mes en cero.
// ─────────────────────────────────────────────────────────────────────────────

import type { PeriodDistInput } from './distribution';

/** Forma del jsonb que escribe la RPC close_period (migración 061). */
export interface ClosingSnapshot {
  broker_pnl?: number | string;
  other_income?: number | string;
  prop_firm_sales?: number | string;
  prop_firm_withdrawals?: number | string;
  investment_profits?: number | string;
  total_expenses?: number | string;
  reserve_pct?: number | string;
  [k: string]: unknown;
}

export interface PeriodLike {
  id: string;
  label?: string | null;
  is_closed: boolean;
  closing_snapshot?: ClosingSnapshot | null;
}

export interface SnapshotDrift {
  periodId: string;
  periodLabel: string;
  field: string;
  frozen: number;
  live: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Convierte el jsonb congelado en un PeriodDistInput. */
export function snapshotToInput(periodId: string, snap: ClosingSnapshot): PeriodDistInput {
  return {
    periodId,
    brokerPnl: num(snap.broker_pnl),
    other: num(snap.other_income),
    propFirmNetIncome: num(snap.prop_firm_sales) - num(snap.prop_firm_withdrawals),
    investmentProfits: num(snap.investment_profits),
    totalExpenses: num(snap.total_expenses),
    reservePct: snap.reserve_pct === undefined || snap.reserve_pct === null
      ? null
      : num(snap.reserve_pct),
  };
}

/** Diferencias por encima de un centavo son deriva real, no ruido de float. */
const TOLERANCE = 0.01;

export interface OverrideResult<T extends PeriodDistInput> {
  inputs: T[];
  drifts: SnapshotDrift[];
}

/**
 * Para cada período CERRADO con snapshot: reemplaza los insumos vivos por los
 * congelados y registra en qué difieren. El orden y los campos extra de cada
 * input (year/month/label del forecast) se preservan.
 */
export function applySnapshotOverrides<T extends PeriodDistInput>(
  periods: PeriodLike[],
  liveInputs: T[],
): OverrideResult<T> {
  const byId = new Map(periods.map((p) => [p.id, p]));
  const drifts: SnapshotDrift[] = [];

  const inputs = liveInputs.map((live) => {
    const period = byId.get(live.periodId);
    if (!period?.is_closed || !period.closing_snapshot) return live;

    const frozen = snapshotToInput(live.periodId, period.closing_snapshot);
    const label = period.label ?? live.periodId;

    const FIELDS: Array<[string, number, number]> = [
      ['brokerPnl', frozen.brokerPnl, live.brokerPnl],
      ['other', frozen.other, live.other],
      ['propFirmNetIncome', frozen.propFirmNetIncome, live.propFirmNetIncome],
      ['investmentProfits', frozen.investmentProfits, live.investmentProfits],
      ['totalExpenses', frozen.totalExpenses, live.totalExpenses],
      ['reservePct', frozen.reservePct ?? 0.1, live.reservePct ?? 0.1],
    ];
    for (const [field, f, l] of FIELDS) {
      if (Math.abs(f - l) > TOLERANCE) {
        drifts.push({ periodId: live.periodId, periodLabel: label, field, frozen: f, live: l });
      }
    }

    // Los campos extra del input (year/month/label/isClosed del forecast)
    // se conservan; solo los insumos económicos vienen del congelador.
    return { ...live, ...frozen };
  });

  return { inputs, drifts };
}
