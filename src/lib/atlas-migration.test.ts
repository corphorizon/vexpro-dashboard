import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATLAS_URL,
  MIGRATED_TO_ATLAS,
  atlasNoticeDismissKey,
  clearAtlasNoticeDismissals,
  dismissAtlasNotice,
  isAtlasNoticeDismissed,
  isMigratedToAtlas,
} from './atlas-migration';
import { translations } from './i18n';

const VEX_PRO = '71715987-5479-52c4-a990-c414fb3a9b36';
const VONIX = 'ad896227-7bad-426b-b1bf-2ca89e6473d3';
const USER = 'user-1';

/** sessionStorage mínimo para el entorno node. */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => Array.from(m.keys())[i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

describe('MIGRATED_TO_ATLAS', () => {
  it('lista exactamente las 6 empresas migradas el 2026-10-18', () => {
    expect(Object.values(MIGRATED_TO_ATLAS).sort()).toEqual(
      ['AP Markets', 'Horizon', 'Horizon Atlas', 'Horizon Global', 'Vex Pro', 'Vonix'],
    );
  });

  it('todas las llaves son UUID en minúsculas (lo que viaja en company.id)', () => {
    for (const id of Object.keys(MIGRATED_TO_ATLAS)) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('Exura Prime y Exura Liquidez NO están (se quedan en Smart Dashboard)', () => {
    const names = Object.values(MIGRATED_TO_ATLAS).map((n) => n.toLowerCase());
    expect(names.some((n) => n.includes('exura'))).toBe(false);
  });
});

describe('isMigratedToAtlas', () => {
  it('true para cada empresa de la lista', () => {
    for (const id of Object.keys(MIGRATED_TO_ATLAS)) expect(isMigratedToAtlas(id)).toBe(true);
  });

  it('no distingue mayúsculas en el id', () => {
    expect(isMigratedToAtlas(VEX_PRO.toUpperCase())).toBe(true);
  });

  it('false sin empresa activa (superadmin en el panel, cargando)', () => {
    expect(isMigratedToAtlas(null)).toBe(false);
    expect(isMigratedToAtlas(undefined)).toBe(false);
    expect(isMigratedToAtlas('')).toBe(false);
  });

  it('false para cualquier otra empresa (lista blanca, no negra)', () => {
    expect(isMigratedToAtlas('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(isMigratedToAtlas('vexprofx')).toBe(false); // el slug no sirve de llave
    expect(isMigratedToAtlas('Vex Pro')).toBe(false); // el nombre tampoco
  });

  it('no cae en propiedades heredadas del objeto', () => {
    expect(isMigratedToAtlas('constructor')).toBe(false);
    expect(isMigratedToAtlas('__proto__')).toBe(false);
    expect(isMigratedToAtlas('toString')).toBe(false);
  });
});

describe('«Seguir aquí» sólo por sesión', () => {
  beforeEach(() => vi.stubGlobal('sessionStorage', fakeStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('al principio no está descartado', () => {
    expect(isAtlasNoticeDismissed(USER, VEX_PRO)).toBe(false);
  });

  it('descartar vale para ese usuario y esa empresa, no para otra', () => {
    dismissAtlasNotice(USER, VEX_PRO);
    expect(isAtlasNoticeDismissed(USER, VEX_PRO)).toBe(true);
    expect(isAtlasNoticeDismissed(USER, VONIX)).toBe(false);
    expect(isAtlasNoticeDismissed('user-2', VEX_PRO)).toBe(false);
  });

  it('cerrar sesión lo olvida todo y deja intactas las demás llaves', () => {
    sessionStorage.setItem('otra-cosa', 'x');
    dismissAtlasNotice(USER, VEX_PRO);
    dismissAtlasNotice(USER, VONIX);
    clearAtlasNoticeDismissals();
    expect(isAtlasNoticeDismissed(USER, VEX_PRO)).toBe(false);
    expect(isAtlasNoticeDismissed(USER, VONIX)).toBe(false);
    expect(sessionStorage.getItem('otra-cosa')).toBe('x');
  });

  it('la llave lleva usuario y empresa', () => {
    expect(atlasNoticeDismissKey(USER, VEX_PRO)).toContain(USER);
    expect(atlasNoticeDismissKey(USER, VEX_PRO)).toContain(VEX_PRO);
  });

  it('sin storage disponible: se muestra (avisar de más) y no revienta', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      key: () => { throw new Error('blocked'); },
      get length() { throw new Error('blocked'); },
    });
    expect(isAtlasNoticeDismissed(USER, VEX_PRO)).toBe(false);
    expect(() => dismissAtlasNotice(USER, VEX_PRO)).not.toThrow();
    expect(() => clearAtlasNoticeDismissals()).not.toThrow();
  });
});

describe('textos', () => {
  const KEYS = [
    'atlasMigration.title',
    'atlasMigration.body1',
    'atlasMigration.body2',
    'atlasMigration.goToAtlas',
    'atlasMigration.stayHere',
    'atlasMigration.banner',
  ];

  it('cada clave existe en en y es', () => {
    for (const k of KEYS) {
      expect(translations.en[k], `en: ${k}`).toBeTruthy();
      expect(translations.es[k], `es: ${k}`).toBeTruthy();
    }
  });

  it('el español es el pedido literal, con tuteo', () => {
    expect(translations.es['atlasMigration.title']).toBe('Smart Dashboard está archivado');
    // Modo archivo (2026-10-20): el texto pedido, con la fecha de corte como {date}.
    expect(translations.es['atlasMigration.banner']).toBe(
      'Smart Dashboard está archivado: solo consulta, con los datos hasta el {date}. Todo el trabajo sigue en Atlas:',
    );
    expect(translations.es['atlasMigration.goToAtlas']).toBe('Ir a Atlas');
    expect(translations.es['atlasMigration.stayHere']).toBe('Seguir aquí (solo consulta)');
    expect(translations.es['atlasMigration.body2']).toBe(
      'Entra con tu mismo correo; si no tienes acceso, pídeselo a tu administrador.',
    );
  });

  it('el enlace va a Atlas por https', () => {
    expect(ATLAS_URL).toBe('https://atlas.exuraglobal.com');
  });
});
