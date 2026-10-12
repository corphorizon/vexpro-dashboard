import { describe, expect, it } from 'vitest';
import {
  AUDIT_PAGE_LIMIT,
  SUPERADMIN_NAV,
  USERS_LIST_LIMIT,
  activeSuperadminEntry,
  atLimit,
  auditActionKind,
  companyStatusKind,
  companySummary,
  formatCount,
  formatLastLogin,
  initials,
  membershipCoverage,
  superadminCrumbs,
  twofaKind,
  userStatusKind,
} from './superadmin-model';

describe('activeSuperadminEntry', () => {
  it('cada entrada se activa en su propia ruta', () => {
    for (const e of SUPERADMIN_NAV) {
      expect(activeSuperadminEntry(e.href)?.href).toBe(e.href);
      expect(activeSuperadminEntry(`${e.href}/`)?.href).toBe(e.href);
    }
  });

  it('las subpantallas de entidades activan «Entidades»', () => {
    expect(activeSuperadminEntry('/superadmin/companies/new')?.label).toBe('Entidades');
    expect(activeSuperadminEntry('/superadmin/companies/abc/users')?.label).toBe('Entidades');
    expect(activeSuperadminEntry('/superadmin/viewing/abc')?.label).toBe('Entidades');
  });

  it('/superadmin NO es prefijo de las demás secciones', () => {
    expect(activeSuperadminEntry('/superadmin/users')?.href).toBe('/superadmin/users');
    expect(activeSuperadminEntry('/superadmin/tokens')?.href).toBe('/superadmin/tokens');
  });

  it('rutas ajenas o parecidas no activan nada', () => {
    expect(activeSuperadminEntry(null)).toBeNull();
    expect(activeSuperadminEntry('/')).toBeNull();
    expect(activeSuperadminEntry('/superadminx')).toBeNull();
    expect(activeSuperadminEntry('/superadmin/usersx')).toBeNull();
    expect(activeSuperadminEntry('/superadmin/desconocida')).toBeNull();
  });

  it('no hay dos entradas con el mismo href ni la misma etiqueta', () => {
    expect(new Set(SUPERADMIN_NAV.map((e) => e.href)).size).toBe(SUPERADMIN_NAV.length);
    expect(new Set(SUPERADMIN_NAV.map((e) => e.label)).size).toBe(SUPERADMIN_NAV.length);
  });
});

describe('superadminCrumbs', () => {
  it('sección + página para las subpantallas', () => {
    expect(superadminCrumbs('/superadmin/companies/new')).toEqual({ section: 'Entidades', page: 'Nueva entidad' });
    expect(superadminCrumbs('/superadmin/companies/x')).toEqual({ section: 'Entidades', page: 'Editar entidad' });
    expect(superadminCrumbs('/superadmin/companies/x/users')).toEqual({ section: 'Entidades', page: 'Usuarios de la entidad' });
  });
  it('sin página en las raíces de sección', () => {
    expect(superadminCrumbs('/superadmin')).toEqual({ section: 'Entidades', page: null });
    expect(superadminCrumbs('/superadmin/tokens')).toEqual({ section: 'Tokens de API', page: null });
    expect(superadminCrumbs('/otra')).toEqual({ section: null, page: null });
  });
});

describe('companySummary', () => {
  it('null (no cargó / falló) devuelve null: nunca 0 entidades', () => {
    expect(companySummary(null)).toBeNull();
    expect(companySummary(undefined)).toBeNull();
  });

  it('lista vacía cargada SÍ es cero', () => {
    expect(companySummary([])).toEqual({ total: 0, active: 0, inactive: 0, users: 0, usersMissing: 0 });
  });

  it('cuenta activas, inactivas y suma usuarios', () => {
    const s = companySummary([
      { status: 'active', user_count: 3 },
      { status: 'inactive', user_count: 2 },
      { status: 'active', user_count: 0 },
    ]);
    expect(s).toEqual({ total: 3, active: 2, inactive: 1, users: 5, usersMissing: 0 });
  });

  it('un conteo faltante deja el total en null y lo cuenta', () => {
    const s = companySummary([
      { status: 'active', user_count: 3 },
      { status: 'active', user_count: null },
      { status: 'active', user_count: Number.NaN },
    ]);
    expect(s?.users).toBeNull();
    expect(s?.usersMissing).toBe(2);
  });

  it('un estado desconocido no cuenta como activa', () => {
    expect(companySummary([{ status: 'pending', user_count: 1 }])?.active).toBe(0);
  });
});

