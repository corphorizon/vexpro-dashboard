import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BRAND_HEX,
  BRAND_RGB,
  hexToRgb,
  relativeLuminance,
  readableTextOn,
} from './brand';
import { buildBrandPalette } from './brand-color';

describe('hexToRgb', () => {
  it('convierte forma larga y corta', () => {
    expect(hexToRgb('#1E3A5F')).toEqual([30, 58, 95]);
    expect(hexToRgb('1E3A5F')).toEqual([30, 58, 95]);
    expect(hexToRgb('#abc')).toEqual([170, 187, 204]);
  });

  it('cae al respaldo con valores invalidos', () => {
    // Las empresas cargan su color a mano: un valor roto no puede tumbar
    // la generación del PDF.
    expect(hexToRgb(null)).toEqual([30, 58, 95]);
    expect(hexToRgb('')).toEqual([30, 58, 95]);
    expect(hexToRgb('rojo')).toEqual([30, 58, 95]);
    expect(hexToRgb('#12345')).toEqual([30, 58, 95]);
    expect(hexToRgb('#zzzzzz', [1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('BRAND_RGB', () => {
  it('deriva de BRAND_HEX sin perder ningún color', () => {
    expect(Object.keys(BRAND_RGB).sort()).toEqual(Object.keys(BRAND_HEX).sort());
    expect(BRAND_RGB.primary).toEqual([30, 58, 95]);
    expect(BRAND_RGB.positive).toEqual([5, 150, 105]);
    expect(BRAND_RGB.negative).toEqual([220, 38, 38]);
  });
});

describe('contraste', () => {
  it('elige texto blanco sobre fondos oscuros y tinta sobre claros', () => {
    expect(readableTextOn(BRAND_RGB.primary)).toEqual(BRAND_RGB.white);
    expect(readableTextOn(BRAND_RGB.negative)).toEqual(BRAND_RGB.white);
    // Un primario claro (algunas empresas los usan) necesita texto oscuro,
    // o el encabezado del PDF queda ilegible.
    expect(readableTextOn(hexToRgb('#FDE68A'))).toEqual(BRAND_RGB.ink);
    expect(readableTextOn(BRAND_RGB.surface)).toEqual(BRAND_RGB.ink);
  });

  it('el blanco es más luminoso que el negro', () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 5);
  });
});

// globals.css no puede importar TypeScript, así que sus variables se escriben
// a mano. Este test las lee y falla si alguien cambia una sin la otra — que
// es exactamente cómo la paleta se había desincronizado entre la app y los
// PDFs.
describe('globals.css coincide con la paleta', () => {
  const css = readFileSync(
    join(process.cwd(), 'src/app/globals.css'),
    'utf8',
  );

  /**
   * Lee la primera declaración de una variable (bloque :root, tema claro).
   * Las variables de marca ya no son un hex suelto sino
   * `var(--brand-…, #RESPALDO)`: lo que interesa comparar es el respaldo.
   */
  function cssVar(name: string): string | null {
    const m = css.match(
      new RegExp(`${name}:\\s*(?:var\\([^,)]+,\\s*)?(#[0-9a-fA-F]{3,8})`),
    );
    return m ? m[1].toUpperCase() : null;
  }

  const PARES: Array<[string, string]> = [
    // El primario y el acento pasan por la corrección de contraste
    // (brand-color.ts), así que el respaldo del CSS es la VARIANTE clara, no
    // el hex de la paleta. Los respaldos se verifican en brand-color.test.ts.
    ['--color-primary', buildBrandPalette(BRAND_HEX.primary).light],
    ['--accent', buildBrandPalette(BRAND_HEX.accent).light],
    ['--positive', BRAND_HEX.positive],
    ['--negative', BRAND_HEX.negative],
    ['--warning', BRAND_HEX.warning],
    ['--info', BRAND_HEX.info],
  ];

  for (const [variable, esperado] of PARES) {
    it(`${variable} = ${esperado}`, () => {
      expect(cssVar(variable)).toBe(esperado.toUpperCase());
    });
  }
});
