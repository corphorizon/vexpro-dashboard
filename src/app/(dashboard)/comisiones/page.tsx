'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { useData } from '@/lib/data-context';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { formatCurrency, cn } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
import { generateCommissionPDF, generateIndividualPDF } from '@/lib/pdf-export';
import { useExport2FA } from '@/components/verify-2fa-modal';
import {
  calculateCommission,
  calculateGroupSummary,
  calculateSalaryFromND,
  calculateHeadSalaryFromND,
  calculateBdmPctFromND,
  getAccumulatedIn,
  SALARY_TIERS,
  HEAD_SALARY_TIERS,
  BDM_PCT_TIERS,
  type CommissionCalcResult,
} from '@/lib/commission-calculator';
import { upsertCommissionEntries, type CommissionEntryRow } from '@/lib/supabase/mutations';
import {
  Calculator,
  Save,
  Download,
  ChevronLeft,
  ChevronRight,
  CheckCircle,
  AlertCircle,
  Info,
  UserCircle,
  Users,
  BarChart3,
  FileText,
  FileSpreadsheet,
  ChevronDown,
} from 'lucide-react';

const ROLE_BADGE: Record<string, string> = {
  sales_manager: 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400',
  head: 'bg-violet-50 dark:bg-violet-950/50 text-violet-700 dark:text-violet-400',
  bdm: 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400',
};
const ROLE_LABEL: Record<string, string> = { sales_manager: 'Sales Manager', head: 'HEAD', bdm: 'BDM' };

type Tab = 'teams' | 'individual' | 'history';

// ═══════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════

