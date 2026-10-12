'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { todayUtcISO } from '@/lib/dates';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Money, moneyText, NUM_CLASS } from '@/components/ui/money';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Input, Select } from '@/components/ui/field';
import { features } from '@/lib/business-model';
import { NoPeriodsState } from '@/components/no-periods-state';
import { useData } from '@/lib/data-context';
import { usePeriod } from '@/lib/period-context';
import { useAuth, canAdd, isCompanyAdmin } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import {
  pinCoinsbuyWallet,
  unpinCoinsbuyWallet,
  setPinnedWalletRole,
} from '@/lib/supabase/mutations';
import type { PinnedWalletRole } from '@/lib/pinned-wallet-roles';
import { fetchChannelBalances, fetchPinnedCoinsbuyWallets } from '@/lib/supabase/queries';
import type { ChannelBalance, OnchainSnapshotMeta, PinnedCoinsbuyWallet } from '@/lib/types';
import { isDerivedBrokerPeriod, computeDerivedNetDeposit } from '@/lib/broker-logic';
import { apiFetch } from '@/lib/api-fetch';
import { withTimeout, TimeoutError } from '@/lib/promise-utils';
import {
  resolveChannels as resolveChannelConfigs,
  type ChannelConfigRow,
  type ResolvedChannel,
} from '@/lib/channel-configs';
import { ChannelConfigModal } from './channel-config-modal';
import { ChannelBalancesCard } from './channel-balances-card';
import { Wallet, RefreshCw, Edit2, X, Pin, PinOff, FileDown, Settings2 } from 'lucide-react';
import { isAutoLedger } from '@/lib/channel-ledger';
import {
  isStaleBalance,
  pickChannelAmount,
  pickLiveOrStored,
  type ReportChannelSource,
} from '@/lib/channel-balance-source';
import { generateChannelBalancesPDF } from '@/lib/pdf-export';
import { isDebt, normalizeLocationType, signedBalance, tallyCash } from '@/lib/cash-locations';

// ─────────────────────────────────────────────────────────────────────────────
// Channel list is now resolved dynamically from channel_configs (see
// /src/lib/channel-configs.ts). The 7 built-ins are the default set; admins
// can hide any of them, rename the manual ones, and add custom channels via
// the "Configurar" button. The resolved list flows through getChannelValue
// and the total-consolidado sum — hidden channels are skipped in both.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// «Hoy» es el día UTC, no el del navegador — todo el sistema corta los días en
// UTC (asientos del libro, snapshots, series del CRM). Acá vivía una copia
// LOCAL de todayISO() con getDate() del navegador, y esa es la tercera vez que
// el mismo bug muerde (reportes en PR #94, órdenes de pago el 01/09): medido el
// 04/09 desde UTC−5, la tarjeta pedía el saldo asof 04/09 (69.909) mientras el
// libro ya tenía un asiento del 05/09 UTC y decía 38.909. El registro canónico
// es todayUtcISO en lib/dates.ts; una copia local es la lista duplicada de
// siempre (§1.1).
const todayISO = todayUtcISO;

// Botones «Libro mayor» (spec §5.1): secundario 32 de alto, ícono 32×32; en
// puntero grueso suben a 40 (área táctil). Clases locales hasta que `Button`
// migre (fase 4/5): el legado pinta `text-white` y `rounded-lg`.
const BTN =
  'inline-flex h-8 items-center gap-1.5 rounded-ui-md border border-border-strong bg-card px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover disabled:opacity-50 [@media(pointer:coarse)]:h-10';
const ICON_BTN =
  'inline-flex size-8 items-center justify-center rounded-ui-md border border-border-strong bg-card text-text-2 hover:bg-surface-hover disabled:opacity-50 [@media(pointer:coarse)]:size-10';
