import { describe, it, expect } from 'vitest';
import {
  MODULES,
  MODULE_KEYS,
  MODULE_LABELS,
  MODULE_KEY_SET,
  RESERVED_MODULE_KEYS,
  sanitizeModuleKeys,
  moduleLabel,
} from './modules';
import { BUILT_IN_ROLES, isBuiltInRole, roleCanWrite } from './roles';

// Estos tests existen porque la lista de módulos vivía duplicada en cuatro
// archivos y se desincronizó en producción: `ib_rebates` faltaba en la lista
// blanca del endpoint y se borraba en silencio de seis usuarios reales.

describe('registro de módulos', () => {
  it('no tiene claves duplicadas', () => {
    expect(new Set(MODULE_KEYS).size).toBe(MODULE_KEYS.length);
  });

  it('todas las claves tienen etiqueta en los dos idiomas', () => {
    for (const m of MODULES) {
      expect(m.labelEs.trim()).not.toBe('');
      expect(m.labelEn.trim()).not.toBe('');
    }
  });

  it('MODULE_LABELS cubre exactamente MODULE_KEYS', () => {
    expect(Object.keys(MODULE_LABELS).sort()).toEqual([...MODULE_KEYS].sort());
  });

  it('incluye los módulos que se habían perdido en alguna de las copias', () => {
    expect(MODULE_KEY_SET.has('payment_orders')).toBe(true);
    expect(MODULE_KEY_SET.has('ib_rebates')).toBe(true);
  });

  it('no expone los módulos reservados del superadmin', () => {
    for (const reserved of RESERVED_MODULE_KEYS) {
      expect(MODULE_KEY_SET.has(reserved)).toBe(false);
    }
  });

  it('el padre de un submódulo es un módulo real', () => {
    for (const m of MODULES) {
      if (m.parent) expect(MODULE_KEY_SET.has(m.parent)).toBe(true);
    }
  });
});

describe('sanitizeModuleKeys', () => {
  it('conserva las claves válidas y descarta el resto', () => {
    expect(sanitizeModuleKeys(['summary', 'audit', 'inventado', 'ib_rebates']))
      .toEqual(['summary', 'ib_rebates']);
  });

  it('deduplica', () => {
    expect(sanitizeModuleKeys(['summary', 'summary'])).toEqual(['summary']);
  });

  it('tolera payloads que no son arrays', () => {
    expect(sanitizeModuleKeys(null)).toEqual([]);
    expect(sanitizeModuleKeys('summary')).toEqual([]);
    expect(sanitizeModuleKeys([1, {}, undefined])).toEqual([]);
  });
});

describe('moduleLabel', () => {
  it('traduce y cae a la clave cruda si no existe', () => {
    expect(moduleLabel('payment_orders', 'es')).toBe('Órdenes de Pago');
    expect(moduleLabel('payment_orders', 'en')).toBe('Payment Orders');
    expect(moduleLabel('no_existe')).toBe('no_existe');
  });
});

describe('registro de roles', () => {
  // Espejo del CHECK de company_users.role. Si este test falla, la base y la
  // app dejaron de coincidir y hay que migrar antes de tocar la lista.
  it('coincide con el CHECK de la base', () => {
    expect([...BUILT_IN_ROLES].sort()).toEqual(
      ['admin', 'auditor', 'hr', 'invitado', 'socio', 'soporte'],
    );
  });

  it('acepta los 6 roles reales y rechaza los inventados', () => {
    for (const r of BUILT_IN_ROLES) expect(isBuiltInRole(r)).toBe(true);
    // 'viewer' lo aceptaba el endpoint de edición pero no existe en la base.
    expect(isBuiltInRole('viewer')).toBe(false);
    // Los roles personalizados siguen pausados: el CHECK los rechaza.
    expect(isBuiltInRole('custom:tesoreria')).toBe(false);
    expect(isBuiltInRole('superadmin')).toBe(false);
    expect(isBuiltInRole(null)).toBe(false);
  });

  it('separa quién puede escribir de quién solo mira', () => {
    expect(roleCanWrite('admin')).toBe(true);
    expect(roleCanWrite('auditor')).toBe(true);
    expect(roleCanWrite('hr')).toBe(true);
    // socio/soporte/invitado son de solo lectura por más módulos que tengan.
    expect(roleCanWrite('socio')).toBe(false);
    expect(roleCanWrite('soporte')).toBe(false);
    expect(roleCanWrite('invitado')).toBe(false);
  });
});
