'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /liquidez — rediseño «Libro mayor» (2026-10-12, docs/diseno-libro-mayor.md)
//
// QUÉ CAMBIÓ (sólo presentación; el saldo corrido sigue saliendo de
// `useRunningBalance`, la misma fórmula que /inversiones y /balances):
//   · Tres StatCard → UNA franja de KPIs: Saldo actual (hero), Entradas,
//     Salidas y Neto del filtro (color por signo: ahí el signo es la noticia).
//     Antes «Ingreso» era azul y «Salida» roja de paleta cruda en cada fila.
//   · Saldo por cuenta MT: de una grilla de tarjetas a una FinTable con el
//     atribuido en el pie y el saldo total al lado. Lo no atribuido es un
//     `Notice pend` con la cifra, no una línea ámbar de paleta cruda.
//   · Historial en FinTable (montos con signo en tinta neutra, saldo corrido a
//     la derecha, total del filtro en el pie con la doble raya).
//
// DOS BUGS QUE SE VEÍAN COMO NÚMEROS PLAUSIBLES (arreglados acá):
//   1. «Faltan $X por atribuir» comparaba lo atribuido (saldo de SIEMPRE por
//      cuenta) contra el saldo al cierre del MES filtrado. Con un mes elegido
//      inventaba una diferencia. Ahora compara contra el saldo de todo el
//      histórico (`attributionGap`, con test).
//   2. Sin movimientos el saldo era $0.00. Ahora es «—» (`closingBalance`
//      devuelve null): «no hay libro» no es «el libro está en cero» (§1.3).
//   Y el mes de cada fila sale del texto `YYYY-MM-DD`, no de `new Date()`
//   (en UTC-3 el día 1 caía en el mes anterior; ver ledger-month-filter.ts).
//
// DESCARTADO:
//   · Mover el filtro al selector de período de la topbar: ése es el período
//     CONTABLE de la empresa y Liquidez no lo usa (sus meses salen de los
//     movimientos). Dos selectores que dicen cosas distintas serían peor.
//   · Paginar con `totalCount` de FinTable: no es un recorte, es paginación;
//     el pie de la tabla ya cuenta «a–b de N» y el total usa las N.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { Droplets, Download, ChevronLeft, ChevronRight, Scale } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { Notice } from '@/components/ui/notice';
import { Chip } from '@/components/ui/chip';
import { Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { ActionButton, actionButtonClass, ROW_ACTION_CLASS } from '@/components/ui/action-button';
import { useData } from '@/lib/data-context';
import { formatDate } from '@/lib/dates';
import { downloadCSV } from '@/lib/csv-export';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useI18n } from '@/lib/i18n';
import { apiFetch } from '@/lib/api-fetch';
import { useRunningBalance } from '@/lib/use-running-balance';
import { ALL_MONTHS, closingBalance, filterByMonth, monthsByYear } from '@/lib/ledger-month-filter';
import type { LiquidityMovement } from '@/lib/types';
import { accountBalanceRows, attributionGap } from './liquidity-view';

const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const PAGE_SIZE = 50;

// La primera columna es el concepto (la etiqueta del total del pie cae ahí:
// en una columna «#» de 48 px no entraba). El número de fila se fue: el pie
// ya dice «a–b de N».
type MovRow = LiquidityMovement;
interface AccountRow { id: string; mt_number: string; label: string | null; balance: number }

