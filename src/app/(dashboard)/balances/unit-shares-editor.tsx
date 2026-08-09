'use client';

// ─────────────────────────────────────────────────────────────────────────────
// UnitSharesEditor — qué unidades son dueñas de una ubicación y en qué parte.
//
// Vive suelto porque lo usan las dos puertas de entrada: el alta de una
// ubicación nueva (modal de configuración) y la reclasificación de una que ya
// existe (tarjeta de balances). Duplicarlo sería tener dos formularios que se
// desincronizan.
//
// No bloquea guardar cuando las partes no suman 100%: reasignar de una unidad a
// otra pasa por estados intermedios, y obligar a que cierren en cada paso
// forzaría a borrar todo antes de empezar. Avisa, y el cálculo manda el
// sobrante a "sin unidad".
// ─────────────────────────────────────────────────────────────────────────────

import { AlertTriangle, Plus, Scale, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { sharesTotal, type BusinessUnit, type UnitShare } from '@/lib/cash-locations';

interface Props {
  units: BusinessUnit[];
  value: UnitShare[];
  onChange: (next: UnitShare[]) => void;
}

const INPUT =
  'h-11 sm:h-9 px-3 text-base sm:text-sm rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30';

export function UnitSharesEditor({ units, value, onChange }: Props) {
  const { t } = useI18n();

  const total = sharesTotal(value);
  const offBy100 = value.length > 0 && Math.abs(total - 1) > 0.0001;
  const available = units.filter((u) => !value.some((v) => v.business_unit_id === u.id));

  const addRow = () => {
    const next = available[0];
    if (!next) return;
    onChange([...value, { business_unit_id: next.id, share: value.length === 0 ? 1 : 0 }]);
  };

  const splitEvenly = () => {
    if (value.length === 0) return;
    const share = Math.round((1 / value.length) * 10_000) / 10_000;
    onChange(
      value.map((row, i) => ({
        ...row,
        // El redondeo se acumula en la última: si no, tres unidades dan 99,99%.
        share: i === value.length - 1 ? Math.round((1 - share * (value.length - 1)) * 10_000) / 10_000 : share,
      })),
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{t('cash.ownerUnits')}</span>
        <div className="flex items-center gap-1">
          {value.length > 1 && (
            <button
              type="button"
              onClick={splitEvenly}
              className="inline-flex items-center gap-1 min-h-11 sm:min-h-9 px-2 rounded-lg text-xs text-muted-foreground hover:bg-muted"
            >
              <Scale className="w-3.5 h-3.5" />
              {t('cash.splitEvenly')}
            </button>
          )}
          <button
            type="button"
            onClick={addRow}
            disabled={available.length === 0}
            className="inline-flex items-center gap-1 min-h-11 sm:min-h-9 px-2 rounded-lg text-xs text-accent hover:bg-accent/10 disabled:opacity-40"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('cash.addOwnerUnit')}
          </button>
        </div>
      </div>

      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('cash.noOwnerUnits')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {value.map((row, index) => (
            <div key={row.business_unit_id} className="flex items-center gap-2">
              <select
                value={row.business_unit_id}
                onChange={(e) => {
                  const next = [...value];
                  next[index] = { ...row, business_unit_id: e.target.value };
                  onChange(next);
                }}
                className={`${INPUT} flex-1 min-w-0`}
                aria-label={t('cash.businessUnit')}
              >
                {units
                  .filter((u) => u.id === row.business_unit_id || available.some((a) => a.id === u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
              <div className="flex items-center gap-1 shrink-0">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={Math.round(row.share * 100 * 100) / 100}
                  onChange={(e) => {
                    const pct = Number(e.target.value);
                    const next = [...value];
                    next[index] = {
                      ...row,
                      share: Number.isFinite(pct) ? Math.min(1, Math.max(0, pct / 100)) : 0,
                    };
                    onChange(next);
                  }}
                  className={`${INPUT} w-20 text-right`}
                  aria-label={t('cash.sharePercent')}
                />
                <span className="text-xs text-muted-foreground">%</span>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((_, i) => i !== index))}
                  className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 flex items-center justify-center rounded-lg text-negative hover:bg-negative/10"
                  aria-label={t('cash.removeOwnerUnit')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {offBy100 && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{t('cash.sharesNot100', { total: (total * 100).toFixed(2) })}</span>
        </p>
      )}
    </div>
  );
}
