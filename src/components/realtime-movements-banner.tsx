'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { RefreshCw, Calendar, Wallet, Pin, PinOff } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { Input, Select } from '@/components/ui/field';
import { relativeAge } from '@/components/ui/relative-age';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useAuth, isCompanyAdmin } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { computeProviderTotals, countPayprosPayouts } from '@/lib/api-integrations/totals';
import {
  apiWithdrawalsFromDatasets,
  sumApiWithdrawals,
  type WithdrawalsByChannel,
} from '@/lib/withdrawal-channels';
import { PROVIDER_META } from '@/lib/api-channels';
import { pendingFromDatasets } from '@/lib/movements-ledger';
import { apiFetch } from '@/lib/api-fetch';
import {
  pinCoinsbuyWallet,
  unpinCoinsbuyWallet,
  setPinnedWalletRole,
} from '@/lib/supabase/mutations';
import { fetchPinnedCoinsbuyWallets } from '@/lib/supabase/queries';
import { selectOperatingWallets, type PinnedWalletRole } from '@/lib/pinned-wallet-roles';
import type { PinnedCoinsbuyWallet } from '@/lib/types';
import { useReportDataFreshness } from '@/lib/data-freshness';
import type {
  ProviderDataset,
  ProviderSlug,
} from '@/lib/api-integrations/types';

// ─────────────────────────────────────────────────────────────────────────────
// RealTimeMovementsBanner — panel «APIs en tiempo real» de /movimientos.
//
// Tiene su PROPIO filtro de fechas (mes o rango) y de wallet de Coinsbuy, y
// lee /api/integrations/persisted-movements (caché en Supabase); sólo
// «Sincronizar ahora» llama a las APIs externas.
//
// REDISEÑO «Libro mayor» (2026-10-12): las 4-6 tarjetas por proveedor pasan a
// un `Panel` con una `FinTable` compacta — proveedor, estado (`StatusBadge`
// ok/stale/bad según `ds.status`), última sync «hace X», total con signo. Las
// tarjetas de Coinsbuy por wallet operativa (Main / Instant) son filas de su
// propio grupo. Por qué:
//   · cada tarjeta pintaba el importe con un color por proveedor
//     (`PROVIDER_META.accent`) y el estado con un ícono verde/ámbar/rojo de
//     14 px sin texto: color sin significado y estado sólo por color;
//   · 12 clases de paleta cruda + 4 `dark:` + 6 textos de 10-11 px (medido
//     antes del cambio) que no siguen el tema ni llegan al mínimo de 11.5 px;
//   · el «Refrescar desde APIs» era un botón de borde tenue: es la única
//     acción primaria de la pantalla y ahora se ve como tal.
// DESCARTADO: dejar `PROVIDER_META.accent` en uso (sigue en el registro para
// no tocar src/lib en esta tanda; queda sin consumidores en esta pantalla).
// ─────────────────────────────────────────────────────────────────────────────

// ── Current month helpers ──

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function currentMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function monthBounds(yearMonth: string): { from: string; to: string } {
  const [y, m] = yearMonth.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return {
    from: `${y}-${pad(m)}-01`,
    to: `${y}-${pad(m)}-${pad(last)}`,
  };
}

type FilterMode = 'month' | 'range';

interface WalletOption {
  id: string;
  label: string;
  currencyCode: string;
}

// Sentinel meaning "no default wallet chosen yet — use the tenant's
// configured default (companies.default_wallet_id) or the first wallet
// the API returns, in that order". Kept as an exported constant for
// back-compat with older callers that still passed it explicitly.
//
// The old literal '1079' (VexPro's Main Wallet ID) was removed in
// migration-031. Every tenant now owns its default_wallet_id on the
// companies row; resolveInitialWalletId() below applies the fallback
// chain uniformly.
export const DEFAULT_WALLET_ID = '';

/**
 * Resolves the wallet id we should show on first render.
 *
 *   1. Controlled prop wins (the Movimientos page lifts state)
 *   2. Tenant's default_wallet_id from the companies row
 *   3. Sentinel '' — banner later swaps to the first API wallet in a
 *      useEffect once walletOptions arrive
 */
function resolveInitialWalletId(
  controlled: string | undefined,
  tenantDefault: string | null | undefined,
): string {
  if (controlled !== undefined) return controlled;
  if (tenantDefault) return tenantDefault;
  return '';
}

