'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /inversiones — rediseño «Libro mayor» (2026-10-12, docs/diseno-libro-mayor.md)
//
// QUÉ CAMBIÓ (presentación; los totales siguen saliendo de
// `computeInvestmentTotals` y el saldo de `useRunningBalance`):
//   · Cuatro StatCard → UNA franja: Saldo actual (hero), Capital colocado,
//     Ganancia del filtro (color por signo), Ganancia sin cobrar y Rendimiento.
//   · «Por responsable»: de una grilla de tarjetas con azul/rojo/verde de
//     paleta cruda a una FinTable; las filas SIN responsable se cuentan en el
//     pie (antes desaparecían en silencio).
//   · Historial en FinTable con el TIPO de movimiento (registro único
//     `investment-types.ts`; «Mixto» como badge `pend` porque pide separarlo)
//     y la ganancia con tono por signo.
//
// BUGS DE PRESENTACIÓN QUE SE VEÍAN COMO DATOS (arreglados acá):
//   1. Una ganancia NEGATIVA (inversión que perdió, se carga con signo − en
//      /upload) se dibujaba «—» en el historial: la celda sólo mostraba
//      `profit > 0`. Una pérdida se leía como «sin ganancia».
//   2. Sin movimientos, el saldo decía $0.00; ahora «—» (§1.3).
//   3. «Capital colocado» con un mes elegido mostraba SÓLO los aportes −
//      devoluciones de ese mes (un mes sin aportes: $0 de capital, con la
//      plata adentro). Ahora es el capital al cierre del filtro; los flujos
//      del mes van en el sub.
//
// EL BANNER «MES CERRADO»: el hallazgo previo lo ubicaba «en esta pestaña».
// Esta pantalla no tiene ninguno (es de sólo lectura y no mira períodos); el
// aviso que sale con un período cerrado es el de la pestaña «inversiones» de
// /upload (`upload.periodClosedNoChanges`), fuera del alcance de este cambio.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo } from 'react';
import { TrendingUp, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Chip } from '@/components/ui/chip';
import { Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { ActionButton, ROW_ACTION_CLASS } from '@/components/payment-orders/action-button';
import { computeInvestmentTotals, movementTypeLabel, inferMovementType } from '@/lib/investment-types';
import { useData } from '@/lib/data-context';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { downloadCSV } from '@/lib/csv-export';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useI18n } from '@/lib/i18n';
import { useRunningBalance } from '@/lib/use-running-balance';
import { ALL_MONTHS, closingBalance, filterByMonth, monthsByYear } from '@/lib/ledger-month-filter';
import type { Investment } from '@/lib/types';
import { byResponsible, capitalPlacedAtEnd, returnPct, type ResponsibleTotals } from './investments-view';

const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const PAGE_SIZE = 50;

// Sin columna «#»: la primera es el concepto, donde cae la etiqueta del total.
type InvRow = Investment;

