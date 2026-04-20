// ─────────────────────────────────────────────────────────────────────────────
// theme-apply — tiny helper that writes a tenant's brand colors into the
// document's CSS custom properties.
//
// We already use `var(--color-primary)` and `var(--color-secondary)` in
// dozens of components. This helper lets the data-context override the
// stylesheet defaults at runtime whenever the active company changes.
//
// Call `applyCompanyTheme({ primary, secondary })` when company loads.
// Call `resetCompanyTheme()` on logout to restore the app defaults from
// globals.css.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PRIMARY = '#1E3A5F';
const DEFAULT_SECONDARY = '#3B82F6';

const isClient = () => typeof document !== 'undefined';

export function applyCompanyTheme(theme: { primary?: string | null; secondary?: string | null }): void {
  if (!isClient()) return;
  const root = document.documentElement;
  const primary = theme.primary || DEFAULT_PRIMARY;
  const secondary = theme.secondary || DEFAULT_SECONDARY;
  root.style.setProperty('--color-primary', primary);
  root.style.setProperty('--color-secondary', secondary);
  // Keep --accent in sync with secondary — it's used in focus rings and
  // chart highlights. If a tenant ever wants a distinct accent, add a
  // separate column in `companies`.
  root.style.setProperty('--accent', secondary);
}

export function resetCompanyTheme(): void {
  if (!isClient()) return;
  const root = document.documentElement;
  root.style.removeProperty('--color-primary');
  root.style.removeProperty('--color-secondary');
  root.style.removeProperty('--accent');
}
