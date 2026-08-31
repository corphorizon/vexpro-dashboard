import { describe, it, expect } from 'vitest';
import {
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
