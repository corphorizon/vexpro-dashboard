'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import type { Employee } from '@/lib/types';

// ─────────────────────────────────────────────────────────────────────────────
// Alta/edición de un EMPLEADO ADMINISTRATIVO (tabla `employees`).
//
// Los comerciales NO se cargan acá: viven en `commercial_profiles` y se crean
// desde la pestaña Fuerza Comercial con <ProfileForm>. Son dos formularios
// distintos porque son dos tablas distintas con reglas distintas (un comercial
// no se borra nunca: cuelga de commercial_monthly_results por FK).
//
// El formulario NO persiste: arma el objeto y se lo pasa al padre, que decide
// crear o actualizar contra /api/admin/employees. Se movió acá desde
// rrhh/page.tsx el 2026-08-31 sin cambiarle una línea de comportamiento.
// ─────────────────────────────────────────────────────────────────────────────

export function EmployeeForm({
  onClose,
  onSave,
  editing,
  companyId,
}: {
  onClose: () => void;
  onSave: (e: Employee) => void;
  editing?: Employee;
  companyId: string;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(editing?.name || '');
  const [email, setEmail] = useState(editing?.email || '');
  const [position, setPosition] = useState(editing?.position || '');
  const [department, setDepartment] = useState(editing?.department || '');
  const [startDate, setStartDate] = useState(editing?.start_date || '');
  const [salary, setSalary] = useState(editing?.salary?.toString() || '');
  const [status, setStatus] = useState<'active' | 'inactive' | 'probation'>(editing?.status || 'active');
  const [birthday, setBirthday] = useState(editing?.birthday || '');
  const [supervisor, setSupervisor] = useState(editing?.supervisor || '');
  const [comments, setComments] = useState(editing?.comments || '');

  const handleSubmit = () => {
    if (!name || !email) return;
    onSave({
      id: editing?.id || `emp-${Date.now()}`,
      company_id: editing?.company_id || companyId,
      name, email, position, department, start_date: startDate,
      salary: salary ? parseFloat(salary) : null,
      status, phone: null, country: null, notes: null,
      birthday: birthday || null,
      supervisor: supervisor || null,
      comments: comments || null,
    });
    onClose();
  };

  return (
    <div className="border border-border rounded-lg p-4 mb-4 bg-muted/30">
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-semibold text-sm">{editing ? t('hr.editEmployee') : t('hr.newEmployee')}</h3>
        <button onClick={onClose} aria-label={t('common.close')}><X className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input aria-label={t('hr.namePlaceholder')} placeholder={t('hr.namePlaceholder')} value={name} onChange={e => setName(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm" />
        <input aria-label={t('hr.emailPlaceholder')} placeholder={t('hr.emailPlaceholder')} value={email} onChange={e => setEmail(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm" />
        <input aria-label={t('hr.positionPlaceholder')} placeholder={t('hr.positionPlaceholder')} value={position} onChange={e => setPosition(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm" />
        <input aria-label={t('hr.departmentPlaceholder')} placeholder={t('hr.departmentPlaceholder')} value={department} onChange={e => setDepartment(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm" />
        <input aria-label={t('hr.startDatePlaceholder')} type="date" placeholder={t('hr.startDatePlaceholder')} value={startDate} onChange={e => setStartDate(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm" />
        <input aria-label={t('hr.salaryPlaceholder')} type="number" placeholder={t('hr.salaryPlaceholder')} value={salary} onChange={e => setSalary(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm" />
        <select aria-label={t('hr.status')} value={status} onChange={e => setStatus(e.target.value as 'active' | 'inactive' | 'probation')} className="px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm">
          <option value="active">{t('hr.statusActive')}</option>
          <option value="inactive">{t('hr.statusInactive')}</option>
          <option value="probation">{t('hr.statusProbation')}</option>
        </select>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">{t('hr.birthday')}</label>
          <input aria-label={t('hr.birthday')} type="date" value={birthday} onChange={e => setBirthday(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm" />
        </div>
        <input aria-label={t('hr.supervisorPlaceholder')} placeholder={t('hr.supervisorPlaceholder')} value={supervisor} onChange={e => setSupervisor(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm" />
        <input aria-label={t('hr.commentsPlaceholder')} placeholder={t('hr.commentsPlaceholder')} value={comments} onChange={e => setComments(e.target.value)} className="px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm" />
      </div>
      <div className="mt-3 flex justify-end">
        <button onClick={handleSubmit} className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90">
          {editing ? t('common.save') : t('common.add')}
        </button>
      </div>
    </div>
  );
}