export default function LiquidezPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { getLiquidityData } = useData();
  const [filter, setFilter] = useState(ALL_MONTHS);
  // Read directly from the data-context on every render — previously the
  // page copied it into local state via `useEffect`, which created a
  // one-tick lag after a mutation and flashed stale rows.
  const liquidityData = useMemo(() => getLiquidityData(), [getLiquidityData]);

  const dataByYear = useMemo(() => monthsByYear(liquidityData), [liquidityData]);
  const availableYears = useMemo(() => Array.from(dataByYear.keys()).sort(), [dataByYear]);

  // El año elegido; hasta que alguien elija, el más reciente con datos
  // (derivado en el render: antes era un setState dentro de un effect, que
  // pintaba un cuadro con el año 0 antes de corregirse).
  const [pickedYear, setSelectedYear] = useState<number | null>(null);
  const selectedYear = pickedYear ?? availableYears.at(-1) ?? 0;

  const filtered = useMemo(() => filterByMonth(liquidityData, filter), [filter, liquidityData]);

  // Running balance map — computed on-the-fly from ALL movements sorted by
  // date ascending. We don't trust the stored `balance` column because
  // addLiquidityRow inserts it as 0 (legacy bug). Shared helper in
  // `useRunningBalance` keeps /liquidez, /inversiones, and /balances in sync.
  const balanceMap = useRunningBalance(liquidityData, m => m.deposit - m.withdrawal);

  // Saldo al cierre del filtro (total = el saldo de hoy; un mes = el saldo al
  // final de ese mes, con todo lo anterior). null = no hay movimientos.
  const lastBalance = useMemo(
    () => closingBalance(filtered.length > 0 ? filtered : liquidityData, balanceMap),
    [filtered, liquidityData, balanceMap],
  );
  // El saldo de HOY, independiente del filtro: contra éste se compara el
  // desglose por cuenta, que también es de todo el histórico.
  const overallBalance = useMemo(() => closingBalance(liquidityData, balanceMap), [liquidityData, balanceMap]);

  const totalDeposits = filtered.reduce((s, m) => s + m.deposit, 0);
  const totalWithdrawals = filtered.reduce((s, m) => s + m.withdrawal, 0);

  // ── Desglose por cuenta MT (migración 062) ────────────────────────────
  // Se reusa el endpoint de conciliación: ya devuelve el catálogo, el saldo
  // por cuenta y lo pendiente. Un endpoint aparte sería una segunda copia del
  // mismo cálculo, que en este proyecto siempre termina divergiendo.
  const [accounts, setAccounts] = useState<Array<{ id: string; mt_number: string; label: string | null }>>([]);
  const [balancesByAccount, setBalancesByAccount] = useState<Record<string, number>>({});
  const [pendingCount, setPendingCount] = useState(0);
  // El desglose es un extra: si el endpoint falla, la página sigue — pero se
  // DICE, porque una sección que desaparece se lee como «no hay cuentas».
  const [breakdownFailed, setBreakdownFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/admin/liquidity-reconcile')
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.success) { setBreakdownFailed(true); return; }
        setAccounts(json.accounts ?? []);
        setBalancesByAccount(json.balancesByAccount ?? {});
        setPendingCount((json.pending ?? []).length);
      })
      .catch(() => { if (!cancelled) setBreakdownFailed(true); });
    return () => { cancelled = true; };
  }, []);

  // Solo las cuentas con movimientos: el catálogo tiene 23 y mostrar las
  // vacías llenaría la pantalla de ceros sin información.
  const accountRows: AccountRow[] = useMemo(
    () => accountBalanceRows(accounts, balancesByAccount),
    [accounts, balancesByAccount],
  );

  const assignedTotal = useMemo(
    () => accountRows.reduce((s, a) => s + a.balance, 0),
    [accountRows],
  );
  const gap = attributionGap(assignedTotal, overallBalance);

  // La página vuelve a 0 cuando cambia el filtro o la cantidad de filas: la
  // página guardada sólo vale para la clave con la que se guardó.
  const pageKey = `${filter}|${liquidityData.length}`;
  const [pageState, setPageState] = useState({ key: pageKey, page: 0 });
  const page = pageState.key === pageKey ? pageState.page : 0;
  const setPage = (fn: (p: number) => number) => setPageState({ key: pageKey, page: fn(page) });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pagedRows = useMemo(
    () => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filtered, page],
  );

  const tableRows: MovRow[] = pagedRows;

  const periodLabel = filter === ALL_MONTHS
    ? t('liquidity.lm.allHistory')
    : `${MONTH_NAMES[Number(filter.slice(5, 7)) - 1]} ${filter.slice(0, 4)}`;
  const empty = liquidityData.length === 0;

  const kpis: KpiItem[] = [
    {
      key: 'balance',
      label: t('liquidity.currentBalance'),
      value: lastBalance,
      hero: true,
      sub: empty ? t('liquidity.lm.noMovements') : filter === ALL_MONTHS ? t('liquidity.lm.balanceToday') : t('liquidity.lm.balanceAtEnd', { period: periodLabel }),
      missingBadge: false,
    },
    {
      key: 'in',
      label: t('liquidity.lm.inflows'),
      value: empty ? null : totalDeposits,
      sub: t('liquidity.lm.movementsCount', { count: String(filtered.filter((m) => m.deposit > 0).length) }),
      missingBadge: false,
    },
    {
      key: 'out',
      // «Salidas» cubre retiros reales y pérdidas (comisiones, transferencias
      // fallidas, etc) en un solo término.
      label: t('liquidity.lm.outflows'),
      value: empty ? null : totalWithdrawals,
      sub: t('liquidity.lm.movementsCount', { count: String(filtered.filter((m) => m.withdrawal > 0).length) }),
      missingBadge: false,
    },
    {
      key: 'net',
      label: t('liquidity.lm.net'),
      value: empty ? null : totalDeposits - totalWithdrawals,
      tone: 'sign',
      sub: periodLabel,
      missingBadge: false,
    },
  ];

  const accountColumns: FinColumn<AccountRow>[] = [
    {
      key: 'account',
      header: t('liquidity.lm.colAccount'),
      cell: (a) => <span className={NUM_CLASS}>{a.mt_number}</span>,
      meta: (a) => a.label ?? undefined,
    },
    { key: 'balance', header: t('liquidity.lm.colBalance'), kind: 'money', value: (a) => a.balance },
  ];

  const movementColumns: FinColumn<MovRow>[] = [
    {
      key: 'concept',
      header: t('liquidity.lm.colConcept'),
      cell: (m) => <span className="block max-w-[260px] truncate" title={m.user_email ?? undefined}>{m.user_email || '—'}</span>,
      meta: (m) => m.mt_account || undefined,
      mobileMeta: (m) => <span className={NUM_CLASS}>{formatDate(m.date)}</span>,
    },
    {
      key: 'date',
      header: t('liquidity.lm.colDate'),
      cell: (m) => <span className={cn(NUM_CLASS, 'text-text-2')}>{formatDate(m.date)}</span>,
      hideSm: true,
    },
    {
      // Una sola columna con signo (+ entrada / − salida) en vez de dos
      // columnas con un guion en la mitad de las celdas; las entradas y las
      // salidas del filtro van separadas en el pie.
      key: 'net',
      header: t('liquidity.lm.colMovement'),
      kind: 'money',
      value: (m) => m.deposit - m.withdrawal,
      money: { signed: true, tone: 'neutral' },
      subtotal: false,
    },
    {
      key: 'balance',
      header: t('liquidity.lm.colRunning'),
      kind: 'money',
      value: (m) => balanceMap.get(m.id) ?? null,
      subtotal: false,
    },
  ];

  const exportCsv = () => verify2FA(() => {
    const headers = ['Fecha', 'Concepto', 'Descripción', '+', '-', 'Balance'];
    const rows = filtered.map(m => [m.date, m.user_email || '', m.mt_account || '', m.deposit, m.withdrawal, balanceMap.get(m.id) ?? ''] as (string | number)[]);
    downloadCSV('liquidez.csv', headers, rows);
  });

  return (
    <div className="space-y-4">
      {Modal2FA}
      <PageHeader
        title={t('liquidity.title')}
        subtitle={t('liquidity.subtitle')}
        icon={Droplets}
        actions={
          <>
            {/* Conciliación: mientras haya movimientos sin cuenta MT, el saldo
                por cuenta no es confiable. El acceso vive acá al lado. */}
            <Link href="/liquidez/conciliacion" className={actionButtonClass('secondary')} aria-label={t('liquidity.lm.reconcile')}>
              <Scale aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t('liquidity.lm.reconcile')}</span>
            </Link>
            <ActionButton onClick={exportCsv} title={t('common.csv')} aria-label={t('common.csv')}>
              <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t('common.csv')}</span>
            </ActionButton>
          </>
        }
      />

      {/* Filtro de meses: los que TIENEN movimientos (no el período contable). */}
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

      {/* ─── Avisos de estado del dato ─── */}
      {pendingCount > 0 && (
        <Notice
          kind="pend"
          title={t('liquidity.lm.pendingTitle', { count: String(pendingCount) })}
          action={<Link href="/liquidez/conciliacion" className="text-[13px] font-medium text-foreground underline underline-offset-2">{t('liquidity.lm.reconcile')}</Link>}
        >
          {t('liquidity.lm.pendingBody')}
        </Notice>
      )}
      {breakdownFailed && (
        <Notice kind="pend" title={t('liquidity.lm.breakdownFailed')}>
          {t('liquidity.lm.breakdownFailedBody')}
        </Notice>
      )}

      {/* Desglose por cuenta MT. Mientras queden movimientos sin atribuir, el
          desglose NO cuadra con el saldo total — decirlo es la diferencia
          entre una tabla útil y una que engaña. */}
      {(accountRows.length > 0 || pendingCount > 0) && (
        <Panel
          title={t('liquidity.lm.byAccount')}
          hint={t('liquidity.lm.byAccountHint')}
          flush
          footer={
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                {t('liquidity.lm.bookBalance')}{' '}
                <Money value={overallBalance} className="font-medium text-foreground" />
              </span>
              {gap.gap !== null && !gap.matches && (
                <span>
                  {gap.gap > 0 ? t('liquidity.lm.unattributed') : t('liquidity.lm.overAttributed')}{' '}
                  <Money value={Math.abs(gap.gap)} tone="neg" className="font-medium" />
                </span>
              )}
            </div>
          }
        >
          <FinTable
            caption={t('liquidity.lm.byAccount')}
            columns={accountColumns}
            rows={accountRows}
            rowKey={(a) => a.id}
            empty={t('liquidity.lm.noAttributed')}
            footer={
              accountRows.length > 0
                ? {
                    label: t('liquidity.lm.attributedTotal', { count: String(accountRows.length) }),
                    values: { balance: assignedTotal },
                  }
                : undefined
            }
          />
        </Panel>
      )}

      <Panel
        title={t('liquidity.history')}
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
          caption={t('liquidity.history')}
          columns={movementColumns}
          rows={tableRows}
          rowKey={(m) => m.id}
          empty={t('common.noData')}
          // Los totales son de TODO el filtro, no de la página visible.
          footerRows={
            filtered.length > 0
              ? [
                  { label: t('liquidity.lm.inflows'), values: { net: totalDeposits } },
                  { label: t('liquidity.lm.outflows'), values: { net: -totalWithdrawals } },
                ]
              : undefined
          }
          footer={
            filtered.length > 0
              ? {
                  label: t('liquidity.lm.filterTotal', { count: String(filtered.length) }),
                  values: { net: totalDeposits - totalWithdrawals, balance: lastBalance },
                }
              : undefined
          }
        />
      </Panel>
    </div>
  );
}

