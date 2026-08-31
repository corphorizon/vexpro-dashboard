'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { useI18n } from '@/lib/i18n';
import { useAuth, isCompanyAdmin } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { formatCurrency, cn } from '@/lib/utils';
import {
  updateCommercialProfile,
  deleteEmployee,
  createEmployee,
  updateEmployee,
} from '@/lib/supabase/mutations';
import { FireModal } from '@/components/fire-modal';
import { Search, Plus, Pencil, Trash2, UserX, UserCheck, UserRound } from 'lucide-react';
import type { Employee, CommercialProfile } from '@/lib/types';
import type { UnifiedEmployee } from '@/lib/hr/employees-list';
import { EmployeeForm } from './employee-form';
import { ProfileForm } from './profile-form';

// ─────────────────────────────────────────────────────────────────────────────
// Pestañas EMPLEADOS y DESPEDIDOS — una sola tabla para las dos.
//
// Es UNA sola tabla a propósito: duplicar el JSX era garantizar que dentro de
// tres meses una de las dos tuviera una columna que la otra no. Lo que cambia
// entre pestañas es la lista (la partición por `estaDespedido`, en
// src/lib/hr/employees-list.ts) y el título.
//
// Reglas que se mantienen tal cual estaban en rrhh/page.tsx:
//  · En Despedidos no se da de alta a nadie: si alguien vuelve, se REINCORPORA
//    desde su fila, no se crea de nuevo.
//  · Borrar es sólo para administrativos. Un comercial se despide (status
//    inactive + termination_date) y NUNCA se borra: rompería
//    `commercial_monthly_results` por FK, y el calculador de comisiones necesita
//    poder postear net deposits negativos post-despido vía `profile_id`.
//  · Reincorporar es admin-only en el cliente Y en el servidor.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_BADGE_CLASSES: Record<string, string> = {
  active: 'bg-positive/10 text-positive',
  inactive: 'bg-negative/10 text-negative',
  probation: 'bg-warning/10 text-warning',
  fired: 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400',
};

/** Registro único de las etiquetas de estado; el CSV usa el MISMO mapa. */
export const STATUS_LABEL_KEYS: Record<string, string> = {
  active: 'hr.statusActive',
  inactive: 'hr.statusInactive',
  probation: 'hr.statusProbation',
  fired: 'hr.statusFired',
};

