'use client';

import { useState, useMemo, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { useData } from '@/lib/data-context';
import { useAuth, hasModuleAccess, canAdd } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { formatCurrency } from '@/lib/utils';
import { upsertChannelBalance } from '@/lib/supabase/mutations';
import { fetchChannelBalances } from '@/lib/supabase/queries';
import type { ChannelBalance } from '@/lib/types';
import {
  Wallet,
  Calendar,
  RefreshCw,
  Save,
  TrendingUp,
  Droplets,
  Plug,
  Edit2,
  Check,
  X,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Channel definitions
// ─────────────────────────────────────────────────────────────────────────────

interface ChannelDef {
  key: string;
  label: string;
  type: 'api' | 'manual' | 'auto';
  icon?: React.ComponentType<{ className?: string }>;
  description?: string;
}

const CHANNELS: ChannelDef[] = [
  { key: 'coinsbuy',       label: 'Coinsbuy',                   type: 'api',    icon: Plug,       description: 'API en tiempo real (con fallback manual)' },
  { key: 'fairpay',        label: 'FairPay',                    type: 'manual',                    description: 'Ingreso manual' },
  { key: 'wallet_externa', label: 'Wallet Externa',             type: 'manual',                    description: 'Ingreso manual' },
  { key: 'otros',          label: 'Otros',                      type: 'manual',                    description: 'Ingreso manual' },
  { key: 'inversiones',    label: 'Balance Actual Inversiones', type: 'auto',   icon: TrendingUp, description: 'Automático desde módulo Inversiones' },
  { key: 'liquidez',       label: 'Balance Actual Liquidez',    type: 'auto',   icon: Droplets,   description: 'Automático desde módulo Liquidez' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function BalancesPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { company, periods, getPeriodSummary, computeSaldoChain, getInvestmentsData, getLiquidityData } = useData();
  const userCanAdd = canAdd(user);

  const [selectedDate, setSelectedDate] = useState<string>(todayISO());
  const [snapshots, setSnapshots] = useState<ChannelBalance[]>([]);
  const [loadingSnap, setLoadingSnap] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({}); // pending edits per channel key
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // ─── Access control ───
  if (!hasModuleAccess(user, 'balances')) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">{t('common.noAccess')}</p>
      </div>
    );
  }

  // ─── Section A: Balance Actual Disponible (chained across periods) ───
  // Formula per period: Net Deposit - Egresos Operativos - Monto a Distribuir
  // The result accumulates as the starting balance of the next period.

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
    }> = [];

    for (const p of periods) {
      const summary = getPeriodSummary(p.id);
      if (!summary) continue;
      const saldoInfo = saldoChain.get(p.id);
      const montoDistribuir = saldoInfo?.totalDistribuir ?? 0;
      const netDeposit = summary.netDeposit;
      const egresos = summary.totalExpenses;
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
      });
    }
    return rows;
  }, [periods, getPeriodSummary, computeSaldoChain]);

  const currentBalanceRow = balanceChain[balanceChain.length - 1];

  // ─── Section B: Balances por Canal (snapshots for selected date) ───

  // Auto-derived values from other modules
  const liquidityBalance = useMemo(() => {
    const data = getLiquidityData();
    return data[data.length - 1]?.balance || 0;
  }, [getLiquidityData]);

  const investmentsBalance = useMemo(() => {
    const data = getInvestmentsData();
    return data[data.length - 1]?.balance || 0;
  }, [getInvestmentsData]);

  // Load snapshots for selected date
  const loadSnapshots = async () => {
    if (!company) return;
    setLoadingSnap(true);
    setErrMsg(null);
    try {
      const data = await fetchChannelBalances(company.id, selectedDate);
      setSnapshots(data);
      setEditing({});
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

  // Helper: get value for a channel for the selected date
  const getChannelValue = (key: string): number => {
    if (key === 'liquidez') return liquidityBalance;
    if (key === 'inversiones') return investmentsBalance;
    const snap = snapshots.find(s => s.channel_key === key);
    return snap?.amount ?? 0;
  };

  const startEdit = (key: string) => {
    if (!userCanAdd) return;
    setEditing(prev => ({ ...prev, [key]: String(getChannelValue(key)) }));
  };

  const cancelEdit = (key: string) => {
    setEditing(prev => {
      const { [key]: _omit, ...rest } = prev;
      return rest;
    });
  };

  const saveEdit = async (key: string) => {
    if (!company) return;
    const raw = editing[key] ?? '';
    const value = parseFloat(raw) || 0;
    setSavingKey(key);
    setErrMsg(null);
    try {
      await upsertChannelBalance(company.id, selectedDate, key, value, 'manual');
      setOkMsg('Balance guardado');
      setTimeout(() => setOkMsg(null), 2000);
      cancelEdit(key);
      await loadSnapshots();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Error guardando balance');
    } finally {
      setSavingKey(null);
    }
  };

  // Total consolidado (suma de todos los canales)
  const totalConsolidado = CHANNELS.reduce((sum, c) => sum + getChannelValue(c.key), 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('balances.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('balances.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="px-3 py-2 rounded-lg border border-border bg-card text-sm"
          />
          <button
            onClick={loadSnapshots}
            disabled={loadingSnap}
            className="p-2 rounded-lg border border-border bg-card hover:bg-muted transition-colors disabled:opacity-50"
            title="Recargar"
            aria-label="Recargar"
          >
            <RefreshCw className={`w-4 h-4 ${loadingSnap ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {okMsg && (
        <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-sm">
          {okMsg}
        </div>
      )}
      {errMsg && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
          {errMsg}
        </div>
      )}

      {/* ═══════════ SECTION A: BALANCE ACTUAL DISPONIBLE ═══════════ */}
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50">
            <Wallet className="w-5 h-5 text-blue-500" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{t('balances.availableBalance')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('balances.formulaHint')}
            </p>
          </div>
        </div>

        {currentBalanceRow ? (
          <>
            <div className="text-center py-6 mb-4 bg-muted/30 rounded-lg">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                {currentBalanceRow.label}
              </p>
              <p className={`text-4xl font-bold ${currentBalanceRow.saldoFinal >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {formatCurrency(currentBalanceRow.saldoFinal)}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                {t('balances.accumulatedHint')}
              </p>
            </div>

            {/* Breakdown of where each number comes from */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <div className="p-3 rounded-lg border border-border">
                <p className="text-xs text-muted-foreground">{t('balances.netDeposit')}</p>
                <p className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">
                  +{formatCurrency(currentBalanceRow.netDeposit)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{t('balances.fromMovements')}</p>
              </div>
              <div className="p-3 rounded-lg border border-border">
                <p className="text-xs text-muted-foreground">{t('balances.operatingExpenses')}</p>
                <p className="text-lg font-semibold text-red-600 dark:text-red-400">
                  −{formatCurrency(currentBalanceRow.egresos)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{t('balances.fromExpenses')}</p>
              </div>
              <div className="p-3 rounded-lg border border-border">
                <p className="text-xs text-muted-foreground">{t('balances.amountToDistribute')}</p>
                <p className="text-lg font-semibold text-orange-600 dark:text-orange-400">
                  −{formatCurrency(currentBalanceRow.montoDistribuir)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{t('balances.fromPartners')}</p>
              </div>
              <div className="p-3 rounded-lg border border-border bg-blue-50/50 dark:bg-blue-950/20">
                <p className="text-xs text-muted-foreground">{t('balances.previousMonthBalance')}</p>
                <p className="text-lg font-semibold">
                  {formatCurrency(currentBalanceRow.saldoInicial)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{t('balances.carryOver')}</p>
              </div>
            </div>

            {/* History of all months */}
            <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('balances.period')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('balances.netDeposit')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('balances.operatingExpenses')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('balances.amountToDistribute')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('balances.balanceMonth')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('balances.accumulated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {balanceChain.map((row) => (
                    <tr key={row.periodId} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="py-2 px-3 font-medium">{row.label}</td>
                      <td className="py-2 px-3 text-right text-emerald-600 dark:text-emerald-400">{formatCurrency(row.netDeposit)}</td>
                      <td className="py-2 px-3 text-right text-red-600 dark:text-red-400">{formatCurrency(row.egresos)}</td>
                      <td className="py-2 px-3 text-right text-orange-600 dark:text-orange-400">{formatCurrency(row.montoDistribuir)}</td>
                      <td className={`py-2 px-3 text-right font-medium ${row.balanceMes >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatCurrency(row.balanceMes)}</td>
                      <td className={`py-2 px-3 text-right font-bold ${row.saldoFinal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatCurrency(row.saldoFinal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-center text-muted-foreground py-8">{t('balances.noData')}</p>
        )}
      </Card>

      {/* ═══════════ SECTION B: BALANCES POR CANAL ═══════════ */}
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-violet-50 dark:bg-violet-950/50">
            <Plug className="w-5 h-5 text-violet-500" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{t('balances.byChannel')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('balances.byChannelHint')} — {selectedDate}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          {CHANNELS.map((ch) => {
            const value = getChannelValue(ch.key);
            const isEditing = editing[ch.key] !== undefined;
            const isAuto = ch.type === 'auto';
            const isApi = ch.type === 'api';
            const Icon = ch.icon;

            return (
              <div
                key={ch.key}
                className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {Icon && <Icon className="w-4 h-4 text-muted-foreground shrink-0" />}
                  <div className="min-w-0">
                    <p className="font-medium truncate">{ch.label}</p>
                    <p className="text-xs text-muted-foreground truncate">{ch.description}</p>
                  </div>
                  {isApi && (
                    <span className="hidden sm:inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                      API pendiente
                    </span>
                  )}
                  {isAuto && (
                    <span className="hidden sm:inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                      Automático
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {isEditing ? (
                    <>
                      <input
                        type="number"
                        step="0.01"
                        value={editing[ch.key]}
                        onChange={(e) => setEditing(prev => ({ ...prev, [ch.key]: e.target.value }))}
                        className="w-32 px-2 py-1 rounded border border-border text-sm text-right"
                        autoFocus
                      />
                      <button
                        onClick={() => saveEdit(ch.key)}
                        disabled={savingKey === ch.key}
                        className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 rounded disabled:opacity-50"
                        aria-label="Guardar"
                      >
                        {savingKey === ch.key ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => cancelEdit(ch.key)}
                        className="p-1 text-muted-foreground hover:bg-muted rounded"
                        aria-label="Cancelar"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className={`font-semibold text-base ${value >= 0 ? '' : 'text-red-600 dark:text-red-400'}`}>
                        {formatCurrency(value)}
                      </span>
                      {!isAuto && userCanAdd && (
                        <button
                          onClick={() => startEdit(ch.key)}
                          className="p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded"
                          aria-label="Editar"
                          title={isApi ? 'Ingreso manual (fallback)' : 'Editar balance'}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Total consolidado */}
        <div className="mt-4 pt-4 border-t border-border flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t('balances.totalConsolidated')}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('balances.totalHint')}
            </p>
          </div>
          <p className={`text-2xl font-bold ${totalConsolidado >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {formatCurrency(totalConsolidado)}
          </p>
        </div>
      </Card>
    </div>
  );
}
