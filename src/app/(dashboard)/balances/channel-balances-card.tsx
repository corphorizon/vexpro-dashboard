'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChannelBalancesCard — "Balances por Canal": cuánto hay, dónde está y de quién
// es. Desde 2026-10-12 en el sistema «Libro mayor» (docs/diseno-libro-mayor.md):
// franja de KPIs → banners de estado del dato → barra de distribución → tabla
// «Saldo por canal» → detalle por canal.
//
// Antes eran dos tarjetas que mostraban los mismos saldos con distinta cara
// ("Balances por Canal" y "Dónde está el dinero"): el mismo número en dos
// lugares invita a que uno de los dos quede desactualizado.
//
// DEUDA (2026-10-05): un lugar `debt` es un préstamo RECIBIDO. Su saldo se
// muestra con signo − en la tabla, suma al KPI «Deuda con terceros» y resta del
// Total, que pasa a llamarse «Total neto» mientras haya deuda. Los números
// salen de `summarize` — esta tarjeta no decide ningún signo.
//
// REDISEÑO (2026-10-12) — por qué cada pieza:
//   · Cinco tarjetas de KPI con borde y fondo de color (verde Disponible,
//     naranja Prestado, rojo Deuda) → UNA `KpiStrip`. El verde decía «positivo»
//     de un saldo que siempre es positivo: color sin significado (spec §2.1).
//     Total neto es el hero porque es la respuesta del módulo.
//   · El badge «viejo»/«dato degradado» iba por fila, pero nadie sumaba cuánta
//     plata vieja entraba al total. Ahora hay un banner `stale` con nombres y
//     monto, y otro `pend` para los canales SIN DATO, que antes se pintaban
//     «$0.00» igual que una wallet vacía (reglas §1.3) — ahora «—».
//   · Los canales ocultos desde «Configurar» salían del total sin decirlo. El
//     pie dice «N canales sumados, M excluidos» y los nombra (reglas §1.2).
//   · «Por unidad de negocio» (lista de tarjetas) + «Por tipo» (7 tarjetitas)
//     eran dos vistas del mismo dato en dos formatos → UNA tabla con
//     segmentado «Por tipo / Por unidad»; los subtotales salen de la fila de
//     grupo (antes la suma por tipo y la por unidad eran dos bloques más).
//   · Sub-filas (wallets fijadas de Coinsbuy, desglose on-chain por moneda)
//     no caben en una fila de tabla: van al panel «Detalle por canal», con los
//     mismos datos.
//   · La clasificación de una ubicación se editaba desplegando un formulario
//     dentro de la fila; ahora se despliega debajo de la tabla (mismos campos,
//     mismo guardado).
//
// La clasificación de filas (grupo, fuente, frescura, % del líquido, conteo)
// es pura y está testeada: balances-view.ts.
//
// DESCARTADO:
//   · Calcular el total del pie sumando las filas: el total es `summary.total`
//     (tallyCash), la misma fórmula del PDF y de /api/balances/total-consolidado.
//   · Mostrar los ocultos en la tabla, atenuados: parecerían sumar. Se nombran
//     en el pie y se muestran desde «Configurar».
//
// No inventa saldos: usa el `getValue` de la pantalla, así que la fecha elegida
// arriba manda sobre todo lo que se ve acá.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Archive, ArrowRightLeft, BookOpen, Building2, Check, Settings2, Trash2, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { formatMoney, MONEY_LOCALE } from '@/lib/money';
import { hasLedger, isAutoLedger } from '@/lib/channel-ledger';
import { balanceAgeInDays } from '@/lib/channel-balance-source';
import type { ChannelConfigRow, ResolvedChannel } from '@/lib/channel-configs';
import {
  DEFAULT_LOCATION_TYPE,
  LOCATION_TYPES,
  LOCATION_TYPE_LABELS,
  groupByUnit,
  isAutomatic,
  isDebt,
  isOnchain,
  normalizeLocationType,
  parseOnchainWallets,
  primaryUnitId,
  requiresHolder,
  summarize,
  type BusinessUnit,
  type CashLocation,
  type LocationType,
  type OnchainWallet,
  type UnitShare,
} from '@/lib/cash-locations';
import type { OnchainSnapshotMeta } from '@/lib/types';
import { InfoTip } from '@/components/ui/info-tip';
import { GLOSSARY } from '@/lib/glossary';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { DistributionBar } from '@/components/ui/distribution-bar';
import { Segmented } from '@/components/ui/segmented';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { NUM_CLASS } from '@/components/ui/money';
import { Field, Input, Select } from '@/components/ui/field';
import { relativeAge } from '@/components/ui/relative-age';
import { cn } from '@/lib/utils';
import { BusinessUnitsModal } from './business-units-modal';
import { UnitSharesEditor } from './unit-shares-editor';
import { OnchainWalletsEditor } from './onchain-wallets-editor';
import { OnchainBreakdown } from './onchain-breakdown';
import {
  buildChannelRow,
  countChannels,
  distributionInputs,
  freshnessSummary,
  liquidSharePct,
  sortByGroup,
  type BalanceMeta,
  type ChannelGroupKey,
  type ChannelRow,
  type ChannelSourceKind,
} from './balances-view';

