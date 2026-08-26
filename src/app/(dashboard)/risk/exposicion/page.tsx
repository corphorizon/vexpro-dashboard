'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /risk/exposicion — el riesgo vivo del bróker.
//
// Cuatro preguntas, en este orden:
//   1. ¿cuánto se está ganando o perdiendo AHORA, por tipo de cuenta?
//   2. ¿hay alguna cuenta a punto de liquidarse? (lo urgente)
//   3. ¿en qué está concentrada la exposición? (lo que puede doler mañana)
//   4. ¿cómo se reparte por familia y símbolo? (el detalle)
//
// ── LO QUE ESTA PANTALLA NO HACE, A PROPÓSITO ──────────────────────────────
// No muestra un total de dinero sumando todo. Las cuentas Cent están EN
// CENTAVOS y las PropFirm llevan capital virtual de desafío: sumar sus
// flotantes daría -676.789 "dólares" que no existen. Cada importe va con su
// unidad al lado.
//
// ── DOS CORTES QUE NO TIENEN POR QUÉ CUADRAR ───────────────────────────────
// El PNL cuenta SÓLO cuentas que están en el CRM; la exposición cuenta todas.
// Hay ~1.140 cuentas reales en MetaTrader que no llegaron nunca al CRM y son de
// prueba. Que los dos bloques no sumen igual es correcto, y por eso el número
// de excluidas se muestra en vez de callarse.
//
// El dato tiene hasta 15 minutos: se dice arriba, con la hora exacta. Una
// pantalla de riesgo que no diga de cuándo es su dato invita a decidir sobre
// algo viejo creyendo que es de ahora.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, AlertTriangle, Clock, Layers, RefreshCw, CalendarDays } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToasts } from '@/components/ui/toast';
import { useTablePage, TableSearch, TablePager } from '@/components/ui/table-toolbar';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { cn, formatNumber } from '@/lib/utils';
import { formatDateTime } from '@/lib/dates';
import type { RiskSnapshot, MarginRow, ExposureRow, PnlRow } from '@/lib/mt5-sync/risk-query';

interface PnlBlock {
  snapshotAt: string | null;
  rows: PnlRow[];
  range: { from: string; to: string };
  history: PnlRow[];
}
type Payload = RiskSnapshot & { pnl?: PnlBlock };

/**
 * Un importe SIEMPRE con su unidad. Nunca se pinta un número de dinero solo:
 * en centavos y en dólares se ven igual y no lo son.
 */
function Money({ value, unit }: { value: number | null; unit: string }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const cents = unit === 'cents';
  return (
    <span className="tabular-nums">
      <span className={cn(value < 0 ? 'text-negative' : value > 0 ? 'text-positive' : '')}>
        {formatNumber(value)}
      </span>
      <span className="ml-1 text-xs text-muted-foreground">{cents ? '¢' : 'USD'}</span>
    </span>
  );
}

/** La categoría dice la unidad: sólo CENT está denominada en centavos. */
const unitOfCategory = (c: string) => (c === 'CENT' ? 'cents' : 'account_currency');