const ROW_BTN =
  'inline-flex size-8 items-center justify-center rounded-ui-md text-text-2 hover:bg-surface-hover hover:text-foreground [@media(pointer:coarse)]:size-10';

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function BalancesPage() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const { company, periods, getPeriodSummary, computeSaldoChain, getInvestmentsData, getLiquidityData, loading } = useData();
  const { movements: showFlows } = features(company?.business_model);

  // El VALOR de la primera columna ya se sustituye por modelo (más abajo:
  // ingresosNetos en vez de Net Deposit), pero la ETIQUETA seguía diciendo
  // "Net Deposit · De Movimientos" — el nombre de un concepto que la empresa
  // no tiene y de un módulo que ni siquiera aparece en su menú. Un número
  // correcto con el nombre equivocado se lee como un número equivocado.
  //
  // `tf` usa la clave nueva si ya está en i18n y, mientras no lo esté, el
  // texto de respaldo — así la pantalla nunca muestra la clave cruda.
  const tf = (key: string, fallback: string) => {
    const v = t(key);
    return v === key ? fallback : v;
  };
  const inflowLabel = showFlows
    ? t('balances.netDeposit')
    : tf('balances.netIncomeCompany', locale === 'en' ? 'Net income' : 'Ingresos netos');
  const inflowHint = showFlows
    ? t('balances.fromMovements')
    : tf(
        'balances.fromIncomeLines',
        locale === 'en' ? 'From Income (billing)' : 'De Ingresos (facturación)',
      );
  const monthResultHint = showFlows
    ? t('balances.monthResultHint')
    : tf(
        'balances.monthResultHintCompany',
        locale === 'en'
          ? 'Net income − Expenses − Amount to Distribute'
          : 'Ingresos netos − Egresos − Monto a Distribuir',
      );
  const { selectedPeriodId } = usePeriod();
  const userCanAdd = canAdd(user);

  const [selectedDate, setSelectedDate] = useState<string>(todayISO());
  const [snapshots, setSnapshots] = useState<ChannelBalance[]>([]);
  const [loadingSnap, setLoadingSnap] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [pinnedWallets, setPinnedWallets] = useState<PinnedCoinsbuyWallet[]>([]);
  const [showCoinsbuyModal, setShowCoinsbuyModal] = useState(false);
  const [showChannelConfig, setShowChannelConfig] = useState(false);
  // Saldo del libro por canal al cierre de la fecha seleccionada (migración
  // 059). Es la fuente de verdad para el histórico; el saldo en vivo de los
  // canales por API sigue saliendo de la API en el momento.
  const [ledgerBalances, setLedgerBalances] = useState<Record<string, number>>({});
  // Fecha del último asiento de cada canal (migración 112) — de acá sale el
  // "de cuándo es este saldo" de las ubicaciones manuales (ítem 23).
  const [ledgerLastEntry, setLedgerLastEntry] = useState<Record<string, string>>({});
  const [channelConfigRows, setChannelConfigRows] = useState<ChannelConfigRow[]>([]);
  // OJO: NO comparar `user.role === 'admin'` a mano. El superadmin en modo
  // "viendo como" no tiene fila en company_users y llega con role
  // 'superadmin', así que esa comparación le escondía "Configurar",
  // "Unidades de negocio" y la edición de ubicaciones — o sea que no podía
  // ni quitar ni agregar canales (Kevin, 2026-08-09).
  const isAdmin = isCompanyAdmin(user);
  // Access-control result is computed here but the early return happens at
  // the bottom of the component — pulling it up before the rest of the
  // hooks would violate the Rules of Hooks on re-renders where access
  // changes (e.g. role switch in the same session).
  const accessDenied = !useModuleAccess('balances');

  // ─── Section A: Balance Actual Disponible (chained across periods) ───
  // Formula per period: Net Deposit - Egresos Operativos - Monto a Distribuir
  // The result accumulates as the starting balance of the next period.
  //
  // For derived-broker periods (April 2026+), Net Deposit also includes the
  // API transactions persisted in api_transactions — otherwise the current
  // month would read as $0 until someone manually loads deposits in /upload.

  const [apiMonthly, setApiMonthly] = useState<Record<string, { deposits: number; withdrawals: number }>>({});
  const [apiTotalsLoading, setApiTotalsLoading] = useState(false);
  // ¿Falló la lectura de los totales de la API?
  //
  // ── EL BUG (auditoría de finanzas, ítem 13) ──────────────────────────────
  // Acá había un `catch {}` vacío con el comentario «Non-fatal — card will
  // fall back to 0 API contribution». No es no-fatal: sin `apiMonthly`, TODOS
  // los meses derivados (Abr 2026+) caen al Net Deposit manual y la tarjeta
  // muestra otro número sin avisar. Medido el 2026-08-31 sobre Vex Pro: agosto
  // pasaría de $551.405,97 a $169.853,00 — y ese número alimenta el Monto a
  // Distribuir a socios. Un fallo silencioso que reparte plata que no entró.
  //
  // El estado degradado se muestra; el número sigue siendo el mejor disponible.
  const [apiTotalsFailed, setApiTotalsFailed] = useState(false);

  const loadApiMonthly = useCallback(async () => {
    setApiTotalsLoading(true);
    try {
      // Pull the last 18 months of persisted API data — enough for the 6-month
      // window plus history for the accumulation chain.
      const end = new Date();
      const start = new Date(end.getFullYear(), end.getMonth() - 17, 1);
      const pad = (n: number) => String(n).padStart(2, '0');
      const from = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-01`;
      const to = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate())}`;
      const res = await apiFetch(`/api/integrations/period-totals?from=${from}&to=${to}`);
      const json = await res.json();
      if (json.success) {
        setApiMonthly(json.months ?? {});
        setApiTotalsFailed(false);
      } else {
        // `success: false` es un fallo igual que una excepción: el endpoint
        // devuelve 200 con `months: {}` cuando la RPC revienta.
        setApiTotalsFailed(true);
      }
    } catch (err) {
      console.error('[balances] period-totals:', err);
      // Se CONSERVA el `apiMonthly` anterior si ya se había cargado: un dato
      // de hace un minuto es mejor que ninguno. Lo que no se hace es fingir
      // que el mes no tuvo movimientos por la API.
      setApiTotalsFailed(true);
    } finally {
      setApiTotalsLoading(false);
    }
  }, []);

  // Load once on mount.
  useEffect(() => {
    loadApiMonthly();
  }, [loadApiMonthly]);

  const balanceChain = useMemo(() => {
    const saldoChain = computeSaldoChain();
    let acumulado = 0;
    const rows: Array<{
      periodId: string;
      label: string;
      netDeposit: number;
      egresos: number;
      montoDistribuir: number;
      balanceMes: number;
      saldoInicial: number;
      saldoFinal: number;
      /** El mes es derivado (Abr 26+) pero NO tenemos sus totales de API. */
      apiMissing: boolean;
      /** Período cerrado (insumos congelados) — badge Abierto/Cerrado. */
      isClosed: boolean;
    }> = [];

    for (const p of periods) {
      const summary = getPeriodSummary(p.id);
      if (!summary) continue;
      const saldoInfo = saldoChain.get(p.id);
      const montoDistribuir = saldoInfo?.totalDistribuir ?? 0;

      // Base net deposit from manual entries in /upload.
      //
      // En una empresa de servicios NO hay depósitos ni retiros de clientes:
      // el Net Deposit sería 0 en todos los meses y el acumulado caería a
      // "menos todos los egresos de la historia" — un número enorme, rojo y
      // falso (Kevin lo vio en -$356.870). Lo que entra en su caja son los
      // ingresos operativos cobrados, así que la fila del mes se arma con eso.
      //
      // El número sale de la CADENA (saldoInfo.ingresosNetos), no de una suma
      // propia sobre las tablas vivas (auditoría 2026-08, B3): la cadena ya
      // aplica el override de snapshot de los períodos cerrados, así que
      // reimplementar la suma acá hacía que un mes cerrado mostrara ingresos
      // de hoy junto a un Monto a Distribuir congelado — dos números de la
      // misma fila calculados sobre realidades distintas.
      let netDeposit = showFlows
        ? summary.netDeposit
        : (saldoInfo?.ingresosNetos ?? 0);

      // For derived-broker periods (Abr 2026+), replicate the EXACT formula
      // that /movimientos uses — la fuente de verdad. Si esto diverge, el
      // hero number de Balances (que alimenta el Monto a Distribuir a socios)
      // se desincroniza de lo que el usuario ve en Movimientos.
      //
      // Decisión final de Kevin (2026-06-06, /movimientos:254):
      //   displayTotalDeposits    = api.deposits + summary.totalDeposits
      //   displayTotalWithdrawals = api.withdrawals + storedBroker
      //   displayNetDeposit       = deposits − withdrawals
      //
      // Las categorías manuales Comisiones IB / Prop Firm / Otros son
      // estrictamente INFORMATIVAS — el usuario las carga en /upload pero NO
      // se suman al total de retiros (los retiros reales ya están en
      // Coinsbuy API + el manual Broker, que representa retiros Coinsbuy que
      // la API no alcanzó a reportar).
      //
      // La implementación anterior usaba la fórmula vieja (derivedBroker =
      // max(0, api.withdrawals − ib − prop − other) y sumaba ib+prop+other),
      // que inflaba los retiros cuando esas categorías eran > 0 — produciendo
      // un Net Deposit menor en Balances que en Movimientos. Para VexPro
      // (ib=prop=other=0) ambas daban igual, pero era un bug latente que
      // afectaba el Monto a Distribuir apenas alguien cargara esas categorías.
      let apiMissing = false;
      if (showFlows && isDerivedBrokerPeriod({ year: p.year, month: p.month })) {
        const ymKey = `${p.year}-${String(p.month).padStart(2, '0')}`;
        const api = apiMonthly[ymKey];
        // Sin datos de API el mes derivado se muestra con lo manual, pero
        // MARCADO: es el número equivocado con cara de número bueno.
        apiMissing = !api;
        if (api) {
          const storedBroker = summary.withdrawals.find((w) => w.category === 'broker')?.amount || 0;
          // Fórmula canónica compartida — misma que usa /movimientos.
          netDeposit = computeDerivedNetDeposit({
            apiDeposits: api.deposits,
            manualDepositsTotal: summary.totalDeposits,
            apiWithdrawals: api.withdrawals,
            manualBroker: storedBroker,
          }).netDeposit;
        }
      }

      // Mismo motivo: los egresos del mes son los de la cadena (congelados si
      // el período está cerrado), no el total vivo de la tabla de egresos.
      const egresos = saldoInfo?.egresosNetos ?? summary.totalExpenses;
      const balanceMes = netDeposit - egresos - montoDistribuir;
      const saldoInicial = acumulado;
      acumulado = saldoInicial + balanceMes;
      rows.push({
        periodId: p.id,
        label: p.label || `${p.year}-${String(p.month).padStart(2, '0')}`,
        netDeposit,
        egresos,
        montoDistribuir,
        balanceMes,
        saldoInicial,
        saldoFinal: acumulado,
        apiMissing,
        isClosed: Boolean(p.is_closed),
      });
    }
    return rows;
  }, [periods, getPeriodSummary, computeSaldoChain, apiMonthly, showFlows]);

  // The month shown in "Balance Actual Disponible". Starts tracking the
  // globally selected period, but the user can override it from the in-card
  // selector — this decouples "which balances-by-channel day am I viewing"
  // from "which month am I viewing in the accumulated balance card".
  const [balanceMonthPeriodId, setBalanceMonthPeriodId] = useState<string>('');
  useEffect(() => {
    // Initialize (or keep in sync when globally selected period changes and
    // the user hasn't overridden yet).
    if (!balanceMonthPeriodId && selectedPeriodId) {
      setBalanceMonthPeriodId(selectedPeriodId);
    }
  }, [selectedPeriodId, balanceMonthPeriodId]);

  const selectedIndex = useMemo(() => {
    const targetId = balanceMonthPeriodId || selectedPeriodId;
    const idx = balanceChain.findIndex(r => r.periodId === targetId);
    return idx >= 0 ? idx : balanceChain.length - 1;
  }, [balanceChain, balanceMonthPeriodId, selectedPeriodId]);

  const sixMonthWindow = useMemo(() => {
    if (selectedIndex < 0) return [];
    const from = Math.max(0, selectedIndex - 5);
    return balanceChain.slice(from, selectedIndex + 1);
  }, [balanceChain, selectedIndex]);

  const currentBalanceRow = balanceChain[selectedIndex];

  // ─── Section B: Balances por Canal (snapshots for selected date) ───

  // Auto-derived values from other modules. Computed on-the-fly because the
  // stored `balance` column on liquidity_movements / investments is always
  // 0 (insert bug — addLiquidityRow / addInvestmentRow never called
  // recalc*Balances). Running sum is the correct current balance regardless.
  const liquidityBalance = useMemo(() => {
    const data = getLiquidityData();
    return data.reduce((s, m) => s + m.deposit - m.withdrawal, 0);
  }, [getLiquidityData]);

  const investmentsBalance = useMemo(() => {
    const data = getInvestmentsData();
    return data.reduce((s, i) => s + i.deposit - i.withdrawal + i.profit, 0);
  }, [getInvestmentsData]);

  // ─── Coinsbuy Wallets (API en tiempo real) — declared early for getChannelValue ───
  interface WalletData {
    id: string;
    label: string;
    balanceConfirmed: number;
    balancePending: number;
    currencyCode: string;
    currencyName: string;
  }

  const [wallets, setWallets] = useState<WalletData[]>([]);
  const [walletsLoading, setWalletsLoading] = useState(false);
  const [walletsError, setWalletsError] = useState<string | null>(null);
  const [walletsFetchedAt, setWalletsFetchedAt] = useState<string | null>(null);
  const [walletsIsMock, setWalletsIsMock] = useState(false);

  const fetchWallets = useCallback(async () => {
    setWalletsLoading(true);
    setWalletsError(null);
    try {
      const res = await apiFetch('/api/integrations/coinsbuy/wallets');
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Error fetching wallets');
      setWallets(json.wallets ?? []);
      setWalletsFetchedAt(json.fetchedAt ?? new Date().toISOString());
      setWalletsIsMock(json.isMock ?? false);
    } catch (err) {
      setWalletsError(err instanceof Error ? err.message : 'Error');
    } finally {
      setWalletsLoading(false);
    }
  }, []);

  // Fetch on mount + auto-refresh every 5 minutes. The interval pauses
  // while the tab is hidden so we don't burn API quota on a backgrounded
  // page; when the tab becomes visible again we refresh immediately.
  useEffect(() => {
    fetchWallets();
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval) return;
      interval = setInterval(fetchWallets, 5 * 60 * 1000);
    };
    const stop = () => {
      if (interval) { clearInterval(interval); interval = null; }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        fetchWallets();
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchWallets]);

  // ── El toggle que prometía excluir y no excluía (borrado 2026-08-31) ──────
  // Cada wallet de Coinsbuy tenía un interruptor rotulado «Excluir del total» /
  // «Incluir en el total». Lo único que hacía era filtrar `walletTotal`, una
  // constante que NO se renderizaba en ninguna parte: el total consolidado sale
  // de las wallets FIJADAS (`pinned_coinsbuy_wallets`, migración 084) y de ahí
  // no lo sacaba nadie. O sea: el usuario apagaba una wallet, la fila se ponía
  // gris, y el total seguía igual. Un control que miente sobre el dinero es
  // peor que no tener control — quien quiera sacar una wallet del total la
  // despinnea, que es el mecanismo real y el que ya está a dos centímetros.
  // Ver la auditoría de finanzas, ítem 20.

  // Load pinned wallets from Supabase
  const loadPinnedWallets = useCallback(async () => {
    if (!company) return;
    // Por la API y no por el cliente del navegador: la lectura directa con RLS
    // no conoce la empresa ACTIVA del superadmin, así que fijar una wallet en
    // otra empresa escribía bien y leía vacío («0 fijadas», sin error).
    // Ver la cabecera de /api/admin/pinned-wallets.
    try {
      const res = await apiFetch('/api/admin/pinned-wallets');
      const json = await res.json();
      if (json?.success) {
        setPinnedWallets(
          (json.wallets ?? []).map((w: { wallet_id: string; wallet_label: string; role: PinnedWalletRole }) => ({
            company_id: company.id,
            wallet_id: w.wallet_id,
            wallet_label: w.wallet_label,
            role: w.role,
          })) as PinnedCoinsbuyWallet[],
        );
        return;
      }
    } catch {
      // Cae al camino viejo: mejor un dato por RLS que ninguno.
    }
    const pins = await fetchPinnedCoinsbuyWallets(company.id);
    setPinnedWallets(pins);
  }, [company]);

  useEffect(() => {
    loadPinnedWallets();
  }, [loadPinnedWallets]);

  // Pin / unpin handlers (admin only)
  const handlePin = async (walletId: string, label: string) => {
    if (!company) return;
    try {
      await pinCoinsbuyWallet(company.id, walletId, label);
      setOkMsg('Wallet fijada en Balances');
      setTimeout(() => setOkMsg(null), 2000);
      await loadPinnedWallets();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Error fijando wallet');
    }
  };

  // Rol de la wallet fijada (migración 084). Fijar suma SIEMPRE al balance;
  // el rol decide si además cuenta como depósitos/retiros de clientes:
  //   · Operativa → sí (default)
  //   · Interna   → no; solo balance (ahorro, pago de egresos, tesorería)
  // Sin esta distinción, Vex Pro fijó "Savings" y "Egresos Vex" para el
  // balance y /movimientos las contó como retiros: $932.444,83 en vez de
  // $469.650,98, con el Net Deposit en −$231.127.
  //
  // Textos en español literal a propósito: las claves i18n de esta UI todavía
  // no están en src/lib/i18n.tsx (ver scratchpad i18n-keys-wallet-roles.ts).
  const handleSetRole = async (walletId: string, role: PinnedWalletRole) => {
    if (!company) return;
    try {
      await setPinnedWalletRole(company.id, walletId, role);
      setOkMsg(role === 'internal' ? 'Wallet marcada como interna' : 'Wallet marcada como operativa');
      setTimeout(() => setOkMsg(null), 2000);
      await loadPinnedWallets();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Error cambiando el rol de la wallet');
    }
  };

  const handleUnpin = async (walletId: string) => {
    if (!company) return;
    try {
      await unpinCoinsbuyWallet(company.id, walletId);
      setOkMsg('Wallet removida de Balances');
      setTimeout(() => setOkMsg(null), 2000);
      await loadPinnedWallets();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Error removiendo wallet');
    }
  };

  const isPinned = (walletId: string) =>
    pinnedWallets.some(p => p.wallet_id === walletId);

  // Get balance of a pinned wallet from the API wallets data
  const getPinnedWalletBalance = (walletId: string): number => {
    const w = wallets.find(wl => wl.id === walletId);
    return w?.balanceConfirmed ?? 0;
  };

  // Total of all pinned wallet balances (for the consolidated total)
  const pinnedWalletsTotal = useMemo(() => {
    return pinnedWallets.reduce((sum, p) => sum + getPinnedWalletBalance(p.wallet_id), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedWallets, wallets]);

  // ─── UniPayment Balance (API en tiempo real) ───
  //
  // `null` = NO LO SABEMOS (todavía no respondió, o falló). No es 0.
  //
  // ── EL BUG (auditoría de finanzas, ítem 13) ──────────────────────────────
  // El estado arrancaba en `0` y el catch decía, literal, «Silent — channel
  // shows $0 on error». Un $0 nunca puede ser el estado de error: se lee como
  // "esta cuenta está vacía", que es una afirmación sobre la plata. Con `null`
  // el canal cae a su libro/snapshot —el mismo fallback que ya hacía
  // /api/balances/total-consolidado:179— y la pantalla lo marca como dato
  // degradado.
  const [unipaymentLive, setUnipaymentLive] = useState<number | null>(null);
  const [unipaymentFailed, setUnipaymentFailed] = useState(false);

  // ── On-chain EN VIVO (Kevin, 2026-09-01: «la trust wallet no está
  // sincronizada») ──────────────────────────────────────────────────────────
  // Estos canales se leían sólo en el cron de medianoche y la fila mostraba esa
  // foto todo el día: el 1/9 el snapshot decía 80.539,70 USDT y la cadena tenía
  // 14.807,54. Mismo contrato que los demás canales de API: en vivo si hoy,
  // libro/snapshot si falla (nunca 0), y `degraded` cuando el dato es viejo.
  const [onchainLive, setOnchainLive] = useState<Record<string, number>>({});
  const [onchainFailed, setOnchainFailed] = useState<string[]>([]);
  const [onchainReadAt, setOnchainReadAt] = useState<string | null>(null);
  useEffect(() => {
    // `selectedDate === hoy` en vez de `isToday`: esa constante se declara más
    // abajo y acá haría falta subirla sin necesidad.
    if (selectedDate !== todayISO()) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/admin/onchain-live');
        const json = await res.json();
        if (cancelled || !json?.success) {
          if (!cancelled) setOnchainFailed(['*']);
          return;
        }
        setOnchainLive(json.balances ?? {});
        setOnchainFailed(json.unavailable ?? []);
        setOnchainReadAt(json.readAt ?? null);
      } catch {
        if (!cancelled) setOnchainFailed(['*']);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedDate]);

  useEffect(() => {
    let cancelled = false;
    const fetchUniBalance = async () => {
      try {
        const res = await apiFetch('/api/integrations/unipayment/balances');
        const json = await res.json();
        if (cancelled) return;
        if (json.success && Array.isArray(json.balances) && json.balances.length > 0) {
          // Sum all available balances (primary wallet)
          const total = json.balances.reduce(
            (sum: number, b: { availableBalance: number }) => sum + (b.availableBalance ?? 0),
            0,
          );
          // `> 0` para que un 0 en vivo caiga al libro, MISMO criterio que
          // /api/balances/total-consolidado:179 — si los dos no coinciden, la
          // home y esta pantalla muestran totales distintos.
          setUnipaymentLive(total > 0 ? total : null);
          setUnipaymentFailed(false);
        } else if (!json.success) {
          setUnipaymentFailed(true);
        }
      } catch (err) {
        if (cancelled) return;
        console.error('[balances] unipayment:', err);
        setUnipaymentFailed(true);
      }
    };
    fetchUniBalance();
    let interval: ReturnType<typeof setInterval> | null = setInterval(fetchUniBalance, 5 * 60 * 1000);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        fetchUniBalance();
        if (!interval) interval = setInterval(fetchUniBalance, 5 * 60 * 1000);
      } else if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Load per-company channel_configs (toggle/rename/custom channels).
  // A missing row for a built-in = "visible, default label" (see resolveChannels).
  const loadChannelConfigs = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/channel-configs');
      const json = (await res.json()) as { success: boolean; rows?: ChannelConfigRow[] };
      if (json.success) setChannelConfigRows(json.rows ?? []);
    } catch {
      // Non-fatal — page falls back to all built-ins visible.
    }
  }, []);
  useEffect(() => {
    loadChannelConfigs();
  }, [loadChannelConfigs]);

  const resolvedChannels: ResolvedChannel[] = useMemo(
    () => resolveChannelConfigs(channelConfigRows),
    [channelConfigRows],
  );
  const visibleChannels = useMemo(
    () => resolvedChannels.filter((c) => c.isVisible),
    [resolvedChannels],
  );

  // Load snapshots for selected date
  const loadSnapshots = async () => {
    if (!company) return;
    setLoadingSnap(true);
    setErrMsg(null);
    try {
      const data = await fetchChannelBalances(company.id, selectedDate);
      setSnapshots(data);
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Error cargando snapshots');
    } finally {
      setLoadingSnap(false);
    }
  };

  useEffect(() => {
    loadSnapshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id, selectedDate]);

  // Helper: get value for a channel for the selected date.
  //
  // Resolution order per channel:
  //   1. If viewing TODAY → prefer LIVE API value. The 00:00 UTC snapshot
  //      becomes stale within minutes once deposits/withdrawals start
  //      flowing — using it would show numbers that disagree with the
  //      per-wallet detail rendered below from the same live API call
  //      (Audit 2026-05-01: aggregate showed $94,774 vs per-wallet sum
  //      $51,893 because snapshot fired at 00:00 UTC and ~$43K of
  //      withdrawals happened between then and the user's view).
  //   2. If viewing a PAST DATE → use the channel_balances snapshot
  //      (written by the daily cron at 00:00 UTC of the next day, or by
  //      manual edits for non-API channels).
  //   3. Zero as last resort.
  //
  // For liquidez/inversiones, we can always reconstruct the balance from
  // the movements table on the fly, so we use that directly.
  const isToday = selectedDate === todayISO();

  // Saldo del libro al cierre de la fecha elegida (migración 059).
  useEffect(() => {
    if (!company?.id) return;
    let cancelled = false;
    apiFetch(`/api/admin/channel-ledger/balances?asof=${selectedDate}`)
      .then((r) => r.json())
      .then(
        (json: {
          success?: boolean;
          balances?: Record<string, number>;
          lastEntry?: Record<string, string>;
        }) => {
          if (cancelled || !json.success) return;
          setLedgerBalances(json.balances ?? {});
          setLedgerLastEntry(json.lastEntry ?? {});
        },
      )
      .catch(() => {
        // Sin libro cargado, cada canal cae a su snapshot histórico.
        if (!cancelled) {
          setLedgerBalances({});
          setLedgerLastEntry({});
        }
      });
    return () => { cancelled = true; };
  }, [company?.id, selectedDate]);

  /**
   * ¿Se pudo leer el saldo EN VIVO de Coinsbuy?
   *
   * `walletsFetchedAt === null` es "todavía no contestó", no "no hay plata":
   * durante la primera carga la pantalla muestra el libro en vez de un $0 que
   * dura medio segundo y asusta.
   */
  const coinsbuyLiveKnown = walletsError === null && walletsFetchedAt !== null;

  /**
   * De dónde sale el saldo de un canal, cuánto es, y de cuándo.
   *
   * La elección libro-vs-snapshot NO se reimplementa acá: es `pickChannelAmount`
   * del módulo puro compartido, la misma que usan el reporte y
   * /api/balances/total-consolidado. Lo propio de esta pantalla es la rama
   * EN VIVO — y su fallback, que es el ítem 13 de la auditoría:
   *
   *   `if (isToday) return pinnedWalletsTotal;` no tenía respaldo. Con la API
   *   de Coinsbuy caída, `wallets` queda vacío, `pinnedWalletsTotal` da 0 y el
   *   canal mostraba **$0,00** en vez de los $244.079,51 que el libro sabe.
   *   El patrón correcto ya existía en /api/balances/total-consolidado:163,179
   *   (si la API falla, cae al libro); acá faltaba.
   */
  const resolveChannel = (
    key: string,
  ): { amount: number; source: ReportChannelSource; asOf: string | null; degraded: boolean } => {
    if (key === 'liquidez') {
      return { amount: liquidityBalance, source: 'computed', asOf: null, degraded: false };
    }
    if (key === 'inversiones') {
      return { amount: investmentsBalance, source: 'computed', asOf: null, degraded: false };
    }

    const snap = snapshots.find((s) => s.channel_key === key);
    const stored = pickChannelAmount({
      channelKey: key,
      ledgerBalance: ledgerBalances[key],
      snapshot: snap ? { amount: snap.amount, source: snap.source ?? 'manual' } : undefined,
    });
    const storedAsOf =
      stored.source === 'ledger'
        ? (ledgerLastEntry[key] ?? null)
        : stored.source === 'missing'
          ? null
          : (snap?.snapshot_date ?? null);
    const storedRow = { ...stored, asOf: storedAsOf, degraded: false };

    // Canales por API: el saldo EN VIVO es lo que devuelve la API en este
    // momento (decisión de Kevin). El libro manda para cualquier fecha
    // pasada, porque cierra exacto contra el saldo real de ese día. La
    // decisión vivo-vs-respaldo es `pickLiveOrStored`, compartida y testeada.
    if (key === 'coinsbuy' && isToday) {
      return pickLiveOrStored({
        live: coinsbuyLiveKnown ? pinnedWalletsTotal : null,
        liveFailed: walletsError !== null,
        liveAsOf: walletsFetchedAt,
        stored,
        storedAsOf,
      });
    }
    if (key === 'unipayment' && isToday) {
      return pickLiveOrStored({
        live: unipaymentLive,
        liveFailed: unipaymentFailed,
        liveAsOf: new Date().toISOString(),
        stored,
        storedAsOf,
      });
    }

    // Canales ON-CHAIN: la clave es un dato (wallet_externa o custom_*), así
    // que el caso no se puede escribir por nombre — se reconoce porque el
    // endpoint devolvió saldo para esa clave (o la marcó no disponible).
    const esOnchain =
      Object.prototype.hasOwnProperty.call(onchainLive, key) ||
      onchainFailed.includes(key) ||
      onchainFailed.includes('*');
    if (esOnchain && isToday) {
      return pickLiveOrStored({
        live: onchainLive[key] ?? null,
        liveFailed: onchainFailed.includes(key) || onchainFailed.includes('*'),
        liveAsOf: onchainReadAt,
        stored,
        storedAsOf,
      });
    }

    return storedRow;
  };

  const getChannelValue = (key: string): number => resolveChannel(key).amount;

  /**
   * Lo que la tarjeta necesita para pintar la fila: de cuándo es el saldo, si
   * está viejo y si es un dato degradado (la API no contestó). Se calcula acá
   * porque acá viven las fuentes; la tarjeta sólo lo muestra.
   */
  const getChannelMeta = (key: string) => {
    const row = resolveChannel(key);
    return {
      source: row.source,
      asOf: row.asOf,
      degraded: row.degraded,
      stale: isStaleBalance({ source: row.source, updatedAt: row.asOf, asOf: selectedDate }),
    };
  };

  // Los canales con saldo degradado (API caída), viejos o sin dato los cuenta
  // y los nombra la tarjeta, con el monto que siguen sumando
  // (balances-view.ts → freshnessSummary). Acá sólo se resuelve la fuente.

  /**
   * Canales ocultos desde «Configurar»: NO suman al total. Se pasan por nombre
   * para que el pie de la tabla lo diga — una exclusión silenciosa es
   * indistinguible de «no hay más» (reglas §1.2).
   */
  const hiddenChannels = useMemo(
    () => resolvedChannels.filter((c) => !c.isVisible).map((c) => c.label),
    [resolvedChannels],
  );

  /**
   * Desglose que el cron dejó guardado con el snapshot (migración 085).
   *
   * Solo se devuelve el de una wallet on-chain, que es el único que hoy tiene
   * forma conocida. Sale del MISMO snapshot que ya se carga para la fecha
   * elegida: mirar el detalle por moneda no dispara ninguna consulta nueva —
   * ni a la base ni, mucho menos, a la blockchain.
   */
  const getSnapshotMeta = (key: string): OnchainSnapshotMeta | null => {
    const meta = snapshots.find((s) => s.channel_key === key)?.meta;
    if (!meta || typeof meta !== 'object') return null;
    const candidate = meta as OnchainSnapshotMeta;
    return candidate.kind === 'onchain' && Array.isArray(candidate.networks) ? candidate : null;
  };

  const exportChannelsPdf = () => {
    const typeByKey = new Map(
      channelConfigRows.map((r) => [r.channel_key, normalizeLocationType(r.location_type)]),
    );
    const items = visibleChannels.map((ch) => ({
      ch,
      location_type: normalizeLocationType(typeByKey.get(ch.key)),
      balance: getChannelValue(ch.key),
    }));
    generateChannelBalancesPDF({
      company: { name: company?.name ?? 'Dashboard', logoUrl: company?.logo_url ?? null },
      asOf: selectedDate,
      // Una deuda (préstamo recibido) sale con signo negativo para que las
      // filas cierren contra el total del pie.
      channels: items.map((it) => ({
        label: it.ch.label,
        isAuto: isAutoLedger(it.ch.key) || it.ch.type === 'auto',
        debt: isDebt(it.location_type),
        balance: signedBalance(it),
      })),
      // Total consolidado — suma SOLO los canales visibles (los ocultados con
      // el toggle en el modal "Configurar" no aportan al total). NETO de deuda
      // y calculado por `tallyCash`, la misma fórmula que la tarjeta de arriba
      // y /api/balances/total-consolidado: sumar `getChannelValue` a mano acá
      // contaba un préstamo recibido como plata propia.
      total: tallyCash(items).total,
      locale: locale === 'en' ? 'en' : 'es',
    });
  };

  // ─── Section C: Coinsbuy Wallets (state + fetch declared above) ───

  if (accessDenied) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-text-3">{t('common.noAccess')}</p>
      </div>
    );
  }

  // Una empresa recién creada no tiene períodos: sin este corte la pantalla
  // arma tarjetas y tablas vacías sobre un chain sin filas.
  if (!loading && periods.length === 0) return <NoPeriodsState />;

  // ─── Resultado mensual (FinTable densa) ───
  // Columnas con signo: lo que entra (+) y lo que sale (−) se leen sin pensar.
  // Sólo «Resultado» lleva color (tono `sign`): es la columna donde el signo ES
  // la noticia (spec §2.1). «A distribuir» dejó de ser naranja — no significaba
  // nada que el gris no diga.
  type MonthRow = (typeof balanceChain)[number];
  const monthColumns: FinColumn<MonthRow>[] = [
    {
      key: 'period',
      header: t('balances.period'),
      cell: (r) => r.label,
      meta: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5 py-0.5">
          <StatusBadge
            kind={r.isClosed ? 'neutral' : 'pend'}
            label={r.isClosed ? t('balances.statusClosed') : t('balances.statusOpen')}
          />
          {/* El mes derivado sin totales de la API se muestra con lo manual,
              pero MARCADO: es el número equivocado con cara de número bueno. */}
          {r.apiMissing && <StatusBadge kind="pend" label={t('balances.apiMissingBadge')} />}
        </span>
      ),
      // En tarjeta (< 720 px) las columnas de detalle se ocultan; sus cifras
      // van acá, bajo el mes, para no perder nada.
      mobileMeta: (r) => (
        <span className={cn(NUM_CLASS, 'whitespace-normal')}>
          {inflowLabel} {moneyText(r.netDeposit, { signed: true })} · {t('balances.colExpenses')}{' '}
          {moneyText(-r.egresos, { signed: true })} · {t('balances.colDistribute')}{' '}
          {moneyText(-r.montoDistribuir, { signed: true })}
        </span>
      ),
    },
    {
      key: 'inflow',
      header: inflowLabel,
      kind: 'money',
      value: (r) => r.netDeposit,
      money: { signed: true, tone: 'neutral' },
      hideSm: true,
    },
    {
      key: 'expenses',
      header: t('balances.colExpenses'),
      kind: 'money',
      value: (r) => -r.egresos,
      money: { signed: true, tone: 'neutral' },
      hideSm: true,
    },
    {
      key: 'distribute',
      header: t('balances.colDistribute'),
      kind: 'money',
      value: (r) => -r.montoDistribuir,
      money: { signed: true, tone: 'neutral' },
      hideSm: true,
    },
    {
      key: 'result',
      header: t('balances.colResult'),
      kind: 'money',
      value: (r) => r.balanceMes,
      money: { signed: true, tone: 'sign' },
    },
    {
      key: 'accumulated',
      header: t('balances.accumulated'),
      kind: 'money',
      value: (r) => r.saldoFinal,
    },
  ];

  return (
    <div className="space-y-4">
      {/* La fecha de corte manda sobre todos los saldos por canal. El cron
          escribe un snapshot diario a las 00:00 UTC, así que cualquier día
          pasado se puede consultar. No es el período de la topbar: es el día
          del saldo. */}
      <PageHeader
        title={t('balances.title')}
        subtitle={t('balances.subtitle')}
        icon={Wallet}
        actions={
          <>
            <div className="w-[156px]">
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                aria-label={t('balances.snapshotDate')}
                className="h-8 [@media(pointer:coarse)]:h-10"
              />
            </div>
            <button
              type="button"
              onClick={loadSnapshots}
              disabled={loadingSnap}
              className={ICON_BTN}
              title={t('balances.reload')}
              aria-label={t('balances.reload')}
            >
              <RefreshCw aria-hidden className={cn('size-[15px]', loadingSnap && 'animate-spin')} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={exportChannelsPdf}
              disabled={visibleChannels.length === 0}
              className={BTN}
              title={t('ledger.exportPdf')}
            >
              <FileDown aria-hidden className="size-[15px]" strokeWidth={1.75} />
              PDF
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setShowChannelConfig(true)}
                className={BTN}
                title={t('balances.configureChannels')}
              >
                <Settings2 aria-hidden className="size-[15px]" strokeWidth={1.75} />
                <span className="max-sm:sr-only">{t('balances.configure')}</span>
              </button>
            )}
          </>
        }
      />

      {okMsg && (
        <p role="status" className="text-[13px] font-medium text-pos">
          {okMsg}
        </p>
      )}
      {errMsg && <Notice kind="bad" title={errMsg} />}

      {/* ═══════════ BALANCES POR CANAL ═══════════
          Va primero porque es la pregunta que el módulo responde antes que
          ninguna otra: cuánto se puede usar hoy y cuánto está afuera.
          Dato degradado (ítem 13 de la auditoría de finanzas): un $0 no puede
          ser el estado de error. Cuando una API no contesta se muestra el
          mejor dato disponible (el libro) Y se dice — ahora con el monto que
          sigue sumando: lo hace la tarjeta (banner `stale`). */}
      <ChannelBalancesCard
        channels={visibleChannels}
        hiddenChannels={hiddenChannels}
        configRows={channelConfigRows}
        getValue={getChannelValue}
        onChanged={loadChannelConfigs}
        canManage={isAdmin}
        selectedDate={selectedDate}
        getSnapshotMeta={getSnapshotMeta}
        getBalanceMeta={getChannelMeta}
        extraActions={(key) =>
          key === 'coinsbuy' && isAdmin ? (
            <button
              type="button"
              onClick={() => setShowCoinsbuyModal(true)}
              className={ROW_BTN}
              aria-label={t('balances.editWallets')}
              title={t('balances.chooseCoinsbuyWallets')}
            >
              <Edit2 aria-hidden className="size-4" strokeWidth={1.75} />
            </button>
          ) : null
        }
        extraRows={(key) =>
          key === 'coinsbuy' && pinnedWallets.length > 0 ? (
            <div className="mt-1">
              <p className="text-[12px] text-text-3">{t('balances.pinnedTitle')}</p>
              <ul className="mt-1.5 divide-y divide-border rounded-ui-md border border-border">
                {pinnedWallets.map((pw) => {
                  const wData = wallets.find((wl) => wl.id === pw.wallet_id);
                  return (
                    <li key={pw.wallet_id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground">
                          <span className="truncate">{pw.wallet_label}</span>
                          {/* Qué significa el pin de esta wallet: la interna
                              suma acá pero NO en /movimientos (migr. 084). */}
                          <StatusBadge
                            kind={pw.role === 'internal' ? 'neutral' : 'info'}
                            label={pw.role === 'internal' ? 'interna' : 'operativa'}
                            title={
                              pw.role === 'internal'
                                ? 'Interna: suma al balance, no cuenta como depósitos ni retiros de clientes'
                                : 'Operativa: suma al balance y cuenta como depósitos y retiros de clientes'
                            }
                          />
                        </p>
                        <p className="text-[12px] text-text-3">
                          {wData?.currencyCode ?? 'USDT'} · Wallet #{pw.wallet_id}
                        </p>
                      </div>
                      {/* Sin respuesta de la API la wallet no tiene saldo
                          conocido: «—», no $0.00 (reglas §1.3). El total del
                          canal no cambia: cae al libro (pickLiveOrStored). */}
                      <Money
                        value={wData ? wData.balanceConfirmed : null}
                        nullLabel={t('ui.noData')}
                        className="text-[13px] font-medium"
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null
        }
      />

      {/* ═══════════ RESULTADO MENSUAL ═══════════ */}
      <Panel
        title={t('balances.monthlyTitle')}
        hint={monthResultHint}
        flush
        actions={
          <>
            {/* Mes elegido — cada opción dice cómo cerró ese mes. */}
            {balanceChain.length > 0 && (
              <div className="w-[220px] max-sm:w-full">
                <Select
                  value={balanceMonthPeriodId || selectedPeriodId || ''}
                  onChange={(e) => setBalanceMonthPeriodId(e.target.value)}
                  aria-label={t('balances.selectMonth')}
                  className="h-8 [@media(pointer:coarse)]:h-10"
                >
                  {balanceChain.map((r) => (
                    <option key={r.periodId} value={r.periodId}>
                      {r.label} — {formatMoney(r.saldoFinal)}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {/* Refrescar los totales de la API — relee api_transactions para
                que el mes en curso tome los datos frescos. */}
            <button
              type="button"
              onClick={loadApiMonthly}
              disabled={apiTotalsLoading}
              className={ICON_BTN}
              title={t('balances.refreshApi')}
              aria-label={t('balances.refreshApi')}
            >
              <RefreshCw
                aria-hidden
                className={cn('size-[15px]', apiTotalsLoading && 'animate-spin')}
                strokeWidth={1.75}
              />
            </button>
          </>
        }
        footer={
          currentBalanceRow ? (
            <div className="space-y-1">
              {sixMonthWindow.length < balanceChain.length && (
                <p>
                  {t('balances.monthlyShowing', {
                    shown: String(sixMonthWindow.length),
                    total: String(balanceChain.length),
                    label: currentBalanceRow.label,
                  })}
                </p>
              )}
              <p>
                {t('balances.monthlySources', {
                  inflow: inflowLabel,
                  inflowHint,
                  expensesHint: t('balances.fromExpenses'),
                  partnersHint: t('balances.fromPartners'),
                })}
              </p>
            </div>
          ) : undefined
        }
      >
        {/* Sin los totales de la API, los meses derivados (Abr 2026+) caen a lo
            cargado a mano — y ese número alimenta el Monto a Distribuir. Se
            muestra el mejor dato Y se avisa (auditoría de finanzas, ítem 13). */}
        {apiTotalsFailed && (
          <div className="border-b border-border p-4">
            <Notice kind="pend" title={t('balances.degradedTitle')}>
              {t('balances.degradedPeriodTotals')}
            </Notice>
          </div>
        )}

        {currentBalanceRow ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-border px-4 py-3">
              <span className="text-[12px] font-medium text-text-2">
                {t('balances.balanceMonth')} · {currentBalanceRow.label}
              </span>
              <Money
                value={currentBalanceRow.balanceMes}
                signed
                tone="sign"
                className="text-[22px] font-semibold leading-7 tracking-[-0.02em]"
              />
              <span className="text-[12.5px] text-text-3">
                {t('balances.previousMonthBalance')}{' '}
                <Money value={currentBalanceRow.saldoInicial} className="font-medium" />
              </span>
              <span className="text-[12.5px] text-text-3">
                {t('balances.accumulated')} <Money value={currentBalanceRow.saldoFinal} className="font-medium" />
              </span>
            </div>
            <FinTable<MonthRow>
              caption={t('balances.monthlyTitle')}
              columns={monthColumns}
              rows={sixMonthWindow}
              rowKey={(r) => r.periodId}
              selectedKey={currentBalanceRow.periodId}
              onRowClick={(r) => setBalanceMonthPeriodId(r.periodId)}
            />
          </>
        ) : (
          <p className="py-8 text-center text-[13px] text-text-3">{t('balances.noData')}</p>
        )}
      </Panel>

      {/* Modal: channel visibility / rename / add custom (admin only).
          Opens from the "Configurar" button in the page header. */}
      {isAdmin && (
        <ChannelConfigModal
          open={showChannelConfig}
          onClose={() => setShowChannelConfig(false)}
          onChanged={() => {
            loadChannelConfigs();
            loadSnapshots();
          }}
          getValue={getChannelValue}
        />
      )}

      {/* Modal: Coinsbuy wallet selector (admin only, triggered from the
          pencil button on the Coinsbuy row above). Lets admin pick which
          wallets get summed into the Balances por Canal total. */}
      {isAdmin && showCoinsbuyModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
          onClick={() => setShowCoinsbuyModal(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="coinsbuy-wallets-title"
            className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-ui-xl border border-border bg-card shadow-3"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="shrink-0 rounded-ui-md bg-brand-tint p-1.5 text-brand-ink" aria-hidden>
                  <Wallet className="size-5" />
                </div>
                <div className="min-w-0">
                  <h2 id="coinsbuy-wallets-title" className="text-[15px] font-semibold text-foreground">
                    {t('balances.coinsbuyWallets')}
                  </h2>
                  <p className="text-[12.5px] text-text-3">
                    {t('balances.coinsbuyWalletsHint')}
                    {walletsIsMock && <span className="ml-1 font-medium text-pend">(Mock)</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {walletsFetchedAt && (
                  <span className="hidden text-[12px] text-text-3 sm:inline">
                    Sync: {new Date(walletsFetchedAt).toLocaleTimeString('es-ES')}
                  </span>
                )}
                <button
                  type="button"
                  onClick={fetchWallets}
                  disabled={walletsLoading}
                  className={ICON_BTN}
                  title={t('balances.refreshWallets')}
                  aria-label={t('balances.refreshWallets')}
                >
                  <RefreshCw
                    aria-hidden
                    className={cn('size-[15px]', walletsLoading && 'animate-spin')}
                    strokeWidth={1.75}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => setShowCoinsbuyModal(false)}
                  className={ROW_BTN}
                  aria-label={t('common.close')}
                >
                  <X aria-hidden className="size-4" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5">
              {walletsError && (
                <Notice kind="bad" title={walletsError} className="mb-3">
                  {walletsFetchedAt
                    ? t('balances.staleData', { time: new Date(walletsFetchedAt).toLocaleString('es-ES') })
                    : null}
                </Notice>
              )}

              <p className="mb-3 text-[12.5px] text-text-3">{t('balances.pinHint')}</p>

              {wallets.length > 0 ? (
                <ul className="divide-y divide-border rounded-ui-md border border-border">
                  {wallets.map((w) => {
                    const pinned = isPinned(w.id);
                    return (
                      <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-foreground">{w.label}</p>
                          <p className="text-[12px] text-text-3">
                            {w.currencyCode}
                            {w.balancePending > 0 && (
                              <span className="ml-2 text-pend">
                                {/* Cantidad en la moneda de la wallet (cripto), no USD:
                                    no pasa por formatMoney (spec §8). */}
                                {t('expenses.pending')}:{' '}
                                {w.balancePending.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={cn(NUM_CLASS, 'text-[13px] font-medium text-foreground')}>
                            {w.balanceConfirmed.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 8,
                            })}{' '}
                            {w.currencyCode}
                          </span>
                          {pinned ? (
                            <>
                              {/* Rol de la wallet fijada: Operativa cuenta como
                                  depósitos/retiros de clientes; Interna solo
                                  suma al balance (migración 084). */}
                              <div className="w-[170px]">
                                <Select
                                  value={pinnedWallets.find((p) => p.wallet_id === w.id)?.role ?? 'operating'}
                                  onChange={(e) => handleSetRole(w.id, e.target.value as PinnedWalletRole)}
                                  aria-label="Rol de la wallet fijada"
                                  title="Operativa: cuenta como depósitos y retiros de clientes. Interna: solo suma al balance (ahorro, egresos)."
                                  className="h-8 [@media(pointer:coarse)]:h-10"
                                >
                                  <option value="operating">Operativa</option>
                                  <option value="internal">Interna (solo balance)</option>
                                </Select>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleUnpin(w.id)}
                                aria-pressed="true"
                                className={cn(ROW_BTN, 'text-brand-ink')}
                                title={t('balances.unpinTitle')}
                                aria-label={`${t('balances.unpinTitle')} — ${w.label}`}
                              >
                                <PinOff aria-hidden className="size-4" strokeWidth={1.75} />
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handlePin(w.id, w.label)}
                              aria-pressed="false"
                              className={ROW_BTN}
                              title={t('balances.pinTitle')}
                              aria-label={`${t('balances.pinTitle')} — ${w.label}`}
                            >
                              <Pin aria-hidden className="size-4" strokeWidth={1.75} />
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : walletsLoading ? (
                <p className="py-8 text-center text-[13px] text-text-3">{t('balances.loadingWallets')}</p>
              ) : (
                <p className="py-8 text-center text-[13px] text-text-3">{t('balances.noActiveWallets')}</p>
              )}
            </div>

            {/* Footer totals */}
            {wallets.length > 0 && (
              <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-[.03em] text-text-3">
                    {t('balances.pinnedWallets')}
                  </p>
                  <p className="text-[12px] text-text-3">
                    {t('balances.pinnedCount', { count: String(pinnedWallets.length) })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCoinsbuyModal(false)}
                  className="inline-flex h-8 items-center rounded-ui-md bg-primary px-4 text-[13px] font-medium text-brand-on-primary hover:bg-primary/90 [@media(pointer:coarse)]:h-10"
                >
                  {t('balances.done')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
