'use client';

import { Fragment } from 'react';
import { MONEY_LOCALE } from '@/lib/money';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Money, NUM_CLASS, hasValue, type MoneyTone } from './money';
import { cardLayout, groupRows, isTruncated, type CardPlacement } from './fin-table-model';

// ─────────────────────────────────────────────────────────────────────────────
// FinTable — la tabla financiera del sistema «Libro mayor» (spec §5.3).
//
// POR QUÉ (2026-10-12): `DataTable` (data-table.tsx) es una tabla genérica:
// sin noción de dinero (cada pantalla formatea y alinea a mano), sin grupos
// con subtotal, sin pie de total, y en móvil hace scroll horizontal — una
// tabla de 6 columnas en 375 px obliga a deslizar para ver el monto, que es lo
// único que se vino a mirar. Esta tabla fija:
//   · dinero a la derecha con <Money> (tabular, 500, «—» para null);
//   · filas de grupo (`group-row`) con conteo y subtotal — que se niega a
//     sumar si la lista está recortada o si falta un dato sin decirlo
//     (fin-table-model.ts);
//   · pie de total con la «doble raya» del libro (1.5 px `foreground`),
//     sticky abajo; el total lo pasa el llamador, calculado sobre TODAS las
//     filas, no sobre las visibles;
//   · «Mostrando N de M · los totales usan los M» si `totalCount` > filas:
//     un recorte silencioso es indistinguible de «no hay más» (reglas §1.2);
//   · < 720 px cada fila es una TARJETA (pieza de la propuesta B): grilla
//     2 columnas, nombre/meta a la izquierda, monto/estado a la derecha,
//     `thead` oculto, grupos como cabeceras. Lo que en escritorio es columna
//     (estado, actualizado) se repite bajo el nombre con `mobileMeta`.
//
// Las clases van separadas por media query complementaria (`min-[720px]:`
// escritorio / `max-[720px]:` tarjeta) en vez de pisarse: `cn` es clsx, sin
// tailwind-merge, y dos utilidades del mismo property pelean por orden de CSS.
//
// Sticky: el `thead` y el `tfoot` quedan pegados al contenedor con scroll.
// Para que el pegado se note hace falta un alto acotado (`maxHeight`); sin él
// el contenedor crece y la tabla scrollea con la página.
//
// DESCARTADO:
//   · Ordenar/paginar adentro: lo decide la pantalla (y el recorte lo cuenta
//     `totalCount`). Una tabla que pagina sola esconde cuántas filas hay.
//   · Calcular el total del pie desde `rows`: con lista recortada daría el
//     total de lo visible con cara de total real.
//   · Cambiar `DataTable`: convive; las pantallas migran de a una (fase 5).
// ─────────────────────────────────────────────────────────────────────────────

export interface FinColumn<R> {
  key: string;
  header: React.ReactNode;
  /** 'money' → derecha + <Money> + subtotal; 'number' → derecha tabular; 'text' (default). */
  kind?: 'text' | 'money' | 'number';
  /** Valor numérico (money/number) — también alimenta los subtotales. */
  value?: (row: R) => number | null | undefined;
  /** Render a medida; gana sobre `value`. */
  cell?: (row: R) => React.ReactNode;
  /** Metadato 12 `text-3` bajo el contenido (celda de nombre). */
  meta?: (row: R) => React.ReactNode;
  /** Sólo en tarjeta móvil, bajo el contenido: estado + frescura (spec `sm-only`). */
  mobileMeta?: (row: R) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Columna secundaria: no aparece en la tarjeta móvil. */
  hideSm?: boolean;
  /** Lado en la tarjeta. Por defecto money/number a la derecha, el resto a la izquierda. */
  cardSide?: 'left' | 'right';
  /** Opciones de <Money> para kind 'money'. */
  money?: {
    signed?: boolean;
    tone?: MoneyTone;
    currency?: string;
    stale?: (row: R) => boolean | string | undefined;
  };
  /** Sumar en la fila de grupo. true por defecto para 'money'. */
  subtotal?: boolean;
  /** Ancho CSS de la columna en escritorio («140px», «30%»). */
  width?: string;
}

