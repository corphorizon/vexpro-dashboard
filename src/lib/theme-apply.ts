// ─────────────────────────────────────────────────────────────────────────────
// theme-apply — escribe los colores de la empresa activa en las variables CSS.
//
// NO escribe `--color-primary` directamente, y eso es a propósito: un estilo
// inline en <html> le gana a la regla `.dark`, así que un único valor inyectado
// dejaría al tema oscuro sin poder corregirlo. En cambio se inyectan las
// VARIANTES ya corregidas por contraste (src/lib/brand-color.ts) con nombres
// neutros al tema, y globals.css elige cuál usar en :root y en .dark.
//
//   --brand-primary-light      relleno + tinta en tema claro
//   --brand-primary-dark       relleno en tema oscuro (y sidebar, siempre oscuro)
//   --brand-primary-ink-light  tinta en claro
//   --brand-primary-ink-dark   tinta en oscuro
//   --brand-primary-fg-*       blanco o negro para el texto ENCIMA del relleno
//   --brand-secondary-*        lo mismo para el secundario (acento y foco)
//   --brand-tint-* / --brand-wash-*   tintes de superficie (ítem activo, cabecera
//                              de tabla), con el tono del acento
//   --brand-sidebar-*          el sidebar oscuro de marca (los dos temas)
//
// El secundario que se usa es el USABLE (`usableSecondary`): si la empresa
// cargó blanco o negro (Exura Prime #ffffff, Exura Liquidez #000000), el acento
// pasa a ser el primario — un acento gris no se ve en uno de los dos temas.
//
// `applyCompanyTheme` al cargar la empresa; `resetCompanyTheme` al salir, que
// devuelve los respaldos de globals.css (la marca del producto).
// ─────────────────────────────────────────────────────────────────────────────

import { buildBrandPalette, buildBrandTints, buildSidebarPalette, usableSecondary } from './brand-color';

const DEFAULT_PRIMARY = '#1E3A5F';
const DEFAULT_SECONDARY = '#3B82F6';

/** Todas las variables que tocamos — una sola lista para poder limpiarlas. */
const VARS = [
  '--brand-primary-base',
  '--brand-primary-light',
  '--brand-primary-dark',
  '--brand-primary-ink-light',
  '--brand-primary-ink-dark',
  '--brand-primary-fg-light',
  '--brand-primary-fg-dark',
  '--brand-secondary-base',
  '--brand-secondary-light',
  '--brand-secondary-dark',
  '--brand-secondary-ink-dark',
  '--brand-tint-light',
  '--brand-tint-dark',
  '--brand-wash-light',
  '--brand-wash-dark',
  '--brand-sidebar-bg',
  '--brand-sidebar-fg',
  '--brand-sidebar-muted',
  '--brand-sidebar-hover',
  '--brand-sidebar-border',
  '--brand-sidebar-accent',
  '--brand-sidebar-active-bg',
] as const;

/** Exportada para el test: `companyThemeVars` escribe exactamente estas. */
export const COMPANY_THEME_VARS: readonly string[] = VARS;

/** Todas las variables derivadas de una marca, en el orden de `VARS`. Pura:
 *  la usan `applyCompanyTheme` y los tests (sin DOM). */
export function companyThemeVars(theme: {
  primary?: string | null;
  secondary?: string | null;
}): Record<(typeof VARS)[number], string> {
  const primary = buildBrandPalette(theme.primary, DEFAULT_PRIMARY);
  const secondary = buildBrandPalette(
    usableSecondary(theme.primary, theme.secondary, DEFAULT_SECONDARY),
    DEFAULT_SECONDARY,
  );
  const tints = buildBrandTints(primary, secondary);
  const sb = buildSidebarPalette(theme.primary, theme.secondary, DEFAULT_PRIMARY, DEFAULT_SECONDARY);
  return {
    '--brand-primary-base': primary.base,
    '--brand-primary-light': primary.light,
    '--brand-primary-dark': primary.dark,
    '--brand-primary-ink-light': primary.light,
    '--brand-primary-ink-dark': primary.inkDark,
    '--brand-primary-fg-light': primary.fgLight,
    '--brand-primary-fg-dark': primary.fgDark,
    '--brand-secondary-base': secondary.base,
    '--brand-secondary-light': secondary.light,
    '--brand-secondary-dark': secondary.dark,
    // El acento en oscuro va sobre fondo, no debajo de texto blanco: puede ser
    // la tinta clara y así el anillo de foco se ve de verdad.
    '--brand-secondary-ink-dark': secondary.inkDark,
    '--brand-tint-light': tints.tintLight,
    '--brand-tint-dark': tints.tintDark,
    '--brand-wash-light': tints.washLight,
    '--brand-wash-dark': tints.washDark,
    '--brand-sidebar-bg': sb.bg,
    '--brand-sidebar-fg': sb.fg,
    '--brand-sidebar-muted': sb.muted,
    '--brand-sidebar-hover': sb.hover,
    '--brand-sidebar-border': sb.border,
    '--brand-sidebar-accent': sb.accent,
    '--brand-sidebar-active-bg': sb.activeBg,
  };
}

const isClient = () => typeof document !== 'undefined';

export function applyCompanyTheme(theme: { primary?: string | null; secondary?: string | null }): void {
  if (!isClient()) return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(companyThemeVars(theme))) {
    root.style.setProperty(name, value);
  }
}

export function resetCompanyTheme(): void {
  if (!isClient()) return;
  const root = document.documentElement;
  for (const v of VARS) root.style.removeProperty(v);
  // Compatibilidad: versiones anteriores escribían estas tres inline y podían
  // quedar pegadas en un <html> ya montado.
  root.style.removeProperty('--color-primary');
  root.style.removeProperty('--color-secondary');
  root.style.removeProperty('--accent');
}
