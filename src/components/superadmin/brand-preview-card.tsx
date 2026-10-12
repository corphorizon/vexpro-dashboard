'use client';

// ─────────────────────────────────────────────────────────────────────────────
// BrandPreviewCard — vista previa EN VIVO de la marca de una entidad: el
// sidebar oscuro expandido, el rail contraído de 64 px (donde vive el
// isotipo) y cómo quedan el primario y el secundario después de la
// corrección de contraste. Todo sale de brand-preview.ts → buildBrandPalette.
//
// Los colores van en `style` porque son DATOS de la empresa (lo que el
// superadmin está eligiendo), no tokens del sistema: es el único lugar del
// panel donde un hex entra a un componente, y es a propósito.
// ─────────────────────────────────────────────────────────────────────────────

import { BarChart3, Home, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import { checkColor, DEFAULT_PRIMARY, DEFAULT_SECONDARY, sidebarPreview } from './brand-preview';
import { initials } from './superadmin-model';

interface Props {
  name: string;
  colorPrimary: string;
  colorSecondary: string;
  logoUrl: string;
  logoWhiteUrl: string;
  logoIconUrl: string;
}

const NAV = [
  { label: 'Inicio', icon: Home },
  { label: 'Balances', icon: Wallet },
  { label: 'Resumen', icon: BarChart3 },
];

export function BrandPreviewCard({ name, colorPrimary, colorSecondary, logoUrl, logoWhiteUrl, logoIconUrl }: Props) {
  const primary = checkColor(colorPrimary, DEFAULT_PRIMARY);
  const secondary = checkColor(colorSecondary, DEFAULT_SECONDARY);
  const s = sidebarPreview(primary.palette, secondary.palette);
  const sidebarLogo = logoWhiteUrl || logoUrl;
  const label = name.trim() || 'Organización';

  const mark = (size: string) =>
    logoIconUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoIconUrl} alt="" className={cn(size, 'shrink-0 rounded-ui-md object-contain')} />
    ) : (
      <span
        aria-hidden="true"
        className={cn(size, 'flex shrink-0 items-center justify-center rounded-ui-md text-[12px] font-semibold')}
        style={{ background: s.activeBg, color: s.activeFg }}
      >
        {initials(label).slice(0, 1)}
      </span>
    );

  return (
    <div className="space-y-3">
      <div
        className="flex gap-3 overflow-hidden rounded-ui-lg border border-border p-3"
        role="img"
        aria-label={`Vista previa del menú oscuro de ${label}`}
        style={{ background: s.bg }}
      >
        {/* Sidebar expandido */}
        <div className="min-w-0 flex-1 space-y-2" style={{ color: s.fg }}>
          <div className="flex items-center gap-2 pb-2" style={{ borderBottom: `1px solid ${s.border}` }}>
            {sidebarLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={sidebarLogo} alt="" className="h-7 max-w-[120px] object-contain" />
            ) : (
              <>
                {mark('size-7')}
                <span className="truncate text-[13px] font-semibold">{label}</span>
              </>
            )}
          </div>
          {NAV.map((n, i) => {
            const Icon = n.icon;
            const active = i === 1;
            return (
              <div
                key={n.label}
                className="relative flex h-8 items-center gap-2 rounded-ui-md px-2.5 text-[12.5px] font-medium"
                style={active ? { background: s.activeBg, color: s.activeFg } : { color: s.muted }}
              >
                {active && (
                  <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full" style={{ background: s.bar }} />
                )}
                <Icon aria-hidden className="size-3.5 shrink-0" />
                {n.label}
              </div>
            );
          })}
        </div>

        {/* Rail contraído: acá sólo entra el isotipo */}
        <div
          className="flex w-16 shrink-0 flex-col items-center gap-2 pl-3"
          style={{ borderLeft: `1px solid ${s.border}` }}
        >
          {mark('size-8')}
          {NAV.map((n, i) => {
            const Icon = n.icon;
            const active = i === 1;
            return (
              <span
                key={n.label}
                className="flex size-8 items-center justify-center rounded-ui-md"
                style={active ? { background: s.activeBg, color: s.activeFg } : { color: s.muted }}
              >
                <Icon aria-hidden className="size-3.5" />
              </span>
            );
          })}
        </div>
      </div>
      <p className="text-[12px] leading-4 text-text-3">
        Aproximación del menú oscuro con estos colores. A la derecha, el menú contraído: ahí sólo entra el isotipo
        {logoIconUrl ? '' : ' (sin isotipo se ve la inicial)'}.
      </p>

      {/* Lo cargado vs. lo que la app usa tras la corrección de contraste */}
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Swatches title="Primario" base={primary.palette.base} light={primary.palette.light} dark={primary.palette.inkDark} />
        <Swatches title="Secundario" base={secondary.palette.base} light={secondary.palette.light} dark={secondary.palette.inkDark} />
      </dl>
    </div>
  );
}

function Swatches({ title, base, light, dark }: { title: string; base: string; light: string; dark: string }) {
  return (
    <div className="rounded-ui-md border border-border p-2.5">
      <dt className="mb-1.5 text-[12px] font-medium text-text-2">{title}</dt>
      <dd className="flex flex-wrap gap-3 text-[12px] text-text-3">
        <Chip hex={base} label="Cargado" />
        <Chip hex={light} label="En claro" changed={light !== base} />
        <Chip hex={dark} label="En oscuro" changed={dark !== base} />
      </dd>
    </div>
  );
}

function Chip({ hex, label, changed }: { hex: string; label: string; changed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={changed ? 'Corregido para cumplir contraste' : undefined}>
      <span aria-hidden className="size-4 shrink-0 rounded-ui-sm border border-border-strong" style={{ background: hex }} />
      <span>
        {label} <span className="font-mono text-text-2">{hex}</span>
        {changed ? ' *' : ''}
      </span>
    </span>
  );
}
