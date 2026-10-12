'use client';

import { Check, Edit2, Plus, Trash2, X } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Field, Input, Select } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { INPUT_MOBILE, INPUT_NUM, PAGE_SIZE, PaginationControls, ROW_BTN, ROW_BTN_DANGER, btnClass } from './upload-ui';

// ─────────────────────────────────────────────────────────────────────────────
// Libro de movimientos editable — pestañas Liquidez e Inversiones de /upload.
// SÓLO presentación (ver deposits-panel.tsx).
//
// POR QUÉ (2026-10-12, migración «Libro mayor»): las dos pestañas eran la
// misma tabla copiada (fecha, dos textos, entradas/salidas, saldo corrido,
// edición inline, alta abajo) con 160 líneas cada una. Acá es UNA tabla que
// recibe la descripción de sus columnas; page.tsx sigue siendo dueño de las
// filas, el filtro, el saldo corrido (`liqBalanceMap` / `invBalanceMap`), la
// edición y el guardado.
//
// Lo que cambió a la vista:
//   · <FinTable> (tarjeta en < 720 px); el pie lleva los totales calculados
//     por page.tsx sobre TODAS las filas filtradas, no sobre la página;
//   · las columnas «+» / «−» (un signo como cabecera, con el nombre sólo en
//     `title`) pasan a decir «Depósito» / «Retiro»;
//   · entradas, salidas y ganancia en gris: antes verde / rojo / azul crudos.
//     Toda la columna es del mismo signo; el color no informaba (§2.1);
//   · una celda sin movimiento sigue mostrando «—» (0 en la base): NO es
//     «sin dato», por eso no pasa por el `null` de <Money>.
//
// DESCARTADO:
//   · Acciones de fila en `rowActions` de FinTable (aparecen al hover): en
//     modo edición «Guardar / Cancelar» tienen que estar siempre a la vista.
//   · Un `totalCount` en FinTable: la paginación de abajo ya dice «1–25 de N
//     · los totales usan los N», y eran dos avisos para el mismo recorte.
// ─────────────────────────────────────────────────────────────────────────────

/** Columna del libro. `flow` = monto que se muestra sólo si es > 0 («—» si no). */
export interface LedgerField<R, E extends Record<string, string>> {
  key: keyof E & string;
  header: string;
  kind: 'date' | 'text' | 'flow';
  read: (row: R) => string | number | null | undefined;
  /** Columna secundaria (se oculta en la tarjeta móvil). */
  hideSm?: boolean;
}

/** Campo del alta. */
export interface LedgerNewField<N extends Record<string, string>> {
  key: keyof N & string;
  label: string;
  kind: 'date' | 'text' | 'number' | 'select';
  placeholder?: string;
  /** Sólo para `select`. */
  options?: ReadonlyArray<{ value: string; label: string; title?: string }>;
  ariaLabel?: string;
  title?: string;
}

export interface MovementsLedgerProps<
  R extends { id: string },
  E extends Record<string, string>,
  N extends Record<string, string>,
> {
  title: string;
  caption: string;
  emptyText: string;
  /** Filtros (MovementFilters). */
  filters: React.ReactNode;
  /** Filas de la página visible. */
  rows: R[];
  /** Filas filtradas en total (para paginación). */
  totalItems: number;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  fields: LedgerField<R, E>[];
  balanceOf: (row: R) => number;
  /** Totales del pie (sobre TODAS las filas filtradas), por clave de campo + 'balance'. */
  totals: Record<string, number>;
  canEdit: boolean;
  canDelete: boolean;
  canAdd: boolean;
  editingId: string | null;
  edit: E;
  setEdit: React.Dispatch<React.SetStateAction<E>>;
  onStartEdit: (row: R) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: (id: string) => void;
  newFields: LedgerNewField<N>[];
  newValue: N;
  setNew: React.Dispatch<React.SetStateAction<N>>;
  onAdd: () => void;
  addDisabled: boolean;
  saving: boolean;
}

export function MovementsLedger<
  R extends { id: string },
  E extends Record<string, string>,
  N extends Record<string, string>,
