'use client';

import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { PeriodSelector } from '@/components/period-selector';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { useAuth, canEdit } from '@/lib/auth-context';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
import { useI18n } from '@/lib/i18n';
import {
  createPartner,
  updatePartner,
  deletePartner,
  updatePeriodReservePct,
  updateAllPeriodsReservePct,
} from '@/lib/supabase/mutations';
import {
  Users, Download, AlertTriangle, TrendingDown, Wallet, Shield,
  PiggyBank, Plus, Pencil, Trash2, X, Check, Settings,
} from 'lucide-react';

const COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#06B6D4'];

export default function SociosPage() {
  const { t } = useI18n();
  const { user } = useAuth();
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
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);

  // ─── Reserve edit state ───
  const [showReserveEdit, setShowReserveEdit] = useState(false);
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

  // Respaldo = reserve_pct del saldo a favor (solo si positivo)
  const reserveThisPeriod = saldoAFavor > 0 ? saldoAFavor * RESERVE_PCT : 0;

  // Compute accumulated reserve across all periods
  const accumulatedReserve = useMemo(() => {
    let accumulated = 0;
    for (const period of periods) {
      const pSummary = getPeriodSummary(period.id);
      const pIncome = (pSummary?.operatingIncome
        ? pSummary.operatingIncome.broker_pnl + pSummary.operatingIncome.other
        : 0) + (pSummary?.propFirmNetIncome || 0);
      const pExpenses = pSummary?.totalExpenses || 0;
      const pSaldo = pIncome - pExpenses;
      const pReservePct = period.reserve_pct ?? 0.10;
      accumulated += pSaldo > 0 ? pSaldo * pReservePct : 0;
      if (period.id === (mode === 'single' ? selectedPeriodId : null)) break;
    }
    return accumulated;
  }, [periods, getPeriodSummary, mode, selectedPeriodId]);

  // Monto a Distribuir = Saldo a Favor - Respaldo
  const totalToDistribute = saldoAFavor > 0
    ? saldoAFavor - reserveThisPeriod
    : saldoAFavor;

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

  // Recalculate distribution amounts based on totalToDistribute
  const effectiveDistributions = mode === 'single'
    ? distributions.map(d => ({
        ...d,
        amount: totalToDistribute * d.percentage,
      }))
    : distributions;

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
      setDeleteConfirm(null);
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('partners.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('partners.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const headers = ['Socio', 'Porcentaje', 'Monto'];
              const rows = effectiveDistributions.map(d => {
                const partner = partners.find(p => p.id === d.partner_id);
                return [partner?.name || '', `${(d.percentage * 100).toFixed(1)}%`, d.amount] as (string | number)[];
              });
              rows.push(['Total', '100%', totalDistributed]);
              downloadCSV('socios.csv', headers, rows);
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
            title={t('common.csv')}
          >
            <Download className="w-4 h-4" />
            {t('common.csv')}
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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-violet-50 dark:bg-violet-950/50">
              <Users className="w-5 h-5 text-violet-500" />
            </div>
            <p className="text-sm text-muted-foreground">{t('partners.netIncome')}</p>
          </div>
          <p className={`text-2xl font-bold ${ingresosNetos >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {formatCurrency(ingresosNetos)}
          </p>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950/50">
              <TrendingDown className="w-5 h-5 text-red-500" />
            </div>
            <p className="text-sm text-muted-foreground">{t('partners.egresosNetos')}</p>
          </div>
          <p className="text-2xl font-bold text-red-600">
            {formatCurrency(egresosNetos)}
          </p>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/50">
              <Wallet className="w-5 h-5 text-amber-500" />
            </div>
            <p className="text-sm text-muted-foreground">{t('partners.saldoFavor')}</p>
          </div>
          <p className={`text-2xl font-bold ${saldoAFavor >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {formatCurrency(saldoAFavor)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">Ingresos Netos - Egresos Netos</p>
        </Card>
      </div>

      {/* Row 2: Respaldo, Respaldo Acumulado, Monto a Distribuir */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-50 dark:bg-orange-950/50">
                <Shield className="w-5 h-5 text-orange-500" />
              </div>
              <p className="text-sm text-muted-foreground">{t('partners.reserveThisPeriod')}</p>
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
          <p className="text-xs text-muted-foreground mt-1">{(RESERVE_PCT * 100).toFixed(1)}% del Saldo a Favor</p>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/50">
              <PiggyBank className="w-5 h-5 text-amber-600" />
            </div>
            <p className="text-sm text-muted-foreground">{t('partners.reserveAccumulated')}</p>
          </div>
          <p className="text-2xl font-bold text-amber-600">{formatCurrency(accumulatedReserve)}</p>
          <p className="text-xs text-muted-foreground mt-1">Acumulado historico</p>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50">
              <Users className="w-5 h-5 text-emerald-500" />
            </div>
            <p className="text-sm text-muted-foreground">{t('partners.distributableAmount')}</p>
          </div>
          <p className={`text-2xl font-bold ${totalToDistribute >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {formatCurrency(totalToDistribute)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">{(100 - RESERVE_PCT * 100).toFixed(1)}% del Saldo a Favor</p>
        </Card>
      </div>

      {/* Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Table */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">{t('partners.distribution')}</h2>
            {isAdmin && (
              <button
                onClick={handleAddPartner}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--color-primary)] text-white hover:opacity-90 transition-opacity"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('partners.addPartner')}
              </button>
            )}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('partners.name')}</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">%</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('partners.amount')}</th>
                {isAdmin && <th className="text-center py-2 px-3 text-muted-foreground font-medium w-20"></th>}
              </tr>
            </thead>
            <tbody>
              {effectiveDistributions.map((dist, i) => {
                const partner = partners.find(p => p.id === dist.partner_id);
                return (
                  <tr key={dist.id} className="border-b border-border/50 hover:bg-muted/50">
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: COLORS[i % COLORS.length] }}
                        />
                        <div>
                          <span className="font-medium">{partner?.name || '—'}</span>
                          {partner?.email && (
                            <span className="text-xs text-muted-foreground ml-2">{partner.email}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right font-medium">{formatPercent(dist.percentage)}</td>
                    <td className={`py-3 px-3 text-right font-bold ${dist.amount < 0 ? 'text-red-600' : ''}`}>
                      {formatCurrency(dist.amount)}
                    </td>
                    {isAdmin && (
                      <td className="py-3 px-3 text-center">
                        <div className="flex justify-center gap-1">
                          <button
                            onClick={() => handleEditPartner(dist.partner_id)}
                            className="p-1 rounded hover:bg-muted transition-colors"
                            title={t('partners.editPartner')}
                          >
                            <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                          </button>
                          <button
                            onClick={() => setDeleteConfirm({ id: dist.partner_id, name: partner?.name || '' })}
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
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: COLORS[(effectiveDistributions.length + i) % COLORS.length] }}
                        />
                        <div>
                          <span className="font-medium">{partner.name}</span>
                          {partner.email && (
                            <span className="text-xs text-muted-foreground ml-2">{partner.email}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right font-medium">{formatPercent(partner.percentage)}</td>
                    <td className="py-3 px-3 text-right font-bold">—</td>
                    {isAdmin && (
                      <td className="py-3 px-3 text-center">
                        <div className="flex justify-center gap-1">
                          <button
                            onClick={() => handleEditPartner(partner.id)}
                            className="p-1 rounded hover:bg-muted transition-colors"
                            title={t('partners.editPartner')}
                          >
                            <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                          </button>
                          <button
                            onClick={() => setDeleteConfirm({ id: partner.id, name: partner.name })}
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
                <td className="py-3 px-3">Total</td>
                <td className="py-3 px-3 text-right">100%</td>
                <td className={`py-3 px-3 text-right ${totalDistributed < 0 ? 'text-red-600' : ''}`}>
                  {formatCurrency(totalDistributed)}
                </td>
                {isAdmin && <td />}
              </tr>
            </tfoot>
          </table>
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

          {/* Historical summary */}
          <div className="mt-8">
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">{t('partners.history')}</h3>
            <div className="overflow-x-auto">
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
                    const pSum = getPeriodSummary(period.id);
                    const pIncome = (pSum?.operatingIncome
                      ? pSum.operatingIncome.broker_pnl + pSum.operatingIncome.other
                      : 0) + (pSum?.propFirmNetIncome || 0);
                    const pExpenses = pSum?.totalExpenses || 0;
                    const pSaldo = pIncome - pExpenses;
                    const pReservePct = period.reserve_pct ?? 0.10;
                    const pReserve = pSaldo > 0 ? pSaldo * pReservePct : 0;
                    const pDistributable = pSaldo > 0 ? pSaldo - pReserve : pSaldo;

                    const effectiveDists = dists.map(d => ({ ...d, amount: pDistributable * d.percentage }));
                    const total = effectiveDists.reduce((s, d) => s + d.amount, 0);

                    return (
                      <tr key={period.id} className={`border-b border-border/30 ${period.id === selectedPeriodId ? 'bg-blue-50 dark:bg-blue-950/50' : ''}`}>
                        <td className="py-1.5 px-2 font-medium">{period.label}</td>
                        {partners.map(p => {
                          const d = effectiveDists.find(dd => dd.partner_id === p.id);
                          return (
                            <td key={p.id} className={`py-1.5 px-2 text-right ${(d?.amount || 0) < 0 ? 'text-red-600' : ''}`}>
                              {formatCurrency(d?.amount || 0)}
                            </td>
                          );
                        })}
                        <td className={`py-1.5 px-2 text-right font-bold ${total < 0 ? 'text-red-600' : ''}`}>
                          {formatCurrency(total)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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

      {/* ─── Delete Confirmation Modal ─── */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl shadow-xl p-6 max-w-md mx-4">
            <h3 className="text-lg font-semibold mb-2">{t('partners.deletePartner')}</h3>
            <p className="text-sm text-muted-foreground mb-6">
              {t('partners.deleteConfirm', { name: deleteConfirm.name })}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                {t('partners.cancel')}
              </button>
              <button
                onClick={() => handleDeletePartner(deleteConfirm.id)}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Eliminando...' : t('partners.deletePartner')}
              </button>
            </div>
          </div>
        </div>
      )}

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
              <label className="block text-sm font-medium mb-1">% Respaldo</label>
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
