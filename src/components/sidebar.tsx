'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Globe,
  ListChevronsDownUp,
  ListChevronsUpDown,
  LogOut,
  UserCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api-fetch';
import { useAuth, hasModuleAccess, ROLE_LABELS } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { moduleDisplayLabel } from '@/lib/modules';
import { BUSINESS_MODEL_LABELS, normalizeBusinessModel } from '@/lib/business-model';
import { clearActiveCompanyId } from '@/lib/active-company';
import { useTrimmedLogo } from '@/lib/logo-trim';
import {
  NAV_ENTRIES,
  NAV_GROUPS,
  findNavEntry,
  groupPendingTotal,
  initialOpenGroups,
  isGroupCollapsible,
  navOpenStorageKey,
  readOpenGroups,
  writeOpenGroups,
  type ModuleGroupKey,
  type NavEntry,
  type PendingCounterKey,
} from '@/lib/module-groups';

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar «Libro mayor» (docs/diseno-libro-mayor.md §6.1 y §10).
//
// OSCURO DE MARCA (2026-10-12, segunda decisión de Kevin: «se ve muy plano…
// que el menú del lado tenga un color oscuro… cada marca sube su isotipo y sus
// colores»). Revierte el «sigue el tema» de la fase 4: el fondo es el primario
// de la empresa oscurecido hacia casi-negro (`--sidebar-bg`, ≥ 14:1 contra el
// blanco), igual en claro y en oscuro; texto/apagado/acento medidos contra ese
// fondo (brand-color.ts `buildSidebarPalette`). El activo lleva el acento de
// marca (secundario usable: si la empresa cargó blanco o negro, el primario).
// `data-surface="brand-dark"` cambia el anillo de foco al acento del sidebar.
// Descartado: volver a `bg-slate-900` (un negro genérico igual para todas las
// marcas — justo lo que Kevin no quiere) y pintar el fondo con el primario
// crudo (un rojo #db0000 de fondo no deja leer nada).
//
// Logo: expandido → `logo_url_white`; si no hay, `logo_url` sobre una placa
// clara; si no hay ninguno, isotipo/inicial + nombre. Contraído → isotipo
// (`logo_icon_url`) sobre placa clara; si no hay, la inicial en un cuadro del
// acento de marca. Una URL vacía ('' — Exura Prime y Horizon Atlas la tienen
// así en prod) cuenta como «no hay», y una imagen que no carga también. El
// margen transparente del lienzo se recorta en el cliente (src/lib/logo-trim.ts).
//
// POR QUÉ se rehízo:
//   · Era SIEMPRE oscura (`bg-slate-900`) con 28 colores de paleta cruda y un
//     `#60A5FA` fijo para el ícono de la sección activa. En la fase 4 pasó a
//     seguir el tema; desde el 2026-10-12 vuelve a ser oscura pero DE MARCA
//     (ver arriba) y sigue siendo sólo tokens.
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
//   · Mantener las secciones plegables TAL COMO ERAN: la spec definía rótulos
//     fijos y el plegado escondía dónde estaba uno (se abría sólo si contenía
//     la página activa). Ver «Menú desplegable» abajo: vuelven como acordeón
//     de varios abiertos, con el activo siempre abierto al arrancar.
//   · Mostrar el logo ancho de la empresa arriba: en 232 px se veía chico y
//     en el rail contraído era un cuadrado en blanco. La spec pide el isotipo
//     (o iniciales) a 30×30 sobre `brand` + nombre + modelo · moneda.
//
// Contadores de pendientes: `pendingCounts` es el hueco preparado. Hoy NADIE
// lo llena porque la app no tiene esos números en ningún contexto compartido
// (órdenes de pago y retiros se leen dentro de su pantalla). Se dibuja sólo
// un número > 0 que llegue; nunca un cero o un número inventado.
//
// Menú desplegable (2026-10-12, pedido del dueño). Finanzas tiene 17 ítems y
// obligaba a scrollear. Cada grupo con más de un ítem accesible es un acordeón:
// el rótulo es un <button aria-expanded aria-controls>; varios abiertos a la
// vez; el grupo de la ruta activa arranca abierto y se reabre al navegar hacia
// él; el resto vuelve como el usuario lo dejó (localStorage por usuario y
// empresa, tolerante a storage roto: ver module-groups.ts). Un grupo CERRADO
// suma los contadores de pendientes de sus ítems junto al rótulo: plegar no
// puede esconder un pendiente. Un grupo con un solo ítem se muestra directo,
// con rótulo estático (no clicable). Los ítems de un grupo cerrado quedan
// `inert`: salen del orden de tabulación y del árbol de accesibilidad (y el
// foco atrapado del drawer los salta). La altura anima con grid-rows 0fr→1fr
// (sin medir en JS) y se apaga con prefers-reduced-motion.
// Descartado: acordeón exclusivo; medir alturas con JS (parpadea con i18n y
// fuentes); `hidden` sin animación (corta la transición).
//
// Rail contraído (sólo ≥ 960 px): no hay acordeón, todos los íconos con un
// separador fino entre grupos: íconos con tooltip nativo (`title`) y
// `aria-label`. Móvil (< 960 px): drawer de 272 px con scrim; Escape cierra,
// el foco queda atrapado adentro mientras está abierto y vuelve al botón que
// lo abrió al cerrar.
// ─────────────────────────────────────────────────────────────────────────────

