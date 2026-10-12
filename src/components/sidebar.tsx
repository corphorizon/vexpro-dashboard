'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, ChevronsUpDown, Globe, LogOut, UserCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api-fetch';
import { useAuth, hasModuleAccess, ROLE_LABELS } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { moduleDisplayLabel } from '@/lib/modules';
import { BUSINESS_MODEL_LABELS, normalizeBusinessModel } from '@/lib/business-model';
import { clearActiveCompanyId } from '@/lib/active-company';
import {
  NAV_ENTRIES,
  NAV_GROUPS,
  findNavEntry,
  type NavEntry,
  type PendingCounterKey,
} from '@/lib/module-groups';

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar «Libro mayor» (docs/diseno-libro-mayor.md §6.1, Fase 4 2026-10-12).
//
// POR QUÉ se rehízo:
//   · Era SIEMPRE oscura (`bg-slate-900`) con 28 colores de paleta cruda y un
//     `#60A5FA` fijo para el ícono de la sección activa. Ahora sigue el tema:
//     superficie (`bg-card` hasta la fase 3), borde `border`, sólo tokens.
//   · Tenía su propia lista (`NAV_STRUCTURE`) y además un modo «plano» que se
//     dibujaba desde OTRA lista (`MODULE_GROUPS`) donde faltaban Forecast y
//     Registro: un usuario de un solo grupo no veía Forecast. Ahora todo sale
//     de `NAV_ENTRIES` (src/lib/module-groups.ts) y el modo plano desaparece:
//     con grupos de rótulo fijo (sin acordeones) un usuario de un solo grupo
//     ya ve exactamente su grupo — el modo plano existía para sacarle los
//     acordeones.
//   · El activo se decide por el href MÁS LARGO que contiene la ruta
//     (`findNavEntry`): antes `/rrhh/dashboard` iluminaba también `/rrhh`.
//
// Descartado:
//   · Mantener las secciones plegables: la spec define rótulos de grupo fijos
//     y el plegado escondía dónde estaba uno (la sección se abría sólo si
//     contenía la página activa).
//   · Mostrar el logo ancho de la empresa arriba: en 232 px se veía chico y
//     en el rail contraído era un cuadrado en blanco. La spec pide el isotipo
//     (o iniciales) a 30×30 sobre `brand` + nombre + modelo · moneda.
//
// Contadores de pendientes: `pendingCounts` es el hueco preparado. Hoy NADIE
// lo llena porque la app no tiene esos números en ningún contexto compartido
// (órdenes de pago y retiros se leen dentro de su pantalla). Se dibuja sólo
// un número > 0 que llegue; nunca un cero o un número inventado.
//
// Rail contraído (sólo ≥ 960 px): íconos con tooltip nativo (`title`) y
// `aria-label`. Móvil (< 960 px): drawer de 272 px con scrim; Escape cierra,
// el foco queda atrapado adentro mientras está abierto y vuelve al botón que
// lo abrió al cerrar.
// ─────────────────────────────────────────────────────────────────────────────

/** El drawer y el rail se separan acá (spec §6.3: 960). */
const DRAWER_QUERY = '(max-width: 959.98px)';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Hasta dos iniciales — avatar del pie y marca de la empresa sin isotipo. */
function initialsOf(name: string | null | undefined): string {
  return (name ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';
}

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
  /** Rail sólo-íconos (≥ 960 px). El estado vive en el layout. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /**
   * Pendientes por contador. Ausente o sin la clave = no se sabe → no se
   * dibuja nada (ver cabecera).
   */
  pendingCounts?: Partial<Record<PendingCounterKey, number>>;
  /** id del <aside>, para el `aria-controls` del botón de menú. */
  id?: string;
}

