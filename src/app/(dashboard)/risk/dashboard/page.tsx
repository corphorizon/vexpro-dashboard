'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import type { RevisionSummary } from '@/components/charts/risk-revisions-chart';
import { ShieldCheck, FileSearch, BarChart3 } from 'lucide-react';

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
// Limpieza 2026-08-03 (decisión Kevin): se removieron los KPIs hard-coded a
// cero, las listas siempre-vacías y los tiles placeholder que esperaban un
// CRM aún no conectado — la página muestra SOLO datos reales (historial de
// revisiones Prop Firm). Cuando se conecte el CRM, los endpoints previstos
// eran: /api/crm/users/count, /api/crm/withdrawal-requests?status=Requested,
// /api/crm/propfirm-withdrawals?status=Requested,
// /api/crm/suspicious-activity?resolved=false (ver git history para el shell).
// ─────────────────────────────────────────────────────────────────────────────

export default function RiskDashboardPage() {
  const { user } = useAuth();
  const canAccess = useModuleAccess('risk');

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

      {/* Quick access */}
      <section>
        <h2 className="text-base font-semibold mb-3">Accesos rápidos</h2>
        {/* Solo accesos con destino real (decisión Kevin 2026-08-03): los
            tiles "Usuarios"/"Actividad Sospechosa" y las listas de solicitudes
            eran placeholders del CRM aún no conectado. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <QuickTile href="/risk/retiros-propfirm" label="Retiros Prop Firm" Icon={FileSearch} />
        </div>
      </section>
    </div>
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
