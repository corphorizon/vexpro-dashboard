// ─────────────────────────────────────────────────────────────────────────────
// Color de marca y sidebar oscuro (docs/diseno-libro-mayor.md §10,
// 2026-10-12) — contraste con las marcas REALES de producción, en claro y en
// oscuro. Medido en prod el 2026-10-12:
//   · Vex Pro, AP Markets, Horizon, Horizon Atlas, Horizon Global, Vonix:
//     #1E3A5F / #3B82F6 (los respaldos del producto).
//   · Exura Prime:    #cf2738 / #ffffff  ← secundario BLANCO
//   · Exura Liquidez: #db0000 / #000000  ← secundario NEGRO
// Lo que fija:
//   1. Cada par texto/fondo nuevo ≥ 4,5:1 y cada ícono/filete/anillo ≥ 3:1.
//   2. Un secundario gris no llega nunca a la pantalla: se usa el primario.
//   3. El sidebar es la marca oscurecida, no un negro genérico.
//   4. Los respaldos de globals.css son los valores calculados para el
//      producto, y theme-apply limpia todo lo que escribe.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexToRgb } from './brand';
import { contrastRatio, isAchromatic, usableSecondary, NAV_GROUP_HUES, SIDEBAR_MIN_CONTRAST } from './brand-color';
import { companyThemeVars, COMPANY_THEME_VARS } from './theme-apply';

const ratio = (a: string, b: string) => contrastRatio(hexToRgb(a), hexToRgb(b));

const MARCAS = [
  { nombre: 'Vex Pro (default)', primary: '#1E3A5F', secondary: '#3B82F6' },
  { nombre: 'Exura Prime (secundario blanco)', primary: '#cf2738', secondary: '#ffffff' },
  { nombre: 'Exura Liquidez (secundario negro)', primary: '#db0000', secondary: '#000000' },
] as const;

/** Superficies legadas del tema (globals.css), las que hoy pisan las pantallas. */
const TEMA = {
  claro: { card: '#FFFFFF', bg: '#F8FAFC', text2: '#465264', fg: '#0F172A' },
  oscuro: { card: '#1E293B', bg: '#0B1222', text2: '#AAB4C5', fg: '#F1F5F9' },
} as const;

/** Lo que globals.css elige para cada tema a partir de las variables inyectadas. */
function resolve(v: ReturnType<typeof companyThemeVars>, tema: 'claro' | 'oscuro') {
  return tema === 'claro'
    ? {
        primary: v['--brand-primary-light'],
        onPrimary: v['--brand-primary-fg-light'],
        ink: v['--brand-primary-ink-light'],
        accent: v['--brand-secondary-light'],
        tint: v['--brand-tint-light'],
        wash: v['--brand-wash-light'],
      }
    : {
        primary: v['--brand-primary-dark'],
        onPrimary: v['--brand-primary-fg-dark'],
        ink: v['--brand-primary-ink-dark'],
        accent: v['--brand-secondary-ink-dark'],
        tint: v['--brand-tint-dark'],
        wash: v['--brand-wash-dark'],
      };
}

describe('secundario gris → se usa el primario', () => {
  it('blanco, negro y grises son acromáticos; un color no', () => {
    for (const g of ['#ffffff', '#000000', '#808080', '#F1F5F9']) expect(isAchromatic(g), g).toBe(true);
    for (const c of ['#3B82F6', '#cf2738', '#1E3A5F']) expect(isAchromatic(c), c).toBe(false);
  });
  it('Exura Prime (#ffffff) y Exura Liquidez (#000000) toman su primario', () => {
    expect(usableSecondary('#cf2738', '#ffffff')).toBe('#cf2738');
    expect(usableSecondary('#db0000', '#000000')).toBe('#db0000');
    expect(usableSecondary('#1E3A5F', '#3B82F6')).toBe('#3B82F6');
  });
  it('sin secundario, o todo gris, cae al respaldo del producto', () => {
    expect(usableSecondary('#cf2738', null)).toBe('#cf2738');
    expect(usableSecondary('#000000', '#ffffff')).toBe('#3B82F6');
    expect(usableSecondary(null, '')).toBe('#3B82F6');
  });
});

