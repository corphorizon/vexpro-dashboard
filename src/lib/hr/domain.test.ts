import { describe, it, expect } from 'vitest';
import {
  bdmsConEquipo,
  HR_COMMERCIAL_ROLES,
  HR_LEADER_ROLES,
  ROLE_LABELS_HR,
  esBdm,
  esBdmGlobal,
  esLider,
  estaActivo,
  estaDespedido,
  hrRoleBadgeClass,
  hrRoleLabel,
  possibleHeads,
  puedeSerHeadDe,
  tieneEquipoPropio,
  sinSalario,
} from './domain';

// Los tests ITERAN sobre el registro (no repiten la lista): agregar un rol
// nuevo sin decidir si lidera o no rompe acá, en vez de pasar desapercibido.

describe('registro de roles comerciales', () => {
  it('tiene etiqueta en los dos idiomas para todos los roles', () => {
    for (const r of HR_COMMERCIAL_ROLES) {
      expect(hrRoleLabel(r, 'es')).toBeTruthy();
      expect(hrRoleLabel(r, 'en')).toBeTruthy();
    }
  });

  it('cada rol es líder o no, y los líderes son exactamente HR_LEADER_ROLES', () => {
    const lideres = HR_COMMERCIAL_ROLES.filter(esLider);
    expect([...lideres].sort()).toEqual([...HR_LEADER_ROLES].sort());
  });

  it('un rol desconocido se capitaliza en vez de romper', () => {
    expect(hrRoleLabel('closer')).toBe('Closer');
    expect(esLider('closer')).toBe(false);
    expect(esBdm('closer')).toBe(false);
  });

  it('un rol desconocido recibe el badge por defecto, no undefined', () => {
    expect(hrRoleBadgeClass('closer')).toBeTruthy();
    expect(hrRoleBadgeClass('closer')).not.toBe(hrRoleBadgeClass('bdm'));
  });

  it('ROLE_LABELS_HR (compat) devuelve lo mismo que hrRoleLabel', () => {
    for (const r of HR_COMMERCIAL_ROLES) expect(ROLE_LABELS_HR[r]).toBe(hrRoleLabel(r));
    expect(ROLE_LABELS_HR['closer']).toBe('Closer');
  });

  it('bdm_global es BDM y además global', () => {
    expect(esBdm('bdm_global')).toBe(true);
    expect(esBdmGlobal('bdm_global')).toBe(true);
    expect(esBdmGlobal('bdm')).toBe(false);
  });
});