export default function ComisionesPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const {
    company,
    periods,
    commercialProfiles,
    monthlyResults,
    getProfilesByHead,
    getPreviousPeriodResults,
    refresh,
    refreshCommissions,
  } = useData();

  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>((searchParams.get('tab') as Tab) || 'teams');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // ─── Shared: Periods ───
  const sortedPeriods = useMemo(
    () => [...periods].sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month)),
    [periods],
  );

  // Restore period from URL param if available
  const savedPeriodId = searchParams.get('period');
  const initialPeriodIdx = savedPeriodId
    ? Math.max(0, sortedPeriods.findIndex((p) => p.id === savedPeriodId))
    : Math.max(0, sortedPeriods.length - 1);
  const [periodIdx, setPeriodIdx] = useState(initialPeriodIdx);
  const selectedPeriod = sortedPeriods[periodIdx] ?? null;

  const existingResults = useMemo(() => {
    if (!selectedPeriod) return [];
    return monthlyResults.filter((r) => r.period_id === selectedPeriod.id);
  }, [selectedPeriod, monthlyResults]);

  const navigatePeriod = (d: -1 | 1) => setPeriodIdx((p) => Math.max(0, Math.min(sortedPeriods.length - 1, p + d)));

  // ═══════════════════════════════════════════════════════════
  // TAB: TEAMS (HEAD + BDMs with differential)
  // ═══════════════════════════════════════════════════════════

  const heads = useMemo(() => {
    const list = commercialProfiles.filter((p) => p.role === 'head' || p.role === 'sales_manager' || commercialProfiles.some((sub) => sub.head_id === p.id));
    const roleOrder: Record<string, number> = { sales_manager: 0, head: 1, bdm: 2 };
    return list.sort((a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9));
  }, [commercialProfiles]);

  const savedHeadId = searchParams.get('head');
  const [selectedHeadId, setSelectedHeadId] = useState<string>(savedHeadId || (heads[0]?.id ?? ''));

  // previousResults is defined after headProfile (see below line ~175)

  // SHARED ND inputs — one Map for all profiles, synced between tabs
  const [ndInputs, setNdInputs] = useState<Map<string, number>>(new Map());
  // Store raw string for display (allows empty field + typing negatives)
  const [ndRawInputs, setNdRawInputs] = useState<Map<string, string>>(new Map());

  // Seed ND inputs from saved data when period changes
  useEffect(() => {
    if (!selectedPeriod) return;
    const results = monthlyResults.filter((r) => r.period_id === selectedPeriod.id);
    const m = new Map<string, number>();
    for (const p of commercialProfiles) {
      // Buscar el registro que corresponde al grupo actual (head_id = selectedHeadId)
      // Así no se confunde con registros del mismo usuario en otros grupos
      const ex = tab === 'individual'
        ? results.find((r) => r.profile_id === p.id && r.net_deposit_current !== 0 && r.net_deposit_current !== null)
          ?? results.find((r) => r.profile_id === p.id)
        : results.find((r) => r.profile_id === p.id && r.head_id === selectedHeadId);
      // Fallback al primer registro si no hay uno con head_id (datos anteriores al fix)
      // If this profile is the currently selected HEAD and has own team + parent,
      // load their PERSONAL ND from net_deposit_accumulated (not net_deposit_current)
      // net_deposit_current belongs to the parent group context
      const isCurrentHead = p.id === selectedHeadId;
      const hasOwnTeam = commercialProfiles.some((sub) => sub.head_id === p.id && sub.status === 'active');
      if (isCurrentHead && hasOwnTeam && p.head_id) {
        // Buscar el registro del HEAD en su PROPIO grupo (head_id = selectedHeadId)
        // NO el del grupo padre
        const ownGroupResult = monthlyResults.find(
          (r) => r.profile_id === p.id
            && r.period_id === selectedPeriod.id
            && r.head_id === selectedHeadId
        );
        m.set(p.id, ownGroupResult?.net_deposit_accumulated ?? 0);
      } else {
        m.set(p.id, ex?.net_deposit_current ?? 0);
      }
    }
    setNdInputs(m);
    // NO limpiar ndRawInputs aquí — se limpia en un effect separado
    // para preservar lo que el usuario está editando después de un refresh
  }, [commercialProfiles, selectedPeriod, monthlyResults, selectedHeadId, tab]);

  // Limpiar raw inputs solo cuando cambia el período o el head seleccionado
  useEffect(() => {
    setNdRawInputs(new Map());
  }, [selectedPeriod?.id, selectedHeadId]);

  const handleNdChange = useCallback((id: string, v: string) => {
    setNdRawInputs((prev) => { const n = new Map(prev); n.set(id, v); return n; });
    const num = v === '' || v === '-' ? 0 : parseFloat(v);
    setNdInputs((prev) => { const n = new Map(prev); n.set(id, isNaN(num) ? 0 : num); return n; });
  }, []);

  const getNdDisplay = useCallback((id: string): string => {
    const raw = ndRawInputs.get(id);
    if (raw !== undefined) return raw;
    return (ndInputs.get(id) ?? 0).toString();
  }, [ndRawInputs, ndInputs]);

  useEffect(() => { if (!selectedHeadId && heads.length > 0) setSelectedHeadId(heads[0].id); }, [heads, selectedHeadId]);

  const teamProfiles = useMemo(() => {
    if (!selectedHeadId) return [];
    const head = commercialProfiles.find((p) => p.id === selectedHeadId);
    if (!head) return [];
    const subs = getProfilesByHead(selectedHeadId).filter((p) => p.status === 'active' && p.id !== selectedHeadId);
    return [head, ...subs];
  }, [selectedHeadId, commercialProfiles, getProfilesByHead]);

  // HEAD profile
  const headProfile = teamProfiles[0] ?? null;
  const headPct = headProfile?.net_deposit_pct ?? 0;
  const extraPct = headProfile?.extra_pct ?? 0;

  const headHasParent = !!(headProfile?.head_id);

  const previousResults = useMemo(() => {
    if (!selectedPeriod || !selectedHeadId) return [];
    const allPrevious = getPreviousPeriodResults(selectedPeriod.id);
    return allPrevious.filter(
      (r) => r.head_id === selectedHeadId
    );
  }, [selectedPeriod, selectedHeadId, getPreviousPeriodResults]);

  const previousResultsAll = useMemo(() => {
    if (!selectedPeriod) return [];
    return getPreviousPeriodResults(selectedPeriod.id);
  }, [selectedPeriod, getPreviousPeriodResults]);

  // HEAD's own ND commission — uses their personal ND from ndInputs
  // When HEAD has parent, accumulated is from their OWN group context (stored in division field of previous period)
  // not from the parent's accumulated_out
  const headOwnCalc = useMemo((): CommissionCalcResult | null => {
    if (!headProfile) return null;
    const nd = ndInputs.get(headProfile.id) ?? 0;
    let accIn = 0;
    if (headHasParent) {
      const prevResult = previousResults.find((r) => r.profile_id === headProfile.id);
      if (prevResult) {
        accIn = prevResult.accumulated_out ?? 0;
      }
    } else {
      accIn = getAccumulatedIn(previousResults, headProfile.id);
    }
    const calc = calculateCommission(nd, accIn, headPct);
    return { profileId: headProfile.id, commissionPct: headPct, salary: 0, ...calc };
  }, [headProfile, ndInputs, previousResults, headPct, headHasParent]);

  // BDM rows — commission calculated at the DIFFERENTIAL rate (what HEAD earns from each BDM)
  const bdmCalcs = useMemo((): (CommissionCalcResult & { bdmOwnPct: number; diffPct: number })[] => {
    const bdms = teamProfiles.filter((_, i) => i > 0);
    return bdms.map((profile) => {
      const nd = ndInputs.get(profile.id) ?? 0;
      const accIn = getAccumulatedIn(previousResults, profile.id);
      // Dynamic BDM pct tiers only apply to actual BDMs, not sub-HEADs
      const isSubHead = profile.role === 'head' || profile.role === 'sales_manager'
        || commercialProfiles.some((sub) => sub.head_id === profile.id && sub.status === 'active');
      const bdmOwnPct = isSubHead
        ? (profile.net_deposit_pct ?? 0)
        : calculateBdmPctFromND(nd, profile.net_deposit_pct ?? 0);
      const naturalDiff = headPct - bdmOwnPct;
      // Extra % only applies when natural differential is 0 (same percentage)
      const diffPct = naturalDiff === 0 ? extraPct : naturalDiff;
      const calc = calculateCommission(nd, accIn, diffPct);
      const bdmSalary = profile.fixed_salary ? (profile.salary ?? 0) : calculateSalaryFromND(nd);
      return { profileId: profile.id, commissionPct: diffPct, bdmOwnPct, diffPct, salary: bdmSalary, ...calc };
    });
  }, [teamProfiles, ndInputs, previousResults, headPct, extraPct]);

  // HEAD differential total (sum of all BDM differential commissions)
  const headDiff = useMemo(() => {
    const totalDifferential = bdmCalcs.reduce((s, c) => s + c.commission, 0);
    const totalRealPayment = bdmCalcs.reduce((s, c) => s + c.realPayment, 0);
    return { totalDifferential, totalRealPayment };
  }, [bdmCalcs]);

  // Team totals — sum of ALL members including HEAD
  const teamTotalND = useMemo(() => {
    let total = 0;
    for (const p of teamProfiles) total += ndInputs.get(p.id) ?? 0;
    return total;
  }, [teamProfiles, ndInputs]);

  const autoSalary = useMemo(() => {
    if (headProfile?.fixed_salary) return headProfile.salary ?? 0;
    return calculateHeadSalaryFromND(teamTotalND);
  }, [teamTotalND, headProfile]);

  // Validation: if this HEAD belongs to a parent group, check that team total matches
  // what was entered for them in the parent's group
  const teamNdValidation = useMemo(() => {
    if (!headProfile || !headProfile.head_id || !selectedPeriod) return null;
    // Find what was saved for this HEAD in the parent's context
    const savedResult = existingResults.find((r) => r.profile_id === headProfile.id);
    if (!savedResult || savedResult.net_deposit_current === 0) return null;
    const expectedTotal = savedResult.net_deposit_current;
    if (teamTotalND !== 0 && Math.abs(teamTotalND - expectedTotal) > 0.01) {
      const parentProfile = commercialProfiles.find((p) => p.id === headProfile.head_id);
      return {
        parentName: parentProfile?.name ?? '',
        expected: expectedTotal,
        actual: teamTotalND,
      };
    }
    return null;
  }, [headProfile, selectedPeriod, existingResults, teamTotalND, commercialProfiles]);

  const teamSummary = useMemo(() => {
    // bdmCalcs already uses differential % — that IS what the HEAD earns from BDMs
    // So headDiff.totalRealPayment === bdmTotal (same data, no double count)
    const diffTotal = bdmCalcs.reduce((s, c) => s + c.realPayment, 0);
    const headOwnPayment = headOwnCalc?.realPayment ?? 0;
    const totalPayment = headOwnPayment + diffTotal;
    return {
      diffTotal,
      headOwnPayment,
      totalPayment,
      totalWithSalary: totalPayment + autoSalary,
    };
  }, [bdmCalcs, headOwnCalc, autoSalary]);

  // ═══════════════════════════════════════════════════════════
  // TAB: INDIVIDUAL (all BDMs)
  // ═══════════════════════════════════════════════════════════

  const allBdms = useMemo(
    () => commercialProfiles.filter((p) => p.role === 'bdm' && p.status === 'active'),
    [commercialProfiles],
  );

  const indCalcs = useMemo((): CommissionCalcResult[] => {
    return allBdms.map((profile) => {
      const nd = ndInputs.get(profile.id) ?? 0;
      const accIn = getAccumulatedIn(previousResultsAll, profile.id);
      // BDM percentage is dynamic based on their individual ND (falls back to profile pct if < $50k)
      const pct = calculateBdmPctFromND(nd, profile.net_deposit_pct ?? 0);
      const calc = calculateCommission(nd, accIn, pct);
      const bdmSalary = profile.fixed_salary ? (profile.salary ?? 0) : calculateSalaryFromND(nd);
      return { profileId: profile.id, commissionPct: pct, salary: bdmSalary, ...calc };
    });
  }, [allBdms, ndInputs, previousResultsAll]);

  const indSummary = useMemo(() => calculateGroupSummary(indCalcs), [indCalcs]);

  // ─── History filter (últimos 7 meses por defecto) ───
  const [historyFrom, setHistoryFrom] = useState(Math.max(0, sortedPeriods.length - 7));
  const [historyTo, setHistoryTo] = useState(sortedPeriods.length - 1);
  const historyPeriods = useMemo(() => sortedPeriods.slice(historyFrom, historyTo + 1), [sortedPeriods, historyFrom, historyTo]);

  // ═══════════════════════════════════════════════════════════
  // SAVE & EXPORT
  // ═══════════════════════════════════════════════════════════

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!selectedPeriod || !company) return;

    // Si hay un warning de validación (el total del equipo no coincide
    // con lo que el grupo padre registró), bloquear el guardado
    if (tab === 'teams' && teamNdValidation) {
      setToast({
        type: 'error',
        msg: `El ND total del equipo (${formatCurrency(teamNdValidation.actual)}) no coincide con el valor del grupo de ${teamNdValidation.parentName} (${formatCurrency(teamNdValidation.expected)}). Corrige los valores antes de guardar.`,
      });
      setTimeout(() => setToast(null), 6000);
      return;
    }

    setSaving(true);
    try {
      let entries: CommissionEntryRow[];
      if (tab === 'teams') {
        entries = [];

        // Save EVERY member of the team with their OWN data
        for (const profile of teamProfiles) {
          const isHead = profile.id === headProfile?.id;

          const nd = ndInputs.get(profile.id) ?? 0;
          const accIn = getAccumulatedIn(previousResults, profile.id);
          // HEAD/sub-HEADs keep profile pct; only actual BDMs use dynamic pct based on ND
          const isSubHead = !isHead && (profile.role === 'head' || profile.role === 'sales_manager'
            || commercialProfiles.some((sub) => sub.head_id === profile.id && sub.status === 'active'));
          const pct = (isHead || isSubHead) ? (profile.net_deposit_pct ?? 0) : calculateBdmPctFromND(nd, profile.net_deposit_pct ?? 0);
          const calc = calculateCommission(nd, accIn, pct);

          if (isHead && headHasParent) {
            // HEAD with parent: save their personal ND and calculations
            // net_deposit_current is preserved (parent manages it via -1 flag)
            // but accumulated_out is their OWN from their own group's calculation
            entries.push({
              profile_id: profile.id,
              net_deposit_current: null, // flag: don't overwrite (parent manages this)
              net_deposit_accumulated: nd, // store personal ND here
              division: calc.division,
              base_amount: calc.base,
              commissions_earned: calc.commission + headDiff.totalDifferential,
              real_payment: calc.realPayment + headDiff.totalRealPayment,
              accumulated_out: calc.accumulatedOut,
              salary_paid: autoSalary,
              total_earned: calc.realPayment + headDiff.totalRealPayment + autoSalary,
            });
          } else {
            // Sub-members with own team: preserve net_deposit_accumulated (-1 flag)
            // because that field stores their personal ND from their own group
            const isSubWithTeam = !isHead && commercialProfiles.some((sub) => sub.head_id === profile.id && sub.status === 'active');
            entries.push({
              profile_id: profile.id,
              net_deposit_current: nd,
              net_deposit_accumulated: isSubWithTeam ? null : accIn,
              division: calc.division,
              base_amount: calc.base,
              commissions_earned: calc.commission,
              real_payment: calc.realPayment,
              accumulated_out: calc.accumulatedOut,
              salary_paid: isHead ? autoSalary : (profile.fixed_salary ? (profile.salary ?? 0) : calculateSalaryFromND(nd)),
              total_earned: (isHead && !headHasParent)
                ? calc.realPayment + headDiff.totalRealPayment + autoSalary
                : calc.realPayment + (profile.fixed_salary ? (profile.salary ?? 0) : calculateSalaryFromND(nd)),
            });
          }
        }
      } else {
        entries = indCalcs.map((c) => {
          const profile = commercialProfiles.find((p) => p.id === c.profileId);
          return {
            profile_id: c.profileId,
            head_id: profile?.head_id ?? selectedHeadId,
            net_deposit_current: c.netDepositCurrent,
            net_deposit_accumulated: c.accumulatedIn,
            division: c.division,
            base_amount: c.base,
            commissions_earned: c.commission,
            real_payment: c.realPayment,
            accumulated_out: c.accumulatedOut,
            salary_paid: c.salary,
            total_earned: c.realPayment + c.salary,
          };
        });
      }
      console.log('[SAVE] entries:', entries.length, entries.map(e => ({ id: e.profile_id, nd: e.net_deposit_current })));
      if (entries.length === 0) {
        setSaving(false);
        setToast({ type: 'error', msg: 'No hay datos para guardar' });
        setTimeout(() => setToast(null), 4000);
        return;
      }
      await upsertCommissionEntries(company.id, selectedPeriod.id, selectedHeadId, entries);
      console.log('[SAVE] success');
      // Limpiar raw inputs para que el display muestre los valores guardados
      setNdRawInputs(new Map());
      // Liberar el botón y mostrar éxito INMEDIATAMENTE
      setSaving(false);
      setToast({ type: 'success', msg: 'Comisiones guardadas' });
      setTimeout(() => setToast(null), 4000);
      // Refrescar datos en background sin bloquear la UI
      refreshCommissions().catch((err) => {
        console.warn('Background refresh failed:', err);
      });
    } catch (err) {
      setSaving(false);
      setToast({ type: 'error', msg: err instanceof Error ? err.message : 'Error al guardar' });
      setTimeout(() => setToast(null), 4000);
    }
  };

  const doExport = () => {
    if (!selectedPeriod) return;
    if (tab === 'teams') {
      const headers = ['Name', 'Role', '%', t('comm.ndCurrent'), t('comm.division'), t('comm.base'), t('comm.commission'), t('comm.realPayment')];
      const rows = bdmCalcs.map((c) => {
        const p = commercialProfiles.find((pr) => pr.id === c.profileId);
        return [p?.name ?? '', 'BDM', c.commissionPct, c.netDepositCurrent, c.division, c.base, c.commission, c.realPayment] as (string | number)[];
      });
      if (headProfile) {
        rows.push([headProfile.name, ROLE_LABEL[headProfile.role], `Diff`, '', '', '', headDiff.totalDifferential, headDiff.totalRealPayment]);
      }
      const headName = headProfile?.name ?? 'team';
      downloadCSV(`comisiones_${headName}_${selectedPeriod.year}-${selectedPeriod.month}.csv`, headers, rows);
    } else {
      const headers = ['Name', '%', t('comm.ndCurrent'), t('comm.division'), t('comm.base'), t('comm.commission'), t('comm.realPayment')];
      const rows = indCalcs.map((c) => {
        const p = commercialProfiles.find((pr) => pr.id === c.profileId);
        return [p?.name ?? '', c.commissionPct, c.netDepositCurrent, c.division, c.base, c.commission, c.realPayment] as (string | number)[];
      });
      downloadCSV(`comisiones_individual_${selectedPeriod.year}-${selectedPeriod.month}.csv`, headers, rows);
    }
  };
  const handleExport = () => verify2FA(doExport);

  const doExportPDF = () => {
    if (!selectedPeriod || !headProfile) return;
    const periodLabel = selectedPeriod.label || `${selectedPeriod.month}/${selectedPeriod.year}`;

    // Build salary tier label
    const tierLabels = HEAD_SALARY_TIERS.map(t => `≥$${t.minND.toLocaleString()} → $${t.salary.toLocaleString()}`).join(' | ');

    generateCommissionPDF({
      companyName: company?.name ?? 'VexPro',
      headName: headProfile.name,
      headRole: ROLE_LABEL[headProfile.role] || headProfile.role,
      headEmail: headProfile.email,
      periodLabel,
      teamTotalND: teamTotalND,
      autoSalary,
      salaryTierLabel: tierLabels,
      headOwnCalc: headOwnCalc ? {
        netDepositCurrent: headOwnCalc.netDepositCurrent,
        accumulatedIn: headOwnCalc.accumulatedIn,
        division: headOwnCalc.division,
        base: headOwnCalc.base,
        commissionPct: headOwnCalc.commissionPct,
        commission: headOwnCalc.commission,
        realPayment: headOwnCalc.realPayment,
        accumulatedOut: headOwnCalc.accumulatedOut,
      } : null,
      headDiff,
      teamSummary,
      bdms: bdmCalcs.map(c => {
        const p = commercialProfiles.find(pr => pr.id === c.profileId);
        return {
          name: p?.name ?? '',
          email: p?.email ?? '',
          pct: c.bdmOwnPct,
          diffPct: c.diffPct,
          nd: c.netDepositCurrent,
          division: c.division,
          base: c.base,
          commission: c.commission,
          realPayment: c.realPayment,
          accOut: c.accumulatedOut,
          salary: c.salary,
        };
      }),
    });
  };
  const handleExportPDF = () => verify2FA(doExportPDF);

  const [showExportMenu, setShowExportMenu] = useState(false);

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════

  if (!hasModuleAccess(user, 'commissions')) {
    return <div className="flex items-center justify-center h-64"><p className="text-muted-foreground">{t('common.noAccess')}</p></div>;
  }

  return (
    <div className="space-y-6">
      {Modal2FA}
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Calculator className="w-6 h-6" />{t('comm.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('comm.subtitle')}</p>
        </div>
        <div className="relative">
          <button
            onClick={() => setShowExportMenu(!showExportMenu)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
          >
            <Download className="w-4 h-4" />{t('comm.export')}
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          {showExportMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[180px]">
                <button
                  onClick={() => { handleExport(); setShowExportMenu(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                >
                  <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
                  Exportar CSV
                </button>
                {tab === 'teams' && (
                  <button
                    onClick={() => { handleExportPDF(); setShowExportMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                  >
                    <FileText className="w-4 h-4 text-red-500" />
                    Informe PDF detallado
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>


      {/* Tabs */}
      <div className="flex gap-1 bg-muted p-1 rounded-lg w-fit">
        <button onClick={() => setTab('teams')} className={cn('flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors', tab === 'teams' ? 'bg-card shadow-sm' : 'hover:bg-card/50')}>
          <Users className="w-4 h-4" />{t('comm.tabTeams')}
        </button>
        <button onClick={() => setTab('individual')} className={cn('flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors', tab === 'individual' ? 'bg-card shadow-sm' : 'hover:bg-card/50')}>
          <UserCircle className="w-4 h-4" />{t('comm.tabIndividual')}
        </button>
        <button onClick={() => setTab('history')} className={cn('flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors', tab === 'history' ? 'bg-card shadow-sm' : 'hover:bg-card/50')}>
          <BarChart3 className="w-4 h-4" />{t('comm.tabHistory')}
        </button>
      </div>

      {/* Period selector (teams & individual only) */}
      {tab !== 'history' && (
        <Card>
          <div className="flex flex-col sm:flex-row gap-4">
            {tab === 'teams' && (
              <div className="flex-1">
                <label className="block text-sm font-medium mb-1.5">{t('comm.selectHead')}</label>
                <select value={selectedHeadId} onChange={(e) => setSelectedHeadId(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
                  <option value="">{t('comm.selectHead')}</option>
                  {heads.map((h) => <option key={h.id} value={h.id}>{h.name} — {h.net_deposit_pct ?? 0}%</option>)}
                </select>
              </div>
            )}
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1.5">{t('comm.selectPeriod')}</label>
              <div className="flex items-center gap-2">
                <button onClick={() => navigatePeriod(-1)} disabled={periodIdx <= 0} className="p-2 rounded-lg border border-border hover:bg-muted disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
                <select value={selectedPeriod?.id ?? ''} onChange={(e) => { const i = sortedPeriods.findIndex((p) => p.id === e.target.value); if (i >= 0) setPeriodIdx(i); }} className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
                  {sortedPeriods.map((p) => <option key={p.id} value={p.id}>{p.label || `${p.year}-${String(p.month).padStart(2, '0')}`}</option>)}
                </select>
                <button onClick={() => navigatePeriod(1)} disabled={periodIdx >= sortedPeriods.length - 1} className="p-2 rounded-lg border border-border hover:bg-muted disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* ═══════════ TAB: TEAMS ═══════════ */}
      {tab === 'teams' && selectedHeadId && headProfile && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-violet-100 dark:bg-violet-950/50 flex items-center justify-center"><UserCircle className="w-6 h-6 text-violet-600" /></div>
                <div>
                  <p className="font-semibold text-sm">{headProfile.name}</p>
                  <p className="text-xs text-muted-foreground"><Users className="w-3 h-3 inline mr-1" />{teamProfiles.length} {t('comm.members')}</p>
                </div>
              </div>
            </Card>
            <Card>
              <p className="text-sm text-muted-foreground">{t('comm.teamTotalND')}</p>
              <p className={cn('text-2xl font-bold', teamTotalND >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(teamTotalND)}</p>
            </Card>
            <Card>
              <p className="text-sm text-muted-foreground">{t('comm.autoSalary')}</p>
              <p className="text-2xl font-bold text-blue-600">{formatCurrency(autoSalary)}</p>
              <p className="text-xs text-muted-foreground mt-1">{HEAD_SALARY_TIERS.map((tier) => `≥${formatCurrency(tier.minND)} → ${formatCurrency(tier.salary)}`).join(' | ')}</p>
            </Card>
            <Card>
              <p className="text-sm text-muted-foreground">{t('comm.totalWithSalary')}</p>
              <p className={cn('text-2xl font-bold', teamSummary.totalWithSalary >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(teamSummary.totalWithSalary)}</p>
            </Card>
          </div>

          {/* Info */}
          <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 text-sm">
            <Info className="w-4 h-4 mt-0.5 shrink-0" /><span>{t('comm.teamFromHR')}</span>
          </div>

          {/* Validation warning */}
          {teamNdValidation && (
            <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                El ND total de este equipo ({formatCurrency(teamNdValidation.actual)}) no coincide con el valor ingresado en el grupo de <strong>{teamNdValidation.parentName}</strong> ({formatCurrency(teamNdValidation.expected)}). La suma del equipo debe ser igual.
              </span>
            </div>
          )}

          {/* BDM Commission Table */}
          {bdmCalcs.length > 0 ? (
            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left px-4 py-3 font-medium">{t('common.name')}</th>
                      <th className="text-left px-3 py-3 font-medium">{t('comm.role')}</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.ndCurrent')}</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.accumulated')}</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.division')}</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.base')}</th>
                      <th className="text-center px-3 py-3 font-medium">%</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.commission')}</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.realPayment')}</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.accNext')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* HEAD's own ND row — earns full percentage on own work */}
                    {headOwnCalc && (
                      <tr className="border-b border-border bg-violet-50/50 dark:bg-violet-950/20 hover:bg-violet-50 dark:hover:bg-violet-950/30">
                        <td className="px-4 py-3"><span className="font-semibold block">{headProfile.name}</span><span className="text-xs text-muted-foreground">{headProfile.email}</span></td>
                        <td className="px-3 py-3"><span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', ROLE_BADGE[headProfile.role])}>{ROLE_LABEL[headProfile.role]}</span></td>
                        <td className="px-3 py-3">
                          <input type="number" value={getNdDisplay(headProfile.id)} onChange={(e) => handleNdChange(headProfile.id, e.target.value)} onFocus={(e) => e.target.select()} className="w-28 px-2 py-1 text-right rounded border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                        </td>
                        <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(headOwnCalc.accumulatedIn)}</td>
                        <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(headOwnCalc.division)}</td>
                        <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(headOwnCalc.base)}</td>
                        <td className="px-3 py-3 text-center text-xs font-medium">{headOwnCalc.commissionPct}%</td>
                        <td className={cn('px-3 py-3 text-right font-medium', headOwnCalc.commission >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(headOwnCalc.commission)}</td>
                        <td className="px-3 py-3 text-right font-semibold text-emerald-600">{formatCurrency(headOwnCalc.realPayment)}</td>
                        <td className={cn('px-3 py-3 text-right', headOwnCalc.accumulatedOut < 0 ? 'text-red-600' : 'text-muted-foreground')}>{formatCurrency(headOwnCalc.accumulatedOut)}</td>
                      </tr>
                    )}
                    {/* BDM rows */}
                    {bdmCalcs.map((calc) => {
                      const profile = commercialProfiles.find((p) => p.id === calc.profileId);
                      if (!profile) return null;
                      const hasOwnTeam = commercialProfiles.some((sub) => sub.head_id === profile.id && sub.status === 'active');
                      return (
                        <tr key={calc.profileId} className="border-b border-border hover:bg-muted/30">
                          <td className="px-4 py-3">
                            <span className="font-medium block">{profile.name}{hasOwnTeam && <span className="ml-1 text-[10px] text-violet-500">(equipo)</span>}</span>
                            <span className="text-xs text-muted-foreground">{profile.email}</span>
                          </td>
                          <td className="px-3 py-3"><span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', ROLE_BADGE[profile.role])}>{ROLE_LABEL[profile.role]}</span></td>
                          <td className="px-3 py-3">
                            <input type="number" value={getNdDisplay(calc.profileId)} onChange={(e) => handleNdChange(calc.profileId, e.target.value)} onFocus={(e) => e.target.select()} className="w-28 px-2 py-1 text-right rounded border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                          </td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.accumulatedIn)}</td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.division)}</td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.base)}</td>
                          <td className="px-3 py-3 text-center text-xs font-medium">
                            <span className="text-violet-600">{calc.diffPct}%</span>
                            <span className="block text-muted-foreground text-[10px]">({calc.bdmOwnPct}% base)</span>
                          </td>
                          <td className={cn('px-3 py-3 text-right font-medium', calc.commission >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(calc.commission)}</td>
                          <td className="px-3 py-3 text-right font-semibold text-emerald-600">{formatCurrency(calc.realPayment)}</td>
                          <td className={cn('px-3 py-3 text-right', calc.accumulatedOut < 0 ? 'text-red-600' : 'text-muted-foreground')}>{formatCurrency(calc.accumulatedOut)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/50 font-semibold">
                      <td className="px-4 py-3" colSpan={2}>{t('comm.groupTotal')}</td>
                      <td className="px-3 py-3 text-right">{formatCurrency(teamTotalND)}</td>
                      <td className="px-3 py-3" colSpan={4}></td>
                      <td className={cn('px-3 py-3 text-right', teamSummary.totalPayment >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(teamSummary.totalPayment)}</td>
                      <td className="px-3 py-3 text-right">
                        <span className={cn(teamSummary.totalPayment >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(teamSummary.totalPayment)}</span>
                        {autoSalary > 0 && (
                          <span className="block text-blue-600 text-xs">+ {formatCurrency(autoSalary)} sal. = {formatCurrency(teamSummary.totalWithSalary)}</span>
                        )}
                      </td>
                      <td className="px-3 py-3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
          ) : (
            <Card><p className="text-center text-muted-foreground py-8">{t('comm.noData')}</p></Card>
          )}
        </>
      )}

      {tab === 'teams' && !selectedHeadId && (
        <Card><p className="text-center text-muted-foreground py-8">{t('comm.selectHead')}</p></Card>
      )}

      {/* ═══════════ TAB: INDIVIDUAL ═══════════ */}
      {tab === 'individual' && (
        <>
          <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 text-sm">
            <Info className="w-4 h-4 mt-0.5 shrink-0" /><span>{t('comm.allBdms')} — {allBdms.length} BDMs</span>
          </div>

          {allBdms.length > 0 ? (
            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left px-4 py-3 font-medium">{t('common.name')}</th>
                      <th className="text-left px-3 py-3 font-medium">HEAD</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.ndCurrent')}</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.accumulated')}</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.division')}</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.base')}</th>
                      <th className="text-center px-3 py-3 font-medium">%</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.commission')}</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.realPayment')}</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.salary')}</th>
                      <th className="text-right px-3 py-3 font-medium">Total</th>
                      <th className="text-right px-3 py-3 font-medium">{t('comm.accNext')}</th>
                      <th className="px-2 py-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {indCalcs.map((calc) => {
                      const profile = commercialProfiles.find((p) => p.id === calc.profileId);
                      if (!profile) return null;
                      const headName = profile.head_id ? commercialProfiles.find((p) => p.id === profile.head_id)?.name : '—';
                      return (
                        <tr key={calc.profileId} className="border-b border-border hover:bg-muted/30">
                          <td className="px-4 py-3"><span className="font-medium block">{profile.name}</span><span className="text-xs text-muted-foreground">{profile.email}</span></td>
                          <td className="px-3 py-3 text-xs text-muted-foreground">{headName}</td>
                          <td className="px-3 py-3">
                            <input type="number" value={getNdDisplay(calc.profileId)} onChange={(e) => handleNdChange(calc.profileId, e.target.value)} onFocus={(e) => e.target.select()} className="w-28 px-2 py-1 text-right rounded border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                          </td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.accumulatedIn)}</td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.division)}</td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.base)}</td>
                          <td className="px-3 py-3 text-center text-xs font-medium">{calc.commissionPct}%</td>
                          <td className={cn('px-3 py-3 text-right font-medium', calc.commission >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(calc.commission)}</td>
                          <td className="px-3 py-3 text-right font-semibold text-emerald-600">{formatCurrency(calc.realPayment)}</td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.salary)}</td>
                          <td className="px-3 py-3 text-right font-semibold">{formatCurrency(calc.realPayment + calc.salary)}</td>
                          <td className={cn('px-3 py-3 text-right', calc.accumulatedOut < 0 ? 'text-red-600' : 'text-muted-foreground')}>{formatCurrency(calc.accumulatedOut)}</td>
                          <td className="px-2 py-3 text-center">
                            <button
                              onClick={() => verify2FA(() => {
                                if (!selectedPeriod) return;
                                const headP = profile.head_id ? commercialProfiles.find(p => p.id === profile.head_id) : null;
                                generateIndividualPDF({
                                  companyName: company?.name ?? 'VexPro',
                                  periodLabel: selectedPeriod.label || `${selectedPeriod.month}/${selectedPeriod.year}`,
                                  name: profile.name,
                                  email: profile.email,
                                  role: ROLE_LABEL[profile.role] || profile.role,
                                  headName: headP?.name ?? '—',
                                  pct: calc.commissionPct,
                                  nd: calc.netDepositCurrent,
                                  accumulatedIn: calc.accumulatedIn,
                                  division: calc.division,
                                  base: calc.base,
                                  commission: calc.commission,
                                  realPayment: calc.realPayment,
                                  accumulatedOut: calc.accumulatedOut,
                                  salary: calc.salary,
                                  total: calc.realPayment + calc.salary,
                                });
                              })}
                              className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 text-red-500 hover:text-red-600 transition-colors"
                              title="Descargar PDF"
                            >
                              <FileText className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/50 font-semibold">
                      <td className="px-4 py-3" colSpan={2}>{t('comm.groupTotal')}</td>
                      <td className="px-3 py-3 text-right">{formatCurrency(indCalcs.reduce((s, c) => s + c.netDepositCurrent, 0))}</td>
                      <td className="px-3 py-3" colSpan={4}></td>
                      <td className={cn('px-3 py-3 text-right', indSummary.totalCommission >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(indSummary.totalCommission)}</td>
                      <td className="px-3 py-3 text-right text-emerald-600">{formatCurrency(indSummary.totalRealPayment)}</td>
                      <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(indSummary.totalSalary)}</td>
                      <td className="px-3 py-3 text-right font-semibold">{formatCurrency(indSummary.totalWithSalary)}</td>
                      <td className="px-3 py-3"></td>
                      <td className="px-2 py-3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
          ) : (
            <Card><p className="text-center text-muted-foreground py-8">{t('comm.noData')}</p></Card>
          )}
        </>
      )}
      {/* ═══════════ TAB: HISTORY ═══════════ */}
      {tab === 'history' && (() => {
        const activeProfiles = commercialProfiles.filter((p) => p.status === 'active');
        const smProfiles = activeProfiles.filter((p) => p.role === 'sales_manager');
        const headProfiles = activeProfiles.filter((p) => p.role === 'head');
        const bdmProfiles = activeProfiles.filter((p) => p.role === 'bdm');
        const allProfiles = [...smProfiles, ...headProfiles, ...bdmProfiles];

        const getTotal = (profileId: string, periodId: string) => {
          const profile = allProfiles.find(p => p.id === profileId);
          const records = monthlyResults.filter(
            (mr) => mr.profile_id === profileId && mr.period_id === periodId
          );
          if (records.length === 0) return null;
          // Para HEADs/SM: buscar registro donde head_id = su propio ID (su grupo)
          const ownGroupRecord = records.find(r => r.head_id === profileId);
          if (ownGroupRecord) return ownGroupRecord.total_earned;
          // Para BDMs: buscar registro donde head_id = su HEAD real
          if (profile?.head_id) {
            const headRecord = records.find(r => r.head_id === profile.head_id);
            if (headRecord) return headRecord.total_earned;
          }
          // Fallback: el registro con mayor total_earned (valor absoluto)
          return records.reduce((best, r) =>
            Math.abs(r.total_earned) > Math.abs(best.total_earned) ? r : best
          ).total_earned;
        };

        const getProfileTotal = (profileId: string) => {
          return historyPeriods.reduce((sum, p) => {
            const val = getTotal(profileId, p.id);
            return sum + (val ?? 0);
          }, 0);
        };

        return (
          <>
            {/* History period filter */}
            <Card>
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-1.5">Desde</label>
                  <select value={historyFrom} onChange={(e) => setHistoryFrom(Number(e.target.value))} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
                    {sortedPeriods.map((p, i) => <option key={p.id} value={i}>{p.label || `${p.year}-${String(p.month).padStart(2, '0')}`}</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-1.5">Hasta</label>
                  <select value={historyTo} onChange={(e) => setHistoryTo(Number(e.target.value))} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
                    {sortedPeriods.map((p, i) => <option key={p.id} value={i}>{p.label || `${p.year}-${String(p.month).padStart(2, '0')}`}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex items-end">
                <button
                  onClick={() => refresh()}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
                  Actualizar datos
                </button>
              </div>
            </Card>

            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left px-4 py-3 font-medium sticky left-0 bg-muted/50 z-10 min-w-[180px]">{t('common.name')}</th>
                      <th className="text-left px-2 py-3 font-medium">{t('comm.role')}</th>
                      {historyPeriods.map((p) => (
                        <th key={p.id} className="text-right px-3 py-3 font-medium whitespace-nowrap">
                          {p.label || `${p.year}-${String(p.month).padStart(2, '0')}`}
                        </th>
                      ))}
                      <th className="text-right px-4 py-3 font-semibold bg-muted/80">{t('comm.totalAll')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allProfiles.map((profile, idx) => {
                      const prevRole = idx > 0 ? allProfiles[idx - 1].role : null;
                      const showSeparator = prevRole && prevRole !== profile.role;
                      const total = getProfileTotal(profile.id);
                      return (
                        <tr key={profile.id} className={cn('border-b border-border/50 hover:bg-muted/30', showSeparator && 'border-t-2 border-t-border')}>
                          <td className="px-4 py-2.5 sticky left-0 bg-card z-10"><span className="font-medium block">{profile.name}</span><span className="text-xs text-muted-foreground">{profile.email}</span></td>
                          <td className="px-2 py-2.5">
                            <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-medium', ROLE_BADGE[profile.role])}>
                              {ROLE_LABEL[profile.role]}
                            </span>
                          </td>
                          {historyPeriods.map((p) => {
                            const val = getTotal(profile.id, p.id);
                            return (
                              <td key={p.id} className={cn('px-3 py-2.5 text-right text-xs', val === null ? 'text-muted-foreground' : val >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                                {val !== null ? formatCurrency(val) : '—'}
                              </td>
                            );
                          })}
                          <td className={cn('px-4 py-2.5 text-right font-semibold bg-muted/30', total >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                            {formatCurrency(total)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        );
      })()}

      {/* Save button + toast at bottom */}
      <div className="flex items-center justify-end gap-4 sticky bottom-4">
        {toast && (
          <div className={cn('flex items-center gap-2 px-4 py-3 rounded-lg text-sm shadow-lg', toast.type === 'success' ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white')}>
            {toast.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}{toast.msg}
          </div>
        )}
        <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-6 py-3 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 shadow-lg">
          <Save className="w-5 h-5" />{saving ? t('comm.saving') : t('comm.save')}
        </button>
      </div>
    </div>
  );
}