for (const m of MARCAS) {
  const v = companyThemeVars(m);
  describe(`${m.nombre}`, () => {
    for (const tema of ['claro', 'oscuro'] as const) {
      const r = resolve(v, tema);
      const t = TEMA[tema];
      it(`${tema}: brand-ink ≥ 4,5:1 sobre la tarjeta, el fondo y brand-tint`, () => {
        expect(ratio(r.ink, t.card)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(r.ink, r.tint)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(r.ink, t.bg)).toBeGreaterThanOrEqual(4.5);
      });
      it(`${tema}: texto sobre el relleno de marca (cuadro de ícono de página) ≥ 4,5:1`, () => {
        expect(ratio(r.onPrimary, r.primary)).toBeGreaterThanOrEqual(4.5);
      });
      it(`${tema}: cabecera con lavado de marca — text-2 y foreground ≥ 4,5:1`, () => {
        expect(ratio(t.text2, r.wash)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t.fg, r.wash)).toBeGreaterThanOrEqual(4.5);
      });
      it(`${tema}: acento (anillo de foco, línea de la topbar, serie 1) ≥ 3:1 sobre la tarjeta`, () => {
        expect(ratio(r.accent, t.card)).toBeGreaterThanOrEqual(3);
      });
      it(`${tema}: filete de marca (brand-ink) ≥ 3:1 sobre la tarjeta`, () => {
        expect(ratio(r.ink, t.card)).toBeGreaterThanOrEqual(3);
      });
      it(`${tema}: el acento no es gris aunque el secundario cargado lo sea`, () => {
        expect(isAchromatic(r.accent)).toBe(false);
      });
    }

    // El sidebar es igual en los dos temas: se mide una vez.
    const sb = {
      bg: v['--brand-sidebar-bg'],
      fg: v['--brand-sidebar-fg'],
      muted: v['--brand-sidebar-muted'],
      hover: v['--brand-sidebar-hover'],
      accent: v['--brand-sidebar-accent'],
      active: v['--brand-sidebar-active-bg'],
    };
    it('sidebar: fondo oscuro (≥ 14:1 contra blanco) y DE LA MARCA, no un negro genérico', () => {
      expect(ratio(sb.bg, '#FFFFFF')).toBeGreaterThanOrEqual(SIDEBAR_MIN_CONTRAST);
      expect(isAchromatic(sb.bg)).toBe(false);
      // Conserva el canal dominante del primario (navy sigue azul, rojo sigue rojo).
      const base = hexToRgb(m.primary);
      const dom = base.indexOf(Math.max(...base));
      const got = hexToRgb(sb.bg);
      expect(got.indexOf(Math.max(...got))).toBe(dom);
    });
    it('sidebar: texto principal, apagado y activo ≥ 4,5:1', () => {
      expect(ratio(sb.fg, sb.bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(sb.fg, sb.hover)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(sb.fg, sb.active)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(sb.muted, sb.bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(sb.muted, sb.hover)).toBeGreaterThanOrEqual(4.5);
    });
    it('sidebar: acento ≥ 4,5:1 sobre el fondo (inicial, foco) y ≥ 3:1 sobre el activo', () => {
      expect(ratio(sb.accent, sb.bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(sb.accent, sb.active)).toBeGreaterThanOrEqual(3);
      expect(isAchromatic(sb.accent)).toBe(false);
    });
    it('sidebar: íconos de grupo ≥ 3:1 sobre el fondo y el hover', () => {
      for (const hue of Object.values(NAV_GROUP_HUES)) {
        expect(ratio(hue, sb.bg), hue).toBeGreaterThanOrEqual(3);
        expect(ratio(hue, sb.hover), hue).toBeGreaterThanOrEqual(3);
      }
    });
  });
}

describe('theme-apply', () => {
  it('companyThemeVars escribe exactamente la lista que resetCompanyTheme limpia', () => {
    const keys = Object.keys(companyThemeVars({ primary: '#cf2738', secondary: '#ffffff' })).sort();
    expect(keys).toEqual([...COMPANY_THEME_VARS].sort());
  });
});

// Respaldos de globals.css = la marca del producto calculada (sin empresa:
// login, superadmin). Si alguien cambia la fórmula o la marca, esto falla.
describe('respaldos de globals.css (sin empresa activa)', () => {
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
  const def = companyThemeVars({ primary: '#1E3A5F', secondary: '#3B82F6' });
  const pares: [string, keyof typeof def][] = [
    ['--brand-tint-light', '--brand-tint-light'],
    ['--brand-tint-dark', '--brand-tint-dark'],
    ['--brand-wash-light', '--brand-wash-light'],
    ['--brand-wash-dark', '--brand-wash-dark'],
    ['--brand-sidebar-bg', '--brand-sidebar-bg'],
    ['--brand-sidebar-fg', '--brand-sidebar-fg'],
    ['--brand-sidebar-muted', '--brand-sidebar-muted'],
    ['--brand-sidebar-hover', '--brand-sidebar-hover'],
    ['--brand-sidebar-border', '--brand-sidebar-border'],
    ['--brand-sidebar-accent', '--brand-sidebar-accent'],
    ['--brand-sidebar-active-bg', '--brand-sidebar-active-bg'],
  ];
  for (const [inyectada, clave] of pares) {
    it(`var(${inyectada}, …) respalda con ${def[clave]}`, () => {
      const m = css.match(new RegExp(`var\\(${inyectada},\\s*(#[0-9A-Fa-f]{6})\\)`));
      expect(m?.[1].toUpperCase()).toBe(def[clave]);
    });
  }
});

describe('marca roja: el rojo sólo en el menú (Kevin, 2026-10-12)', () => {
  it('detecta los rojos de Exura y no otros tonos', async () => {
    const { clashesWithLoss } = await import('./brand-color');
    expect(clashesWithLoss('#cf2738')).toBe(true);
    expect(clashesWithLoss('#db0000')).toBe(true);
    expect(clashesWithLoss('#1E3A5F')).toBe(false);
    expect(clashesWithLoss('#3B82F6')).toBe(false);
    expect(clashesWithLoss('#F2B13A')).toBe(false);
    expect(clashesWithLoss('#ffffff')).toBe(false);
    expect(clashesWithLoss('#000000')).toBe(false);
  });
  it('Exura: el contenido usa los colores del producto y el sidebar conserva el rojo', async () => {
    const { companyThemeVars } = await import('./theme-apply');
    const exura = companyThemeVars({ primary: '#cf2738', secondary: '#ffffff' });
    const producto = companyThemeVars({ primary: '#1E3A5F', secondary: '#3B82F6' });
    expect(exura['--brand-primary-base']).toBe(producto['--brand-primary-base']);
    expect(exura['--brand-secondary-base']).toBe(producto['--brand-secondary-base']);
    expect(exura['--brand-tint-light']).toBe(producto['--brand-tint-light']);
    expect(exura['--brand-sidebar-bg']).not.toBe(producto['--brand-sidebar-bg']);
  });
});
