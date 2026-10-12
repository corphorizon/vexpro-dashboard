'use client';

import { useState } from 'react';
import { Clock } from 'lucide-react';
import { MONEY_LOCALE } from '@/lib/money';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Money, NUM_CLASS, hasValue, type MoneyTone } from './money';
import { StatusBadge, type StatusKind } from './status-badge';
import { relativeAge } from './relative-age';

// ─────────────────────────────────────────────────────────────────────────────
// KpiStrip — franja de KPIs: UNA superficie dividida, no N tarjetas
// («Libro mayor», spec §5.4).
//
// POR QUÉ (2026-10-12): `StatCard` es una tarjeta por número, con ícono de
// color y `font-bold text-2xl`. Cinco tarjetas con cinco íconos de colores
// compiten entre sí y el color deja de significar (spec §2.1). Y el caso que
// importa: un KPI sin dato se mostraba «$0.00» porque el llamador hacía
// `formatCurrency(x ?? 0)` — «no lo sabemos» leído como «es cero»
// (reglas-del-proyecto.md §1.3). Acá:
//   · `value: null` → «—» + badge «Sin dato» (pend: requiere mirar). NUNCA $0.
//   · `staleAt` → el valor sigue (suma), subrayado punteado violeta, y el sub
//     dice «hace 26 h» con un reloj. Cada número dice de cuándo es.
//   · `delta` → «▲ 4.1 % vs. 31 ago» en pos/neg; `goodWhen: 'down'` invierte
//     el color para gastos (que bajen es bueno).
//
// Medidas: celda padding 14 18, etiqueta 12/500 `text-2`, valor 22/600
// tabular (hero 26), móvil 18 (hero 24), sub 12 `text-3`.
// Responsive: ≥ 1100 todas en una fila (máx. 5); 640–1100 hasta 3 columnas;
// < 640 dos columnas con el hero a todo el ancho.
//
// Los divisores son una sombra de 1 px a la izquierda y arriba de cada celda,
// recortada por el `overflow-hidden` del contenedor: así la primera columna y
// la primera fila no dibujan línea, y no se duplican bordes al cambiar el
// número de columnas (la spec pide «recalcular los bordes»; esto lo hace sin
// calcular nada por breakpoint).
//
// Color de marca (2026-10-12, spec §10): filete superior de 2 px `brand-ink`
// en toda la franja y, opcional, un `icon` por KPI en un cuadro con el tinte de
// marca. El VALOR nunca toma el color de marca: sigue `foreground` o el tono de
// significado (pos/neg/stale) que decide Money — un número azul de marca se
// leería como «info» o como «positivo».
//
// DESCARTADO:
//   · `gap-px` sobre fondo `border` (el truco clásico): con 5 KPIs en 3
//     columnas la celda vacía del final queda pintada de color borde.
//   · Formatear «hace X» en el server: el reloj se toma en el cliente al montar
//     (`useState`), con `suppressHydrationWarning` por si cruza un minuto.
// ─────────────────────────────────────────────────────────────────────────────

export interface KpiDelta {
  /** Variación en PORCENTAJE (4.1 = 4,1 %). */
  pct: number;
  /** Referencia: «31 ago», «mes anterior». */
  ref?: string;
  /** Qué dirección es buena. 'up' por defecto; 'down' para gastos. */
  goodWhen?: 'up' | 'down';
}

export interface KpiItem {
  key?: string;
  label: React.ReactNode;
  /** null/undefined = sin dato → «—». Nunca se convierte en 0. */
  value: number | null | undefined;
  /** 'compact' ($45.2K, exacto en title) por defecto; 'money' exacto; 'count'; 'percent' (4.1 → 4.1 %). */
  format?: 'compact' | 'money' | 'count' | 'percent';
  currency?: string;
  /** Color del valor de dinero (ver Money). 'auto' = sólo negativos. */
  tone?: MoneyTone;
  /** El número que importa: 26 px y, en móvil, toda la fila. */
  hero?: boolean;
  /** Explicación bajo el valor: conteo, por qué no hay dato, «1 canal sin dato». */
  sub?: React.ReactNode;
  delta?: KpiDelta;
  /** Fecha del dato si es viejo: lo marca `stale` y muestra «hace X». */
  staleAt?: Date | string | number | null;
  /**
   * Badge que REEMPLAZA al «Sin dato» (pend) cuando `value` es null, para
   * cuando la pantalla sabe POR QUÉ falta: «Cargando datos del CRM…» es un
   * dato que todavía no llegó (`stale`), no algo que alguien tenga que
   * resolver. `false` = sin badge (el `sub` ya lo explica). Nunca cambia el
   * «—»: el valor sigue sin inventarse.
   *
   * Agregado 2026-10-12 (Home / Resumen / Socios): con el badge fijo, un KPI
   * en vuelo mostraba DOS badges («Sin dato» + «Cargando datos del CRM»), y
   * el primero afirma algo falso — sí hay dato, todavía no llegó.
   */
  missingBadge?: { kind: StatusKind; label: React.ReactNode } | false;
  /** Ícono junto a la etiqueta, en un cuadro con el tinte de marca. */
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}

