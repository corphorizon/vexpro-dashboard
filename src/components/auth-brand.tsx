// ─────────────────────────────────────────────────────────────────────────────
// AuthBrand — Smart Dashboard mark shown on screens that run BEFORE we know
// which tenant the visitor belongs to (login, password recovery, 2FA setup,
// global loading). Tenant-specific branding takes over inside the dashboard
// once the user is authenticated and `company` loads.
//
// Uses the official Smart Dashboard logo with dark/light variants swapped
// automatically by the theme. The subtitle below the logo is optional and
// defaults to attributing Horizon Consulting.
// ─────────────────────────────────────────────────────────────────────────────

'use client';

// Intentionally using a native <img> rather than next/image here: the auth
// screens are tiny, the image is static in /public, and we want an instant
// swap between dark/light without next/image's loader round-trip.

export function AuthBrand({
  subtitle = 'The all-in-one financial and operations dashboard',
}: { subtitle?: string }) {
  return (
    <div className="text-center mb-8">
      {/* Dark variant: visible in light mode. White variant: visible in dark mode. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/smart-dashboard-dark.png"
        alt="Smart Dashboard"
        width={180}
        height={180}
        className="mx-auto mb-3 block dark:hidden h-24 w-24 object-contain"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/smart-dashboard-white.png"
        alt="Smart Dashboard"
        width={180}
        height={180}
        className="mx-auto mb-3 hidden dark:block h-24 w-24 object-contain"
      />
      <p className="text-xs text-muted-foreground max-w-[280px] mx-auto">
        {subtitle}
      </p>
    </div>
  );
}