export interface FinTableFooter {
  /** «Total retiros (4 de 5 canales)» — si excluye algo, lo dice acá. */
  label: React.ReactNode;
  /** Totales por clave de columna, calculados por el llamador sobre TODAS las filas. */
  values?: Record<string, number | null | undefined>;
}

export interface FinTableProps<R> {
  columns: FinColumn<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  /** Agrupar: filas de grupo con conteo y subtotal. */
  groupBy?: (row: R) => string;
  groupLabel?: (key: string) => React.ReactNode;
  /** Subtotales reales por grupo (si la lista está recortada, sin esto se muestra «—»). */
  groupTotals?: Record<string, Record<string, number | null | undefined>>;
  footer?: FinTableFooter;
  /**
   * Filas de pie ANTES del total (subtotal, comisiones…): 13/400 `text-2`, sin
   * la doble raya ni sticky — la doble raya es sólo del total (`footer`).
   */
  footerRows?: FinTableFooter[];
  /** Total de filas que existen (M). Si es mayor que `rows.length`, se avisa. */
  totalCount?: number | null;
  density?: 'compact' | 'comfortable';
  selectedKey?: string | null;
  onRowClick?: (row: R) => void;
  /** Acciones por fila: aparecen al hover / foco (siempre visibles en táctil y móvil). */
  rowActions?: (row: R) => React.ReactNode;
  /** Título accesible de la tabla (caption sólo para lectores). */
  caption?: string;
  empty?: React.ReactNode;
  /** Alto máximo del contenedor (activa el sticky de cabecera y pie). */
  maxHeight?: number | string;
  className?: string;
}

const ACTIONS_KEY = '__actions__';

// Tarjeta móvil: las acciones van en la FILA 1, 3.ª columna — a la derecha del
// monto, en la misma línea.
//
// POR QUÉ (2026-10-12, Balances): antes la celda de acciones entraba a
// `cardLayout` como una columna «derecha» más y caía en la fila siguiente al
// monto: una línea entera para un «···». Medido en /_design a 375 px: cada
// tarjeta crecía ~28 px (de 2 a 3 líneas) sólo por eso.
// DESCARTADO: superponer acciones y monto en la misma celda de grilla (se
// pisan con montos largos) y ocultar las acciones en móvil (en táctil no hay
// hover: serían inaccesibles).
const ACTIONS_CARD_STYLE: React.CSSProperties = { gridColumn: 3, gridRow: 1 };

/** ¿El render de acciones dibuja algo? null/false/'' o un array vacío no. */
export function hasNodeContent(node: React.ReactNode): boolean {
  if (node == null || node === false || node === true || node === '') return false;
  if (Array.isArray(node)) return node.some(hasNodeContent);
  return true;
}

function cardStyle(p: CardPlacement | undefined): React.CSSProperties | undefined {
  // gridColumn/gridRow no afectan a una celda `table-cell` (escritorio): sólo
  // actúan cuando la fila es grid (< 720 px).
  if (!p || p.side === 'hidden') return undefined;
  return { gridColumn: p.side === 'left' ? 1 : 2, gridRow: p.row };
}

