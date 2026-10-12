import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MODULES, MODULE_KEY_SET } from './modules';
import {
  NAV_ENTRIES,
  NAV_GROUPS,
  MODULE_GROUPS,
  findNavEntry,
  isNavHrefActive,
} from './module-groups';
import { resolveModule } from './route-modules';
import { translations } from './i18n';

// ─────────────────────────────────────────────────────────────────────────────
// El registro único de navegación (2026-10-12, Fase 4). Existe porque la
// navegación vivía en TRES listas (sidebar, module-groups, accesos rápidos) y
// ya se habían separado: Forecast y Registro faltaban en module-groups, así
// que un usuario de un solo grupo no veía Forecast en el menú.
// ─────────────────────────────────────────────────────────────────────────────

// auth-context crea el cliente de Supabase al importarse (necesita env). El
// registro sólo usa `hasModuleAccess`, que es un adaptador de
// `canAccessModule` (testeado en module-access.test.ts): acá no se prueba
// acceso, se prueba la forma del registro.
vi.mock('@/lib/auth-context', () => ({ hasModuleAccess: () => true }));

const DASHBOARD_DIR = path.resolve(__dirname, '../app/(dashboard)');

describe('registro de navegación', () => {
  it('cada módulo con pantalla tiene al menos una entrada de navegación', () => {
    // Los submódulos (`parent`) viven dentro de la pantalla de otro módulo
    // (ib_rebates es una pestaña de RRHH): no tienen destino propio.
    const conPantalla = MODULES.filter((m) => !m.parent).map((m) => m.key);
    const enMenu = new Set<string>(NAV_ENTRIES.map((e) => e.module));
    const faltan = conPantalla.filter((k) => !enMenu.has(k));
    expect(faltan, `módulos sin entrada en NAV_ENTRIES: ${faltan.join(', ')}`).toEqual([]);
  });

  it('cada entrada apunta a un módulo real', () => {
    for (const e of NAV_ENTRIES) expect(MODULE_KEY_SET.has(e.module), e.href).toBe(true);
  });

  it('no hay hrefs duplicados', () => {
    const hrefs = NAV_ENTRIES.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('cada entrada apunta a una página que existe', () => {
    for (const e of NAV_ENTRIES) {
      const file = path.join(DASHBOARD_DIR, e.href === '/' ? '' : e.href, 'page.tsx');
      expect(existsSync(file), `${e.href} → ${file}`).toBe(true);
    }
  });

  it('cada rótulo (entradas y grupos) existe en en y es', () => {
    const keys = [...NAV_ENTRIES.map((e) => e.i18nKey), ...NAV_GROUPS.map((g) => g.i18nKey)];
    for (const k of keys) {
      expect(translations.en[k], `en: ${k}`).toBeTruthy();
      expect(translations.es[k], `es: ${k}`).toBeTruthy();
    }
  });

  it('el guardián de rutas protege cada entrada con el MISMO módulo que el menú', () => {
    // Si difieren, el menú muestra una pantalla que el guardián bloquea (o al
    // revés: el menú la esconde y la URL escrita a mano entra). Así se
    // encontró que /finanzas/crm no tenía guardián.
    for (const e of NAV_ENTRIES) {
      if (e.href === '/') continue; // la home es siempre accesible (ALWAYS_ALLOWED)
      expect(resolveModule(e.href), e.href).toBe(e.module);
    }
  });

  it('cada entrada (salvo la home) tiene grupo, y cada grupo tiene entradas', () => {
    for (const e of NAV_ENTRIES) {
      if (e.href !== '/') expect(e.group, e.href).not.toBeNull();
    }
    for (const g of NAV_GROUPS) {
      expect(NAV_ENTRIES.some((e) => e.group === g.key), g.key).toBe(true);
    }
  });

  it('el homeHref de cada grupo es una entrada de ese grupo', () => {
    for (const g of NAV_GROUPS) {
      const home = NAV_ENTRIES.find((e) => e.href === g.homeHref);
      expect(home?.group, g.key).toBe(g.key);
    }
  });
});

describe('MODULE_GROUPS (derivado)', () => {
  it('contiene exactamente las entradas agrupadas del registro, en orden', () => {
    const derivados = MODULE_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    const registro = NAV_GROUPS.flatMap((g) =>
      NAV_ENTRIES.filter((e) => e.group === g.key).map((e) => e.href),
    );
    expect(derivados).toEqual(registro);
  });

  it('incluye Forecast y Registro de Actividad (las que faltaban)', () => {
    const hrefs = MODULE_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toContain('/finanzas/forecast');
    expect(hrefs).toContain('/logs');
  });
});

describe('findNavEntry — qué ítem está activo', () => {
  it('gana el href más largo', () => {
    expect(findNavEntry('/rrhh/dashboard')?.href).toBe('/rrhh/dashboard');
    expect(findNavEntry('/rrhh')?.href).toBe('/rrhh');
    expect(findNavEntry('/rrhh/perfil/123')?.href).toBe('/rrhh');
  });

  it('las rutas hijas iluminan a su padre', () => {
    expect(findNavEntry('/movimientos/desglose/coinsbuy')?.href).toBe('/movimientos');
  });

  it('la home sólo matchea exacto', () => {
    expect(findNavEntry('/')?.href).toBe('/');
    expect(isNavHrefActive('/', '/egresos')).toBe(false);
  });

  it('un prefijo de texto no es una ruta hija', () => {
    // /liquidez-pool NO está debajo de /liquidez.
    expect(findNavEntry('/liquidez-pool')?.href).toBe('/liquidez-pool');
    expect(isNavHrefActive('/liquidez', '/liquidez-pool')).toBe(false);
  });

  it('una ruta fuera del menú no tiene entrada', () => {
    expect(findNavEntry('/perfil')).toBeNull();
  });
});
