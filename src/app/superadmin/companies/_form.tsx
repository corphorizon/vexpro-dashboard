'use client';

// ─────────────────────────────────────────────────────────────────────────────
// CompanyForm — alta y edición de una entidad (superadmin).
//
// «Libro mayor» (2026-10-12):
//   · Tres paneles: Datos, MARCA y Módulos. Controles con Field/Input/Select
//     (borde `control-border` 3:1, label atado, hint debajo). Botones con
//     ActionButton: el primario ya no es `bg-[var(--color-primary)] text-white`.
//   · Marca (pedido de Kevin: «cada marca sube su isotipo y sus colores para
//     que quede customizado»): logo, logo blanco, isotipo cuadrado y los dos
//     colores, con una VISTA PREVIA EN VIVO del menú oscuro y del rail
//     contraído (BrandPreviewCard). Los colores muestran lo cargado y lo que
//     la app usa tras la corrección de contraste (buildBrandPalette); un
//     primario o secundario blanco/negro (Exura Prime #ffffff, Exura Liquidez
//     #000000) avisa con el color al que se degrada. Sin isotipo (Vex, AP)
//     avisa que el rail muestra la inicial. Nada de esto bloquea el guardado.
//   · Payload y validación sin cambios: los mismos campos viajan igual.
//     Ojo, alta: POST /api/superadmin/companies no lee logo_url_white ni
//     logo_icon_url, y los subidores necesitan el id — por eso en «create»
//     los logos se suben después, desde Gestionar (lo dice un Notice).
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { LogoUploader } from '@/components/logo-uploader';
import { MODULES } from '@/lib/modules';
import { cn } from '@/lib/utils';
import {
  BUSINESS_MODELS,
  BUSINESS_MODEL_LABELS,
  BUSINESS_MODEL_DESCRIPTIONS,
  blockedModules,
  normalizeBusinessModel,
} from '@/lib/business-model';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { Field, Input, Select } from '@/components/ui/field';
import { ActionButton } from '@/components/ui/action-button';
import { BrandPreviewCard } from '@/components/superadmin/brand-preview-card';
import {
  DEFAULT_PRIMARY,
  DEFAULT_SECONDARY,
  brandWarnings,
  checkColor,
  isValidHex,
  sidebarPreview,
  type BrandWarning,
} from '@/components/superadmin/brand-preview';

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

  const warnings = brandWarnings(values);
  const warn = (field: BrandWarning['field']) => warnings.find((w) => w.field === field)?.text;
  const preview = sidebarPreview(
    checkColor(values.color_primary, DEFAULT_PRIMARY).palette,
    checkColor(values.color_secondary, DEFAULT_SECONDARY).palette,
  );
  const modelLabel = BUSINESS_MODEL_LABELS[normalizeBusinessModel(values.business_model)].es;

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <Notice kind="bad" title={mode === 'create' ? 'No se pudo crear la entidad' : 'No se pudieron guardar los cambios'}>
          {error}
        </Notice>
      )}

      <Panel title="Datos de la entidad">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Nombre de la empresa" required>
            <Input
              value={values.name}
              onChange={(e) => setValues({ ...values, name: e.target.value })}
              placeholder="Ej: Acme Inc"
            />
          </Field>
          {mode === 'edit' && (
            <Field label="Slug" hint="Inmutable: es parte de las URLs y de los registros.">
              <Input readOnly disabled value={values.slug ?? ''} className="font-mono" />
            </Field>
          )}
          <Field label="Moneda" hint="Código ISO de 3 letras (USD, EUR…).">
            <Input
              value={values.currency}
              onChange={(e) => setValues({ ...values, currency: e.target.value.toUpperCase() })}
              maxLength={3}
              className="font-mono uppercase"
            />
          </Field>
          <Field label="% Reserva" hint="Fracción: 0.10 = 10 %.">
            <Input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={values.reserve_pct}
              onChange={(e) => setValues({ ...values, reserve_pct: parseFloat(e.target.value) || 0 })}
              className="num tabular-nums"
            />
          </Field>
          {/* El modelo decide qué pantallas ve la empresa: un broker opera
              cuentas de clientes y una empresa de servicios factura. Cambiarlo
              no toca ningún dato, solo qué se muestra. */}
          <Field
            label="Modelo de negocio"
            hint={BUSINESS_MODEL_DESCRIPTIONS[normalizeBusinessModel(values.business_model)].es}
          >
            <Select
              value={values.business_model}
              onChange={(e) => setValues({ ...values, business_model: e.target.value })}
            >
              {BUSINESS_MODELS.map((m) => (
                <option key={m} value={m}>{BUSINESS_MODEL_LABELS[m].es}</option>
              ))}
            </Select>
          </Field>
          <Field label="Estado" hint="Los usuarios de una entidad inactiva no pueden iniciar sesión.">
            <Select
              value={values.status}
              onChange={(e) => setValues({ ...values, status: e.target.value as 'active' | 'inactive' })}
            >
              <option value="active">Activa</option>
              <option value="inactive">Inactiva</option>
            </Select>
          </Field>
        </div>
      </Panel>

      {/* ── Marca ────────────────────────────────────────────────────────── */}
      <Panel
        title="Marca"
        hint="Logo, versión blanca, isotipo y colores: lo que la empresa ve en el menú, el login, los PDF y los emails."
      >
        <div className="space-y-5">
          {mode === 'create' && (
            <Notice kind="info" title="Los logos se suben después de crear la entidad">
              El alta guarda nombre, colores y módulos. Para subir el logo, la versión blanca y el isotipo, creá la
              entidad y entrá a «Gestionar».
            </Notice>
          )}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {/* Slot 1 — logo en color, para fondos claros. */}
            <BrandSlot
              title="Logo"
              hint="Fondos claros: login, reportes, emails y PDF. PNG/SVG/JPG/WEBP, transparente."
            >
              <LogoUploader
                companyId={companyId ?? null}
                companyName={values.name || 'Organización'}
                colorPrimary={values.color_primary}
                logoUrl={values.logo_url || null}
                onChange={(next) => setValues((v) => ({ ...v, logo_url: next ?? '' }))}
                variant="color"
                previewTone="light"
              />
            </BrandSlot>

            {/* Slot 2 — logo blanco, para fondos oscuros (sidebar, headers). */}
            <BrandSlot
              title="Logo blanco"
              hint="Versión monocromática para el menú oscuro. Si no se sube, se usa el logo color."
              warning={warn('logo_url_white')}
            >
              <LogoUploader
                companyId={companyId ?? null}
                companyName={values.name || 'Organización'}
                colorPrimary={values.color_primary}
                logoUrl={values.logo_url_white || null}
                onChange={(next) => setValues((v) => ({ ...v, logo_url_white: next ?? '' }))}
                variant="white"
                previewTone="dark"
                previewBg={preview.bg}
                previewFg={preview.fg}
                aspect="free"
              />
            </BrandSlot>

            {/* Slot 3 — isotipo cuadrado, para el sidebar contraído (64px). */}
            <BrandSlot
              title="Isotipo cuadrado"
              hint="Lo único que entra en el menú contraído (64 px). El recorte se fuerza 1:1."
              warning={warn('logo_icon_url')}
            >
              <LogoUploader
                companyId={companyId ?? null}
                companyName={values.name || 'Organización'}
                colorPrimary={values.color_primary}
                logoUrl={values.logo_icon_url || null}
                onChange={(next) => setValues((v) => ({ ...v, logo_icon_url: next ?? '' }))}
                variant="icon"
                previewTone="dark"
                previewBg={preview.bg}
                previewFg={preview.fg}
                aspect="square"
              />
            </BrandSlot>
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="space-y-4">
              <ColorField
                label="Color primario"
                hint="Botones, ítem activo del menú y encabezados de los PDF."
                value={values.color_primary}
                onChange={(color_primary) => setValues((v) => ({ ...v, color_primary }))}
                warning={warn('color_primary')}
              />
              <ColorField
                label="Color secundario"
                hint="Acentos: la barra del ítem activo y los detalles de marca."
                value={values.color_secondary}
                onChange={(color_secondary) => setValues((v) => ({ ...v, color_secondary }))}
                warning={warn('color_secondary')}
              />
            </div>
            <div className="min-w-0">
              <p className="mb-2 text-[12.5px] font-medium text-text-2">Vista previa en vivo</p>
              <BrandPreviewCard
                name={values.name}
                colorPrimary={values.color_primary}
                colorSecondary={values.color_secondary}
                logoUrl={values.logo_url}
                logoWhiteUrl={values.logo_url_white}
                logoIconUrl={values.logo_icon_url}
              />
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        title="Módulos activos"
        hint={blocked.size > 0 ? `Los atenuados no aplican al modelo «${modelLabel}» y no se guardan.` : undefined}
      >
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 min-[420px]:grid-cols-2 sm:grid-cols-3">
          {ALL_MODULES.map((m) => {
            const off = blocked.has(m.key);
            const on = !off && values.active_modules.includes(m.key);
            return (
              <label
                key={m.key}
                title={off ? `No aplica al modelo "${modelLabel}"` : undefined}
                className={cn(
                  'flex min-h-8 select-none items-center gap-2 rounded-ui-sm px-1 text-[13px] pointer-coarse:min-h-11',
                  off ? 'cursor-not-allowed text-text-3' : 'cursor-pointer text-foreground hover:bg-surface-hover',
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={off}
                  onChange={() => toggleModule(m.key)}
                  className="size-4 shrink-0 accent-brand-ink"
                />
                <span className={cn(off && 'line-through')}>{m.label}</span>
              </label>
            );
          })}
        </div>
      </Panel>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <ActionButton variant="secondary" onClick={onCancel}>
          Cancelar
        </ActionButton>
        <ActionButton type="submit" variant="primary" loading={submitting}>
          {mode === 'create' ? 'Crear entidad' : 'Guardar cambios'}
        </ActionButton>
      </div>
    </form>
  );
}

