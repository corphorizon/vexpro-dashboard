import { describe, it, expect } from 'vitest';
import {
  buildUnifiedEmployees,
  filterUnifiedEmployees,
  partitionByFired,
} from './employees-list';
import type { CommercialProfile, Employee } from '@/lib/types';

const empleado = (over: Partial<Employee> = {}): Employee => ({
  id: 'e1',
  company_id: 'c1',
  name: 'Laura Admin',
  email: 'laura@vex.com',
  position: 'Contadora',
  department: 'Finanzas',
  start_date: '2025-03-01',
  salary: 1200,
  status: 'active',
  phone: null,
  country: null,
  notes: null,
  birthday: null,
  supervisor: null,
  comments: null,
  ...over,
});

const perfil = (over: Partial<CommercialProfile> = {}): CommercialProfile =>
  ({
    id: 'p1',
    company_id: 'c1',
    name: 'Ana BDM',
    email: 'ana@vex.com',
    role: 'bdm',
    head_id: null,
    status: 'active',
    salary: 1000,
    hire_date: '2025-01-10',
    birthday: null,
    termination_date: null,
    ...over,
  }) as CommercialProfile;

describe('plantilla unificada', () => {
  it('junta administrativos y comerciales sin tocar la base', () => {
    const list = buildUnifiedEmployees([empleado()], [perfil()]);
    expect(list.map((e) => e.source)).toEqual(['employee', 'commercial']);
    expect(list[1].position).toBe('BDM'); // la etiqueta sale del registro
    expect(list[1].department).toBe('Comercial');
  });

  it('el estado "fired" es derivado: inactive + fecha de baja', () => {
    const [c1] = buildUnifiedEmployees([], [perfil({ status: 'inactive', termination_date: '2026-06-30' })]);
    expect(c1.status).toBe('fired');
    const [c2] = buildUnifiedEmployees([], [perfil({ status: 'inactive', termination_date: null })]);
    expect(c2.status).toBe('inactive'); // licencia: NO es un despido
  });

  it('el buscador mira nombre, email, puesto y área', () => {
    const list = buildUnifiedEmployees([empleado()], [perfil()]);
    expect(filterUnifiedEmployees(list, 'ana')).toHaveLength(1);
    expect(filterUnifiedEmployees(list, 'FINANZAS')).toHaveLength(1);
    expect(filterUnifiedEmployees(list, 'comercial')).toHaveLength(1);
    expect(filterUnifiedEmployees(list, '')).toHaveLength(2);
    expect(filterUnifiedEmployees(list, 'nadie')).toHaveLength(0);
  });

  it('la partición no pierde a nadie: activos + despedidos = la lista', () => {
    const list = buildUnifiedEmployees(
      [empleado(), empleado({ id: 'e2', status: 'probation', name: 'Prueba' })],
      [
        perfil(),
        perfil({ id: 'p2', name: 'Beto', status: 'inactive', termination_date: '2026-05-01' }),
      ],
    );
    const { activos, despedidos } = partitionByFired(list);
    expect(despedidos.map((e) => e.name)).toEqual(['Beto']);
    expect(activos.length + despedidos.length).toBe(list.length);
  });
});
