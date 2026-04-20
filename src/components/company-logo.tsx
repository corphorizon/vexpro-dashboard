'use client';

import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// CompanyLogo
//
// Consistent rendering of a tenant's brand mark across the dashboard:
//   - If `logoUrl` is present, render the image.
//   - Otherwise, render a solid block (colorPrimary background) with the
//     company's initials — up to two letters, uppercase.
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
              parent.innerHTML = `<span class="${initialsClassName} font-semibold text-white">${escapeHtml(label)}</span>`;
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center shrink-0 text-white font-semibold',
        rounded,
        className ?? 'w-9 h-9',
        initialsClassName,
      )}
      style={{ backgroundColor: fallbackColor }}
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
