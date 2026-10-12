// ─────────────────────────────────────────────────────────────────────────────
// periods-view — las decisiones de /periodos que no son de dibujo, puras para
// testearlas sin DOM (mismo patrón que ordenes-pago/orders-view.ts).
//
// POR QUÉ (2026-10-12, migración «Libro mayor»):
//   · Color = significado (spec §2.1): «Abierto» es `pend` (requiere una
//     acción: cerrarlo), «Cerrado» es neutro (terminado, no afirma nada
//     bueno ni malo), «En curso» es `info` (abierto pero todavía no se puede
//     cerrar: no hay nada que hacer). Antes «Abierto» era VERDE — el color de
//     «completado» para lo único de la pantalla que está sin completar.
//   · Cerrado por / cuándo: `close_period` (migración 061) graba `closed_at`
//     y `closed_by_name`, y la pantalla nunca los mostró. OJO: `reopen_period`
//     NO los limpia, así que en un período reabierto siguen los del último
//     cierre. Se muestran SÓLO si el período está cerrado; un mes cerrado
//     antes de la 061 no tiene esos datos y es «—», no una fecha inventada.
//   · Reserva %: `reserve_pct` es una fracción (0.1 = 10 %) y es insumo de la
//     cadena de distribución. null → «—», nunca 0 % (reglas §1.3).
//   · Checklist → kinds: un ítem bloqueante con conteo es `bad`, un aviso con
//     conteo es `pend`, y un ítem en 0 es `ok`. Antes los ítems en 0 no se
//     mostraban: «no hay pendientes de X» y «no se revisó X» se veían igual.
//
// DESCARTADO:
//   · Agregar `closed_at`/`closed_by_name` a `Period` en lib/types.ts: el
//     tipo es compartido por toda la app y otras tandas lo tocan en paralelo.
//     Se leen acá como campos opcionales (la query hace `select('*')`).
// ─────────────────────────────────────────────────────────────────────────────

import type { Period } from '@/lib/types';
import type { StatusKind } from '@/components/ui/status-kind';

export type PeriodStatus = 'closed' | 'open' | 'in_progress';

/** Orden de los estados para leyendas y conteos. */
export const PERIOD_STATUSES: readonly PeriodStatus[] = ['open', 'in_progress', 'closed'];

/** Color de cada estado (registro único de esta pantalla). */
export const PERIOD_STATUS_KIND: Record<PeriodStatus, StatusKind> = {
  open: 'pend',
  in_progress: 'info',
  closed: 'neutral',
};

/** Campos de cierre que trae `select('*')` desde la migración 061. */
export type PeriodWithClose = Period & {
  closed_at?: string | null;
  closed_by_name?: string | null;
};

// `is_closed` SIEMPRE va primero. Cuando el chequeo de "mes en curso" iba
// antes, un período del mes actual que estaba cerrado en la base se mostraba
// como "En curso": no aparecía ni "Cerrar" ni "Reabrir", pero el trigger de la
// migración 061 seguía rechazando toda escritura — el mes quedaba irreabrible
// desde la UI y sólo se destrababa con SQL directo.
// "En curso" es, por definición, el mes actual TODAVÍA abierto.
export function periodStatus(p: Pick<Period, 'is_closed' | 'year' | 'month'>, now: Date): PeriodStatus {
  if (p.is_closed) return 'closed';
  if (p.year === now.getFullYear() && p.month === now.getMonth() + 1) return 'in_progress';
  return 'open';
}

export interface PeriodRow {
  id: string;
  label: string;
  year: number;
  month: number;
  status: PeriodStatus;
  /** Reserva en PORCENTAJE (10 = 10 %); null si no hay dato. */
  reservePct: number | null;
  /** Sólo si está cerrado y la base lo sabe. */
  closedAt: string | null;
  closedBy: string | null;
}

export function reservePercent(fraction: number | null | undefined): number | null {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null;
  return Math.round(fraction * 10000) / 100;
}

/** Filas de la tabla: el mes más reciente primero (las acciones viven arriba). */
export function buildPeriodRows(periods: PeriodWithClose[], now: Date): PeriodRow[] {
  return periods
    .map((p) => {
      const status = periodStatus(p, now);
      const closed = status === 'closed';
      return {
        id: p.id,
        label: p.label || '',
        year: p.year,
        month: p.month,
        status,
        reservePct: reservePercent(p.reserve_pct),
        closedAt: closed ? p.closed_at ?? null : null,
        closedBy: closed ? p.closed_by_name?.trim() || null : null,
      };
    })
    .sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month));
}

export function periodStatusCounts(rows: Pick<PeriodRow, 'status'>[]): Record<PeriodStatus, number> {
  const out: Record<PeriodStatus, number> = { open: 0, in_progress: 0, closed: 0 };
  for (const r of rows) out[r.status] += 1;
  return out;
}

// ── Checklist de cierre ─────────────────────────────────────────────────────

export interface ChecklistApiItem {
  key: string;
  /** Clave i18n (registro único en src/lib/period-close-checklist.ts). */
  labelKey?: string;
  /** Respaldo en castellano para un cliente/servidor viejo. */
  label?: string;
  count: number;
  detail: string | null;
  severity?: 'warning' | 'blocking';
}

export interface ChecklistState {
  items: ChecklistApiItem[];
  clean: boolean;
  /** true → la RPC va a rechazar el cierre (orden cronológico). */
  blocked?: boolean;
  failed?: boolean;
}

export interface ChecklistRow extends ChecklistApiItem {
  kind: Extract<StatusKind, 'ok' | 'pend' | 'bad'>;
}

const KIND_ORDER: Record<ChecklistRow['kind'], number> = { bad: 0, pend: 1, ok: 2 };

/**
 * Ítems con su kind, problemas primero (bloqueantes, avisos, en orden), y
 * los que dieron 0 al final como `ok`: se ve QUÉ se revisó, no sólo qué falló.
 * Un conteo inválido (NaN, negativo) no es «ok»: se trata como aviso.
 */
export function checklistRows(items: ChecklistApiItem[]): ChecklistRow[] {
  const rows = items.map((i, idx) => {
    const count = Number(i.count);
    const clean = Number.isFinite(count) && count === 0;
    const kind: ChecklistRow['kind'] = clean ? 'ok' : i.severity === 'blocking' ? 'bad' : 'pend';
    return { row: { ...i, kind }, idx };
  });
  return rows.sort((a, b) => KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind] || a.idx - b.idx).map((r) => r.row);
}

export function checklistSummary(rows: ChecklistRow[]): { bad: number; pend: number; ok: number } {
  const out = { bad: 0, pend: 0, ok: 0 };
  for (const r of rows) out[r.kind] += 1;
  return out;
}
