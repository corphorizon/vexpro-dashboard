'use client';

import { Moon, Sun } from 'lucide-react';
import { AuthBrand } from '@/components/auth-brand';
import { useI18n } from '@/lib/i18n';
import { useTheme } from '@/lib/theme-context';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// AuthShell — composición de las pantallas de acceso «Libro mayor»
// (login, recuperación, reset de contraseña, setup/reset de 2FA).
//
// POR QUÉ (2026-10-12, pedido del dueño: «aplicar ese diseño a todo el sitio
// incluyendo login»): las cinco pantallas repetían a mano el mismo esqueleto
// (`min-h-screen … max-w-md` + logo de 160 px + tarjeta `rounded-xl p-6
// shadow-sm`), cada una con su variante; ninguna tenía selector de tema ni de
// idioma (la topbar con el toggle vive dentro del dashboard), y la mitad de los
// textos estaba en inglés fijo y la otra mitad en español fijo.
//
// Composición:
//   ≥ 960 px  dos columnas: a la izquierda la marca sobre `surface-2` con el
//             motivo de libro mayor (reglas finas cada 36 px = `h-row`), el
//             lema y las tres áreas en texto (Finanzas, Recursos Humanos, Risk
//             Management); a la derecha el formulario sobre `bg-card`.
//   < 960 px  una columna: logo arriba, formulario. La ilustración no aparece
//             (en 390 px no aporta y empuja el formulario fuera de la vista).
//   Arriba a la derecha, siempre: idioma y tema (40×40, `aria-label`).
//
// 2026-10-12: se quitó la franja de KPIs de ejemplo (pedido de Kevin: «solo
// deja texto»). Montos inventados en la puerta de un sistema financiero
// sumaban ruido; las áreas en texto dicen qué hay adentro.
//
// 2026-10-12 (tarde), «más color» + sidebar oscuro de marca: la columna de
// marca usa el MISMO fondo oscuro que el sidebar (`--sidebar-bg`,
// `data-surface="brand-dark"`), así la puerta y el dashboard se leen como una
// sola marca. Antes del login no hay empresa: `resetCompanyTheme` deja los
// respaldos de globals.css, que son la marca del producto (#1E3A5F/#3B82F6).
// Cada área lleva un filete del color de su grupo en el menú (`--nav-*`): el
// mismo código de color que el usuario va a ver adentro.
//
// DESCARTADO:
//   · Logo de la empresa por subdominio: no existe esa lógica hoy (ver
//     auth-brand.tsx). Si aparece, entra por la prop `brand`.
//   · Fondo con imagen / gradiente de marca: el fondo es plano (el oscuro de
//     marca, medido); el motivo de reglas va en `--sidebar-border`.
// ─────────────────────────────────────────────────────────────────────────────

export const ICON_BUTTON_CLASS =
  'inline-flex size-10 items-center justify-center rounded-ui-md text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground motion-reduce:transition-none';

/** Idioma y tema. Viven fuera del dashboard: las pantallas de acceso no tienen topbar. */
export function AuthPreferences({ className }: { className?: string }) {
  const { t, locale, setLocale } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const nextLocale = locale === 'es' ? 'en' : 'es';
  const themeLabel = resolvedTheme === 'dark' ? t('auth.theme.toLight') : t('auth.theme.toDark');
  const localeLabel = t('auth.locale.switch', { lang: t(`auth.locale.${nextLocale}`) });
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <button
        type="button"
        onClick={() => setLocale(nextLocale)}
        aria-label={localeLabel}
        title={localeLabel}
        lang={nextLocale}
        className={cn(ICON_BUTTON_CLASS, 'w-auto px-2.5 text-[12.5px] font-semibold tracking-[.03em]')}
      >
        {nextLocale.toUpperCase()}
      </button>
      <button
        type="button"
        onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
        aria-label={themeLabel}
        title={themeLabel}
        className={ICON_BUTTON_CLASS}
      >
        {resolvedTheme === 'dark' ? <Sun aria-hidden className="size-[18px]" /> : <Moon aria-hidden className="size-[18px]" />}
      </button>
    </div>
  );
}

