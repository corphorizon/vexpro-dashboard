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
//
// `applyCompanyTheme` al cargar la empresa; `resetCompanyTheme` al salir, que
// devuelve los respaldos de globals.css (la marca del producto).
// ─────────────────────────────────────────────────────────────────────────────

import { buildBrandPalette } from './brand-color';

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
] as const;

const isClient = () => typeof document !== 'undefined';

export function applyCompanyTheme(theme: { primary?: string | null; secondary?: string | null }): void {
  if (!isClient()) return;
  const root = document.documentElement;
  const primary = buildBrandPalette(theme.primary, DEFAULT_PRIMARY);
  const secondary = buildBrandPalette(theme.secondary, DEFAULT_SECONDARY);

  root.style.setProperty('--brand-primary-base', primary.base);
  root.style.setProperty('--brand-primary-light', primary.light);
  root.style.setProperty('--brand-primary-dark', primary.dark);
  root.style.setProperty('--brand-primary-ink-light', primary.light);
  root.style.setProperty('--brand-primary-ink-dark', primary.inkDark);
  root.style.setProperty('--brand-primary-fg-light', primary.fgLight);
  root.style.setProperty('--brand-primary-fg-dark', primary.fgDark);

  root.style.setProperty('--brand-secondary-base', secondary.base);
  root.style.setProperty('--brand-secondary-light', secondary.light);
  root.style.setProperty('--brand-secondary-dark', secondary.dark);
  // El acento en oscuro va sobre fondo, no debajo de texto blanco: puede ser
  // la tinta clara y así el anillo de foco se ve de verdad.
  root.style.setProperty('--brand-secondary-ink-dark', secondary.inkDark);
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
