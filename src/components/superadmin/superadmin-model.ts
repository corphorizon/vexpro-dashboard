// ─────────────────────────────────────────────────────────────────────────────
// superadmin-model — decisiones puras del panel de plataforma (/superadmin).
//
// POR QUÉ (2026-10-12, rediseño «Libro mayor» del área superadmin): las
// pantallas de superadmin decidían en el JSX cosas que se equivocaban en
// silencio, y acá quedan en funciones con test:
//   · Los KPIs del panel sumaban `(companies ?? [])`: con la carga fallida o
//     todavía en vuelo se veían «0 entidades activas · 0 usuarios» — «no lo
//     sabemos» leído como «es cero» (reglas-del-proyecto.md §1.3).
//     `companySummary(null)` devuelve null y la pantalla pinta «—».
//   · GET /api/superadmin/users corta en 500 filas (`.limit(500)`) sin flag de
//     recorte, y la auditoría de una empresa se pide con `limit=200`. Una lista
//     de exactamente el techo es indistinguible de «no hay más» (§1.2).
//     `membershipCoverage` / `atLimit` lo dicen con números.
//   · El color de cada estado se elegía a ojo con paleta cruda (roles en
//     índigo/violeta/rosa sin significado). Spec §2.1: si un color no
//     significa pos/neg/pend/info/stale, va en gris. Los roles son neutros.
//
// La navegación propia del panel (Entidades, Usuarios, Tokens, Pool) vive acá
// y SÓLO acá: no es una copia de NAV_ENTRIES (module-groups.ts) — ninguna de
// estas rutas es un módulo de empresa y ninguna aparece en el menú del
// dashboard. Antes eran cuatro <Link> sueltos en la cabecera de /superadmin.
//
// DESCARTADO:
//   · Meter estas rutas en NAV_ENTRIES: el registro del dashboard decide
//     acceso por módulo de empresa; superadmin no es un módulo y el guardián
//     (route-modules.ts) las rechazaría.
//   · Calcular el recorte de usuarios en el server: no se toca src/app/api en
//     esta tanda (es visual). Queda anotado como pendiente en el reporte.
// ─────────────────────────────────────────────────────────────────────────────

import { Building2, Droplets, KeyRound, Users, type LucideIcon } from 'lucide-react';
import { MONEY_LOCALE } from '@/lib/money';
import type { StatusKind } from '@/components/ui/status-kind';

// ── Navegación ───────────────────────────────────────────────────────────────

export interface SuperadminNavEntry {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Prefijos que también marcan la entrada como activa. */
  match?: readonly string[];
}

export const SUPERADMIN_NAV: readonly SuperadminNavEntry[] = [
  {
    href: '/superadmin',
    label: 'Entidades',
    icon: Building2,
    match: ['/superadmin/companies', '/superadmin/viewing'],
  },
  { href: '/superadmin/users', label: 'Usuarios', icon: Users },
  { href: '/superadmin/tokens', label: 'Tokens de API', icon: KeyRound },
  { href: '/superadmin/liquidity', label: 'Pool de Liquidez', icon: Droplets },
];

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Entrada activa para `pathname`. `/superadmin` sólo matchea exacto (si no,
 * sería prefijo de todo); el resto, por prefijo. Gana el prefijo más largo.
 */
export function activeSuperadminEntry(pathname: string | null | undefined): SuperadminNavEntry | null {
  if (!pathname) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  let best: { entry: SuperadminNavEntry; len: number } | null = null;
  for (const entry of SUPERADMIN_NAV) {
    const prefixes = [entry.href, ...(entry.match ?? [])];
    for (const p of prefixes) {
      const hit = p === '/superadmin' ? path === p : underPrefix(path, p);
      if (hit && (!best || p.length > best.len)) best = { entry, len: p.length };
    }
  }
  return best?.entry ?? null;
}

/** Migas de la topbar: sección (la entrada del menú) + página, si es una subpantalla. */
export function superadminCrumbs(pathname: string | null | undefined): { section: string | null; page: string | null } {
  const entry = activeSuperadminEntry(pathname);
  const path = (pathname ?? '').replace(/\/+$/, '');
  let page: string | null = null;
  if (path === '/superadmin/companies/new') page = 'Nueva entidad';
  else if (/^\/superadmin\/companies\/[^/]+\/users$/.test(path)) page = 'Usuarios de la entidad';
  else if (/^\/superadmin\/companies\/[^/]+$/.test(path)) page = 'Editar entidad';
  else if (/^\/superadmin\/viewing\/[^/]+$/.test(path)) page = 'Entrando a la empresa';
  return { section: entry?.label ?? null, page };
}

// ── Panel de entidades ───────────────────────────────────────────────────────

