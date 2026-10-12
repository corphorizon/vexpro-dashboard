'use client';

import { Save } from 'lucide-react';
import { Field, Select } from '@/components/ui/field';
import { useI18n } from '@/lib/i18n';
import { INPUT_MOBILE, SaveDot, SavedRecentlyBadge, btnClass } from './upload-ui';

// ─────────────────────────────────────────────────────────────────────────────
// Barra inferior de /upload: período + estado del autosave + «Guardar ahora».
//
// POR QUÉ (2026-10-12, migración «Libro mayor»): «Guardar ahora» era
// `bg-emerald-600 text-white` — verde de «ganancia» como color de acción, y
// blanco fijo sobre la marca. Es la acción principal de la pantalla: va como
// EL primario (marca + `text-brand-on-primary`, §5.1, uno por pantalla); los
// «Agregar» de cada pestaña pasaron a secundarios. Los puntos de estado
// (guardando / sin guardar / guardado) usan info / pend / pos, que es
// exactamente lo que significan (§2.1), en vez de sky / amber / emerald.
//
// Sólo presentación: `saveAll`, el debounce del autosave y `dirtySections`
// siguen en page.tsx; acá llegan como props.
//
// DESCARTADO: usar el período de la topbar (§6.2: «nada de un segundo
// selector»). La topbar ya tiene uno (`PeriodContext`), pero /upload tiene su
// propio `selectedPeriod` y cambiarlo dispara la siembra de los buffers y de
// la huella de egresos (reglas §2.4). Atarlo al contexto es un cambio de
// flujo, no de presentación: queda para un cambio propio.
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveBarProps {
  periods: ReadonlyArray<{ id: string; label: string | null; is_closed?: boolean | null }>;
  selectedPeriod: string;
  onPeriodChange: (id: string) => void;
  /** La sección activa se guarda con «Guardar ahora» (no Liquidez/Inversiones). */
  showSave: boolean;
  savingAll: boolean;
  dirty: boolean;
  lastSavedAt: Date | null;
  closed: boolean;
  onSave: () => void;
}

export function SaveBar({
  periods,
  selectedPeriod,
  onPeriodChange,
  showSave,
  savingAll,
  dirty,
  lastSavedAt,
  closed,
  onSave,
}: SaveBarProps) {
  const { t } = useI18n();
  return (
    <div className="sticky bottom-0 z-10 -mx-4 flex flex-col items-stretch justify-between gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:flex-row sm:items-end sm:gap-4 sm:px-6 sm:py-4 lg:-mx-8 lg:px-8">
      <Field label={t('upload.period')} className="sm:w-64">
        <Select value={selectedPeriod} onChange={(e) => onPeriodChange(e.target.value)} className={INPUT_MOBILE}>
          {periods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} {p.is_closed ? t('upload.closedPeriod') : ''}
            </option>
          ))}
        </Select>
      </Field>
      {showSave && (
        <div className="flex items-center justify-end gap-3">
          {savingAll ? (
            <SaveDot tone="info" label={t('common.saving')} title={t('upload.autosaving')} pulse />
          ) : dirty ? (
            <SaveDot tone="pend" label={t('upload.savingIn3s')} title={t('upload.unsavedAutosaveHint')} pulse />
          ) : lastSavedAt ? (
            <SavedRecentlyBadge at={lastSavedAt} />
          ) : null}
          <button
            type="button"
            onClick={onSave}
            disabled={savingAll || closed}
            className={btnClass('primary', 'px-4 font-semibold sm:px-6')}
            title={t('upload.saveNowTitle')}
          >
            <Save aria-hidden className="size-4" />
            {savingAll ? t('common.saving') : t('upload.saveNow')}
          </button>
        </div>
      )}
    </div>
  );
}
