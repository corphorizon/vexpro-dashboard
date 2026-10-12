'use client';

// ─────────────────────────────────────────────────────────────────────────────
// SuperadminShell — barra lateral + topbar del panel de plataforma con el
// lenguaje «Libro mayor» (2026-10-12).
//
// POR QUÉ: /superadmin tenía su propia cabecera `bg-slate-900 text-slate-100`
// (siempre oscura, paleta cruda, ícono `text-amber-300` decorativo) y los
// accesos a Usuarios / Tokens / Liquidez eran botones sueltos en la cabecera
// de una sola página: desde /superadmin/tokens no había forma de ir a
// Usuarios sin volver al panel. Ahora es de la misma familia que el shell del
// dashboard (components/sidebar.tsx + topbar.tsx): sidebar 232 px que sigue el
// tema con ítem activo `brand-tint` + barra de 3 px `brand-ink`, topbar de
// 52 px con migas y tema, drawer de 272 px con scrim bajo 960 px.
//
// La lista de entradas es SUPERADMIN_NAV (superadmin-model.ts), propia del
// panel: no copia NAV_ENTRIES (el menú del dashboard decide por módulo de
// empresa y ninguna de estas rutas es un módulo).
//
// DESCARTADO:
//   · Reusar <Sidebar>/<Topbar> del dashboard: dependen de useData() /
//     usePeriod() (empresa activa, períodos, notificaciones) que acá no
//     existen — el superadmin no está «dentro» de una empresa.
//   · Rail contraído (64 px): son cuatro entradas; no ahorra nada.
//   · Selector de idioma: el panel está escrito en castellano fijo (nunca usó
//     t()); un botón EN que sólo traduce la barra sería mentirle al usuario.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Menu, Moon, ShieldCheck, Sun } from 'lucide-react';
import { AuthBrand } from '@/components/auth-brand';
import { useI18n } from '@/lib/i18n';
import { useTheme } from '@/lib/theme-context';
import { cn } from '@/lib/utils';
import { SUPERADMIN_NAV, activeSuperadminEntry, initials, superadminCrumbs } from './superadmin-model';

const DRAWER_QUERY = '(max-width: 959.98px)';
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const SIDEBAR_ID = 'superadmin-sidebar';

const ICON_BUTTON = cn(
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-ui-md text-text-2 transition-colors motion-reduce:transition-none',
  'hover:bg-surface-2 hover:text-foreground',
);

interface ShellProps {
  email: string;
  name?: string | null;
  onLogout: () => void;
  children: React.ReactNode;
}

export function SuperadminShell({ email, name, onLogout, children }: ShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const close = useCallback(() => setMobileOpen(false), []);

  // Al pasar a escritorio el drawer no tiene sentido: se cierra solo.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 960px)');
    const onChange = () => {
      if (mq.matches) setMobileOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <div className="flex h-full bg-background text-foreground">
      <SuperadminSidebar
        mobileOpen={mobileOpen}
        onClose={close}
        email={email}
        name={name}
        onLogout={onLogout}
      />
      {/* `relative`: mismo motivo que en el layout del dashboard (los inputs
          `sr-only` absolutos no escapan del overflow de este main). */}
      <main className="relative min-w-0 flex-1 overflow-auto">
        <div className="sticky top-[env(safe-area-inset-top,0px)] z-30">
          <SuperadminTopbar menuOpen={mobileOpen} onMenuToggle={() => setMobileOpen((v) => !v)} />
        </div>
        <div className="mx-auto w-full max-w-[1360px] px-4 pb-12 pt-4 sm:px-6 sm:pb-16 sm:pt-6">{children}</div>
      </main>
    </div>
  );
}

