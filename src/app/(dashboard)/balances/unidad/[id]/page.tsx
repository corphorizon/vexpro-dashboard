'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Libro consolidado de una unidad de negocio.
//
// Una unidad no tiene asientos propios: son los de todas sus ubicaciones
// (wallets, bancos, pasarelas, préstamos) puestos en una sola línea de tiempo
// con saldo corrido. El cálculo es el mismo de siempre — channel-ledger.ts —
// porque un consolidado que sumara por su cuenta terminaría discrepando del
// libro de cada ubicación.
//
// LA TABLA es de solo lectura a propósito: las ubicaciones mezclan canales
// automáticos (pasarelas que escribe el cron) con canales manuales, y editar
// fila por fila acá obligaría a decidir cuál se puede tocar. La EDICIÓN sigue
// viviendo en el libro de cada ubicación, a un click de distancia.
//
// El ALTA, en cambio, sí se puede disparar desde acá (pedido de Kevin: "en las
// empresas necesito la forma de alimentar el libro"). No es una excepción a lo
// anterior: un asiento nuevo no tiene ambigüedad de origen, solo hace falta
// saber en qué ubicación cae. Si la unidad tiene una sola ubicación manual se
// asume esa; si tiene varias se pregunta; las pasarelas nunca se ofrecen.
//
// UBICACIONES COMPARTIDAS (migración 071 / auditoría 2026-08, A5)
// Una wallet puede pertenecer a varias unidades con porcentaje. El endpoint
// devuelve la parte de cada ubicación y acá se aplica a los TOTALES y al saldo
// por ubicación — sin eso, una wallet 50/50 sumaba entera en las dos unidades.
// Los ASIENTOS, en cambio, se listan completos: un depósito de $10.000 en una
// wallet compartida fue de $10.000, y mostrar $5.000 sería inventar un
// movimiento que no ocurrió. La nota de "compartida" explica la diferencia.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Building2, FileDown, Lock, Plus, Wallet } from 'lucide-react';
import { useAuth, canAdd } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { apiFetch } from '@/lib/api-fetch';
import { formatCurrency } from '@/lib/utils';
import { resolveChannels, type ChannelConfigRow } from '@/lib/channel-configs';
import type { BusinessUnit } from '@/lib/cash-locations';
import {
  withRunningBalance,
  computeTotals,
  balanceAsOf,
  autoCategoryLabel,
  isAutoLedger,
  hasLedger,
  AUTO_CATEGORIES,
  type LedgerEntry,
  type LedgerTotals,
} from '@/lib/channel-ledger';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useToasts } from '@/components/ui/toast';
import { LedgerEntryDialog } from '@/components/balances/ledger-entry-dialog';
import { LedgerLocationPicker } from '@/components/balances/ledger-location-picker';
import { generateChannelLedgerPDF } from '@/lib/pdf-export';

