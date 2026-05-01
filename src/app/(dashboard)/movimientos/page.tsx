'use client';

import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { MovimientosPeriodSelector } from '@/components/movimientos-period-selector';
import {
  RealTimeMovementsBanner,
  DEFAULT_WALLET_ID,
} from '@/components/realtime-movements-banner';
import { useApiCoexistence } from '@/lib/use-api-coexistence';
import { useOrionCrmTotals } from '@/lib/api-integrations/orion-crm/client';
import { ArrowDownCircle, ArrowUpCircle, Wallet, ArrowLeftRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { InfoTip } from '@/components/ui/info-tip';
import { GLOSSARY } from '@/lib/glossary';
import { ConsolidatedBadge } from '@/components/ui/consolidated-badge';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { CHANNEL_LABELS, WITHDRAWAL_LABELS } from '@/lib/types';
import type { Deposit, Withdrawal } from '@/lib/types';
import { downloadCSV } from '@/lib/csv-export';
import { withActiveCompany } from '@/lib/api-fetch';
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
  const { getPeriodSummary, getConsolidatedSummary, periods, company } = useData();

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

  // Keep the Coinsbuy wallet id in page-level state so the banner AND the
  // "Depósitos" table below both filter by the same wallet (prevents the
  // card total ≠ table row total bug).
  //
  // Initial value comes from the tenant's companies.default_wallet_id
  // (migration 031). When that's null the banner's options-load effect
  // swaps in the first API wallet via onWalletChange.
  const [coinsbuyWalletId, setCoinsbuyWalletId] = useState<string>(
    company?.default_wallet_id ?? DEFAULT_WALLET_ID,
  );

  // When the user changes wallet from the banner dropdown, persist it to
  // companies.default_wallet_id so it survives reloads. Empty string ("")
  // means "Todas las wallets" — the endpoint normalises to null. The
  // setState happens immediately so the UI reacts; the API call is
  // fire-and-forget (best-effort persistence; if it fails the local change
  // still applies for this session).
  const handleWalletChange = (next: string) => {
    setCoinsbuyWalletId(next);
    fetch(withActiveCompany('/api/admin/wallet-preference'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletId: next || null }),
    }).catch((err) => {
      console.warn('[movimientos] wallet preference persist failed:', err);
    });
  };
  // Bumped by the banner after a live sync finishes — forces useApiTotals to
  // re-read from the persisted cache so the tables reflect the fresh data.
  const [apiRefreshKey, setApiRefreshKey] = useState(0);

  // Centralized API + manual coexistence (same hook feeds /resumen-general).
  const coexist = useApiCoexistence(activePeriods, coinsbuyWalletId, apiRefreshKey);
  const { useDerivedBroker, apiFrom, apiTo } = coexist;
  // Broker CRM — prop firm sales + P2P transfers. Stub for now (returns 0
  // until the CRM endpoint exists), but wired so the display already sums
  // apiValue + manualValue with zero migration work when the API lands.
  // Orion CRM totals (prop firm sales + P2P transfers) — sums with manual
  // values under the coexistence rule: `displayedValue = apiValue + manual`.
  const brokerCrmTotals = useOrionCrmTotals(apiFrom, apiTo, apiRefreshKey);

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

  // API amounts from the shared coexistence hook (0 for historical periods).
  const { apiCoinsbuy, apiFairpay, apiUnipayment } = coexist;

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
  const apiWithdrawalsTotal = useDerivedBroker ? coexist.apiWithdrawalsTotal : storedBroker;

  // Broker display = API-derived amount + any manual override the user
  // typed in Carga de Datos. They coexist; the user can use the manual
  // column to reflect adjustments the API doesn't know about.
  const derivedBrokerFromApi = coexist.derivedBrokerFromApi(
    ibCommissions,
    propFirmWithdrawal,
    otherWithdrawal,
  );
  const brokerDisplay = useDerivedBroker ? derivedBrokerFromApi + storedBroker : storedBroker;

  // ─── Broker CRM coexistence (Prop Firm sales + P2P) ───
  // Same coexistence rule as Coinsbuy/FairPay/Unipayment: the manual value
  // stored in Supabase is added on top of whatever the CRM reports. When the
  // CRM isn't connected yet, the API side is 0 and only the manual value
  // shows — the UI stays correct either way.
  const apiPropFirmSales = brokerCrmTotals.propFirmSales;
  const manualPropFirmSales = summary.propFirmSales;
  const propFirmSalesDisplay = apiPropFirmSales + manualPropFirmSales;

  const apiP2PTransfer = brokerCrmTotals.p2pTransfer;
  const manualP2PTransfer = summary.p2pTransfer;
  const p2pTransferDisplay = apiP2PTransfer + manualP2PTransfer;

  // Prop-firm net income recomputed with the combined sales value so it
  // tracks what the user sees on screen, not just the stored manual figure.
  const propFirmNetIncomeDisplay = propFirmSalesDisplay - propFirmWithdrawal;

  // ─── Depósitos Broker ───
  // Business rule (Abr-2026+): the "broker" deposits line is derived, not
  // entered. It's whatever's left of the API deposits after subtracting
  // prop-firm sales (which are their own bucket). For historical periods we
  // keep the legacy stored value so nothing moves retroactively.

  // Depósitos Broker = Depósitos Totales (API) − Prop Firm Sales (API + manual).
  // La resta incluye tanto la parte reportada por la API como el manual que el
  // usuario haya cargado en /upload, de modo que el valor refleje la realidad
  // completa de ventas Prop Firm, no solo lo que vino por integración.
  const brokerDepositsDisplay = useDerivedBroker
    ? Math.max(0, apiDepositsTotal - propFirmSalesDisplay)
    : summary.brokerDeposits;

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
      <PageHeader
        title={t('movements.title')}
        subtitle={t('movements.subtitle')}
        icon={ArrowLeftRight}
        actions={
          <>
            <ConsolidatedBadge count={mode === 'consolidated' ? activePeriods.length : 1} />
            <button
              onClick={handleExport}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
              title={t('common.csv')}
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">{t('common.csv')}</span>
            </button>
          </>
        }
      />

      {/* ─── Upper section: APIs en tiempo real (owns its own filter) ─── */}
      <RealTimeMovementsBanner
        walletId={coinsbuyWalletId}
        onWalletChange={handleWalletChange}
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
        <StatCard
          label="Depósitos Totales"
          value={formatCurrency(displayTotalDeposits)}
          hint="Período seleccionado"
          icon={ArrowDownCircle}
          tone="info"
        />
        <StatCard
          label="Retiros Totales"
          value={formatCurrency(displayTotalWithdrawals)}
          hint="Período seleccionado"
          icon={ArrowUpCircle}
          tone="negative"
        />
        <StatCard
          label={<>Depósito Neto <InfoTip text={GLOSSARY.netDeposit} /></>}
          value={formatCurrency(displayNetDeposit)}
          hint="Depósitos − Retiros"
          icon={Wallet}
          tone={displayNetDeposit >= 0 ? 'positive' : 'negative'}
        />
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
                  ? coexist.apiTotalsBy[apiSlug] ?? 0
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
                <td className="py-1">
                  <span className="inline-flex items-center gap-1.5">
                    {t('movements.propFirmSales')}
                    <InfoTip text={GLOSSARY.propFirm} />
                  </span>
                </td>
                <td className="py-1 text-right">{formatCurrency(propFirmSalesDisplay)}</td>
              </tr>
              <tr className="text-muted-foreground">
                <td className="py-1">
                  <span className="inline-flex items-center gap-1.5">
                    {t('movements.brokerDeposits')}
                    <InfoTip text={GLOSSARY.brokerDeposits} />
                  </span>
                  {useDerivedBroker && (
                    <span className="ml-2 text-[10px] text-muted-foreground/80 uppercase tracking-wide">
                      total api − prop firm
                    </span>
                  )}
                </td>
                <td className="py-1 text-right">{formatCurrency(brokerDepositsDisplay)}</td>
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
                <td className="py-1">
                  {t('movements.p2pTransfer')}
                  {brokerCrmTotals.connected && apiP2PTransfer > 0 && manualP2PTransfer > 0 && (
                    <span className="ml-2 text-[10px] text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">
                      api+manual
                    </span>
                  )}
                </td>
                <td className="py-1 text-right">
                  {formatCurrency(p2pTransferDisplay)}
                  {brokerCrmTotals.connected && apiP2PTransfer > 0 && manualP2PTransfer > 0 && (
                    <span className="block text-[10px] text-muted-foreground">
                      {formatCurrency(apiP2PTransfer)} API + {formatCurrency(manualP2PTransfer)} manual
                    </span>
                  )}
                </td>
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
                <td className="py-2.5">
                  {t('movements.propFirmSales')}
                  {brokerCrmTotals.connected && apiPropFirmSales > 0 && manualPropFirmSales > 0 ? (
                    <span className="ml-2 text-[10px] text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">
                      api+manual
                    </span>
                  ) : (
                    <span className="ml-2 text-[10px] text-muted-foreground uppercase tracking-wide">
                      {brokerCrmTotals.connected ? 'api' : 'manual'}
                    </span>
                  )}
                </td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(propFirmSalesDisplay)}
                  {brokerCrmTotals.connected && apiPropFirmSales > 0 && manualPropFirmSales > 0 && (
                    <span className="block text-[10px] text-muted-foreground">
                      {formatCurrency(apiPropFirmSales)} API + {formatCurrency(manualPropFirmSales)} manual
                    </span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-2.5">{t('movements.propFirmWithdrawals')}</td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(propFirmWithdrawal)}
                </td>
              </tr>
              <tr className="font-bold">
                <td className="py-3">{t('movements.netIncome')}</td>
                <td className="py-3 text-right">{formatCurrency(propFirmNetIncomeDisplay)}</td>
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
                <td className="py-2.5">
                  <span className="inline-flex items-center gap-1.5">
                    Broker P&L (Libro B)
                    <InfoTip text={GLOSSARY.libroB} />
                  </span>
                </td>
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