function BrandSlot({
  title,
  hint,
  warning,
  children,
}: {
  title: string;
  hint: string;
  warning?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div>
        <p className="text-[13px] font-semibold text-foreground">{title}</p>
        <p className="text-[12px] leading-4 text-text-3">{hint}</p>
      </div>
      {children}
      {warning && (
        <p className="flex items-start gap-1.5 text-[12px] leading-4 text-pend">
          <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>{warning}</span>
        </p>
      )}
    </div>
  );
}

function ColorField({
  label,
  hint,
  value,
  onChange,
  warning,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  warning?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Field label={label} hint={hint}>
        <div className="flex items-center gap-2">
          <Input value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" spellCheck={false} />
          {/* El selector nativo sólo acepta #RRGGBB: con otro valor muestra
              negro, pero el texto (lo que se guarda) no se toca. */}
          <input
            type="color"
            aria-label={`${label}: selector`}
            value={isValidHex(value) && value.trim().length === 7 ? value.trim() : '#000000'}
            onChange={(e) => onChange(e.target.value)}
            className="h-9 w-11 shrink-0 cursor-pointer rounded-ui-md border border-control-border bg-card p-0.5"
          />
        </div>
      </Field>
      {warning && (
        <Notice kind="pend" title="Revisá este color">
          {warning}
        </Notice>
      )}
    </div>
  );
}
