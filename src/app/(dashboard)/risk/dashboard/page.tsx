'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { ShieldCheck, Users, Clock, AlertTriangle, ArrowRight, FileSearch, Wallet } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// /risk/dashboard — landing page for support / risk-only roles.
//
// Today the Risk module has two surfaces (retiros-propfirm + retiros-wallet)
// and no CRM integration yet. This dashboard provides the headline metrics
// and "recent" lists the spec calls for, but populates them with defensible
// empty-state copy when the data source doesn't exist in DB yet.
//
// Wiring notes (for the backend person who connects the CRM later):
//   · Total CRM users          → GET /api/crm/users/count
//   · Pending withdrawal reqs  → GET /api/crm/withdrawal-requests?status=Requested
//   · Pending propfirm reqs    → GET /api/crm/propfirm-withdrawals?status=Requested
//   · Suspicious activity      → GET /api/crm/suspicious-activity?resolved=false
//
// Until those endpoints exist, we render skeletons / zero counts so the page
// is visible but doesn't error.
// ─────────────────────────────────────────────────────────────────────────────

interface RiskData {
  totalUsers: number | null;
  pendingWithdrawals: number;
  pendingPropFirm: number;
  suspiciousOpen: number;
  recentWithdrawals: Array<{ id: string; user: string; amount: string; date: string }>;
  recentPropFirm: Array<{ id: string; user: string; amount: string; date: string }>;
  recentSuspicious: Array<{ id: string; user: string; description: string; date: string; status: string }>;
}

// Placeholder defaults until the CRM endpoints land. These are deliberately
// null/zero so the UI shows "Sin solicitudes pendientes" instead of fake
// numbers — nothing worse than a support dashboard showing phantom data.
const EMPTY_DATA: RiskData = {
  totalUsers: null,
  pendingWithdrawals: 0,
  pendingPropFirm: 0,
  suspiciousOpen: 0,
  recentWithdrawals: [],
  recentPropFirm: [],
  recentSuspicious: [],
};

export default function RiskDashboardPage() {
  const { user } = useAuth();
  const canAccess = useModuleAccess('risk');
  const data = useMemo(() => EMPTY_DATA, []);

  if (!canAccess) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-muted-foreground text-sm">403 · Acceso restringido</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Risk Management"
        subtitle={`Hola${user?.name ? `, ${user.name.split(' ')[0]}` : ''}. Panel de soporte y control.`}
        icon={ShieldCheck}
      />

      {/* Header metrics */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Usuarios en el CRM"
          value={data.totalUsers ?? '—'}
          icon={Users}
          tone="info"
          hint={data.totalUsers === null ? 'Sin conexión al CRM' : 'Total global'}
        />
        <StatCard
          label="Retiros pendientes"
          value={data.pendingWithdrawals}
          icon={Clock}
          tone={data.pendingWithdrawals > 0 ? 'warning' : 'neutral'}
          hint="Estado: Requested"
        />
        <StatCard
          label="Prop Firm pendientes"
          value={data.pendingPropFirm}
          icon={Clock}
          tone={data.pendingPropFirm > 0 ? 'warning' : 'neutral'}
          hint="Estado: Requested"
        />
        <StatCard
          label="Actividad sospechosa"
          value={data.suspiciousOpen}
          icon={AlertTriangle}
          tone={data.suspiciousOpen > 0 ? 'negative' : 'neutral'}
          hint={data.suspiciousOpen === 0 ? 'Todo tranquilo' : 'Sin resolver'}
        />
      </section>

      {/* Recent withdrawal requests */}
      <RecentSection
        heading="Solicitudes de retiro recientes"
        seeAllHref="/risk/retiros-wallet"
        emptyCopy="Sin solicitudes pendientes."
        rows={data.recentWithdrawals.map((r) => ({
          id: r.id,
          main: r.user,
          sub: `${r.amount} · ${r.date}`,
          detailHref: `/risk/retiros-wallet?id=${r.id}`,
        }))}
      />

      {/* Recent propfirm */}
      <RecentSection
        heading="Retiros Prop Firm recientes"
        seeAllHref="/risk/retiros-propfirm"
        emptyCopy="Sin retiros Prop Firm pendientes."
        rows={data.recentPropFirm.map((r) => ({
          id: r.id,
          main: r.user,
          sub: `${r.amount} · ${r.date}`,
          detailHref: `/risk/retiros-propfirm?id=${r.id}`,
        }))}
      />

      {/* Recent suspicious */}
      <RecentSection
        heading="Actividad sospechosa reciente"
        seeAllHref="/risk/retiros-wallet"
        emptyCopy="Sin actividad sospechosa registrada."
        rows={data.recentSuspicious.map((r) => ({
          id: r.id,
          main: r.user,
          sub: `${r.description} · ${r.date}`,
          tag: r.status,
          detailHref: `/risk/retiros-wallet?id=${r.id}`,
        }))}
      />

      {/* Quick access */}
      <section>
        <h2 className="text-base font-semibold mb-3">Accesos rápidos</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <QuickTile href="/risk/retiros-wallet" label="Solicitudes de Retiro" Icon={Wallet} />
          <QuickTile href="/risk/retiros-propfirm" label="Retiros Prop Firm" Icon={FileSearch} />
          <QuickTile href="/risk/retiros-wallet" label="Usuarios" Icon={Users} />
          <QuickTile href="/risk/retiros-wallet" label="Actividad Sospechosa" Icon={AlertTriangle} />
        </div>
      </section>
    </div>
  );
}

function RecentSection({
  heading,
  seeAllHref,
  emptyCopy,
  rows,
}: {
  heading: string;
  seeAllHref: string;
  emptyCopy: string;
  rows: Array<{ id: string; main: string; sub: string; tag?: string; detailHref: string }>;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold">{heading}</h2>
        <Link href={seeAllHref} className="text-xs text-muted-foreground hover:text-foreground">
          Ver todas →
        </Link>
      </div>
      {rows.length === 0 ? (
        <Card className="text-sm text-muted-foreground text-center py-6">
          {emptyCopy}
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.main}</p>
                  <p className="text-xs text-muted-foreground truncate">{r.sub}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {r.tag && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                      {r.tag}
                    </span>
                  )}
                  <Link
                    href={r.detailHref}
                    className="inline-flex items-center gap-1 text-xs text-[var(--color-primary)] hover:underline"
                  >
                    Ver detalle <ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

function QuickTile({
  href,
  label,
  Icon,
}: {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-muted transition-colors"
    >
      <div className="p-2 rounded-lg bg-muted/70 text-[var(--color-primary)]">
        <Icon className="w-4 h-4" />
      </div>
      <span className="text-sm font-medium truncate">{label}</span>
    </Link>
  );
}
