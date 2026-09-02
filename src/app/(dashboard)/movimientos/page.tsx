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
import { useCrmMonthlyAuto } from '@/lib/use-crm-monthly-auto';
import { resolveAutoOrManual } from '@/lib/crm-auto-values';
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
import {
  ALL_WITHDRAWAL_CATEGORIES,
  withdrawalCategoryLabel,
} from '@/lib/withdrawal-categories';
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
// Las categorías de retiro salen del registro único
// (src/lib/withdrawal-categories.ts), igual que los canales de depósito. El
// orden es parte del registro: acá y el selector de /upload lo comparten.
const ALL_CATEGORIES = ALL_WITHDRAWAL_CATEGORIES;

/**
 * Series del espejo del CRM que esta pantalla consume. Las claves son las de
 * `CRM_MONTHLY_METRICS` (src/lib/crm-monthly.ts): una sola lectura del endpoint
 * para las cuatro, en vez de un efecto por métrica.
 */
const CRM_AUTO_METRICS = [
  'propfirm_sales',
  'propfirm_withdrawals',
  'p2p_transfers',
  'ib_commissions',
] as const;

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

  // ── Las series automáticas del espejo del CRM ──────────────────────────────
  // Viven en `crm_monthly_totals` (migración 100) y las calcula el cron desde
  // Orion. Las cuatro se resuelven con la MISMA regla, que vive una sola vez en
  // `resolveAutoOrManual` (src/lib/crm-auto-values.ts): en períodos DERIVADOS
  // (abr-2026+) manda el automático, y un manual > 0 es un override explícito
  // que se muestra rotulado; en históricos manda el manual siempre.
  //
  // Qué arregla cada una, medido el 2026-08-31:
  //   · propfirm_sales / propfirm_withdrawals — cableadas ese mismo día. Agosto
  //     mostraba $0 manual contra $11.981,70 reales.
  //   · p2p_transfers — la fila del pie de Retiros mostraba $0,00 desde hace
  //     SEIS MESES contra Dic 136.213,42 · Feb 76.693,78 · Jun 39.474,91 ·
  //     Jul 31.629,80 · Ago 29.403,67. El único mes cargado a mano en toda la
  //     historia de Vex Pro es nov-2025 y coincide al centavo con el automático
  //     ($9.787,04): se respeta igual como override, porque la regla no puede
  //     depender de que los dos números coincidan.
  //   · ib_commissions — la categoría manual está vacía desde ABRIL contra una
  //     serie de $125-180K/mes. Es INFORMATIVA (crm-monthly.ts la marca
  //     `informational: true`): NO suma a Retiros Totales ni al Net Deposit,
  //     porque la comisión acreditada es deuda interna con el IB y la caja se
  //     mueve recién cuando el IB retira — y ESE retiro ya se cuenta. Lo que sí
  //     arregla es el RÓTULO del split: con el IB en cero, los $125-180K que la
  //     API reporta como retiro quedaban atribuidos enteros a «Broker».
  const crmAuto = useCrmMonthlyAuto(activePeriods, CRM_AUTO_METRICS, apiRefreshKey);
  const { useDerivedBroker } = coexist;

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
          [t('movements.withdrawal'), withdrawalCategoryLabel(w.category, t), w.amount] as (
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
    : ALL_CHANNELS.filter((ch) => !canalOculto(ch)).map((ch) => {
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
  // Canales apagados para la empresa: su fila no se dibuja (ni con $0). Ver
  // la cabecera del endpoint persisted-movements.
  const canalOculto = (k: string) => coexist.hiddenChannels.includes(k);

  // "Depósitos Totales (API)" — la suma de los canales con API, incluyendo lo
  // que el usuario haya cargado a mano en esos canales. Sale del registro
  // único: no hay tres variables sueltas que se olviden de la cuarta.
  const apiDepositsTotal = coexist.apiDepositsTotal(manualByChannel);

  // Stored manual amounts per withdrawal category.
  const storedBroker = summary.withdrawals.find((w) => w.category === 'broker')?.amount || 0;
  const propFirmWithdrawal = summary.withdrawals.find((w) => w.category === 'prop_firm')?.amount || 0;

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
    ? API_WITHDRAWAL_CHANNELS.filter(({ key }) => !canalOculto(key)).map(({ key }) => ({
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
  // La misma regla para las cuatro series (ver `resolveAutoOrManual`): en
  // derivados manda el automático y un manual > 0 es override rotulado; en
  // históricos manda el manual.
  const auto = (metric: string) => crmAuto.auto[metric] ?? null;
  const pfSales = resolveAutoOrManual({
    derived: useDerivedBroker,
    manual: summary.propFirmSales,
    auto: auto('propfirm_sales'),
  });
  const pfWdr = resolveAutoOrManual({
    derived: useDerivedBroker,
    manual: propFirmWithdrawal,
    auto: auto('propfirm_withdrawals'),
  });
  const propFirmSalesDisplay = pfSales.value;
  const pfSalesSource = pfSales.source;
  const propFirmWithdrawalDisplay = pfWdr.value;
  const pfWdrSource = pfWdr.source;

  // ── P2P: la fila que decía $0,00 desde hace seis meses ─────────────────────
  // `summary.p2pTransfer` es la tabla manual `p2p_transfers`, que en toda la
  // historia de Vex Pro tiene UN período cargado (nov-2025, $9.787,04) y
  // coincide al centavo con el automático. Todo lo demás estaba en cero contra
  // una serie real de decenas de miles por mes. No suma a ningún total: es una
  // línea informativa al pie de Retiros, y por eso cablearla no mueve ni
  // Retiros Totales ni el Net Deposit — sólo deja de mentir.
  const p2p = resolveAutoOrManual({
    derived: useDerivedBroker,
    manual: summary.p2pTransfer,
    auto: auto('p2p_transfers'),
  });
  const p2pTransferDisplay = p2p.value;

  // ── Comisiones IB: INFORMATIVA, no un retiro ───────────────────────────────
  // El manual está vacío desde abril contra $125-180K/mes en la serie. Se
  // muestra el automático rotulado, y NO entra a Retiros Totales ni al Net
  // Deposit: `crm-monthly.ts` la marca `informational: true` porque la comisión
  // acreditada es deuda interna con el IB —la caja se mueve el día que el IB
  // retira, y ese retiro ya se cuenta como egreso—. Sumarla contaría el mismo
  // dólar dos veces.
  const ib = resolveAutoOrManual({
    derived: useDerivedBroker,
    manual: summary.withdrawals.find((w) => w.category === 'ib_commissions')?.amount || 0,
    auto: auto('ib_commissions'),
  });

  // Lo que muestra cada fila de la tabla de Retiros, y de dónde salió. Vive en
  // una función y no en tres ternarios repartidos por el JSX porque la columna
  // del importe y la del rótulo TIENEN que decir lo mismo.
  const withdrawalRowAmount = (category: string, manual: number): number => {
    if (category === 'broker') return brokerDisplay;
    if (category === 'ib_commissions') return ib.value;
    if (category === 'prop_firm') return propFirmWithdrawalDisplay;
    return manual;
  };
  const withdrawalRowSource = (category: string): 'manual' | 'api' => {
    if (category === 'ib_commissions') return ib.source;
    if (category === 'prop_firm') return pfWdrSource;
    return 'manual';
  };

  const propFirmNetIncomeDisplay = propFirmSalesDisplay - propFirmWithdrawalDisplay;

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
                header: (
                  <span className="inline-flex items-center gap-1.5">
                    {t('movements.channel')}
                    {/* La entrada del glosario existía desde hace meses y no la
                        usaba nadie: explicaba justo lo que esta tabla no dice,
                        que cada fila es API + manual y que el manual nunca se
                        pisa. Va acá, al lado del rótulo «api» que la motiva
                        (2026-08-31, auditoría de finanzas, ítem 20). */}
                    <InfoTip text={GLOSSARY.apiManualCoexist} />
                  </span>
                ),
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
                {/* Kevin (2026-08-31): «sigue sin sumar esto bien» — el total en
                    negrita tiene que ser la suma de TODAS las filas visibles,
                    incluida la manual «Otros Depósitos». El total solo-API sigue
                    disponible como desglose debajo, porque «Restante (Broker)»
                    se deriva de él (regla Abr-2026) y no debe moverse. */}
                <tr className="font-bold">
                  <td className="px-4 py-3">{t('movements.totalDepositsAll')}</td>
                  <td className="px-4 py-3 text-right text-blue-600">
                    {formatCurrency(displayTotalDeposits)}
                    {otherDeposits > 0 && (
                      <span className="block text-[10px] font-normal text-muted-foreground">
                        {t('movements.totalDepositsBreakdown', {
                          api: formatCurrency(apiDepositsTotal),
                          manual: formatCurrency(otherDeposits),
                        })}
                      </span>
                    )}
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
                accessor: (w) => {
                  const src = withdrawalRowSource(w.category);
                  return (
                    <>
                      {withdrawalCategoryLabel(w.category, t)}
                      <span
                        className={`ml-2 text-[10px] uppercase tracking-wide ${
                          src === 'api' ? 'text-positive' : 'text-muted-foreground'
                        }`}
                      >
                        {src === 'api' ? 'api' : 'manual'}
                      </span>
                      {/* «Informativa» no es decoración: dice por qué este
                          número NO está en Retiros Totales. Sin el rótulo, una
                          fila de $180.000 arriba de un total que no la incluye
                          se lee como un error de suma. */}
                      {w.category === 'ib_commissions' && (
                        <span className="ml-2 text-[10px] text-muted-foreground/80 uppercase tracking-wide">
                          {t('movements.informationalOnly')}
                        </span>
                      )}
                    </>
                  );
                },
              },
              {
                header: t('movements.amount'),
                align: 'right',
                // Broker — Kevin (2026-05-03): es informativo manual,
                // siempre se muestra solo lo cargado en Carga de Datos.
                // Comisiones IB y Prop Firm muestran desde el 2026-08-31 el
                // valor EFECTIVO (automático del espejo del CRM, o el manual si
                // hay override), el mismo que ya usaban las tarjetas de abajo:
                // tener la tabla en $0 y la tarjeta en $11.981,70 era el mismo
                // dato contado dos veces con dos resultados. Ninguna suma a
                // «Retiros Totales» — los retiros reales viven ahí.
                accessor: (w) => (
                  <span className="font-medium">
                    {formatCurrency(withdrawalRowAmount(w.category, w.amount))}
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
                    <span
                      className={`ml-2 text-[10px] uppercase tracking-wide ${
                        p2p.source === 'api' ? 'text-positive' : 'text-muted-foreground'
                      }`}
                    >
                      {p2p.source === 'api' ? 'api' : 'manual'}
                    </span>
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
                  <span className={`ml-2 text-[10px] uppercase tracking-wide ${pfSalesSource === 'api' ? 'text-positive' : 'text-muted-foreground'}`}>
                    {pfSalesSource === 'api' ? 'api' : 'manual'}
                  </span>
                </td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(propFirmSalesDisplay)}
                </td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-2.5">
                  {t('movements.propFirmWithdrawals')}
                  <span className={`ml-2 text-[10px] uppercase tracking-wide ${pfWdrSource === 'api' ? 'text-positive' : 'text-muted-foreground'}`}>
                    {pfWdrSource === 'api' ? 'api' : 'manual'}
                  </span>
                </td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(propFirmWithdrawalDisplay)}
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