describe('jerarquía', () => {
  it('sólo un líder puede tener gente a cargo', () => {
    expect(puedeSerHeadDe('head', 'bdm')).toBe(true);
    expect(puedeSerHeadDe('sales_manager', 'head')).toBe(true);
    expect(puedeSerHeadDe('bdm', 'bdm')).toBe(false);
    expect(puedeSerHeadDe('bdm_global', 'bdm')).toBe(false);
  });

  it('un head puede colgar de otro head (la estructura real de Vex Pro)', () => {
    expect(puedeSerHeadDe('head', 'head')).toBe(true);
  });

  it('possibleHeads devuelve sólo líderes y excluye al propio perfil', () => {
    const perfiles = [
      { id: 'a', role: 'sales_manager' },
      { id: 'b', role: 'head' },
      { id: 'c', role: 'bdm' },
      { id: 'd', role: 'closer' },
    ];
    expect(possibleHeads(perfiles).map((p) => p.id)).toEqual(['a', 'b']);
    expect(possibleHeads(perfiles, { excludeId: 'b' }).map((p) => p.id)).toEqual(['a']);
  });

  it('possibleHeads con incluirBdms suma los BDM (excepción Master IB)', () => {
    const perfiles = [
      { id: 'a', role: 'sales_manager' },
      { id: 'ana', role: 'bdm' },
      { id: 'glob', role: 'bdm_global' },
      { id: 'd', role: 'closer' },
    ];
    // Sin el flag, el selector queda EXACTAMENTE como estaba.
    expect(possibleHeads(perfiles).map((p) => p.id)).toEqual(['a']);
    expect(possibleHeads(perfiles, { incluirBdms: true }).map((p) => p.id)).toEqual(['a', 'ana', 'glob']);
    // El rol libre sigue afuera con y sin flag.
    expect(possibleHeads(perfiles, { incluirBdms: true }).some((p) => p.id === 'd')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EQUIPO PROPIO — y por qué un Master IB no lo es (migración 129)
// ─────────────────────────────────────────────────────────────────────────────
describe('tieneEquipoPropio', () => {
  const activo = (id: string, head_id: string | null, is_master_ib = false) =>
    ({ id, head_id, is_master_ib, status: 'active', termination_date: null });

  it('un hijo activo cuenta como equipo', () => {
    expect(tieneEquipoPropio('ana', [activo('ana', 'hugo'), activo('sub', 'ana')])).toBe(true);
  });

  it('un hijo MASTER IB NO cuenta: el BDM padre sigue siendo BDM', () => {
    // Jose Emanuel colgando de Ana García (2026-09-06): la RPC ya le corta la
    // subred a Ana, pero Ana conserva sus tramos de % por volumen.
    expect(tieneEquipoPropio('ana', [activo('ana', 'hugo'), activo('master', 'ana', true)])).toBe(false);
    // Y si además tiene un BDM propio, sí tiene equipo.
    expect(
      tieneEquipoPropio('ana', [activo('ana', 'hugo'), activo('master', 'ana', true), activo('sub', 'ana')]),
    ).toBe(true);
  });

  it('un DESPEDIDO sigue contando como equipo (se le cargan ND negativos)', () => {
    const despedido = { id: 'x', head_id: 'ana', status: 'inactive', termination_date: '2026-08-01' };
    expect(tieneEquipoPropio('ana', [despedido])).toBe(true);
  });

  it('un inactivo SIN fecha de baja (licencia) no cuenta', () => {
    const enPausa = { id: 'x', head_id: 'ana', status: 'inactive', termination_date: null };
    expect(tieneEquipoPropio('ana', [enPausa])).toBe(false);
  });

  it('sin hijos, no hay equipo', () => {
    expect(tieneEquipoPropio('ana', [activo('ana', 'hugo')])).toBe(false);
  });
});

describe('bdmsConEquipo', () => {
  const perfil = (
    id: string,
    role: string,
    head_id: string | null,
    is_master_ib = false,
    status = 'active',
    termination_date: string | null = null,
  ) => ({ id, role, head_id, is_master_ib, status, termination_date });

  const ana = perfil('ana', 'bdm', 'luka');
  const luka = perfil('luka', 'head', null);
  const master = perfil('master', 'bdm', 'ana', true);

  it('un BDM con un MASTER IB colgado SÍ lidera grupo (al revés que tieneEquipoPropio)', () => {
    // Las dos preguntas conviven a propósito: la de la plata ignora al master,
    // la de la pantalla lo cuenta — es la línea que ese grupo muestra.
    expect(bdmsConEquipo([luka, ana, master]).map((p) => p.id)).toEqual(['ana']);
    expect(tieneEquipoPropio('ana', [luka, ana, master])).toBe(false);
  });

  it('sin ningún master configurado la lista es vacía (la regresión que importa)', () => {
    expect(bdmsConEquipo([luka, ana])).toEqual([]);
  });

  it('un head con equipo NO entra: tiene su propio selector', () => {
    expect(bdmsConEquipo([luka, ana, master]).some((p) => p.id === 'luka')).toBe(false);
    expect(bdmsConEquipo([perfil('sm', 'sales_manager', null), perfil('x', 'bdm', 'sm')])).toEqual([]);
  });

  it('BDM GLOBAL con gente colgada también cuenta como líder', () => {
    const global = perfil('glob', 'bdm_global', 'luka');
    expect(bdmsConEquipo([global, perfil('m2', 'bdm', 'glob', true)]).map((p) => p.id)).toEqual(['glob']);
  });

  it('un hijo DESPEDIDO cuenta; uno en licencia (inactive sin fecha) no', () => {
    const despedido = perfil('m', 'bdm', 'ana', true, 'inactive', '2026-08-01');
    const enPausa = perfil('m', 'bdm', 'ana', true, 'inactive', null);
    expect(bdmsConEquipo([ana, despedido]).map((p) => p.id)).toEqual(['ana']);
    expect(bdmsConEquipo([ana, enPausa])).toEqual([]);
  });

  it('un rol desconocido colgando de un BDM igual lo hace líder de grupo', () => {
    // La pregunta es «¿tiene gente colgada?», no «¿de qué rol?».
    expect(bdmsConEquipo([ana, perfil('c', 'closer', 'ana')]).map((p) => p.id)).toEqual(['ana']);
  });
});

describe('predicados de estado', () => {
  it('despedido exige inactive Y fecha (un inactive a secas NO lo es)', () => {
    expect(estaDespedido({ status: 'inactive', termination_date: '2026-08-01' })).toBe(true);
    expect(estaDespedido({ status: 'inactive', termination_date: null })).toBe(false);
    expect(estaDespedido({ status: 'active', termination_date: '2026-08-01' })).toBe(false);
    expect(estaDespedido(null)).toBe(false);
    expect(estaDespedido(undefined)).toBe(false);
  });

  it('activo es sólo status active', () => {
    expect(estaActivo({ status: 'active' })).toBe(true);
    expect(estaActivo({ status: 'inactive' })).toBe(false);
    expect(estaActivo(null)).toBe(false);
  });

  it('sinSalario trata null y 0 igual — es el checklist de "falta cargarlo"', () => {
    expect(sinSalario({ salary: null })).toBe(true);
    expect(sinSalario({ salary: 0 })).toBe(true);
    expect(sinSalario({})).toBe(true);
    expect(sinSalario({ salary: 1000 })).toBe(false);
    expect(sinSalario({ salary: '1500' })).toBe(false);
  });
});
