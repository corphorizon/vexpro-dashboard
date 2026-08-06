'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Libro de balances de un canal.
//
// Dos regímenes, misma pantalla (ver channel-ledger.ts):
//   · Canal por API (coinsbuy / unipayment) → SOLO LECTURA. El cron de las
//     00:00 UTC asienta los depósitos, los retiros, las transferencias
//     internas y el ajuste que cierra contra el saldo real del proveedor.
//   · Canal manual → alta, edición y baja de asientos a mano.
//
// La tabla NO usa <DataTable> a propósito: tiene filas editables, y DataTable
// está pensado para datos de solo lectura (ordenamiento + paginación propios
// que pelean con el estado de edición).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, BookOpen, Plus, Pencil, Trash2, FileDown, Lock } from 'lucide-react';
import { useAuth, canAdd } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { apiFetch } from '@/lib/api-fetch';
import { formatCurrency } from '@/lib/utils';
import { resolveChannels, type ChannelConfigRow } from '@/lib/channel-configs';
import {
  withRunningBalance,
  computeTotals,
  isAutoLedger,
  hasLedger,
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LedgerEntryDialog } from '@/components/balances/ledger-entry-dialog';
import { generateChannelLedgerPDF } from '@/lib/pdf-export';

function monthRange(): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const lastDay = new Date(y, m, 0).getDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay)}` };
}

export default function ChannelLedgerPage() {
  const params = useParams<{ channel: string }>();
  const router = useRouter();
  const channelKey = decodeURIComponent(params.channel ?? '');

  const { t, locale } = useI18n();
  const { user } = useAuth();
  const { company } = useData();
  const { toast, ToastHost } = useToasts();

  const isAuto = isAutoLedger(channelKey);
  // Los canales por API son de solo lectura aunque el usuario tenga permiso
  // de escritura: el saldo lo manda el proveedor.
  const canWrite = canAdd(user) && !isAuto && hasLedger(channelKey);

  const [range, setRange] = useState(monthRange);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [priorEntries, setPriorEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [channelLabel, setChannelLabel] = useState(channelKey);
  const [dialogEntry, setDialogEntry] = useState<LedgerEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<LedgerEntry | null>(null);

  // ── Nombre del canal (puede estar renombrado por la empresa) ────────────
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/admin/channel-configs')
      .then((r) => r.json())
      .then((json: { success?: boolean; rows?: ChannelConfigRow[] }) => {
        if (cancelled || !json.success) return;
        const found = resolveChannels(json.rows ?? []).find((c) => c.key === channelKey);
        if (found) setChannelLabel(found.label);
      })
      .catch(() => { /* el key crudo alcanza como fallback */ });
    return () => { cancelled = true; };
  }, [channelKey]);

  // ── Asientos ───────────────────────────────────────────────────────────
  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/admin/channel-ledger?channel_key=${encodeURIComponent(channelKey)}&from=${range.from}&to=${range.to}`,
      );
      const json = await res.json();
      if (json.success) {
        setEntries(json.entries ?? []);
        setPriorEntries(json.priorEntries ?? []);
      } else {
        toast.error(json.error ?? 'No se pudo cargar el libro');
      }
    } catch {
      toast.error('No se pudo cargar el libro');
    } finally {
      setLoading(false);
    }
  }, [channelKey, range.from, range.to, toast]);

  useEffect(() => { void loadEntries(); }, [loadEntries]);

  // El saldo corrido tiene que arrancar en el saldo REAL del canal al inicio
  // del rango, no en cero: por eso se calcula sobre prior + rango y después
  // se muestran solo las filas del rango.
  const rows = useMemo(() => {
    const all = withRunningBalance([...priorEntries, ...entries]);
    return all.filter((r) => r.entry_date >= range.from && r.entry_date <= range.to);
  }, [priorEntries, entries, range.from, range.to]);

  const totals = useMemo(
    () => computeTotals([...priorEntries, ...entries], range.from, range.to),
    [priorEntries, entries, range.from, range.to],
  );

  // ── Acciones ───────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      const res = await apiFetch('/api/admin/channel-ledger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: pendingDelete.id }),
      });
      const json = await res.json();
      if (json.success) {
        toast.success(t('ledger.deleted'));
        await loadEntries();
      } else {
        toast.error(json.error ?? 'No se pudo eliminar');
      }
    } catch {
      toast.error('No se pudo eliminar');
    } finally {
      setPendingDelete(null);
    }
  };

  const handleExport = () => {
    generateChannelLedgerPDF({
      company: {
        name: company?.name ?? 'Dashboard',
        logoUrl: company?.logo_url ?? null,
        colorPrimary: company?.color_primary ?? null,
      },
      channelLabel,
      isAuto,
      from: range.from,
      to: range.to,
      rows,
      totals,
      locale: locale === 'en' ? 'en' : 'es',
    });
  };

  if (!hasLedger(channelKey)) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('ledger.title')} icon={BookOpen} />
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">{t('ledger.noLedgerNotice')}</p>
          <Button className="mt-4" onClick={() => router.push('/balances')}>
            <ArrowLeft className="w-4 h-4" /> {t('ledger.backToBalances')}
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {ToastHost}

      <PageHeader
        title={`${t('ledger.title')} · ${channelLabel}`}
        subtitle={`${range.from} → ${range.to}`}
        icon={BookOpen}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/balances"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> {t('ledger.backToBalances')}
            </Link>
            <Button variant="secondary" size="sm" onClick={handleExport} disabled={rows.length === 0}>
              <FileDown className="w-4 h-4" /> {t('ledger.exportPdf')}
            </Button>
            {canWrite && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => { setDialogEntry(null); setDialogOpen(true); }}
              >
                <Plus className="w-4 h-4" /> {t('ledger.newEntry')}
              </Button>
            )}
          </div>
        }
      />

      {isAuto && (
        <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4">
          <Lock className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">{t('ledger.autoNotice')}</p>
        </div>
      )}

      {/* Rango */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('ledger.from')}</span>
            <input
              type="date"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="h-9 rounded-lg border border-border bg-card px-3 text-base sm:text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('ledger.to')}</span>
            <input
              type="date"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="h-9 rounded-lg border border-border bg-card px-3 text-base sm:text-sm"
            />
          </label>
        </div>
      </Card>

      {/* Resumen del rango */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard label={t('ledger.openingBalance')} value={formatCurrency(totals.opening)} />
        <StatCard label={t('ledger.inflows')} value={formatCurrency(totals.inflows)} tone="positive" />
        <StatCard label={t('ledger.outflows')} value={formatCurrency(totals.outflows)} tone="negative" />
        <StatCard
          label={t('ledger.internalTransfers')}
          value={formatCurrency(totals.internalTransfers)}
          hint={t('ledger.internalHint')}
        />
        <StatCard
          label={t('ledger.closingBalance')}
          value={formatCurrency(totals.closing)}
          emphasis
        />
      </div>

      {/* Libro */}
      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-medium">{t('ledger.date')}</th>
                <th className="px-4 py-3 font-medium">{t('ledger.concept')}</th>
                <th className="px-4 py-3 font-medium">{t('ledger.reference')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('ledger.inflow')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('ledger.outflow')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('ledger.runningBalance')}</th>
                {canWrite && <th className="px-4 py-3 w-20" />}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">…</td></tr>
              )}

              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-0">
                    <EmptyState
                      icon={BookOpen}
                      title={t('ledger.empty')}
                      description={isAuto ? t('ledger.autoNotice') : t('ledger.emptyHint')}
                    />
                  </td>
                </tr>
              )}

              {!loading && rows.map((row) => {
                const autoLabel = autoCategoryLabel(row.category, locale === 'en' ? 'en' : 'es');
                const isAdjustment = row.category === AUTO_CATEGORIES.adjustment;
                const isInternal = row.category === AUTO_CATEGORIES.internal;
                return (
                  <tr key={row.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums text-muted-foreground">
                      {row.entry_date}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{autoLabel ?? row.concept}</div>
                      {(isAdjustment || isInternal) && (
                        <div className="text-xs text-muted-foreground mt-0.5 max-w-md">
                          {isAdjustment ? t('ledger.adjustmentHint') : t('ledger.internalHint')}
                        </div>
                      )}
                      {!autoLabel && row.category && (
                        <div className="text-xs text-muted-foreground mt-0.5">{row.category}</div>
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
                    {canWrite && (
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('ledger.editEntry')}
                            onClick={() => { setDialogEntry(row); setDialogOpen(true); }}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          {row.kind !== 'opening' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t('ledger.deleteEntry')}
                              onClick={() => setPendingDelete(row)}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <LedgerEntryDialog
        open={dialogOpen}
        channelKey={channelKey}
        entry={dialogEntry}
        onClose={() => setDialogOpen(false)}
        onSaved={() => { setDialogOpen(false); void loadEntries(); }}
      />

      {pendingDelete && (
        <ConfirmDialog
          title={t('ledger.deleteEntry')}
          message={t('ledger.deleteConfirm')}
          tone="danger"
          onConfirm={handleDelete}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
