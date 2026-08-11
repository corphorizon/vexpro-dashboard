'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { LogoUploader } from '@/components/logo-uploader';
import { MODULES } from '@/lib/modules';
import {
  BUSINESS_MODELS,
  BUSINESS_MODEL_LABELS,
  BUSINESS_MODEL_DESCRIPTIONS,
  blockedModules,
  normalizeBusinessModel,
} from '@/lib/business-model';

// Los módulos salen del registro único (src/lib/modules.ts). Antes era un
// literal más — la cuarta copia de la misma lista — y esas copias se
// desincronizaron entre sí.
export const ALL_MODULES: { key: string; label: string }[] = MODULES.map(
  (m) => ({ key: m.key, label: m.labelEs }),
);

export interface CompanyFormValues {
  name: string;
  logo_url: string;
  /** Second logo slot — the white/monochrome version used on dark
   *  backgrounds (sidebar header, superadmin header, email footer).
   *  When empty we fall back to logo_url. */
  logo_url_white: string;
  /** Isotipo cuadrado (migración 072) — es lo único que entra en el sidebar
   *  contraído, que mide 64px. Vacío = se muestra la inicial del nombre. */
  logo_icon_url: string;
  color_primary: string;
  color_secondary: string;
  active_modules: string[];
  status: 'active' | 'inactive';
  reserve_pct: number;
  currency: string;
  business_model: string;
  slug?: string;   // only present when editing (read-only)
}

interface Props {
  initial: CompanyFormValues;
  submitting: boolean;
  error: string | null;
  onSubmit: (values: CompanyFormValues) => void;
  onCancel: () => void;
  mode: 'create' | 'edit';
  /** Only present in edit mode — enables logo upload to Supabase Storage. */
  companyId?: string;
}

