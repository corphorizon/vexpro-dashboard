'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /ingresos — consulta de ingresos operativos.
//
// Espejo exacto de /egresos: SOLO LECTURA. El detalle por concepto se carga en
// "Carga de Datos" (pestaña Ingresos) y hasta hoy no había dónde MIRARLO — el
// único acceso era la pantalla de edición, que obliga a entrar a un formulario
// para responder "¿cuánto facturamos y cuánto nos deben este mes?".
//
// La cifra destacada es "Por cobrar", no lo facturado: lo que se reparte en la
// cadena de socios es lo COBRADO (ver src/lib/income-lines.ts), así que la
// pregunta que la pantalla tiene que contestar de un vistazo es cuánta plata
// facturada todavía no entró.
//
// Aplica a los dos modelos de negocio: `incomeLines` está en true tanto para
// broker como para company (src/lib/business-model.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Download,
  Search,
  TrendingUp,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/ui/page-header';
import { ConsolidatedBadge } from '@/components/ui/consolidated-badge';
import { PeriodSelector } from '@/components/period-selector';
import { NoPeriodsState } from '@/components/no-periods-state';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { usePeriod } from '@/lib/period-context';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { downloadCSV } from '@/lib/csv-export';
import { formatDate, formatDayMonth } from '@/lib/dates';
import { computeIncomeTotals, type IncomeLine } from '@/lib/income-lines';
import { formatCurrency, periodLabel } from '@/lib/utils';

type SortState = 'default' | 'desc' | 'asc';

const SortIcon = ({ state }: { state: SortState }) => {
  if (state === 'desc') return <ArrowDown className="w-3.5 h-3.5" />;
  if (state === 'asc') return <ArrowUp className="w-3.5 h-3.5" />;
  return <ArrowUpDown className="w-3.5 h-3.5" />;
};

/** Un pendiente por debajo del centavo es redondeo, no una deuda. */
const PENDING_EPSILON = 0.009;

