'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /clientes — ficha de cliente.
//
// La pantalla se mira para COBRAR: por eso el orden lo pone `cardsFromLines`
// (quien más debe, primero) y el "por cobrar" es la cifra destacada.
//
// ── «LIBRO MAYOR» (2026-10-12) ────────────────────────────────────────────
// Antes cada cliente era una tarjeta con su propia grilla de tres montos y la
// ficha se desplegaba adentro. Con 40 clientes eran 40 superficies apiladas y
// los montos no alineaban entre tarjetas — comparar dos deudores era leer dos
// grillas distintas. Ahora:
//   · cinco `StatCard` → UNA `KpiStrip`; «Por cobrar» es el hero;
//   · la lista es una `FinTable` (montos en columna, tabulares; tarjeta en
//     móvil) con estado `StatusBadge` (debe = pend: requiere acción de
//     cobro; al día = ok). «Por cobrar» NO va en rojo: es plata a favor, no
//     una pérdida (spec §2.1);
//   · el checkbox «Solo los que deben» → `Chip` con conteo, y el pie dice
//     «Mostrando N de M» cuando hay filtro o búsqueda: un recorte silencioso
//     es indistinguible de «no hay más» (reglas §1.2). Los KPIs usan siempre
//     los M; el total al pie, los N mostrados, y lo dice;
//   · la ficha (mes a mes + conceptos) se abre al hacer clic en la fila, en
//     un `Panel` debajo de la tabla con el mes como fila de grupo y su
//     subtotal (el de `cardsFromLines`, no re-sumado acá).
// La regla «debe» (umbral de 1 centavo) y el filtro viven en clients-view.ts,
// con test, para que el conteo del chip y la tabla no puedan diferir.
// El CSV sale igual que antes (mismas columnas, mismas filas visibles).
// Medido antes/después en este archivo: 18 tokens legados + 1 `text-[11px]`
// → 0. Paleta cruda: 0 → 0.
//
// DESCARTADO: la ficha desplegada DENTRO de la fila (FinTable no tiene filas
// expandibles y meter una tabla en una celda rompe el modo tarjeta); se
// compensa llevando la vista al panel al abrirla.
//
// No hay KYC, email ni país: esta pantalla es de FACTURACIÓN (líneas de
// ingreso), no del CRM. Inventar esas columnas sería mostrar «—» en todas.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from 'react';
import { Contact, Download, Search, X } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/field';
import { ActionButton } from '@/components/ui/action-button';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { downloadCSV } from '@/lib/csv-export';
import { cardsFromLines, totalsOf, type ClientCard, type ClientLine } from '@/lib/clients';
import type { IncomeLine } from '@/lib/income-lines';
import { periodLabel } from '@/lib/utils';
import { clientDisplayName, filterClients, filterCounts, owes, type ClientFilter } from './clients-view';

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
  const [filter, setFilter] = useState<ClientFilter>('all');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const detailRef = useRef<HTMLElement>(null);

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

  // Al abrir una ficha, la vista baja hasta ella: vive debajo de la tabla.
  useEffect(() => {
    if (openKey) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [openKey]);

  const currency = company?.currency || 'USD';

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
  const counts = useMemo(() => filterCounts(cards), [cards]);

  const unassignedLabel = t('clients.unassigned');
  const displayName = (card: ClientCard) => clientDisplayName(card, unassignedLabel);

  const visible = useMemo(
    () => filterClients(cards, { query, filter, unassignedLabel }),
    [cards, query, filter, unassignedLabel],
  );
  const visibleTotals = useMemo(() => totalsOf(visible), [visible]);
  const openCard = openKey ? cards.find((c) => c.key === openKey) ?? null : null;

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

  const range = (card: ClientCard) =>
    card.firstPeriodLabel === card.lastPeriodLabel
      ? t('clients.singlePeriod', { from: card.firstPeriodLabel })
      : t('clients.range', { from: card.firstPeriodLabel, to: card.lastPeriodLabel });
  const metaLine = (card: ClientCard) =>
    `${range(card)} · ${t('clients.monthsCount', { count: String(card.months.length) })}`;
  const statusBadge = (card: ClientCard) =>
    owes(card) ? (
      <StatusBadge kind="pend" label={t('clients.lm.owes')} />
    ) : (
      <StatusBadge kind="ok" label={t('clients.settled')} />
    );

  const kpis: KpiItem[] = [
    { key: 'pending', label: t('clients.statPending'), value: totals.pending, format: 'money', hero: true },
    { key: 'billed', label: t('clients.statBilled'), value: totals.amount, format: 'money' },
    { key: 'collected', label: t('clients.statCollected'), value: totals.received, format: 'money' },
    {
      key: 'withDebt',
      label: t('clients.statWithDebt'),
      value: totals.withDebt,
      format: 'count',
      sub: t('clients.statWithDebtHint', { count: String(totals.withDebt), total: String(totals.clients) }),
    },
    { key: 'clients', label: t('clients.statClients'), value: totals.clients, format: 'count' },
  ];

  const columns: FinColumn<ClientCard>[] = [
    {
      key: 'name',
      header: t('clients.csvClient'),
      cell: (c) => displayName(c),
      meta: (c) => metaLine(c),
      mobileMeta: (c) => statusBadge(c),
    },
    { key: 'status', header: t('clients.lm.status'), cell: (c) => statusBadge(c), hideSm: true },
    {
      key: 'billed',
      header: t('clients.billed'),
      kind: 'money',
      value: (c) => c.amount,
      money: { currency },
      hideSm: true,
    },
    {
      key: 'collected',
      header: t('clients.collected'),
      kind: 'money',
      value: (c) => c.received,
      money: { currency },
      hideSm: true,
    },
    {
      key: 'pending',
      header: t('clients.pending'),
      kind: 'money',
      value: (c) => c.pending,
      // Al día: el $0.00 va en gris; lo que se mira es quién debe.
      cell: (c) => (
        <Money value={c.pending} currency={currency} className={owes(c) ? 'font-medium' : 'text-text-3'} />
      ),
    },
  ];

  const filtered = visible.length !== cards.length;

  return (
    <div className="space-y-4">
      {Modal2FA}
      <PageHeader
        title={t('clients.title')}
        subtitle={t('clients.subtitle')}
        icon={Contact}
        actions={
          <ActionButton onClick={exportCSV} disabled={visible.length === 0} aria-label={t('common.csv')}>
            <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
            {t('common.csv')}
          </ActionButton>
        }
      />

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-[92px]" />
          <Skeleton className="h-64" />
        </div>
      ) : failed ? (
        <Notice kind="bad" title={t('clients.loadError')}>
          {t('clients.lm.loadErrorBody')}
        </Notice>
      ) : cards.length === 0 ? (
        <Panel>
          <EmptyState icon={Contact} title={t('clients.empty')} description={t('clients.emptyHint')} />
        </Panel>
      ) : (
        <>
          <KpiStrip items={kpis} />

          <Panel
            flush
            title={t('clients.lm.listTitle')}
            hint={t('clients.lm.listHint')}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Chip active={filter === 'all'} count={counts.all} onClick={() => setFilter('all')}>
                  {t('clients.lm.filterAll')}
                </Chip>
                <Chip active={filter === 'debt'} count={counts.debt} onClick={() => setFilter('debt')}>
                  {t('clients.onlyDebt')}
                </Chip>
              </div>
            }
            footer={
              filtered
                ? t('clients.lm.shownOf', {
                    shown: String(visible.length),
                    total: String(cards.length),
                  })
                : undefined
            }
          >
            <div className="border-b border-border px-4 py-2.5">
              <div className="relative max-w-[320px] max-sm:max-w-none">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-2.5 top-1/2 size-[15px] -translate-y-1/2 text-text-3"
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('clients.searchPlaceholder')}
                  aria-label={t('clients.searchPlaceholder')}
                  className="pl-8"
                />
              </div>
            </div>
            <FinTable
              columns={columns}
              rows={visible}
              rowKey={(c) => c.key}
              caption={t('clients.title')}
              selectedKey={openKey}
              onRowClick={(c) => setOpenKey(openKey === c.key ? null : c.key)}
              empty={
                <EmptyState
                  compact
                  icon={Search}
                  title={t('clients.emptyFiltered')}
                  description={t('clients.emptyFilteredHint')}
                />
              }
              footer={
                visible.length > 0
                  ? {
                      label: filtered
                        ? t('clients.lm.totalShown', { count: String(visible.length) })
                        : t('clients.lm.totalAll', { count: String(visible.length) }),
                      values: {
                        billed: visibleTotals.amount,
                        collected: visibleTotals.received,
                        pending: visibleTotals.pending,
                      },
                    }
                  : undefined
              }
            />
          </Panel>

          {openCard && (
            <ClientDetail
              ref={detailRef}
              card={openCard}
              name={displayName(openCard)}
              meta={metaLine(openCard)}
              currency={currency}
              onClose={() => setOpenKey(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

interface DetailLine extends ClientLine {
  rowId: string;
}

interface ClientDetailProps {
  ref: React.Ref<HTMLElement>;
  card: ClientCard;
  name: string;
  meta: string;
  currency: string;
  onClose: () => void;
}

function ClientDetail({ ref, card, name, meta, currency, onClose }: ClientDetailProps) {
  const { t } = useI18n();

  // Cada línea con su mes como grupo. El subtotal del mes es el que ya armó
  // `cardsFromLines` (`groupTotals`), no una suma nueva de esta pantalla.
  const historyRows: DetailLine[] = card.months.flatMap((m) =>
    m.lines.map((l, i) => ({ ...l, rowId: `${m.periodId}-${i}` })),
  );
  const periodLabels = new Map(card.months.map((m) => [m.periodId, m.periodLabel]));
  const groupTotals = Object.fromEntries(
    card.months.map((m) => [m.periodId, { amount: m.amount, received: m.received, pending: m.pending }]),
  );

  const historyColumns: FinColumn<DetailLine>[] = [
    { key: 'concept', header: t('clients.lm.concept'), cell: (l) => l.concept },
    { key: 'amount', header: t('clients.billed'), kind: 'money', value: (l) => l.amount, money: { currency } },
    {
      key: 'received',
      header: t('clients.collected'),
      kind: 'money',
      value: (l) => l.received,
      money: { currency },
      hideSm: true,
    },
    {
      key: 'pending',
      header: t('clients.pending'),
      kind: 'money',
      value: (l) => l.pending,
      money: { currency },
      hideSm: true,
    },
  ];

  const conceptColumns: FinColumn<ClientCard['concepts'][number]>[] = [
    {
      key: 'concept',
      header: t('clients.lm.concept'),
      cell: (c) => c.concept,
      meta: (c) => t('clients.conceptTimes', { count: String(c.times) }),
    },
    { key: 'amount', header: t('clients.billed'), kind: 'money', value: (c) => c.amount, money: { currency } },
  ];

  return (
    <section ref={ref} aria-label={name} className="scroll-mt-20 space-y-4">
      <Panel
        flush
        title={name}
        hint={meta}
        actions={
          <ActionButton variant="ghost" onClick={onClose} aria-label={t('clients.lm.closeDetail')}>
            <X aria-hidden className="size-[15px]" strokeWidth={1.75} />
            <span className="max-sm:hidden">{t('clients.lm.closeDetail')}</span>
          </ActionButton>
        }
      >
        <div className="border-b border-border px-4 py-2.5 text-[12px] font-semibold uppercase tracking-[.03em] text-text-3">
          {t('clients.history')}
        </div>
        <FinTable
          columns={historyColumns}
          rows={historyRows}
          rowKey={(l) => l.rowId}
          groupBy={(l) => l.periodId}
          groupLabel={(id) => periodLabels.get(id) ?? id}
          groupTotals={groupTotals}
          caption={t('clients.history')}
        />
      </Panel>

      <Panel flush title={t('clients.conceptsSummary')}>
        <FinTable
          columns={conceptColumns}
          rows={card.concepts}
          rowKey={(c) => c.concept}
          caption={t('clients.conceptsSummary')}
        />
      </Panel>
    </section>
  );
}
