// ─────────────────────────────────────────────────────────────────────────────
// Decisiones puras de /inversiones (rediseño «Libro mayor», 2026-10-12).
//
// · `byResponsible`: el resumen por responsable que antes vivía inline en la
//   página. Las filas SIN responsable se ignoraban en silencio — ahora se
//   cuentan (`unassigned`) y la tabla lo dice en el pie: una exclusión
//   silenciosa es indistinguible de un cruce roto (§1.2).
// · `returnPct`: el rendimiento del filtro = ganancia del filtro / capital
//   colocado al cierre del filtro. `null` (→ «—») cuando no hay capital
//   positivo contra el cual medir: un 0 % diría «no rindió», que es otra cosa.
//
// DESCARTADO para el rendimiento:
//   · Ganancia / aportes del MISMO mes: un mes sin aportes daría infinito y uno
//     con un aporte grande, un rendimiento ridículo. El capital que rinde es el
//     que está colocado, no el que entró ese mes.
//   · Anualizarlo: no sabemos el plazo de cada aporte; sería un número inventado.
// ─────────────────────────────────────────────────────────────────────────────

import { computeInvestmentTotals } from '@/lib/investment-types';
import { monthKeyOf, ALL_MONTHS } from '@/lib/ledger-month-filter';

interface Row {
  date: string;
  responsible: string | null;
  deposit: number;
  withdrawal: number;
  profit: number;
  concept?: string | null;
  movement_type?: string | null;
}

export interface ResponsibleTotals {
  responsible: string;
  deposits: number;
  withdrawals: number;
  profit: number;
  /** aporte − retiro + ganancia: la MISMA fórmula del saldo global. */
  balance: number;
  count: number;
}

export function byResponsible(rows: Row[]): { rows: ResponsibleTotals[]; unassigned: number } {
  const map = new Map<string, ResponsibleTotals>();
  let unassigned = 0;
  for (const inv of rows) {
    const responsible = (inv.responsible ?? '').trim();
    if (!responsible) {
      unassigned += 1;
      continue;
    }
    const e = map.get(responsible) ?? { responsible, deposits: 0, withdrawals: 0, profit: 0, balance: 0, count: 0 };
    e.deposits += inv.deposit;
    e.withdrawals += inv.withdrawal;
    e.profit += inv.profit;
    e.balance += inv.deposit - inv.withdrawal + inv.profit;
    e.count += 1;
    map.set(responsible, e);
  }
  return { rows: [...map.values()].sort((a, b) => b.balance - a.balance), unassigned };
}

/** Capital colocado (aportes − devoluciones) con todo lo anterior al cierre del filtro, inclusive. */
export function capitalPlacedAtEnd(all: Row[], filter: string): number {
  const upTo = filter === ALL_MONTHS
    ? all
    : all.filter((r) => {
        const k = monthKeyOf(r.date);
        return k !== null && k <= filter;
      });
  return computeInvestmentTotals(upTo).capitalPlaced;
}

/** Rendimiento en % (4.1 = 4,1 %). null si no hay capital positivo colocado. */
export function returnPct(profit: number, capital: number): number | null {
  if (!Number.isFinite(profit) || !Number.isFinite(capital) || capital <= 0) return null;
  return Math.round((profit / capital) * 1000) / 10;
}