/** El drawer y el rail se separan acá (spec §6.3: 960). */
const DRAWER_QUERY = '(max-width: 959.98px)';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** URL de logo utilizable: null si falta o es '' (pasa en prod). */
function logoUrl(url: string | null | undefined): string | null {
  const u = url?.trim();
  return u ? u : null;
}

/**
 * Marca de la empresa en el sidebar. Elige el asset según el espacio y cae al
 * siguiente si la imagen no carga (404, storage borrado): nunca un cuadro roto.
 */
function CompanyMark({
  name,
  logoWhite,
  logoColor,
  logoIcon,
  compact,
  sub,
}: {
  name: string;
  logoWhite: string | null;
  logoColor: string | null;
  logoIcon: string | null;
  compact: boolean;
  sub: string;
}) {
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const ok = (u: string | null) => (u && !broken.has(u) ? u : null);
  const onError = (u: string) => () => setBroken((cur) => new Set(cur).add(u));
  const iconUrl = ok(logoIcon);
  const white = ok(logoWhite);
  const color = white ? null : ok(logoColor);
  const wideUrl = white ?? color;
  // Sin el margen transparente del lienzo (logo-trim.ts): el logo blanco de
  // Exura Prime es una palabra ancha en un PNG cuadrado y en 28 px no se leía.
  const icon = useTrimmedLogo(iconUrl);
  const wide = useTrimmedLogo(wideUrl);
  const initial = (name.trim().charAt(0) || '?').toUpperCase();

  const square = icon && iconUrl ? (
    <span className="flex h-7.5 w-7.5 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sidebar-plate p-0.5">
      {/* <img> nativo: los logos vienen de URLs arbitrarias (no van al
          allow-list de next/image). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={icon} alt="" onError={onError(iconUrl)} className="size-full object-contain" />
    </span>
  ) : (
    <span
      aria-hidden="true"
      className="flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-[13px] font-bold text-sidebar-bg"
    >
      {initial}
    </span>
  );
  if (compact) return square;

  const subLine = sub ? (
    <span className="block truncate text-xs leading-tight text-sidebar-muted">{sub}</span>
  ) : null;
  if (wide && wideUrl) {
    return (
      <span className="flex min-w-0 flex-col gap-1.5">
        <span className="sr-only">{name}</span>
        <span className={cn('flex items-center', color ? 'h-9 w-fit rounded-ui-md bg-sidebar-plate px-2' : 'h-9')}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={wide}
            alt=""
            onError={onError(wideUrl)}
            className={cn('max-w-[176px] object-contain object-left', color ? 'h-6' : 'h-8')}
          />
        </span>
        {subLine}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {square}
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold leading-tight text-sidebar-fg">{name}</span>
        {subLine}
      </span>
    </span>
  );
}

/** Color del ícono de cada grupo del menú (tokens `--nav-*`, globals.css). */
const GROUP_ICON_CLASS: Record<ModuleGroupKey, string> = {
  finance: 'text-nav-finance',
  hr: 'text-nav-hr',
  risk: 'text-nav-risk',
  config: 'text-nav-config',
};

/** Hasta dos iniciales — avatar del pie. */
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
  const activeEntry = findNavEntry(pathname);
  const activeHref = activeEntry?.href ?? null;
  const activeGroup = activeEntry?.group ?? null;

  // ── Acordeón de grupos ────────────────────────────────────────────────────
  const storageKey = user ? navOpenStorageKey(user.id, company?.id) : null;
  const [openGroups, setOpenGroups] = useState<Set<ModuleGroupKey>>(() =>
    initialOpenGroups(null, activeGroup),
  );
  // Al navegar a otro grupo se ABRE (sin cerrar los demás). Ajuste de estado
  // durante el render, no en un effect: evita un frame con el grupo cerrado.
  const [seenGroup, setSeenGroup] = useState(activeGroup);
  if (seenGroup !== activeGroup) {
    setSeenGroup(activeGroup);
    if (activeGroup && !openGroups.has(activeGroup)) {
      setOpenGroups(new Set(openGroups).add(activeGroup));
    }
  }
  // Lo guardado se lee DESPUÉS de hidratar (el servidor no tiene storage) y se
  // une a lo ya abierto, que siempre incluye el grupo activo.
  useEffect(() => {
    if (!storageKey) return;
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    const stored = readOpenGroups(storage, storageKey);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage sólo existe en el cliente
    if (stored && stored.length > 0) setOpenGroups((cur) => new Set([...cur, ...stored]));
  }, [storageKey]);

  const commitOpenGroups = (next: Set<ModuleGroupKey>) => {
    setOpenGroups(next);
    if (!storageKey) return;
    try {
      writeOpenGroups(window.localStorage, storageKey, next);
    } catch {
      /* storage bloqueado: el estado sigue valiendo en memoria */
    }
  };
  const toggleGroup = (key: ModuleGroupKey) => {
    const next = new Set(openGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    commitOpenGroups(next);
  };

  // ── Drawer móvil: foco atrapado + Escape ──────────────────────────────────
  useEffect(() => {
    if (!mobileOpen) return;
    const aside = asideRef.current;
    if (!aside) return;
    const isDrawer = () => window.matchMedia(DRAWER_QUERY).matches;
    if (!isDrawer()) return;

    const opener = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(aside.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null && !el.closest('[inert]'),
      );
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

  const collapsibleKeys = groups
    .filter((g) => isGroupCollapsible(g.entries.length))
    .map((g) => g.group.key);
  const allOpen = collapsibleKeys.every((k) => openGroups.has(k));
  const toggleAll = () => {
    const next = new Set(openGroups);
    for (const k of collapsibleKeys) {
      if (allOpen) next.delete(k);
      else next.add(k);
    }
    commitOpenGroups(next);
  };
  const toggleAllLabel = allOpen ? t('nav.collapseAll') : t('nav.expandAll');

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
              ? 'bg-sidebar-active-bg font-semibold text-sidebar-fg before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-accent'
              : 'text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg',
          )}
        >
          <Icon className={cn('h-4 w-4 shrink-0', isActive && 'text-sidebar-accent')} aria-hidden="true" />
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
    'flex h-10 w-10 shrink-0 items-center justify-center rounded-ui-md text-sidebar-muted transition-colors motion-reduce:transition-none',
    'hover:bg-sidebar-hover hover:text-sidebar-fg',
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
        data-surface="brand-dark"
        className={cn(
          'h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar-bg text-sidebar-fg',
          'hidden min-[960px]:flex transition-[width] duration-200 motion-reduce:transition-none',
          isCollapsed ? 'w-16' : 'w-58',
          mobileOpen && 'max-[959.98px]:fixed max-[959.98px]:inset-y-0 max-[959.98px]:left-0 max-[959.98px]:z-50 max-[959.98px]:flex max-[959.98px]:w-68 max-[959.98px]:shadow-3',
        )}
      >
        {/* ── Empresa ── */}
        <div
          className={cn(
            'flex shrink-0 items-center border-b border-sidebar-border',
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
            <CompanyMark
              name={company?.name ?? ''}
              logoWhite={logoUrl(company?.logo_url_white)}
              logoColor={logoUrl(company?.logo_url)}
              logoIcon={logoUrl(company?.logo_icon_url)}
              compact={isCollapsed}
              sub={companySub}
            />
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
          {!isCollapsed && collapsibleKeys.length > 0 && (
            <div className="mb-1 flex justify-end">
              <button
                type="button"
                onClick={toggleAll}
                aria-label={toggleAllLabel}
                title={toggleAllLabel}
                className={iconButton}
              >
                {allOpen
                  ? <ListChevronsDownUp className="h-4 w-4" aria-hidden="true" />
                  : <ListChevronsUpDown className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
          )}
          {ungrouped.length > 0 && <ul className="space-y-0.5">{ungrouped.map(renderLink)}</ul>}
          {groups.map(({ group, entries }) => {
            const headingId = `${id}-group-${group.key}`;
            const panelId = `${id}-panel-${group.key}`;
            const label = t(group.i18nKey);
            const wrapper = cn(isCollapsed ? 'mt-2 border-t border-sidebar-border pt-2' : 'mt-3');
            const headingText =
              'text-xs font-semibold uppercase tracking-[0.06em] text-sidebar-muted';
            const GroupIcon = group.icon;
            const groupIcon = (
              <GroupIcon className={cn('h-3.5 w-3.5 shrink-0', GROUP_ICON_CLASS[group.key])} aria-hidden="true" />
            );

            // Rail: sin acordeón, todos los íconos.
            if (isCollapsed) {
              return (
                <div key={group.key} className={wrapper}>
                  <ul className="space-y-0.5" aria-label={label}>{entries.map(renderLink)}</ul>
                </div>
              );
            }

            // Un solo ítem accesible: directo, con rótulo estático.
            if (!isGroupCollapsible(entries.length)) {
              return (
                <div key={group.key} className={wrapper}>
                  <p id={headingId} className={cn('flex items-center gap-2 px-2.5 pb-1', headingText)}>
                    {groupIcon}
                    {label}
                  </p>
                  <ul className="space-y-0.5" aria-labelledby={headingId}>{entries.map(renderLink)}</ul>
                </div>
              );
            }

            const isOpen = openGroups.has(group.key);
            const pending = isOpen ? 0 : groupPendingTotal(entries, pendingCounts);
            const pendingText = pending > 99 ? '99+' : String(pending);
            const pendingLabel = t('shell.pending', { count: String(pending) });
            return (
              <div key={group.key} className={wrapper}>
                <button
                  type="button"
                  id={headingId}
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-ui-md px-2.5 text-left transition-colors pointer-coarse:h-11',
                    'hover:bg-sidebar-hover hover:text-sidebar-fg motion-reduce:transition-none',
                    headingText,
                  )}
                >
                  {groupIcon}
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {pending > 0 && (
                    <span
                      aria-label={pendingLabel}
                      title={pendingLabel}
                      className="min-w-5 rounded-full bg-pend-bg px-1.5 text-center text-[11.5px] font-semibold normal-case leading-5 tracking-normal text-pend tabular-nums"
                    >
                      {pendingText}
                    </span>
                  )}
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
                      isOpen ? 'rotate-0' : '-rotate-90',
                    )}
                    aria-hidden="true"
                  />
                </button>
                <div
                  className={cn(
                    'grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none',
                    isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                  )}
                >
                  <div id={panelId} inert={!isOpen} className="min-h-0 overflow-hidden">
                    <ul className="space-y-0.5 pt-0.5" aria-labelledby={headingId}>
                      {entries.map(renderLink)}
                    </ul>
                  </div>
                </div>
              </div>
            );
          })}
        </nav>

        {/* ── Pie: persona + utilidades ── */}
        <div className={cn('shrink-0 border-t border-sidebar-border', isCollapsed ? 'px-2 py-2' : 'px-3 py-2.5')}>
          {user && (
            <Link
              href="/perfil"
              onClick={handleNavClick}
              aria-current={pathname === '/perfil' ? 'page' : undefined}
              title={isCollapsed ? `${user.name} · ${roleLabel}` : t('nav.profile')}
              aria-label={isCollapsed ? `${t('nav.profile')}: ${user.name}` : undefined}
              className={cn(
                'flex items-center rounded-ui-md transition-colors hover:bg-sidebar-hover motion-reduce:transition-none',
                isCollapsed ? 'mx-auto h-10 w-10 justify-center' : 'gap-2.5 px-1.5 py-1.5',
              )}
            >
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-active-bg text-xs font-semibold text-sidebar-fg"
              >
                {initialsOf(user.name)}
              </span>
              {!isCollapsed && (
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold leading-tight">{user.name}</span>
                  <span className="block truncate text-xs leading-tight text-sidebar-muted">{roleLabel}</span>
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
              className={cn(iconButton, 'gap-1 text-xs font-semibold', !isCollapsed && 'w-auto px-2.5')}
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
              className={cn(iconButton, !isCollapsed && 'ml-auto')}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