export function CompanyForm({ initial, submitting, error, onSubmit, onCancel, mode, companyId }: Props) {
  const [values, setValues] = useState<CompanyFormValues>(initial);

  // Módulos que el modelo de negocio esconde igual (para 'company': risk,
  // movements, liquidity, investments, commissions e ib_rebates). Dejar que se
  // tilden guardaba módulos que ninguna pantalla muestra pero que SÍ aparecían
  // como elegibles al crear usuarios de esa empresa.
  const blocked = new Set(blockedModules(values.business_model));

  const toggleModule = (key: string) => {
    if (blocked.has(key)) return;
    setValues((v) => ({
      ...v,
      active_modules: v.active_modules.includes(key)
        ? v.active_modules.filter((m) => m !== key)
        : [...v.active_modules, key],
    }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // El filtro va también acá y no solo en el render: cambiar el modelo con
    // módulos ya tildados los dejaría viajar en el payload.
    onSubmit({
      ...values,
      active_modules: values.active_modules.filter((m) => !blocked.has(m)),
    });
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-300 bg-negative/10 dark:border-red-800 text-red-800 dark:text-red-200 p-3 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Nombre de la empresa" required>
          <input
            required
            value={values.name}
            onChange={(e) => setValues({ ...values, name: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            placeholder="Ej: Acme Inc"
          />
        </Field>
        {mode === 'edit' && (
          <Field label="Slug (inmutable)">
            <input
              readOnly
              value={values.slug ?? ''}
              className="w-full px-3 py-2 rounded-lg border border-border bg-muted text-sm text-muted-foreground"
            />
          </Field>
        )}
        <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Slot 1 — logo en color, para fondos claros. */}
          <div>
            <span className="text-xs font-medium mb-1 inline-block">
              Logo — fondos claros
            </span>
            <p className="text-[11px] text-muted-foreground mb-2">
              Se usa en login, reportes, emails y PDFs. PNG/SVG/JPG/WEBP, transparente.
            </p>
            <LogoUploader
              companyId={companyId ?? null}
              companyName={values.name || 'Organización'}
              colorPrimary={values.color_primary}
              logoUrl={values.logo_url || null}
              onChange={(next) => setValues((v) => ({ ...v, logo_url: next ?? '' }))}
              variant="color"
              previewTone="light"
            />
          </div>

          {/* Slot 2 — logo blanco, para fondos oscuros (sidebar, headers). */}
          <div>
            <span className="text-xs font-medium mb-1 inline-block">
              Logo blanco — fondos oscuros
            </span>
            <p className="text-[11px] text-muted-foreground mb-2">
              Versión monocromática blanca para el sidebar. Si no se sube, usa el logo color.
            </p>
            <LogoUploader
              companyId={companyId ?? null}
              companyName={values.name || 'Organización'}
              colorPrimary={values.color_primary}
              logoUrl={values.logo_url_white || null}
              onChange={(next) => setValues((v) => ({ ...v, logo_url_white: next ?? '' }))}
              variant="white"
              previewTone="dark"
              aspect="free"
            />
          </div>

          {/* Slot 3 — isotipo cuadrado, para el sidebar contraído (64px). */}
          <div>
            <span className="text-xs font-medium mb-1 inline-block">
              Isotipo — menú contraído
            </span>
            <p className="text-[11px] text-muted-foreground mb-2">
              Marca cuadrada para el rail de 64px. El recorte se fuerza 1:1. Si no se sube,
              se muestra la inicial del nombre.
            </p>
            <LogoUploader
              companyId={companyId ?? null}
              companyName={values.name || 'Organización'}
              colorPrimary={values.color_primary}
              logoUrl={values.logo_icon_url || null}
              onChange={(next) => setValues((v) => ({ ...v, logo_icon_url: next ?? '' }))}
              variant="icon"
              previewTone="dark"
              aspect="square"
            />
          </div>
        </div>
        <Field label="Moneda">
          <input
            value={values.currency}
            onChange={(e) => setValues({ ...values, currency: e.target.value.toUpperCase() })}
            maxLength={3}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
          />
        </Field>
        <Field label="Color primario">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={values.color_primary}
              onChange={(e) => setValues({ ...values, color_primary: e.target.value })}
              className="w-10 h-10 rounded border border-border cursor-pointer"
            />
            <input
              type="text"
              value={values.color_primary}
              onChange={(e) => setValues({ ...values, color_primary: e.target.value })}
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono"
            />
          </div>
        </Field>
        <Field label="Color secundario">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={values.color_secondary}
              onChange={(e) => setValues({ ...values, color_secondary: e.target.value })}
              className="w-10 h-10 rounded border border-border cursor-pointer"
            />
            <input
              type="text"
              value={values.color_secondary}
              onChange={(e) => setValues({ ...values, color_secondary: e.target.value })}
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono"
            />
          </div>
        </Field>
        <Field label="% Reserva (0.10 = 10%)">
          <input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={values.reserve_pct}
            onChange={(e) => setValues({ ...values, reserve_pct: parseFloat(e.target.value) || 0 })}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
          />
        </Field>
        {/* El modelo decide qué pantallas ve la empresa: un broker opera
            cuentas de clientes y una empresa de servicios factura. Cambiarlo
            no toca ningún dato, solo qué se muestra. */}
        <Field label="Modelo de negocio">
          <select
            value={values.business_model}
            onChange={(e) => setValues({ ...values, business_model: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
          >
            {BUSINESS_MODELS.map((m) => (
              <option key={m} value={m}>{BUSINESS_MODEL_LABELS[m].es}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            {BUSINESS_MODEL_DESCRIPTIONS[normalizeBusinessModel(values.business_model)].es}
          </p>
        </Field>
        <Field label="Estado">
          <select
            value={values.status}
            onChange={(e) => setValues({ ...values, status: e.target.value as 'active' | 'inactive' })}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
          >
            <option value="active">Activa</option>
            <option value="inactive">Inactiva</option>
          </select>
        </Field>
      </div>

      <div>
        <p className="text-sm font-medium mb-2">Módulos activos</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 rounded-lg border border-border bg-card">
          {ALL_MODULES.map((m) => {
            const off = blocked.has(m.key);
            const on = !off && values.active_modules.includes(m.key);
            return (
              <label
                key={m.key}
                title={
                  off
                    ? `No aplica al modelo "${BUSINESS_MODEL_LABELS[normalizeBusinessModel(values.business_model)].es}"`
                    : undefined
                }
                className={`flex items-center gap-2 text-sm select-none ${
                  off ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={off}
                  onChange={() => toggleModule(m.key)}
                  className="rounded border-border"
                />
                <span>{m.label}</span>
              </label>
            );
          })}
        </div>
        {blocked.size > 0 && (
          <p className="text-xs text-muted-foreground mt-2">
            Los módulos en gris no aplican al modelo de negocio elegido y no se guardan.
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {mode === 'create' ? 'Crear entidad' : 'Guardar cambios'}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium mb-1 inline-block">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}
