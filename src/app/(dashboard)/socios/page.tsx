'use client';

import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { InfoTip } from '@/components/ui/info-tip';
import { GLOSSARY } from '@/lib/glossary';
import { PeriodSelector } from '@/components/period-selector';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { useAuth, canEdit } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
import { useI18n } from '@/lib/i18n';
import { useConfirm } from '@/lib/use-confirm';
import {
  createPartner,
  updatePartner,
  deletePartner,
  updatePeriodReservePct,
  updateAllPeriodsReservePct,
} from '@/lib/supabase/mutations';
import {
  Users, Download, AlertTriangle, TrendingDown, Wallet, Shield,
  PiggyBank, Plus, Pencil, Trash2, X, Check, Settings, ChevronDown,
} from 'lucide-react';

const COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#06B6D4'];

export default function SociosPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const isAdmin = canEdit(user);
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();
  const { periods, partners, partnerDistributions, getPeriodSummary, company, refresh } = useData();

  // ─── Partner management state ───
  const [showPartnerForm, setShowPartnerForm] = useState(false);
  const [editingPartner, setEditingPartner] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPercentage, setFormPercentage] = useState('');
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  // `deleteConfirm` kept for legacy pattern compatibility in the two rows that
  // still reference it (they open the shared useConfirm modal via setter).
  const { confirm, Modal: ConfirmModal } = useConfirm();

  // ─── Reserve edit state ───
  const [showReserveEdit, setShowReserveEdit] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [reserveInput, setReserveInput] = useState('');

  // Get current period info
  const currentPeriod = mode === 'single' ? periods.find(p => p.id === selectedPeriodId) : null;
  const RESERVE_PCT = currentPeriod?.reserve_pct ?? 0.10;

  // Get operating income for current view
  const summary = mode === 'single' ? getPeriodSummary(selectedPeriodId) : null;
  const ingresosNetos = (summary?.operatingIncome
    ? summary.operatingIncome.broker_pnl + summary.operatingIncome.other
    : 0) + (summary?.propFirmNetIncome || 0);
  const egresosNetos = summary?.totalExpenses || 0;

  // Saldo a Favor = Ingresos Netos - Egresos Netos
  const saldoAFavor = ingresosNetos - egresosNetos;

  // ─── Chain calculation: reserve, debt carry, distribution per period ───
  interface PeriodChain {
    ingresosNetos: number;
    egresosNetos: number;
    saldoAFavor: number;
    deudaArrastradaEntrada: number; // debt coming IN from previous month
    reserveThisPeriod: number;
    reserveAccumulated: number;
    deudaArrastradaSalida: number;  // debt going OUT to next month
    montoDistribuir: number;        // actual amount to distribute to partners
  }

  const periodChain = useMemo(() => {
    const chain = new Map<string, PeriodChain>();
    let accReserve = 0;
    let carryDebt = 0; // positive number representing outstanding debt

    for (const period of periods) {
      const pSum = getPeriodSummary(period.id);
      const pIncome = (pSum?.operatingIncome
        ? pSum.operatingIncome.broker_pnl + pSum.operatingIncome.other
        : 0) + (pSum?.propFirmNetIncome || 0);
      const pExpenses = pSum?.totalExpenses || 0;
      const pSaldo = pIncome - pExpenses;
      const pReservePct = period.reserve_pct ?? 0.10;

      const debtIn = carryDebt;

      if (pSaldo <= 0) {
        // Negative month: no reserve, reserve absorbs loss
        const loss = Math.abs(pSaldo);
        const totalLoss = loss + carryDebt;

        if (accReserve >= totalLoss) {
          // Reserve covers everything
          accReserve -= totalLoss;
          carryDebt = 0;
        } else {
          // Reserve doesn't cover all — remainder becomes carried debt
          carryDebt = totalLoss - accReserve;
          accReserve = 0;
        }

        chain.set(period.id, {
          ingresosNetos: pIncome,
          egresosNetos: pExpenses,
          saldoAFavor: pSaldo,
          deudaArrastradaEntrada: debtIn,
          reserveThisPeriod: 0,
          reserveAccumulated: accReserve,
          deudaArrastradaSalida: carryDebt,
          montoDistribuir: 0, // no distribution in negative months
        });
      } else {
        // Positive month: first cover any carried debt
        let available = pSaldo;

        if (carryDebt > 0) {
          if (available >= carryDebt) {
            available -= carryDebt;
            carryDebt = 0;
          } else {
            carryDebt -= available;
            available = 0;
          }
        }

        // From the remaining, calculate reserve and distribution
        const reserve = available > 0 ? available * pReservePct : 0;
        accReserve += reserve;
        const distributable = available > 0 ? available - reserve : 0;

        chain.set(period.id, {
          ingresosNetos: pIncome,
          egresosNetos: pExpenses,
          saldoAFavor: pSaldo,
          deudaArrastradaEntrada: debtIn,
          reserveThisPeriod: reserve,
          reserveAccumulated: accReserve,
          deudaArrastradaSalida: carryDebt,
          montoDistribuir: distributable,
        });
      }
    }

    return chain;
  }, [periods, getPeriodSummary]);

  // Get current period's chain data
  const currentChain = mode === 'single' ? periodChain.get(selectedPeriodId) : null;
  const reserveThisPeriod = currentChain?.reserveThisPeriod ?? 0;
  const accumulatedReserve = currentChain?.reserveAccumulated ?? 0;
  const carryDebt = currentChain?.deudaArrastradaEntrada ?? 0;
  const totalToDistribute = currentChain?.montoDistribuir ?? 0;

  const distributions = mode === 'consolidated'
    ? (() => {
        const allDists = partnerDistributions.filter(d => selectedPeriodIds.includes(d.period_id));
        const byPartner = new Map<string, { id: string; period_id: string; partner_id: string; company_id: string; percentage: number; amount: number }>();
        for (const dist of allDists) {
          const existing = byPartner.get(dist.partner_id);
          if (existing) {
            existing.amount += dist.amount;
          } else {
            byPartner.set(dist.partner_id, { ...dist, id: `cons-${dist.partner_id}`, period_id: 'consolidated' });
          }
        }
        return Array.from(byPartner.values());
      })()
    : partnerDistributions.filter(d => d.period_id === selectedPeriodId);

  // Recalculate distribution amounts so the displayed number always reflects
  // the CURRENT `reserve_pct` and the CURRENT partner percentages, not the
  // stale `amount` column persisted by earlier sessions.
  //
  //  - Single period: amount = montoDistribuir(period) × partner.percentage
  //  - Consolidated:  amount = Σ over selected periods of
  //                              montoDistribuir(period_i) × partner.percentage
  //
  // This keeps historical consolidated months (Mar-2026 and older) coherent
  // with single-period views without rewriting the stored rows.
  const effectiveDistributions = mode === 'single'
    ? distributions.map(d => ({
        ...d,
        amount: totalToDistribute > 0 ? totalToDistribute * d.percentage : 0,
      }))
    : distributions.map(d => {
        const recomputed = selectedPeriodIds.reduce((sum, pid) => {
          const md = periodChain.get(pid)?.montoDistribuir ?? 0;
          return sum + (md > 0 ? md * d.percentage : 0);
        }, 0);
        return { ...d, amount: recomputed };
      });

  const totalDistributed = effectiveDistributions.reduce((sum, d) => sum + d.amount, 0);
  const totalPercentage = effectiveDistributions.reduce((sum, d) => sum + d.percentage, 0);
  const percentageMismatch = Math.abs(totalPercentage - 1) > 0.001;

  // ─── Available percentage for new/edit partner ───
  const usedPercentage = partners.reduce((sum, p) => sum + p.percentage, 0);
  const availableForNew = 1 - usedPercentage;
  const availableForEdit = (partnerId: string) => {
    const other = partners.filter(p => p.id !== partnerId).reduce((sum, p) => sum + p.percentage, 0);
    return 1 - other;
  };

  // ─── Flash messages ───
  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setErrorMsg('');
    setTimeout(() => setSuccessMsg(''), 3000);
  };
  const showError = (msg: string) => {
    setErrorMsg(msg);
    setSuccessMsg('');
    setTimeout(() => setErrorMsg(''), 5000);
  };

  // ─── Partner CRUD handlers ───
  const handleAddPartner = () => {
    setEditingPartner(null);
    setFormName('');
    setFormEmail('');
    setFormPercentage('');
    setShowPartnerForm(true);
  };

  const handleEditPartner = (id: string) => {
    const partner = partners.find(p => p.id === id);
    if (!partner) return;
    setEditingPartner(id);
    setFormName(partner.name);
    setFormEmail(partner.email || '');
    setFormPercentage((partner.percentage * 100).toFixed(1));
    setShowPartnerForm(true);
  };

  const handleSavePartner = async () => {
    const pct = parseFloat(formPercentage) / 100;
    if (!formName.trim()) return;
    if (isNaN(pct) || pct <= 0 || pct > 1) return;

    const maxPct = editingPartner ? availableForEdit(editingPartner) : availableForNew;
    if (pct > maxPct + 0.001) {
      showError(t('partners.maxPercentage', { available: (maxPct * 100).toFixed(1) }));
      return;
    }

    setSaving(true);
    try {
      if (editingPartner) {
        await updatePartner(editingPartner, {
          name: formName.trim(),
          email: formEmail.trim() || null,
          percentage: pct,
        });
        showSuccess(t('partners.updated'));
      } else {
        await createPartner(
          company?.id || '',
          formName.trim(),
          formEmail.trim() || null,
          pct,
        );
        showSuccess(t('partners.created'));
      }
      await refresh();
      setShowPartnerForm(false);
      setEditingPartner(null);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePartner = async (id: string) => {
    setSaving(true);
    try {
      await deletePartner(id);
      await refresh();
      showSuccess(t('partners.deleted'));
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Error');
    } finally {
      setSaving(false);
    }
  };

  // ─── Reserve handlers ───
  const handleOpenReserveEdit = () => {
    setReserveInput(((RESERVE_PCT) * 100).toFixed(1));
    setShowReserveEdit(true);
  };

  const handleSaveReserve = async (applyToAll: boolean) => {
    const pct = parseFloat(reserveInput) / 100;
    if (isNaN(pct) || pct < 0 || pct > 1) return;

    setSaving(true);
    try {
      if (applyToAll) {
        await updateAllPeriodsReservePct(company?.id || '', pct);
      } else if (currentPeriod) {
        await updatePeriodReservePct(currentPeriod.id, pct);
      }
      await refresh();
      showSuccess(t('partners.reserveUpdated'));
      setShowReserveEdit(false);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {Modal2FA}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('partners.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('partners.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto">
          <button
            onClick={() => verify2FA(() => {
              const headers = ['Socio', 'Porcentaje', 'Monto'];
              const rows = effectiveDistributions.map(d => {
                const partner = partners.find(p => p.id === d.partner_id);
                return [partner?.name || '', `${(d.percentage * 100).toFixed(1)}%`, d.amount] as (string | number)[];
              });
              rows.push(['Total', '100%', totalDistributed]);
              downloadCSV('socios.csv', headers, rows);
            })}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors flex-shrink-0"
            title={t('common.csv')}
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">{t('common.csv')}</span>
          </button>
          <PeriodSelector />
        </div>
      </div>

      {/* Success / Error messages */}
      {successMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 text-sm font-medium" aria-live="polite">
          <Check className="w-4 h-4" />
          {successMsg}
        </div>
      )}
      {errorMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400 text-sm font-medium" aria-live="polite">
          <AlertTriangle className="w-4 h-4" />
          {errorMsg}
        </div>
      )}

      {/* Percentage warning */}
      {percentageMismatch && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-sm font-medium">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {t('partners.percentageWarning', { pct: (totalPercentage * 100).toFixed(1) })}
        </div>
      )}

      {/* Summary cards */}
      {/* Row 1: Ingresos, Egresos, Saldo a Favor */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <StatCard
          label={t('partners.netIncome')}
          value={formatCurrency(ingresosNetos)}
          icon={Users}
          tone={ingresosNetos >= 0 ? 'positive' : 'negative'}
        />
        <StatCard
          label={t('partners.egresosNetos')}
          value={formatCurrency(egresosNetos)}
          icon={TrendingDown}
          tone="negative"
        />
        <StatCard
          label={<>{t('partners.saldoFavor')} <InfoTip text={GLOSSARY.netoOperativo} /></>}
          value={formatCurrency(saldoAFavor)}
          icon={Wallet}
          tone={saldoAFavor >= 0 ? 'positive' : 'negative'}
          hint="Ingresos Operativos − Egresos Operativos"
        />
      </div>

      {/* Row 2: Reserva del Período, Reserva Acumulada, Deuda Arrastrada (if any) */}
      <div className={`grid grid-cols-2 gap-3 sm:gap-4 ${carryDebt > 0 ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}>
        <Card>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-50 dark:bg-orange-950/50">
                <Shield className="w-5 h-5 text-orange-500" />
              </div>
              <p className="text-sm text-muted-foreground inline-flex items-center gap-1.5">
                {t('partners.reserveThisPeriod')}
                <InfoTip text={GLOSSARY.reserve} />
              </p>
            </div>
            {isAdmin && mode === 'single' && (
              <button
                onClick={handleOpenReserveEdit}
                className="p-1.5 rounded-md hover:bg-muted transition-colors"
                title={t('partners.editReserve')}
              >
                <Settings className="w-4 h-4 text-muted-foreground" />
              </button>
            )}
          </div>
          <p className="text-2xl font-bold text-orange-600">{formatCurrency(reserveThisPeriod)}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {reserveThisPeriod > 0
              ? `${(RESERVE_PCT * 100).toFixed(1)}% del saldo disponible`
              : saldoAFavor <= 0 ? 'Mes negativo — sin reserva' : 'Cubriendo deuda arrastrada'}
          </p>
        </Card>

        <StatCard
          label={t('partners.reserveAccumulated')}
          value={formatCurrency(accumulatedReserve)}
          icon={PiggyBank}
          tone="warning"
          hint="Fondo acumulado hasta este período"
        />

        {carryDebt > 0 && (
          <StatCard
            label={<>Deuda Arrastrada <InfoTip text={GLOSSARY.deudaArrastrada} /></>}
            value={formatCurrency(-carryDebt)}
            icon={AlertTriangle}
            tone="negative"
            hint="Se descuenta antes de distribuir"
          />
        )}

        <StatCard
          label={<>{t('partners.distributableAmount')} <InfoTip text={GLOSSARY.montoDistribuir} /></>}
          value={formatCurrency(totalToDistribute)}
          icon={Users}
          tone={totalToDistribute > 0 ? 'positive' : 'neutral'}
          hint={
            totalToDistribute > 0
              ? `${(100 - RESERVE_PCT * 100).toFixed(1)}% del saldo disponible`
              : 'Sin distribución este período'
          }
        />
      </div>

      {/* Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Table */}
        <Card>
          <div className="flex items-center justify-between mb-4 gap-2">
            <h2 className="text-base sm:text-lg font-semibold">{t('partners.distribution')}</h2>
            {isAdmin && (
              <button
                onClick={handleAddPartner}
                className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--color-primary)] text-white hover:opacity-90 transition-opacity flex-shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('partners.addPartner')}
              </button>
            )}
          </div>
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <table className="w-full text-sm min-w-[360px]">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-2 sm:px-3 text-muted-foreground font-medium">{t('partners.name')}</th>
                <th className="text-right py-2 px-2 sm:px-3 text-muted-foreground font-medium">%</th>
                <th className="text-right py-2 px-2 sm:px-3 text-muted-foreground font-medium">{t('partners.amount')}</th>
                {isAdmin && <th className="text-center py-2 px-1 sm:px-3 text-muted-foreground font-medium w-16 sm:w-20"></th>}
              </tr>
            </thead>
            <tbody>
              {effectiveDistributions.map((dist, i) => {
                const partner = partners.find(p => p.id === dist.partner_id);
                return (
                  <tr key={dist.id} className="border-b border-border/50 hover:bg-muted/50">
                    <td className="py-3 px-2 sm:px-3">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: COLORS[i % COLORS.length] }}
                        />
                        <div className="min-w-0">
                          <span className="font-medium truncate block">{partner?.name || '—'}</span>
                          {partner?.email && (
                            <span className="text-xs text-muted-foreground hidden sm:block truncate">{partner.email}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-2 sm:px-3 text-right font-medium whitespace-nowrap">{formatPercent(dist.percentage)}</td>
                    <td className={`py-3 px-2 sm:px-3 text-right font-bold whitespace-nowrap ${dist.amount < 0 ? 'text-red-600' : ''}`}>
                      {formatCurrency(dist.amount)}
                    </td>
                    {isAdmin && (
                      <td className="py-3 px-1 sm:px-3 text-center">
                        <div className="flex justify-center gap-0.5 sm:gap-1">
                          <button
                            onClick={() => handleEditPartner(dist.partner_id)}
                            className="p-1 rounded hover:bg-muted transition-colors"
                            title={t('partners.editPartner')}
                          >
                            <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                          </button>
                          <button
                            onClick={() => confirm(
                              t('partners.deleteConfirm', { name: partner?.name || '' }),
                              () => handleDeletePartner(dist.partner_id),
                              { tone: 'danger', title: t('partners.deletePartner'), confirmLabel: t('partners.deletePartner') },
                            )}
                            className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                            title={t('partners.deletePartner')}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-red-500" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
              {/* Show partners not in distributions */}
              {partners
                .filter(p => !effectiveDistributions.some(d => d.partner_id === p.id))
                .map((partner, i) => (
                  <tr key={partner.id} className="border-b border-border/50 hover:bg-muted/50 opacity-60">
                    <td className="py-3 px-2 sm:px-3">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: COLORS[(effectiveDistributions.length + i) % COLORS.length] }}
                        />
                        <div className="min-w-0">
                          <span className="font-medium truncate block">{partner.name}</span>
                          {partner.email && (
                            <span className="text-xs text-muted-foreground hidden sm:block truncate">{partner.email}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-2 sm:px-3 text-right font-medium whitespace-nowrap">{formatPercent(partner.percentage)}</td>
                    <td className="py-3 px-2 sm:px-3 text-right font-bold">—</td>
                    {isAdmin && (
                      <td className="py-3 px-1 sm:px-3 text-center">
                        <div className="flex justify-center gap-0.5 sm:gap-1">
                          <button
                            onClick={() => handleEditPartner(partner.id)}
                            className="p-1 rounded hover:bg-muted transition-colors"
                            title={t('partners.editPartner')}
                          >
                            <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                          </button>
                          <button
                            onClick={() => confirm(
                              t('partners.deleteConfirm', { name: partner.name }),
                              () => handleDeletePartner(partner.id),
                              { tone: 'danger', title: t('partners.deletePartner'), confirmLabel: t('partners.deletePartner') },
                            )}
                            className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                            title={t('partners.deletePartner')}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-red-500" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
            </tbody>
            <tfoot>
              <tr className="font-bold bg-muted/50">
                <td className="py-3 px-2 sm:px-3">Total</td>
                <td className="py-3 px-2 sm:px-3 text-right">100%</td>
                <td className={`py-3 px-2 sm:px-3 text-right whitespace-nowrap ${totalDistributed < 0 ? 'text-red-600' : ''}`}>
                  {formatCurrency(totalDistributed)}
                </td>
                {isAdmin && <td />}
              </tr>
            </tfoot>
          </table>
          </div>
        </Card>

        {/* Visual bar chart */}
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('partners.participation')}</h2>
          <div className="space-y-4">
            {effectiveDistributions.map((dist, i) => {
              const partner = partners.find(p => p.id === dist.partner_id);
              return (
                <div key={dist.id}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium">{partner?.name}</span>
                    <span className="text-muted-foreground">{formatPercent(dist.percentage)}</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-4">
                    <div
                      className="h-4 rounded-full transition-all duration-500"
                      style={{
                        width: `${dist.percentage * 100}%`,
                        backgroundColor: COLORS[i % COLORS.length],
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Historical summary — collapsible */}
          <div className="mt-8">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${showHistory ? 'rotate-0' : '-rotate-90'}`} />
              {t('partners.history')}
            </button>
            {showHistory && (
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-1.5 px-2">{t('partners.period')}</th>
                    {partners.map(p => (
                      <th key={p.id} className="text-right py-1.5 px-2">{p.name}</th>
                    ))}
                    <th className="text-right py-1.5 px-2">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((period) => {
                    const dists = partnerDistributions.filter(d => d.period_id === period.id);
                    const pChain = periodChain.get(period.id);
                    const pDistributable = pChain?.montoDistribuir ?? 0;

                    const effectiveDists = dists.map(d => ({
                      ...d,
                      amount: pDistributable > 0 ? pDistributable * d.percentage : 0,
                    }));
                    const total = effectiveDists.reduce((s, d) => s + d.amount, 0);

                    return (
                      <tr key={period.id} className={`border-b border-border/30 ${period.id === selectedPeriodId ? 'bg-blue-50 dark:bg-blue-950/50' : ''}`}>
                        <td className="py-1.5 px-2 font-medium">
                          <div className="flex items-center gap-1">
                            {period.label}
                            {(pChain?.deudaArrastradaEntrada ?? 0) > 0 && (
                              <span className="text-red-500" title={`Deuda: ${formatCurrency(-(pChain?.deudaArrastradaEntrada ?? 0))}`}>*</span>
                            )}
                          </div>
                        </td>
                        {partners.map(p => {
                          const d = effectiveDists.find(dd => dd.partner_id === p.id);
                          return (
                            <td key={p.id} className="py-1.5 px-2 text-right">
                              {formatCurrency(d?.amount || 0)}
                            </td>
                          );
                        })}
                        <td className="py-1.5 px-2 text-right font-bold">
                          {formatCurrency(total)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border font-bold bg-muted/50">
                    <td className="py-2 px-2">Total</td>
                    {partners.map(p => {
                      const partnerTotal = periods.reduce((sum, period) => {
                        const pChain = periodChain.get(period.id);
                        const pDist = pChain?.montoDistribuir ?? 0;
                        if (pDist <= 0) return sum;
                        const dist = partnerDistributions.find(d => d.period_id === period.id && d.partner_id === p.id);
                        return sum + (dist ? pDist * dist.percentage : 0);
                      }, 0);
                      return (
                        <td key={p.id} className="py-2 px-2 text-right">
                          {formatCurrency(partnerTotal)}
                        </td>
                      );
                    })}
                    <td className="py-2 px-2 text-right">
                      {formatCurrency(periods.reduce((sum, period) => {
                        const pChain = periodChain.get(period.id);
                        const md = pChain?.montoDistribuir ?? 0;
                        return sum + (md > 0 ? md : 0);
                      }, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            )}
          </div>
        </Card>
      </div>

      {/* ─── Partner Form Modal ─── */}
      {showPartnerForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl shadow-xl p-6 max-w-md mx-4 w-full">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">
                {editingPartner ? t('partners.editPartner') : t('partners.addPartner')}
              </h3>
              <button onClick={() => setShowPartnerForm(false)} className="p-1 rounded hover:bg-muted">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">{t('partners.name')}</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  placeholder="Nombre del socio"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">{t('partners.email')}</label>
                <input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  placeholder="email@ejemplo.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  {t('partners.percentage')} (%)
                  <span className="text-muted-foreground font-normal ml-2">
                    Max: {((editingPartner ? availableForEdit(editingPartner) : availableForNew) * 100).toFixed(1)}%
                  </span>
                </label>
                <input
                  type="number"
                  value={formPercentage}
                  onChange={(e) => setFormPercentage(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  placeholder="25.0"
                  min="0.1"
                  max={(((editingPartner ? availableForEdit(editingPartner) : availableForNew)) * 100).toFixed(1)}
                  step="0.1"
                />
              </div>
            </div>

            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={() => setShowPartnerForm(false)}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                {t('partners.cancel')}
              </button>
              <button
                onClick={handleSavePartner}
                disabled={saving || !formName.trim() || !formPercentage}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {saving ? 'Guardando...' : t('partners.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {ConfirmModal}

      {/* ─── Reserve Edit Modal ─── */}
      {showReserveEdit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl shadow-xl p-6 max-w-sm mx-4 w-full">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">{t('partners.reserveTitle')}</h3>
              <button onClick={() => setShowReserveEdit(false)} className="p-1 rounded hover:bg-muted">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium mb-1">% Reserva</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={reserveInput}
                  onChange={(e) => setReserveInput(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  min="0"
                  max="100"
                  step="0.5"
                />
                <span className="text-sm font-medium text-muted-foreground">%</span>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Periodo actual: <strong>{currentPeriod?.label}</strong> ({(RESERVE_PCT * 100).toFixed(1)}%)
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <button
                onClick={() => handleSaveReserve(false)}
                disabled={saving}
                className="w-full px-4 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {saving ? 'Guardando...' : t('partners.reserveApplyThis')}
              </button>
              <button
                onClick={() => handleSaveReserve(true)}
                disabled={saving}
                className="w-full px-4 py-2.5 rounded-lg border border-[var(--color-primary)] text-[var(--color-primary)] text-sm font-medium hover:bg-[var(--color-primary)]/10 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Guardando...' : t('partners.reserveApplyAll')}
              </button>
              <button
                onClick={() => setShowReserveEdit(false)}
                className="w-full px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                {t('partners.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
