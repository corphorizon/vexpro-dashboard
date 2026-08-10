import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexToRgb, relativeLuminance } from './brand';
import {
  buildBrandPalette,
  contrastRatio,
  ensureContrast,
  mix,
  readableTextOn,
  rgbToHex,
  DARK_BG,
  DARK_SURFACE,
  LIGHT_SURFACE,
  TEXT_CONTRAST,
  UI_CONTRAST,
} from './brand-color';

const WHITE = hexToRgb('#FFFFFF');
const BLACK = hexToRgb('#000000');

/** Colores de marca reales + casos límite: el que rompe el contraste no es el
 *  color promedio, es el pastel y el casi-negro. */
const MARCAS = [
  '#CF2738', // Exura Prime — rojo
  '#1E3A5F', // Smart Dashboard — navy
  '#3B82F6', // azul medio
  '#FDE68A', // amarillo pastel (el caso que rompe `text-white`)
  '#00FF00', // verde saturado
  '#050505', // casi negro
  '#FFFFFF', // blanco
  '#7C3AED', // violeta
];

describe('rgbToHex', () => {
  it('es la inversa de hexToRgb', () => {
    expect(rgbToHex([30, 58, 95])).toBe('#1E3A5F');
    expect(rgbToHex(hexToRgb('#CF2738'))).toBe('#CF2738');
  });

  it('recorta y redondea fuera de rango', () => {
    expect(rgbToHex([-10, 300, 127.6])).toBe('#00FF80');
  });
});

describe('contrastRatio', () => {
  it('blanco contra negro es 21:1 y un color contra sí mismo 1:1', () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 2);
    expect(contrastRatio(hexToRgb('#CF2738'), hexToRgb('#CF2738'))).toBeCloseTo(1, 5);
  });

  it('es simétrica', () => {
    const a = hexToRgb('#1E3A5F');
    const b = hexToRgb('#F8FAFC');
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
});

