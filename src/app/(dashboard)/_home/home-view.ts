// ─────────────────────────────────────────────────────────────────────────────
// home-view — las decisiones de la home del admin, sin React (rediseño «Libro
// mayor», 2026-10-12).
//
// POR QUÉ:
//   · Alertas: la home no avisaba NADA. Lo que hacía falta saber vivía en
//     cuatro pantallas distintas — la serie del CRM que no llegó (/socios), un
//     canal de retiros sin dato (/movimientos), el checklist de cierre
//     (/periodos, sólo al apretar «Cerrar»), los meses cerrados editados
//     (/socios) — y en la home se veían los números como si estuvieran bien.
//     Acá se juntan en UNA lista ordenada por severidad (bad > pend > stale >
//     info); la pantalla muestra 3 y «ver todas (N)». Recortar sin decir
//     cuántas quedan sería un recorte silencioso (reglas §1.2).
//   · Total consolidado: si /api/balances/total-consolidado fallaba, el
//     `catch` ponía `0` — la home decía «Total consolidado $0.00» con la red
//     caída. Ahora el estado es 'failed' → «—» + aviso `bad`.
//
// Los textos NO viven acá: cada alerta trae una clave de i18n (o el texto ya
// formado de `incompleteNotice`, que comparte el PDF) y la pantalla traduce.
//
// DESCARTADO: leer las notificaciones del usuario (/api/notifications) como
// alertas. Son eventos (ya pasaron); esto es estado del dato de HOY.
// ─────────────────────────────────────────────────────────────────────────────

import type { NoticeKind } from '@/components/ui/notice';
import type { SeriesState } from '@/lib/chain-view';

export type LoadState = 'loading' | 'ready' | 'failed';

export type AlertText = { key: string; params?: Record<string, string> } | { text: string };

export interface HomeAlert {
  id: string;
  kind: NoticeKind;
  title: AlertText;
  detail?: AlertText | null;
  /** Conteo delante del título («3 · Órdenes aprobadas sin pagar»). */
  count?: number;
  href?: string;
}

export interface ChecklistItemLike {
  key: string;
  labelKey?: string;
  label?: string;
  count: number;
  detail: string | null;
  severity?: 'warning' | 'blocking';
}

export interface HomeAlertsInput {
  /** null = el usuario no ve Balances (no se avisa de lo que no ve). */
  totalState: LoadState | null;
  /** Serie del CRM del mes en curso (chain scope). */
  monthSeries: SeriesState | null;
  /** `incompleteNotice` del mes en curso: «Broker P&L: sin datos del CRM — …». */
  monthNotice: string | null;
  /** Rótulos de canales de retiro sin dato (sólo si el usuario ve Movimientos). */
  withdrawalChannelsWithoutData: readonly string[];
  /** `truncatedSlices` del bootstrap. */
  truncatedSlices: readonly string[];
  /** Meses cerrados con datos editados después del cierre. */
  driftPeriods: readonly string[];
  /** Checklist de cierre del mes abierto. null = no aplica (sin período abierto). */
  checklist: { state: LoadState; items: readonly ChecklistItemLike[] } | null;
  periodLabel: string | null;
}

const SEVERITY: Record<NoticeKind, number> = { bad: 0, pend: 1, stale: 2, info: 3 };

/** Todas las alertas, de la más grave a la menos. Orden estable dentro de cada severidad. */
export function homeAlerts(input: HomeAlertsInput): HomeAlert[] {
  const out: HomeAlert[] = [];

  if (input.totalState === 'failed') {
    out.push({ id: 'total-failed', kind: 'bad', title: { key: 'home.alert.totalFailed' }, href: '/balances' });
  }

  if (input.monthSeries && input.monthNotice) {
    out.push({
      id: 'crm-series',
      kind: input.monthSeries.notice,
      title: { text: input.monthNotice },
      detail: { key: input.monthSeries.phase === 'loading' ? 'home.alert.crmLoading' : 'home.alert.crmFailed' },
      href: '/socios',
    });
  }

  if (input.driftPeriods.length > 0) {
    out.push({
      id: 'drift',
      kind: 'bad',
      title: { key: 'home.alert.drift', params: { n: String(input.driftPeriods.length) } },
      detail: { text: input.driftPeriods.join(', ') },
      href: '/socios',
    });
  }

  if (input.withdrawalChannelsWithoutData.length > 0) {
    out.push({
      id: 'withdrawal-channels',
      kind: 'pend',
      title: {
        key: 'home.alert.withdrawalChannels',
        params: { channels: input.withdrawalChannelsWithoutData.join(', ') },
      },
      detail: { key: 'home.alert.notZero' },
      href: '/movimientos',
    });
  }

  if (input.truncatedSlices.length > 0) {
    out.push({
      id: 'truncated',
      kind: 'pend',
      title: { key: 'home.alert.truncated', params: { slices: input.truncatedSlices.join(', ') } },
      detail: { key: 'home.alert.truncatedBody' },
    });
  }

  if (input.checklist) {
    if (input.checklist.state === 'failed') {
      out.push({
        id: 'checklist-failed',
        kind: 'info',
        title: { key: 'home.alert.checklistFailed', params: { period: input.periodLabel ?? '' } },
        href: '/periodos',
      });
    } else if (input.checklist.state === 'ready') {
      for (const item of input.checklist.items) {
        if (item.count <= 0) continue;
        out.push({
          id: `checklist-${item.key}`,
          kind: item.severity === 'blocking' ? 'bad' : 'pend',
          title: item.labelKey
            ? { key: item.labelKey }
            : { text: item.label ?? item.key },
          detail: item.detail ? { text: item.detail } : null,
          count: item.count,
          href: '/periodos',
        });
      }
    }
  }

  return out
    .map((a, i) => ({ a, i }))
    .sort((x, y) => SEVERITY[x.a.kind] - SEVERITY[y.a.kind] || x.i - y.i)
    .map(({ a }) => a);
}

export const HOME_ALERTS_VISIBLE = 3;

/** Las que se muestran y cuántas quedan ocultas (para «ver todas (N)»). */
export function visibleAlerts<T>(alerts: readonly T[], expanded: boolean, max = HOME_ALERTS_VISIBLE) {
  const shown = expanded ? [...alerts] : alerts.slice(0, max);
  return { shown, hidden: alerts.length - shown.length };
}

// ─── Números ────────────────────────────────────────────────────────────────

/** Variación % contra el mes anterior. null si no hay base (anterior 0 o sin dato). */
export function pctChange(now: number | null, prev: number | null): number | null {
  if (now === null || prev === null || !prev) return null;
  const v = ((now - prev) / Math.abs(prev)) * 100;
  return Number.isFinite(v) ? v : null;
}

/**
 * Saldo corrido de Inversiones / Liquidez: Σ depósito − retiro (+ profit).
 * Los campos null de un movimiento son «ese movimiento no tiene esa parte»,
 * no datos faltantes: ahí 0 es correcto. Sin movimientos → null (no «$0»).
 */
export function runningBalance(
  items: ReadonlyArray<{ deposit?: number | null; withdrawal?: number | null; profit?: number | null }>,
): number | null {
  if (items.length === 0) return null;
  let bal = 0;
  for (const m of items) bal += (m.deposit ?? 0) - (m.withdrawal ?? 0) + (m.profit ?? 0);
  return Math.round(bal * 100) / 100;
}
