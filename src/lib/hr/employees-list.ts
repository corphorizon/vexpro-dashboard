// ─────────────────────────────────────────────────────────────────────────────
// La plantilla UNIFICADA: administrativos (`employees`) + comerciales
// (`commercial_profiles`) en una sola lista, y su partición Empleados/Despedidos.
//
// NO se duplica nada en la base: los comerciales siguen viviendo sólo en
// `commercial_profiles`; acá se PRESENTAN junto a los employees para que el
// admin vea toda su gente en un lugar.
//
// «Los que dicen despedido no eliminarlos, sino pasarlos a una pestaña
// diferente… arribita, empleados y al lado despedidos» (Daniela, 27/08/2026).
// No se borra NADA: es la misma lista partida por `estaDespedido` (el registro
// único, en hr/domain.ts). Un `inactive` a secas —licencia, pausa— sigue en
// Empleados, que es donde su jefe lo busca.
//
// Vive en lib/ y no en la pantalla porque es una decisión, no un render: se
// testea sin React y la usan la pestaña y el CSV, que antes podían divergir.
// ─────────────────────────────────────────────────────────────────────────────

import type { CommercialProfile, Employee } from '@/lib/types';
import { estaDespedido, hrRoleLabel } from './domain';

export type UnifiedEmployee = {
  id: string;
  name: string;
  email: string;
  position: string;
  department: string;
  start_date: string;
  termination_date: string | null;
  salary: number | null;
  /** `fired` es DERIVADO (inactive + fecha), no una columna de la base. */
  status: 'active' | 'inactive' | 'probation' | 'fired';
  birthday: string | null;
  supervisor: string | null;
  source: 'employee' | 'commercial';
  originalEmployee?: Employee;
  originalProfile?: CommercialProfile;
};

export function buildUnifiedEmployees(
  employees: readonly Employee[],
  profiles: readonly CommercialProfile[],
): UnifiedEmployee[] {
  const fromEmployees: UnifiedEmployee[] = employees.map((e) => ({
    id: e.id,
    name: e.name,
    email: e.email,
    position: e.position,
    department: e.department,
    start_date: e.start_date,
    termination_date: null, // `employees` no tiene esta columna todavía
    salary: e.salary,
    status: e.status,
    birthday: e.birthday,
    supervisor: e.supervisor,
    source: 'employee',
    originalEmployee: e,
  }));

  const fromCommercial: UnifiedEmployee[] = profiles.map((p) => ({
    id: p.id,
    name: p.name,
    email: p.email,
    position: hrRoleLabel(p.role),
    department: 'Comercial',
    start_date: p.hire_date || '',
    termination_date: p.termination_date,
    salary: p.salary,
    status: estaDespedido(p) ? 'fired' : p.status,
    birthday: p.birthday,
    supervisor: null,
    source: 'commercial',
    originalProfile: p,
  }));

  return [...fromEmployees, ...fromCommercial];
}

/** Buscador libre por nombre, email, puesto o área. Consulta vacía = todo. */
export function filterUnifiedEmployees(
  list: readonly UnifiedEmployee[],
  query: string,
): UnifiedEmployee[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.email.toLowerCase().includes(q) ||
      e.position.toLowerCase().includes(q) ||
      e.department.toLowerCase().includes(q),
  );
}

/** Las dos pestañas, que son la misma lista partida — nunca dos consultas. */
export function partitionByFired(list: readonly UnifiedEmployee[]): {
  activos: UnifiedEmployee[];
  despedidos: UnifiedEmployee[];
} {
  const activos: UnifiedEmployee[] = [];
  const despedidos: UnifiedEmployee[] = [];
  for (const e of list) (e.status === 'fired' ? despedidos : activos).push(e);
  return { activos, despedidos };
}
