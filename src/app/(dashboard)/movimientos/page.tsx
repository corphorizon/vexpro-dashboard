'use client';

import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { MovimientosPeriodSelector } from '@/components/movimientos-period-selector';
import {
  RealTimeMovementsBanner,
  useApiTotals,
  DEFAULT_WALLET_ID,
} from '@/components/realtime-movements-banner';
import {
  allPeriodsUseDerivedBroker,
  computeDerivedBroker,
} from '@/lib/broker-logic';
import { ArrowDownCircle, ArrowUpCircle, Wallet } from 'lucide-react';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { CHANNEL_LABELS, WITHDRAWAL_LABELS } from '@/lib/types';
import type { Deposit, Withdrawal } from '@/lib/types';
import { downloadCSV } from '@/lib/csv-export';
import { useAuth } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useI18n } from '@/lib/i18n';
import { Download } from 'lucide-react';

// Channels shown in the "Depósitos del período" card. "Otros" is included
// because it's a manual-entry field that still gets stored in Supabase.
const ALL_CHANNELS: Array<'coinsbuy' | 'fairpay' | 'unipayment' | 'other'> = [
  'coinsbuy',
  'fairpay',
  'unipayment',
  'other',
];
const ALL_CATEGORIES: Array<'ib_commissions' | 'broker' | 'prop_firm' | 'other'> = [
  'ib_commissions',
  'broker',
  'prop_firm',
  'other',
];

