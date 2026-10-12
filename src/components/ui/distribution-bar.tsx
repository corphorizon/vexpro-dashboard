'use client';

import { formatMoney, MONEY_LOCALE } from '@/lib/money';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { computeDistribution, type DistributionInput, type DistributionSegment } from './distribution';

// ─────────────────────────────────────────────────────────────────────────────
// DistributionBar — barra horizontal segmentada + leyenda (spec §7, pieza de
// la propuesta B para Balances: «Distribución del disponible»).
//
// POR QUÉ (2026-10-12): la tabla de saldos por canal dice cuánto hay en cada
// uno, pero no dónde está concentrado el disponible; con 10+ canales hay que
// sumar de cabeza. La barra lo muestra en una línea y la leyenda repite el %
// en texto: la barra nunca es la única fuente del dato.
//
// Colores: la spec §7 manda una rampa SECUENCIAL de la marca (`brand-ink` al
// 100/75/55/40/28 %, mezclado sobre la superficie para que sea opaco) y
// «Otros» en `border-strong`. NO pos/neg/pend: serían color con significado
// falso (§2.1). Un canal `stale` va rayado del mismo tono, no de otro color.
//
// El cálculo (base = positivos, máx. 5 + Otros, % que suman 100) vive en
// distribution.ts. Lo excluido (deudas/ceros) y lo sin dato se CUENTA y se
// dice debajo de la leyenda.
//
// A11y: `role="img"` con `aria-label` que enumera los %; cada segmento con
// `title` (nombre + monto).
//
// DESCARTADO: la paleta «accent / accent-2 / accent-3 / warn / text-3» del
// pedido de la tanda — `accent-2/3` no existen como tokens y `warn` es `pend`,
// que la spec prohíbe acá. Manda la spec (ver reporte).
// ─────────────────────────────────────────────────────────────────────────────

/** Rampa de la spec §7: % de `brand-ink` por posición. */
export const DIST_RAMP = [100, 75, 55, 40, 28] as const;

/** Color CSS de un segmento. Pura, para test. */
export function segmentColor(seg: Pick<DistributionSegment, 'others' | 'rank'>): string {
  if (seg.others) return 'var(--border-strong)';
  const pct = DIST_RAMP[Math.min(seg.rank, DIST_RAMP.length - 1)];
  return pct === 100 ? 'var(--brand-ink)' : `color-mix(in srgb, var(--brand-ink) ${pct}%, var(--card))`;
}

function segmentBackground(seg: DistributionSegment): string {
  const c = segmentColor(seg);
  if (!seg.stale) return c;
  // Rayado del mismo tono: mitad del color sobre la superficie.
  const faded = `color-mix(in srgb, ${c} 45%, var(--card))`;
  return `repeating-linear-gradient(135deg, ${c} 0 3px, ${faded} 3px 6px)`;
}

export interface DistributionBarProps {
  items: DistributionInput[];
  currency?: string;
  className?: string;
}

export function DistributionBar({ items, currency, className }: DistributionBarProps) {
  const { t } = useI18n();
  const dist = computeDistribution(items, t('ui.dist.others'));
  const pctFmt = new Intl.NumberFormat(MONEY_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pctText = (p: number) => `${pctFmt.format(p)} %`;
  const ariaList = dist.segments.map((s) => `${s.label} ${pctText(s.pct)}`).join(', ');

  return (
    <div className={cn('flex flex-col', className)}>
      {dist.segments.length === 0 ? (
        <p className="px-4 pt-3 text-[12.5px] text-text-3">{t('ui.dist.empty')}</p>
      ) : (
        <>
          <div className="px-4 pt-4">
            <div
              role="img"
              aria-label={t('ui.dist.aria', { list: ariaList })}
              className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-surface-2"
            >
              {dist.segments.map((s) => (
                <i
                  key={s.key}
                  className="block h-full min-w-0.5"
                  style={{ flexGrow: s.value, flexBasis: 0, background: segmentBackground(s) }}
                  title={`${s.label}: ${formatMoney(s.value, { currency })} (${pctText(s.pct)})`}
                />
              ))}
            </div>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5 px-4 pb-4 pt-3 text-[12px] text-text-2">
            {dist.segments.map((s) => (
              <li key={s.key} className="inline-flex items-center gap-1.5">
                <i
                  aria-hidden
                  className="block size-2.5 rounded-[2px]"
                  style={{ background: segmentBackground(s) }}
                />
                <span>
                  {s.label}
                  {s.others && s.count > 1 ? ` (${s.count})` : ''}
                </span>
                <span className="tabular-nums slashed-zero whitespace-nowrap font-semibold text-foreground">
                  {pctText(s.pct)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {(dist.excludedCount > 0 || dist.missingCount > 0) && (
        <p className="px-4 pb-3 text-[12px] text-text-3">
          {dist.excludedCount > 0 &&
            t('ui.dist.excluded', {
              count: String(dist.excludedCount),
              amount: formatMoney(dist.excludedTotal, { currency }),
            })}
          {dist.excludedCount > 0 && dist.missingCount > 0 ? ' · ' : ''}
          {dist.missingCount > 0 && t('ui.table.missing', { n: String(dist.missingCount) })}
        </p>
      )}
    </div>
  );
}
