'use client';

import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { StatCard } from '@/components/ui/stat-card';
import { MovimientosPeriodSelector } from '@/components/movimientos-period-selector';
import {
  RealTimeMovementsBanner,
  DEFAULT_WALLET_ID,
} from '@/components/realtime-movements-banner';
import { useApiCoexistence } from '@/lib/use-api-coexistence';
import { computeDerivedNetDeposit } from '@/lib/broker-logic';
import { ArrowDownCircle, ArrowUpCircle, Wallet, ArrowLeftRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { InfoTip } from '@/components/ui/info-tip';
import { GLOSSARY } from '@/lib/glossary';
import { ConsolidatedBadge } from '@/components/ui/consolidated-badge';
import { usePeriod } from '@/lib/period-context';
import { NoPeriodsState } from '@/components/no-periods-state';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { WITHDRAWAL_LABELS } from '@/lib/types';
import {
  ALL_DEPOSIT_CHANNELS,
  apiSlugForChannel,
  depositChannelLabel,
  manualDepositsByChannel,
} from '@/lib/deposit-channels';
import {
  API_WITHDRAWAL_CHANNELS,
  withdrawalChannelLabel,
} from '@/lib/withdrawal-channels';
import type { Deposit, Withdrawal } from '@/lib/types';
import { downloadCSV } from '@/lib/csv-export';
import { apiFetch } from '@/lib/api-fetch';
import { useAuth } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useI18n } from '@/lib/i18n';
import { Download } from 'lucide-react';