function monthRange(): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const lastDay = new Date(y, m, 0).getDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay)}` };
}

export default function BusinessUnitLedgerPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const unitId = decodeURIComponent(params.id ?? '');

  const { t, locale } = useI18n();
  const { user } = useAuth();
  const { company } = useData();
  const { toast, ToastHost } = useToasts();
  const lang = locale === 'en' ? 'en' : 'es';

  const canWrite = canAdd(user);

  const [range, setRange] = useState(monthRange);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [priorEntries, setPriorEntries] = useState<LedgerEntry[]>([]);
  const [unitChannelKeys, setUnitChannelKeys] = useState<string[]>([]);
  /** Parte de cada ubicación que le corresponde a esta unidad (1 = exclusiva). */
  const [shares, setShares] = useState<Record<string, number>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  /** Ubicaciones con direcciones on-chain: su libro también lo escribe el cron. */
  const [onchainKeys, setOnchainKeys] = useState<ReadonlySet<string>>(new Set());
  const [unit, setUnit] = useState<BusinessUnit | null>(null);
  const [unitMissing, setUnitMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  /** Ubicación elegida para el alta; null = no hay diálogo de asiento abierto. */
  const [entryChannel, setEntryChannel] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // ── Nombre de la unidad ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/admin/business-units?include_inactive=1')
      .then((r) => r.json())
      .then((json: { success?: boolean; units?: BusinessUnit[] }) => {
        if (cancelled) return;
        const found = (json.units ?? []).find((u) => u.id === unitId) ?? null;
        setUnit(found);
        setUnitMissing(!found);
      })
      .catch(() => {
        if (!cancelled) setUnitMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [unitId]);

  // ── Nombres de las ubicaciones (pueden estar renombradas por la empresa) ─
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/admin/channel-configs')
      .then((r) => r.json())
      .then((json: { success?: boolean; rows?: ChannelConfigRow[] }) => {
        if (cancelled || !json.success) return;
        const map: Record<string, string> = {};
        for (const ch of resolveChannels(json.rows ?? [])) map[ch.key] = ch.label;
        setLabels(map);
        // Una ubicación con direcciones cargadas lleva libro automático aunque
        // su clave sea `wallet_externa` o `custom_<uuid>`: el cron la asienta
        // contra el saldo de la cadena. Ofrecerla para un asiento a mano era
        // ofrecer algo que el endpoint rechaza.
        setOnchainKeys(
          new Set(
            (json.rows ?? [])
              .filter((r) => (r.onchain_wallets?.length ?? 0) > 0)
              .map((r) => r.channel_key),
          ),
        );
      })
      .catch(() => {
        /* el channel_key crudo alcanza como fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Asientos de todas las ubicaciones de la unidad ──────────────────────
  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/admin/channel-ledger?business_unit_id=${encodeURIComponent(unitId)}&from=${range.from}&to=${range.to}`,
      );
      const json = await res.json();
      if (json.success) {
        setEntries(json.entries ?? []);
        setPriorEntries(json.priorEntries ?? []);
        setUnitChannelKeys(json.channelKeys ?? []);
        setShares(json.shares ?? {});
      } else {
        toast.error(json.error ?? t('unitLedger.loadError'));
      }
    } catch {
      toast.error(t('unitLedger.loadError'));
    } finally {
      setLoading(false);
    }
  }, [unitId, range.from, range.to, toast, t]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const labelOf = useCallback((key: string) => labels[key] ?? key, [labels]);

  // El saldo corrido arranca en el saldo REAL de la unidad al inicio del
  // rango: se calcula sobre prior + rango y recién después se recortan las
  // filas visibles.
  const rows = useMemo(() => {
    const all = withRunningBalance([...priorEntries, ...entries]);
    return all.filter((r) => r.entry_date >= range.from && r.entry_date <= range.to);
  }, [priorEntries, entries, range.from, range.to]);

  const shareOf = useCallback(
    (key: string) => {
      const s = Number(shares[key]);
      return Number.isFinite(s) && s > 0 ? Math.min(s, 1) : 1;
    },
    [shares],
  );

  const allKeys = useMemo(() => {
    const keys = new Set<string>(unitChannelKeys);
    for (const e of priorEntries) keys.add(e.channel_key);
    for (const e of entries) keys.add(e.channel_key);
    return [...keys];
  }, [unitChannelKeys, priorEntries, entries]);

  // Totales del rango PONDERADOS por la parte de cada ubicación: si una wallet
  // es 50% de esta unidad, solo la mitad de su saldo y de sus flujos es de
  // esta unidad. Se calcula canal por canal (computeTotals sobre el subconjunto)
  // y se suma ponderado — sumar todo y ponderar después daría cualquier cosa
  // apenas dos ubicaciones tengan porcentajes distintos.
  const totals = useMemo<LedgerTotals>(() => {
    const all = [...priorEntries, ...entries];
    const acc: LedgerTotals = {
      opening: 0, inflows: 0, outflows: 0, internalTransfers: 0, adjustments: 0, closing: 0,
    };
    for (const key of allKeys) {
      const t = computeTotals(all.filter((e) => e.channel_key === key), range.from, range.to);
      const s = shareOf(key);
      acc.opening += t.opening * s;
      acc.inflows += t.inflows * s;
      acc.outflows += t.outflows * s;
      acc.internalTransfers += t.internalTransfers * s;
      acc.adjustments += t.adjustments * s;
      acc.closing += t.closing * s;
    }
    return acc;
  }, [priorEntries, entries, allKeys, shareOf, range.from, range.to]);

  // Saldo de cada ubicación al cierre del rango. Se listan también las
  // ubicaciones sin un solo asiento: que estén en cero es información.
  const perLocation = useMemo(() => {
    const all = [...priorEntries, ...entries];
    return allKeys
      .map((key) => {
        const full = balanceAsOf(all.filter((e) => e.channel_key === key), range.to);
        const share = shareOf(key);
        return { key, label: labelOf(key), share, fullBalance: full, balance: full * share };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [priorEntries, entries, allKeys, labelOf, shareOf, range.to]);

  const hasSharedLocations = useMemo(
    () => perLocation.some((l) => l.share < 1),
    [perLocation],
  );

  // Ubicaciones donde SÍ se puede escribir a mano. Es el mismo criterio que
  // usa el libro por canal (y que valida el endpoint): las pasarelas las
  // escribe el cron y los canales sin libro no tienen dónde asentar.
  const manualLocations = useMemo(
    () =>
      perLocation
        .filter((l) => hasLedger(l.key) && !isAutoLedger(l.key, { onchain: onchainKeys.has(l.key) }))
        .map((l) => ({ key: l.key, label: l.label, balance: l.balance })),
    [perLocation, onchainKeys],
  );

  const handleAddEntry = () => {
    // Sin ubicación manual no hay dónde asentar: el botón lleva a "Dónde está
    // el dinero", que es donde se crea o se asigna una.
    if (manualLocations.length === 0) {
      router.push('/balances');
      return;
    }
    // Con una sola ubicación manual preguntar sería un click de trámite: no
    // hay otra respuesta posible.
    if (manualLocations.length === 1) setEntryChannel(manualLocations[0].key);
    else setPickerOpen(true);
  };

  const sharePct = (share: number) => String(Math.round(share * 1000) / 10);

  const unitName = unit?.name ?? t('unitLedger.title');

  const handleExport = () => {
    generateChannelLedgerPDF({
      company: {
        name: company?.name ?? 'Dashboard',
        logoUrl: company?.logo_url ?? null,
        colorPrimary: company?.color_primary ?? null,
      },
      // Con ubicaciones compartidas el resumen del PDF va prorrateado y el
      // detalle no (igual que en pantalla): el rótulo lo dice para que el que
      // recibe el archivo no intente cuadrarlos.
      channelLabel: hasSharedLocations
        ? `${unitName} · ${t('unitLedger.sharedNoticeShort')}`
        : unitName,
      isAuto: false,
      from: range.from,
      to: range.to,
      // El PDF del canal no tiene columna de ubicación: acá hace falta, así
      // que se antepone al concepto en vez de mantener un segundo layout.
      rows: rows.map((r) => ({
        ...r,
        concept: `${labelOf(r.channel_key)} · ${autoCategoryLabel(r.category, lang) ?? r.concept}`,
      })),
      totals,
      locale: lang,
    });
  };

  if (unitMissing) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('unitLedger.title')} icon={Building2} />
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">{t('unitLedger.notFound')}</p>
          <Link
            href="/balances"
            className="mt-4 inline-flex items-center gap-1.5 min-h-11 text-sm text-accent hover:underline"
          >
            <ArrowLeft className="w-4 h-4" /> {t('unitLedger.backToBalances')}
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {ToastHost}

      <PageHeader
        title={`${t('unitLedger.title')} · ${unitName}`}
        subtitle={`${range.from} → ${range.to}`}
        icon={Building2}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/balances"
              className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-9 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> {t('unitLedger.backToBalances')}
            </Link>
            <Button variant="secondary" size="sm" onClick={handleExport} disabled={rows.length === 0}>
              <FileDown className="w-4 h-4" /> {t('unitLedger.exportPdf')}
            </Button>
            {canWrite && (
              <Button variant="primary" size="sm" onClick={handleAddEntry}>
                <Plus className="w-4 h-4" /> {t('unitLedger.addEntry')}
              </Button>
            )}
          </div>
        }
      />

      <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4">
        <Lock className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{t('unitLedger.readOnlyNotice')}</p>
      </div>

      {/* Aviso explícito: el botón existe pero no hay dónde asentar todavía. */}
      {canWrite && manualLocations.length === 0 && (
        <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4">
          <Wallet className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            {t('unitLedger.noManualLocationNotice')}{' '}
            <Link href="/balances" className="text-accent hover:underline">
              {t('unitLedger.goToCashLocations')}
            </Link>
          </p>
        </div>
      )}

      {/* Rango */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('unitLedger.from')}</span>
            <input
              type="date"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="h-11 sm:h-9 rounded-lg border border-border bg-card px-3 text-base sm:text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('unitLedger.to')}</span>
            <input
              type="date"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="h-11 sm:h-9 rounded-lg border border-border bg-card px-3 text-base sm:text-sm"
            />
          </label>
        </div>
      </Card>

      {/* Resumen del rango */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard label={t('unitLedger.openingBalance')} value={formatCurrency(totals.opening)} />
        <StatCard label={t('unitLedger.inflows')} value={formatCurrency(totals.inflows)} tone="positive" />
        <StatCard label={t('unitLedger.outflows')} value={formatCurrency(totals.outflows)} tone="negative" />
        <StatCard label={t('unitLedger.adjustments')} value={formatCurrency(totals.adjustments)} />
        <StatCard label={t('unitLedger.closingBalance')} value={formatCurrency(totals.closing)} emphasis />
      </div>

      {/* Desglose por ubicación */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          {t('unitLedger.byLocation')}
        </h2>
        {perLocation.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('unitLedger.noLocations')}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {perLocation.map((loc) => (
              <Link
                key={loc.key}
                href={`/balances/libro/${encodeURIComponent(loc.key)}`}
                className="flex items-center justify-between gap-3 min-h-11 px-3 py-2 rounded-lg border border-border hover:bg-muted/60 transition-colors"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Wallet className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate">{loc.label}</span>
                    {loc.share < 1 && (
                      <span className="block text-xs text-muted-foreground">
                        {t('unitLedger.sharedOf', {
                          pct: sharePct(loc.share),
                          total: formatCurrency(loc.fullBalance),
                        })}
                      </span>
                    )}
                  </span>
                </span>
                <span className="font-semibold tabular-nums shrink-0">{formatCurrency(loc.balance)}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>

      {/* Ubicaciones compartidas: el resumen va prorrateado, los asientos no. */}
      {hasSharedLocations && (
        <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4">
          <Wallet className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">{t('unitLedger.sharedNotice')}</p>
        </div>
      )}

      {/* Libro consolidado */}
      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-medium">{t('unitLedger.date')}</th>
                <th className="px-4 py-3 font-medium">{t('unitLedger.location')}</th>
                <th className="px-4 py-3 font-medium">{t('unitLedger.concept')}</th>
                <th className="px-4 py-3 font-medium">{t('unitLedger.reference')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('unitLedger.inflow')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('unitLedger.outflow')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('unitLedger.runningBalance')}</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    …
                  </td>
                </tr>
              )}

              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-0">
                    <EmptyState
                      icon={Building2}
                      title={t('unitLedger.empty')}
                      description={
                        perLocation.length === 0
                          ? t('unitLedger.noLocationsHint')
                          : t('unitLedger.emptyHint')
                      }
                    />
                  </td>
                </tr>
              )}

              {!loading &&
                rows.map((row) => {
                  const autoLabel = autoCategoryLabel(row.category, lang);
                  const isAdjustment = row.category === AUTO_CATEGORIES.adjustment;
                  const isInternal = row.category === AUTO_CATEGORIES.internal;
                  // Ver la nota gemela en balances/libro/[channel]: la
                  // variación del saldo comparte aritmética con el ajuste pero
                  // no su explicación. Hoy esta pantalla solo lista canales sin
                  // libro automático, así que no debería aparecer — está por si
                  // esa condición cambia, no para tapar un caso conocido.
                  const isBalanceDelta = row.category === AUTO_CATEGORIES.balanceDelta;
                  return (
                    <tr key={row.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-3 whitespace-nowrap tabular-nums text-muted-foreground">
                        {row.entry_date}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/balances/libro/${encodeURIComponent(row.channel_key)}`}
                          className="text-accent hover:underline"
                        >
                          {labelOf(row.channel_key)}
                        </Link>
                        {/* El importe de la fila es el del movimiento REAL, no
                            la parte de esta unidad: el badge evita leerlo como
                            si el 100% le correspondiera. */}
                        {shareOf(row.channel_key) < 1 && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {t('unitLedger.sharedBadge', { pct: sharePct(shareOf(row.channel_key)) })}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{autoLabel ?? row.concept}</div>
                        {(isAdjustment || isInternal || isBalanceDelta) && (
                          <div className="text-xs text-muted-foreground mt-0.5 max-w-md">
                            {isBalanceDelta
                              ? t('ledger.balanceDeltaHint')
                              : isAdjustment
                                ? t('unitLedger.adjustmentHint')
                                : t('unitLedger.internalHint')}
                          </div>
                        )}
                      </td>
                      {/* break-all: los hashes y las URLs no tienen espacios y
                          desbordan la celda si se los deja romper por palabra. */}
                      <td className="px-4 py-3 max-w-[220px] break-all text-muted-foreground">
                        {row.reference ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-positive">
                        {row.kind !== 'out' ? formatCurrency(row.amount) : ''}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-negative">
                        {row.kind === 'out' ? formatCurrency(row.amount) : ''}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">
                        {formatCurrency(row.balance)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </Card>

      <LedgerLocationPicker
        open={pickerOpen}
        locations={manualLocations}
        onPick={(key) => {
          setPickerOpen(false);
          setEntryChannel(key);
        }}
        onClose={() => setPickerOpen(false)}
      />

      {/* entry=null: desde acá solo se dan de alta asientos; editar sigue
          siendo cosa del libro de la ubicación. */}
      <LedgerEntryDialog
        open={entryChannel !== null}
        channelKey={entryChannel ?? ''}
        entry={null}
        onClose={() => setEntryChannel(null)}
        onSaved={() => {
          setEntryChannel(null);
          toast.success(t('unitLedger.entrySaved'));
          void loadEntries();
        }}
      />
    </div>
  );
}
