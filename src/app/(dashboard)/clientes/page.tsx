'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /clientes — ficha de cliente.
//
// La pantalla se mira para COBRAR: por eso el orden lo pone `cardsFromLines`
// (quien más debe, primero) y el "por cobrar" es la cifra destacada.
//
// La ficha se abre inline, no en una ruta propia: un cliente entero (meses +
// conceptos) entra en una tarjeta, y comparar dos deudores es abrir y cerrar
// en la misma lista en vez de ir y volver — que en el teléfono es lo único
// que se banca.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Contact, Download, Search, Users } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { downloadCSV } from '@/lib/csv-export';
import { cardsFromLines, totalsOf, UNASSIGNED_CLIENT_KEY, type ClientCard } from '@/lib/clients';
import type { IncomeLine } from '@/lib/income-lines';
import { cn, formatCurrency, periodLabel } from '@/lib/utils';

/** Una deuda por debajo del centavo es ruido de redondeo, no una deuda. */
const DEBT_EPSILON = 0.009;

export default function ClientesPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { company, periods } = useData();
  const accessDenied = !useModuleAccess('clients');
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);

  const [lines, setLines] = useState<IncomeLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyDebt, setOnlyDebt] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  // Sin `period_id` el endpoint devuelve el histórico completo de la empresa,
  // que es justo lo que la ficha necesita: un cliente vive entre meses.
  useEffect(() => {
    if (accessDenied) return;
    let alive = true;
    apiFetch('/api/admin/income-lines')
      .then((res) => res.json())
      .then((json: { success?: boolean; lines?: IncomeLine[] }) => {
        if (!alive) return;
        if (json?.success) setLines(json.lines ?? []);
        else setFailed(true);
      })
      .catch(() => {
        if (alive) setFailed(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [accessDenied]);

  const currency = company?.currency || 'USD';
  const money = (n: number) => formatCurrency(n, currency);

  const periodMeta = useMemo(() => {
    const map = new Map<string, { label: string; order: number }>();
    for (const p of periods) {
      map.set(p.id, {
        label: p.label || periodLabel(p.year, p.month),
        order: p.year * 12 + p.month,
      });
    }
    return map;
  }, [periods]);

  const cards = useMemo(
    () =>
      cardsFromLines(
        lines.map((l) => {
          const meta = periodMeta.get(l.period_id);
          return { ...l, periodLabel: meta?.label ?? '—', periodOrder: meta?.order ?? 0 };
        }),
      ),
    [lines, periodMeta],
  );

  const totals = useMemo(() => totalsOf(cards), [cards]);

  const unassignedLabel = t('clients.unassigned');
  const displayName = (card: ClientCard) =>
    card.key === UNASSIGNED_CLIENT_KEY ? unassignedLabel : card.name;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter((c) => {
      if (onlyDebt && c.pending <= DEBT_EPSILON) return false;
      if (!q) return true;
      // La ficha sin cliente se busca por su etiqueta, no por la clave cruda.
      const name = c.key === UNASSIGNED_CLIENT_KEY ? unassignedLabel : c.name;
      return name.toLowerCase().includes(q);
    });
  }, [cards, query, onlyDebt, unassignedLabel]);

  const exportCSV = () => {
    verify2FA(() => {
      const headers = [
        t('clients.csvClient'),
        t('clients.billed'),
        t('clients.collected'),
        t('clients.pending'),
        t('clients.csvMonths'),
        t('clients.csvFrom'),
        t('clients.csvTo'),
      ];
      const rows = visible.map((c) => [
        displayName(c),
        c.amount,
        c.received,
        c.pending,
        c.months.length,
        c.firstPeriodLabel,
        c.lastPeriodLabel,
      ] as (string | number)[]);
      downloadCSV('clientes.csv', headers, rows);
    });
  };

  if (accessDenied) {
    return <EmptyState icon={Contact} title={t('clients.title')} description={t('common.noAccess')} />;
  }

  return (
    <div className="space-y-6">
      {Modal2FA}
      <PageHeader
        title={t('clients.title')}
        subtitle={t('clients.subtitle')}
        icon={Contact}
        actions={
          <Button onClick={exportCSV} disabled={visible.length === 0}>
            <Download className="w-4 h-4" />
            {t('common.csv')}
          </Button>
        }
      />

      {loading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      ) : failed ? (
        <Card>
          <EmptyState icon={AlertTriangle} title={t('clients.loadError')} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
            <StatCard label={t('clients.statClients')} value={String(totals.clients)} icon={Users} />
            <StatCard label={t('clients.statBilled')} value={money(totals.amount)} />
            <StatCard label={t('clients.statCollected')} value={money(totals.received)} tone="positive" />
            <StatCard
              label={t('clients.statPending')}
              value={money(totals.pending)}
              tone="negative"
              emphasis
              icon={AlertTriangle}
            />
            <StatCard
              label={t('clients.statWithDebt')}
              value={String(totals.withDebt)}
              tone={totals.withDebt > 0 ? 'warning' : 'neutral'}
              hint={t('clients.statWithDebtHint', {
                count: String(totals.withDebt),
                total: String(totals.clients),
              })}
            />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('clients.searchPlaceholder')}
                aria-label={t('clients.searchPlaceholder')}
                className="w-full h-11 pl-9 pr-3 rounded-lg border border-border bg-card text-base sm:text-sm text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <label className="inline-flex items-center gap-2 h-11 px-3 rounded-lg border border-border bg-card cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyDebt}
                onChange={(e) => setOnlyDebt(e.target.checked)}
                className="w-4 h-4 accent-[var(--color-primary)]"
              />
              <span className="text-sm text-foreground">{t('clients.onlyDebt')}</span>
            </label>
          </div>

          {cards.length === 0 ? (
            <Card>
              <EmptyState icon={Contact} title={t('clients.empty')} description={t('clients.emptyHint')} />
            </Card>
          ) : visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={Search}
                title={t('clients.emptyFiltered')}
                description={t('clients.emptyFilteredHint')}
              />
            </Card>
          ) : (
            <div className="space-y-3">
              {visible.map((card) => (
                <ClientRow
                  key={card.key}
                  card={card}
                  name={displayName(card)}
                  money={money}
                  open={openKey === card.key}
                  onToggle={() => setOpenKey(openKey === card.key ? null : card.key)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface ClientRowProps {
  card: ClientCard;
  name: string;
  money: (n: number) => string;
  open: boolean;
  onToggle: () => void;
}

function ClientRow({ card, name, money, open, onToggle }: ClientRowProps) {
  const { t } = useI18n();
  const owes = card.pending > DEBT_EPSILON;
  const panelId = `client-panel-${card.key}`;

  const range =
    card.firstPeriodLabel === card.lastPeriodLabel
      ? t('clients.singlePeriod', { from: card.firstPeriodLabel })
      : t('clients.range', { from: card.firstPeriodLabel, to: card.lastPeriodLabel });

  return (
    <Card className="p-0 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full min-h-[44px] text-left px-4 py-4 sm:px-6 hover:bg-muted transition-colors"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground truncate">{name}</span>
              {owes ? (
                <Badge variant="danger">{money(card.pending)}</Badge>
              ) : (
                <Badge variant="success">{t('clients.settled')}</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {range} · {t('clients.monthsCount', { count: String(card.months.length) })}
            </p>
            <div className="grid grid-cols-3 gap-3 mt-3 max-w-md">
              <Amount label={t('clients.billed')} value={money(card.amount)} />
              <Amount label={t('clients.collected')} value={money(card.received)} tone="positive" />
              <Amount
                label={t('clients.pending')}
                value={money(card.pending)}
                tone={owes ? 'negative' : 'muted'}
              />
            </div>
          </div>
          <ChevronDown
            className={cn(
              'w-5 h-5 text-muted-foreground shrink-0 transition-transform',
              open && 'rotate-180',
            )}
          />
        </div>
      </button>

      {open && (
        <div id={panelId} className="border-t border-border px-4 py-4 sm:px-6 space-y-6 bg-muted/30">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('clients.history')}
            </h3>
            <ul className="mt-3 space-y-3">
              {card.months.map((m) => (
                <li key={m.periodId} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{m.periodLabel}</span>
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {money(m.amount)}
                    </span>
                  </div>
                  <div className="flex gap-4 mt-1 text-xs tabular-nums">
                    <span className="text-positive">
                      {t('clients.collected')} {money(m.received)}
                    </span>
                    <span className={m.pending > DEBT_EPSILON ? 'text-negative' : 'text-muted-foreground'}>
                      {t('clients.pending')} {money(m.pending)}
                    </span>
                  </div>
                  <ul className="mt-2 pt-2 border-t border-border space-y-1">
                    {m.lines.map((l, i) => (
                      <li
                        key={`${m.periodId}-${i}`}
                        className="flex items-baseline justify-between gap-3 text-xs"
                      >
                        <span className="text-muted-foreground min-w-0 truncate">{l.concept}</span>
                        <span className="tabular-nums text-foreground shrink-0">{money(l.amount)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('clients.conceptsSummary')}
            </h3>
            <ul className="mt-3 space-y-2">
              {card.concepts.map((c) => (
                <li key={c.concept} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-foreground min-w-0 truncate">
                    {c.concept}{' '}
                    <span className="text-muted-foreground text-xs">
                      {t('clients.conceptTimes', { count: String(c.times) })}
                    </span>
                  </span>
                  <span className="tabular-nums text-foreground shrink-0">{money(c.amount)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Card>
  );
}

function Amount({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'positive' | 'negative' | 'muted';
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground truncate">{label}</p>
      <p
        className={cn(
          'text-sm font-semibold tabular-nums truncate',
          tone === 'positive' && 'text-positive',
          tone === 'negative' && 'text-negative',
          tone === 'muted' && 'text-muted-foreground',
          tone === 'default' && 'text-foreground',
        )}
      >
        {value}
      </p>
    </div>
  );
}