export interface CompanySummaryInput {
  status: string;
  user_count?: number | null;
}

export interface CompanySummary {
  total: number;
  active: number;
  inactive: number;
  /** Suma de user_count. null si alguna entidad no trae el conteo (no se suma como 0). */
  users: number | null;
  /** Entidades cuyo conteo de usuarios no vino. */
  usersMissing: number;
}

/** null = la lista no cargó (o falló): la pantalla pinta «—», nunca 0. */
export function companySummary(companies: readonly CompanySummaryInput[] | null | undefined): CompanySummary | null {
  if (!companies) return null;
  let active = 0;
  let users = 0;
  let usersMissing = 0;
  for (const c of companies) {
    if (c.status === 'active') active += 1;
    if (typeof c.user_count === 'number' && Number.isFinite(c.user_count)) users += c.user_count;
    else usersMissing += 1;
  }
  return {
    total: companies.length,
    active,
    inactive: companies.length - active,
    users: usersMissing > 0 ? null : users,
    usersMissing,
  };
}

export function companyStatusKind(status: string | null | undefined): StatusKind {
  return status === 'active' ? 'ok' : 'neutral';
}

// ── Recortes ─────────────────────────────────────────────────────────────────

/**
 * Techo de GET /api/superadmin/users (`.limit(500)` en
 * src/app/api/superadmin/users/route.ts). Si cambia allá, cambia acá: el test
 * de este archivo no lo puede ver, por eso el comentario apunta a la línea.
 */
export const USERS_LIST_LIMIT = 500;

/** Filas que pide la pestaña Auditoría de una entidad (`?limit=`). El server tope es 500. */
export const AUDIT_PAGE_LIMIT = 200;

/** Entradas del «Historial reciente» del panel de un usuario (`?limit=`). */
export const USER_AUDIT_PREVIEW = 5;

/** ¿Una lista con techo `limit` pudo quedar cortada? Exactamente el techo = no lo sabemos. */
export function atLimit(shown: number, limit: number): boolean {
  return Number.isFinite(limit) && limit > 0 && shown >= limit;
}

export interface Coverage {
  /** La lista visible puede no ser todo. */
  truncated: boolean;
  /** Total conocido (si lo hay), para «Mostrando N de M». */
  total: number | null;
}

/**
 * Cobertura de la lista de membresías. `expected` es la suma de `user_count`
 * de las entidades del filtro (misma tabla, company_users), cuando se conoce.
 *   · expected > shown → recortada y se sabe cuánto falta.
 *   · shown en el techo → puede estar recortada; total desconocido.
 *   · expected < shown se ignora: el conteo del panel puede venir corto
 *     (ver reporte) y nunca es razón para esconder filas.
 */
export function membershipCoverage(shown: number, expected: number | null | undefined, limit: number = USERS_LIST_LIMIT): Coverage {
  if (typeof expected === 'number' && Number.isFinite(expected) && expected > shown) {
    return { truncated: true, total: expected };
  }
  if (atLimit(shown, limit)) return { truncated: true, total: null };
  return { truncated: false, total: null };
}

// ── Usuarios ─────────────────────────────────────────────────────────────────

/** 2FA es obligatorio (migración 029): sin configurar requiere acción. */
export function twofaKind(enabled: boolean | null | undefined): StatusKind {
  return enabled ? 'ok' : 'pend';
}

export function userStatusKind(status: string | null | undefined): StatusKind {
  return status === 'active' ? 'ok' : 'neutral';
}

/**
 * Color de una acción de auditoría. Borrar es la única noticia mala; crear es
 * informativo; el resto (ver, editar, login…) no significa nada de dinero.
 * Antes `export` iba en ámbar como si requiriera acción: no la requiere.
 */
export function auditActionKind(action: string | null | undefined): StatusKind {
  if (action === 'delete') return 'bad';
  if (action === 'create') return 'info';
  return 'neutral';
}

export function initials(label: string | null | undefined): string {
  const out = (label ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return out || '?';
}

/**
 * «hace 5 min» / «Nunca» / «—». `null` es «nunca entró» (dato real de la
 * fila: last_login_at vacío); una fecha ilegible es «—» (no lo sabemos).
 * `older` formatea lo de más de 30 días (se inyecta para no atar el test a
 * la zona horaria).
 */
export function formatLastLogin(ts: string | null | undefined, now: number, older: (d: Date) => string): string {
  if (!ts) return 'Nunca';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const mins = Math.floor((now - d.getTime()) / 60000);
  if (mins < 1) return 'hace un momento';
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `hace ${days} d`;
  return older(d);
}

/** Conteo entero con el locale único de la app. null / no finito → «—». */
export function formatCount(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(MONEY_LOCALE, { maximumFractionDigits: 0 }).format(n);
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
