'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import type { RevisionSummary } from '@/components/charts/risk-revisions-chart';
import { ShieldCheck, Users, Clock, AlertTriangle, ArrowRight, FileSearch, Wallet, BarChart3 } from 'lucide-react';

// recharts on-demand (patrón PERF-03).
const RiskRevisionsChart = dynamic(
  () => import('@/components/charts/risk-revisions-chart').then((m) => m.RiskRevisionsChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground">
        Cargando gráfico…
      </div>
    ),
  },
);

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

  // Historial REAL de revisiones Prop Firm — misma fuente que
  // /risk/retiros-propfirm (/api/risk/revisions). Cada payload trae
  // savedAt + verdict; alcanza para la evolución mensual por veredicto.
  const [revisions, setRevisions] = useState<RevisionSummary[] | null>(null);
  useEffect(() => {
    if (user === null || !canAccess) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/risk/revisions');
        const json = await res.json();
        if (cancelled) return;
        if (res.ok && json.success && Array.isArray(json.revisions)) {
          setRevisions(
            json.revisions.map(
              (r: { payload: { savedAt: string; verdict: RevisionSummary['verdict'] } }) => ({
                savedAt: r.payload?.savedAt,
                verdict: r.payload?.verdict ?? null,
              }),
            ),
          );
        } else {
          setRevisions([]);
        }
      } catch {
        if (!cancelled) setRevisions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [user, canAccess]);

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

      {/* Revisiones Prop Firm por mes (datos reales del historial guardado) */}
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-accent/10">
            <BarChart3 className="w-5 h-5 text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold">Revisiones Prop Firm por mes</h2>
            <p className="text-xs text-muted-foreground">Historial guardado, apilado por veredicto</p>
          </div>
          <Link href="/risk/retiros-propfirm" className="text-xs text-muted-foreground hover:text-foreground shrink-0">
            Ver historial →
          </Link>
        </div>
        {revisions === null ? (
          <Skeleton className="h-[260px]" />
        ) : (
          <RiskRevisionsChart revisions={revisions} />
        )}
      </Card>

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
                    className="inline-flex items-center gap-1 text-xs text-primary dark:text-accent hover:underline"
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
      <div className="p-2 rounded-lg bg-muted/70 text-primary dark:text-accent">
        <Icon className="w-4 h-4" />
      </div>
      <span className="text-sm font-medium truncate">{label}</span>
    </Link>
  );
}
