'use client';

import { Moon, Sun } from 'lucide-react';
import { AuthBrand } from '@/components/auth-brand';
import { StatusBadge } from '@/components/ui/status-badge';
import { useI18n } from '@/lib/i18n';
import { useTheme } from '@/lib/theme-context';
import { formatMoney } from '@/lib/money';
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
//             motivo de libro mayor (reglas finas cada 36 px = `h-row`) y una
//             franja de KPIs de EJEMPLO; a la derecha el formulario sobre la
//             superficie limpia (`bg-card`).
//   < 960 px  una columna: logo arriba, formulario. La ilustración no aparece
//             (en 390 px no aporta y empuja el formulario fuera de la vista).
//   Arriba a la derecha, siempre: idioma y tema (40×40, `aria-label`).
//
// La franja de ejemplo dice «Ilustración · cifras de ejemplo» en texto
// visible y va `aria-hidden`: un lector de pantalla no tiene por qué leer
// montos inventados en la puerta de entrada de un sistema financiero, y
// alguien que mira tampoco puede confundirlos con datos reales.
//
// DESCARTADO:
//   · Logo de la empresa por subdominio: no existe esa lógica hoy (ver
//     auth-brand.tsx). Si aparece, entra por la prop `brand`.
//   · Fondo con imagen / gradiente de marca: «el color es significado, nunca
//     decoración» (spec §2.1). El motivo es gris (`border`) sobre `surface-2`.
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

/** Mini libro mayor de EJEMPLO (decorativo). Cifras fijas, marcadas como ilustración. */
function LedgerSample() {
  const { t } = useI18n();
  const rows = [
    { name: 'Binance', src: 'API', amount: 62_410.2, stale: false },
    { name: t('auth.sample.bank'), src: 'Manual', amount: 40_120, stale: true },
    { name: 'Coinsbuy', src: 'API', amount: 18_904.75, stale: false },
  ];
  return (
    <div className="w-full max-w-[460px]">
      {/* text-2, no text-3: sobre `surface-2` el terciario da 4,28:1 (no AA). */}
      <p className="text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-2">{t('auth.sample.label')}</p>
      <div aria-hidden="true" className="mt-2 overflow-hidden rounded-ui-lg border border-border bg-card shadow-1">
        <div className="grid grid-cols-3">
          <div className="px-4 py-3">
            <p className="text-[12px] font-medium text-text-2">{t('auth.sample.available')}</p>
            <p className="mt-0.5 text-[20px] font-semibold leading-7 tracking-[-0.02em] tabular-nums slashed-zero whitespace-nowrap">
              {formatMoney(121_434.95, { compact: true })}
            </p>
          </div>
          <div className="border-l border-border px-4 py-3">
            <p className="text-[12px] font-medium text-text-2">{t('auth.sample.netDeposit')}</p>
            <p className="mt-0.5 text-[20px] font-semibold leading-7 tracking-[-0.02em] text-pos tabular-nums slashed-zero whitespace-nowrap">
              {formatMoney(12_480, { compact: true, signed: true })}
            </p>
          </div>
          <div className="border-l border-border px-4 py-3">
            <p className="text-[12px] font-medium text-text-2">{t('auth.sample.toApprove')}</p>
            <p className="mt-0.5 text-[20px] font-semibold leading-7 tracking-[-0.02em] tabular-nums">7</p>
          </div>
        </div>
        <ul className="border-t border-border text-[13px]">
          {rows.map((r) => (
            <li key={r.name} className="flex h-row items-center justify-between gap-3 border-b border-border px-4 last:border-b-0">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{r.name}</span>
                <span
                  className={cn(
                    'rounded-ui-sm border px-1 text-[10.5px] font-semibold uppercase leading-4',
                    r.src === 'API' ? 'border-info/35 text-info' : 'border-border-strong text-text-2',
                  )}
                >
                  {r.src}
                </span>
                {r.stale && <StatusBadge kind="stale" label={t('auth.sample.staleAgo')} />}
              </span>
              <span
                className={cn(
                  'font-medium tabular-nums slashed-zero whitespace-nowrap',
                  r.stale && 'text-text-2 underline decoration-stale decoration-dotted underline-offset-[3px]',
                )}
              >
                {formatMoney(r.amount)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
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
      <aside className="relative hidden overflow-hidden border-r border-border bg-surface-2 min-[960px]:flex min-[960px]:flex-col min-[960px]:justify-between min-[960px]:gap-10 min-[960px]:p-10">
        {/* Motivo de libro mayor: reglas de 1 px cada 36 px (= alto de fila) y
            la doble raya del margen, en el gris de los bordes. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[length:100%_36px] opacity-70"
        />
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-6 w-[3px] border-x border-border-strong opacity-60" />

        <div className="relative flex items-center gap-3">
          <AuthBrand className="size-14" alt="" />
          <span className="text-[15px] font-semibold tracking-[-0.005em]">Smart Dashboard</span>
        </div>

        <div className="relative space-y-8">
          <p className="max-w-[420px] text-[26px] font-semibold leading-8 tracking-[-0.02em] text-balance">
            {t('auth.tagline')}
          </p>
          <LedgerSample />
        </div>

        <p className="relative text-[12px] text-text-2">© {new Date().getFullYear()} Smart Dashboard</p>
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
