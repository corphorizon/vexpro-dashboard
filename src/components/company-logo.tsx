'use client';

import { cn } from '@/lib/utils';
import { hexToRgb } from '@/lib/brand';
import { readableTextOn, rgbToHex } from '@/lib/brand-color';

// ─────────────────────────────────────────────────────────────────────────────
// CompanyLogo
//
// Consistent rendering of a tenant's brand mark across the dashboard:
//   - If `logoUrl` is present, render the image.
//   - Otherwise, render a solid block (colorPrimary background) with the
//     company's initials — up to two letters, uppercase.
//
// Colores («Libro mayor», barrido final 2026-10-12): las iniciales iban en
// `text-white` fijo, que sobre una marca pastel (un amarillo, un celeste)
// queda ilegible. Ahora el texto es el blanco o negro que más contrasta con
// ESE color (`readableTextOn`, la misma regla que `--brand-on-primary`). No
// se usa `text-brand-on-primary`: este logo muestra la marca de CUALQUIER
// empresa (superadmin), no la activa. La placa blanca detrás del logo es
// legítima (los logos a color se diseñan sobre blanco): está en la
// allowlist de design-guard.ts.
//
// Tenant logos are arbitrary URLs, so we use a plain <img> (no Next.js
// optimizer) to avoid forcing every tenant domain into the image allow-list.
// ─────────────────────────────────────────────────────────────────────────────

interface CompanyLogoProps {
  name: string;
  logoUrl?: string | null;
  colorPrimary?: string | null;
  /** Tailwind size class pair. Override for specific placements. */
  className?: string;
  /** Tailwind rounding override. Default `rounded-md`. */
  rounded?: string;
  /** Font size for initials fallback. */
  initialsClassName?: string;
}

export function CompanyLogo({
  name,
  logoUrl,
  colorPrimary,
  className,
  rounded = 'rounded-md',
  initialsClassName = 'text-xs',
}: CompanyLogoProps) {
  const fallbackColor = colorPrimary || '#1E3A5F';
  const initialsColor = rgbToHex(readableTextOn(hexToRgb(fallbackColor)));
  const label = initials(name);

  if (logoUrl) {
    return (
      <div
        className={cn(
          'flex items-center justify-center shrink-0 overflow-hidden bg-white',
          rounded,
          className ?? 'w-9 h-9',
        )}
      >
        {/* Using native img on purpose — tenant logos come from arbitrary URLs. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoUrl}
          alt={name}
          className="w-full h-full object-contain"
          onError={(e) => {
            // If the URL 404s or is blocked, fall back to initials at render
            // time by swapping the node. Rare path — logs but never throws.
            const el = e.currentTarget;
            el.style.display = 'none';
            const parent = el.parentElement;
            if (parent) {
              parent.style.backgroundColor = fallbackColor;
              parent.style.color = initialsColor;
              parent.innerHTML = `<span class="${initialsClassName} font-semibold">${escapeHtml(label)}</span>`;
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center shrink-0 font-semibold',
        rounded,
        className ?? 'w-9 h-9',
        initialsClassName,
      )}
      style={{ backgroundColor: fallbackColor, color: initialsColor }}
      aria-label={name}
    >
      {label}
    </div>
  );
}

function initials(name: string): string {
  return (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));
}
