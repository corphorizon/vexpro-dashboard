// ─────────────────────────────────────────────────────────────────────────────
// Decisiones de presentación de /hedge-fund (rediseño «Libro mayor»,
// 2026-10-12). Puras, para testearlas sin montar la pantalla.
//
// · `daysLeftTone`: «días a vencer» < 0 = venció y sigue abierta (`neg`);
//   0-30 = vence pronto, alguien tiene que preparar la devolución (`pend`).
//   `null` = sin fecha de fin, que NO es «vence hoy»: sin color.
// · `hfStatusKind`: los estados crudos del CRM (`OPEN`, `ACTIVE`, …). Sólo se
//   colorea lo que se sabe: OPEN/ACTIVE = al día (`ok`). Todo lo demás va
//   neutro con el texto crudo — inventarle un color a un estado que no
//   conocemos sería un significado falso (spec §2.1).
// · `capitalRows`: une solicitudes de retiro y asientos TERMINATION en una
//   lista, ordenada por fecha (las sin fecha al final, no en un mes inventado).
//
// DESCARTADO: agregar un dominio `hedgeFund` a `ui/status-kind.ts`. Es el
// registro canónico de estados del sistema contable (órdenes, egresos,
// PayPros) y lo están tocando otras migraciones en paralelo; estos estados son
// del espejo del CRM y hoy sólo los lee esta pantalla. Si un segundo lugar los
// necesita, se mueven allá (y se borra esto).
// ─────────────────────────────────────────────────────────────────────────────

import type { StatusKind } from '@/components/ui/status-kind';

/** Días a partir de los cuales un vencimiento deja de ser «próximo». */
export const HF_SOON_DAYS = 30;

export function daysLeftTone(daysLeft: number | null | undefined): 'neg' | 'pend' | null {
  if (typeof daysLeft !== 'number' || !Number.isFinite(daysLeft)) return null;
  if (daysLeft < 0) return 'neg';
  if (daysLeft <= HF_SOON_DAYS) return 'pend';
  return null;
}

const OK_STATUSES = new Set(['OPEN', 'ACTIVE']);

export function hfStatusKind(status: string | null | undefined): StatusKind {
  if (!status) return 'neutral';
  return OK_STATUSES.has(status.toUpperCase()) ? 'ok' : 'neutral';
}

export interface CapitalRow {
  id: string;
  kind: 'request' | 'termination';
  at: string | null;
  fundKey: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
}

export function capitalRows(capital: {
  requests: Array<{ requestId: string; fundKey: string | null; status: string | null; amount: number | null; currency: string | null; at: string | null }>;
  terminations: Array<{ entryId: string; fundKey: string | null; amount: number | null; currency: string | null; at: string | null }>;
}): CapitalRow[] {
  const rows: CapitalRow[] = [
    ...capital.requests.map((r) => ({
      id: r.requestId, kind: 'request' as const, at: r.at,
      fundKey: r.fundKey, amount: r.amount, currency: r.currency, status: r.status,
    })),
    ...capital.terminations.map((r) => ({
      id: r.entryId, kind: 'termination' as const, at: r.at,
      fundKey: r.fundKey, amount: r.amount, currency: r.currency, status: 'TERMINATION',
    })),
  ];
  return rows.sort((a, b) => {
    if (a.at === b.at) return 0;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return b.at.localeCompare(a.at);
  });
}

/**
 * La moneda común de las filas, o `null` si hay más de una. El dinero NUNCA
 * se suma entre monedas (reglas G3): con `null` la tabla no muestra total.
 * Una fila sin moneda cuenta como USD, igual que la celda que la dibuja.
 */
export function singleCurrency(rows: Array<{ currency: string | null }>): string | null {
  const set = new Set(rows.map((r) => r.currency ?? 'USD'));
  if (set.size === 0) return 'USD';
  return set.size === 1 ? [...set][0] : null;
}

/** Suma de montos conocidos; `null` si ninguno lo es (no se dibuja $0). */
export function sumKnown(values: Array<number | null | undefined>): number | null {
  let sum = 0;
  let known = 0;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      known += 1;
    }
  }
  return known === 0 ? null : Math.round(sum * 100) / 100;
}
