import { describe, expect, it } from 'vitest';
import { buildBrandPalette } from '@/lib/brand-color';
import {
  DEFAULT_PRIMARY,
  DEFAULT_SECONDARY,
  barContrast,
  brandWarnings,
  checkColor,
  colorExtreme,
  isValidHex,
  sidebarPreview,
} from './brand-preview';

const LOGOS = { logo_url_white: 'https://x/w.png', logo_icon_url: 'https://x/i.png' };

describe('isValidHex', () => {
  it('acepta #RGB y #RRGGBB, con o sin #', () => {
    for (const v of ['#fff', '#FFFFFF', '1E3A5F', '#1e3a5f']) expect(isValidHex(v)).toBe(true);
  });
  it('rechaza lo demás', () => {
    for (const v of ['', null, undefined, '#ffff', 'rojo', '#12345G', 'rgb(0,0,0)']) expect(isValidHex(v)).toBe(false);
  });
});

describe('colorExtreme', () => {
  it('detecta los casos reales: Exura Prime #ffffff y Exura Liquidez #000000', () => {
    expect(colorExtreme('#ffffff')).toBe('white');
    expect(colorExtreme('#000000')).toBe('black');
  });
  it('casi blanco / casi negro también', () => {
    expect(colorExtreme('#F5F5F5')).toBe('white');
    expect(colorExtreme('#0A0A0A')).toBe('black');
  });
  it('colores de marca normales no avisan', () => {
    for (const v of [DEFAULT_PRIMARY, DEFAULT_SECONDARY, '#F2B13A', '#1D5BD6', '#333333', '#DDDDDD']) {
      expect(colorExtreme(v)).toBeNull();
    }
  });
  it('un valor ilegible no es extremo (es inválido, se avisa aparte)', () => {
    expect(colorExtreme('nada')).toBeNull();
  });
});

describe('checkColor', () => {
  it('un hex inválido cae al fallback y lo marca', () => {
    const c = checkColor('azul', DEFAULT_PRIMARY);
    expect(c.invalid).toBe(true);
    expect(c.palette.base).toBe(DEFAULT_PRIMARY);
  });
  it('usa buildBrandPalette: misma paleta que el resto de la app', () => {
    expect(checkColor('#3B82F6', DEFAULT_PRIMARY).palette).toEqual(buildBrandPalette('#3B82F6'));
  });
  it('blanco se corrige en claro y negro en oscuro', () => {
    expect(checkColor('#ffffff', DEFAULT_SECONDARY).adjustedLight).toBe(true);
    expect(checkColor('#000000', DEFAULT_SECONDARY).adjustedDark).toBe(true);
  });
});

describe('sidebarPreview', () => {
  it('el ítem activo es el relleno oscuro de la paleta con su texto', () => {
    const p = buildBrandPalette(DEFAULT_PRIMARY);
    const s = sidebarPreview(p, buildBrandPalette(DEFAULT_SECONDARY));
    expect(s.activeBg).toBe(p.dark);
    expect(s.activeFg).toBe(p.fgDark);
  });
  it('el fondo es más oscuro que el activo y el texto se elige por contraste', () => {
    for (const hex of [DEFAULT_PRIMARY, '#F2B13A', '#ffffff', '#000000']) {
      const s = sidebarPreview(buildBrandPalette(hex), buildBrandPalette(DEFAULT_SECONDARY));
      expect(s.bg).not.toBe(s.activeBg);
      expect(['#FFFFFF', '#000000']).toContain(s.fg);
    }
  });
  it('barContrast devuelve un número finito ≥ 1', () => {
    const s = sidebarPreview(buildBrandPalette(DEFAULT_PRIMARY), buildBrandPalette('#000000'));
    const c = barContrast(s);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(1);
  });
});

describe('brandWarnings', () => {
  it('marca completa y colores normales: sin avisos', () => {
    expect(brandWarnings({ color_primary: DEFAULT_PRIMARY, color_secondary: DEFAULT_SECONDARY, ...LOGOS })).toEqual([]);
  });
  it('secundario blanco o negro avisa con el color resultante', () => {
    const w = brandWarnings({ color_primary: DEFAULT_PRIMARY, color_secondary: '#ffffff', ...LOGOS });
    expect(w).toHaveLength(1);
    expect(w[0].field).toBe('color_secondary');
    expect(w[0].text).toContain(buildBrandPalette('#ffffff').light);
    const b = brandWarnings({ color_primary: DEFAULT_PRIMARY, color_secondary: '#000000', ...LOGOS });
    expect(b[0].text).toContain(buildBrandPalette('#000000').inkDark);
  });
  it('primario extremo también avisa', () => {
    const w = brandWarnings({ color_primary: '#000000', color_secondary: DEFAULT_SECONDARY, ...LOGOS });
    expect(w.map((x) => x.field)).toEqual(['color_primary']);
  });
  it('hex inválido avisa con el default que se usará', () => {
    const w = brandWarnings({ color_primary: 'azul', color_secondary: DEFAULT_SECONDARY, ...LOGOS });
    expect(w[0].text).toContain(DEFAULT_PRIMARY);
  });
  it('sin isotipo / sin logo blanco avisa (Vex y AP hoy)', () => {
    const w = brandWarnings({ color_primary: DEFAULT_PRIMARY, color_secondary: DEFAULT_SECONDARY, logo_url_white: '', logo_icon_url: '' });
    expect(w.map((x) => x.field)).toEqual(['logo_icon_url', 'logo_url_white']);
  });
});
