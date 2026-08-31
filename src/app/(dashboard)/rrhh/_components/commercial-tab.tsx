'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { useI18n } from '@/lib/i18n';
import { useData } from '@/lib/data-context';
import { formatCurrency, cn } from '@/lib/utils';
import { deleteCommercialProfile } from '@/lib/supabase/mutations';
import { FiredBadge, firedNameClass } from '@/components/fired-badge';
import {
  ChevronDown, ChevronRight, Pencil, Plus, Search, Trash2, UserCircle, UserRound,
} from 'lucide-react';
import type { CommercialProfile } from '@/lib/types';
import {
  esBdm,
  esBdmGlobal,
  esLider,
  hrRoleBadgeClass,
  hrRoleLabel,
  sinSalario,
} from '@/lib/hr/domain';
import { flattenRollup } from '@/lib/hr/net-deposit';
import {
  totalesDe,
  totalesGenerales,
  totalesPorPerfil,
  type MonthlyResultRow,
} from '@/lib/hr/monthly-totals';
import { ProfileForm } from './profile-form';
import { useHrPeriod } from './hr-period-context';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña FUERZA COMERCIAL — las tarjetas de equipo, los BDM independientes y
// los resultados por período.
//
// ── El Net del CRM ahora sigue al selector ─────────────────────────────────
// Kevin, 2026-08-31: «lo de los net de los bdms y heads sigo sin verlo
// automatizado». El rollup automático vivía sólo en la pestaña Net Deposit, así
// que el 30/08 se agregó a estas tarjetas con un fetch propio del MES CORRIENTE
// FIJO — un parche: la tarjeta decía "Net CRM (mes)" y era otro mes que el que
// mostraba la pestaña de al lado. Ahora sale del overview del módulo y el mes es
// EL DEL SELECTOR, uno solo para todas las pestañas.
//
// `crmNet === null` significa "todavía no lo sabemos" (cargando, o el slice
// falló) y se pinta "—". Nunca $0: un cero acá diría "este equipo no produjo".
//
// Los totales de las columnas de dinero salen de src/lib/hr/monthly-totals.ts,
// que es el mismo camino que usa el CSV — antes eran cinco `reduce` inline en la
// tabla y otros cinco en el export.
// ─────────────────────────────────────────────────────────────────────────────