describe('mix', () => {
  it('interpola entre los extremos y satura t fuera de [0,1]', () => {
    expect(mix([0, 0, 0], [255, 255, 255], 0)).toEqual([0, 0, 0]);
    expect(mix([0, 0, 0], [255, 255, 255], 1)).toEqual([255, 255, 255]);
    expect(mix([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
    expect(mix([10, 20, 30], [0, 0, 0], 5)).toEqual([0, 0, 0]);
  });
});

describe('ensureContrast', () => {
  it('no toca un color que ya cumple', () => {
    const navy = hexToRgb('#1E3A5F');
    expect(ensureContrast(navy, WHITE, TEXT_CONTRAST)).toEqual(navy);
  });

  it('oscurece contra fondo claro y aclara contra fondo oscuro', () => {
    const pastel = hexToRgb('#FDE68A');
    const corregidoClaro = ensureContrast(pastel, WHITE, TEXT_CONTRAST);
    expect(relativeLuminance(corregidoClaro)).toBeLessThan(relativeLuminance(pastel));

    const navy = hexToRgb('#1E3A5F');
    const corregidoOscuro = ensureContrast(navy, hexToRgb(DARK_BG), UI_CONTRAST);
    expect(relativeLuminance(corregidoOscuro)).toBeGreaterThan(relativeLuminance(navy));
  });

  it('llega al umbral pedido para cualquier marca y fondo', () => {
    for (const hex of MARCAS) {
      for (const bg of [LIGHT_SURFACE, DARK_BG, DARK_SURFACE]) {
        const out = ensureContrast(hexToRgb(hex), hexToRgb(bg), TEXT_CONTRAST);
        expect(contrastRatio(out, hexToRgb(bg))).toBeGreaterThanOrEqual(TEXT_CONTRAST - 1e-9);
      }
    }
  });

  it('devuelve el extremo cuando el umbral es inalcanzable', () => {
    // 21:1 contra un gris medio no existe: mejor negro puro que un valor a
    // medio camino que pretenda cumplir.
    const out = ensureContrast(hexToRgb('#808080'), hexToRgb('#808080'), 21);
    expect(out).toEqual(BLACK);
  });

  it('respeta el sentido forzado', () => {
    const rojo = hexToRgb('#CF2738');
    const forzado = ensureContrast(rojo, WHITE, 7, 'darker');
    expect(relativeLuminance(forzado)).toBeLessThan(relativeLuminance(rojo));
  });
});

describe('readableTextOn', () => {
  it('elige blanco sobre oscuro y negro sobre claro', () => {
    expect(readableTextOn(hexToRgb('#1E3A5F'))).toEqual(WHITE);
    expect(readableTextOn(hexToRgb('#CF2738'))).toEqual(WHITE);
    expect(readableTextOn(hexToRgb('#FDE68A'))).toEqual(BLACK);
  });
});

describe('buildBrandPalette', () => {
  it('conserva el color cargado en `base`', () => {
    expect(buildBrandPalette('#CF2738').base).toBe('#CF2738');
    expect(buildBrandPalette('#cf2738').base).toBe('#CF2738');
  });

  it('cae al respaldo con valores rotos', () => {
    // Los colores se cargan a mano en el alta de la empresa: un valor
    // inválido no puede dejar la UI sin marca.
    expect(buildBrandPalette(null).base).toBe('#1E3A5F');
    expect(buildBrandPalette('rojo').base).toBe('#1E3A5F');
    expect(buildBrandPalette('', '#CF2738').base).toBe('#CF2738');
  });

  it('la variante clara es legible como texto sobre tarjeta blanca', () => {
    for (const hex of MARCAS) {
      const p = buildBrandPalette(hex);
      expect(contrastRatio(hexToRgb(p.light), WHITE)).toBeGreaterThanOrEqual(TEXT_CONTRAST - 1e-9);
    }
  });

  it('la variante oscura se ve sobre el fondo oscuro Y aguanta texto blanco', () => {
    // Las dos condiciones a la vez: es la que rompía antes — el navy
    // desaparecía en tema oscuro y el pastel dejaba ilegible el `text-white`.
    for (const hex of MARCAS) {
      const p = buildBrandPalette(hex);
      expect(contrastRatio(hexToRgb(p.dark), hexToRgb(DARK_BG))).toBeGreaterThanOrEqual(
        UI_CONTRAST - 1e-9,
      );
      expect(contrastRatio(hexToRgb(p.dark), WHITE)).toBeGreaterThanOrEqual(TEXT_CONTRAST - 1e-9);
    }
  });

  it('la tinta oscura es legible sobre la tarjeta oscura', () => {
    for (const hex of MARCAS) {
      const p = buildBrandPalette(hex);
      expect(contrastRatio(hexToRgb(p.inkDark), hexToRgb(DARK_SURFACE))).toBeGreaterThanOrEqual(
        TEXT_CONTRAST - 1e-9,
      );
    }
  });

  it('el texto sobre cada relleno contrasta al menos 4.5:1', () => {
    for (const hex of MARCAS) {
      const p = buildBrandPalette(hex);
      expect(contrastRatio(hexToRgb(p.fgLight), hexToRgb(p.light))).toBeGreaterThanOrEqual(
        TEXT_CONTRAST - 1e-9,
      );
      expect(contrastRatio(hexToRgb(p.fgDark), hexToRgb(p.dark))).toBeGreaterThanOrEqual(
        TEXT_CONTRAST - 1e-9,
      );
    }
  });

  it('no toca la marca cuando ya cumple (el navy del producto en claro)', () => {
    const p = buildBrandPalette('#1E3A5F');
    expect(p.light).toBe('#1E3A5F');
    // …pero sí la aclara para el tema oscuro, donde era casi invisible.
    expect(relativeLuminance(hexToRgb(p.dark))).toBeGreaterThan(
      relativeLuminance(hexToRgb('#1E3A5F')),
    );
  });

  it('el rojo de Exura sobrevive intacto como relleno y se aclara como tinta', () => {
    // 5.25:1 contra blanco: pasa AA sin tocarlo, así que en claro y como
    // relleno oscuro se respeta el color de la marca…
    const p = buildBrandPalette('#CF2738');
    expect(p.light).toBe('#CF2738');
    expect(p.dark).toBe('#CF2738');
    expect(p.fgLight).toBe('#FFFFFF');
    // …pero como texto sobre la tarjeta oscura se queda en 2.79:1, así que la
    // tinta del tema oscuro sí se aclara.
    expect(relativeLuminance(hexToRgb(p.inkDark))).toBeGreaterThan(
      relativeLuminance(hexToRgb('#CF2738')),
    );
  });
});

// Los valores de respaldo de globals.css (los que se usan cuando no hay
// empresa activa) están escritos a mano en el CSS. Este test los recalcula y
// falla si alguien cambia la marca del producto sin regenerarlos.
describe('los respaldos de globals.css salen de la paleta', () => {
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

  /** Lee el respaldo de `var(--x, #hex)` en la n-ésima aparición. */
  function fallback(name: string, ocurrencia = 0): string | null {
    const re = new RegExp(`${name}:\\s*var\\([^,]+,\\s*(#[0-9a-fA-F]{6})\\s*\\)`, 'g');
    const all = [...css.matchAll(re)];
    return all[ocurrencia] ? all[ocurrencia][1].toUpperCase() : null;
  }

  const primary = buildBrandPalette('#1E3A5F');
  const secondary = buildBrandPalette('#3B82F6');

  it('--color-primary usa la variante clara en :root y la oscura en .dark', () => {
    expect(fallback('--color-primary', 0)).toBe(primary.light);
    expect(fallback('--color-primary', 1)).toBe(primary.dark);
  });

  it('--accent usa el secundario corregido en cada tema', () => {
    expect(fallback('--accent', 0)).toBe(secondary.light);
    expect(fallback('--accent', 1)).toBe(secondary.inkDark);
  });

  it('--brand-ink usa la tinta de cada tema', () => {
    expect(fallback('--brand-ink', 0)).toBe(primary.light);
    expect(fallback('--brand-ink', 1)).toBe(primary.inkDark);
  });
});