export default function IngresosPage() {
  const { t } = useI18n();
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();
  const { user } = useAuth();
  const { company, periods, loading: dataLoading } = useData();
  const canView = useModuleAccess('income');
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);

  const [searchQuery, setSearchQuery] = useState('');
  const [sortState, setSortState] = useState<SortState>('default');

  // En consolidado los ids cambian de identidad en cada render aunque el
  // contenido sea el mismo; sin esta clave el efecto refetchearía en bucle.
  const requestKey =
    mode === 'consolidated' ? `c:${selectedPeriodIds.join(',')}` : `s:${selectedPeriodId}`;

  // La respuesta se guarda junto a la clave que la pidió. Así "cargando" es
  // una comparación derivada (clave pedida ≠ clave respondida) y el efecto no
  // necesita un setState sincrónico que dispare un render en cascada.
  const [result, setResult] = useState<{
    key: string;
    lines: IncomeLine[];
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!canView) return;
    if (mode !== 'consolidated' && !selectedPeriodId) return;
    // Un solo período pide solo ese; el consolidado trae el histórico y filtra
    // acá, porque el endpoint acepta un `period_id`, no una lista.
    const url =
      mode === 'consolidated'
        ? '/api/admin/income-lines'
        : `/api/admin/income-lines?period_id=${encodeURIComponent(selectedPeriodId)}`;

    let alive = true;
    apiFetch(url)
      .then((res) => res.json())
      .then((json: { success?: boolean; lines?: IncomeLine[] }) => {
        if (!alive) return;
        if (json?.success) setResult({ key: requestKey, lines: json.lines ?? [], failed: false });
        else setResult({ key: requestKey, lines: [], failed: true });
      })
      .catch(() => {
        if (alive) setResult({ key: requestKey, lines: [], failed: true });
      });
    return () => {
      alive = false;
    };
  }, [canView, mode, selectedPeriodId, requestKey]);

  const loading = result?.key !== requestKey;
  const failed = !loading && !!result?.failed;
  const lines = useMemo(() => (result?.key === requestKey ? result.lines : []), [result, requestKey]);

  const currency = company?.currency || 'USD';
  const money = useCallback((n: number) => formatCurrency(n, currency), [currency]);

  const periodLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of periods) map.set(p.id, p.label || periodLabel(p.year, p.month));
    return map;
  }, [periods]);

  // El consolidado recorta al conjunto elegido; el modo simple ya vino filtrado
  // por el endpoint, pero se re-filtra igual para que una respuesta vieja en
  // vuelo no pinte líneas de otro mes.
  const scopedLines = useMemo(() => {
    const allowed = new Set(mode === 'consolidated' ? selectedPeriodIds : [selectedPeriodId]);
    return lines.filter((l) => allowed.has(l.period_id));
  }, [lines, mode, selectedPeriodIds, selectedPeriodId]);

  const visibleLines = useMemo(() => {
    let result = [...scopedLines];

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (l) =>
          l.concept.toLowerCase().includes(q) || (l.client ?? '').toLowerCase().includes(q),
      );
    }

    if (sortState === 'desc') result.sort((a, b) => b.amount - a.amount);
    else if (sortState === 'asc') result.sort((a, b) => a.amount - b.amount);

    return result;
  }, [scopedLines, searchQuery, sortState]);

  // Las tarjetas miran el período completo; la tabla y su pie, lo filtrado.
  const scopedTotals = useMemo(() => computeIncomeTotals(scopedLines), [scopedLines]);
  const visibleTotals = useMemo(() => computeIncomeTotals(visibleLines), [visibleLines]);

  const cycleSortState = () => {
    setSortState((prev) => {
      if (prev === 'default') return 'desc';
      if (prev === 'desc') return 'asc';
      return 'default';
    });
  };

  const scopeLabel =
    mode === 'consolidated'
      ? t('income.consolidatedScope', { count: String(selectedPeriodIds.length) })
      : periodLabels.get(selectedPeriodId) ?? '—';

  const exportCSV = () => {
    verify2FA(() => {
      const headers = [
        '#',
        t('income.period'),
        t('income.concept'),
        t('income.client'),
        t('income.category'),
        t('expenses.date'),
        t('income.invoiced'),
        t('income.received'),
        t('income.pendingAmount'),
      ];
      const rows = visibleLines.map(
        (l, i) =>
          [
            i + 1,
            periodLabels.get(l.period_id) ?? '',
            l.concept,
            l.client ?? '',
            l.category ?? '',
            // Fecha completa en el CSV: fuera de la tabla no hay período que
            // dé el año por contexto.
            l.income_date ? formatDate(l.income_date) : '',
            l.amount,
            l.received,
            l.pending,
          ] as (string | number)[],
      );
      downloadCSV(`ingresos_${scopeLabel.replace(/\s/g, '_')}.csv`, headers, rows);
    });
  };

  if (!canView) {
    return <EmptyState icon={TrendingUp} title={t('income.title')} description={t('common.noAccess')} />;
  }

  // Sin períodos no hay nada que cargar: un esqueleto eterno haría creer que
  // el sistema está trabajando.
  if (!dataLoading && periods.length === 0) return <NoPeriodsState />;

  return (
    <div className="space-y-6">
      {Modal2FA}
      <PageHeader
        title={t('income.title')}
        subtitle={t('income.subtitle')}
        icon={TrendingUp}
        actions={
          <>
            <ConsolidatedBadge count={mode === 'consolidated' ? selectedPeriodIds.length : 1} />
            <button
              onClick={exportCSV}
              disabled={visibleLines.length === 0}
              className="inline-flex items-center gap-2 h-11 px-3 rounded-lg border border-border bg-card text-base sm:text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={t('common.csv')}
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">{t('common.csv')}</span>
            </button>
            <PeriodSelector />
          </>
        }
      />

      {loading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      ) : failed ? (
        <Card>
          <EmptyState icon={AlertTriangle} title={t('income.fetchError')} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard
              label={t('income.invoiced')}
              value={money(scopedTotals.amount)}
              icon={TrendingUp}
              tone="neutral"
            />
            <StatCard
              label={t('income.received')}
              value={money(scopedTotals.received)}
              icon={Check}
              tone="positive"
            />
            {/* La cifra que se mira para cobrar va destacada. */}
            <StatCard
              label={t('income.pendingAmount')}
              value={money(scopedTotals.pending)}
              icon={AlertTriangle}
              tone={scopedTotals.pending > PENDING_EPSILON ? 'warning' : 'neutral'}
              emphasis
            />
          </div>

          <Card>
            <h2 className="text-lg font-semibold mb-4">
              {t('income.detail')} — {scopeLabel}
            </h2>

            <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
              <div className="relative flex-1 sm:max-w-sm min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('income.search')}
                  aria-label={t('income.search')}
                  className="w-full h-11 pl-9 pr-3 rounded-lg border border-border bg-background text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <button
                onClick={cycleSortState}
                className={`inline-flex items-center gap-1.5 h-11 px-3 rounded-lg border text-base sm:text-sm font-medium transition-colors ${
                  sortState !== 'default'
                    ? 'border-[var(--color-primary)] text-primary dark:text-accent bg-info/10'
                    : 'border-border hover:bg-muted'
                }`}
                title={
                  sortState === 'default'
                    ? t('expenses.sortDefault')
                    : sortState === 'desc'
                      ? t('expenses.sortDesc')
                      : t('expenses.sortAsc')
                }
              >
                <SortIcon state={sortState} />
                {t('expenses.sortAmount')}{' '}
                {sortState === 'desc'
                  ? t('expenses.sortHighest')
                  : sortState === 'asc'
                    ? t('expenses.sortLowest')
                    : ''}
              </button>
            </div>

            <div className="overflow-auto max-h-[65vh]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-border">
                    <th className="text-left py-2.5 px-3 text-muted-foreground font-medium w-8">#</th>
                    {/* En consolidado hay varios meses mezclados: sin esta
                        columna dos facturas iguales de meses distintos se ven
                        como un duplicado. */}
                    {mode === 'consolidated' && (
                      <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">
                        {t('income.period')}
                      </th>
                    )}
                    <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('income.concept')}</th>
                    <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('income.client')}</th>
                    <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('income.category')}</th>
                    {/* Fecha en DD/MM — el año lo da el período — para no
                        ensanchar la tabla en móvil. */}
                    <th className="text-left py-2 px-2 text-muted-foreground font-medium w-16">{t('expenses.date')}</th>
                    <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('income.invoiced')}</th>
                    <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('income.received')}</th>
                    <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('income.pendingAmount')}</th>
                    <th className="text-center py-2.5 px-3 text-muted-foreground font-medium">{t('expenses.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLines.length === 0 && (
                    <tr>
                      <td colSpan={mode === 'consolidated' ? 10 : 9} className="py-8 text-center text-muted-foreground">
                        {searchQuery ? t('income.noResults') : t('income.noIncome')}
                      </td>
                    </tr>
                  )}
                  {visibleLines.map((line, i) => (
                    <tr key={line.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                      <td className="py-2.5 px-3 text-muted-foreground">{i + 1}</td>
                      {mode === 'consolidated' && (
                        <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap">
                          {periodLabels.get(line.period_id) ?? '—'}
                        </td>
                      )}
                      <td className="py-2.5 px-3">{line.concept}</td>
                      <td className="py-2.5 px-3">
                        {line.client?.trim() ? (
                          line.client
                        ) : (
                          <span className="text-xs text-muted-foreground">{t('income.unassignedClient')}</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        {line.category ? (
                          <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-muted text-muted-foreground border border-border">
                            {line.category}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                        {line.income_date ? formatDayMonth(line.income_date) : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-right font-medium">{money(line.amount)}</td>
                      <td className="py-2.5 px-3 text-right">{money(line.received)}</td>
                      <td className="py-2.5 px-3 text-right">{money(line.pending)}</td>
                      <td className="py-2.5 px-3 text-center">
                        <Badge variant={line.pending <= PENDING_EPSILON ? 'success' : 'warning'}>
                          {line.pending <= PENDING_EPSILON
                            ? t('income.collectedStatus')
                            : t('income.pendingStatus')}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-bold bg-muted/50">
                    {/* colSpan cubre TODAS las columnas de texto (incluida
                        Fecha): con una de menos los totales quedan corridos
                        una columna a la izquierda. */}
                    <td className="py-3 px-3" colSpan={mode === 'consolidated' ? 6 : 5}>
                      TOTAL
                    </td>
                    <td className="py-3 px-3 text-right">{money(visibleTotals.amount)}</td>
                    <td className="py-3 px-3 text-right">{money(visibleTotals.received)}</td>
                    <td className="py-3 px-3 text-right">{money(visibleTotals.pending)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* La edición vive en Carga de Datos → pestaña Ingresos. */}
            <p className="mt-4 text-xs text-muted-foreground">{t('income.readOnlyNote')}</p>
          </Card>
        </>
      )}
    </div>
  );
}
