// users-view: color de 2FA y activación, recorte de módulos contado, lista
// vacía sospechosa y carga de roles personalizados que no falla en silencio.
import { describe, it, expect } from 'vitest';
import {
  MODULE_CHIPS_MAX,
  parseCustomRoles,
  pendingActivationKind,
  splitModules,
  twofaKind,
  usersListSuspect,
} from './users-view';

describe('twofaKind', () => {
  it('activo = ok', () => {
    expect(twofaKind(true)).toBe('ok');
  });
  it.each([false, null, undefined])('%s = neutral (nunca ok por defecto)', (v) => {
    expect(twofaKind(v)).toBe('neutral');
  });
});

describe('pendingActivationKind', () => {
  it('requiere acción → pend', () => {
    expect(pendingActivationKind()).toBe('pend');
  });
});

describe('splitModules', () => {
  const mods = ['dashboard', 'balances', 'socios', 'egresos', 'ingresos', 'logs'];
  it('corta en el máximo y devuelve los ocultos (para contarlos)', () => {
    const r = splitModules(mods);
    expect(r.shown).toHaveLength(MODULE_CHIPS_MAX);
    expect(r.hidden).toEqual(['ingresos', 'logs']);
    expect(r.shown.length + r.hidden.length).toBe(mods.length);
  });
  it('sin recorte no hay ocultos', () => {
    expect(splitModules(['a', 'b']).hidden).toEqual([]);
    expect(splitModules([]).shown).toEqual([]);
  });
  it('máximo raro no pierde módulos', () => {
    const r = splitModules(mods, -3);
    expect(r.shown).toEqual([]);
    expect(r.hidden).toEqual(mods);
    expect(splitModules(mods, 2.7).shown).toHaveLength(2);
  });
});

describe('usersListSuspect', () => {
  it('lista vacía con sesión = no cargó', () => {
    expect(usersListSuspect([], true)).toBe(true);
  });
  it('con usuarios o sin sesión no es sospechosa', () => {
    expect(usersListSuspect([{}], true)).toBe(false);
    expect(usersListSuspect([], false)).toBe(false);
  });
});

describe('parseCustomRoles', () => {
  it('respuesta buena', () => {
    expect(parseCustomRoles(200, true, { success: true, roles: [{ id: 'r' }] })).toEqual({ state: 'ok', roles: [{ id: 'r' }] });
  });
  it('403 (no admin) = forbidden, no error', () => {
    expect(parseCustomRoles(403, false, { success: false }).state).toBe('forbidden');
  });
  it('500, success:false, sin roles o basura = error', () => {
    expect(parseCustomRoles(500, false, null).state).toBe('error');
    expect(parseCustomRoles(200, true, { success: false }).state).toBe('error');
    expect(parseCustomRoles(200, true, { success: true }).state).toBe('error');
    expect(parseCustomRoles(200, true, 'x').state).toBe('error');
  });
});
