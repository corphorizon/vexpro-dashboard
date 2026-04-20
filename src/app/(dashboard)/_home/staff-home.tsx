'use client';

import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { getAuditLog } from '@/lib/audit-log';
import { QuickAccess } from './quick-access';
import { Wallet, Users, Activity } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// StaffHome — lightweight home for GERENTE / SUPERVISOR / auditor / hr /
// socio (anything that isn't admin, superadmin, or team-member).
//
// Intentionally minimal: hides full financial breakdown, shows one-line
// headline numbers only when the user's modules include finance or HR.
// ─────────────────────────────────────────────────────────────────────────────

export function StaffHome() {
  const { user } = useAuth();
  const { company, periods, getPeriodSummary, employees } = useData();
  const has = (m: string) => hasModuleAccess(user, m, company?.active_modules);

  const currentPeriod = useMemo(() => {
    if (!periods.length) return null;
    return [...periods].reverse().find((p) => !p.is_closed) ?? periods[periods.length - 1];
  }, [periods]);
  const summary = currentPeriod ? getPeriodSummary(currentPeriod.id) : null;

  const balance = useMemo(() => {
    if (!summary) return 0;
    const ingresos = (summary.operatingIncome
      ? summary.operatingIncome.broker_pnl + summary.operatingIncome.other
      : 0) + summary.propFirmNetIncome;
    return ingresos - summary.totalExpenses;
  }, [summary]);

  const activity = useMemo(() => getAuditLog().slice(0, 5), []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Hola, {user?.name?.split(' ')[0] ?? ''}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {company?.name ? `Panel de ${company.name}` : 'Panel'}
        </p>
      </header>

      {/* Slim KPI row — only what this role has access to. */}
      {(has('movements') || has('balances') || has('hr')) && (
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {has('movements') && (
            <StatCard
              label="Net Deposit · mes"
              value={formatCurrency(summary?.netDeposit ?? 0)}
              icon={Wallet}
              tone={(summary?.netDeposit ?? 0) >= 0 ? 'positive' : 'negative'}
            />
          )}
          {has('balances') && (
            <StatCard
              label="Balance Disponible"
              value={formatCurrency(balance)}
              icon={Wallet}
              tone={balance >= 0 ? 'positive' : 'negative'}
            />
          )}
          {has('hr') && (
            <StatCard
              label="Empleados activos"
              value={employees.filter((e) => e.status === 'active').length.toString()}
              icon={Users}
              tone="info"
            />
          )}
        </section>
      )}

      <section>
        <h2 className="text-base font-semibold mb-3">Actividad reciente</h2>
        {activity.length === 0 ? (
          <Card className="text-sm text-muted-foreground text-center py-6">
            Sin actividad reciente.
          </Card>
        ) : (
          <Card className="p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {activity.map((a) => (
                <li key={a.id} className="p-3 flex items-start gap-3">
                  <Activity className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">{a.user_name}</span>{' '}
                      <span className="text-muted-foreground">{a.action}</span>{' '}
                      <span className="text-xs text-muted-foreground">· {a.module}</span>
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(a.timestamp).toLocaleString('es-ES', {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <QuickAccess />
    </div>
  );
}