export function Sidebar({
  mobileOpen = false,
  onClose,
  collapsed = false,
  onToggleCollapse,
  pendingCounts,
  id = 'app-sidebar',
}: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const { company } = useData();
  const { locale, setLocale, t } = useI18n();
  const asideRef = useRef<HTMLElement>(null);
  // `onClose` por ref: si el layout pasa una flecha nueva en cada render, el
  // effect del drawer se re-ejecutaría y le robaría el foco al usuario.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // El rail contraído es SÓLO de escritorio: con el drawer móvil abierto se
  // muestra siempre el menú completo.
  const isCollapsed = collapsed && !mobileOpen;
  const collapseLabel = isCollapsed ? t('nav.expand') : t('nav.collapse');
  const activeHref = findNavEntry(pathname)?.href ?? null;

  // ── Drawer móvil: foco atrapado + Escape ──────────────────────────────────
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
        onCloseRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !aside.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !aside.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Devolver el foco a quien abrió el drawer (el botón de menú).
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [mobileOpen]);

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const handleNavClick = () => {
    onClose?.();
  };

  // Superadmin «viendo como»: cambiar de empresa = volver al panel limpiando
  // el puntero (mismo camino único que el banner «Viendo como»). Un usuario
  // normal pertenece a una sola empresa: no hay selector que mostrar.
  const canSwitchCompany = Boolean(user?.is_superadmin && company);
  const handleSwitchCompany = () => {
    clearActiveCompanyId();
    onClose?.();
    router.push('/superadmin');
  };

  const toggleLanguage = () => {
    const next = locale === 'es' ? 'en' : 'es';
    setLocale(next);
    // Persistir la preferencia para que los EMAILS salgan en el idioma del
    // usuario (fase 7). Fire-and-forget: si falla, localStorage sigue mandando.
    apiFetch('/api/user/language', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: next }),
    }).catch(() => {});
  };

  // Lectura la decide el módulo: TODA entrada pasa por hasModuleAccess
  // (usuario + empresa + modelo de negocio; superadmin incluido para lo que
  // el modelo no contempla).
  const canSee = (e: NavEntry) =>
    hasModuleAccess(user, e.module, company?.active_modules, company?.business_model);

  const ungrouped = NAV_ENTRIES.filter((e) => e.group === null && canSee(e));
  const groups = NAV_GROUPS.map((g) => ({
    group: g,
    entries: NAV_ENTRIES.filter((e) => e.group === g.key && canSee(e)),
  })).filter((g) => g.entries.length > 0);

  const renderLink = (e: NavEntry) => {
    const isActive = e.href === activeHref;
    const Icon = e.icon;
    const label = moduleDisplayLabel(e.module, t(e.i18nKey), company);
    const rawCount = e.pendingKey ? pendingCounts?.[e.pendingKey] : undefined;
    const count = typeof rawCount === 'number' && rawCount > 0 ? rawCount : null;
    const countText = count === null ? null : count > 99 ? '99+' : String(count);
    const countLabel = count === null ? undefined : t('shell.pending', { count: String(count) });

    return (
      <li key={e.href}>
        <Link
          href={e.href}
          onClick={handleNavClick}
          aria-current={isActive ? 'page' : undefined}
          title={isCollapsed ? (countLabel ? `${label} · ${countLabel}` : label) : undefined}
          aria-label={isCollapsed ? (countLabel ? `${label}, ${countLabel}` : label) : undefined}
          className={cn(
            'group relative flex items-center rounded-ui-md text-[13.5px] font-medium transition-colors motion-reduce:transition-none',
            isCollapsed
              ? 'mx-auto h-10 w-10 justify-center'
              : 'h-8.5 gap-2.5 px-2.5 pointer-coarse:h-11',
            isActive
              ? 'bg-brand-tint font-semibold text-brand-ink before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-brand-ink'
              : 'text-text-2 hover:bg-surface-2 hover:text-foreground',
          )}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          {!isCollapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
          {countText !== null && (
            <span
              aria-label={isCollapsed ? undefined : countLabel}
              className={cn(
                'rounded-full bg-pend-bg px-1.5 text-center text-[11.5px] font-semibold leading-5 text-pend tabular-nums',
                isCollapsed ? 'absolute -right-1 -top-1 min-w-5' : 'min-w-5',
              )}
            >
              {countText}
            </span>
          )}
        </Link>
      </li>
    );
  };

  const modelLabel = company
    ? BUSINESS_MODEL_LABELS[normalizeBusinessModel(company.business_model)][locale]
    : null;
  const companySub = [modelLabel, company?.currency].filter(Boolean).join(' · ');
  const roleLabel = user ? (ROLE_LABELS[user.role] || user.role) : '';

  const iconButton = cn(
    'flex h-10 w-10 shrink-0 items-center justify-center rounded-ui-md text-text-2 transition-colors motion-reduce:transition-none',
    'hover:bg-surface-2 hover:text-foreground',
  );

  return (
    <>
      {/* Scrim del drawer móvil */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/45 min-[960px]:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        id={id}
        ref={asideRef}
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label={mobileOpen ? t('shell.mainNav') : undefined}
        className={cn(
          'h-full shrink-0 flex-col border-r border-border bg-card text-foreground',
          'hidden min-[960px]:flex transition-[width] duration-200 motion-reduce:transition-none',
          isCollapsed ? 'w-16' : 'w-58',
          mobileOpen && 'max-[959.98px]:fixed max-[959.98px]:inset-y-0 max-[959.98px]:left-0 max-[959.98px]:z-50 max-[959.98px]:flex max-[959.98px]:w-68 max-[959.98px]:shadow-3',
        )}
      >
        {/* ── Empresa ── */}
        <div
          className={cn(
            'flex shrink-0 items-center border-b border-border',
            isCollapsed ? 'flex-col gap-1 px-2 py-3' : 'gap-2.5 px-3.5 py-3',
          )}
        >
          <Link
            href="/"
            onClick={handleNavClick}
            className={cn('flex min-w-0 items-center gap-2.5 rounded-ui-md', !isCollapsed && 'flex-1')}
            aria-label={company?.name || t('nav.home')}
            title={isCollapsed ? company?.name : undefined}
          >
            {company?.logo_icon_url ? (
              // Isotipo de la empresa (migración 072). <img> nativo: los logos
              // vienen de URLs arbitrarias y no van al allow-list de next/image.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={company.logo_icon_url}
                alt=""
                className="h-7.5 w-7.5 shrink-0 rounded-lg object-contain"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-lg bg-primary text-[12px] font-semibold text-brand-on-primary"
              >
                {initialsOf(company?.name)}
              </span>
            )}
            {!isCollapsed && (
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold leading-tight">
                  {company?.name ?? ''}
                </span>
                {companySub && (
                  <span className="block truncate text-[12px] leading-tight text-text-3">{companySub}</span>
                )}
              </span>
            )}
          </Link>
          {canSwitchCompany && (
            <button
              type="button"
              onClick={handleSwitchCompany}
              aria-label={t('shell.switchCompany')}
              title={t('shell.switchCompany')}
              className={iconButton}
            >
              <ChevronsUpDown className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* ── Navegación ── */}
        <nav
          aria-label={t('shell.mainNav')}
          className={cn('flex-1 overflow-y-auto', isCollapsed ? 'px-2 py-2' : 'px-2.5 py-2')}
        >
          {ungrouped.length > 0 && <ul className="space-y-0.5">{ungrouped.map(renderLink)}</ul>}
          {groups.map(({ group, entries }) => {
            const headingId = `${id}-group-${group.key}`;
            return (
              <div
                key={group.key}
                className={cn(isCollapsed ? 'mt-2 border-t border-border pt-2' : 'mt-3')}
              >
                {!isCollapsed && (
                  <p
                    id={headingId}
                    className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3"
                  >
                    {t(group.i18nKey)}
                  </p>
                )}
                <ul
                  className="space-y-0.5"
                  aria-labelledby={isCollapsed ? undefined : headingId}
                  aria-label={isCollapsed ? t(group.i18nKey) : undefined}
                >
                  {entries.map(renderLink)}
                </ul>
              </div>
            );
          })}
        </nav>

        {/* ── Pie: persona + utilidades ── */}
        <div className={cn('shrink-0 border-t border-border', isCollapsed ? 'px-2 py-2' : 'px-3 py-2.5')}>
          {user && (
            <Link
              href="/perfil"
              onClick={handleNavClick}
              aria-current={pathname === '/perfil' ? 'page' : undefined}
              title={isCollapsed ? `${user.name} · ${roleLabel}` : t('nav.profile')}
              aria-label={isCollapsed ? `${t('nav.profile')}: ${user.name}` : undefined}
              className={cn(
                'flex items-center rounded-ui-md transition-colors hover:bg-surface-2 motion-reduce:transition-none',
                isCollapsed ? 'mx-auto h-10 w-10 justify-center' : 'gap-2.5 px-1.5 py-1.5',
              )}
            >
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[12px] font-semibold text-text-2"
              >
                {initialsOf(user.name)}
              </span>
              {!isCollapsed && (
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold leading-tight">{user.name}</span>
                  <span className="block truncate text-[12px] leading-tight text-text-3">{roleLabel}</span>
                </span>
              )}
            </Link>
          )}

          <div className={cn('mt-1.5 flex items-center', isCollapsed ? 'flex-col gap-1' : 'gap-1')}>
            {!isCollapsed && (
              <Link
                href="/perfil"
                onClick={handleNavClick}
                aria-label={t('nav.profile')}
                title={t('nav.profile')}
                className={iconButton}
              >
                <UserCircle className="h-4 w-4" aria-hidden="true" />
              </Link>
            )}
            <button
              type="button"
              onClick={toggleLanguage}
              aria-label={t('shell.language')}
              title={t('shell.language')}
              className={cn(iconButton, 'gap-1 text-[12px] font-semibold', !isCollapsed && 'w-auto px-2.5')}
            >
              <Globe className="h-4 w-4" aria-hidden="true" />
              {!isCollapsed && <span>{locale === 'es' ? 'EN' : 'ES'}</span>}
            </button>
            {onToggleCollapse && (
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-label={collapseLabel}
                title={collapseLabel}
                aria-expanded={!isCollapsed}
                aria-controls={id}
                className={cn(iconButton, 'max-[959.98px]:hidden')}
              >
                {isCollapsed
                  ? <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  : <ChevronLeft className="h-4 w-4" aria-hidden="true" />}
              </button>
            )}
            {/* Cerrar sesión — SIEMPRE el último control (pedido de Kevin). */}
            <button
              type="button"
              onClick={handleLogout}
              aria-label={t('nav.logout')}
              title={t('nav.logout')}
              className={cn(iconButton, 'hover:bg-neg-bg hover:text-neg', !isCollapsed && 'ml-auto')}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