export function FinTable<R>({
  columns,
  rows,
  rowKey,
  groupBy,
  groupLabel,
  groupTotals,
  footer,
  footerRows,
  totalCount,
  density = 'compact',
  selectedKey,
  onRowClick,
  rowActions,
  caption,
  empty,
  maxHeight,
  className,
}: FinTableProps<R>) {
  const { t } = useI18n();
  const countFmt = new Intl.NumberFormat(MONEY_LOCALE, { maximumFractionDigits: 0 });
  const truncated = isTruncated(rows.length, totalCount);

  const layoutCols = rowActions
    ? [...columns, { key: ACTIONS_KEY, kind: 'text' as const, cardSide: 'right' as const }]
    : columns;
  // Las acciones NO entran al reparto de filas de la tarjeta: van en una
  // tercera columna de la fila 1, al lado del monto (ver ACTIONS_CARD_STYLE).
  const layout = cardLayout(columns);

  const isNumeric = (c: FinColumn<R>) => c.kind === 'money' || c.kind === 'number';
  const alignOf = (c: FinColumn<R>) => c.align ?? (isNumeric(c) ? 'right' : 'left');
  const alignClass = (c: FinColumn<R>) =>
    alignOf(c) === 'right' ? 'text-right' : alignOf(c) === 'center' ? 'text-center' : 'text-left';
  const sumCols = columns
    .filter((c) => c.value && (c.subtotal ?? c.kind === 'money'))
    .map((c) => ({ key: c.key, value: c.value! }));
  const groups = groupBy ? groupRows(rows, groupBy, sumCols, truncated) : null;
  const totalCols = layoutCols.length;

  const rowH = density === 'comfortable' ? 'min-[720px]:h-11' : 'min-[720px]:h-row';

  // ── Clases compartidas (escritorio | tarjeta, nunca las dos pisándose) ──
  const tdBase = cn(
    'align-middle text-[13px]',
    'min-[720px]:border-b min-[720px]:border-border min-[720px]:px-3 min-[720px]:first:pl-4 min-[720px]:last:pr-4',
    'max-[720px]:block max-[720px]:min-w-0',
  );
  const bodyTr = cn(
    'max-[720px]:grid max-[720px]:items-center max-[720px]:gap-x-3 max-[720px]:gap-y-0.5',
    // Con acciones, la tarjeta tiene una 3.ª columna angosta para ellas.
    rowActions
      ? 'max-[720px]:grid-cols-[minmax(0,1fr)_auto_auto]'
      : 'max-[720px]:grid-cols-[minmax(0,1fr)_auto]',
    'max-[720px]:border-b max-[720px]:border-border max-[720px]:px-4 max-[720px]:py-3',
  );

  function renderCell(c: FinColumn<R>, row: R) {
    if (c.cell) return c.cell(row);
    if (c.kind === 'money') {
      return (
        <Money
          value={c.value?.(row)}
          signed={c.money?.signed}
          tone={c.money?.tone}
          currency={c.money?.currency}
          stale={c.money?.stale?.(row)}
          nullLabel={t('ui.noData')}
          className="font-medium"
        />
      );
    }
    if (c.kind === 'number') {
      const v = c.value?.(row);
      return <span className={NUM_CLASS}>{hasValue(v) ? countFmt.format(v) : '—'}</span>;
    }
    return null;
  }

  function renderBodyRow(row: R) {
    const key = rowKey(row);
    const selected = selectedKey != null && key === selectedKey;
    const clickable = Boolean(onRowClick);
    const actions = rowActions ? rowActions(row) : null;
    const hasActions = hasNodeContent(actions);
    return (
      <tr
        key={key}
        data-selected={selected || undefined}
        aria-current={selected ? 'true' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? () => onRowClick!(row) : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onRowClick!(row);
                }
              }
            : undefined
        }
        className={cn(
          'group/row',
          bodyTr,
          clickable && 'cursor-pointer',
          selected ? 'bg-row-selected' : 'hover:bg-row-hover',
          // Barra de selección: en tarjeta va en la fila entera.
          selected && 'max-[720px]:shadow-[inset_3px_0_0_0_var(--brand-ink)]',
        )}
      >
        {columns.map((c, i) => {
          const p = layout[c.key];
          return (
            <td
              key={c.key}
              style={cardStyle(p)}
              className={cn(
                tdBase,
                rowH,
                alignClass(c),
                p.side === 'hidden' && 'max-[720px]:hidden',
                p.side === 'right' && 'max-[720px]:text-right',
                p.side === 'left' && 'max-[720px]:text-left',
                selected && i === 0 && 'min-[720px]:shadow-[inset_3px_0_0_0_var(--brand-ink)]',
              )}
            >
              {c.meta || c.mobileMeta ? (
                <div className="min-w-0 max-[720px]:py-0 min-[720px]:py-1.5">
                  <div className="truncate font-medium text-foreground">{renderCell(c, row) ?? null}</div>
                  {c.meta && <div className="truncate text-[12px] leading-[1.3] text-text-3">{c.meta(row)}</div>}
                  {c.mobileMeta && (
                    <div className="mt-1 hidden flex-wrap items-center gap-1.5 text-[12px] text-text-3 max-[720px]:flex">
                      {c.mobileMeta(row)}
                    </div>
                  )}
                </div>
              ) : (
                renderCell(c, row)
              )}
            </td>
          );
        })}
        {rowActions && (
          <td
            style={ACTIONS_CARD_STYLE}
            className={cn(
              tdBase,
              rowH,
              'w-px whitespace-nowrap text-right',
              // Sin acciones para esta fila: en la tarjeta no queda una celda vacía.
              !hasActions && 'max-[720px]:hidden',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className={cn(
                'inline-flex items-center justify-end gap-1',
                'min-[720px]:opacity-0 min-[720px]:group-hover/row:opacity-100 min-[720px]:group-focus-within/row:opacity-100',
                '[@media(pointer:coarse)]:opacity-100',
              )}
            >
              {actions}
            </div>
          </td>
        )}
      </tr>
    );
  }

  function renderGroupRow(g: NonNullable<typeof groups>[number]) {
    const label = groupLabel ? groupLabel(g.key) : g.key;
    const given = groupTotals?.[g.key];
    return (
      <tr
        key={`grp-${g.key}`}
        data-group={g.key}
        className="bg-group-row max-[720px]:flex max-[720px]:items-center max-[720px]:justify-between max-[720px]:gap-3 max-[720px]:border-b max-[720px]:border-border max-[720px]:px-4 max-[720px]:py-2"
      >
        {layoutCols.map((col, i) => {
          const c = col as FinColumn<R>;
          const st = g.subtotals[c.key];
          const isLabel = i === 0;
          const hasSum = Boolean(st);
          return (
            <th
              key={c.key}
              scope={isLabel ? 'rowgroup' : undefined}
              className={cn(
                'text-[12px] font-semibold text-text-2',
                'min-[720px]:h-8 min-[720px]:border-b min-[720px]:border-border min-[720px]:px-3 min-[720px]:first:pl-4 min-[720px]:last:pr-4',
                isLabel ? 'text-left' : alignClass(c),
                !isLabel && !hasSum && 'max-[720px]:hidden',
                hasSum && layout[c.key]?.side === 'hidden' && 'max-[720px]:hidden',
              )}
            >
              {isLabel && (
                <span>
                  {label}
                  <span className="font-medium text-text-3">
                    {' · '}
                    {countFmt.format(g.rows.length)}
                    {g.missingRows > 0 && ` · ${t('ui.table.missing', { n: String(g.missingRows) })}`}
                  </span>
                </span>
              )}
              {hasSum && (
                <Money
                  value={given ? given[c.key] : st.sum}
                  signed={c.money?.signed}
                  currency={c.money?.currency}
                  tone={c.money?.tone}
                  nullLabel={st.partial && !given ? t('ui.table.partialSubtotal') : t('ui.noData')}
                />
              )}
            </th>
          );
        })}
      </tr>
    );
  }

  // Pie: `total` lleva la «doble raya» del libro, 650 y sticky abajo; `sub`
  // (subtotal, comisiones — agregado 2026-10-12 para el detalle de Órdenes de
  // pago) va en 13/400 `text-2`, sin raya ni sticky: dos filas sticky con
  // `bottom: 0` se encimarían.
  function renderFooterRow(f: FinTableFooter, variant: 'sub' | 'total', key: string) {
    const isTotal = variant === 'total';
    return (
      <tr key={key} data-foot={variant} className={cn(bodyTr, 'max-[720px]:bg-surface-2')}>
        {layoutCols.map((col, i) => {
          const c = col as FinColumn<R>;
          const p = layout[c.key];
          const hasValueCol = f.values != null && c.key in f.values;
          const isLabel = i === 0;
          return (
            <td
              key={c.key}
              style={isLabel ? { gridColumn: 1, gridRow: 1 } : cardStyle(p)}
              className={cn(
                'text-[13px]',
                isTotal ? 'font-[650] text-foreground' : 'text-text-2',
                'min-[720px]:px-3 min-[720px]:first:pl-4 min-[720px]:last:pr-4',
                isTotal
                  ? 'min-[720px]:sticky min-[720px]:bottom-0 min-[720px]:h-[42px] min-[720px]:bg-card min-[720px]:shadow-[inset_0_1.5px_0_0_var(--foreground)]'
                  : 'min-[720px]:h-8 min-[720px]:bg-card',
                'max-[720px]:block',
                isLabel ? 'text-left' : alignClass(c),
                !isLabel && !hasValueCol && 'max-[720px]:hidden',
                !isLabel && p?.side === 'hidden' && 'max-[720px]:hidden',
                p?.side === 'right' && 'max-[720px]:text-right',
              )}
            >
              {isLabel && f.label}
              {hasValueCol && (
                <Money
                  value={f.values![c.key]}
                  signed={c.money?.signed}
                  currency={c.money?.currency}
                  tone={c.money?.tone}
                  nullLabel={t('ui.noData')}
                  className={isTotal ? undefined : 'font-medium'}
                />
              )}
            </td>
          );
        })}
      </tr>
    );
  }

  const containerStyle: React.CSSProperties | undefined =
    maxHeight != null ? { maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight } : undefined;

  return (
    <div className={cn('min-w-0', className)}>
      <div className="overflow-x-auto max-[720px]:overflow-visible" style={containerStyle}>
        <table className="w-full border-separate border-spacing-0 text-[13px] max-[720px]:block">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="max-[720px]:hidden">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  style={c.width ? { width: c.width } : undefined}
                  className={cn(
                    'sticky top-0 z-[1] h-[34px] whitespace-nowrap border-b border-border-strong bg-card px-3 first:pl-4 last:pr-4',
                    'text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3',
                    alignClass(c),
                  )}
                >
                  {c.header}
                </th>
              ))}
              {rowActions && (
                <th scope="col" className="sticky top-0 z-[1] h-[34px] border-b border-border-strong bg-card pr-4">
                  <span className="sr-only">{t('ui.table.actions')}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="max-[720px]:block">
            {rows.length === 0 ? (
              <tr className="max-[720px]:block">
                <td colSpan={totalCols} className="px-4 py-8 text-center text-[13px] text-text-3 max-[720px]:block">
                  {empty ?? t('ui.table.empty')}
                </td>
              </tr>
            ) : groups ? (
              groups.map((g) => (
                <Fragment key={g.key}>
                  {renderGroupRow(g)}
                  {g.rows.map(renderBodyRow)}
                </Fragment>
              ))
            ) : (
              rows.map(renderBodyRow)
            )}
          </tbody>
          {(footer || (footerRows && footerRows.length > 0)) && (
            <tfoot className="max-[720px]:block">
              {footerRows?.map((f, i) => renderFooterRow(f, 'sub', `sub-${i}`))}
              {footer && renderFooterRow(footer, 'total', 'total')}
            </tfoot>
          )}
        </table>
      </div>
      {truncated && (
        <p className="border-t border-border px-4 py-2.5 text-[12.5px] text-text-3" role="note">
          {t('ui.table.showing', {
            shown: countFmt.format(rows.length),
            total: countFmt.format(totalCount!),
            totalAll: countFmt.format(totalCount!),
          })}
        </p>
      )}
    </div>
  );
}