export default function ExposicionPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const router = useRouter();
  const hasRiskAccess = useModuleAccess('risk');
  const { toast, ToastHost } = useToasts();

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => {
    if (user === null) return;
    if (!hasRiskAccess) router.replace('/');
  }, [user, hasRiskAccess, router]);
  const accessDenied = user !== null && !hasRiskAccess;

  const load = useCallback(
    async (silent = false, r?: { from: string; to: string }) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const qs = r ? `?from=${r.from}&to=${r.to}` : '';
        const res = await apiFetch(`/api/admin/risk-exposure${qs}`);
        const body = await res.json();
        if (!res.ok || body?.success === false) throw new Error(body?.error ?? t('exposure.loadError'));
        setData(body);
        if (body?.pnl?.range) setRange(body.pnl.range);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('exposure.loadError'));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!accessDenied) void load();
  }, [accessDenied, load]);

  const enRiesgo = [...(data?.critical ?? []), ...(data?.watch ?? [])];

  // Los hooks van SIEMPRE antes de cualquier return condicional: llamarlos
  // después haría que React vea distinto número de hooks entre renders.
  const margen = useTablePage<MarginRow>(
    enRiesgo,
    (m) => `${m.login} ${m.email ?? ''} ${m.family} ${m.group_name ?? ''}`,
  );
  const detalle = useTablePage<ExposureRow>(
    data?.exposure ?? [],
    (r) => `${r.symbol} ${r.family}`,
  );
  const historia = useTablePage<PnlRow>(
    data?.pnl?.history ?? [],
    (r) => `${r.utc_day} ${r.category}`,
  );

  const pagerLabels = {
    prev: t('table.prev'),
    next: t('table.next'),
    range: t('table.range'),
    filtered: t('table.filtered'),
  };

  if (accessDenied) return null;

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-64" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (!data || !data.snapshotAt) {
    return (
      <div className="space-y-6">
        {ToastHost}
        <PageHeader icon={Activity} title={t('exposure.title')} subtitle={t('exposure.subtitle')} />
        <EmptyState
          icon={Activity}
          title={t('exposure.noSnapshot')}
          description={t('exposure.noSnapshotHint')}
        />
      </div>
    );
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const pnlRows = data.pnl?.rows ?? [];

  return (
    <div className="space-y-6">
      {ToastHost}

      <PageHeader
        icon={Activity}
        title={t('exposure.title')}
        subtitle={t('exposure.subtitle')}
        actions={
          <Button variant="secondary" size="sm" loading={refreshing} onClick={() => void load(true, range ?? undefined)}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            {t('exposure.refresh')}
          </Button>
        }
      />

      {/* Una pantalla de riesgo tiene que decir de cuándo es su dato. */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted px-4 py-3 text-sm">
        <Clock className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground">
          {t('exposure.asOf', { when: formatDateTime(data.snapshotAt) })} · {t('exposure.moneyNotice')}
        </p>
      </div>

      {/* ── 1. PNL en vivo por categoría ─────────────────────────────────── */}
      <Card>
        <CardTitle>{t('exposure.pnlTitle')}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('exposure.pnlHint')}</p>

        {pnlRows.length === 0 ? (
          <div className="mt-4">
            <EmptyState compact title={t('exposure.pnlEmpty')} description={t('exposure.pnlEmptyHint')} />
          </div>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {pnlRows.map((r) => {
              const unit = unitOfCategory(r.category);
              return (
                <div key={r.category} className="rounded-lg border border-border p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{r.category}</span>
                    <Badge variant="neutral">{unit === 'cents' ? '¢' : 'USD'}</Badge>
                  </div>

                  <dl className="mt-3 space-y-3">
                    <div>
                      <dt className="text-xs text-muted-foreground">{t('exposure.pnlOpen')}</dt>
                      <dd className="text-lg font-semibold">
                        <Money value={r.open_pnl} unit={unit} />
                      </dd>
                      <dd className="text-xs text-muted-foreground">
                        {t('exposure.pnlPositions', {
                          positions: formatNumber(r.open_positions),
                          accounts: formatNumber(r.open_accounts),
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">{t('exposure.pnlClosed')}</dt>
                      <dd className="text-lg font-semibold">
                        <Money value={r.closed_pnl} unit={unit} />
                      </dd>
                      <dd className="text-xs text-muted-foreground">
                        {t('exposure.pnlDeals', {
                          deals: formatNumber(r.closed_deals),
                          accounts: formatNumber(r.closed_accounts),
                        })}
                      </dd>
                    </div>
                  </dl>

                  {/* Una exclusión silenciosa es indistinguible de un error de
                      cruce, así que se dice cuántas quedaron fuera. */}
                  {r.accounts_outside_crm > 0 && (
                    <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
                      {t('exposure.pnlOutside', { n: String(r.accounts_outside_crm) })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={Layers}
          label={t('exposure.kpiPositions')}
          value={formatNumber(data.totalPositions)}
          hint={t('exposure.kpiPositionsHint')}
          emphasis
        />
        <StatCard
          icon={AlertTriangle}
          tone={data.critical.length > 0 ? 'negative' : 'neutral'}
          label={t('exposure.kpiCritical')}
          value={String(data.critical.length)}
          hint={t('exposure.kpiCriticalHint')}
        />
        <StatCard
          icon={Activity}
          tone={data.watch.length > 0 ? 'warning' : 'neutral'}
          label={t('exposure.kpiWatch')}
          value={String(data.watch.length)}
          hint={t('exposure.kpiWatchHint', { total: String(data.accountsWithMargin) })}
        />
      </div>

      {/* ── 2. Lo urgente: cuentas que pueden liquidarse ─────────────────── */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 pt-4">
          <CardTitle>{t('exposure.marginTitle')}</CardTitle>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('exposure.marginHint')}</p>
          <div className="mb-3">
            <TableSearch
              value={margen.query}
              onChange={margen.setQuery}
              placeholder={t('exposure.searchMargin')}
            />
          </div>
        </div>
        <DataTable<MarginRow>
          zebra
          density="compact"
          data={margen.pageRows}
          empty={
            <EmptyState
              compact
              title={t('exposure.marginEmpty')}
              description={t('exposure.marginEmptyHint', { total: String(data.accountsWithMargin) })}
            />
          }
          columns={[
            {
              header: t('exposure.colLevel'),
              align: 'right',
              accessor: (m) => (
                <Badge variant={(m.margin_level ?? 0) < 100 ? 'danger' : 'warning'}>
                  {formatNumber(m.margin_level ?? 0)}%
                </Badge>
              ),
            },
            { header: t('exposure.colAccount'), accessor: (m) => String(m.login) },
            {
              header: t('exposure.colClient'),
              accessor: (m) => <span className="text-xs">{m.email ?? t('exposure.noEmail')}</span>,
            },
            {
              header: t('exposure.colFamily'),
              accessor: (m) => (
                <span className="text-xs">
                  {m.family}
                  {m.is_virtual && (
                    <span className="ml-1 text-muted-foreground">{t('exposure.virtual')}</span>
                  )}
                </span>
              ),
            },
            {
              header: t('exposure.colEquity'),
              align: 'right',
              accessor: (m) => <Money value={m.equity} unit={m.unit} />,
            },
            {
              header: t('exposure.colMargin'),
              align: 'right',
              accessor: (m) => <Money value={m.margin} unit={m.unit} />,
            },
            {
              header: t('exposure.colFloating'),
              align: 'right',
              accessor: (m) => <Money value={m.floating} unit={m.unit} />,
            },
          ]}
        />
        <TablePager
          page={margen.page}
          pageCount={margen.pageCount}
          shown={margen.pageRows.length}
          total={margen.total}
          filteredTotal={margen.filtered.length}
          onPage={margen.setPage}
          labels={pagerLabels}
        />
      </Card>

      {/* ── 3. Concentración ─────────────────────────────────────────────── */}
      <Card>
        <CardTitle>{t('exposure.concentrationTitle')}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('exposure.concentrationHint')}</p>
        <ul className="mt-4 space-y-3">
          {data.concentration.map((c) => (
            <li key={c.symbol}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{c.symbol}</span>
                <span className="text-sm text-muted-foreground">
                  {t('exposure.concentrationRow', {
                    positions: formatNumber(c.positions),
                    share: String(c.share),
                    lots: formatNumber(c.netLots),
                  })}
                </span>
              </div>
              {/* La barra usa el PESO en posiciones, que sí es comparable. */}
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.min(100, c.share)}%` }}
                />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {c.byFamily.map((f) => (
                  <span key={f.family}>
                    {f.family}
                    {f.isVirtual ? ` ${t('exposure.virtual')}` : ''}:{' '}
                    <Money value={f.floating} unit={f.unit} />
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {/* ── 4. El detalle ────────────────────────────────────────────────── */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 pt-4">
          <CardTitle>{t('exposure.detailTitle')}</CardTitle>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('exposure.detailHint')}</p>
          <div className="mb-3">
            <TableSearch
              value={detalle.query}
              onChange={detalle.setQuery}
              placeholder={t('exposure.searchDetail')}
            />
          </div>
        </div>
        <DataTable<ExposureRow>
          stickyHeader
          zebra
          density="compact"
          data={detalle.pageRows}
          empty={<EmptyState compact title={t('exposure.detailEmpty')} />}
          columns={[
            {
              header: t('exposure.colFamily'),
              accessor: (r) => (
                <span className="text-xs">
                  {r.family}
                  {r.is_virtual && (
                    <span className="ml-1 text-muted-foreground">{t('exposure.virtual')}</span>
                  )}
                </span>
              ),
            },
            { header: t('exposure.colSymbol'), accessor: (r) => r.symbol },
            {
              header: t('exposure.colPositions'),
              align: 'right',
              accessor: (r) => <span className="tabular-nums">{formatNumber(r.positions)}</span>,
            },
            {
              header: t('exposure.colNetLots'),
              align: 'right',
              accessor: (r) => (
                <span
                  className={cn(
                    'tabular-nums',
                    (r.net_lots ?? 0) > 0 ? 'text-positive' : (r.net_lots ?? 0) < 0 ? 'text-negative' : '',
                  )}
                >
                  {formatNumber(r.net_lots ?? 0)}
                </span>
              ),
            },
            {
              header: t('exposure.colFloating'),
              align: 'right',
              accessor: (r) => <Money value={r.floating} unit={r.unit} />,
            },
            {
              header: t('exposure.colSwap'),
              align: 'right',
              accessor: (r) => <Money value={r.storage} unit={r.unit} />,
            },
          ]}
        />
        <TablePager
          page={detalle.page}
          pageCount={detalle.pageCount}
          shown={detalle.pageRows.length}
          total={detalle.total}
          filteredTotal={detalle.filtered.length}
          onPage={detalle.setPage}
          labels={pagerLabels}
        />
      </Card>

      {/* ── 5. Histórico de cierres ──────────────────────────────────────── */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 pt-4">
          <CardTitle>{t('exposure.historyTitle')}</CardTitle>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('exposure.historyHint')}</p>

          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="text-xs text-muted-foreground">
              <span className="mb-1 block">{t('exposure.historyFrom')}</span>
              <input
                type="date"
                value={range?.from ?? ''}
                max={range?.to ?? hoy}
                onChange={(e) => {
                  const next = { from: e.target.value, to: range?.to ?? hoy };
                  setRange(next);
                  if (e.target.value) void load(true, next);
                }}
                className="rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              <span className="mb-1 block">{t('exposure.historyTo')}</span>
              <input
                type="date"
                value={range?.to ?? ''}
                min={range?.from ?? ''}
                max={hoy}
                onChange={(e) => {
                  const next = { from: range?.from ?? hoy, to: e.target.value };
                  setRange(next);
                  if (e.target.value) void load(true, next);
                }}
                className="rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
              />
            </label>
            <div className="flex-1">
              <TableSearch
                value={historia.query}
                onChange={historia.setQuery}
                placeholder={t('exposure.searchHistory')}
              />
            </div>
          </div>
        </div>

        <DataTable<PnlRow>
          stickyHeader
          zebra
          density="compact"
          data={historia.pageRows}
          empty={<EmptyState compact icon={CalendarDays} title={t('exposure.pnlEmpty')} />}
          columns={[
            {
              header: t('exposure.colDay'),
              accessor: (r) => (
                <span className="tabular-nums">
                  {r.utc_day}
                  {/* El día en curso no es un cierre y compararlo con días
                      enteros sin saberlo lleva a conclusiones falsas. */}
                  {r.utc_day === hoy && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('exposure.inProgress')}
                    </span>
                  )}
                </span>
              ),
            },
            { header: t('exposure.colCategory'), accessor: (r) => r.category },
            {
              header: t('exposure.colClosedPnl'),
              align: 'right',
              accessor: (r) => <Money value={r.closed_pnl} unit={unitOfCategory(r.category)} />,
            },
            {
              header: t('exposure.colDeals'),
              align: 'right',
              accessor: (r) => <span className="tabular-nums">{formatNumber(r.closed_deals)}</span>,
            },
            {
              header: t('exposure.colOpenPnl'),
              align: 'right',
              accessor: (r) => <Money value={r.open_pnl} unit={unitOfCategory(r.category)} />,
            },
            {
              header: t('exposure.colPositions'),
              align: 'right',
              accessor: (r) => <span className="tabular-nums">{formatNumber(r.open_positions)}</span>,
            },
          ]}
        />
        <TablePager
          page={historia.page}
          pageCount={historia.pageCount}
          shown={historia.pageRows.length}
          total={historia.total}
          filteredTotal={historia.filtered.length}
          onPage={historia.setPage}
          labels={pagerLabels}
        />
      </Card>
    </div>
  );
}
