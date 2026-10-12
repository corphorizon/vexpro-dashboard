'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { ActionButton } from '@/components/payment-orders/action-button';
import { useI18n } from '@/lib/i18n';
import { useAuth, isCompanyAdmin } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { cn } from '@/lib/utils';
import {
  updateCommercialProfile,
  deleteEmployee,
  createEmployee,
  updateEmployee,
} from '@/lib/supabase/mutations';
import { FireModal } from '@/components/fire-modal';
import { Plus, Pencil, Trash2, UserX, UserCheck, UserRound } from 'lucide-react';
import type { Employee, CommercialProfile } from '@/lib/types';
import type { UnifiedEmployee } from '@/lib/hr/employees-list';
import { EmployeeForm } from './employee-form';
import { ProfileForm } from './profile-form';
import { ROW_ACTION_CLASS, ROW_DANGER_CLASS, SearchField } from './hr-ui';
import { EMPLOYEE_STATUS_VIEW } from './hr-view';

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
//
// «Libro mayor» (2026-10-12) — sólo presentación: Panel + FinTable (en
// < 720 px cada persona es una tarjeta con su estado); el estado sale de
// EMPLOYEE_STATUS_VIEW (hr-view.ts, el mismo mapa que usa el CSV — antes
// `STATUS_BADGE_CLASSES` + `STATUS_LABEL_KEYS` acá: «inactivo» en ROJO, que
// es una licencia, no un error; «despedido» en slate crudo con `dark:`); el
// tipo (comercial / administrativo) en gris porque no es un estado; los
// botones de confirmación en línea (borrar, reincorporar) son ActionButton.
// Medición (sin comentarios): antes 18 clases de paleta cruda, 4 `dark:` de
// color y 31 tokens legados; después 0.
// ─────────────────────────────────────────────────────────────────────────────

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

  const statusBadge = (emp: UnifiedEmployee) => {
    const v = EMPLOYEE_STATUS_VIEW[emp.status];
    return <StatusBadge kind={v.kind} label={t(v.labelKey)} />;
  };

  const columns: FinColumn<UnifiedEmployee>[] = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (emp) => <span className={cn(emp.status === 'fired' && 'text-text-3')}>{emp.name}</span>,
      meta: (emp) => emp.email,
      mobileMeta: statusBadge,
    },
    {
      key: 'position',
      header: t('hr.position'),
      hideSm: true,
      cell: (emp) => emp.position || '—',
    },
    {
      key: 'department',
      header: t('hr.department'),
      hideSm: true,
      cell: (emp) => <span className="text-text-2">{emp.department || '—'}</span>,
    },
    {
      key: 'type',
      header: t('hr.type'),
      hideSm: true,
      cell: (emp) => (
        <span className="text-text-2">
          {emp.source === 'commercial' ? t('hr.typeCommercial') : t('hr.typeAdmin')}
        </span>
      ),
    },
    {
      key: 'hireDate',
      header: t('hr.hireDate'),
      hideSm: true,
      cell: (emp) => <span className="tabular-nums text-text-2">{emp.start_date || '—'}</span>,
    },
    {
      key: 'terminationDate',
      header: t('hr.terminationDate'),
      hideSm: true,
      cell: (emp) => <span className="tabular-nums text-text-2">{emp.termination_date || '—'}</span>,
    },
    // Sueldo no cargado = «—» (antes «N/A»), nunca $0.
    { key: 'salary', header: t('hr.salary'), kind: 'money', value: (emp) => emp.salary, subtotal: false },
    { key: 'status', header: t('hr.status'), hideSm: true, cell: statusBadge },
  ];

  const rowActions = (emp: UnifiedEmployee) => (
    <>
      {/* Ver perfil: comerciales → /rrhh/perfil?id=…, administrativos → abren
          el EmployeeForm en modo edición (no hay página de perfil para
          `employees` todavía). */}
      {emp.source === 'commercial' && emp.originalProfile ? (
        <Link
          href={`/rrhh/perfil?id=${emp.originalProfile.id}`}
          className={ROW_ACTION_CLASS}
          aria-label={t('hr.viewProfile')}
          title={t('hr.viewProfile')}
        >
          <UserRound aria-hidden className="size-[15px]" strokeWidth={1.75} />
        </Link>
      ) : emp.source === 'employee' && emp.originalEmployee ? (
        <button
          type="button"
          onClick={() => { setEditingEmp(emp.originalEmployee!); setShowEmpForm(true); }}
          className={ROW_ACTION_CLASS}
          aria-label={t('hr.viewProfile')}
          title={t('hr.viewProfile')}
        >
          <UserRound aria-hidden className="size-[15px]" strokeWidth={1.75} />
        </button>
      ) : null}

      {emp.source === 'commercial' && emp.originalProfile && emp.status === 'active' && (
        <button
          type="button"
          onClick={() => setFiringProfile(emp.originalProfile!)}
          className={ROW_DANGER_CLASS}
          aria-label={t('hr.fire')}
          title={t('hr.fire')}
        >
          <UserX aria-hidden className="size-[15px]" strokeWidth={1.75} />
        </button>
      )}

      {emp.source === 'commercial' && emp.originalProfile && emp.status === 'fired' && isCompanyAdmin(user) && (
        reinstatingProfile?.id === emp.originalProfile.id ? (
          <span className="inline-flex items-center gap-1">
            <ActionButton
             
              onClick={() => handleReinstate(emp.originalProfile!)}
              loading={reinstating}
            >
              {t('hr.reinstate')}
            </ActionButton>
            <ActionButton
              variant="ghost"
             
              onClick={() => setReinstatingProfile(null)}
              disabled={reinstating}
            >
              {t('common.no')}
            </ActionButton>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setReinstatingProfile(emp.originalProfile!)}
            className={ROW_ACTION_CLASS}
            aria-label={t('hr.reinstate')}
            title={t('hr.reinstate')}
          >
            <UserCheck aria-hidden className="size-[15px]" strokeWidth={1.75} />
          </button>
        )
      )}

      <button
        type="button"
        onClick={() => {
          if (emp.source === 'employee' && emp.originalEmployee) {
            setEditingEmp(emp.originalEmployee);
            setShowEmpForm(true);
          } else if (emp.source === 'commercial' && emp.originalProfile) {
            setEditingProfile(emp.originalProfile);
            setShowProfileForm(true);
          }
        }}
        className={ROW_ACTION_CLASS}
        aria-label={t('common.edit')}
        title={t('common.edit')}
      >
        <Pencil aria-hidden className="size-[15px]" strokeWidth={1.75} />
      </button>
      {emp.source === 'employee' && (
        deletingId === emp.id ? (
          <span className="inline-flex items-center gap-1">
            <ActionButton variant="danger" onClick={() => handleDeleteEmployee(emp.id)}>
              {t('common.delete')}
            </ActionButton>
            <ActionButton variant="ghost" onClick={() => setDeletingId(null)}>
              {t('common.no')}
            </ActionButton>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setDeletingId(emp.id)}
            className={ROW_DANGER_CLASS}
            aria-label={t('common.delete')}
            title={t('common.delete')}
          >
            <Trash2 aria-hidden className="size-[15px]" strokeWidth={1.75} />
          </button>
        )
      )}
    </>
  );

  return (
    <div className="space-y-4">
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

      <Panel
        title={tab === 'terminated' ? t('hr.terminatedTab') : t('hr.employees')}
        hint={t('hrv.peopleCount', { n: String(list.length) })}
        actions={
          <>
            <SearchField
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={t('hr.searchEmployees')}
              className="w-64"
            />
            {tab === 'employees' && (
              <ActionButton variant="primary" onClick={() => { setEditingEmp(undefined); setShowEmpForm(true); }}>
                <Plus aria-hidden className="size-[15px]" strokeWidth={1.75} /> {t('hr.addEmployee')}
              </ActionButton>
            )}
          </>
        }
        flush
      >
        <FinTable
          columns={columns}
          rows={list}
          rowKey={(emp) => `${emp.source}-${emp.id}`}
          caption={tab === 'terminated' ? t('hr.terminatedTab') : t('hr.employees')}
          empty={
            searchQuery
              ? t('hr.noSearchResults')
              : tab === 'terminated' ? t('hr.noTerminated') : t('hr.noEmployees')
          }
          rowActions={rowActions}
        />
      </Panel>

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
    </div>
  );
}
