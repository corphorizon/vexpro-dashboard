// ─────────────────────────────────────────────────────────────────────────────
// AuthBrand — neutral platform mark shown on screens that run BEFORE we know
// which tenant the visitor belongs to (login, password recovery, 2FA setup,
// global loading). Tenant-specific branding takes over inside the dashboard
// once the user is authenticated and `company` loads.
//
// Keeps a simple, text-first approach: a colored shield with "H" (Horizon)
// plus "Smart Dashboard · Horizon Consulting" as the line under it. No
// tenant logo or name appears here, which also prevents information leakage
// ("is admin@x.com in tenant Y?").
// ─────────────────────────────────────────────────────────────────────────────

import { ShieldCheck } from 'lucide-react';

export function AuthBrand({
  subtitle = 'Smart Dashboard · Horizon Consulting',
}: { subtitle?: string }) {
  return (
    <div className="text-center mb-8">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-slate-900 text-amber-300 mb-3">
        <ShieldCheck className="w-7 h-7" />
      </div>
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        {subtitle}
      </p>
    </div>
  );
}
