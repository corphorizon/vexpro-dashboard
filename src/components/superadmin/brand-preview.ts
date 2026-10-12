// ─────────────────────────────────────────────────────────────────────────────
// brand-preview — qué va a ver una empresa con los colores que se le cargan.
//
// POR QUÉ (2026-10-12, pedido de Kevin: «cada marca sube su isotipo y sus
// colores para que quede customizado»): el formulario de la entidad tenía
// dos <input type="color"> y tres subidores de logo sin ninguna vista de cómo
// quedaba. Y los colores NO se usan crudos: brand-color.ts los corrige para
// que cumplan contraste, así que lo que el superadmin elige no es lo que la
// empresa ve. Dos casos reales en producción:
//   · Exura Prime con secundario #FFFFFF y Exura Liquidez con #000000: un
//     blanco no se ve sobre la tarjeta clara y un negro no se ve sobre el
//     tema oscuro; buildBrandPalette los empuja hasta el contraste mínimo y
//     el resultado es un gris que no es la marca. Hay que avisarlo ANTES de
//     guardar, con el color en que se va a convertir.
//   · Vex y AP sin isotipo: el sidebar contraído muestra la inicial.
//
// La vista previa deriva TODO de buildBrandPalette (src/lib/brand-color.ts,
// el único lugar donde se decide un color derivado de la marca) — este
// archivo no inventa variantes de marca: sólo arma, con esas variantes, una
// aproximación del sidebar oscuro.
//
// DESCARTADO:
//   · Copiar la fórmula exacta del sidebar oscuro: la está implementando otra
//     tanda en paralelo; duplicarla acá sería la segunda copia que se
//     desincroniza (reglas §1.1). La vista previa usa el relleno oscuro de la
//     paleta (`dark`) para el ítem activo y lo oscurece para el fondo; cuando
//     esa tanda entre, si exporta su fórmula, esta función debería llamarla.
//   · Bloquear el guardado con blanco/negro: es una decisión de marca, no un
//     error. Se avisa con el color resultante y se deja guardar.
// ─────────────────────────────────────────────────────────────────────────────

import { buildBrandPalette, buildSidebarPalette, clashesWithLoss, contrastRatio, type BrandPalette } from '@/lib/brand-color';
import { hexToRgb, relativeLuminance } from '@/lib/brand';


/** Defaults del alta (companies/new y el POST de /api/superadmin/companies). */
export const DEFAULT_PRIMARY = '#1E3A5F';
export const DEFAULT_SECONDARY = '#3B82F6';