interface BannerProps {
  /** Optional controlled wallet id. When provided, banner becomes controlled
   *  and propagates changes via onWalletChange. Used so the Movimientos
   *  page can keep the banner AND the "Depósitos" table in sync (same
   *  walletId → same totals). */
  walletId?: string;
  onWalletChange?: (walletId: string) => void;
  /** Fires after the banner finishes a live sync (user pressed "Refrescar").
   *  The parent page uses this to invalidate its own persisted-movements
   *  cache so the tables below update with the freshly synced data. */
  onAfterLiveSync?: () => void;
}

export function RealTimeMovementsBanner({ walletId: walletIdProp, onWalletChange, onAfterLiveSync }: BannerProps = {}) {
  const { t } = useI18n();
  const { user } = useAuth();
  // «Ahora» para «hace X», tomado al montar (Date.now() en el render no es
  // puro). Tras «Sincronizar» la marca nueva es posterior y se lee «recién».
  const [now] = useState(() => Date.now());
  const { company } = useData();
  // isCompanyAdmin y no `user.role === 'admin'`: el superadmin en modo
  // "viendo como" llega con role 'superadmin' y quedaba sin selector de
  // wallet (mismo bug que escondía "Configurar" en Balances).
  const isAdmin = isCompanyAdmin(user);

  const [mode, setMode] = useState<FilterMode>('month');
  const [month, setMonth] = useState<string>(currentMonthStr());
  const [rangeFrom, setRangeFrom] = useState<string>('');
  const [rangeTo, setRangeTo] = useState<string>('');
  // Initial wallet id comes from the tenant's companies.default_wallet_id.
  // If null (tenant hasn't picked one yet) we fall through to '' and let
  // the walletOptions-sync effect below pick the first API wallet.
  const [walletIdLocal, setWalletIdLocal] = useState<string>(
    resolveInitialWalletId(walletIdProp, company?.default_wallet_id),
  );
  const walletId = walletIdProp ?? walletIdLocal;
  const setWalletId = (id: string) => {
    if (onWalletChange) onWalletChange(id);
    else setWalletIdLocal(id);
  };
  const [walletOptions, setWalletOptions] = useState<WalletOption[]>([]);

  const [datasets, setDatasets] = useState<ProviderDataset[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  // La topbar muestra «Actualizado hace X» con ESTA marca: es el
  // `last_synced_at` real de api_sync_log (o la hora de la llamada en vivo
  // tras «Refrescar»). `null` = nunca sincronizó → la topbar no muestra nada.
  useReportDataFreshness('movements:api', fetchedAt);
  // Proveedores cuyo dataset vino RECORTADO por el techo de paginación del
  // endpoint. Hasta el 2026-08-31 ese corte sólo dejaba un console.warn del
  // lado del servidor y la tarjeta mostraba un total corto con cara de total
  // completo (auditoría de finanzas, ítem 19).
  const [truncatedSlugs, setTruncatedSlugs] = useState<ProviderSlug[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Wallets pinneadas, con su ROL (company-wide, misma tabla que /balances).
  // Permite pinnear/despinnear y cambiar el rol desde acá; tras el cambio se
  // refrescan los totales vía onAfterLiveSync.
  //
  // BUG-05 (reescrito 2026-08-17): pinnear significaba UNA sola cosa y en
  // realidad son dos. Las wallets pineadas suman TODAS al balance, pero solo
  // las OPERATIVAS cuentan como depósitos/retiros de clientes. Vex Pro pinneó
  // 1087 "Savings" y 1705 "Egresos Vex" para el balance y "Datos del período"
  // se las llevó puestas: Retiros Totales $932.444,83 en vez de $469.650,98
  // (la Main 1079) y Net Deposit −$231.127 alimentando la distribución.
  const [pinned, setPinned] = useState<PinnedCoinsbuyWallet[]>([]);
  // ── Retiros de Coinsbuy POR WALLET OPERATIVA (Kevin, 2026-08-31: «en
  // retiros de coinsbuy deben sumar 2: la VexPro Main Wallet y la Vex
  // Instant, creale otra tarjeta y sube esa data»). El selector de wallet
  // filtra lo que viaja al navegador, así que con Main seleccionada los
  // retiros de la Instant NI EXISTEN en el payload — hace falta una carga
  // aparte con walletId=all. null = no cargó (se cae a la tarjeta agregada
  // del dataset filtrado, nunca a un $0 inventado).
  const [retirosPorWallet, setRetirosPorWallet] = useState<
    Array<{ walletId: string; label: string; total: number; count: number }> | null
  >(null);
  const pinnedIds = useMemo(() => pinned.map((p) => p.wallet_id), [pinned]);
  const operatingPins = useMemo(() => selectOperatingWallets(pinned), [pinned]);
  const [pinBusy, setPinBusy] = useState(false);
  const loadPinned = useCallback(async () => {
    if (!company?.id) return;
    setPinned(await fetchPinnedCoinsbuyWallets(company.id));
  }, [company?.id]);
  useEffect(() => {
    if (isAdmin) void loadPinned();
  }, [isAdmin, loadPinned]);

  const togglePin = async (id: string, label: string) => {
    if (!company?.id || !id || pinBusy) return;
    setPinBusy(true);
    try {
      if (pinnedIds.includes(id)) {
        await unpinCoinsbuyWallet(company.id, id);
      } else {
        // Default 'operating': fijar una wallet nueva sin decir nada la deja
        // contando como wallet de clientes, que es lo que el usuario espera
        // del botón "Fijar". Para tesorería interna se cambia el rol al lado.
        await pinCoinsbuyWallet(company.id, id, label, 'operating');
      }
      await loadPinned();
      onAfterLiveSync?.(); // re-scopea los totales al nuevo set pinneado
    } catch {
      // silencioso — la UI queda en el estado previo; el usuario puede reintentar
    } finally {
      setPinBusy(false);
    }
  };

  const changePinRole = async (id: string, role: PinnedWalletRole) => {
    if (!company?.id || !id || pinBusy) return;
    setPinBusy(true);
    try {
      await setPinnedWalletRole(company.id, id, role);
      await loadPinned();
      onAfterLiveSync?.(); // los totales cambian: re-leer
    } catch {
      // silencioso — igual que togglePin
    } finally {
      setPinBusy(false);
    }
  };

  // Load wallet options once on mount — only admins need the full list
  useEffect(() => {
    if (!isAdmin) return; // Non-admins use the default wallet, no need to fetch
    (async () => {
      try {
        const res = await apiFetch('/api/integrations/coinsbuy/wallets');
        const json = await res.json();
        if (json.success && Array.isArray(json.wallets)) {
          const options: WalletOption[] = json.wallets.map(
            (w: { id: string; label: string; currencyCode: string }) => ({
              id: w.id,
              label: w.label,
              currencyCode: w.currencyCode,
            }),
          );
          setWalletOptions(options);

          // Fallback: if the currently-resolved walletId is empty (no
          // tenant default, no controlled prop, no previous local pick),
          // seed it with the first API wallet so the rest of the page
          // has something to filter against.
          //
          // setWalletId() routes through onWalletChange when controlled,
          // so the parent's state stays in sync. When uncontrolled it
          // writes to walletIdLocal.
          const effective = walletIdProp ?? walletIdLocal;
          if (!effective && options.length > 0) {
            setWalletId(options[0].id);
          }
        }
      } catch {
        // Silent — wallets are optional filter
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  // Resolve the effective {from, to} from the filter state.
  const { from, to } = useMemo(() => {
    if (mode === 'month') return monthBounds(month);
    return { from: rangeFrom, to: rangeTo };
  }, [mode, month, rangeFrom, rangeTo]);

  // Two modes of loading:
  //   1. loadFromCache (default on mount + filter changes): reads the last
  //      persisted state from Supabase. NO external API calls.
  //   2. loadLive (triggered by the "Refrescar" button): hits the real
  //      providers, writes through to api_transactions, and shows fresh data.
  // This way opening the page is fast and free of API quotas, and the user
  // explicitly decides when to sync.
  const loadFromCache = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (walletId) qs.set('walletId', walletId);
      const res = await apiFetch(`/api/integrations/persisted-movements?${qs.toString()}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Error cargando datos persistidos');
      setDatasets(json.datasets ?? []);
      setFetchedAt(json.fetchedAt);
      setTruncatedSlugs(json.truncatedSlugs ?? []);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  }, [from, to, walletId]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const qs = new URLSearchParams();
        if (from) qs.set('from', from);
        if (to) qs.set('to', to);
        qs.set('walletId', 'all');
        const res = await apiFetch(`/api/integrations/persisted-movements?${qs.toString()}`);
        const json = await res.json();
        if (!json.success || cancel) return;
        const ds = (json.datasets ?? []).find(
          (d: { slug: string }) => d.slug === 'coinsbuy-withdrawals',
        );
        if (!ds) { if (!cancel) setRetirosPorWallet(null); return; }
        const porWallet = new Map<string, { label: string; total: number; count: number }>();
        for (const t of ds.transactions ?? []) {
          // Mismos criterios que el total del dataset: Approved, no excluida,
          // no interna (una interna mueve wallets pero no es un retiro).
          if (t.status !== 'Approved' || t.excluded === true || t.internal === true) continue;
          const wid = String(t.walletId ?? '');
          if (!wid) continue;
          const prev = porWallet.get(wid) ?? { label: String(t.walletLabel ?? `#${wid}`), total: 0, count: 0 };
          prev.total += Number(t.amount ?? t.netAmount ?? 0);
          prev.count += 1;
          porWallet.set(wid, prev);
        }
        const idsOperativas = operatingPins.length > 0
          ? new Set(operatingPins.map((w) => w.wallet_id))
          : null;
        const filas = [...porWallet.entries()]
          .filter(([wid]) => idsOperativas === null || idsOperativas.has(wid))
          .map(([walletId, v]) => ({ walletId, label: v.label, total: v.total, count: v.count }))
          .sort((a, b) => b.total - a.total);
        if (!cancel) setRetirosPorWallet(filas.length > 0 ? filas : null);
      } catch {
        if (!cancel) setRetirosPorWallet(null);
      }
    })();
    return () => { cancel = true; };
  }, [from, to, fetchedAt, operatingPins]);

  const loadLive = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (walletId) qs.set('walletId', walletId);
      const res = await apiFetch(`/api/integrations/movements?${qs.toString()}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Error desconocido');
      // Si un proveedor vino en ERROR desde la API en vivo (cuota agotada,
      // caída, timeout), NO pisamos su tarjeta con ceros: un $0.00 se lee como
      // "no hubo depósitos", que es peor que un dato viejo con aviso. Se
      // conserva el dataset que ya teníamos (de la caché persistida) marcado
      // como 'stale' y con el mensaje del error. Kevin (2026-08-17): "si falla
      // debería mostrar el último balance, es mejor". Los proveedores que sí
      // respondieron se actualizan normalmente.
      const live: ProviderDataset[] = json.datasets ?? [];
      setDatasets((prev) =>
        live.map((ds) => {
          if (ds.status !== 'error') return ds;
          const cached = prev.find((p) => p.slug === ds.slug);
          if (!cached || cached.status === 'error' || cached.transactions.length === 0) return ds;
          return { ...cached, status: 'stale' as const, errorMessage: ds.errorMessage };
        }),
      );
      setFetchedAt(json.fetchedAt);
      setTruncatedSlugs(json.truncatedSlugs ?? []);
      // Wait briefly for the server-side fire-and-forget persist to complete,
      // THEN tell the parent page to re-read from Supabase. Without this
      // delay the tables below could fetch persisted-movements before the
      // write-through finished, showing stale zeros.
      if (onAfterLiveSync) {
        setTimeout(onAfterLiveSync, 1500);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  }, [from, to, walletId, onAfterLiveSync]);

  // Load from cache on mount + whenever filters change. Never auto-fetch
  // from external APIs — that only happens when the user clicks Refrescar.
  useEffect(() => {
    loadFromCache();
  }, [loadFromCache]);

  // Query-string carried over into the breakdown page link so the breakdown
  // starts on the same range AND the same wallet filter the cards used.
  // Passing walletId here is the difference that closes the "tarjetas vs
  // desglose" discrepancy Kevin reported on 2026-05-01 — without this the
  // breakdown defaulted to all wallets.
  const linkQs = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (walletId) p.set('walletId', walletId);
    return p.toString();
  }, [from, to, walletId]);

  // ── Filas de la tabla compacta («Libro mayor», 2026-10-12) ───────────────
  // Antes: una tarjeta por proveedor, el importe pintado con el color de cada
  // proveedor (`PROVIDER_META.accent`: azul, rojo, verde, violeta, ámbar — cinco
  // colores que no significaban nada) y el estado como un ícono verde/ámbar/
  // rojo de 14 px. Ahora: una fila por proveedor con el estado en palabras
  // (`StatusBadge` vía `statusKind('fetch', …)`), la antigüedad del dato y el
  // monto con signo en tinta neutra. Un dataset en `error` sin caché no tiene
  // monto: «—», no $0.00 (el $0 se leía como «no hubo depósitos»).
  const statusLabel = (s: ProviderDataset['status']) =>
    s === 'fresh' ? t('movements.rt.status.fresh') : s === 'stale' ? t('movements.rt.status.stale') : t('movements.rt.status.error');
  const syncedAt = (iso: string | null | undefined) => {
    // `fetchedAt` = epoch 0 cuando nunca sincronizó (persisted-movements).
    if (!iso || Date.parse(iso) <= 0) return null;
    const age = relativeAge(iso, now);
    return age ? t(age.key, { n: String(age.n) }) : null;
  };
  const rows: ProviderRow[] = datasets.flatMap((ds): ProviderRow[] => {
    const meta = PROVIDER_META[ds.slug];
    const totals = computeProviderTotals(ds);
    const sign = meta.direction === 'out' ? -1 : 1;
    const known = ds.status !== 'error' || totals.count > 0;
    const base = {
      status: ds.status,
      synced: syncedAt(ds.fetchedAt),
      error: ds.errorMessage ?? null,
    };
    // Retiros de Coinsbuy: una fila POR WALLET OPERATIVA cuando la carga sin
    // filtro respondió; si no, la agregada de siempre (que sigue el selector).
    // Nunca un $0 inventado por fallo de red.
    if (ds.slug === 'coinsbuy-withdrawals' && retirosPorWallet !== null) {
      return retirosPorWallet.map((w) => ({
        ...base,
        key: `cbw-${w.walletId}`,
        group: 'cbWallets' as const,
        label: w.label,
        href: `/movimientos/desglose/coinsbuy-withdrawals${linkQs ? `?${linkQs}&` : '?'}walletId=${w.walletId}`,
        meta: t('movements.rt.txMeta', { n: String(w.count), status: 'Approved' }),
        amount: -w.total,
      }));
    }
    const out: ProviderRow[] = [
      {
        ...base,
        key: ds.slug,
        group: meta.direction === 'out' ? 'out' : 'in',
        label: meta.cardLabel,
        href: `/movimientos/desglose/${ds.slug}${linkQs ? `?${linkQs}` : ''}`,
        meta:
          t('movements.rt.txMeta', { n: String(totals.count), status: totals.acceptedStatus }) +
          (ds.isMock ? ' · mock' : ''),
        amount: known ? sign * totals.total : null,
      },
    ];
    // Kevin (2026-08-31): «pon aquí también una tarjeta con la info de los
    // retiros de paypros». Pay-Pros es UN provider con dos sentidos separados
    // por status; la fila de retiros sale del mismo dataset vía
    // countPayprosPayouts (los payout_paid que computeProviderTotals excluye a
    // propósito del lado de depósitos).
    if (ds.slug === 'paypros') {
      const payouts = countPayprosPayouts(ds);
      out.push({
        ...base,
        key: 'paypros-payouts',
        group: 'out',
        label: t('movements.rt.payprosPayouts'),
        href: `/movimientos/desglose/paypros${linkQs ? `?${linkQs}` : ''}`,
        meta: t('movements.rt.txMeta', { n: String(payouts.count), status: 'payout_paid' }),
        amount: known ? -payouts.total : null,
      });
    }
    return out;
  });
  // Orden de lectura: depósitos, retiros de Coinsbuy por wallet, otros retiros.
  const GROUP_ORDER: ProviderRow['group'][] = ['in', 'cbWallets', 'out'];
  rows.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));

  const columns: FinColumn<ProviderRow>[] = [
    {
      key: 'provider',
      header: t('movements.rt.col.provider'),
      cell: (r) => (
        <Link href={r.href} className="font-medium text-foreground hover:underline" title={r.label}>
          {r.label}
        </Link>
      ),
      meta: (r) => (r.status === 'error' && r.error ? r.error : r.meta),
      mobileMeta: (r) => (
        <>
          <StatusBadge domain="fetch" status={r.status} label={statusLabel(r.status)} title={r.error ?? undefined} />
          {r.synced && <span suppressHydrationWarning>{r.synced}</span>}
        </>
      ),
    },
    {
      key: 'status',
      header: t('movements.rt.col.status'),
      cell: (r) => (
        <StatusBadge
          domain="fetch"
          status={r.status}
          label={statusLabel(r.status)}
          // Ámbar/violeta = dato de la última sincronización buena: la API en
          // vivo falló pero el número NO es cero ni inventado.
          title={
            r.status === 'stale'
              ? r.error
                ? t('movements.rt.staleTitleError', { error: r.error })
                : t('movements.rt.staleTitle')
              : (r.error ?? undefined)
          }
        />
      ),
      hideSm: true,
    },
    {
      key: 'synced',
      header: t('movements.rt.col.synced'),
      cell: (r) => (
        <span className="text-text-2" suppressHydrationWarning>
          {r.synced ?? '—'}
        </span>
      ),
      hideSm: true,
    },
    {
      key: 'amount',
      header: t('movements.rt.col.total'),
      kind: 'money',
      value: (r) => r.amount,
      money: { signed: true, tone: 'neutral' },
    },
  ];

  const pickerLabel = 'inline-flex items-center gap-1.5 text-[12.5px] font-medium text-text-2';
  const selectedWallet = walletOptions.find((w) => w.id === walletId);
  const selectedPin = pinned.find((p) => p.wallet_id === walletId);
  const operatingNames = operatingPins.map((p) => p.wallet_label || `#${p.wallet_id}`).join(', ');
  const internalNames = pinned
    .filter((p) => p.role === 'internal')
    .map((p) => p.wallet_label || `#${p.wallet_id}`)
    .join(', ');
  const lastSync = fetchedAt ? syncedAt(fetchedAt) : null;

  return (
    <Panel
      title={t('movements.rt.title')}
      hint={
        <span suppressHydrationWarning>
          {lastSync ? t('movements.rt.updated', { ago: lastSync }) : t('movements.rt.neverSynced')}
        </span>
      }
      flush
      actions={
        // El ÚNICO botón primario de /movimientos (spec §5.1).
        <button
          type="button"
          onClick={loadLive}
          disabled={loading}
          title={t('movements.rt.syncTitle')}
          className="inline-flex h-8 items-center gap-1.5 rounded-ui-md border border-primary bg-primary px-3 text-[13px] font-medium text-brand-on-primary hover:bg-[color-mix(in_srgb,var(--color-primary)_86%,#000)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw aria-hidden className={cn('size-[15px]', loading && 'animate-spin')} strokeWidth={1.75} />
          {loading ? t('movements.rt.syncing') : t('movements.rt.sync')}
        </button>
      }
    >
      {/* Filtro propio del banner: mes o rango, y wallet de Coinsbuy. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Calendar aria-hidden className="size-4 text-text-3" />
          <Segmented<FilterMode>
            aria-label={t('movements.rt.modeAria')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'month', label: t('movements.rt.month') },
              { value: 'range', label: t('movements.rt.range') },
            ]}
          />
        </div>

        {mode === 'month' ? (
          <label className={pickerLabel}>
            {t('movements.rt.month')}
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-auto"
              aria-label={t('movements.rt.monthAria')}
            />
          </label>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <label className={pickerLabel}>
              {t('movements.rt.from')}
              <Input
                type="date"
                value={rangeFrom}
                onChange={(e) => setRangeFrom(e.target.value)}
                className="w-auto"
              />
            </label>
            <label className={pickerLabel}>
              {t('movements.rt.to')}
              <Input
                type="date"
                value={rangeTo}
                onChange={(e) => setRangeTo(e.target.value)}
                className="w-auto"
              />
            </label>
          </div>
        )}

        {/* Wallet (Coinsbuy) — sólo admins la cambian. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={pickerLabel}>
            <Wallet aria-hidden className="size-4 text-text-3" />
            {t('movements.rt.wallet')}
          </span>
          {isAdmin && walletOptions.length > 0 ? (
            <Select
              value={walletId}
              onChange={(e) => setWalletId(e.target.value)}
              className="w-auto max-w-[240px]"
              aria-label={t('movements.rt.walletAria')}
            >
              <option value="">{t('movements.rt.allWallets')}</option>
              {walletOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label} ({w.currencyCode})
                </option>
              ))}
            </Select>
          ) : !isAdmin ? (
            <span className="text-[13px] text-foreground">{t('movements.rt.mainWallet')}</span>
          ) : null}
          {isAdmin && walletId && walletOptions.length > 0 && (
            // Fijar/quitar la wallet seleccionada + su ROL. Los pins son
            // company-wide → afectan también a /balances y /resumen-general.
            <>
              <button
                type="button"
                onClick={() => togglePin(walletId, selectedWallet?.label ?? '')}
                disabled={pinBusy}
                aria-pressed={Boolean(selectedPin)}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-ui-md border px-2.5 text-[13px] font-medium disabled:opacity-50',
                  selectedPin
                    ? 'border-brand-ink bg-brand-tint text-brand-ink'
                    : 'border-border-strong bg-card text-text-2 hover:bg-surface-hover hover:text-foreground',
                )}
                title={selectedPin ? t('movements.rt.unpinTitle') : t('movements.rt.pinTitle')}
              >
                {selectedPin ? (
                  <PinOff aria-hidden className="size-[15px]" strokeWidth={1.75} />
                ) : (
                  <Pin aria-hidden className="size-[15px]" strokeWidth={1.75} />
                )}
                {selectedPin ? t('movements.rt.pinned') : t('movements.rt.pin')}
              </button>
              {selectedPin && (
                <Select
                  value={selectedPin.role}
                  onChange={(e) => changePinRole(walletId, e.target.value as PinnedWalletRole)}
                  disabled={pinBusy}
                  className="w-auto"
                  aria-label={t('movements.rt.roleAria')}
                  title={t('movements.rt.roleTitle')}
                >
                  <option value="operating">{t('movements.rt.roleOperating')}</option>
                  <option value="internal">{t('movements.rt.roleInternal')}</option>
                </Select>
              )}
            </>
          )}
        </div>
      </div>

      {/* Qué wallets cuentan y para qué. Sin esto, «Datos del período» (arriba)
          y esta tabla muestran números distintos sin explicar por qué: el
          selector de wallet filtra SOLO esta tabla, mientras que los totales
          del período siempre cuentan las operativas. */}
      {isAdmin && pinned.length > 0 && (
        <p className="border-b border-border px-4 py-2.5 text-[12px] leading-5 text-text-3">
          {t(
            operatingPins.length === 1 ? 'movements.periodDataScopeOne' : 'movements.periodDataScopeMany',
            { count: String(operatingPins.length), wallets: operatingNames || '—' },
          )}{' '}
          {pinned.length > operatingPins.length &&
            `${t('movements.periodDataScopeInternal', { internal: internalNames })} `}
          {t('movements.periodDataScopeHint')}
        </p>
      )}

      {(errorMsg || truncatedSlugs.length > 0) && (
        <div className="space-y-2 border-b border-border px-4 py-3">
          {errorMsg && (
            <Notice
              kind="bad"
              title={t('movements.rt.errorTitle')}
              action={
                <button
                  type="button"
                  onClick={loadFromCache}
                  className="inline-flex h-8 items-center rounded-ui-md border border-border-strong bg-card px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover"
                >
                  {t('movements.notice.retry')}
                </button>
              }
            >
              {errorMsg}
            </Notice>
          )}
          {/* Un recorte silencioso es indistinguible de «no hay más». Si el
              endpoint tocó su techo de páginas, la fila de ese proveedor
              muestra MENOS de lo que hay y hay que decirlo antes de que alguien
              lo sume. */}
          {truncatedSlugs.length > 0 && (
            <Notice
              kind="pend"
              title={t('movements.notice.truncatedTitle', {
                channels: truncatedSlugs.map((s) => PROVIDER_META[s]?.provider ?? s).join(', '),
              })}
            >
              {t('movements.notice.truncatedBody')}
            </Notice>
          )}
        </div>
      )}

      <FinTable
        caption={t('movements.rt.title')}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        groupBy={(r) => r.group}
        groupLabel={(g) =>
          g === 'in'
            ? t('movements.depositsTab')
            : g === 'cbWallets'
              ? t('movements.rt.cbWallets')
              : t('movements.withdrawalsTab')
        }
        empty={errorMsg ? t('movements.rt.empty') : t('movements.rt.loading')}
      />
    </Panel>
  );
}

/** Una fila de la tabla compacta del banner. */
interface ProviderRow {
  key: string;
  group: 'in' | 'out' | 'cbWallets';
  label: string;
  href: string;
  meta: string;
  status: ProviderDataset['status'];
  synced: string | null;
  error: string | null;
  /** Con signo: depósitos +, retiros −. null = sin dato (error sin caché). */
  amount: number | null;
}

// Exported so the main Movimientos page can read API totals for the
// "Depósitos Totales" / "Retiros Totales" lines in the period tables.
// Reads from the persisted cache — never triggers a live API call on its
// own. The banner's "Refrescar" button is what syncs new data in.
// `walletId` MUST be passed so the totals stay consistent with what the
// banner displays.
export function useApiTotals(
  from: string,
  to: string,
  walletId: string = DEFAULT_WALLET_ID,
  /** Bump this number to force a re-read of the persisted cache (after the
   *  banner finishes a live sync and writes through to Supabase). */
  refreshKey: number = 0,
) {
  const [datasets, setDatasets] = useState<ProviderDataset[]>([]);
  // Canales apagados para esta empresa (channel_configs.is_visible = false).
  // Viajan explícitos desde el endpoint: deducirlos de "qué dataset falta"
  // escondería canales reales en los períodos históricos, que no consultan la
  // API. Ver la cabecera de /api/integrations/persisted-movements.
  const [hiddenChannels, setHiddenChannels] = useState<string[]>([]);
  // ── Estado de la lectura (2026-10-12, «Libro mayor») ───────────────────
  // Hasta hoy un fallo de esta lectura era `catch {}` silencioso: los
  // datasets quedaban vacíos, los depósitos por canal daban `?? 0` y la
  // pantalla mostraba $0.00 por canal con cara de dato. Ahora el estado viaja
  // ('loading' | 'ok' | 'failed') junto con `truncatedSlugs`, que el endpoint
  // ya devolvía y este hook tiraba. Una exclusión silenciosa es
  // indistinguible de un cruce roto (reglas §1.2).
  const [fetchState, setFetchState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [truncatedSlugs, setTruncatedSlugs] = useState<ProviderSlug[]>([]);

  // Debounce rapid wallet-selector clicks (350 ms) and support AbortController
  // so a newer request supersedes an older one mid-flight — fixes N-fetches-
  // per-click when the user scrolls through wallets quickly.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      (async () => {
        try {
          const qs = new URLSearchParams();
          if (from) qs.set('from', from);
          if (to) qs.set('to', to);
          if (walletId) qs.set('walletId', walletId);
          // apiFetch = withActiveCompany + manejo de errores. Este era el
          // ÚNICO fetch del banner sin scope de tenant (auditoría
          // 2026-07-15) — useApiTotals alimentaba los cards de Movimientos
          // con la empresa equivocada en viewing-as.
          const res = await apiFetch(
            `/api/integrations/persisted-movements?${qs.toString()}`,
            { signal: controller.signal },
          );
          const json = await res.json();
          if (cancelled) return;
          if (json.success) {
            setDatasets(json.datasets ?? []);
            setHiddenChannels(json.hiddenChannels ?? []);
            setTruncatedSlugs(json.truncatedSlugs ?? []);
            setFetchState('ok');
          } else {
            setFetchState('failed');
          }
        } catch {
          // Un abort (lo reemplazó una lectura más nueva) no es un fallo.
          if (!cancelled) setFetchState('failed');
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [from, to, walletId, refreshKey]);

  return useMemo(() => {
    const by: Record<ProviderSlug, number> = {
      'coinsbuy-deposits': 0,
      'coinsbuy-withdrawals': 0,
      fairpay: 0,
      unipayment: 0,
      // Pay-Pros llega por /persisted-movements (espejo), no por la llamada en
      // vivo: no tiene endpoint de listado. Ver aggregator.fetchProviderBySlug.
      paypros: 0,
    };
    // Cantidad de operaciones que cuentan, por slug (mismo filtro que `by`).
    const countBy: Record<ProviderSlug, number> = { ...by };
    for (const ds of datasets) {
      const totals = computeProviderTotals(ds);
      by[ds.slug] = totals.total;
      countBy[ds.slug] = totals.count;
    }
    const depositsTotal =
      by['coinsbuy-deposits'] + by.fairpay + by.unipayment + by.paypros;

    // ── Retiros por canal, desde el registro único ────────────────────────
    // Hasta el 2026-08-31 acá decía `by['coinsbuy-withdrawals']` a secas,
    // mientras `loadPersistedTotals` (el MISMO número, del lado del servidor)
    // ya sumaba los payouts de Pay-Pros. Dos verdades para Retiros Totales, y
    // la que faltaba era la de la pantalla. No se veía porque no había ninguna
    // fila 'payout_paid'; el día que entrara la primera, /movimientos habría
    // mostrado un Net Deposit inflado sin que fallara nada. Ver
    // src/lib/withdrawal-channels.ts.
    //
    // `null` cuando el dataset del proveedor todavía no llegó: es "no lo
    // sabemos", no "no hubo retiros". `sumApiWithdrawals` lo excluye del total
    // y lo devuelve en `channelsWithoutData` para que la exclusión se pueda
    // mostrar en vez de tragarse.
    // La cuenta por canal vive en el registro (`apiWithdrawalsFromDatasets`):
    // el informe de cierre de /socios necesita exactamente la misma.
    const withdrawalsByChannel: WithdrawalsByChannel = apiWithdrawalsFromDatasets(datasets);
    const { total: withdrawalsTotal, channelsWithoutData: withdrawalChannelsWithoutData } =
      sumApiWithdrawals(withdrawalsByChannel);
    const paypros = datasets.find((d) => d.slug === 'paypros');
    const payoutCount = paypros ? countPayprosPayouts(paypros).count : 0;

    return {
      by,
      /** Operaciones que cuentan por slug (0 si el dataset no llegó: mirar `loadedSlugs`). */
      countBy,
      /** Retiros de Pay-Pros (payout_paid) que cuentan. */
      payoutCount,
      depositsTotal,
      withdrawalsTotal,
      withdrawalsByChannel,
      withdrawalChannelsWithoutData,
      /** Canales apagados para la empresa: la tabla no dibuja su fila. */
      hiddenChannels,
      /** Slugs cuyo dataset LLEGÓ. Un slug ausente es «sin dato», no $0. */
      loadedSlugs: datasets.map((d) => d.slug),
      /** Estado de la última lectura de /persisted-movements. */
      fetchState,
      /** Proveedores cuyo dataset vino recortado por el techo de páginas. */
      truncatedSlugs,
      /** Transacciones pendientes (en juego). null = no hay datasets. */
      pending: pendingFromDatasets(datasets),
    };
  }, [datasets, hiddenChannels, fetchState, truncatedSlugs]);
}
