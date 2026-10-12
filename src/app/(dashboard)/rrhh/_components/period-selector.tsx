'use client';

import { useState } from 'react';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { Input } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { Chip } from '@/components/ui/chip';
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
//
// «Libro mayor» (2026-10-12): los presets son un Segmented y los períodos a
// medida, Chips (spec §5.6) — antes los dos en `bg-[var(--color-primary)]
// text-white`, seis rellenos de marca compitiendo con el botón primario.
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex items-center gap-2">
        <label className="text-[12.5px] font-medium text-text-2" htmlFor="hr-month">
          {t('hr.warningMonth')}
        </label>
        {/* Ancho en el contenedor: `cn` no fusiona y un `w-auto` pelearía
            con el `w-full` del control por orden de CSS. */}
        <div className="w-44">
          <Input
            id="hr-month"
            type="month"
            value={month}
            onChange={(e) => {
              // Un mes vacío (el usuario borra el campo) dejaría a todas las
              // pestañas pidiendo `month=`: se ignora y queda el anterior.
              if (e.target.value) setMonth(e.target.value);
            }}
          />
        </div>
      </div>

      {showPresets && (
        <>
          <Segmented
            options={HR_PERIOD_PRESETS.map((p) => ({ value: p, label: filterLabels[p] }))}
            value={preset}
            onChange={(p) => {
              setPreset(p);
              setShowCustom(p === 'custom');
            }}
            aria-label={t('hrv.periodPreset')}
            className="max-w-full flex-wrap"
          />
          {showCustom && preset === 'custom' && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('hr.filterCustom')}>
              {periods.map((p) => (
                <Chip
                  key={p.id}
                  active={customIds.includes(p.id)}
                  onClick={() =>
                    setCustomIds(
                      customIds.includes(p.id)
                        ? customIds.filter((x) => x !== p.id)
                        : [...customIds, p.id],
                    )
                  }
                >
                  {p.label}
                </Chip>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
