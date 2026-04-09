'use client';

import { useMemo, useState, useEffect } from 'react';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { Check, CheckSquare, Square } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// MovimientosPeriodSelector
//
// Multi-select period picker used ONLY on the Movimientos page. Unlike the
// shared <PeriodSelector/>, clicking a month toggles it in a set, so you can
// pick one or many months without opening a separate dialog. "Seleccionar
// todo" picks every month of the visible year, "Limpiar" resets to the
// latest month (we never leave the page with zero selected — downstream
// summaries need at least one period to render).
//
// All state lives in the shared PeriodContext (mode + selectedPeriodIds) so
// every card and table on the page reacts automatically.
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_LABELS: Record<number, string> = {
  1: 'Ene', 2: 'Feb', 3: 'Mar', 4: 'Abr',
  5: 'May', 6: 'Jun', 7: 'Jul', 8: 'Ago',
  9: 'Sep', 10: 'Oct', 11: 'Nov', 12: 'Dic',
};

export function MovimientosPeriodSelector() {
  const { periods } = useData();
  const { mode, selectedPeriodId, selectedPeriodIds, setSelectedPeriod, setConsolidated } = usePeriod();

  // Available years, sorted ascending.
  const years = useMemo(
    () => [...new Set(periods.map((p) => p.year))].sort(),
    [periods]
  );

  // Which year's months are shown in the selector.
  const [selectedYear, setSelectedYear] = useState<number>(() => {
    const current = periods.find((p) => p.id === selectedPeriodId);
    return current?.year ?? years[years.length - 1] ?? new Date().getFullYear();
  });

  // Keep the year in sync if `periods` loads asynchronously.
  useEffect(() => {
    if (years.length > 0 && !years.includes(selectedYear)) {
      setSelectedYear(years[years.length - 1]);
    }
  }, [years, selectedYear]);

  const monthsForYear = useMemo(
    () => periods.filter((p) => p.year === selectedYear),
    [periods, selectedYear]
  );

  // Canonical selection set, in sorted-by-period order.
  const activeIds = useMemo(() => {
    if (mode === 'consolidated') return new Set(selectedPeriodIds);
    return new Set([selectedPeriodId]);
  }, [mode, selectedPeriodId, selectedPeriodIds]);

  // Apply a new selection to the shared context. Zero → fallback to latest.
  const applySelection = (ids: string[]) => {
    if (ids.length === 0) {
      const fallback = periods[periods.length - 1];
      if (fallback) setSelectedPeriod(fallback.id);
      return;
    }
    if (ids.length === 1) {
      setSelectedPeriod(ids[0]);
      return;
    }
    // Keep chronological order so consolidated label reads naturally.
    const sorted = periods.filter((p) => ids.includes(p.id)).map((p) => p.id);
    const first = periods.find((p) => p.id === sorted[0]);
    const last = periods.find((p) => p.id === sorted[sorted.length - 1]);
    setConsolidated(
      sorted,
      first && last ? `${first.label} — ${last.label}` : undefined
    );
  };

  const toggleMonth = (periodId: string) => {
    const next = new Set(activeIds);
    if (next.has(periodId)) {
      next.delete(periodId);
    } else {
      next.add(periodId);
    }
    applySelection(Array.from(next));
  };

  const selectAllYear = () => {
    const yearIds = monthsForYear.map((p) => p.id);
    // Merge with whatever is already selected from other years.
    const merged = new Set([...activeIds, ...yearIds]);
    applySelection(Array.from(merged));
  };

  const clearAll = () => {
    // Reset to latest period instead of truly empty.
    const latest = periods[periods.length - 1];
    if (latest) setSelectedPeriod(latest.id);
  };

  const selectedCount = activeIds.size;
  const selectionLabel =
    selectedCount === 1
      ? '1 mes seleccionado'
      : `${selectedCount} meses seleccionados`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Year picker */}
        <select
          value={selectedYear}
          onChange={(e) => setSelectedYear(Number(e.target.value))}
          aria-label="Seleccionar año"
          className="px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>

        {/* Month chips */}
        <div className="flex items-center gap-1 flex-wrap">
          {monthsForYear.map((period) => {
            const isActive = activeIds.has(period.id);
            return (
              <button
                key={period.id}
                type="button"
                onClick={() => toggleMonth(period.id)}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                  isActive
                    ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                    : 'border-border bg-card hover:bg-muted'
                }`}
              >
                {isActive && <Check className="w-3 h-3" />}
                {MONTH_LABELS[period.month]}
              </button>
            );
          })}
        </div>

        {/* Bulk actions */}
        <div className="flex items-center gap-1 ml-auto">
          <button
            type="button"
            onClick={selectAllYear}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-border bg-card hover:bg-muted transition-colors"
            title={`Seleccionar todos los meses de ${selectedYear}`}
          >
            <CheckSquare className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Seleccionar todo</span>
          </button>
          <button
            type="button"
            onClick={clearAll}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-border bg-card hover:bg-muted transition-colors"
            title="Volver al mes más reciente"
          >
            <Square className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Limpiar</span>
          </button>
        </div>
      </div>

      {/* Selection summary */}
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{selectionLabel}</span>
        {mode === 'consolidated' && ' · totales consolidados'}
      </p>
    </div>
  );
}
