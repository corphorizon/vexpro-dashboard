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

// ─────────────────────────────────────────────────────────────────────────────
// Color de marca y sidebar oscuro (2026-10-12, pedido de Kevin: «se ve muy
// plano, me gustaría agregarle más colores y que el menú del lado tenga un
// color oscuro… cada marca sube su isotipo y sus colores»).
//
// Todo lo que sigue deriva de los MISMOS dos colores que carga el admin, con
// la misma regla de arriba: nunca el color crudo, siempre una variante medida.
// Ver docs/diseno-libro-mayor.md §10.
// ─────────────────────────────────────────────────────────────────────────────

/** Casi negro con un toque azul: hacia acá se oscurece la marca para el
 *  sidebar. Es la DIRECCIÓN, no el destino (eso lo decide el contraste): así
 *  un navy queda navy y un rojo queda bordó, nunca un negro genérico. */
const INK_BLACK: RGB = [5, 8, 15];

/** Contraste mínimo del fondo del sidebar contra el blanco. 14:1 deja lugar
 *  para texto apagado (≥ 4,5:1) y para íconos de grupo de color (≥ 3:1). */
export const SIDEBAR_MIN_CONTRAST = 14;

/** Íconos de grupo del menú (Finanzas usa el acento de la marca). Fijos y
 *  claros: con el fondo del sidebar a ≥ 14:1 del blanco, cualquier color de
 *  luminancia ≥ 0,18 pasa 3:1. NO son pos/neg/pend (verde/rojo/ámbar): un
 *  grupo del menú no es una ganancia ni una pérdida. */
export const NAV_GROUP_HUES = {
  hr: '#C4B5FD', // violeta
  risk: '#5EEAD4', // turquesa
  config: '#CBD5E1', // pizarra
} as const;

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const isHex = (h: string | null | undefined): h is string => !!h && HEX.test(h.trim());

/**
 * ¿El color es gris (blanco, negro o cualquier gris)? Croma sRGB < 12 %.
 * Un secundario así no sirve de acento: blanco desaparece en claro y negro en
 * oscuro (Exura Prime carga #ffffff y Exura Liquidez #000000 — medido en prod
 * el 2026-10-12). Con el secundario gris, la marca ES el primario.
 */
export function isAchromatic(hex: string | null | undefined): boolean {
  if (!isHex(hex)) return false;
  const [r, g, b] = hexToRgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) < 0.12 * 255;
}

/** El secundario que se usa de verdad: el cargado, salvo que falte o sea
 *  gris → el primario; si el primario también es gris, el `fallback`. */
export function usableSecondary(
  primary: string | null | undefined,
  secondary: string | null | undefined,
  fallback = '#3B82F6',
): string {
  if (isHex(secondary) && !isAchromatic(secondary)) return secondary;
  if (isHex(primary) && !isAchromatic(primary)) return primary;
  return fallback;
}

/** Tintes de marca para SUPERFICIES (nunca para texto ni para números). */
export interface BrandTints {
  /** Ítem/chip activo, cuadro de ícono. `brand-ink` del tema encima ≥ 4,5:1. */
  tintLight: string;
  tintDark: string;
  /** Lavado muy suave: cabecera de tabla, cabecera de panel destacado. */
  washLight: string;
  washDark: string;
}

/**
 * El tinte toma el TONO del acento (secundario usable: más saturado que un
 * primario navy, que daba un gris) y se aclara/oscurece hasta que la tinta de
 * marca (`brand-ink`, del primario) encima pase 4,5:1. `s` = paleta del
 * secundario usable; sin ella, el primario.
 */
export function buildBrandTints(p: BrandPalette, s: BrandPalette = p): BrandTints {
  const ink = hexToRgb(p.light);
  const inkDark = hexToRgb(p.inkDark);
  const white = hexToRgb(LIGHT_SURFACE);
  const darkBg = hexToRgb(DARK_BG);
  const darkSurface = hexToRgb(DARK_SURFACE);
  const ensureInk = (c: RGB, inkOn: RGB, toward: RGB): RGB => {
    for (let k = 0; k <= 1.0001; k += 0.02) {
      const cand = mix(c, toward, k);
      if (contrastRatio(inkOn, cand) >= TEXT_CONTRAST) return cand;
    }
    return toward;
  };
  const tintLight = ensureInk(mix(hexToRgb(s.light), white, 0.88), ink, white);
  const tintDark = ensureInk(mix(hexToRgb(s.inkDark), darkBg, 0.8), inkDark, darkBg);
  return {
    tintLight: rgbToHex(tintLight),
    tintDark: rgbToHex(tintDark),
    washLight: rgbToHex(mix(hexToRgb(s.light), white, 0.95)),
    washDark: rgbToHex(mix(hexToRgb(s.inkDark), darkSurface, 0.9)),
  };
}

/** El sidebar: SIEMPRE oscuro (los dos temas), del color de la marca. */
export interface SidebarPalette {
  bg: string;
  /** Texto principal: nombre, ítem activo. */
  fg: string;
  /** Ítems inactivos y rótulos de grupo: ≥ 4,5:1 sobre `bg` y sobre `hover`. */
  muted: string;
  hover: string;
  border: string;
  /** Acento (secundario usable, aclarado): barra e ícono del activo, anillo de
   *  foco. ≥ 4,5:1 sobre `bg` y ≥ 3:1 sobre `activeBg`. */
  accent: string;
  /** Fondo del ítem activo: el fondo teñido con el acento. */
  activeBg: string;
}

export function buildSidebarPalette(
  primary: string | null | undefined,
  secondary: string | null | undefined,
  fallbackPrimary = '#1E3A5F',
  fallbackSecondary = '#3B82F6',
): SidebarPalette {
  const base = hexToRgb(isHex(primary) ? primary : fallbackPrimary);
  // Oscurecer hacia el casi-negro (conserva el tono) un 50 % como mínimo, y
  // más si el contraste contra el blanco no llega (marcas claras).
  let bg = mix(base, INK_BLACK, 0.5);
  for (let t = 0.52; contrastRatio(bg, WHITE) < SIDEBAR_MIN_CONTRAST && t <= 1.0001; t += 0.02) {
    bg = mix(base, INK_BLACK, t);
  }
  const hover = mix(bg, WHITE, 0.07);
  const border = mix(bg, WHITE, 0.14);
  const fg = mix(bg, WHITE, 0.94);
  const muted = ensureContrast(mix(bg, WHITE, 0.68), hover, TEXT_CONTRAST, 'lighter');

  const accentRaw = hexToRgb(usableSecondary(primary, secondary, fallbackSecondary));
  const activeBg = mix(bg, accentRaw, 0.24);
  let accent = ensureContrast(accentRaw, bg, TEXT_CONTRAST, 'lighter');
  accent = ensureContrast(accent, activeBg, UI_CONTRAST, 'lighter');

  return {
    bg: rgbToHex(bg),
    fg: rgbToHex(fg),
    muted: rgbToHex(muted),
    hover: rgbToHex(hover),
    border: rgbToHex(border),
    accent: rgbToHex(accent),
    activeBg: rgbToHex(activeBg),
  };
}