describe('recortes', () => {
  it('atLimit: exactamente el techo = puede haber más', () => {
    expect(atLimit(USERS_LIST_LIMIT, USERS_LIST_LIMIT)).toBe(true);
    expect(atLimit(AUDIT_PAGE_LIMIT, AUDIT_PAGE_LIMIT)).toBe(true);
    expect(atLimit(USERS_LIST_LIMIT - 1, USERS_LIST_LIMIT)).toBe(false);
    expect(atLimit(0, 0)).toBe(false);
    expect(atLimit(10, Number.NaN)).toBe(false);
  });

  it('membershipCoverage: el esperado mayor dice cuánto falta', () => {
    expect(membershipCoverage(500, 612)).toEqual({ truncated: true, total: 612 });
    expect(membershipCoverage(10, 11)).toEqual({ truncated: true, total: 11 });
  });

  it('membershipCoverage: en el techo sin esperado = recortado, total desconocido', () => {
    expect(membershipCoverage(500, null)).toEqual({ truncated: true, total: null });
  });

  it('membershipCoverage: completo no avisa', () => {
    expect(membershipCoverage(10, 10)).toEqual({ truncated: false, total: null });
    expect(membershipCoverage(10, null)).toEqual({ truncated: false, total: null });
    expect(membershipCoverage(0, 0)).toEqual({ truncated: false, total: null });
  });

  it('membershipCoverage: un esperado menor nunca esconde filas', () => {
    expect(membershipCoverage(12, 3)).toEqual({ truncated: false, total: null });
    expect(membershipCoverage(12, Number.NaN)).toEqual({ truncated: false, total: null });
  });
});

describe('colores de estado', () => {
  it('sólo «active» es ok; el resto es gris', () => {
    expect(companyStatusKind('active')).toBe('ok');
    expect(companyStatusKind('inactive')).toBe('neutral');
    expect(companyStatusKind(null)).toBe('neutral');
    expect(userStatusKind('active')).toBe('ok');
    expect(userStatusKind('inactive')).toBe('neutral');
    expect(userStatusKind(undefined)).toBe('neutral');
  });

  it('2FA sin configurar requiere acción (es obligatorio)', () => {
    expect(twofaKind(true)).toBe('ok');
    expect(twofaKind(false)).toBe('pend');
    expect(twofaKind(null)).toBe('pend');
  });

  it('auditoría: borrar es malo, crear informativo, lo demás gris', () => {
    expect(auditActionKind('delete')).toBe('bad');
    expect(auditActionKind('create')).toBe('info');
    for (const a of ['update', 'login', 'logout', 'export', 'view', 'otra', null]) {
      expect(auditActionKind(a)).toBe('neutral');
    }
  });
});

describe('formatLastLogin', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const older = () => 'FECHA';
  it('null es «Nunca» y una fecha ilegible es «—»', () => {
    expect(formatLastLogin(null, now, older)).toBe('Nunca');
    expect(formatLastLogin('basura', now, older)).toBe('—');
  });
  it('escalones', () => {
    expect(formatLastLogin('2026-10-12T11:59:40Z', now, older)).toBe('hace un momento');
    expect(formatLastLogin('2026-10-12T11:55:00Z', now, older)).toBe('hace 5 min');
    expect(formatLastLogin('2026-10-12T09:00:00Z', now, older)).toBe('hace 3 h');
    expect(formatLastLogin('2026-10-10T12:00:00Z', now, older)).toBe('hace 2 d');
    expect(formatLastLogin('2026-08-01T12:00:00Z', now, older)).toBe('FECHA');
  });
});

describe('formatCount / initials', () => {
  it('null y no finitos son «—», no 0', () => {
    expect(formatCount(null)).toBe('—');
    expect(formatCount(undefined)).toBe('—');
    expect(formatCount(Number.NaN)).toBe('—');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234)).toMatch(/^1.234$/);
  });
  it('initials', () => {
    expect(initials('Vex Pro Capital')).toBe('VP');
    expect(initials('  ')).toBe('?');
    expect(initials(null)).toBe('?');
  });
});