/** ¿Es un hex que brand.ts sabe leer (#RGB / #RRGGBB)? */
export function isValidHex(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

export type ColorExtreme = 'white' | 'black' | null;

/**
 * Blanco o negro (o casi): luminancia ≥ 0.9 o ≤ 0.01. #F5F5F5 es 0.91 y
 * #0A0A0A 0.003 — a esa distancia del extremo la corrección de contraste lo
 * reemplaza por un gris y el color deja de ser la marca.
 */
export function colorExtreme(value: string | null | undefined): ColorExtreme {
  if (!isValidHex(value)) return null;
  const l = relativeLuminance(hexToRgb(value));
  if (l >= 0.9) return 'white';
  if (l <= 0.01) return 'black';
  return null;
}

export interface ColorCheck {
  /** Lo cargado no es un hex legible: se usa el default. */
  invalid: boolean;
  extreme: ColorExtreme;
  palette: BrandPalette;
  /** La corrección cambió el color en el tema claro (tinta/relleno). */
  adjustedLight: boolean;
  /** La corrección cambió el color en el tema oscuro (tinta). */
  adjustedDark: boolean;
}

export function checkColor(value: string | null | undefined, fallback: string): ColorCheck {
  const invalid = !isValidHex(value);
  const palette = buildBrandPalette(invalid ? fallback : value, fallback);
  return {
    invalid,
    extreme: invalid ? null : colorExtreme(value),
    palette,
    adjustedLight: palette.light !== palette.base,
    adjustedDark: palette.inkDark !== palette.base,
  };
}

export interface SidebarPreview {
  bg: string;
  fg: string;
  /** Texto secundario (ítems no activos, subtítulo). */
  muted: string;
  border: string;
  activeBg: string;
  activeFg: string;
  /** Barra de 3 px del ítem activo: la tinta oscura del secundario. */
  bar: string;
}

/**
 * Aproximación del sidebar oscuro con la marca: fondo = relleno oscuro de la
 * paleta llevado 55 % hacia negro; ítem activo = el relleno oscuro tal cual
 * con su texto (fgDark); barra = tinta oscura del secundario. Todo sale de
 * buildBrandPalette; los textos se eligen por contraste (readableTextOn).
 */
export function sidebarPreview(primary: BrandPalette, secondary: BrandPalette): SidebarPreview {
  // La MISMA fórmula que pinta el sidebar real (buildSidebarPalette en
  // brand-color.ts). Antes había una aproximación propia acá: dos fórmulas del
  // mismo color se separan en silencio y la vista previa mentía.
  const s = buildSidebarPalette(primary.base, secondary.base);
  return {
    bg: s.bg,
    fg: s.fg,
    muted: s.muted,
    border: s.border,
    activeBg: s.activeBg,
    activeFg: s.fg,
    bar: s.accent,
  };
}

/** Contraste de la barra del activo contra el fondo del ítem (para avisar si no se distingue). */
export function barContrast(preview: SidebarPreview): number {
  return contrastRatio(hexToRgb(preview.bar), hexToRgb(preview.activeBg));
}

export interface BrandWarning {
  field: 'color_primary' | 'color_secondary' | 'logo_icon_url' | 'logo_url_white';
  text: string;
}

const LABEL: Record<'color_primary' | 'color_secondary', string> = {
  color_primary: 'primario',
  color_secondary: 'secundario',
};

/** Avisos de marca, en el orden en que se ven en el formulario. */
export function brandWarnings(input: {
  color_primary: string;
  color_secondary: string;
  logo_url_white: string;
  logo_icon_url: string;
}): BrandWarning[] {
  const out: BrandWarning[] = [];
  const checks = {
    color_primary: checkColor(input.color_primary, DEFAULT_PRIMARY),
    color_secondary: checkColor(input.color_secondary, DEFAULT_SECONDARY),
  };
  for (const field of ['color_primary', 'color_secondary'] as const) {
    const c = checks[field];
    const name = LABEL[field];
    if (c.invalid) {
      out.push({
        field,
        text: `El color ${name} «${input[field]}» no es un hex válido (#RRGGBB): se va a usar ${c.palette.base}.`,
      });
    } else if (c.extreme) {
      const where = c.extreme === 'white' ? 'sobre fondos claros' : 'en el tema oscuro';
      const becomes = c.extreme === 'white' ? c.palette.light : c.palette.inkDark;
      out.push({
        field,
        text: `El ${name} es ${c.extreme === 'white' ? 'blanco' : 'negro'} (${c.palette.base}): no se ve ${where}, así que el sistema lo degrada a ${becomes}, que ya no es la marca. Conviene cargar el color de marca real.`,
      });
    } else if (clashesWithLoss(input[field])) {
      out.push({
        field,
        text: `El ${name} es rojo (${input[field]}): se usa sólo en el menú lateral y el login. En el contenido se usan los colores del producto para que no se confunda con pérdidas y errores.`,
      });
    }
  }
  if (!input.logo_icon_url) {
    out.push({
      field: 'logo_icon_url',
      text: 'Sin isotipo: el menú contraído (64 px) muestra la inicial del nombre en lugar de la marca.',
    });
  }
  if (!input.logo_url_white) {
    out.push({
      field: 'logo_url_white',
      text: 'Sin logo blanco: sobre el sidebar oscuro se usa el logo color, que puede no leerse.',
    });
  }
  return out;
}