// Los canales de la tarjeta «Depósitos del período» salen del registro único
// (src/lib/deposit-channels.ts). Antes eran una lista dura acá y otra en el
// hook, y cuando entró Pay-Pros ninguna de las dos se enteró: la pantalla
// mostraba $44.653,95 menos que el backend. Ver la cabecera del registro.
const ALL_CHANNELS = ALL_DEPOSIT_CHANNELS;
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
  const { getPeriodSummary, getConsolidatedSummary, periods, company, loading } = useData();

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
    apiFetch('/api/admin/wallet-preference', {
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
  //
  // BUG-05 (reescrito 2026-08-17): los TOTALES (net deposit) scopean a las
  // wallets pineadas OPERATIVAS — walletId '' → modo 'pinned' en
  // persisted-movements, que desde la migración 084 devuelve solo role
  // 'operating'. El selector de wallet del banner (coinsbuyWalletId) sigue
  // siendo solo para mirar una wallet puntual en las tarjetas de arriba; NO
  // scopea estos totales.
  //
  // La versión anterior decía "IGUAL que /balances" y usaba TODAS las
  // pineadas, unificando a propósito dos criterios que no son el mismo:
  //   · balance      → toda wallet propia suma (incluida la de ahorro)
  //   · movimientos  → solo lo que entra y sale de CLIENTES
  // Coincidían mientras Vex Pro tenía pineada solo 1079 "Main". Al pinnear
  // 1087 "Savings Vex Pro" ($400.014,00) y 1705 "Egresos Vex" ($62.779,85)
  // para el balance, esta pantalla las contó como retiros: Retiros Totales
  // $932.444,83 en vez de $469.650,98 y Net Deposit −$231.127, que es el
  // número que después consume la cadena de distribución.
  const coexist = useApiCoexistence(activePeriods, '', apiRefreshKey);
  const { useDerivedBroker, apiFrom, apiTo } = coexist;
  // Broker CRM — prop firm sales + P2P transfers. Stub for now (returns 0
  // until the CRM endpoint exists), but wired so the display already sums
  // apiValue + manualValue with zero migration work when the API lands.
  // Orion CRM totals (prop firm sales + P2P transfers) — sums with manual
  // values under the coexistence rule: `displayedValue = apiValue + manual`.

  const handleExport = () => verify2FA(() => {
    if (!summary) return;
    const headers = [t('movements.type'), t('movements.category'), t('movements.amount')];
    const rows: (string | number)[][] = [
      ...summary.deposits.map(
        (d) =>
          [t('movements.deposit'), depositChannelLabel(d.channel, t), d.amount] as (string | number)[]
      ),
      ...summary.withdrawals.map(
        (w) =>
          [t('movements.withdrawal'), WITHDRAWAL_LABELS[w.category], w.amount] as (
            | string
            | number
          )[]
      ),
      ['', t('movements.netDeposit'), displayNetDeposit],
    ];
    downloadCSV(
      `movimientos_${(summary.period.label || 'export').replace(/\s/g, '_')}.csv`,
      headers,
      rows
    );
  });

  // Ensure all channels/categories always appear, even with $0.
  // Sin useMemo manual: el React Compiler memoiza automáticamente. El useMemo
  // explícito sobre `summary` no podía preservarse (regla react-compiler), y
  // estos valores solo se usan en el render (no como deps de efectos).
  const fullDeposits: Deposit[] = !summary
    ? []
    : ALL_CHANNELS.map((ch) => {
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

  const fullWithdrawals: Withdrawal[] = !summary
    ? []
    : ALL_CATEGORIES.map((cat) => {
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

  // Sin períodos no hay nada que mostrar: devolver null dejaba la pantalla en
  // blanco, sin explicación ni salida.
  if (!loading && periods.length === 0) return <NoPeriodsState />;
  if (!summary) return null;

  // ─── Consolidación API + manual ───
  // Both sources coexist and add up. For each channel/category the displayed
  // number is (API amount when applicable) + (manual amount stored in
  // Supabase). The manual entry is never overwritten or hidden by the API.

  // Manual values per deposit channel (may be 0 if the user didn't enter any).
  const manualByChannel = manualDepositsByChannel(summary.deposits);
  const otherDeposits = manualByChannel.other;

  // API amounts from the shared coexistence hook (0 for historical periods).
  const { apiByChannel } = coexist;

  // "Depósitos Totales (API)" — la suma de los canales con API, incluyendo lo
  // que el usuario haya cargado a mano en esos canales. Sale del registro
  // único: no hay tres variables sueltas que se olviden de la cuarta.
  const apiDepositsTotal = coexist.apiDepositsTotal(manualByChannel);

  // Stored manual amounts per withdrawal category.
  const storedBroker = summary.withdrawals.find((w) => w.category === 'broker')?.amount || 0;
  const ibCommissions = summary.withdrawals.find((w) => w.category === 'ib_commissions')?.amount || 0;
  const propFirmWithdrawal = summary.withdrawals.find((w) => w.category === 'prop_firm')?.amount || 0;
  const otherWithdrawal = summary.withdrawals.find((w) => w.category === 'other')?.amount || 0;

  // "Retiros Totales (API)" tracks the real Coinsbuy-side outflow. For
  // historical periods it reduces to the stored broker value.
  const apiWithdrawalsTotal = useDerivedBroker ? coexist.apiWithdrawalsTotal : storedBroker;

  // ── Retiros por canal de API (Kevin, 2026-08-31) ──────────────────────────
  // «de paypros en movimientos incluí también los retiros por ese medio».
  // Hasta hoy la sección de Retiros solo mostraba las cuatro categorías
  // MANUALES; el lado API era un único número al pie sin decir de dónde salía.
  // Las filas vienen del registro único `API_WITHDRAWAL_CHANNELS`, el
  // simétrico de `API_DEPOSIT_CHANNELS` que ya alimenta la tabla de arriba.
  //
  // `null` = todavía no llegó el dataset ⇒ «sin datos». No es $0: un canal que
  // no se pudo leer y uno que no tuvo retiros son dos cosas distintas, y la
  // segunda es la única que se puede sumar.
  const apiWithdrawalRows = useDerivedBroker
    ? API_WITHDRAWAL_CHANNELS.map(({ key }) => ({
        key,
        label: withdrawalChannelLabel(key, t),
        amount: coexist.apiWithdrawalsByChannel[key] ?? null,
      }))
    : [];

  // Broker display — Kevin (2026-05-03): Broker es información manual
  // estrictamente informativa; no se mezcla con la API porque los retiros
  // reales ya están capturados en Retiros Totales (API + Otros). Aquí solo
  // se muestra lo que el usuario cargó en Carga de Datos. Para periodos
  // legacy (sin useDerivedBroker) se sigue mostrando el valor histórico.
  const brokerDisplay = storedBroker;

  // ── Prop firm / P2P: solo manual + serie del espejo Mongo ──
  // Kevin (2026-08-28): «desconectala». La vieja API agregada de Orion
  // (`/v1/totals`) nunca existió — era un placeholder con mock — y si algún
  // día respondía habría duplicado contra `crm_monthly_totals` (migración
  // 100), que hoy es la serie automática real y vive en /finanzas/crm.
  // Aquí queda únicamente lo cargado a mano, como el resto de Broker.
  const propFirmSalesDisplay = summary.propFirmSales;
  const p2pTransferDisplay = summary.p2pTransfer;

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
  // Retiros Totales — Kevin (2026-06-06, decisión final): el total son los
  // datos de Coinsbuy: la API + el manual de la categoría Broker (que
  // representa retiros Coinsbuy que la API no alcanzó a reportar). Las
  // categorías Comisiones IB / Prop Firm / Otros son meramente informativas
  // — el usuario las carga en Carga de Datos pero NO se suman al total.
  //
  // Historial: PR #15 (2026-05-02) introdujo esta misma fórmula. PR #16
  // (mismo día) la cambió a `+ otherWithdrawal`. Tras probar varios
  // meses Kevin confirmó (2026-06-06) que el manual Broker SÍ debe sumar,
  // porque representa Coinsbuy supplement; volvemos al patrón original.
  // Fórmula canónica compartida con /balances y los reportes — definida en
  // broker-logic.ts (computeDerivedNetDeposit). Antes cada página la
  // reimplementaba y divergían (bug 2026-06-07). Pasamos los componentes
  // económicos crudos (API pura + manual puro) para que la fórmula viva en
  // UN solo lugar.
  const _derived = useDerivedBroker
    ? computeDerivedNetDeposit({
        apiDeposits: ALL_DEPOSIT_CHANNELS.reduce((s, ch) => s + (apiByChannel[ch] ?? 0), 0),
        manualDepositsTotal: ALL_DEPOSIT_CHANNELS.reduce(
          (s, ch) => s + (manualByChannel[ch] ?? 0),
          0,
        ),
        apiWithdrawals: apiWithdrawalsTotal,
        manualBroker: storedBroker,
      })
    : null;
  // TS-01: chequear el nullable real (_derived) en vez de `useDerivedBroker`
  // + non-null assertion — TS estrecha el tipo y desaparece el `!` frágil.
  const displayTotalWithdrawals = _derived ? _derived.totalWithdrawals : summary.totalWithdrawals;
  const displayNetDeposit = _derived ? _derived.netDeposit : summary.netDeposit;

  // Filas de la tabla de Depósitos — API + manual coexist: per-channel
  // display = API amount (when this period uses derived broker logic) +
  // manual entry from Supabase `deposits` table.
  const depositRows = fullDeposits.map((d) => {
    const apiSlug = apiSlugForChannel(d.channel);
    const apiAmount = useDerivedBroker && apiSlug
      ? coexist.apiTotalsBy[apiSlug] ?? 0
      : 0;
    const manualAmount = d.amount;
    return {
      ...d,
      apiAmount,
      manualAmount,
      displayAmount: apiAmount + manualAmount,
      isApiChannel: !!apiSlug,
    };
  });

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
          <h2 className="text-lg font-semibold">{t('movements.periodData')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('movements.periodDataDesc')}
          </p>
        </div>
        <MovimientosPeriodSelector />
      </div>

      {/* ─── Summary cards: Depósitos / Retiros / Net Deposit ─── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          label={t('summary.deposits')}
          value={formatCurrency(displayTotalDeposits)}
          hint={t('movements.selectedPeriodHint')}
          icon={ArrowDownCircle}
          tone="info"
        />
        <StatCard
          label={t('summary.withdrawals')}
          value={formatCurrency(displayTotalWithdrawals)}
          hint={t('movements.selectedPeriodHint')}
          icon={ArrowUpCircle}
          tone="negative"
        />
        <StatCard
          label={<>{t('movements.netDeposit')} <InfoTip text={GLOSSARY.netDeposit} /></>}
          value={formatCurrency(displayNetDeposit)}
          hint={t('movements.netDepositHint')}
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
          <DataTable
            data={depositRows}
            columns={[
              {
                header: t('movements.channel'),
                accessor: (d) => (
                  <>
                    {depositChannelLabel(d.channel, t)}
                    {d.channel === 'other' && (
                      <span className="ml-2 text-[10px] text-muted-foreground uppercase tracking-wide">
                        manual
                      </span>
                    )}
                    {d.isApiChannel && useDerivedBroker && (
                      <span className="ml-2 text-[10px] text-emerald-500 uppercase tracking-wide">
                        api
                      </span>
                    )}
                  </>
                ),
              },
              {
                header: t('movements.amount'),
                align: 'right',
                accessor: (d) => (
                  <span className="font-medium">
                    {formatCurrency(d.displayAmount)}
                    {/* Breakdown when both sources contribute — shows the
                        user that manual + API are coexisting, not fighting. */}
                    {d.isApiChannel && useDerivedBroker && d.apiAmount > 0 && d.manualAmount > 0 && (
                      <span className="block text-[10px] text-muted-foreground">
                        {formatCurrency(d.apiAmount)} API + {formatCurrency(d.manualAmount)} manual
                      </span>
                    )}
                  </span>
                ),
              },
            ]}
            footerRow={
              <>
                <tr className="font-bold">
                  <td className="px-4 py-3">{t('movements.totalDepositsApi')}</td>
                  <td className="px-4 py-3 text-right text-blue-600">
                    {formatCurrency(apiDepositsTotal)}
                  </td>
                </tr>
                <tr className="text-muted-foreground">
                  <td className="px-4 py-1">
                    <span className="inline-flex items-center gap-1.5">
                      {t('movements.propFirmSales')}
                      <InfoTip text={GLOSSARY.propFirm} />
                    </span>
                  </td>
                  <td className="px-4 py-1 text-right">{formatCurrency(propFirmSalesDisplay)}</td>
                </tr>
                <tr className="text-muted-foreground">
                  <td className="px-4 py-1">
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
                  <td className="px-4 py-1 text-right">{formatCurrency(brokerDepositsDisplay)}</td>
                </tr>
              </>
            }
          />
        </Card>

        {/* Retiros */}
        <Card>
          <h2 className="text-lg font-semibold mb-4 text-red-600">
            {t('movements.withdrawalsTab')}
          </h2>
          <DataTable
            data={fullWithdrawals}
            columns={[
              {
                header: t('movements.category'),
                accessor: (w) => (
                  <>
                    {WITHDRAWAL_LABELS[w.category]}
                    <span className="ml-2 text-[10px] text-muted-foreground uppercase tracking-wide">
                      manual
                    </span>
                  </>
                ),
              },
              {
                header: t('movements.amount'),
                align: 'right',
                // Broker — Kevin (2026-05-03): es informativo manual,
                // siempre se muestra solo lo cargado en Carga de Datos.
                // Las demás categorías (Comisiones IB, Prop Firm, Otros)
                // también son manuales. Ninguna lleva splitting API+MANUAL
                // porque los retiros reales viven en "Retiros Totales".
                accessor: (w) => (
                  <span className="font-medium">
                    {formatCurrency(w.category === 'broker' ? brokerDisplay : w.amount)}
                  </span>
                ),
              },
            ]}
            footerRow={
              <>
                {/* Retiros por API, uno por canal del registro único. Van
                    ANTES del total para que se lea como su desglose. */}
                {apiWithdrawalRows.map((r) => (
                  <tr key={r.key} className="text-muted-foreground">
                    <td className="px-4 py-1">
                      {r.label}
                      <span className="ml-2 text-[10px] text-emerald-500 uppercase tracking-wide">
                        api
                      </span>
                    </td>
                    <td className="px-4 py-1 text-right">
                      {r.amount === null ? t('movements.noData') : formatCurrency(r.amount)}
                    </td>
                  </tr>
                ))}
                <tr className="font-bold">
                  <td className="px-4 py-3">{t('summary.withdrawals')}</td>
                  <td className="px-4 py-3 text-right text-red-600">
                    {formatCurrency(displayTotalWithdrawals)}
                  </td>
                </tr>
                {/* Un canal que no se pudo leer NO está en el total. Decirlo es
                    obligatorio: un recorte silencioso es indistinguible de
                    "no hay más" (docs/reglas-del-proyecto.md §1.2). */}
                {coexist.withdrawalChannelsWithoutData.length > 0 && (
                  <tr>
                    <td colSpan={2} className="px-4 pb-2 text-xs text-amber-600">
                      {t('movements.withdrawalsMissingChannels', {
                        channels: coexist.withdrawalChannelsWithoutData
                          .map((c) => withdrawalChannelLabel(c, t))
                          .join(', '),
                      })}
                    </td>
                  </tr>
                )}
                <tr className="text-muted-foreground">
                  <td className="px-4 py-1">
                    {t('movements.p2pTransfer')}
                  </td>
                  <td className="px-4 py-1 text-right">
                    {formatCurrency(p2pTransferDisplay)}
                  </td>
                </tr>
                <tr className="font-bold border-t border-border">
                  <td className="px-4 py-3">{t('movements.netDeposit')}</td>
                  <td
                    className={`px-4 py-3 text-right ${
                      displayNetDeposit >= 0 ? 'text-emerald-600' : 'text-red-600'
                    }`}
                  >
                    {formatCurrency(displayNetDeposit)}
                  </td>
                </tr>
              </>
            }
          />
        </Card>

        {/* Balance Prop Firm */}
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('movements.balancePropFirm')}</h2>
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-border/50">
                <td className="py-2.5">
                  {t('movements.propFirmSales')}
                  <span className="ml-2 text-[10px] text-muted-foreground uppercase tracking-wide">
                    manual
                  </span>
                </td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(propFirmSalesDisplay)}
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
                    {t('movements.brokerPnlBookB')}
                    <InfoTip text={GLOSSARY.libroB} />
                  </span>
                  {/* Desde 2026-08-31 este número YA NO se teclea: sale de
                      `crm_daily_pnl` en los períodos abiertos y del congelado
                      del cierre en los cerrados (src/lib/broker-pnl.ts). La
                      PROCEDENCIA se muestra en /resumen-general, que es donde
                      hay un solo período a la vista; acá una etiqueta fija
                      diría "CRM" también sobre un mes cerrado, que es
                      justamente el número que NO sale del CRM. */}
                </td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(summary.operatingIncome?.broker_pnl || 0)}
                </td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-2.5">{t('upload.other')}</td>
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
