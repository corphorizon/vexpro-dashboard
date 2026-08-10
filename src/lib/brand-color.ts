// ─────────────────────────────────────────────────────────────────────────────
// brand-color — corrección automática de contraste del color de cada empresa.
//
// EL PROBLEMA: `companies.color_primary` es UN color elegido por un admin, y
// se usa para dos cosas incompatibles: como RELLENO (botón, chip, item activo)
// y como TINTA (texto, íconos, links). Un color puede servir para una y no
// para la otra, y encima el dashboard tiene tema claro y tema oscuro:
//   · Un primario oscuro (navy, bordó) es perfecto en claro y desaparece
//     sobre el fondo oscuro.
//   · Un primario claro (amarillo, celeste) se ve en oscuro pero como texto
//     sobre tarjeta blanca es ilegible, y con `text-white` encima peor.
// Pedirle al admin que cargue cuatro variantes no es una opción: no lo va a
// hacer. Así que se DERIVAN.
//
// LA REGLA: nunca se usa el color crudo. De cada color de marca se derivan
// variantes que cumplen contraste WCAG contra la superficie donde van a caer,
// moviendo el color hacia negro o hacia blanco lo MÍNIMO necesario (se mezcla
// en pasos chicos, así el tono se conserva y sigue leyéndose como la marca).
//
// Umbrales: 4.5:1 para texto (WCAG AA, 1.4.3) y 3:1 para superficies y bordes
// (WCAG 1.4.11, que es contraste de componente, no de texto).
//
// Dónde se aplica: theme-apply.ts escribe estas variantes como variables CSS
// y globals.css elige la del tema. Este archivo es el ÚNICO lugar donde se
// decide un color derivado de la marca — si hace falta otra variante, se
// agrega acá y no en un componente.
// ─────────────────────────────────────────────────────────────────────────────

import { hexToRgb, relativeLuminance, type RGB } from './brand';

/** Superficie más exigente del tema claro: la tarjeta blanca. */
export const LIGHT_SURFACE = '#FFFFFF';
/** Fondo del tema oscuro (globals.css `--background` en .dark). */
export const DARK_BG = '#0B1222';
/** Tarjeta del tema oscuro — más clara que el fondo, así que es el peor caso
 *  para una tinta clara. */
export const DARK_SURFACE = '#1E293B';

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

/** Texto AA normal. */
export const TEXT_CONTRAST = 4.5;
/** Componentes no textuales (rellenos, bordes, anillos de foco). */
export const UI_CONTRAST = 3;

/** [30, 58, 95] → '#1E3A5F'. */
export function rgbToHex(rgb: RGB): string {
  return (
    '#' +
    rgb
      .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

/** Razón de contraste WCAG entre dos colores (1 a 21). Simétrica. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Mezcla lineal en sRGB: t=0 devuelve `color`, t=1 devuelve `target`. */
export function mix(color: RGB, target: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return [
    color[0] + (target[0] - color[0]) * k,
    color[1] + (target[1] - color[1]) * k,
    color[2] + (target[2] - color[2]) * k,
  ].map((c) => Math.round(c)) as RGB;
}

/** Blanco o negro puro, el que más contraste dé sobre `background`. */
export function readableTextOn(background: RGB): RGB {
  return contrastRatio(background, WHITE) >= contrastRatio(background, BLACK) ? WHITE : BLACK;
}

/**
 * Devuelve `color` si ya contrasta `target`:1 contra `background`; si no, lo
 * acerca a negro o a blanco en pasos de 2% hasta lograrlo.
 *
 * `toward: 'auto'` decide el sentido según el fondo (fondo claro → oscurecer),
 * que es lo correcto en el 99% de los casos; se puede forzar cuando el destino
 * importa (p. ej. oscurecer un relleno para que el texto blanco encima siga
 * legible, aunque el fondo sea oscuro).
 */
export function ensureContrast(
  color: RGB,
  background: RGB,
  target: number,
  toward: 'darker' | 'lighter' | 'auto' = 'auto',
): RGB {
  if (contrastRatio(color, background) >= target) return color;
  const direction =
    toward === 'auto' ? (relativeLuminance(background) > 0.18 ? 'darker' : 'lighter') : toward;
  const endpoint = direction === 'darker' ? BLACK : WHITE;
  // Pasos chicos: el primero que cumple es el que menos deforma la marca.
  for (let t = 0.02; t <= 1; t += 0.02) {
    const candidate = mix(color, endpoint, t);
    if (contrastRatio(candidate, background) >= target) return candidate;
  }
  return endpoint;
}

/** Las variantes utilizables de un color de marca. Todo en hex `#RRGGBB`. */
export interface BrandPalette {
  /** El color tal cual lo cargó el admin. Solo para mostrarlo (swatch, PDF). */
  base: string;
  /** Tema claro — relleno Y tinta. Cumple 4.5:1 contra blanco, que es lo mismo
   *  que decir que el texto blanco encima también cumple 4.5:1. */
  light: string;
  /** Tema oscuro — RELLENO. Visible sobre el fondo oscuro (≥3:1) y a la vez
   *  suficientemente oscuro para que el texto blanco encima sea legible. */
  dark: string;
  /** Tema oscuro — TINTA (texto, íconos). Aclarado hasta 4.5:1 contra la
   *  tarjeta oscura; como relleno sería demasiado claro. */
  inkDark: string;
  /** Blanco o negro para el texto que va encima de `light`. */
  fgLight: string;
  /** Blanco o negro para el texto que va encima de `dark`. */
  fgDark: string;
}

/**
 * Deriva todas las variantes de un color de marca. Tolera null/basura: cae al
 * `fallback` (los colores se cargan a mano y un valor roto no puede dejar la
 * UI sin color).
 */
export function buildBrandPalette(hex: string | null | undefined, fallback = '#1E3A5F'): BrandPalette {
  const base = hexToRgb(hex, hexToRgb(fallback));
  const lightSurface = hexToRgb(LIGHT_SURFACE);
  const darkBg = hexToRgb(DARK_BG);
  const darkSurface = hexToRgb(DARK_SURFACE);

  // Claro: una sola variante sirve de tinta y de relleno, porque "contrasta
  // 4.5:1 con el blanco" y "el blanco encima contrasta 4.5:1" son la misma
  // condición.
  const light = ensureContrast(base, lightSurface, TEXT_CONTRAST, 'darker');

  // Oscuro, relleno: primero que se vea sobre el fondo (≥3:1)…
  let dark = ensureContrast(base, darkBg, UI_CONTRAST, 'lighter');
  // …y después que el texto blanco encima aguante. Casi toda la UI escribe
  // `text-white` sobre el primario, así que un primario pastel tiene que
  // bajar. Oscurecer acá no rompe lo anterior: la ventana de luminancia que
  // cumple las dos condiciones nunca es vacía (ver brand-color.test.ts).
  if (contrastRatio(dark, WHITE) < TEXT_CONTRAST) {
    dark = ensureContrast(dark, WHITE, TEXT_CONTRAST, 'darker');
  }

  // Oscuro, tinta: acá no hay texto encima, así que se aclara libremente.
  const inkDark = ensureContrast(base, darkSurface, TEXT_CONTRAST, 'lighter');

  return {
    base: rgbToHex(base),
    light: rgbToHex(light),
    dark: rgbToHex(dark),
    inkDark: rgbToHex(inkDark),
    fgLight: rgbToHex(readableTextOn(light)),
    fgDark: rgbToHex(readableTextOn(dark)),
  };
}
