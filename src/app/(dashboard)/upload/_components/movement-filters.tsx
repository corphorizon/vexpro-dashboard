'use client';

import { ArrowUpDown } from 'lucide-react';
import { Field, Input, Select } from '@/components/ui/field';
import { useI18n } from '@/lib/i18n';
import { INPUT_MOBILE, btnClass } from './upload-ui';

// ─────────────────────────────────────────────────────────────────────────────
// Barra de filtros de Liquidez e Inversiones (desde / hasta / período / orden).
//
// POR QUÉ (2026-10-12, migración «Libro mayor»): eran dos copias idénticas de
// 50 líneas en page.tsx, cada una con sus `<label>` sin `for` y su propia
// receta de foco. Una sola pieza con <Field> (label atado al control, 36 px,
// borde control-border). El estado de cada filtro sigue en page.tsx.
// ─────────────────────────────────────────────────────────────────────────────

export interface MovementFiltersProps {
  dateFrom: string;
  dateTo: string;
  periodFilter: string;
  sortAsc: boolean;
  periods: ReadonlyArray<{ id: string; label: string | null }>;
  onDateFrom: (v: string) => void;
  onDateTo: (v: string) => void;
  onPeriodFilter: (v: string) => void;
  onToggleSort: () => void;
  onClear: () => void;
}

export function MovementFilters({
  dateFrom,
  dateTo,
  periodFilter,
  sortAsc,
  periods,
  onDateFrom,
  onDateTo,
  onPeriodFilter,
  onToggleSort,
  onClear,
}: MovementFiltersProps) {
  const { t } = useI18n();
  const active = Boolean(dateFrom || dateTo || periodFilter !== 'todos');
  return (
    <div role="group" aria-label={t('upload.ledger.filtersAria')} className="flex flex-wrap items-end gap-3 border-b border-border p-4">
      <Field label={t('upload.filterFrom')} className="w-40">
        <Input type="date" value={dateFrom} onChange={(e) => onDateFrom(e.target.value)} className={INPUT_MOBILE} />
      </Field>
      <Field label={t('upload.filterTo')} className="w-40">
        <Input type="date" value={dateTo} onChange={(e) => onDateTo(e.target.value)} className={INPUT_MOBILE} />
      </Field>
      <Field label={t('upload.period')} className="w-44">
        <Select value={periodFilter} onChange={(e) => onPeriodFilter(e.target.value)} className={INPUT_MOBILE}>
          <option value="todos">{t('common.all')}</option>
          {periods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <button
        type="button"
        onClick={onToggleSort}
        className={btnClass('secondary')}
        title={sortAsc ? t('upload.dateSortAsc') : t('upload.dateSortDesc')}
      >
        <ArrowUpDown aria-hidden className="size-3.5" />
        {sortAsc ? t('upload.dateSortAsc') : t('upload.dateSortDesc')}
      </button>
      {active && (
        <button type="button" onClick={onClear} className={btnClass('ghost')}>
          {t('audit.clearFilters')}
        </button>
      )}
    </div>
  );
}
