'use client';

import { useMemo, useState } from 'react';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, kpiPlainText, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Notice } from '@/components/ui/notice';
import { MovimientosPeriodSelector } from '@/components/movimientos-period-selector';
import {
  RealTimeMovementsBanner,
  DEFAULT_WALLET_ID,
} from '@/components/realtime-movements-banner';
import { useApiCoexistence } from '@/lib/use-api-coexistence';
import { useCrmMonthlyAuto } from '@/lib/use-crm-monthly-auto';
import { resolveAutoOrManual } from '@/lib/crm-auto-values';
import { computeDerivedNetDeposit } from '@/lib/broker-logic';
import { ArrowLeftRight, Download, RotateCw } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { InfoTip } from '@/components/ui/info-tip';
import { GLOSSARY } from '@/lib/glossary';
import { ConsolidatedBadge } from '@/components/ui/consolidated-badge';
import { usePeriod } from '@/lib/period-context';
import { NoPeriodsState } from '@/components/no-periods-state';
import { useData } from '@/lib/data-context';
import { formatMoney } from '@/lib/money';
import { PROVIDER_META } from '@/lib/api-channels';
import {
  ALL_WITHDRAWAL_CATEGORIES,
  withdrawalCategoryLabel,
} from '@/lib/withdrawal-categories';
import {
  ALL_DEPOSIT_CHANNELS,
  API_DEPOSIT_CHANNELS,
  apiSlugForChannel,
  depositChannelLabel,
  manualDepositsByChannel,
  type DepositChannel,
} from '@/lib/deposit-channels';
import {
  API_WITHDRAWAL_CHANNELS,
  withdrawalChannelLabel,
} from '@/lib/withdrawal-channels';
import type { Deposit, Withdrawal } from '@/lib/types';
import type { ProviderSlug } from '@/lib/api-integrations/types';
import { downloadCSV } from '@/lib/csv-export';
import { apiFetch } from '@/lib/api-fetch';
import { useAuth } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useI18n } from '@/lib/i18n';
import {
  buildDepositRows,
  buildWithdrawalRows,
  channelCoverage,
  sharePct,
  type ChannelRow,
} from './channel-rows';
import { SourceTag } from './source-tag';