const pctFmt = () =>
  new Intl.NumberFormat(MONEY_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** «▲ 4.1 %» + color. Pura, para test. Un delta que redondea a 0.0 no tiene flecha ni color. */
export function deltaParts(delta: KpiDelta): { text: string; tone: 'pos' | 'neg' | 'neutral' } {
  const rounded = Math.round(delta.pct * 10) / 10;
  if (!Number.isFinite(rounded)) return { text: '—', tone: 'neutral' };
  const abs = pctFmt().format(Math.abs(rounded));
  if (rounded === 0) return { text: `${abs} %`, tone: 'neutral' };
  const up = rounded > 0;
  const good = (delta.goodWhen ?? 'up') === 'up' ? up : !up;
  return { text: `${up ? '▲' : '▼'} ${abs} %`, tone: good ? 'pos' : 'neg' };
}

/** Texto de un KPI que no es dinero. null → «—». */
export function kpiPlainText(value: number | null | undefined, format: 'count' | 'percent'): string {
  if (!hasValue(value)) return '—';
  if (format === 'percent') return `${pctFmt().format(value)} %`;
  return new Intl.NumberFormat(MONEY_LOCALE, { maximumFractionDigits: 0 }).format(value);
}

export interface KpiStripProps {
  /** Hasta 5. Más de 5 no entra en una fila de escritorio: partí la franja. */
  items: KpiItem[];
  className?: string;
  /** Sólo para tests / la muestra: «ahora» fijo para «hace X». */
  now?: number;
}

export function KpiStrip({ items, className, now: nowProp }: KpiStripProps) {
  const { t } = useI18n();
  const [mountedAt] = useState(() => Date.now());
  const now = nowProp ?? mountedAt;
  const shown = items.slice(0, 5);
  if (process.env.NODE_ENV !== 'production' && items.length > 5) {
    // Un recorte silencioso es indistinguible de «no hay más» (reglas §1.2).
    console.warn(`KpiStrip: ${items.length} KPIs, se muestran 5. Partí la franja.`);
  }
  const n = Math.max(shown.length, 1);
  return (
    <div
      className={cn(
        'grid overflow-hidden rounded-ui-lg border border-border border-t-2 border-t-brand-ink bg-card shadow-1',
        'grid-cols-2 sm:grid-cols-[repeat(var(--kc3),minmax(0,1fr))] min-[1100px]:grid-cols-[repeat(var(--kc),minmax(0,1fr))]',
        className,
      )}
      style={{ '--kc': n, '--kc3': Math.min(n, 3) } as React.CSSProperties}
    >
      {shown.map((item, i) => {
        const format = item.format ?? 'compact';
        const missing = !hasValue(item.value);
        const age = item.staleAt != null ? relativeAge(item.staleAt, now) : null;
        const staleTitle = age ? t(age.key, { n: String(age.n) }) : undefined;
        const delta = item.delta ? deltaParts(item.delta) : null;
        const valueClass = cn(
          'mt-1 block font-semibold leading-[26px] tracking-[-0.02em]',
          item.hero ? 'text-[24px] sm:text-[26px] sm:leading-[30px]' : 'text-[18px] sm:text-[22px] sm:leading-[30px]',
        );
        return (
          <div
            key={item.key ?? i}
            className={cn(
              'min-w-0 px-[18px] py-3.5 text-foreground shadow-[-1px_0_0_0_var(--border),0_-1px_0_0_var(--border)]',
              (item.hero || n === 1) && 'max-sm:col-span-2',
            )}
            data-hero={item.hero || undefined}
          >
            <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-text-2">
              {item.icon && (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-ui-sm bg-brand-tint text-brand-ink">
                  <item.icon className="size-3" aria-hidden />
                </span>
              )}
              <span className="truncate">{item.label}</span>
            </div>
            {missing ? (
              <span className={cn(valueClass, NUM_CLASS, 'text-text-3')}>—</span>
            ) : format === 'count' || format === 'percent' ? (
              <span className={cn(valueClass, NUM_CLASS, 'text-foreground')}>
                {kpiPlainText(item.value, format)}
              </span>
            ) : (
              <Money
                value={item.value}
                compact={format === 'compact'}
                currency={item.currency}
                tone={item.tone}
                stale={item.staleAt != null ? staleTitle ?? true : undefined}
                // Sin clase de color acá: Money decide (tono / stale) y el
                // texto normal hereda `foreground` de la celda. `cn` no
                // fusiona clases, así que dos colores pelearían por orden de CSS.
                className={valueClass}
              />
            )}
            <div className="mt-0.5 flex min-h-4 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] leading-4 text-text-3">
              {missing &&
                (item.missingBadge === undefined ? (
                  <StatusBadge kind="pend" label={t('ui.noData')} />
                ) : item.missingBadge ? (
                  <StatusBadge kind={item.missingBadge.kind} label={item.missingBadge.label} />
                ) : null)}
              {age && (
                <span className="inline-flex items-center gap-1 text-stale" suppressHydrationWarning>
                  <Clock aria-hidden className="size-3" strokeWidth={2} />
                  {staleTitle}
                </span>
              )}
              {delta && !missing && (
                <span
                  className={cn(
                    NUM_CLASS,
                    delta.tone === 'pos' && 'text-pos',
                    delta.tone === 'neg' && 'text-neg',
                  )}
                >
                  {delta.text}
                  {item.delta?.ref ? ` ${t('ui.kpi.vs', { ref: item.delta.ref })}` : ''}
                </span>
              )}
              {item.sub != null && <span className="min-w-0">{item.sub}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
