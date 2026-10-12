import { describe, it, expect, vi } from 'vitest';
import {
  NAV_ENTRIES,
  findNavEntry,
  groupPendingTotal,
  initialOpenGroups,
  isGroupCollapsible,
  navOpenStorageKey,
  readOpenGroups,
  writeOpenGroups,
} from './module-groups';
import { translations } from './i18n';

// Estado del menú desplegable (2026-10-12). Se prueba la lógica pura que usa
// el sidebar; el componente sólo la cablea.
vi.mock('@/lib/auth-context', () => ({ hasModuleAccess: () => true }));

const KEY = navOpenStorageKey('u1', 'c1');

function memoryStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(KEY, initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe('estado inicial del acordeón', () => {
  it('sin nada guardado abre sólo el grupo de la ruta activa', () => {
    const active = findNavEntry('/egresos')?.group ?? null;
    expect(active).toBe('finance');
    expect([...initialOpenGroups(null, active)]).toEqual(['finance']);
  });

  it('lo guardado se suma al activo, que siempre queda abierto', () => {
    const open = initialOpenGroups(['hr'], 'finance');
    expect(open.has('hr')).toBe(true);
    expect(open.has('finance')).toBe(true);
  });

  it('una ruta fuera de grupo (home) no abre nada por sí sola', () => {
    expect(initialOpenGroups(null, findNavEntry('/')?.group ?? null).size).toBe(0);
  });
});

describe('persistencia', () => {
  it('la clave es por usuario Y empresa', () => {
    expect(navOpenStorageKey('u1', 'c1')).not.toBe(navOpenStorageKey('u1', 'c2'));
    expect(navOpenStorageKey('u1', 'c1')).not.toBe(navOpenStorageKey('u2', 'c1'));
  });

  it('escribe y vuelve a leer', () => {
    const s = memoryStorage();
    expect(writeOpenGroups(s, KEY, new Set(['finance', 'hr'] as const))).toBe(true);
    expect(readOpenGroups(s, KEY)).toEqual(['finance', 'hr']);
  });

  it('distingue «nada guardado» (null) de «cerró todo» ([])', () => {
    expect(readOpenGroups(memoryStorage(), KEY)).toBeNull();
    expect(readOpenGroups(memoryStorage('[]'), KEY)).toEqual([]);
  });

  it('tolera JSON roto, tipos equivocados y claves desconocidas', () => {
    expect(readOpenGroups(memoryStorage('{no json'), KEY)).toBeNull();
    expect(readOpenGroups(memoryStorage('{"finance":true}'), KEY)).toBeNull();
    expect(readOpenGroups(memoryStorage('"finance"'), KEY)).toBeNull();
    expect(readOpenGroups(memoryStorage('["finance",3,"nope","hr"]'), KEY)).toEqual(['finance', 'hr']);
  });

  it('tolera un storage que lanza o que no existe', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readOpenGroups(throwing, KEY)).toBeNull();
    expect(writeOpenGroups(throwing, KEY, ['finance'])).toBe(false);
    expect(readOpenGroups(null, KEY)).toBeNull();
    expect(writeOpenGroups(undefined, KEY, ['finance'])).toBe(false);
  });
});

describe('contadores de un grupo cerrado', () => {
  const entries = [
    { pendingKey: 'paymentOrdersPending' as const },
    { pendingKey: 'withdrawalsToReview' as const },
    {},
  ];

  it('suma los contadores > 0 del grupo', () => {
    expect(groupPendingTotal(entries, { paymentOrdersPending: 3, withdrawalsToReview: 4 })).toBe(7);
  });

  it('ausente, cero, negativo o no numérico no suma (no se sabe ≠ hay)', () => {
    expect(groupPendingTotal(entries, undefined)).toBe(0);
    expect(groupPendingTotal(entries, {})).toBe(0);
    expect(groupPendingTotal(entries, { paymentOrdersPending: 0, withdrawalsToReview: -2 })).toBe(0);
    expect(groupPendingTotal(entries, { paymentOrdersPending: Number.NaN })).toBe(0);
    expect(groupPendingTotal(entries, { paymentOrdersPending: 2 })).toBe(2);
  });

  it('cada ítem con pendingKey existe en el registro de navegación', () => {
    const keys = NAV_ENTRIES.filter((e) => e.pendingKey).map((e) => e.pendingKey);
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe('grupo de un solo ítem', () => {
  it('no colapsa; con dos o más sí', () => {
    expect(isGroupCollapsible(0)).toBe(false);
    expect(isGroupCollapsible(1)).toBe(false);
    expect(isGroupCollapsible(2)).toBe(true);
  });
});

describe('textos nuevos', () => {
  it('las claves de expandir/contraer todo existen en es y en', () => {
    for (const locale of ['es', 'en'] as const) {
      const dict = translations[locale] as Record<string, string>;
      expect(dict['nav.collapseAll']).toBeTruthy();
      expect(dict['nav.expandAll']).toBeTruthy();
    }
  });
});
