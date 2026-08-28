// Gate por slice de /api/bootstrap.
//
// Lo que este test protege es concreto: la ruta responde con el ADMIN CLIENT y
// el service role NO pasa por RLS. Si el gate se cae, la nómina (sueldos,
// motivos de despido, contratos) sale por la API para cualquiera con sesión.
// Antes de la ruta ese filtro lo hacía la migración 064 en la DB.
//
// Se itera sobre BUILT_IN_ROLES a propósito: agregar un rol nuevo rompe el
// test en vez de pasar desapercibido.

import { describe, it, expect } from 'vitest';
import {
  BOOTSTRAP_SLICES,
  HR_GATED_SLICES,
  CRITICAL_SLICES,
  esLectorDeRrhh,
  puedeLeerSlicesRrhh,
  slicesVedados,
} from './bootstrap-slices';
import { BUILT_IN_ROLES } from './roles';
import { MODULE_KEYS } from './modules';

/** Empresa con todos los módulos contratados, modelo broker. */
const empresaCompleta = {
  activeModules: MODULE_KEYS,
  businessModel: 'broker',
};

function ctx(role: string, extra: Record<string, unknown> = {}) {
  return {
    role,
    isSuperadmin: false,
    // allowed_modules con TODO: aisla la variable rol de la variable módulo.
    allowedModules: MODULE_KEYS,
    ...empresaCompleta,
    ...extra,
  };
}

describe('registro de slices', () => {
  it('tiene los 20 slices del arranque, sin duplicados', () => {
    expect(BOOTSTRAP_SLICES).toHaveLength(20);
    expect(new Set(BOOTSTRAP_SLICES).size).toBe(20);
  });

  it('los slices vedados y los críticos son slices reales', () => {
    for (const s of [...HR_GATED_SLICES, ...CRITICAL_SLICES]) {
      expect(BOOTSTRAP_SLICES).toContain(s);
    }
  });

  it('tapa exactamente las tres tablas de RRHH del arranque', () => {
    expect([...HR_GATED_SLICES].sort()).toEqual(
      ['commercialProfiles', 'employees', 'monthlyResults'],
    );
  });
});

describe('gate de RRHH — espejo de auth_is_hr_reader() (migración 064)', () => {
  // La verdad de la DB: solo admin y hr (y el superadmin) leen RRHH.
  const LECTORES = new Set(['admin', 'hr']);

  it.each(BUILT_IN_ROLES.map((r) => [r] as const))(
    'rol %s: el gate coincide con lo que aplica la DB',
    (role) => {
      expect(esLectorDeRrhh(ctx(role))).toBe(LECTORES.has(role));
      expect(puedeLeerSlicesRrhh(ctx(role))).toBe(LECTORES.has(role));
    },
  );

  // La mitad negativa, explícita: son los casos que filtrarían datos.
  it.each(BUILT_IN_ROLES.filter((r) => !LECTORES.has(r)).map((r) => [r] as const))(
    'rol %s recibe employees/commercial_* VACÍOS y enumerados en `gated`',
    (role) => {
      const vedados = slicesVedados(ctx(role));
      expect(vedados).toContain('employees');
      expect(vedados).toContain('commercialProfiles');
      expect(vedados).toContain('monthlyResults');
    },
  );

  it('un usuario con el módulo hr pero rol soporte NO pasa (el rol también manda)', () => {
    expect(puedeLeerSlicesRrhh(ctx('soporte', { allowedModules: ['hr'] }))).toBe(false);
  });

  it('paridad con RLS: el módulo NO influye — un admin sin el módulo hr los recibe igual (auth_is_hr_reader no mira módulos)', () => {
    const sinHr = MODULE_KEYS.filter((m) => m !== 'hr');
    expect(puedeLeerSlicesRrhh(ctx('admin', { activeModules: sinHr }))).toBe(true);
    expect(puedeLeerSlicesRrhh(ctx('hr', { allowedModules: sinHr }))).toBe(true);
    expect(slicesVedados(ctx('admin', { activeModules: sinHr }))).toEqual([]);
  });

  it('admin y hr con el módulo SÍ los reciben (nada vedado)', () => {
    expect(slicesVedados(ctx('admin'))).toEqual([]);
    expect(slicesVedados(ctx('hr'))).toEqual([]);
  });

  it('el superadmin de plataforma los recibe aunque no tenga allowed_modules', () => {
    const superadmin = {
      role: 'admin',
      isSuperadmin: true,
      allowedModules: null,
      ...empresaCompleta,
    };
    expect(puedeLeerSlicesRrhh(superadmin)).toBe(true);
    expect(slicesVedados(superadmin)).toEqual([]);
  });

  it('un rol personalizado desconocido no entra por default', () => {
    expect(puedeLeerSlicesRrhh(ctx('custom:analista'))).toBe(false);
  });
});
