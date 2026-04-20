// ─────────────────────────────────────────────────────────────────────────────
// AuthBrand — Smart Dashboard logo shown on screens that run BEFORE we know
// which tenant the visitor belongs to (login, password recovery, 2FA setup,
// global loading). Tenant-specific branding takes over inside the dashboard
// once the user is authenticated and `company` loads.
//
// Dark/light PNG variants are swapped automatically based on the resolved
// theme. No subtitle by default — screens can pass one explicitly if needed.
// ─────────────────────────────────────────────────────────────────────────────

'use client';

interface AuthBrandProps {
  /** Optional subtitle rendered under the mark. Omitted by default. */
  subtitle?: string;
  /** Tailwind size class override — defaults to h-40 w-40 (160px). */
  sizeClassName?: string;
}

export function AuthBrand({ subtitle, sizeClassName = 'h-40 w-40' }: AuthBrandProps) {
  return (
    <div className="text-center mb-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/smart-dashboard-dark.png"
        alt="Smart Dashboard"
        width={320}
        height={320}
        className={`mx-auto block dark:hidden object-contain ${sizeClassName}`}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/smart-dashboard-white.png"
        alt="Smart Dashboard"
        width={320}
        height={320}
        className={`mx-auto hidden dark:block object-contain ${sizeClassName}`}
      />
      {subtitle && (
        <p className="text-xs text-muted-foreground mt-2 max-w-[280px] mx-auto">
          {subtitle}
        </p>
      )}
    </div>
  );
}