/** Las tres áreas del sistema, sólo texto (Kevin, 2026-10-12: «solo deja texto»). */
function AuthAreas() {
  const { t } = useI18n();
  const areas = [
    { title: t('auth.area.finance'), desc: t('auth.area.financeDesc'), bar: 'border-nav-finance' },
    { title: t('auth.area.hr'), desc: t('auth.area.hrDesc'), bar: 'border-nav-hr' },
    { title: t('auth.area.risk'), desc: t('auth.area.riskDesc'), bar: 'border-nav-risk' },
  ];
  return (
    <ul className="max-w-[420px] space-y-4">
      {areas.map((a) => (
        <li key={a.title} className={cn('border-l-[3px] pl-3', a.bar)}>
          <p className="text-[15px] font-semibold text-sidebar-fg">{a.title}</p>
          {/* sidebar-muted: ≥ 4,5:1 sobre el fondo oscuro de marca. */}
          <p className="mt-0.5 text-[13.5px] leading-5 text-sidebar-muted">{a.desc}</p>
        </li>
      ))}
    </ul>
  );
}

export interface AuthShellProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Ícono / badge sobre el título (p. ej. el escudo de 2FA o el check de éxito). */
  icon?: React.ReactNode;
  /** Pie bajo el formulario (enlaces secundarios, notas). */
  footer?: React.ReactNode;
  children?: React.ReactNode;
  /** Ancho máx. de la columna del formulario. 400 por defecto (setup de 2FA usa 440). */
  width?: 'default' | 'wide';
}

export function AuthShell({ title, subtitle, icon, footer, children, width = 'default' }: AuthShellProps) {
  const { t } = useI18n();
  return (
    <div className="min-h-dvh bg-card text-foreground min-[960px]:grid min-[960px]:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside
        data-surface="brand-dark"
        className="relative hidden overflow-hidden border-r border-sidebar-border bg-sidebar-bg text-sidebar-fg min-[960px]:flex min-[960px]:flex-col min-[960px]:justify-between min-[960px]:gap-10 min-[960px]:p-10"
      >
        {/* Motivo de libro mayor: reglas de 1 px cada 36 px (= alto de fila) y
            la doble raya del margen, en el gris de los bordes. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,var(--sidebar-border)_1px,transparent_1px)] bg-[length:100%_36px] opacity-60"
        />
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-6 w-[3px] border-x border-sidebar-accent opacity-50" />

        <div className="relative flex items-center gap-3">
          <AuthBrand className="size-14" alt="" onDark />
          <span className="text-[15px] font-semibold tracking-[-0.005em]">Smart Dashboard</span>
        </div>

        <div className="relative space-y-8">
          <p className="max-w-[420px] text-[26px] font-semibold leading-8 tracking-[-0.02em] text-balance">
            {t('auth.tagline')}
          </p>
          <AuthAreas />
        </div>

        <p className="relative text-xs text-sidebar-muted">© {new Date().getFullYear()} Smart Dashboard</p>
      </aside>

      <main className="flex min-h-dvh flex-col">
        {/* El logo en móvil vive dentro de la columna (ver abajo); acá sólo
            las preferencias, arriba a la derecha. */}
        <div className="flex justify-end px-3 pt-3 sm:px-4">
          <AuthPreferences />
        </div>
        <div className="flex flex-1 items-center justify-center px-4 pb-12 pt-4 sm:px-6">
          <div className={cn('w-full', width === 'wide' ? 'max-w-[440px]' : 'max-w-[400px]')}>
            <AuthBrand className="mb-6 size-20 min-[960px]:hidden" />
            {icon != null && <div className="mb-4">{icon}</div>}
            <h1 className="text-[22px] font-[650] leading-7 tracking-[-0.015em] max-sm:text-[20px]">{title}</h1>
            {subtitle != null && <p className="mt-1.5 text-[13.5px] leading-5 text-text-2">{subtitle}</p>}
            {children != null && <div className="mt-6">{children}</div>}
            {footer != null && <div className="mt-4 text-[13px] text-text-2">{footer}</div>}
          </div>
        </div>
      </main>
    </div>
  );
}

/** Ícono en un cuadro de 40 px con el fondo de su significado (pos / info). */
export function AuthIcon({ tone, children }: { tone: 'pos' | 'info'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex size-10 items-center justify-center rounded-ui-md',
        tone === 'pos' ? 'bg-pos-bg text-pos' : 'bg-info-bg text-info',
      )}
    >
      {children}
    </span>
  );
}