export default function MovimientosPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();
  const { getPeriodSummary, getConsolidatedSummary, periods } = useData();

  const summary =
    mode === 'consolidated'
      ? getConsolidatedSummary(selectedPeriodIds)
      : getPeriodSummary(selectedPeriodId);

  // ── Broker logic cutoff (April 2026+) ──
  // Only when EVERY active period is on the new rule do we switch to the
  // derived broker computation. Any consolidation that includes historical
  // months falls back to the stored values so history stays untouched.
  const activePeriods = useMemo(() => {
    const ids =
      mode === 'consolidated' ? selectedPeriodIds : [selectedPeriodId];
    return periods.filter((p) => ids.includes(p.id));
  }, [mode, selectedPeriodId, selectedPeriodIds, periods]);

  const useDerivedBroker = useMemo(
    () => allPeriodsUseDerivedBroker(activePeriods),
    [activePeriods]
  );

  // Date range to ask the API for Coinsbuy withdrawals. Spans from the first
  // day of the earliest active period to the last day of the latest.
  const { apiFrom, apiTo } = useMemo(() => {
    if (!useDerivedBroker || activePeriods.length === 0) {
      return { apiFrom: '', apiTo: '' };
    }
    const sorted = [...activePeriods].sort(
      (a, b) => a.year - b.year || a.month - b.month
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const pad = (n: number) => String(n).padStart(2, '0');
    const lastDay = new Date(last.year, last.month, 0).getDate();
    return {
      apiFrom: `${first.year}-${pad(first.month)}-01`,
      apiTo: `${last.year}-${pad(last.month)}-${pad(lastDay)}`,
    };
  }, [useDerivedBroker, activePeriods]);

  // Keep the Coinsbuy wallet id in page-level state so the banner AND the
  // "Depósitos" table below both filter by the same wallet (prevents the
  // card total ≠ table row total bug).
  const [coinsbuyWalletId, setCoinsbuyWalletId] = useState<string>(DEFAULT_WALLET_ID);
  // Bumped by the banner after a live sync finishes — forces useApiTotals to
  // re-read from the persisted cache so the tables reflect the fresh data.
  const [apiRefreshKey, setApiRefreshKey] = useState(0);
  const apiTotals = useApiTotals(apiFrom, apiTo, coinsbuyWalletId, apiRefreshKey);

  const handleExport = () => verify2FA(() => {
    if (!summary) return;
    const headers = [t('movements.type'), t('movements.category'), t('movements.amount')];
    const rows: (string | number)[][] = [
      ...summary.deposits.map(
        (d) =>
          [t('movements.deposit'), CHANNEL_LABELS[d.channel], d.amount] as (string | number)[]
      ),
      ...summary.withdrawals.map(
        (w) =>
          [t('movements.withdrawal'), WITHDRAWAL_LABELS[w.category], w.amount] as (
            | string
            | number
          )[]
      ),
      ['', 'Net Deposit', displayNetDeposit],
    ];
    downloadCSV(
      `movimientos_${(summary.period.label || 'export').replace(/\s/g, '_')}.csv`,
      headers,
      rows
    );
  });

  // Ensure all channels/categories always appear, even with $0
  const fullDeposits: Deposit[] = useMemo(() => {
    if (!summary) return [];
    return ALL_CHANNELS.map((ch) => {
      const existing = summary.deposits.find((d) => d.channel === ch);
      return (
        existing || {
          id: `empty-d-${ch}`,
          period_id: '',
          company_id: '',
          channel: ch,
          amount: 0,
          notes: null,
        }
      );
    });
  }, [summary]);

  const fullWithdrawals: Withdrawal[] = useMemo(() => {
    if (!summary) return [];
    return ALL_CATEGORIES.map((cat) => {
      const existing = summary.withdrawals.find((w) => w.category === cat);
      return (
        existing || {
          id: `empty-w-${cat}`,
          period_id: '',
          company_id: '',
          category: cat,
          amount: 0,
          notes: null,
        }
      );
    });
  }, [summary]);

  if (!summary) return null;

  // ─── Consolidación API + manual ───
  // Both sources coexist and add up. For each channel/category the displayed
  // number is (API amount when applicable) + (manual amount stored in
  // Supabase). The manual entry is never overwritten or hidden by the API.

  // Manual values per deposit channel (may be 0 if the user didn't enter any).
  const manualCoinsbuy = summary.deposits.find((d) => d.channel === 'coinsbuy')?.amount || 0;
  const manualFairpay = summary.deposits.find((d) => d.channel === 'fairpay')?.amount || 0;
  const manualUnipayment = summary.deposits.find((d) => d.channel === 'unipayment')?.amount || 0;
  const otherDeposits = summary.deposits.find((d) => d.channel === 'other')?.amount || 0;

  // API amounts (0 when not a derived-logic period or when the API cache is
  // empty). These are whatever `api_transactions` holds for the active
  // period's date range.
  const apiCoinsbuy = useDerivedBroker ? apiTotals.by['coinsbuy-deposits'] ?? 0 : 0;
  const apiFairpay = useDerivedBroker ? apiTotals.by['fairpay'] ?? 0 : 0;
  const apiUnipayment = useDerivedBroker ? apiTotals.by['unipayment'] ?? 0 : 0;

  // Per-channel totals shown in the table rows.
  const coinsbuyDisplay = apiCoinsbuy + manualCoinsbuy;
  const fairpayDisplay = apiFairpay + manualFairpay;
  const unipaymentDisplay = apiUnipayment + manualUnipayment;

  // "Depósitos Totales (API)" — the sum of the three API-backed channels,
  // including any manual entry the user added for those channels.
  const apiDepositsTotal = coinsbuyDisplay + fairpayDisplay + unipaymentDisplay;

  // Stored manual amounts per withdrawal category.
  const storedBroker = summary.withdrawals.find((w) => w.category === 'broker')?.amount || 0;
  const ibCommissions = summary.withdrawals.find((w) => w.category === 'ib_commissions')?.amount || 0;
  const propFirmWithdrawal = summary.withdrawals.find((w) => w.category === 'prop_firm')?.amount || 0;
  const otherWithdrawal = summary.withdrawals.find((w) => w.category === 'other')?.amount || 0;

  // "Retiros Totales (API)" tracks the real Coinsbuy-side outflow. For
  // historical periods it reduces to the stored broker value.
  const apiWithdrawalsTotal = useDerivedBroker ? apiTotals.withdrawalsTotal : storedBroker;

  // Broker display = API-derived amount + any manual override the user
  // typed in Carga de Datos. They coexist; the user can use the manual
  // column to reflect adjustments the API doesn't know about.
  const derivedBrokerFromApi = useDerivedBroker
    ? computeDerivedBroker({
        apiWithdrawalsTotal,
        ibCommissions,
        propFirm: propFirmWithdrawal,
        other: otherWithdrawal,
      })
    : 0;
  const brokerDisplay = useDerivedBroker ? derivedBrokerFromApi + storedBroker : storedBroker;

  // Consolidated totals = sum of all channels/categories (API+manual).
  const displayTotalDeposits = useDerivedBroker
    ? apiDepositsTotal + otherDeposits
    : summary.totalDeposits;
  const displayTotalWithdrawals = useDerivedBroker
    ? ibCommissions + brokerDisplay + propFirmWithdrawal + otherWithdrawal
    : summary.totalWithdrawals;
  const displayNetDeposit = useDerivedBroker
    ? displayTotalDeposits - displayTotalWithdrawals
    : summary.netDeposit;

  return (
    <div className="space-y-6">
      {Modal2FA}
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('movements.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('movements.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors flex-shrink-0"
            title={t('common.csv')}
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">{t('common.csv')}</span>
          </button>
        </div>
      </div>

      {/* ─── Upper section: APIs en tiempo real (owns its own filter) ─── */}
      <RealTimeMovementsBanner
        walletId={coinsbuyWalletId}
        onWalletChange={setCoinsbuyWalletId}
        onAfterLiveSync={() => setApiRefreshKey((k) => k + 1)}
      />

      {/* ─── Lower section: Datos del período (mes) ─── */}
      <div className="flex flex-col gap-3 pt-2 border-t border-border">
        <div>
          <h2 className="text-lg font-semibold">Datos del período</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Depósitos, retiros, Prop Firm y Broker del mes seleccionado. Puedes
            elegir varios meses para consolidar los totales.
          </p>
        </div>
        <MovimientosPeriodSelector />
      </div>

      {/* ─── Summary cards: Depósitos / Retiros / Net Deposit ─── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Depósitos Totales */}
        <Card className="border-blue-200/60 dark:border-blue-900/60 bg-gradient-to-br from-blue-50/60 to-transparent dark:from-blue-950/20">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Depósitos Totales
              </p>
              <p className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1 truncate">
                {formatCurrency(displayTotalDeposits)}
              </p>
              {/* Deposits are unchanged by broker logic — they are always the
                  stored/summary value for both historical and new periods. */}
              <p className="text-[11px] text-muted-foreground mt-1">
                Período seleccionado
              </p>
            </div>
            <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-950/40 flex-shrink-0">
              <ArrowDownCircle className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            </div>
          </div>
        </Card>

        {/* Retiros Totales */}
        <Card className="border-red-200/60 dark:border-red-900/60 bg-gradient-to-br from-red-50/60 to-transparent dark:from-red-950/20">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Retiros Totales
              </p>
              <p className="text-2xl font-bold text-red-600 dark:text-red-400 mt-1 truncate">
                {formatCurrency(displayTotalWithdrawals)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Período seleccionado
              </p>
            </div>
            <div className="p-2 rounded-lg bg-red-100 dark:bg-red-950/40 flex-shrink-0">
              <ArrowUpCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
            </div>
          </div>
        </Card>

        {/* Net Deposit */}
        <Card
          className={`bg-gradient-to-br to-transparent ${
            displayNetDeposit >= 0
              ? 'border-emerald-200/60 dark:border-emerald-900/60 from-emerald-50/60 dark:from-emerald-950/20'
              : 'border-red-200/60 dark:border-red-900/60 from-red-50/60 dark:from-red-950/20'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Net Deposit
              </p>
              <p
                className={`text-2xl font-bold mt-1 truncate ${
                  displayNetDeposit >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400'
                }`}
              >
                {formatCurrency(displayNetDeposit)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Depósitos − Retiros
              </p>
            </div>
            <div
              className={`p-2 rounded-lg flex-shrink-0 ${
                displayNetDeposit >= 0
                  ? 'bg-emerald-100 dark:bg-emerald-950/40'
                  : 'bg-red-100 dark:bg-red-950/40'
              }`}
            >
              <Wallet
                className={`w-5 h-5 ${
                  displayNetDeposit >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400'
                }`}
              />
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Depósitos */}
        <Card>
          <h2 className="text-lg font-semibold mb-4 text-blue-600">
            {t('movements.depositsTab')}
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 text-muted-foreground font-medium">
                  {t('movements.channel')}
                </th>
                <th className="text-right py-2 text-muted-foreground font-medium">
                  {t('movements.amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {fullDeposits.map((d) => {
                // API + manual coexist: per-channel display = API amount
                // (when this period uses derived broker logic) + manual
                // entry from Supabase `deposits` table.
                const API_SLUG_MAP: Record<string, 'coinsbuy-deposits' | 'fairpay' | 'unipayment'> = {
                  coinsbuy: 'coinsbuy-deposits',
                  fairpay: 'fairpay',
                  unipayment: 'unipayment',
                };
                const apiSlug = API_SLUG_MAP[d.channel];
                const apiAmount = useDerivedBroker && apiSlug
                  ? apiTotals.by[apiSlug] ?? 0
                  : 0;
                const manualAmount = d.amount;
                const displayAmount = apiAmount + manualAmount;
                const isApiChannel = !!apiSlug;

                return (
                  <tr key={d.id} className="border-b border-border/50">
                    <td className="py-2.5">
                      {CHANNEL_LABELS[d.channel]}
                      {d.channel === 'other' && (
                        <span className="ml-2 text-[10px] text-muted-foreground uppercase tracking-wide">
                          manual
                        </span>
                      )}
                      {isApiChannel && useDerivedBroker && (
                        <span className="ml-2 text-[10px] text-emerald-500 uppercase tracking-wide">
                          api
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right font-medium">
                      {formatCurrency(displayAmount)}
                      {/* Breakdown when both sources contribute — shows the
                          user that manual + API are coexisting, not fighting. */}
                      {isApiChannel && useDerivedBroker && apiAmount > 0 && manualAmount > 0 && (
                        <span className="block text-[10px] text-muted-foreground">
                          {formatCurrency(apiAmount)} API + {formatCurrency(manualAmount)} manual
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-bold">
                <td className="py-3">Depósitos Totales (API)</td>
                <td className="py-3 text-right text-blue-600">
                  {formatCurrency(apiDepositsTotal)}
                </td>
              </tr>
              <tr className="text-muted-foreground">
                <td className="py-1">{t('movements.propFirmSales')}</td>
                <td className="py-1 text-right">{formatCurrency(summary.propFirmSales)}</td>
              </tr>
              <tr className="text-muted-foreground">
                <td className="py-1">{t('movements.brokerDeposits')}</td>
                <td className="py-1 text-right">{formatCurrency(summary.brokerDeposits)}</td>
              </tr>
            </tfoot>
          </table>
        </Card>

        {/* Retiros */}
        <Card>
          <h2 className="text-lg font-semibold mb-4 text-red-600">
            {t('movements.withdrawalsTab')}
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 text-muted-foreground font-medium">
                  {t('movements.category')}
                </th>
                <th className="text-right py-2 text-muted-foreground font-medium">
                  {t('movements.amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {fullWithdrawals.map((w) => {
                // Broker = derived-from-API + manual override. Other
                // categories are manual-only.
                const displayAmount =
                  w.category === 'broker' ? brokerDisplay : w.amount;
                const isBroker = w.category === 'broker';
                const hasBothSources =
                  isBroker && useDerivedBroker && derivedBrokerFromApi > 0 && storedBroker > 0;
                return (
                  <tr key={w.id} className="border-b border-border/50">
                    <td className="py-2.5">
                      {WITHDRAWAL_LABELS[w.category]}
                      {isBroker && useDerivedBroker ? (
                        <span className="ml-2 text-[10px] text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">
                          api+manual
                        </span>
                      ) : (
                        <span className="ml-2 text-[10px] text-muted-foreground uppercase tracking-wide">
                          manual
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right font-medium">
                      {formatCurrency(displayAmount)}
                      {hasBothSources && (
                        <span className="block text-[10px] text-muted-foreground">
                          {formatCurrency(derivedBrokerFromApi)} API + {formatCurrency(storedBroker)} manual
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-bold">
                <td className="py-3">Retiros Totales (API)</td>
                <td className="py-3 text-right text-red-600">
                  {formatCurrency(apiWithdrawalsTotal)}
                </td>
              </tr>
              <tr className="text-muted-foreground">
                <td className="py-1">{t('movements.p2pTransfer')}</td>
                <td className="py-1 text-right">{formatCurrency(summary.p2pTransfer)}</td>
              </tr>
              <tr className="font-bold border-t border-border">
                <td className="py-3">{t('movements.netDeposit')}</td>
                <td
                  className={`py-3 text-right ${
                    displayNetDeposit >= 0 ? 'text-emerald-600' : 'text-red-600'
                  }`}
                >
                  {formatCurrency(displayNetDeposit)}
                </td>
              </tr>
            </tfoot>
          </table>
        </Card>

        {/* Balance Prop Firm */}
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('movements.balancePropFirm')}</h2>
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-border/50">
                <td className="py-2.5">{t('movements.propFirmSales')}</td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(summary.propFirmSales)}
                </td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-2.5">{t('movements.propFirmWithdrawals')}</td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(
                    summary.withdrawals.find((w) => w.category === 'prop_firm')?.amount || 0
                  )}
                </td>
              </tr>
              <tr className="font-bold">
                <td className="py-3">{t('movements.netIncome')}</td>
                <td className="py-3 text-right">{formatCurrency(summary.propFirmNetIncome)}</td>
              </tr>
            </tbody>
          </table>
        </Card>

        {/* Balance Broker */}
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('movements.balanceBroker')}</h2>
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-border/50">
                <td className="py-2.5">Broker P&L (Libro B)</td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(summary.operatingIncome?.broker_pnl || 0)}
                </td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-2.5">Otros</td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(summary.operatingIncome?.other || 0)}
                </td>
              </tr>
              <tr className="font-bold">
                <td className="py-3">{t('movements.totalBroker')}</td>
                <td className="py-3 text-right">
                  {formatCurrency(
                    (summary.operatingIncome?.broker_pnl || 0) +
                      (summary.operatingIncome?.other || 0)
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
