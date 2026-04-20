'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import {
  BarChart3, ArrowLeftRight, Receipt, Droplets, TrendingUp,
  Wallet, Briefcase, Upload, CalendarDays, Users, Calculator,
  FileSearch, LayoutDashboard,
} from 'lucide-react';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';

// ─────────────────────────────────────────────────────────────────────────────
// QuickAccess — grid of module shortcuts, filtered to what the user can see
// and what the tenant has enabled. Shared by every role's home view.
// ─────────────────────────────────────────────────────────────────────────────

type Entry = {
  href: string;
  label: string;
  module: string;
  Icon: React.ComponentType<{ className?: string }>;
  color: string; // tailwind fg tone
};

const ENTRIES: Entry[] = [
  { href: '/resumen-general', label: 'Resumen General', module: 'summary', Icon: BarChart3, color: 'text-blue-600' },
  { href: '/movimientos', label: 'Movimientos', module: 'movements', Icon: ArrowLeftRight, color: 'text-indigo-600' },
  { href: '/egresos', label: 'Egresos', module: 'expenses', Icon: Receipt, color: 'text-amber-600' },
  { href: '/liquidez', label: 'Liquidez', module: 'liquidity', Icon: Droplets, color: 'text-cyan-600' },
  { href: '/inversiones', label: 'Inversiones', module: 'investments', Icon: TrendingUp, color: 'text-emerald-600' },
  { href: '/balances', label: 'Balances', module: 'balances', Icon: Wallet, color: 'text-sky-600' },
  { href: '/socios', label: 'Socios', module: 'partners', Icon: Briefcase, color: 'text-violet-600' },
  { href: '/upload', label: 'Carga de datos', module: 'upload', Icon: Upload, color: 'text-fuchsia-600' },
  { href: '/periodos', label: 'Períodos', module: 'periods', Icon: CalendarDays, color: 'text-pink-600' },
  { href: '/rrhh', label: 'Recursos Humanos', module: 'hr', Icon: Users, color: 'text-rose-600' },
  { href: '/rrhh/dashboard', label: 'Dashboard RRHH', module: 'hr', Icon: LayoutDashboard, color: 'text-rose-500' },
  { href: '/comisiones', label: 'Comisiones', module: 'commissions', Icon: Calculator, color: 'text-orange-600' },
  { href: '/risk/retiros-propfirm', label: 'Risk · Prop Firm', module: 'risk', Icon: FileSearch, color: 'text-teal-600' },
  { href: '/risk/retiros-wallet', label: 'Risk · Wallet', module: 'risk', Icon: Wallet, color: 'text-teal-600' },
  { href: '/usuarios', label: 'Usuarios', module: 'users', Icon: Users, color: 'text-slate-600' },
  // Auditoría removed from tenant quick-access — lives in /superadmin/companies/[id] now.
];

export function QuickAccess({ heading = 'Accesos rápidos' }: { heading?: string }) {
  const { user } = useAuth();
  const { company } = useData();

  const visible = useMemo(() => {
    return ENTRIES.filter((e) => hasModuleAccess(user, e.module, company?.active_modules));
  }, [user, company?.active_modules]);

  if (visible.length === 0) return null;

  return (
    <section>
      <h2 className="text-base font-semibold mb-3">{heading}</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {visible.map((e) => (
          <Link
            key={e.href}
            href={e.href}
            className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-muted transition-colors"
          >
            <div className={`p-2 rounded-lg bg-muted/70 ${e.color}`}>
              <e.Icon className="w-4 h-4" />
            </div>
            <span className="text-sm font-medium truncate">{e.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
