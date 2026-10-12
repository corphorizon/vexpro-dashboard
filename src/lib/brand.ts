// ─────────────────────────────────────────────────────────────────────────────
// Paleta Smart Dashboard — origen ÚNICO.
//
// Los mismos hex estaban escritos a mano en cuatro lugares: globals.css, la
// constante `C` de pdf-export.ts, los estilos inline de reports/email-template.ts
// y valores sueltos en reports/pdf.ts. Cambiar el color de marca obligaba a
// encontrarlos todos, y cualquier olvido dejaba un PDF o un email con la
// paleta vieja sin que nadie lo notara.
//
// Ahora todo el TypeScript importa de acá. globals.css NO puede importar TS,
// así que sus variables se mantienen a mano — pero hay un test
// (brand.test.ts) que lee el CSS y falla si los valores dejan de coincidir.
//
// DISTINCIÓN IMPORTANTE:
//   · Esta paleta es la de SMART DASHBOARD (el producto).
//   · `companies.color_primary` es el color de CADA EMPRESA y es el que manda
//     en los documentos de esa empresa (portada del reporte, sellos, barras
//     de sección). Los colores de acá son el resto del sistema: semánticos,
//     grises, superficies y la marca del pie.
// ─────────────────────────────────────────────────────────────────────────────

export type RGB = [number, number, number];

/** Paleta en hex — la fuente. Todo lo demás se deriva. */
export const BRAND_HEX = {
  /** Navy de identidad: headers, botón primario, encabezados de tabla. */
  primary: '#1E3A5F',
  /** Azul de acento: barras, foco, detalles. */
  accent: '#3B82F6',

  /** Tinta principal sobre fondo claro. */
  ink: '#0F172A',
  /** Texto secundario. */
  muted: '#64748B',
  /** Texto terciario: pies de página, notas al margen. */
  mutedLight: '#94A3B8',
  /** Tinta suave: subtítulos y cuerpo secundario. */
  inkSoft: '#334155',
  /** Bordes y divisores. */
  border: '#E2E8F0',
  /** Fondo de fila alterna / superficie sutil. */
  surface: '#F8FAFC',
  white: '#FFFFFF',

  // ── Semánticos ──
  // Se usan los tonos 600: sobre papel blanco los 500 quedan lavados y en un
  // PDF impreso no se distingue una ganancia de una pérdida.
  //
  // CORRECCIÓN 2026-10-12 (rediseño «Libro mayor», fase 0): «los 600» no
  // alcanzaba para dos de los cuatro. Medido contra blanco con la fórmula
  // WCAG: emerald-600 #059669 daba 3,77:1 y amber-600 #D97706 3,19:1 — los
  // dos por debajo de 4,5:1 (AA texto), justo los colores con que se pinta
  // una ganancia y un «pendiente» en tablas de 13px. Pasan a #047857
  // (5,48:1) y #A15C07 (5,19:1), que son además los valores de
  // `--pos`/`--pend` de la dirección nueva (docs/diseno-libro-mayor.md).
  // Descartado: amber-700 de Tailwind (#B45309, 5,02:1) — también pasa, pero
  // dejaría la app y el token `--pend` del diseño nuevo con dos ámbares
  // distintos; un solo valor para pantalla, PDF y email.
  // Rojo #DC2626 (4,83:1) pasa: no se toca. Info #2563EB pasaba sobre blanco
  // (5,17:1) pero no sobre su fondo nuevo --info-bg (4,48:1): pasa a #1D5BD6
  // (5,97:1 / 5,17:1), el `--info` de la maqueta.
  /** Ganancia, ingreso, éxito. */
  positive: '#047857',
  /** Pérdida, egreso, destructivo. */
  negative: '#DC2626',
  /** Pendiente, atención. */
  warning: '#A15C07',
  /** Informativo, neutro con énfasis. */
  info: '#1D5BD6',
} as const;

export type BrandColorName = keyof typeof BRAND_HEX;

/** '#1E3A5F' → [30, 58, 95]. Acepta forma corta (#abc) y tolera basura. */
export function hexToRgb(hex: string | null | undefined, fallback: RGB = [30, 58, 95]): RGB {
  if (!hex) return fallback;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return fallback;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** La misma paleta en tuplas RGB — jsPDF trabaja con canales, no con hex. */
export const BRAND_RGB: Record<BrandColorName, RGB> = Object.fromEntries(
  (Object.keys(BRAND_HEX) as BrandColorName[]).map((k) => [k, hexToRgb(BRAND_HEX[k])]),
) as Record<BrandColorName, RGB>;

/**
 * Luminancia relativa (WCAG). Sirve para decidir si sobre un color de marca
 * va texto blanco o negro: hay empresas con primarios claros, y pintar texto
 * blanco encima los vuelve ilegibles en el PDF.
 */
export function relativeLuminance(rgb: RGB): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Blanco o tinta, el que contraste mejor contra `background`. */
export function readableTextOn(background: RGB): RGB {
  return relativeLuminance(background) > 0.5 ? BRAND_RGB.ink : BRAND_RGB.white;
}