export function EmployeesTab({
  tab,
  list,
  searchQuery,
  setSearchQuery,
  setEmployees,
  onToast,
}: {
  tab: 'employees' | 'terminated';
  /** Ya filtrada y partida por el shell (una sola derivación para tabla y CSV). */
  list: UnifiedEmployee[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  setEmployees: React.Dispatch<React.SetStateAction<Employee[]>>;
  onToast: (t: { type: 'success' | 'error'; msg: string }) => void;
}) {
  const { t } = useI18n();
  const { company, refresh } = useData();
  const { user } = useAuth();

  const [showEmpForm, setShowEmpForm] = useState(false);
  const [editingEmp, setEditingEmp] = useState<Employee | undefined>();
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [editingProfile, setEditingProfile] = useState<CommercialProfile | undefined>();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ─── Fire / Reinstate ───
  const [firingProfile, setFiringProfile] = useState<CommercialProfile | null>(null);
  const [reinstatingProfile, setReinstatingProfile] = useState<CommercialProfile | null>(null);
  const [reinstating, setReinstating] = useState(false);

  const handleSaveEmployee = async (emp: Employee) => {
    // Persistir contra BD vía /api/admin/employees (admin client, bypassea
    // RLS). Antes este handler sólo tocaba state local y al refrescar los
    // empleados nuevos desaparecían. Se distingue create de update por
    // `editingEmp`, no por el id del payload — en create el form arma un id
    // local `emp-…` que no existe en BD.
    try {
      const writable = {
        name: emp.name,
        email: emp.email,
        position: emp.position,
        department: emp.department,
        start_date: emp.start_date,
        salary: emp.salary,
        status: emp.status,
        phone: emp.phone,
        country: emp.country,
        notes: emp.notes,
        birthday: emp.birthday,
        supervisor: emp.supervisor,
        comments: emp.comments,
      };
      if (editingEmp) {
        const saved = await updateEmployee(editingEmp.id, writable);
        setEmployees((prev) => prev.map((e) => (e.id === editingEmp.id ? saved : e)));
      } else {
        const created = await createEmployee(writable);
        setEmployees((prev) => [...prev, created]);
      }
      await refresh();
      onToast({ type: 'success', msg: editingEmp ? t('hr.employeeUpdated') : t('hr.employeeCreated') });
    } catch (err) {
      onToast({ type: 'error', msg: err instanceof Error ? err.message : t('hr.employeeSaveError') });
    } finally {
      setEditingEmp(undefined);
    }
  };

  const handleDeleteEmployee = async (id: string) => {
    // Las filas locales (aún sin persistir) llevan un id no-UUID `emp-<ts>`:
    // para ésas no hay nada que borrar en la base.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    try {
      if (isUuid) await deleteEmployee(id);
      setEmployees((prev) => prev.filter((e) => e.id !== id));
      setDeletingId(null);
      if (isUuid) await refresh();
    } catch (err) {
      setDeletingId(null);
      onToast({ type: 'error', msg: err instanceof Error ? err.message : t('hr.deleteError') });
    }
  };

  const handleFireSuccess = () => {
    // El refresh() silencioso del DataProvider no refleja de forma fiable el
    // status recién persistido (la fila seguía en "Activo" hasta recargar a
    // mano). Se usa el mismo window.location.reload() que ya usan editar y
    // eliminar en este módulo, recordando la pestaña para volver a ella.
    setFiringProfile(null);
    try { sessionStorage.setItem('rrhh-restore-tab', tab); } catch {}
    window.location.reload();
  };

  const handleReinstate = async (profile: CommercialProfile) => {
    if (!isCompanyAdmin(user)) return;
    setReinstating(true);
    try {
      await updateCommercialProfile(profile.id, {
        status: 'active',
        termination_date: null,
        termination_reason: null,
        termination_category: null,
        terminated_by: null,
      });
      // Refrescar primero y recién después limpiar el confirm inline: evita el
      // flash de dato viejo.
      await refresh();
      setReinstatingProfile(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : t('hr.fireError'));
    } finally {
      setReinstating(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <h2 className="text-lg font-semibold">
          {tab === 'terminated' ? t('hr.terminatedTab') : t('hr.employees')}
        </h2>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:w-64">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              aria-label={t('hr.searchEmployees')}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('hr.searchEmployees')}
              className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-border bg-card text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
            />
          </div>
          {tab === 'employees' && (
            <button
              onClick={() => { setEditingEmp(undefined); setShowEmpForm(true); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" /> {t('hr.addEmployee')}
            </button>
          )}
        </div>
      </div>
      {showEmpForm && company && (
        <EmployeeForm
          editing={editingEmp}
          companyId={company.id}
          onClose={() => { setShowEmpForm(false); setEditingEmp(undefined); }}
          onSave={handleSaveEmployee}
        />
      )}
      {/* ProfileForm también acá: la fila comercial en Empleados tiene un botón
          de editar (lápiz) que abre este modal. Sin montarlo en esta pestaña, el
          botón seteaba el estado pero el modal no existía y "no hacía nada". */}
      {showProfileForm && (
        <ProfileForm
          editing={editingProfile}
          onClose={() => { setEditingProfile(undefined); setShowProfileForm(false); }}
          companyId={company?.id || ''}
        />
      )}
      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        <table className="w-full text-sm min-w-[800px]">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
              <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('common.email')}</th>
              <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('hr.position')}</th>
              <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.department')}</th>
              <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden md:table-cell">{t('hr.type')}</th>
              <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.hireDate')}</th>
              <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden lg:table-cell">{t('hr.terminationDate')}</th>
              <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.salary')}</th>
              <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('hr.status')}</th>
              <th className="text-right py-2.5 px-3 text-muted-foreground font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {list.map(emp => {
              const isFired = emp.status === 'fired';
              return (
                <tr key={`${emp.source}-${emp.id}`} className={cn('border-b border-border/50 hover:bg-muted/50 transition-colors', isFired && 'opacity-60')}>
                  <td className="py-2.5 px-3 font-medium">{emp.name}</td>
                  <td className="py-2.5 px-3 text-muted-foreground hidden sm:table-cell">{emp.email}</td>
                  <td className="py-2.5 px-3">{emp.position}</td>
                  <td className="py-2.5 px-3 hidden sm:table-cell">{emp.department}</td>
                  <td className="py-2.5 px-3 hidden md:table-cell">
                    <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium',
                      emp.source === 'commercial'
                        ? 'bg-info/10 text-info'
                        : 'bg-slate-50 dark:bg-slate-900/50 text-slate-700 dark:text-slate-400')}>
                      {emp.source === 'commercial' ? t('hr.typeCommercial') : t('hr.typeAdmin')}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 hidden sm:table-cell">{emp.start_date || '-'}</td>
                  <td className="py-2.5 px-3 hidden lg:table-cell text-muted-foreground">{emp.termination_date || '-'}</td>
                  <td className="py-2.5 px-3 text-right">{emp.salary != null ? formatCurrency(emp.salary) : 'N/A'}</td>
                  <td className="py-2.5 px-3">
                    <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', STATUS_BADGE_CLASSES[emp.status])}>
                      {t(STATUS_LABEL_KEYS[emp.status])}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* Ver perfil: comerciales → /rrhh/perfil?id=…,
                          administrativos → abren el EmployeeForm en modo edición
                          (no hay página de perfil para `employees` todavía). */}
                      {emp.source === 'commercial' && emp.originalProfile ? (
                        <Link
                          href={`/rrhh/perfil?id=${emp.originalProfile.id}`}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={t('hr.viewProfile')}
                          title={t('hr.viewProfile')}
                        >
                          <UserRound className="w-3.5 h-3.5" />
                        </Link>
                      ) : emp.source === 'employee' && emp.originalEmployee ? (
                        <button
                          onClick={() => { setEditingEmp(emp.originalEmployee!); setShowEmpForm(true); }}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={t('hr.viewProfile')}
                          title={t('hr.viewProfile')}
                        >
                          <UserRound className="w-3.5 h-3.5" />
                        </button>
                      ) : null}

                      {emp.source === 'commercial' && emp.originalProfile && emp.status === 'active' && (
                        <button
                          onClick={() => setFiringProfile(emp.originalProfile!)}
                          className="text-muted-foreground hover:text-red-600"
                          aria-label={t('hr.fire')}
                          title={t('hr.fire')}
                        >
                          <UserX className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {emp.source === 'commercial' && emp.originalProfile && emp.status === 'fired' && isCompanyAdmin(user) && (
                        reinstatingProfile?.id === emp.originalProfile.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleReinstate(emp.originalProfile!)}
                              disabled={reinstating}
                              className="px-2 py-0.5 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                            >
                              {reinstating ? '…' : 'OK'}
                            </button>
                            <button
                              onClick={() => setReinstatingProfile(null)}
                              disabled={reinstating}
                              className="px-2 py-0.5 text-xs rounded border border-border hover:bg-muted"
                            >
                              No
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setReinstatingProfile(emp.originalProfile!)}
                            className="text-muted-foreground hover:text-emerald-600"
                            aria-label={t('hr.reinstate')}
                            title={t('hr.reinstate')}
                          >
                            <UserCheck className="w-3.5 h-3.5" />
                          </button>
                        )
                      )}

                      <button
                        onClick={() => {
                          if (emp.source === 'employee' && emp.originalEmployee) {
                            setEditingEmp(emp.originalEmployee);
                            setShowEmpForm(true);
                          } else if (emp.source === 'commercial' && emp.originalProfile) {
                            setEditingProfile(emp.originalProfile);
                            setShowProfileForm(true);
                          }
                        }}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={t('common.edit')}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {emp.source === 'employee' && (
                        deletingId === emp.id ? (
                          <div className="flex items-center gap-1">
                            <button onClick={() => handleDeleteEmployee(emp.id)} className="px-2 py-0.5 text-xs rounded bg-red-500 text-white hover:bg-red-600">OK</button>
                            <button onClick={() => setDeletingId(null)} className="px-2 py-0.5 text-xs rounded border border-border hover:bg-muted">{t('common.no')}</button>
                          </div>
                        ) : (
                          <button onClick={() => setDeletingId(emp.id)} className="text-muted-foreground hover:text-red-500" aria-label={t('common.delete')}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {list.length === 0 && (
        <p className="text-center text-muted-foreground py-8">
          {searchQuery
            ? t('hr.noSearchResults')
            : tab === 'terminated' ? t('hr.noTerminated') : t('hr.noEmployees')}
        </p>
      )}

      {/* FireModal montado acá dentro: en la página vieja colgaba de la raíz
          para que el overlay cubriera todo. Sigue siendo `fixed inset-0`, así
          que el overlay tapa la pantalla igual desde este nivel. */}
      {firingProfile && (
        <FireModal
          profile={firingProfile}
          onClose={() => setFiringProfile(null)}
          onSuccess={handleFireSuccess}
        />
      )}
    </Card>
  );
}