function SuperadminSidebar({
  mobileOpen,
  onClose,
  email,
  name,
  onLogout,
}: {
  mobileOpen: boolean;
  onClose: () => void;
  email: string;
  name?: string | null;
  onLogout: () => void;
}) {
  const pathname = usePathname();
  const { t } = useI18n();
  const active = activeSuperadminEntry(pathname);
  const asideRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Drawer móvil: foco atrapado + Escape (misma receta que components/sidebar.tsx).
  useEffect(() => {
    if (!mobileOpen) return;
    const aside = asideRef.current;
    if (!aside) return;
    const isDrawer = () => window.matchMedia(DRAWER_QUERY).matches;
    if (!isDrawer()) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(aside.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!isDrawer()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !aside.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !aside.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [mobileOpen]);

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/45 min-[960px]:hidden" onClick={onClose} aria-hidden="true" />
      )}
      <aside
        id={SIDEBAR_ID}
        ref={asideRef}
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label={mobileOpen ? t('shell.mainNav') : undefined}
        className={cn(
          'h-full w-58 shrink-0 flex-col border-r border-border bg-card text-foreground',
          'hidden min-[960px]:flex',
          mobileOpen &&
            'max-[959.98px]:fixed max-[959.98px]:inset-y-0 max-[959.98px]:left-0 max-[959.98px]:z-50 max-[959.98px]:flex max-[959.98px]:w-68 max-[959.98px]:shadow-3',
        )}
      >
        {/* ── Marca de la plataforma ── */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-3.5 py-3">
          <Link href="/superadmin" onClick={onClose} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-ui-md">
            <AuthBrand className="size-7.5" alt="" />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold leading-tight">Smart Dashboard</span>
              <span className="flex items-center gap-1 truncate text-[12px] leading-tight text-text-3">
                <ShieldCheck aria-hidden className="size-3 shrink-0" />
                Plataforma · Superadmin
              </span>
            </span>
          </Link>
        </div>

        {/* ── Navegación propia del panel ── */}
        <nav aria-label="Panel de plataforma" className="flex-1 overflow-y-auto px-2.5 py-2">
          <p id="sa-nav-heading" className="px-2.5 pb-1 pt-2 text-[11.5px] font-semibold uppercase tracking-[.06em] text-text-3">
            Plataforma
          </p>
          <ul className="space-y-0.5" aria-labelledby="sa-nav-heading">
            {SUPERADMIN_NAV.map((e) => {
              const isActive = active?.href === e.href;
              const Icon = e.icon;
              return (
                <li key={e.href}>
                  <Link
                    href={e.href}
                    onClick={onClose}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'relative flex h-8.5 items-center gap-2.5 rounded-ui-md px-2.5 text-[13.5px] font-medium transition-colors motion-reduce:transition-none pointer-coarse:h-11',
                      isActive
                        ? 'bg-brand-tint font-semibold text-brand-ink before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-brand-ink'
                        : 'text-text-2 hover:bg-surface-2 hover:text-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{e.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* ── Pie: quién está operando + salir ── */}
        <div className="flex shrink-0 items-center gap-2.5 border-t border-border px-3 py-2.5">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[12px] font-semibold text-text-2"
          >
            {initials(name || email)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-tight">{name || email}</span>
            <span className="block truncate text-[12px] leading-tight text-text-3">{name ? email : 'Superadmin'}</span>
          </span>
          <button
            type="button"
            onClick={onLogout}
            aria-label={t('nav.logout')}
            title={t('nav.logout')}
            className={cn(ICON_BUTTON, 'hover:bg-neg-bg hover:text-neg')}
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </aside>
    </>
  );
}

function SuperadminTopbar({ menuOpen, onMenuToggle }: { menuOpen: boolean; onMenuToggle: () => void }) {
  const pathname = usePathname();
  const { t } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const { section, page } = superadminCrumbs(pathname);
  const themeLabel = resolvedTheme === 'dark' ? t('shell.themeToLight') : t('shell.themeToDark');

  return (
    <header className="flex h-13 items-center gap-3 border-b border-border bg-background/88 px-6 backdrop-blur-[8px] max-[959.98px]:px-4">
      <button
        type="button"
        onClick={onMenuToggle}
        aria-label={menuOpen ? t('shell.closeMenu') : t('shell.openMenu')}
        aria-expanded={menuOpen}
        aria-controls={SIDEBAR_ID}
        className={cn(ICON_BUTTON, '-ml-2 min-[960px]:hidden')}
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      <nav aria-label={t('shell.breadcrumb')} className="min-w-0">
        <ol className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
          <li className="flex items-center gap-1.5 text-text-3 max-sm:hidden">
            <span className="whitespace-nowrap">Plataforma</span>
            {section && <span aria-hidden="true">/</span>}
          </li>
          {section && page && (
            <li className="flex items-center gap-1.5 text-text-3 max-sm:hidden">
              <span className="whitespace-nowrap">{section}</span>
              <span aria-hidden="true">/</span>
            </li>
          )}
          {(page ?? section) && (
            <li className="min-w-0">
              <span aria-current="page" className="block truncate font-semibold text-foreground">
                {page ?? section}
              </span>
            </li>
          )}
        </ol>
      </nav>

      <div className="ml-auto flex shrink-0 items-center">
        <button
          type="button"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          aria-label={themeLabel}
          title={themeLabel}
          className={ICON_BUTTON}
        >
          {resolvedTheme === 'dark' ? (
            <Sun className="h-[18px] w-[18px]" aria-hidden="true" />
          ) : (
            <Moon className="h-[18px] w-[18px]" aria-hidden="true" />
          )}
        </button>
      </div>
    </header>
  );
}