export default function InversionesPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { getInvestmentsData } = useData();
  const [filter, setFilter] = useState(ALL_MONTHS);
  // Read directly from the data-context — removing the local-state mirror
  // eliminates the flash-of-stale-data after add/edit/delete.
  const investmentsData = useMemo(() => getInvestmentsData(), [getInvestmentsData]);

  const dataByYear = useMemo(() => monthsByYear(investmentsData), [investmentsData]);
  const availableYears = useMemo(() => Array.from(dataByYear.keys()).sort(), [dataByYear]);

  // El año elegido; hasta que alguien elija, el más reciente con datos
  // (derivado en el render: antes era un setState dentro de un effect, que
  // pintaba un cuadro con el año 0 antes de corregirse).
  const [pickedYear, setSelectedYear] = useState<number | null>(null);
  const selectedYear = pickedYear ?? availableYears.at(-1) ?? 0;

  const filtered = useMemo(() => filterByMonth(investmentsData, filter), [filter, investmentsData]);

  // Running balance computed on-the-fly. The stored `balance` column is
  // unreliable because addInvestmentRow / updateInvestment pass `balance: 0`
  // on insert. Formula matches recalcInvestmentBalances: deposit - withdrawal
  // + profit accumulated in date order.
  const balanceMap = useRunningBalance(
    investmentsData,
    inv => inv.deposit - inv.withdrawal + inv.profit,
  );

  const lastBalance = useMemo(
    () => closingBalance(filtered.length > 0 ? filtered : investmentsData, balanceMap),
    [filtered, investmentsData, balanceMap],
  );

  const totalDeposits = filtered.reduce((s, i) => s + i.deposit, 0);
  const totalWithdrawals = filtered.reduce((s, i) => s + i.withdrawal, 0);
  const totalProfit = filtered.reduce((s, i) => s + i.profit, 0);

  // Totales tipificados (migración 062). "Retiros" a secas mezclaba devolución
  // de capital con cobro de ganancias; estos los separan.
  const tot = useMemo(() => computeInvestmentTotals(filtered), [filtered]);
  const capitalAtEnd = useMemo(() => capitalPlacedAtEnd(investmentsData, filter), [investmentsData, filter]);
  const yieldPct = returnPct(totalProfit, capitalAtEnd);

  // Resumen por responsable — respeta el mismo filtro de fecha activo.
  const perResponsible = useMemo(() => byResponsible(filtered), [filtered]);

  // Pagination
  // La página vuelve a 0 cuando cambia el filtro o la cantidad de filas: la
  // página guardada sólo vale para la clave con la que se guardó.
  const pageKey = `${filter}|${investmentsData.length}`;
  const [pageState, setPageState] = useState({ key: pageKey, page: 0 });
  const page = pageState.key === pageKey ? pageState.page : 0;
  const setPage = (fn: (p: number) => number) => setPageState({ key: pageKey, page: fn(page) });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pagedRows = useMemo(
    () => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filtered, page],
  );
  const tableRows: InvRow[] = pagedRows;

  const periodLabel = filter === ALL_MONTHS
    ? t('liquidity.lm.allHistory')
    : `${MONTH_NAMES[Number(filter.slice(5, 7)) - 1]} ${filter.slice(0, 4)}`;
  const empty = investmentsData.length === 0;

  const kpis: KpiItem[] = [
    {
      key: 'balance',
      label: t('investments.currentBalance'),
      value: lastBalance,
      hero: true,
      sub: empty ? t('liquidity.lm.noMovements') : filter === ALL_MONTHS ? t('liquidity.lm.balanceToday') : t('liquidity.lm.balanceAtEnd', { period: periodLabel }),
      missingBadge: false,
    },
    {
      // Capital colocado = aportes − devoluciones. Es la plata que sigue
      // adentro, sin mezclar las ganancias cobradas.
      key: 'capital',
      label: t('investments.lm.capital'),
      value: empty ? null : capitalAtEnd,
      sub: t('investments.lm.capitalSub', {
        contributions: formatMoney(tot.contributions),
        redemptions: formatMoney(tot.redemptions),
      }),
      missingBadge: false,
    },
    {
      // La ganancia puede ser negativa cuando una inversión pierde: el signo
      // es la noticia.
      key: 'profit',
      label: t('investments.lm.profit'),
      value: empty ? null : totalProfit,
      tone: 'sign',
      sub: periodLabel,
      missingBadge: false,
    },
    {
      key: 'pending',
      label: t('investments.lm.profitPending'),
      value: empty ? null : tot.profitPending,
      sub: t('investments.lm.profitPendingSub', {
        accrued: formatMoney(tot.profitAccrued),
        paid: formatMoney(tot.profitPaid),
      }),
      missingBadge: false,
    },
    {
      key: 'yield',
      label: t('investments.lm.yield'),
      value: yieldPct,
      format: 'percent',
      sub: yieldPct === null ? t('investments.lm.yieldNoCapital') : t('investments.lm.yieldSub'),
      missingBadge: false,
    },
  ];

  const responsibleColumns: FinColumn<ResponsibleTotals>[] = [
    {
      key: 'name',
      header: t('investments.lm.colResponsible'),
      cell: (r) => r.responsible,
      meta: (r) => t('investments.lm.movementsCount', { count: String(r.count) }),
    },
    { key: 'deposits', header: t('investments.lm.colContributions'), kind: 'money', value: (r) => r.deposits, money: { tone: 'neutral' }, hideSm: true },
    { key: 'withdrawals', header: t('investments.lm.colWithdrawals'), kind: 'money', value: (r) => -r.withdrawals, money: { signed: true, tone: 'neutral' }, hideSm: true },
    { key: 'profit', header: t('investments.lm.colProfit'), kind: 'money', value: (r) => r.profit, money: { signed: true, tone: 'sign' }, hideSm: true },
    { key: 'balance', header: t('investments.lm.colBalance'), kind: 'money', value: (r) => r.balance },
  ];

  const historyColumns: FinColumn<InvRow>[] = [
    {
      key: 'concept',
      header: t('liquidity.lm.colConcept'),
      cell: (r) => <span className="block max-w-[280px] truncate" title={r.concept ?? undefined}>{r.concept || '—'}</span>,
      meta: (r) => r.responsible || undefined,
      mobileMeta: (r) => (
        <>
          <span className={NUM_CLASS}>{formatDate(r.date)}</span>
          <TypeBadge row={r} />
        </>
      ),
    },
    {
      key: 'date',
      header: t('liquidity.lm.colDate'),
      cell: (r) => <span className={cn(NUM_CLASS, 'text-text-2')}>{formatDate(r.date)}</span>,
      hideSm: true,
    },
    { key: 'type', header: t('investments.lm.colType'), cell: (r) => <TypeBadge row={r} />, hideSm: true },
    {
      key: 'flow',
      header: t('investments.lm.colFlow'),
      kind: 'money',
      value: (r) => r.deposit - r.withdrawal,
      cell: (r) => (r.deposit === 0 && r.withdrawal === 0
        ? <Dash />
        : <Money value={r.deposit - r.withdrawal} signed tone="neutral" className="font-medium" />),
      money: { signed: true, tone: 'neutral' },
      subtotal: false,
    },
    {
      key: 'profit',
      header: t('investments.lm.colProfit'),
      kind: 'money',
      value: (r) => r.profit,
      cell: (r) => (r.profit === 0 ? <Dash /> : <Money value={r.profit} signed tone="sign" className="font-medium" />),
      money: { signed: true, tone: 'sign' },
      subtotal: false,
    },
    {
      key: 'balance',
      header: t('liquidity.lm.colRunning'),
      kind: 'money',
      value: (r) => balanceMap.get(r.id) ?? null,
      hideSm: true,
      subtotal: false,
    },
  ];

  const exportCsv = () => verify2FA(() => {
    const headers = ['Fecha', 'Concepto', 'Responsable', '+', '-', 'Profit', 'Balance'];
    const rows = filtered.map(i => [i.date, i.concept || '', i.responsible || '', i.deposit, i.withdrawal, i.profit, balanceMap.get(i.id) ?? ''] as (string | number)[]);
    downloadCSV('inversiones.csv', headers, rows);
  });

  return (
    <div className="space-y-4">
      {Modal2FA}
      <PageHeader
        title={t('investments.title')}
        subtitle={t('investments.subtitle')}
        icon={TrendingUp}
        actions={
          <ActionButton onClick={exportCsv} title={t('common.csv')} aria-label={t('common.csv')}>
            <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
            <span className="hidden sm:inline">{t('common.csv')}</span>
          </ActionButton>
        }
      />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('liquidity.lm.filterAria')}>
        <Chip active={filter === ALL_MONTHS} onClick={() => setFilter(ALL_MONTHS)}>
          {t('liquidity.total')}
        </Chip>
        <Select
          aria-label={t('liquidity.lm.year')}
          value={selectedYear}
          onChange={e => {
            setSelectedYear(parseInt(e.target.value));
            setFilter(ALL_MONTHS);
          }}
          className="h-8 w-auto [@media(pointer:coarse)]:h-10"
        >
          {availableYears.map(yr => (
            <option key={yr} value={yr}>{yr}</option>
          ))}
        </Select>
        {Array.from({ length: 12 }, (_, i) => i + 1).map(month => {
          if (!dataByYear.get(selectedYear)?.has(month)) return null;
          const ym = `${selectedYear}-${String(month).padStart(2, '0')}`;
          return (
            <Chip key={month} active={filter === ym} onClick={() => setFilter(ym)}>
              {MONTH_NAMES[month - 1]}
            </Chip>
          );
        })}
      </div>

      <KpiStrip items={kpis} />

      {/* Las filas mixtas traen ganancia y retiro en el mismo renglón, así que
          no se pueden atribuir a una sola categoría. Se avisa en vez de
          esconderlas: son deuda del formato viejo. */}
      {tot.mixedCount > 0 && (
        <Notice kind="pend" title={t('investments.lm.mixedTitle', { count: String(tot.mixedCount) })}>
          {t('investments.lm.mixedBody')}
        </Notice>
      )}

      {/* Resumen por responsable — respeta el mismo filtro de fecha activo.
          Ordenado por saldo desc. Las filas sin responsable se CUENTAN. */}
      {(perResponsible.rows.length > 0 || perResponsible.unassigned > 0) && filtered.length > 0 && (
        <Panel
          title={t('investments.lm.byResponsible')}
          hint={periodLabel}
          flush
          footer={
            perResponsible.unassigned > 0
              ? t('investments.lm.unassigned', { count: String(perResponsible.unassigned) })
              : undefined
          }
        >
          <FinTable
            caption={t('investments.lm.byResponsible')}
            columns={responsibleColumns}
            rows={perResponsible.rows}
            rowKey={(r) => r.responsible}
            empty={t('investments.lm.noResponsible')}
            footer={
              perResponsible.rows.length > 0
                ? {
                    label: perResponsible.unassigned > 0
                      ? t('investments.lm.totalAssigned', { count: String(filtered.length - perResponsible.unassigned), total: String(filtered.length) })
                      : t('investments.lm.total'),
                    values: {
                      deposits: perResponsible.rows.reduce((s, r) => s + r.deposits, 0),
                      withdrawals: -perResponsible.rows.reduce((s, r) => s + r.withdrawals, 0),
                      profit: perResponsible.rows.reduce((s, r) => s + r.profit, 0),
                      balance: perResponsible.rows.reduce((s, r) => s + r.balance, 0),
                    },
                  }
                : undefined
            }
          />
        </Panel>
      )}

      <Panel
        title={t('investments.history')}
        hint={periodLabel}
        flush
        footer={
          filtered.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={NUM_CLASS}>
                {t('liquidity.lm.showing', {
                  from: String(page * PAGE_SIZE + 1),
                  to: String(Math.min((page + 1) * PAGE_SIZE, filtered.length)),
                  total: String(filtered.length),
                })}
              </span>
              {filtered.length > PAGE_SIZE && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className={ROW_ACTION_CLASS}
                    aria-label={t('liquidity.lm.prevPage')}
                  >
                    <ChevronLeft aria-hidden className="size-4" />
                  </button>
                  <span className={cn(NUM_CLASS, 'px-1 text-text-2')}>
                    {t('liquidity.lm.pageOf', { page: String(page + 1), total: String(totalPages) })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className={ROW_ACTION_CLASS}
                    aria-label={t('liquidity.lm.nextPage')}
                  >
                    <ChevronRight aria-hidden className="size-4" />
                  </button>
                </div>
              )}
            </div>
          ) : undefined
        }
      >
        <FinTable
          caption={t('investments.history')}
          columns={historyColumns}
          rows={tableRows}
          rowKey={(r) => r.id}
          empty={t('common.noData')}
          // Los totales son de TODO el filtro, no de la página visible.
          footerRows={
            filtered.length > 0
              ? [
                  { label: t('investments.lm.colContributions'), values: { flow: totalDeposits } },
                  { label: t('investments.lm.colWithdrawals'), values: { flow: -totalWithdrawals } },
                ]
              : undefined
          }
          footer={
            filtered.length > 0
              ? {
                  label: t('liquidity.lm.filterTotal', { count: String(filtered.length) }),
                  values: { flow: totalDeposits - totalWithdrawals, profit: totalProfit, balance: lastBalance },
                }
              : undefined
          }
        />
      </Panel>
    </div>
  );
}

/** Tipo de movimiento (registro único `investment-types.ts`). Sólo «Mixto» lleva color: pide una acción. */
function TypeBadge({ row }: { row: Investment }) {
  const type = inferMovementType(row);
  if (type === 'mixed') return <StatusBadge kind="pend" label={movementTypeLabel(type)} />;
  if (type === null) return <StatusBadge kind="neutral" label={movementTypeLabel(type)} />;
  return <span className="text-[12.5px] text-text-2">{movementTypeLabel(type)}</span>;
}

/** «No hubo» en esa columna (no es «sin dato»). */
function Dash() {
  return <span className={cn(NUM_CLASS, 'text-text-3')}>—</span>;
}