>({
  title,
  caption,
  emptyText,
  filters,
  rows,
  totalItems,
  page,
  totalPages,
  onPageChange,
  fields,
  balanceOf,
  totals,
  canEdit,
  canDelete,
  canAdd,
  editingId,
  edit,
  setEdit,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  newFields,
  newValue,
  setNew,
  onAdd,
  addDisabled,
  saving,
}: MovementsLedgerProps<R, E, N>) {
  const { t } = useI18n();

  const columns: FinColumn<R>[] = fields.map((f) => {
    const numeric = f.kind === 'flow';
    return {
      key: f.key,
      header: f.header,
      kind: numeric ? 'money' : 'text',
      hideSm: f.hideSm,
      value: numeric ? (r: R) => Number(f.read(r) ?? 0) : undefined,
      cell: (r: R) => {
        if (editingId === r.id) {
          return (
            <Input
              type={f.kind === 'date' ? 'date' : f.kind === 'flow' ? 'number' : 'text'}
              step={f.kind === 'flow' ? '0.01' : undefined}
              aria-label={f.header}
              value={edit[f.key]}
              onChange={(e) => {
                const v = e.target.value;
                setEdit((p) => ({ ...p, [f.key]: v }));
              }}
              className={f.kind === 'flow' ? INPUT_NUM : INPUT_MOBILE}
            />
          );
        }
        const v = f.read(r);
        if (f.kind === 'flow') {
          const n = Number(v ?? 0);
          return n > 0 ? <Money value={n} className="font-medium" /> : <span className="text-text-3">—</span>;
        }
        if (f.kind === 'date') return <span className="tabular-nums text-foreground">{v}</span>;
        return <span className="text-text-2">{v || '—'}</span>;
      },
    } satisfies FinColumn<R>;
  });

  columns.push({
    key: 'balance',
    header: t('upload.balance'),
    kind: 'money',
    value: balanceOf,
    cell: (r) => (
      <Money value={balanceOf(r)} className={editingId === r.id ? 'text-text-3' : 'font-semibold'} />
    ),
  });

  if (canEdit || canDelete) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">{t('common.actions')}</span>,
      width: '5.5rem',
      align: 'right',
      cardSide: 'right',
      cell: (r) =>
        editingId === r.id ? (
          <span className="inline-flex gap-1">
            <button type="button" onClick={onSaveEdit} className={ROW_BTN} aria-label={t('common.save')}>
              <Check aria-hidden className="size-4" />
            </button>
            <button type="button" onClick={onCancelEdit} className={ROW_BTN} aria-label={t('common.cancel')}>
              <X aria-hidden className="size-4" />
            </button>
          </span>
        ) : (
          <span className="inline-flex gap-1">
            {canEdit && (
              <button
                type="button"
                onClick={() => onStartEdit(r)}
                className={ROW_BTN}
                title={t('common.edit')}
                aria-label={t('common.edit')}
              >
                <Edit2 aria-hidden className="size-3.5" />
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={() => onDelete(r.id)}
                className={ROW_BTN_DANGER}
                title={t('common.delete')}
                aria-label={t('common.delete')}
              >
                <Trash2 aria-hidden className="size-3.5" />
              </button>
            )}
          </span>
        ),
    });
  }

  return (
    <Panel
      title={title}
      flush
      footer={
        totalItems > PAGE_SIZE ? (
          <PaginationControls page={page} totalPages={totalPages} totalItems={totalItems} onChange={onPageChange} />
        ) : undefined
      }
    >
      {filters}
      <FinTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        caption={caption}
        empty={emptyText}
        footer={totalItems > 0 ? { label: t('upload.totals'), values: totals } : undefined}
      />
      {canAdd && (
        <div className="border-t border-border p-4">
          <h3 className="mb-3 flex items-center gap-2 text-[13.5px] font-semibold text-foreground">
            <Plus aria-hidden className="size-4" /> {t('upload.addMovement')}
          </h3>
          <div
            className={cn(
              'grid grid-cols-1 items-end gap-3',
              newFields.length >= 6 ? 'md:grid-cols-7' : 'md:grid-cols-6',
            )}
          >
            {newFields.map((f) => (
              <Field key={f.key} label={f.label}>
                {f.kind === 'select' ? (
                  <Select
                    aria-label={f.ariaLabel}
                    value={newValue[f.key]}
                    onChange={(e) => {
                      const v = e.target.value;
                      setNew((p) => ({ ...p, [f.key]: v }));
                    }}
                    className={INPUT_MOBILE}
                  >
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value} title={o.title}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    type={f.kind === 'text' ? undefined : f.kind}
                    step={f.kind === 'number' ? '0.01' : undefined}
                    title={f.title}
                    value={newValue[f.key]}
                    onChange={(e) => {
                      const v = e.target.value;
                      setNew((p) => ({ ...p, [f.key]: v }));
                    }}
                    placeholder={f.placeholder}
                    className={f.kind === 'number' ? INPUT_NUM : INPUT_MOBILE}
                  />
                )}
              </Field>
            ))}
            <button type="button" onClick={onAdd} disabled={addDisabled} className={btnClass('secondary')}>
              {saving ? t('common.saving') : t('common.add')}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
