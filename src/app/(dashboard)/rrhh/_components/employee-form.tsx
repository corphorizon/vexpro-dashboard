'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Panel } from '@/components/ui/panel';
import { Field, Input, Select } from '@/components/ui/field';
import { ActionButton } from '@/components/payment-orders/action-button';
import type { Employee } from '@/lib/types';
import { ROW_ACTION_CLASS } from './hr-ui';
import { EMPLOYEE_STATUS_VIEW } from './hr-view';

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
//
// «Libro mayor» (2026-10-12) — sólo presentación: un Panel en línea con
// Field/Input/Select. Antes el placeholder ERA la etiqueta (desaparecía al
// escribir y el lector de pantalla no la anunciaba) y los inputs usaban
// `border-border`, 1,2:1 contra la superficie. El objeto que llega a `onSave`
// es el mismo. Medición (sin comentarios): antes 1 clase de paleta cruda y 3
// tokens legados; después 0.
// ─────────────────────────────────────────────────────────────────────────────

type EmpStatus = 'active' | 'inactive' | 'probation';
const EMP_STATUSES: readonly EmpStatus[] = ['active', 'inactive', 'probation'];

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
  const [status, setStatus] = useState<EmpStatus>(editing?.status || 'active');
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
    <Panel
      title={editing ? t('hr.editEmployee') : t('hr.newEmployee')}
      actions={
        <button type="button" onClick={onClose} aria-label={t('common.close')} className={ROW_ACTION_CLASS}>
          <X aria-hidden className="size-4" />
        </button>
      }
      footer={
        <span className="flex justify-end">
          <ActionButton variant="primary" onClick={handleSubmit} disabled={!name || !email}>
            {editing ? t('common.save') : t('common.add')}
          </ActionButton>
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label={t('hr.namePlaceholder')} required>
          <Input value={name} onChange={e => setName(e.target.value)} />
        </Field>
        <Field label={t('hr.emailPlaceholder')} required>
          <Input type="email" value={email} onChange={e => setEmail(e.target.value)} />
        </Field>
        <Field label={t('hr.positionPlaceholder')}>
          <Input value={position} onChange={e => setPosition(e.target.value)} />
        </Field>
        <Field label={t('hr.departmentPlaceholder')}>
          <Input value={department} onChange={e => setDepartment(e.target.value)} />
        </Field>
        <Field label={t('hr.startDatePlaceholder')}>
          <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
        </Field>
        <Field label={t('hr.salaryPlaceholder')}>
          <Input type="number" value={salary} onChange={e => setSalary(e.target.value)} className="text-right tabular-nums" />
        </Field>
        <Field label={t('hr.status')}>
          <Select value={status} onChange={e => setStatus(e.target.value as EmpStatus)}>
            {EMP_STATUSES.map((st) => (
              <option key={st} value={st}>{t(EMPLOYEE_STATUS_VIEW[st].labelKey)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t('hr.birthday')}>
          <Input type="date" value={birthday} onChange={e => setBirthday(e.target.value)} />
        </Field>
        <Field label={t('hr.supervisorPlaceholder')}>
          <Input value={supervisor} onChange={e => setSupervisor(e.target.value)} />
        </Field>
        <Field label={t('hr.commentsPlaceholder')} className="md:col-span-3">
          <Input value={comments} onChange={e => setComments(e.target.value)} />
        </Field>
      </div>
    </Panel>
  );
}
