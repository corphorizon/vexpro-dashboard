'use client';

import { useState, useMemo } from 'react';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { Layers, Lock } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

const MONTH_LABELS: Record<number, string> = {
  1: 'Ene', 2: 'Feb', 3: 'Mar', 4: 'Abr',
  5: 'May', 6: 'Jun', 7: 'Jul', 8: 'Ago',
  9: 'Sep', 10: 'Oct', 11: 'Nov', 12: 'Dic',
};

export function PeriodSelector() {
  const { t } = useI18n();
  const { periods } = useData();
  const { mode, selectedPeriodId, selectedPeriodIds, consolidationLabel, setSelectedPeriod, setConsolidated, setSingleMode } = usePeriod();

  const PRESETS = useMemo(() => [
    { label: 'Todo', ids: periods.map(p => p.id) },
    { label: 'Q4 2025', ids: periods.filter(p => p.year === 2025 && p.month >= 10).map(p => p.id) },
    { label: 'Q1 2026', ids: periods.filter(p => p.year === 2026 && p.month <= 3).map(p => p.id) },
    { label: 'Q2 2026', ids: periods.filter(p => p.year === 2026 && p.month >= 4 && p.month <= 6).map(p => p.id) },
    { label: 'Oct-Dic 2025', ids: periods.filter(p => p.year === 2025).map(p => p.id) },
  ], [periods]);
  const [showPanel, setShowPanel] = useState(false);
  const [customSelection, setCustomSelection] = useState<string[]>([]);

  // Compute available years
  const years = useMemo(() => [...new Set(periods.map(p => p.year))].sort(), [periods]);

  // Track selected year for month buttons
  const [selectedYear, setSelectedYear] = useState(() => {
    const current = periods.find(p => p.id === selectedPeriodId);
    return current?.year || years[years.length - 1];
  });

  const monthsForYear = periods.filter(p => p.year === selectedYear);

  const handleMonthClick = (periodId: string) => {
    setSelectedPeriod(periodId);
  };

  const toggleCustom = (id: string) => {
    setCustomSelection(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  const applyCustom = () => {
    const sorted = periods.filter(p => customSelection.includes(p.id)).map(p => p.id);
    if (sorted.length > 0) {
      const first = periods.find(p => p.id === sorted[0]);
      const last = periods.find(p => p.id === sorted[sorted.length - 1]);
      setConsolidated(sorted, `${first?.label} — ${last?.label}`);
    }
    setShowPanel(false);
  };

  // Find the currently active period id in single mode
  const activePeriodId = mode === 'single' ? selectedPeriodId : null;

  return (
    <div className="relative flex items-center gap-2">
      {/* Year selector */}
      <select
        value={selectedYear}
        onChange={(e) => setSelectedYear(Number(e.target.value))}
        aria-label={t('periods.selectPeriod')}
        className="px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent"
      >
        {years.map((year) => (
          <option key={year} value={year}>
            {year}
          </option>
        ))}
      </select>

      {/* Month buttons */}
      <div className="flex items-center gap-1">
        {monthsForYear.map((period) => {
          const isActive = activePeriodId === period.id;
          return (
            <button
              key={period.id}
              onClick={() => handleMonthClick(period.id)}
              title={period.is_closed ? t('periods.closed') : t('periods.open')}
              className={`relative px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                isActive
                  ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                  : period.is_closed
                    ? 'border-border hover:bg-muted opacity-70'
                    : 'border-border hover:bg-muted'
              }`}
            >
              <span className="flex items-center gap-1">
                {MONTH_LABELS[period.month]}
                {period.is_closed && !isActive && (
                  <Lock className="w-3 h-3" />
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* Consolidated mode indicator */}
      {mode === 'consolidated' && (
        <span className="px-2 py-1 text-xs font-medium bg-[var(--color-primary)]/10 text-[var(--color-primary)] rounded-md">
          {consolidationLabel}
        </span>
      )}

      {/* Consolidated button */}
      <button
        onClick={() => {
          if (showPanel) {
            setShowPanel(false);
          } else {
            setCustomSelection(mode === 'consolidated' ? selectedPeriodIds : []);
            setShowPanel(true);
          }
        }}
        className={`p-2 rounded-lg border transition-colors ${
          mode === 'consolidated'
            ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
            : 'border-border bg-card hover:bg-muted'
        }`}
        title={t('periods.consolidated')}
        aria-label={t('periods.consolidated')}
      >
        <Layers className="w-4 h-4" />
      </button>

      {/* Consolidation panel */}
      {showPanel && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-card border border-border rounded-xl shadow-lg z-50 p-4">
          <h3 className="text-sm font-semibold mb-3">{t('periods.consolidated')}</h3>

          {/* Presets */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {PRESETS.filter(p => p.ids.length > 0).map((preset) => (
              <button
                key={preset.label}
                onClick={() => {
                  setConsolidated(preset.ids, preset.label);
                  setShowPanel(false);
                }}
                className="px-2.5 py-1 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors"
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="border-t border-border pt-3 mb-3">
            <p className="text-xs text-muted-foreground mb-2">{t('periods.selectMonths')}</p>
            <div className="grid grid-cols-3 gap-1.5">
              {periods.map((period) => (
                <button
                  key={period.id}
                  onClick={() => toggleCustom(period.id)}
                  className={`px-2 py-1.5 text-xs rounded-md border transition-colors ${
                    customSelection.includes(period.id)
                      ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                      : 'border-border hover:bg-muted'
                  }`}
                >
                  {period.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={applyCustom}
              disabled={customSelection.length === 0}
              className="flex-1 px-3 py-1.5 text-xs font-medium bg-[var(--color-primary)] text-white rounded-md disabled:opacity-50"
            >
              {t('periods.apply')} ({customSelection.length})
            </button>
            {mode === 'consolidated' && (
              <button
                onClick={() => { setSingleMode(); setShowPanel(false); }}
                className="px-3 py-1.5 text-xs font-medium border border-border rounded-md hover:bg-muted"
              >
                {t('periods.clear')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
