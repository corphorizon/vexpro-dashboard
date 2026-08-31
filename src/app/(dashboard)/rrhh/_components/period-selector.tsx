'use client';

import { useState } from 'react';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { HR_PERIOD_PRESETS, type HrPeriodPreset } from '@/lib/hr/period-filter';
import { useHrPeriod } from './hr-period-context';

// ─────────────────────────────────────────────────────────────────────────────
// EL selector de período del módulo — uno solo, arriba de las pestañas.
//
// Antes había tres controles de tiempo repartidos (los presets de Comercial, el
// <input month> de Net Deposit y el mes corriente hardcodeado de las tarjetas).
// Éste es el único, y lo que elige acá vale para TODAS las pestañas.
//
// El control del mes es un <input type="month"> y no el <select> de períodos
// que tenía Comercial: los períodos contables se crean a mano y puede no haber
// fila para un mes que igual tiene datos del CRM. Con el select, esos meses
// eran directamente inelegibles.
//
// El preset sólo afecta a lo que se mide contra los PERÍODOS CONTABLES (la
// pestaña Comercial). Lo que sale del CRM es por mes y siempre usa el ancla:
// un "trimestre" del rollup del CRM no existe hoy y fingirlo sumando tres meses
// sería inventar un número que nadie cuadró.
// ─────────────────────────────────────────────────────────────────────────────

export function HrPeriodSelector({ showPresets }: { showPresets: boolean }) {
  const { t } = useI18n();
  const { periods } = useData();
  const { month, setMonth, preset, setPreset, customIds, setCustomIds } = useHrPeriod();
  const [showCustom, setShowCustom] = useState(preset === 'custom');

  const filterLabels: Record<HrPeriodPreset, string> = {
    total: t('hr.filterTotal'),
    month: t('hr.filterMonth'),
    quarter: t('hr.filterQuarter'),
    semester: t('hr.filterSemester'),
    annual: t('hr.filterAnnual'),
    custom: t('hr.filterCustom'),
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-2">
        <label className="text-sm text-muted-foreground" htmlFor="hr-month">
          {t('hr.warningMonth')}
        </label>
        <input
          id="hr-month"
          type="month"
          value={month}
          onChange={(e) => {
            // Un mes vacío (el usuario borra el campo) dejaría a todas las
            // pestañas pidiendo `month=`: se ignora y queda el anterior.
            if (e.target.value) setMonth(e.target.value);
          }}
          className="px-3 py-1.5 rounded-lg border border-border bg-card text-base sm:text-sm"
        />
      </div>

      {showPresets && (
        <>
          <span className="hidden sm:inline text-border">|</span>
          {HR_PERIOD_PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => {
                setPreset(p);
                setShowCustom(p === 'custom');
              }}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md border transition-colors',
                preset === p
                  ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                  : 'border-border hover:bg-muted',
              )}
            >
              {filterLabels[p]}
            </button>
          ))}
          {showCustom && preset === 'custom' && (
            <div className="flex flex-wrap gap-1">
              {periods.map((p) => (
                <button
                  key={p.id}
                  onClick={() =>
                    setCustomIds(
                      customIds.includes(p.id)
                        ? customIds.filter((x) => x !== p.id)
                        : [...customIds, p.id],
                    )
                  }
                  className={cn(
                    'px-2 py-1 text-xs rounded-md border transition-colors',
                    customIds.includes(p.id)
                      ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                      : 'border-border hover:bg-muted',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
