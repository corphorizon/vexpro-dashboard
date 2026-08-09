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
// SOLO LECTURA a propósito: las ubicaciones mezclan canales automáticos
// (pasarelas que escribe el cron) con canales manuales, y editar acá obligaría
// a decidir fila por fila cuál se puede tocar. El alta y la edición siguen
// viviendo en el libro de cada ubicación, a un click de distancia.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Building2, FileDown, Lock, Wallet } from 'lucide-react';
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
  AUTO_CATEGORIES,
  type LedgerEntry,
} from '@/lib/channel-ledger';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useToasts } from '@/components/ui/toast';
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
  const unitId = decodeURIComponent(params.id ?? '');

  const { t, locale } = useI18n();
  const { company } = useData();
  const { toast, ToastHost } = useToasts();
  const lang = locale === 'en' ? 'en' : 'es';

  const [range, setRange] = useState(monthRange);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [priorEntries, setPriorEntries] = useState<LedgerEntry[]>([]);
  const [unitChannelKeys, setUnitChannelKeys] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [unit, setUnit] = useState<BusinessUnit | null>(null);
  const [unitMissing, setUnitMissing] = useState(false);
  const [loading, setLoading] = useState(true);

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

  const totals = useMemo(
    () => computeTotals([...priorEntries, ...entries], range.from, range.to),
    [priorEntries, entries, range.from, range.to],
  );

  // Saldo de cada ubicación al cierre del rango. Se listan también las
  // ubicaciones sin un solo asiento: que estén en cero es información.
  const perLocation = useMemo(() => {
    const all = [...priorEntries, ...entries];
    const keys = new Set<string>(unitChannelKeys);
    for (const e of all) keys.add(e.channel_key);
    return [...keys]
      .map((key) => ({
        key,
        label: labelOf(key),
        balance: balanceAsOf(all.filter((e) => e.channel_key === key), range.to),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [priorEntries, entries, unitChannelKeys, labelOf, range.to]);

  const unitName = unit?.name ?? t('unitLedger.title');

  const handleExport = () => {
    generateChannelLedgerPDF({
      company: {
        name: company?.name ?? 'Dashboard',
        logoUrl: company?.logo_url ?? null,
        colorPrimary: company?.color_primary ?? null,
      },
      channelLabel: unitName,
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
          </div>
        }
      />

      <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4">
        <Lock className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{t('unitLedger.readOnlyNotice')}</p>
      </div>

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
                  <span className="truncate">{loc.label}</span>
                </span>
                <span className="font-semibold tabular-nums shrink-0">{formatCurrency(loc.balance)}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>

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
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{autoLabel ?? row.concept}</div>
                        {(isAdjustment || isInternal) && (
                          <div className="text-xs text-muted-foreground mt-0.5 max-w-md">
                            {isAdjustment
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
    </div>
  );
}