interface Props {
  /** Canales visibles ya resueltos por la pantalla (built-ins + custom). */
  channels: ResolvedChannel[];
  /** Nombres de los canales ocultos desde «Configurar»: no suman, y el pie lo dice. */
  hiddenChannels: string[];
  /** Filas crudas de channel_configs — de acá salen tipo, unidad y holder. */
  configRows: ChannelConfigRow[];
  /** Saldo de cada canal a la fecha elegida, tal como lo calcula la pantalla. */
  getValue: (channelKey: string) => number;
  /** Recarga la config de canales en el padre tras guardar. */
  onChanged: () => void;
  canManage: boolean;
  selectedDate: string;
  /** Sub-filas propias de un canal (wallets fijadas de Coinsbuy) → panel «Detalle». */
  extraRows?: (channelKey: string) => ReactNode;
  /** Acciones propias de un canal (elegir wallets de Coinsbuy). */
  extraActions?: (channelKey: string) => ReactNode;
  /**
   * Desglose que dejó el cron en el snapshot de la fecha elegida (migración
   * 085). De acá sale el "cuánto hay en cada moneda" de una wallet on-chain,
   * sin volver a consultar la blockchain al abrir la pantalla.
   */
  getSnapshotMeta?: (channelKey: string) => OnchainSnapshotMeta | null;
  /**
   * De cuándo es el saldo de cada ubicación y si hay que desconfiar de él
   * (auditoría de finanzas, ítems 13 y 23). Lo calcula la pantalla, que es
   * quien tiene las fuentes; acá sólo se muestra.
   */
  getBalanceMeta?: (channelKey: string) => BalanceMeta;
}

interface Draft {
  location_type: LocationType;
  holder: string;
  shares: UnitShare[];
  onchain: OnchainWallet[];
}

type View = 'type' | 'unit';

/** Grupo «sin unidad» de la vista por unidad (FinTable agrupa por string). */
const NO_UNIT = '__none__';

const GROUP_LABEL_KEY: Record<ChannelGroupKey, string> = {
  gateway: 'balances.groupGateway',
  wallet: 'balances.groupWallet',
  bank: 'balances.groupBank',
  lent: 'balances.groupLent',
  debt: 'balances.groupDebt',
};

const SOURCE_LABEL_KEY: Record<ChannelSourceKind, string> = {
  api: 'balances.srcApi',
  onchain: 'balances.srcOnchain',
  manual: 'balances.srcManual',
  computed: 'balances.srcComputed',
};

/** Botón-ícono de acción de fila (spec §5.1): 32×32, 40 en táctil. */
const ROW_BTN =
  'inline-flex size-8 items-center justify-center rounded-ui-md text-text-2 hover:bg-surface-hover hover:text-foreground disabled:opacity-40 [@media(pointer:coarse)]:size-10';
/** Botón secundario (spec §5.1). */
const BTN =
  'inline-flex h-8 items-center gap-1.5 rounded-ui-md border border-border-strong bg-card px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover disabled:opacity-50 [@media(pointer:coarse)]:h-10';