export function CommercialTab({
  onToast,
}: {
  onToast: (t: { type: 'success' | 'error'; msg: string }) => void;
}) {
  const { t } = useI18n();
  const { company, commercialProfiles: profiles, monthlyResults } = useData();
  const { periodIds, overview } = useHrPeriod();

  const [showProfileForm, setShowProfileForm] = useState(false);
  const [editingProfile, setEditingProfile] = useState<CommercialProfile | undefined>();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [commercialSearch, setCommercialSearch] = useState('');
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set());
  // Filtro «sin salario»: checklist para que RRHH cargue los que faltan (Kevin
  // 2026-08-28: el salario es opcional, pero las metas por net deposit muestran
  // vacío sin él; ~103/126 perfiles no lo tenían).
  const [soloSinSalario, setSoloSinSalario] = useState(false);

  const totales = useMemo(
    () => totalesPorPerfil(monthlyResults as unknown as MonthlyResultRow[], periodIds),
    [monthlyResults, periodIds],
  );
  const totalGeneral = useMemo(() => totalesGenerales(totales), [totales]);

  /** Net del CRM del mes del selector, por perfil. `null` = no lo sabemos. */
  const crmNet = useMemo(() => {
    const tree = overview?.data.net?.tree;
    if (!tree) return null;
    const m = new Map<string, { own: number; total: number }>();
    for (const { node } of flattenRollup(tree)) m.set(node.profileId, { own: node.own, total: node.total });
    return m;
  }, [overview]);

  const toggleTeamCollapsed = (leaderId: string) => {
    setCollapsedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(leaderId)) next.delete(leaderId); else next.add(leaderId);
      return next;
    });
  };

  const commercialQ = commercialSearch.trim().toLowerCase();
  const matchesCommercial = (p: CommercialProfile, q: string) =>
    !q ||
    p.name.toLowerCase().includes(q) ||
    p.email.toLowerCase().includes(q) ||
    hrRoleLabel(p.role).toLowerCase().includes(q);
  const pasaFiltroSalario = (p: CommercialProfile) => !soloSinSalario || sinSalario(p);
  const totalSinSalario = profiles.filter(sinSalario).length;

  // Registro único: quién lidera y quién es BDM lo decide hr/domain.ts.
  const lideres = profiles.filter((p) => esLider(p.role));
  const salesManagers = profiles.filter((p) => p.role === 'sales_manager');
  const heads = profiles.filter((p) => p.role === 'head');
  const independentBdms = profiles.filter((p) => esBdm(p.role) && !p.head_id);

  // Un equipo se muestra si matchea el líder O algún BDM bajo su estructura.
  const teamHasMatch = (leader: CommercialProfile) =>
    (matchesCommercial(leader, commercialQ) && pasaFiltroSalario(leader)) ||
    profiles.some((p) => p.head_id === leader.id && matchesCommercial(p, commercialQ) && pasaFiltroSalario(p));
  const visibleSalesManagers = salesManagers.filter(teamHasMatch);
  const visibleHeads = heads.filter(teamHasMatch);
  const visibleIndependentBdms = independentBdms.filter(
    (b) => matchesCommercial(b, commercialQ) && pasaFiltroSalario(b),
  );

  const handleDeleteProfile = async (id: string) => {
    try {
      await deleteCommercialProfile(id);
      setDeletingId(null);
      window.location.reload();
    } catch (err) {
      setDeletingId(null);
      onToast({ type: 'error', msg: err instanceof Error ? err.message : t('hr.deleteError') });
    }
  };

  const netCrmCell = (profileId: string) =>
    crmNet === null ? '—' : formatCurrency(crmNet.get(profileId)?.total ?? 0);

  const renderTeamCard = (leader: CommercialProfile) => {
    const allBdms = profiles.filter(p => p.head_id === leader.id);
    const leaderMatches = matchesCommercial(leader, commercialQ);
    // Al buscar: si el líder NO matchea, mostrar sólo los BDM que matchean.
    const bdms = (!commercialQ || leaderMatches) ? allBdms : allBdms.filter(b => matchesCommercial(b, commercialQ));
    // Colapsar se ignora mientras hay búsqueda activa (siempre expandido).
    const isCollapsed = !commercialQ && collapsedTeams.has(leader.id);
    const leaderTotal = totalesDe(totales, leader.id).total;

    return (
      <Card key={leader.id}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => toggleTeamCollapsed(leader.id)}
              className="text-muted-foreground hover:text-foreground shrink-0"
              aria-label={isCollapsed ? t('hr.expandTeam') : t('hr.collapseTeam')}
              title={isCollapsed ? t('hr.expandTeam') : t('hr.collapseTeam')}
            >
              {isCollapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
            </button>
            <div className="w-10 h-10 rounded-full bg-violet-100 dark:bg-violet-950/50 flex items-center justify-center shrink-0">
              <UserCircle className="w-6 h-6 text-violet-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/rrhh/perfil?id=${leader.id}`}
                  className={cn(
                    'text-base sm:text-lg font-semibold hover:text-primary dark:text-accent transition-colors',
                    firedNameClass(leader),
                  )}
                >
                  {leader.name}
                </Link>
                <FiredBadge profile={leader} />
                <button onClick={() => { setEditingProfile(leader); setShowProfileForm(true); }} className="text-muted-foreground hover:text-foreground" aria-label={t('common.edit')}>
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                {deletingId === leader.id ? (
                  <div className="flex items-center gap-1">
                    <button onClick={() => handleDeleteProfile(leader.id)} className="px-2 py-0.5 text-xs rounded bg-red-500 text-white hover:bg-red-600">OK</button>
                    <button onClick={() => setDeletingId(null)} className="px-2 py-0.5 text-xs rounded border border-border hover:bg-muted">{t('common.no')}</button>
                  </div>
                ) : (
                  <button onClick={() => setDeletingId(leader.id)} className="text-muted-foreground hover:text-red-500" aria-label={t('common.delete')}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', hrRoleBadgeClass(leader.role))}>
                  {hrRoleLabel(leader.role)}
                </span>
                <span className="hidden sm:inline">{leader.email}</span>
              </div>
            </div>
          </div>
          <div className="text-left sm:text-right ml-13 sm:ml-0">
            <p className="text-sm text-muted-foreground">{t('hr.netDeposit')}: {leader.net_deposit_pct != null ? `${leader.net_deposit_pct}%` : 'N/A'}</p>
            <p className="font-semibold">{formatCurrency(leaderTotal)}</p>
            <p className="text-xs mt-0.5">
              <span className="text-muted-foreground">{t('hr.netCrmMonth')}: </span>
              {crmNet === null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className={cn('font-semibold', (crmNet.get(leader.id)?.total ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>
                  {formatCurrency(crmNet.get(leader.id)?.total ?? 0)}
                  <span className="ml-1 text-[10px] uppercase tracking-wide text-positive/80">api</span>
                </span>
              )}
            </p>
          </div>
        </div>

        {!isCollapsed && bdms.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[500px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">BDM</th>
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('common.email')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.netCrmCol')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.netDepPct')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.salaryCol')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.pnl')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.commissions')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.bonus')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.total')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {bdms.map(bdm => {
                  const tot = totalesDe(totales, bdm.id);
                  return (
                  <tr key={bdm.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                    <td className={cn('py-2.5 px-3 font-medium', firedNameClass(bdm))}>
                      {bdm.name}
                      {esBdmGlobal(bdm.role) && (
                        <span className="inline-block ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800 border border-purple-300">GLOBAL</span>
                      )}
                      <FiredBadge profile={bdm} />
                    </td>
                    <td className="py-2.5 px-3 text-muted-foreground text-xs hidden sm:table-cell">{bdm.email}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums">{netCrmCell(bdm.id)}</td>
                    <td className="py-2.5 px-3 text-right hidden sm:table-cell">{bdm.net_deposit_pct != null ? `${bdm.net_deposit_pct}%` : 'N/A'}</td>
                    <td className="py-2.5 px-3 text-right hidden sm:table-cell">{bdm.fixed_salary && bdm.salary != null ? formatCurrency(bdm.salary) : 'N/A'}</td>
                    <td className="py-2.5 px-3 text-right hidden sm:table-cell">{tot.pnl > 0 ? formatCurrency(tot.pnl) : '-'}</td>
                    <td className="py-2.5 px-3 text-right">{formatCurrency(tot.commissions)}</td>
                    <td className="py-2.5 px-3 text-right hidden sm:table-cell">{tot.bonus > 0 ? formatCurrency(tot.bonus) : '-'}</td>
                    <td className="py-2.5 px-3 text-right font-medium">{formatCurrency(tot.total)}</td>
                    <td className="py-2.5 px-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => { setEditingProfile(bdm); setShowProfileForm(true); }} className="text-muted-foreground hover:text-foreground" aria-label={t('common.edit')}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {deletingId === bdm.id ? (
                          <div className="flex items-center gap-1">
                            <button onClick={() => handleDeleteProfile(bdm.id)} className="px-2 py-0.5 text-xs rounded bg-red-500 text-white hover:bg-red-600">OK</button>
                            <button onClick={() => setDeletingId(null)} className="px-2 py-0.5 text-xs rounded border border-border hover:bg-muted">{t('common.no')}</button>
                          </div>
                        ) : (
                          <button onClick={() => setDeletingId(bdm.id)} className="text-muted-foreground hover:text-red-500" aria-label={t('common.delete')}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <Link
                          href={`/rrhh/perfil?id=${bdm.id}`}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={t('hr.viewProfile')}
                          title={t('hr.viewProfile')}
                        >
                          <UserRound className="w-4 h-4" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      {/* El selector de período NO vive acá: es uno solo del módulo y está
          arriba de las pestañas (ver rrhh/page.tsx). Acá queda sólo el alta. */}
      <Card>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('hr.commercialForce')}</h3>
          <button
            onClick={() => { setEditingProfile(undefined); setShowProfileForm(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
          >
            <Plus className="w-4 h-4" /> {t('hr.addProfile')}
          </button>
        </div>
      </Card>

      {showProfileForm && (
        <ProfileForm
          editing={editingProfile}
          onClose={() => { setEditingProfile(undefined); setShowProfileForm(false); }}
          companyId={company?.id || ''}
        />
      )}

      {/* Buscador (por encargado HEAD/SM o por BDM) + colapsar/expandir todo */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex items-center flex-1 min-w-[220px]">
            <Search className="w-4 h-4 absolute left-2.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={commercialSearch}
              onChange={(e) => setCommercialSearch(e.target.value)}
              placeholder={t('hr.searchCommercialPlaceholder')}
              className="pl-8 pr-8 py-1.5 text-base sm:text-sm border border-border rounded-md bg-background w-full focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
            />
            {commercialSearch && (
              <button onClick={() => setCommercialSearch('')} className="absolute right-2 text-muted-foreground hover:text-foreground" aria-label={t('comm.clearSearch')}>✕</button>
            )}
          </div>
          <button
            onClick={() => setSoloSinSalario((v) => !v)}
            aria-pressed={soloSinSalario}
            className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
              soloSinSalario
                ? 'bg-primary text-brand-on-primary border-primary'
                : 'border-border hover:bg-muted'
            }`}
          >
            {t('hr.noSalaryFilter', { count: String(totalSinSalario) })}
          </button>
          {!commercialQ && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCollapsedTeams(new Set(lideres.map((l) => l.id)))}
                className="px-2.5 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-muted"
              >
                {t('hr.collapseAll')}
              </button>
              <button
                onClick={() => setCollapsedTeams(new Set())}
                className="px-2.5 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-muted"
              >
                {t('hr.expandAll')}
              </button>
            </div>
          )}
        </div>
        {commercialQ && (
          <p className="text-xs text-muted-foreground mt-2">
            {t('hr.showingTeams', { teams: String(visibleSalesManagers.length + visibleHeads.length) })}
            {visibleIndependentBdms.length > 0 ? t('hr.showingBdms', { count: String(visibleIndependentBdms.length) }) : ''}
            {t('hr.forQuery', { query: commercialSearch })}
          </p>
        )}
      </Card>

      {/* Sales Managers */}
      {visibleSalesManagers.map(sm => renderTeamCard(sm))}

      {/* HEADs */}
      {visibleHeads.map(head => renderTeamCard(head))}

      {/* Sin resultados de búsqueda */}
      {commercialQ && visibleSalesManagers.length === 0 && visibleHeads.length === 0 && visibleIndependentBdms.length === 0 && (
        <Card><p className="text-center text-muted-foreground py-8">{t('hr.noResultsFor', { query: commercialSearch })}</p></Card>
      )}

      {/* Independent BDMs */}
      {visibleIndependentBdms.length > 0 && (
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('hr.independentBdms')}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('common.email')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.netDepPct')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.pnlPct')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.salaryCol')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.pnl')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.commissions')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.bonus')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.total')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {visibleIndependentBdms.map(bdm => {
                  const tot = totalesDe(totales, bdm.id);
                  return (
                  <tr key={bdm.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                    <td className={cn('py-2.5 px-3 font-medium', firedNameClass(bdm))}>
                      {bdm.name}
                      {esBdmGlobal(bdm.role) && (
                        <span className="inline-block ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800 border border-purple-300">GLOBAL</span>
                      )}
                      <FiredBadge profile={bdm} />
                    </td>
                    <td className="py-2.5 px-3 text-muted-foreground text-xs">{bdm.email}</td>
                    <td className="py-2.5 px-3 text-right">{bdm.net_deposit_pct != null ? `${bdm.net_deposit_pct}%` : 'N/A'}</td>
                    <td className="py-2.5 px-3 text-right">{bdm.pnl_pct != null ? `${bdm.pnl_pct}%` : 'N/A'}</td>
                    <td className="py-2.5 px-3 text-right">{bdm.fixed_salary && bdm.salary != null ? formatCurrency(bdm.salary) : 'N/A'}</td>
                    <td className="py-2.5 px-3 text-right">{tot.pnl > 0 ? formatCurrency(tot.pnl) : '-'}</td>
                    <td className="py-2.5 px-3 text-right">{formatCurrency(tot.commissions)}</td>
                    <td className="py-2.5 px-3 text-right">{tot.bonus > 0 ? formatCurrency(tot.bonus) : '-'}</td>
                    <td className="py-2.5 px-3 text-right font-medium">{formatCurrency(tot.total)}</td>
                    <td className="py-2.5 px-3 text-right flex items-center justify-end gap-1">
                      <button onClick={() => { setEditingProfile(bdm); setShowProfileForm(true); }} className="text-muted-foreground hover:text-foreground" aria-label={t('common.edit')}>
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <Link
                        href={`/rrhh/perfil?id=${bdm.id}`}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={t('hr.viewProfile')}
                        title={t('hr.viewProfile')}
                      >
                        <UserRound className="w-4 h-4" />
                      </Link>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ─── Resultados por período (todos los perfiles) ─── */}
      <Card>
        <h2 className="text-lg font-semibold mb-4">{t('hr.resultsByPeriod')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
                <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('hr.role')}</th>
                <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.netDeposit')}</th>
                <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.pnl')}</th>
                <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.commissions')}</th>
                <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.bonus')}</th>
                <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.salaryCol')}</th>
                <th className="text-right py-2.5 px-3 text-muted-foreground font-medium font-bold">{t('hr.total')}</th>
              </tr>
            </thead>
            <tbody>
              {profiles
                // Mismo criterio que antes: se listan los que movieron algo en
                // el período (ganaron o trajeron net deposit).
                .filter(p => {
                  const tot = totales.get(p.id);
                  return !!tot && (tot.total > 0 || tot.netDepositCurrent > 0);
                })
                .sort((a, b) => totalesDe(totales, b.id).total - totalesDe(totales, a.id).total)
                .map(p => {
                  const tot = totalesDe(totales, p.id);
                  return (
                    <tr key={p.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                      <td className="py-2.5 px-3 font-medium">
                        <Link href={`/rrhh/perfil?id=${p.id}`} className="hover:text-primary dark:text-accent">{p.name}</Link>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', hrRoleBadgeClass(p.role))}>
                          {hrRoleLabel(p.role)}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right">{formatCurrency(tot.netDepositTotal)}</td>
                      <td className="py-2.5 px-3 text-right">{tot.pnl > 0 ? formatCurrency(tot.pnl) : '-'}</td>
                      <td className="py-2.5 px-3 text-right">{formatCurrency(tot.commissions)}</td>
                      <td className="py-2.5 px-3 text-right">{tot.bonus > 0 ? formatCurrency(tot.bonus) : '-'}</td>
                      <td className="py-2.5 px-3 text-right">{tot.salary > 0 ? formatCurrency(tot.salary) : '-'}</td>
                      <td className="py-2.5 px-3 text-right font-bold">{formatCurrency(tot.total)}</td>
                    </tr>
                  );
                })}
            </tbody>
            <tfoot>
              <tr className="font-bold border-t-2 border-border">
                <td className="py-3 px-3" colSpan={2}>TOTAL</td>
                <td className="py-3 px-3 text-right">{formatCurrency(totalGeneral.netDepositTotal)}</td>
                <td className="py-3 px-3 text-right">{totalGeneral.pnl > 0 ? formatCurrency(totalGeneral.pnl) : '-'}</td>
                <td className="py-3 px-3 text-right">{formatCurrency(totalGeneral.commissions)}</td>
                <td className="py-3 px-3 text-right">{totalGeneral.bonus > 0 ? formatCurrency(totalGeneral.bonus) : '-'}</td>
                <td className="py-3 px-3 text-right">{totalGeneral.salary > 0 ? formatCurrency(totalGeneral.salary) : '-'}</td>
                <td className="py-3 px-3 text-right text-primary dark:text-accent">{formatCurrency(totalGeneral.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}
