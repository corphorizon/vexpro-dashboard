'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { LogoUploader } from '@/components/logo-uploader';

// Modules the sidebar knows about. Kept in sync with
// scripts/db-admin/migrate-vexprofx.mjs CODE_MODULES.
export const ALL_MODULES: { key: string; label: string }[] = [
  { key: 'summary', label: 'Resumen general' },
  { key: 'movements', label: 'Movimientos' },
  { key: 'expenses', label: 'Egresos' },
  { key: 'liquidity', label: 'Liquidez' },
  { key: 'investments', label: 'Inversiones' },
  { key: 'balances', label: 'Balances' },
  { key: 'partners', label: 'Socios' },
  { key: 'upload', label: 'Carga de datos' },
  { key: 'periods', label: 'Períodos' },
  { key: 'hr', label: 'Recursos Humanos' },
  { key: 'commissions', label: 'Comisiones' },
  { key: 'risk', label: 'Risk Management' },
  { key: 'reports', label: 'Reportes' },
  { key: 'users', label: 'Usuarios' },
  { key: 'ib_rebates', label: 'Configuración IBs' },
];

export interface CompanyFormValues {
  name: string;
  logo_url: string;
  /** Second logo slot — the white/monochrome version used on dark
   *  backgrounds (sidebar header, superadmin header, email footer).
   *  When empty we fall back to logo_url. */
  logo_url_white: string;
  color_primary: string;
  color_secondary: string;
  active_modules: string[];
  status: 'active' | 'inactive';
  reserve_pct: number;
  currency: string;
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

  const toggleModule = (key: string) => {
    setValues((v) => ({
      ...v,
      active_modules: v.active_modules.includes(key)
        ? v.active_modules.filter((m) => m !== key)
        : [...v.active_modules, key],
    }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(values);
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800 text-red-800 dark:text-red-200 p-3 text-sm">
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
        <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
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
            const on = values.active_modules.includes(m.key);
            return (
              <label
                key={m.key}
                className="flex items-center gap-2 text-sm cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleModule(m.key)}
                  className="rounded border-border"
                />
                <span>{m.label}</span>
              </label>
            );
          })}
        </div>
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