// ─────────────────────────────────────────────────────────────────────────────
// /movimientos — rediseño «Libro mayor» (2026-10-12, docs/diseno-libro-mayor.md)
//
// QUÉ CAMBIÓ (sólo presentación; ningún cálculo se movió):
//   · Tres StatCard con ícono de color → UNA franja de KPIs: Depósito neto
//     (hero, color por signo: acá el signo ES la noticia), Depósitos, Retiros,
//     Pendientes. Cada sub cuenta operaciones y «N canal(es) sin dato».
//   · Aviso `pend` cuando un canal de API no respondió: lo nombra, dice que NO
//     está sumado y que no es cero, es desconocido, con «Reintentar». Antes era
//     una línea ámbar (paleta cruda) al pie de Retiros, y para los depósitos no
//     había nada: un canal sin dataset mostraba «$0.00» (`?? 0`).
//   · «Depósitos» en azul y «Retiros» en rojo de paleta cruda, el total en
//     verde: color decorativo fuera (spec §2.1). Los montos van en tinta
//     neutra con signo + / −; el signo dice el sentido, no el color.
//   · Retiros separa en grupos lo que SUMA de lo informativo (IB, Prop Firm,
//     Otros, P2P), que antes convivían sin distinción sobre un total que no
//     las incluía.
//   · El orden sigue la spec §6.3: período → KPIs → avisos → paneles. «APIs en
//     tiempo real» (que tiene su propio rango de fechas, independiente del
//     período) pasa al final: arriba competía con los KPIs del período y era
//     la causa recurrente de «las tarjetas no coinciden con la tabla».
//
// MEDICIÓN: los totales salen de las mismas expresiones que antes
// (`computeDerivedNetDeposit`, `coexist.apiDepositsTotal`, `summary.*`,
// `resolveAutoOrManual`); las filas por canal se arman en `channel-rows.ts` y
// su test cruza Σ filas contra `computeDerivedNetDeposit`.
//
// DESCARTADO:
//   · Sacar `MovimientosPeriodSelector` en favor del período de la topbar
//     (spec §6.2): es multi-mes (consolidado) y la topbar no lo es todavía.
//   · Fila «Net Deposit» al pie de Retiros: está en el KPI hero; repetirla
//     abajo era el mismo número dos veces con dos colores.
// ─────────────────────────────────────────────────────────────────────────────

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
  // Canales apagados para la empresa: su fila no se dibuja (ni con $0). Ver
  // la cabecera del endpoint persisted-movements.
  //
  // Declarado ACÁ, pegado a `coexist`, y no más abajo junto a `apiByChannel`:
  // el 2026-09-02 vivió 100 líneas después de su primer uso (`fullDeposits`) y
  // tiró ReferenceError (zona muerta temporal de `const`) en cuanto el período
  // tuvo datos. tsc no lo ve; la pantalla de Movimientos se cayó en prod.
  const canalOculto = (k: string) => coexist.hiddenChannels.includes(k);

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

  // ─── Filas por canal (presentación; los totales de arriba no se tocan) ───
  // Depósitos: API + manual coexisten por canal. Un canal de API cuyo dataset
  // no llegó muestra «sin dato» (null), no «$0.00»: el total sigue sumándole
  // 0 de API —el cálculo es el de siempre— y el pie lo dice («3 de 4 canales»).
  // Mientras la lectura está en curso tampoco hay dato: «—» (sin el badge, que
  // sería una alarma antes de saber si falta algo).
  //
  // `apiLoading` va declarado ACÁ, antes de su primer uso: el 2026-09-02 esta
  // página se cayó en prod por un `const` usado antes de su línea (ver
  // `canalOculto`).
  const apiLoading = useDerivedBroker && coexist.apiFetchState === 'loading';
  const loadedSlugs = new Set<string>(
    API_DEPOSIT_CHANNELS.filter(
      ({ channel }) => !coexist.depositChannelsWithoutData.includes(channel),
    ).map(({ slug }) => slug),
  );
  const depositRows = buildDepositRows({
    channels: fullDeposits.map((d) => d.channel),
    derived: useDerivedBroker,
    apiSlugOf: (ch) => apiSlugForChannel(ch as DepositChannel),
    apiAmountOf: (slug) =>
      !apiLoading && loadedSlugs.has(slug) ? coexist.apiTotalsBy[slug as ProviderSlug] ?? 0 : null,
    manualOf: (ch) => fullDeposits.find((d) => d.channel === ch)?.amount ?? 0,
    labelOf: (ch) =>
      ch === 'other' ? t('movements.otherDepositsManual') : depositChannelLabel(ch as DepositChannel, t),
  });

  // Retiros: canales de API (sólo derivados) + categorías manuales + P2P. Los
  // canales apagados para la empresa no se dibujan; mientras la lectura está
  // en curso, «sin dato» todavía no es un aviso (no sabemos ni que falte).
  const withdrawalRows = buildWithdrawalRows({
    derived: useDerivedBroker,
    apiChannels: apiWithdrawalRows,
    categories: fullWithdrawals.map((w) => ({
      key: w.category,
      label: withdrawalCategoryLabel(w.category, t),
      amount: withdrawalRowAmount(w.category, w.amount),
      source: withdrawalRowSource(w.category),
    })),
    p2p: { label: t('movements.p2pTransfer'), amount: p2pTransferDisplay, source: p2p.source },
  });

  const depositCoverage = channelCoverage(depositRows);
  const withdrawalCoverage = channelCoverage(withdrawalRows);

  // Canales sin dato, para el aviso y los KPIs. Los retiros vienen del hook,
  // que cuenta también los apagados (su dataset tampoco llega): se filtran.
  const depositsMissing = apiLoading ? [] : coexist.depositChannelsWithoutData;
  const withdrawalsMissing = apiLoading
    ? []
    : coexist.withdrawalChannelsWithoutData.filter((c) => !canalOculto(c));
  const missingLabels = [
    ...depositsMissing.map((c) =>
      t('movements.notice.channelSide', {
        channel: depositChannelLabel(c, t),
        side: t('movements.depositsTab').toLowerCase(),
      }),
    ),
    ...withdrawalsMissing.map((c) =>
      t('movements.notice.channelSide', {
        channel: withdrawalChannelLabel(c, t),
        side: t('movements.withdrawalsTab').toLowerCase(),
      }),
    ),
  ];
  const missingCount = depositsMissing.length + withdrawalsMissing.length;
  const fetchFailed = coexist.apiFetchState === 'failed';
  const truncatedLabels = coexist.truncatedSlugs.map((s) => PROVIDER_META[s]?.cardLabel ?? s);
  const retryApi = () => setApiRefreshKey((k) => k + 1);

  // ─── KPIs ───
  // Si la lectura de la API falló en un período derivado, los tres totales
  // tienen un hueco de tamaño desconocido: «—», no un número parcial con cara
  // de total (el aviso de arriba explica qué falta).
  const totalsUnknown = useDerivedBroker && fetchFailed;
  const countText = (n: number) => kpiPlainText(n, 'count');
  const noDataSub = (n: number) =>
    n > 0
      ? t(n === 1 ? 'movements.kpi.channelNoDataOne' : 'movements.kpi.channelNoDataMany', { n: String(n) })
      : null;
  const joinSub = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || null;
  const depositOps = coexist.apiCountBy
    ? API_DEPOSIT_CHANNELS.filter(({ channel }) => !canalOculto(channel)).reduce(
        (s, { slug }) => s + (coexist.apiCountBy?.[slug] ?? 0),
        0,
      )
    : null;
  const withdrawalOps =
    coexist.apiCountBy && coexist.apiPayoutCount !== null
      ? (canalOculto('coinsbuy') ? 0 : coexist.apiCountBy['coinsbuy-withdrawals']) +
        (canalOculto('paypros') ? 0 : coexist.apiPayoutCount)
      : null;
  const opsSub = (n: number | null) =>
    !useDerivedBroker
      ? t('movements.kpi.manualOnly')
      : n === null
        ? null
        : t('movements.kpi.ops', { n: countText(n) });
  const pending = coexist.apiPending;
  const kpis: KpiItem[] = [
    {
      key: 'net',
      label: (
        <span className="inline-flex items-center gap-1">
          {t('movements.netDeposit')} <InfoTip text={GLOSSARY.netDeposit} />
        </span>
      ),
      value: totalsUnknown ? null : displayNetDeposit,
      tone: 'sign',
      hero: true,
      sub: totalsUnknown
        ? t('movements.kpi.apiFailed')
        : noDataSub(missingCount) ?? t('movements.netDepositHint'),
    },
    {
      key: 'deposits',
      label: t('movements.depositsTab'),
      value: totalsUnknown ? null : displayTotalDeposits,
      tone: 'neutral',
      sub: totalsUnknown
        ? t('movements.kpi.apiFailed')
        : joinSub(opsSub(depositOps), noDataSub(depositsMissing.length)),
    },
    {
      key: 'withdrawals',
      label: t('movements.withdrawalsTab'),
      value: totalsUnknown ? null : displayTotalWithdrawals,
      tone: 'neutral',
      sub: totalsUnknown
        ? t('movements.kpi.apiFailed')
        : joinSub(opsSub(withdrawalOps), noDataSub(withdrawalsMissing.length)),
    },
    {
      key: 'pending',
      label: t('movements.kpi.pending'),
      value: pending ? pending.count : null,
      format: 'count',
      sub: !useDerivedBroker
        ? t('movements.kpi.pendingHistorical')
        : pending
          ? pending.count > 0
            ? t('movements.kpi.pendingAmount', { amount: formatMoney(pending.amount, { compact: true }) })
            : t('movements.kpi.pendingNone')
          : null,
    },
  ];

  // ─── Columnas ───
  const pctCell = (row: ChannelRow, total: number | null) => {
    const pct = sharePct(row, total);
    return pct === null ? (
      <span className="text-text-3">—</span>
    ) : (
      <span className={NUM_CLASS}>{kpiPlainText(pct, 'percent')}</span>
    );
  };
  const noDataCell = (
    <span className="inline-flex items-center justify-end gap-2">
      {!apiLoading && <StatusBadge kind="stale" label={t('ui.noData')} />}
      <span className={`${NUM_CLASS} text-text-3`} aria-hidden>
        —
      </span>
    </span>
  );
  const sourceLabel = (k: ChannelRow['source']) =>
    k === 'api'
      ? t('movements.source.api')
      : k === 'manual'
        ? t('movements.source.manual')
        : t('movements.source.apiManual');

  const channelColumn = (meta: (r: ChannelRow) => React.ReactNode): FinColumn<ChannelRow> => ({
    key: 'channel',
    header: (
      <span className="inline-flex items-center gap-1.5">
        {t('movements.channel')}
        {/* Cada fila de API es API + manual y el manual nunca se pisa: es lo
            que explica esta entrada del glosario (auditoría 2026-08-31, ítem 20). */}
        <InfoTip text={GLOSSARY.apiManualCoexist} />
      </span>
    ),
    cell: (r) => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span className="truncate">{r.label}</span>
        {useDerivedBroker && <SourceTag kind={r.source} label={sourceLabel(r.source)} />}
      </span>
    ),
    meta,
    mobileMeta: (r) =>
      r.amount === null && !apiLoading ? <StatusBadge kind="stale" label={t('ui.noData')} /> : null,
  });

  const depositColumns: FinColumn<ChannelRow>[] = [
    channelColumn((r) => {
      if (r.amount === null) {
        return r.manualAmount !== 0
          ? t('movements.manualStillSums', { amount: formatMoney(r.manualAmount) })
          : t('movements.channelNotSummed');
      }
      if (r.source === 'api+manual' && r.apiAmount !== null) {
        return t('movements.totalDepositsBreakdown', {
          api: formatMoney(r.apiAmount),
          manual: formatMoney(r.manualAmount),
        });
      }
      return null;
    }),
    {
      key: 'amount',
      header: t('movements.amount'),
      kind: 'money',
      value: (r) => r.amount,
      cell: (r) =>
        r.amount === null ? noDataCell : <Money value={r.amount} signed tone="neutral" className="font-medium" />,
      width: '40%',
    },
    {
      key: 'share',
      header: '%',
      kind: 'number',
      cell: (r) => pctCell(r, displayTotalDeposits),
      hideSm: true,
      width: '72px',
    },
  ];

  const withdrawalColumns: FinColumn<ChannelRow>[] = [
    channelColumn((r) => (r.amount === null ? t('movements.channelNotSummed') : null)),
    {
      key: 'amount',
      header: t('movements.amount'),
      kind: 'money',
      value: (r) => (r.amount === null ? null : -r.amount),
      // Sin subtotal por grupo: el grupo «informativas» sumaría IB + Prop
      // Firm + P2P, un número que no existe en ningún lado.
      subtotal: false,
      cell: (r) =>
        r.amount === null ? noDataCell : <Money value={-r.amount} signed tone="neutral" className="font-medium" />,
      width: '40%',
    },
    {
      key: 'share',
      header: '%',
      kind: 'number',
      cell: (r) => pctCell(r, displayTotalWithdrawals),
      hideSm: true,
      width: '72px',
    },
  ];

  const coverageLabel = (base: string, cov: ReturnType<typeof channelCoverage>) =>
    cov.withData < cov.total
      ? t('movements.totalCoverage', { label: base, n: String(cov.withData), m: String(cov.total) })
      : base;

  const exactRow = (label: React.ReactNode, value: number, hint?: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0">
        {label}
        {hint && <span className="ml-1.5">· {hint}</span>}
      </span>
      <Money value={value} tone="neutral" className="text-text-2" />
    </div>
  );

  const simpleColumns: FinColumn<SimpleRow>[] = [
    {
      key: 'concept',
      header: t('movements.concept'),
      cell: (r) => (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate">{r.label}</span>
          {r.source && <SourceTag kind={r.source} label={sourceLabel(r.source)} />}
        </span>
      ),
    },
    {
      key: 'amount',
      header: t('movements.amount'),
      kind: 'money',
      value: (r) => r.amount,
      money: { signed: true, tone: 'neutral' },
      width: '40%',
    },
  ];
  const brokerPnl = summary.operatingIncome?.broker_pnl || 0;
  const brokerOther = summary.operatingIncome?.other || 0;

  return (
    <div className="space-y-4">
      {Modal2FA}
      <PageHeader
        title={t('movements.title')}
        subtitle={t('movements.subtitle')}
        icon={ArrowLeftRight}
        actions={
          <>
            <ConsolidatedBadge count={mode === 'consolidated' ? activePeriods.length : 1} />
            <button
              type="button"
              onClick={handleExport}
              className="inline-flex h-8 items-center gap-1.5 rounded-ui-md border border-border-strong bg-card px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover"
              title={t('common.csv')}
              aria-label={t('common.csv')}
            >
              <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t('common.csv')}</span>
            </button>
          </>
        }
      />

      {/* ─── Período (multi-mes) ─── */}
      <Panel title={t('movements.periodData')} hint={t('movements.periodDataDesc')}>
        <MovimientosPeriodSelector />
      </Panel>

      <KpiStrip items={kpis} />

      {/* ─── Avisos de estado del dato (spec §5.5) ───
          Un canal que no se pudo leer NO está en el total. Decirlo es
          obligatorio: un recorte silencioso es indistinguible de "no hay más"
          (docs/reglas-del-proyecto.md §1.2). */}
      {totalsUnknown && (
        <Notice
          kind="pend"
          title={t('movements.notice.failedTitle')}
          action={<RetryButton label={t('movements.notice.retry')} onClick={retryApi} />}
        >
          {t('movements.notice.unknownNotZero')}
        </Notice>
      )}
      {useDerivedBroker && !fetchFailed && missingLabels.length > 0 && (
        <Notice
          kind="pend"
          title={t('movements.notice.channelsTitle', { channels: missingLabels.join(', ') })}
          action={<RetryButton label={t('movements.notice.retry')} onClick={retryApi} />}
        >
          {t('movements.notice.unknownNotZero')}
        </Notice>
      )}
      {useDerivedBroker && truncatedLabels.length > 0 && (
        <Notice
          kind="pend"
          title={t('movements.notice.truncatedTitle', { channels: truncatedLabels.join(', ') })}
        >
          {t('movements.notice.truncatedBody')}
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-4 min-[1100px]:grid-cols-2">
        <Panel
          title={t('movements.depositsByChannel')}
          hint={useDerivedBroker ? t('movements.depositsByChannelHint') : t('movements.kpi.manualOnly')}
          flush
          footer={
            <div className="space-y-1">
              {/* «Restante (Broker)» se deriva del total SOLO-API (regla
                  Abr-2026): por eso el desglose API + manual sigue visible. */}
              {otherDeposits > 0 &&
                exactRow(
                  t('movements.totalDepositsAll'),
                  displayTotalDeposits,
                  t('movements.totalDepositsBreakdown', {
                    api: formatMoney(apiDepositsTotal),
                    manual: formatMoney(otherDeposits),
                  }),
                )}
              {exactRow(
                <span className="inline-flex items-center gap-1.5">
                  {t('movements.propFirmSales')} <InfoTip text={GLOSSARY.propFirm} />
                </span>,
                propFirmSalesDisplay,
              )}
              {exactRow(
                <span className="inline-flex items-center gap-1.5">
                  {t('movements.brokerDeposits')} <InfoTip text={GLOSSARY.brokerDeposits} />
                </span>,
                brokerDepositsDisplay,
                useDerivedBroker ? t('movements.brokerDerivedHint') : undefined,
              )}
            </div>
          }
        >
          <FinTable
            caption={t('movements.depositsByChannel')}
            columns={depositColumns}
            rows={depositRows}
            rowKey={(r) => r.key}
            footer={{
              label: coverageLabel(t('movements.totalDepositsLabel'), depositCoverage),
              values: { amount: displayTotalDeposits },
            }}
          />
        </Panel>

        <Panel
          title={t('movements.withdrawalsByChannel')}
          hint={useDerivedBroker ? t('movements.withdrawalsByChannelHint') : t('movements.kpi.manualOnly')}
          flush
        >
          <FinTable
            caption={t('movements.withdrawalsByChannel')}
            columns={withdrawalColumns}
            rows={withdrawalRows}
            rowKey={(r) => r.key}
            groupBy={(r) => (r.sums ? 'sums' : 'info')}
            groupLabel={(g) => (g === 'sums' ? t('movements.group.sums') : t('movements.group.info'))}
            footer={{
              label: coverageLabel(t('movements.totalWithdrawalsLabel'), withdrawalCoverage),
              values: { amount: -displayTotalWithdrawals },
            }}
          />
        </Panel>

        <Panel title={t('movements.balancePropFirm')} flush>
          <FinTable
            caption={t('movements.balancePropFirm')}
            columns={simpleColumns}
            rows={[
              {
                key: 'sales',
                label: t('movements.propFirmSales'),
                amount: propFirmSalesDisplay,
                source: useDerivedBroker ? pfSalesSource : undefined,
              },
              {
                key: 'wdr',
                label: t('movements.propFirmWithdrawals'),
                amount: -propFirmWithdrawalDisplay,
                source: useDerivedBroker ? pfWdrSource : undefined,
              },
            ]}
            rowKey={(r) => r.key}
            footer={{ label: t('movements.netIncome'), values: { amount: propFirmNetIncomeDisplay } }}
          />
        </Panel>

        <Panel title={t('movements.balanceBroker')} flush>
          {/* Desde 2026-08-31 el P&L ya no se teclea: sale de `crm_daily_pnl`
              en los períodos abiertos y del congelado del cierre en los
              cerrados (src/lib/broker-pnl.ts). La PROCEDENCIA se muestra en
              /resumen-general, donde hay un solo período a la vista; acá una
              etiqueta fija diría "CRM" también sobre un mes cerrado. */}
          <FinTable
            caption={t('movements.balanceBroker')}
            columns={simpleColumns}
            rows={[
              {
                key: 'pnl',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    {t('movements.brokerPnlBookB')} <InfoTip text={GLOSSARY.libroB} />
                  </span>
                ),
                amount: brokerPnl,
              },
              { key: 'other', label: t('upload.other'), amount: brokerOther },
            ]}
            rowKey={(r) => r.key}
            footer={{ label: t('movements.totalBroker'), values: { amount: brokerPnl + brokerOther } }}
          />
        </Panel>
      </div>

      {/* ─── APIs en tiempo real (rango propio, independiente del período) ─── */}
      <RealTimeMovementsBanner
        walletId={coinsbuyWalletId}
        onWalletChange={handleWalletChange}
        onAfterLiveSync={() => setApiRefreshKey((k) => k + 1)}
      />
    </div>
  );
}

/** Fila de los libritos Prop Firm / Broker. */
interface SimpleRow {
  key: string;
  label: React.ReactNode;
  amount: number;
  source?: 'api' | 'manual';
}

/** «Reintentar» del aviso: botón secundario (el único primario es «Sincronizar ahora»). */
function RetryButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-ui-md border border-border-strong bg-card px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover"
    >
      <RotateCw aria-hidden className="size-[15px]" strokeWidth={1.75} />
      {label}
    </button>
  );
}