export function ChannelBalancesCard({
  channels,
  hiddenChannels,
  configRows,
  getValue,
  onChanged,
  canManage,
  selectedDate,
  extraRows,
  extraActions,
  getSnapshotMeta,
  getBalanceMeta,
}: Props) {
  const { t, locale } = useI18n();
  const lang = locale === 'en' ? 'en' : 'es';

  const [units, setUnits] = useState<BusinessUnit[]>([]);
  const [showUnits, setShowUnits] = useState(false);
  const [view, setView] = useState<View>('type');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  // «Ahora» se toma una vez al montar (como KpiStrip): «hace X» no cambia de
  // render en render ni difiere entre server y cliente.
  const [now] = useState(() => Date.now());

  const loadUnits = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/business-units');
      const json = (await res.json()) as { success: boolean; units?: BusinessUnit[] };
      if (json.success) setUnits(json.units ?? []);
    } catch {
      // Sin unidades el desglose sigue funcionando: todo cae en "sin asignar".
    }
  }, []);

  useEffect(() => {
    loadUnits();
  }, [loadUnits]);

  // El reparto viene con `configRows`: desde que
  // `GET /api/admin/channel-configs` lo devuelve, el fetch aparte a
  // /api/admin/location-units era un segundo request pidiendo lo mismo y una
  // segunda copia del dato que se podía desincronizar de la primera. Tras
  // guardar, `onChanged()` recarga la configuración y con ella el reparto.
  const sharesByKey = useMemo(() => {
    const map = new Map<string, UnitShare[]>();
    for (const row of configRows) {
      const shares = (row.unit_shares ?? [])
        .filter((s) => s?.business_unit_id)
        .map((s) => ({ business_unit_id: s.business_unit_id, share: Number(s.share) || 0 }));
      if (shares.length > 0) map.set(row.channel_key, shares);
    }
    return map;
  }, [configRows]);

  const locations: CashLocation[] = useMemo(() => {
    const rowByKey = new Map(configRows.map((r) => [r.channel_key, r]));
    return channels.map((ch) => {
      const row = rowByKey.get(ch.key);
      return {
        channel_key: ch.key,
        label: ch.label,
        // Sin fila guardada, una pasarela con API es 'gateway' y el resto cae
        // al default del catálogo — nunca se inventa una lista nueva de keys.
        location_type: row?.location_type
          ? normalizeLocationType(row.location_type)
          : isAutoLedger(ch.key)
            ? 'gateway'
            : DEFAULT_LOCATION_TYPE,
        business_unit_id: row?.business_unit_id ?? null,
        unit_shares: sharesByKey.get(ch.key) ?? null,
        holder: row?.holder ?? null,
        is_visible: ch.isVisible,
        is_custom: ch.isCustom,
        sort_order: ch.sortOrder,
        onchain_wallets: parseOnchainWallets(row?.onchain_wallets),
        balance: getValue(ch.key),
      };
    });
  }, [channels, configRows, getValue, sharesByKey]);

  const locByKey = useMemo(() => new Map(locations.map((l) => [l.channel_key, l])), [locations]);
  const summary = useMemo(() => summarize(locations, units), [locations, units]);
  // Declarado justo después de `summary` y antes de cualquier uso en el JSX.
  const hasDebt = summary.owed !== 0;
  const byUnit = useMemo(() => groupByUnit(locations, units), [locations, units]);
  const unitById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);

  // Una fila por canal (vista por tipo): de acá salen los banners, la barra,
  // el conteo del pie y el detalle. La vista por unidad reparte las MISMAS
  // ubicaciones entre sus unidades dueñas.
  const typeRows: ChannelRow[] = useMemo(
    () => sortByGroup(locations.map((loc) => buildChannelRow(loc, getBalanceMeta?.(loc.channel_key)))),
    [locations, getBalanceMeta],
  );
  const unitRows: ChannelRow[] = useMemo(
    () =>
      byUnit.flatMap((g) =>
        g.locations.map((loc) => buildChannelRow(loc, getBalanceMeta?.(loc.channel_key), g.unit?.id ?? NO_UNIT)),
      ),
    [byUnit, getBalanceMeta],
  );
  const rows = view === 'unit' ? unitRows : typeRows;
  const count = useMemo(() => countChannels(typeRows, hiddenChannels.length), [typeRows, hiddenChannels.length]);
  const fresh = useMemo(() => freshnessSummary(typeRows), [typeRows]);
  const distItems = useMemo(() => distributionInputs(typeRows), [typeRows]);

  // Una ubicación compartida aparece en cada unidad dueña, pero editarla,
  // archivarla o borrarla afecta a todas por igual: los botones van una sola
  // vez, en el primer grupo donde asoma.
  const primaryGroupOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of byUnit) {
      for (const loc of group.locations) {
        if (!map.has(loc.channel_key)) map.set(loc.channel_key, group.unit?.id ?? NO_UNIT);
      }
    }
    return map;
  }, [byUnit]);

  /**
   * Archivar = ocultar. Las pasarelas y los canales base NO se borran: su
   * libro y su histórico siguen existiendo y borrarlos dejaría asientos
   * huérfanos. Solo las ubicaciones propias (is_custom) se pueden eliminar,
   * y únicamente si su saldo es cero — si no, se estaría escondiendo plata.
   */
  const setArchived = async (loc: CashLocation, archived: boolean) => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await apiFetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          channel_key: loc.channel_key,
          is_visible: !archived,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('cash.saveError'));
      setStatus({ kind: 'ok', msg: archived ? t('cash.archived') : t('cash.unarchived') });
      onChanged();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : t('cash.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const removeLocation = async (loc: CashLocation) => {
    if (Math.abs(loc.balance) > 0.009) {
      setStatus({ kind: 'err', msg: t('cash.deleteNeedsZero') });
      return;
    }
    if (!window.confirm(t('cash.deleteLocationConfirm', { name: loc.label }))) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await apiFetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // El endpoint espera `channel_key`: mandar `key` borraba nada y la
        // pantalla igual decía "eliminada".
        body: JSON.stringify({ action: 'delete', channel_key: loc.channel_key }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('cash.saveError'));
      setStatus({ kind: 'ok', msg: t('cash.deleted') });
      onChanged();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : t('cash.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (loc: CashLocation) => {
    setStatus(null);
    setEditingKey(loc.channel_key);
    setDraft({
      location_type: loc.location_type,
      holder: loc.holder ?? '',
      shares:
        loc.unit_shares && loc.unit_shares.length > 0
          ? loc.unit_shares.map((s) => ({ ...s }))
          : loc.business_unit_id
            ? [{ business_unit_id: loc.business_unit_id, share: 1 }]
            : [],
      onchain: parseOnchainWallets(loc.onchain_wallets).map((w) => ({ ...w })),
    });
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setDraft(null);
  };

  const saveEdit = async (loc: CashLocation) => {
    if (!draft) return;
    // El servidor lo valida igual; acá es para no hacer el viaje.
    if (requiresHolder(draft.location_type) && !draft.holder.trim()) {
      setStatus({ kind: 'err', msg: t('balances.cfgDebtNeedsHolder') });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const res = await apiFetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          channel_key: loc.channel_key,
          // El upsert no puede omitir is_visible: su default es `true` y
          // omitirlo re-mostraría una ubicación que el admin había ocultado.
          is_visible: loc.is_visible,
          location_type: draft.location_type,
          // La unidad principal sigue viviendo en channel_configs para las
          // pantallas que la leen sin saber del reparto. Es la de MAYOR parte,
          // no la primera del array: con un reparto 30/70, guardar la primera
          // cargada dejaba la ubicación registrada bajo la unidad del 30%.
          business_unit_id: primaryUnitId(draft.shares),
          holder: draft.holder,
          // Se manda SIEMPRE (aunque venga vacío) porque este formulario es el
          // único lugar donde se desconecta una wallet de la cadena: omitirlo
          // dejaría las direcciones puestas para siempre. Las filas a medio
          // cargar se descartan acá; el servidor revalida y rechaza el resto.
          onchain_wallets: draft.onchain.filter((w) => w.address.trim()),
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('cash.saveError'));

      const sharesRes = await apiFetch('/api/admin/location-units', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_key: loc.channel_key, units: draft.shares }),
      });
      const sharesJson = (await sharesRes.json()) as { success: boolean; error?: string };
      if (!sharesJson.success) throw new Error(sharesJson.error ?? t('cash.saveError'));

      cancelEdit();
      setStatus({ kind: 'ok', msg: t('cash.saved') });
      // Recarga la configuración, que ahora trae también el reparto.
      onChanged();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : t('cash.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const typeLabel = (type: LocationType) => LOCATION_TYPE_LABELS[type][lang];
  const plural = (n: number, one: string, many: string) =>
    n === 1 ? t(one) : t(many, { n: String(n) });
  const pctFmt = new Intl.NumberFormat(MONEY_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  /** «hace 3 min» para un instante, «actualizado hace N días» para una fecha de libro. */
  const ageText = (asOf: string | null): string | null => {
    if (!asOf) return null;
    if (asOf.length > 10) {
      const age = relativeAge(asOf, now);
      return age ? t(age.key, { n: String(age.n) }) : null;
    }
    const days = balanceAgeInDays(asOf, selectedDate);
    if (days === null) return null;
    return days === 0 ? t('balances.updatedToday') : t('balances.updatedDaysAgo', { days: String(days) });
  };

  const sourceChip = (r: ChannelRow) => {
    const loc = locByKey.get(r.channelKey);
    const addresses =
      r.source === 'onchain' && loc
        ? parseOnchainWallets(loc.onchain_wallets)
            .map((w) => `${w.network}: ${w.address}`)
            .join('\n')
        : undefined;
    return (
      <span
        className={cn(
          'inline-flex h-[18px] items-center rounded-ui-sm border px-1.5 text-[10.5px] font-semibold uppercase leading-none tracking-[.03em]',
          r.source === 'api' ? 'border-info/40 text-info' : 'border-border-strong text-text-2',
        )}
        title={r.source === 'computed' ? t('balances.srcComputedHint') : addresses}
      >
        {t(SOURCE_LABEL_KEY[r.source])}
      </span>
    );
  };

  const freshnessCell = (r: ChannelRow) => {
    const age = ageText(r.asOf);
    switch (r.freshness) {
      case 'live':
        return <StatusBadge kind="ok" label={t('balances.live')} title={age ?? undefined} />;
      case 'stale':
        return <StatusBadge kind="stale" label={age ?? t('balances.staleBadge')} title={t('balances.staleHint')} />;
      case 'degraded':
        return <StatusBadge kind="stale" label={t('balances.degradedBadge')} title={age ?? undefined} />;
      case 'missing':
        return <StatusBadge kind="pend" label={t('balances.noDataBadge')} />;
      default:
        return (
          <span className="text-[12.5px] text-text-2">
            {r.source === 'computed' ? t('balances.updatedToday') : (age ?? '—')}
          </span>
        );
    }
  };

  const shareCell = (r: ChannelRow) => {
    const pct = liquidSharePct(r, summary.liquid);
    if (pct === null) {
      return (
        <span className="text-text-3" title={r.liquid ? undefined : t('balances.notLiquid')}>
          —
        </span>
      );
    }
    const width = Math.max(0, Math.min(100, pct));
    return (
      <span className="inline-flex items-center justify-end gap-2">
        <span aria-hidden className="block h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunk">
          <span className="block h-full rounded-full bg-brand-ink/75" style={{ width: `${width}%` }} />
        </span>
        <span className={cn(NUM_CLASS, 'w-12 text-right text-text-2')}>{pctFmt.format(pct)} %</span>
      </span>
    );
  };

  const columns: FinColumn<ChannelRow>[] = [
    {
      key: 'channel',
      header: t('balances.colChannel'),
      cell: (r) => r.label,
      meta: (r) => {
        const parts = [typeLabel(r.type)];
        if (r.holder) parts.push(r.holder);
        if (r.share < 0.9999) {
          parts.push(
            t('cash.sharedLocation', {
              percent: (r.share * 100).toFixed((r.share * 100) % 1 === 0 ? 0 : 2),
              total: formatMoney(r.fullBalance),
            }),
          );
        }
        return parts.join(' · ');
      },
      // En tarjeta (< 720 px) la fuente y la frescura van bajo el nombre.
      mobileMeta: (r) => (
        <>
          {sourceChip(r)}
          {freshnessCell(r)}
        </>
      ),
    },
    { key: 'source', header: t('balances.colSource'), cell: sourceChip, hideSm: true, width: '96px' },
    { key: 'updated', header: t('balances.colUpdated'), cell: freshnessCell, hideSm: true, width: '150px' },
    {
      key: 'balance',
      header: t('balances.colBalance'),
      kind: 'money',
      value: (r) => r.signed,
      money: {
        stale: (r) =>
          r.freshness === 'stale' || r.freshness === 'degraded'
            ? (ageText(r.asOf) ?? t('balances.staleBadge'))
            : undefined,
      },
    },
    { key: 'share', header: t('balances.colShare'), kind: 'number', cell: shareCell, hideSm: true, width: '140px' },
  ];

  const rowActions = (r: ChannelRow) => {
    const loc = locByKey.get(r.channelKey);
    if (!loc) return null;
    const isPrimary = view === 'type' || primaryGroupOf.get(r.channelKey) === r.unitKey;
    const nodes: ReactNode[] = [];
    if (hasLedger(r.channelKey)) {
      nodes.push(
        <Link
          key="book"
          href={`/balances/libro/${encodeURIComponent(r.channelKey)}`}
          className={ROW_BTN}
          title={t('ledger.openBook')}
          aria-label={`${t('ledger.openBook')} — ${r.label}`}
        >
          <BookOpen aria-hidden className="size-4" strokeWidth={1.75} />
        </Link>,
      );
    }
    if (isPrimary) {
      const extra = extraActions?.(r.channelKey);
      if (extra) nodes.push(<span key="extra" className="contents">{extra}</span>);
    }
    if (isPrimary && canManage) {
      nodes.push(
        <button
          key="edit"
          type="button"
          onClick={() => startEdit(loc)}
          disabled={editingKey === r.channelKey}
          className={ROW_BTN}
          title={t('cash.editLocation')}
          aria-label={`${t('cash.editLocation')} — ${r.label}`}
        >
          <Settings2 aria-hidden className="size-4" strokeWidth={1.75} />
        </button>,
        <button
          key="archive"
          type="button"
          onClick={() => setArchived(loc, loc.is_visible)}
          disabled={saving}
          className={ROW_BTN}
          title={loc.is_visible ? t('cash.archive') : t('cash.unarchive')}
          aria-label={`${loc.is_visible ? t('cash.archive') : t('cash.unarchive')} — ${r.label}`}
        >
          <Archive aria-hidden className="size-4" strokeWidth={1.75} />
        </button>,
      );
      if (loc.is_custom) {
        nodes.push(
          <button
            key="delete"
            type="button"
            onClick={() => removeLocation(loc)}
            disabled={saving}
            className={cn(ROW_BTN, 'hover:text-neg')}
            title={t('cash.deleteLocation')}
            aria-label={`${t('cash.deleteLocation')} — ${r.label}`}
          >
            <Trash2 aria-hidden className="size-4" strokeWidth={1.75} />
          </button>,
        );
      }
    }
    return nodes.length > 0 ? nodes : null;
  };

  const groupLabel = (key: string): ReactNode => {
    if (view === 'type') return t(GROUP_LABEL_KEY[key as ChannelGroupKey] ?? key);
    const unit = key === NO_UNIT ? null : unitById.get(key) ?? null;
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span>{unit ? unit.name : t('cash.noUnit')}</span>
        <StatusBadge
          kind={unit && !unit.counts_to_fund ? 'neutral' : 'info'}
          label={unit && !unit.counts_to_fund ? t('cash.apartFromFund') : t('cash.inFund')}
        />
        {/* El libro consolidado existía pero solo se llegaba haciendo click en
            el nombre de la unidad: nadie lo encontraba. */}
        {unit && (
          <Link
            href={`/balances/unidad/${encodeURIComponent(unit.id)}`}
            className="inline-flex items-center gap-1 font-medium text-brand-ink hover:underline"
            title={t('unitLedger.openBook')}
          >
            <ArrowRightLeft aria-hidden className="size-3.5" />
            {t('cash.viewMovements')}
          </Link>
        )}
      </span>
    );
  };

  const kpis: KpiItem[] = [
    {
      key: 'total',
      label: hasDebt ? t('cash.totalNet') : t('balances.totalConsolidated'),
      value: summary.total,
      format: 'money',
      hero: true,
      sub:
        count.missing > 0
          ? plural(count.missing, 'balances.kpiMissingOne', 'balances.kpiMissingMany')
          : hasDebt
            ? t('cash.totalNetHint')
            : t('cash.totalHint'),
    },
    { key: 'liquid', label: t('cash.available'), value: summary.liquid, format: 'money', sub: t('cash.availableHint') },
    { key: 'lent', label: t('cash.lent'), value: summary.lent, format: 'money', sub: t('cash.lentHint') },
    // La Deuda sólo aparece si hay: un KPI en $0 para todas las empresas que
    // nunca pidieron prestado sería ruido. Va NEGATIVA: es un pasivo (neg).
    ...(hasDebt
      ? [
          {
            key: 'owed',
            label: (
              <span className="inline-flex items-center gap-1">
                {t('cash.owed')} <InfoTip text={GLOSSARY.deudaConTerceros} />
              </span>
            ),
            value: -summary.owed,
            format: 'money' as const,
            sub: t('cash.owedHint'),
          },
        ]
      : []),
    {
      key: 'fund',
      label: t('cash.fund'),
      value: summary.fund,
      format: 'money',
      sub: `${t('cash.outsideFund')}: ${formatMoney(summary.outsideFund)}`,
    },
  ];

  const editingLoc = editingKey ? locByKey.get(editingKey) ?? null : null;
  const reviewLink = (
    <a href="#saldo-por-canal" className="text-brand-ink underline underline-offset-2">
      {t('balances.review')}
    </a>
  );

  // Detalle por canal: lo que antes eran sub-filas (wallets fijadas de
  // Coinsbuy, desglose on-chain por moneda). Mismo orden que la tabla.
  const details = typeRows
    .map((r) => {
      const loc = locByKey.get(r.channelKey);
      const onchainMeta = loc && isOnchain(loc) ? getSnapshotMeta?.(r.channelKey) ?? null : null;
      const extra = extraRows?.(r.channelKey) ?? null;
      if (!onchainMeta && !extra) return null;
      return (
        <div key={r.channelKey} className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground">{r.label}</p>
          {onchainMeta && <OnchainBreakdown meta={onchainMeta} />}
          {extra}
        </div>
      );
    })
    .filter(Boolean);

  const footerNotes: ReactNode[] = [];
  if (hiddenChannels.length > 0) {
    footerNotes.push(<p key="hidden">{t('balances.hiddenNote', { names: hiddenChannels.join(', ') })}</p>);
  }
  if (summary.lent !== 0) footerNotes.push(<p key="lent">{t('cash.lentNotice')}</p>);
  if (hasDebt) footerNotes.push(<p key="owed">{t('cash.owedNotice')}</p>);

  return (
    <>
      {status &&
        (status.kind === 'err' ? (
          <Notice kind="bad" title={status.msg} />
        ) : (
          <p role="status" className="text-[13px] font-medium text-pos">
            {status.msg}
          </p>
        ))}

      <KpiStrip items={kpis} />

      {/* Estado del dato: lo viejo SIGUE sumando (stale), lo que no tiene dato
          NO suma (pend). Siempre con nombres y cifra (spec §5.5). */}
      {(fresh.outdated.labels.length > 0 || fresh.missing.labels.length > 0) && (
        <div className="space-y-2">
          {fresh.outdated.labels.length > 0 && (
            <Notice
              kind="stale"
              title={plural(fresh.outdated.labels.length, 'balances.outdatedTitleOne', 'balances.outdatedTitleMany')}
              action={reviewLink}
            >
              {t('balances.outdatedBody', {
                names: fresh.outdated.labels.join(', '),
                amount: formatMoney(fresh.outdated.amount),
              })}
            </Notice>
          )}
          {fresh.missing.labels.length > 0 && (
            <Notice
              kind="pend"
              title={plural(fresh.missing.labels.length, 'balances.missingTitleOne', 'balances.missingTitleMany')}
              action={reviewLink}
            >
              {t('balances.missingBody', { names: fresh.missing.labels.join(', ') })}
            </Notice>
          )}
        </div>
      )}

      {channels.length === 0 ? (
        <Panel title={t('balances.tableTitle')}>
          <p className="py-4 text-center text-[13px] text-text-2">
            {t('balances.noVisibleChannelsPre')} <strong>{t('balances.configure')}</strong>{' '}
            {t('balances.noVisibleChannelsPost')}
          </p>
          {hiddenChannels.length > 0 && (
            <p className="text-center text-[12.5px] text-text-3">
              {t('balances.hiddenNote', { names: hiddenChannels.join(', ') })}
            </p>
          )}
        </Panel>
      ) : (
        <>
          <Panel title={t('balances.distTitle')} hint={t('balances.distHint')} flush>
            <DistributionBar items={distItems} />
          </Panel>

          <Panel
            id="saldo-por-canal"
            className="scroll-mt-20"
            title={t('balances.tableTitle')}
            hint={t('balances.tableHint', { date: selectedDate })}
            flush
            actions={
              <>
                <Segmented<View>
                  aria-label={t('balances.viewLabel')}
                  value={view}
                  onChange={setView}
                  options={[
                    { value: 'type', label: t('balances.viewByType') },
                    { value: 'unit', label: t('balances.viewByUnit'), count: units.length || null },
                  ]}
                />
                {canManage && (
                  <button type="button" onClick={() => setShowUnits(true)} className={BTN}>
                    <Building2 aria-hidden className="size-[15px]" strokeWidth={1.75} />
                    <span className="max-sm:sr-only">{t('cash.manageUnits')}</span>
                  </button>
                )}
              </>
            }
            footer={footerNotes.length > 0 ? <div className="space-y-1">{footerNotes}</div> : undefined}
          >
            <FinTable<ChannelRow>
              caption={t('balances.tableTitle')}
              columns={columns}
              rows={rows}
              rowKey={(r) => r.rowKey}
              groupBy={(r) => (view === 'unit' ? r.unitKey : r.group)}
              groupLabel={groupLabel}
              selectedKey={
                editingKey
                  ? view === 'type'
                    ? editingKey
                    : `${primaryGroupOf.get(editingKey) ?? NO_UNIT}:${editingKey}`
                  : null
              }
              rowActions={rowActions}
              footer={{
                label: (
                  <span>
                    {hasDebt ? t('cash.totalNet') : t('balances.totalConsolidated')}
                    <span className="ml-2 text-[12px] font-medium text-text-3">
                      {t('balances.footerCount', {
                        summed: String(count.summed),
                        excluded: String(count.excluded),
                      })}
                    </span>
                  </span>
                ),
                values: { balance: summary.total },
              }}
            />

            {editingLoc && draft && (
              <div className="border-t border-border p-4">
                <h3 className="mb-3 text-[13.5px] font-semibold text-foreground">
                  {t('balances.editTitle', { name: editingLoc.label })}
                </h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t('cash.locationType')}>
                    <Select
                      value={draft.location_type}
                      onChange={(e) => setDraft({ ...draft, location_type: e.target.value as LocationType })}
                    >
                      {LOCATION_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {typeLabel(type)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('cash.holder')} required={requiresHolder(draft.location_type)}>
                    <Input
                      value={draft.holder}
                      onChange={(e) => setDraft({ ...draft, holder: e.target.value })}
                      placeholder={
                        isDebt(draft.location_type) ? t('cash.debtHolderPlaceholder') : t('cash.holderPlaceholder')
                      }
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <UnitSharesEditor
                      units={units}
                      value={draft.shares}
                      onChange={(shares) => setDraft({ ...draft, shares })}
                    />
                  </div>
                  {/* Solo para wallets: una cuenta bancaria o un préstamo no
                      tienen dirección en una blockchain. */}
                  {draft.location_type === 'wallet' && (
                    <div className="border-t border-border pt-2 sm:col-span-2">
                      <OnchainWalletsEditor
                        value={draft.onchain}
                        onChange={(onchain) => setDraft({ ...draft, onchain })}
                        disabled={saving}
                      />
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
                    <p className="text-[12px] text-text-3">
                      {isAutomatic(editingLoc.location_type) || isOnchain(editingLoc)
                        ? t('cash.autoBalanceNote')
                        : isDebt(draft.location_type)
                          ? t('balances.cfgDebtHelp')
                          : t('cash.manualBalanceNote')}
                    </p>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={cancelEdit} className={BTN}>
                        <X aria-hidden className="size-[15px]" strokeWidth={1.75} />
                        {t('common.cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={() => saveEdit(editingLoc)}
                        disabled={saving}
                        className={BTN}
                      >
                        <Check aria-hidden className="size-[15px]" strokeWidth={1.75} />
                        {t('common.save')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Panel>

          {details.length > 0 && (
            <Panel title={t('balances.detailTitle')} hint={t('balances.detailHint')}>
              <div className="grid gap-x-8 gap-y-5 min-[1100px]:grid-cols-2">{details}</div>
            </Panel>
          )}
        </>
      )}

      {canManage && (
        <BusinessUnitsModal
          open={showUnits}
          onClose={() => setShowUnits(false)}
          onChanged={() => {
            loadUnits();
            // Borrar una unidad borra en cascada sus filas de reparto, así que
            // la configuración también hay que releerla.
            onChanged();
          }}
        />
      )}
    </>
  );
}
