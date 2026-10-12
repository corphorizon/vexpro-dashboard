// ─────────────────────────────────────────────────────────────────────────────
// hr-view — las decisiones de PRESENTACIÓN del módulo RRHH, puras y testeadas
// («Libro mayor», 2026-10-12, docs/diseno-libro-mayor.md).
//
// POR QUÉ: antes de la migración cada pestaña elegía el color de un estado a
// mano y con su propia lista. Medido en rrhh/** (sin comentarios): el estado de
// una negociación tenía DOS mapas (negotiations-tab `NEG_STATUS_BADGE` y un
// ternario inline en perfil/page.tsx), el estado de un empleado otro
// (`STATUS_BADGE_CLASSES`), la procedencia del net otros dos (commercial-tab y
// net-deposit-tab, `text-positive/80` a mano) y el umbral de warnings un
// cuarto. Listas duplicadas que se desincronizan en silencio son el modo de
// falla número uno del repo (reglas-del-proyecto.md §1.1): acá hay UNA por
// cosa, tipada contra el tipo de dominio (`Record<NegotiationStatus, …>`), así
// que un estado nuevo rompe `tsc` en vez de caer al gris sin que nadie lo vea.
//
// El color sale siempre de `StatusKind` (components/ui/status-kind.ts) — los
// seis significados de la spec §2.1 — nunca de una clase de paleta.
//
// LO QUE NO HAY ACÁ: ninguna fórmula de plata. El net deposit resuelto sigue
// saliendo de `resolveNetDepositInput` (hr/net-deposit-input.ts), la comisión
// de `comisionIndividualDeBdm` (hr/commission-preview.ts) y los totales de
// hr/monthly-totals.ts. Las funciones de KPI de abajo sólo deciden «¿hay
// dato o no?» sobre números que ya existen — que «no lo sabemos» se vea «—» y
// no $0 (reglas §1.3).
//
// DESCARTADO:
//   · Agregar los dominios de RRHH a STATUS_DOMAINS (status-kind.ts): la tanda
//     tiene `src/components/ui/**` vedado, y los estados de RRHH sólo se pintan
//     acá. Si otra pantalla los necesita, se mueven allá tal cual (mismo tipo).
//   · Pintar el rol (HEAD, BDM…) de color: un rol no es pos/neg/pend/info/stale
//     (spec §2.1 «si no significa una de estas cinco cosas, va en gris»). El
//     `badge` de ROLE_SPECS (hr/domain.ts) queda para /comisiones, que no es de
//     esta tanda.
// ─────────────────────────────────────────────────────────────────────────────

import type { StatusKind } from '@/components/ui/status-kind';
import type { NegotiationStatus } from '@/lib/types';
import type { NetDepositSource } from '@/lib/hr/net-deposit-input';
import type { UnifiedEmployee } from '@/lib/hr/employees-list';
import type { HrOverviewResponse } from '@/lib/hr/overview';
import type { AlertLevel } from '@/lib/ib-rebates/types';

export interface StatusView {
  kind: StatusKind;
  /** Clave i18n de la etiqueta. */
  labelKey: string;
}

// ── Negociaciones de perfiles comerciales ──────────────────────────────────
// `closed` era ROJO (bg-negative/10). Una negociación cerrada no es un error
// ni una pérdida: es un estado terminal, y la spec §5.5 pone «Cerrado» en
// neutro. `active` = acuerdo vigente (ok); `pending` = falta que alguien
// decida (pend).
export const NEG_STATUS_VIEW: Record<NegotiationStatus, StatusView> = {
  active: { kind: 'ok', labelKey: 'hr.negStatusActive' },
  pending: { kind: 'pend', labelKey: 'hr.negStatusPending' },
  closed: { kind: 'neutral', labelKey: 'hr.negStatusClosed' },
};

/** Los estados en el orden de los selectores. Sale del mapa: no es otra lista. */
export const NEG_STATUSES = Object.keys(NEG_STATUS_VIEW) as NegotiationStatus[];

/** Estado de negociación desconocido (dato viejo) → gris, nunca verde. */
export function negStatusView(status: string | null | undefined): StatusView {
  if (status && Object.prototype.hasOwnProperty.call(NEG_STATUS_VIEW, status)) {
    return NEG_STATUS_VIEW[status as NegotiationStatus];
  }
  return { kind: 'neutral', labelKey: 'hr.negotiationStatus' };
}

// ── Plantilla (Empleados / Despedidos) ─────────────────────────────────────
// `inactive` era ROJO: una licencia no es un error. `probation` era amarillo
// de «pendiente», pero nadie tiene que hacer nada: es un paso intermedio (info).
// `fired` era slate crudo con `dark:`; ahora neutro con el token que flipa solo.
export const EMPLOYEE_STATUS_VIEW: Record<UnifiedEmployee['status'], StatusView> = {
  active: { kind: 'ok', labelKey: 'hr.statusActive' },
  probation: { kind: 'info', labelKey: 'hr.statusProbation' },
  inactive: { kind: 'neutral', labelKey: 'hr.statusInactive' },
  fired: { kind: 'neutral', labelKey: 'hr.statusFired' },
};

/** Registro único de las etiquetas de estado; el CSV del shell usa ESTE mapa. */
export const STATUS_LABEL_KEYS: Record<UnifiedEmployee['status'], string> = Object.fromEntries(
  Object.entries(EMPLOYEE_STATUS_VIEW).map(([k, v]) => [k, v.labelKey]),
) as Record<UnifiedEmployee['status'], string>;

/** Estado de un perfil comercial: despedido = inactive + fecha (hr/domain.ts). */
export function profileStatusView(p: { status: string; termination_date?: string | null }): StatusView {
  if (p.status === 'inactive' && p.termination_date) return EMPLOYEE_STATUS_VIEW.fired;
  if (p.status === 'active') return EMPLOYEE_STATUS_VIEW.active;
  return EMPLOYEE_STATUS_VIEW.inactive;
}

// ── Procedencia del net deposit resuelto ───────────────────────────────────
// CRM es una fuente automática (spec §2.1: `info` = «fuente automática», la
// etiqueta API). Manual y cerrado son datos firmes cargados por alguien: gris.
// `none` = no hay número — `stale` (dato que no llegó), igual que el «Net CRM
// sin dato» del dashboard. Antes el CRM iba en `text-positive/80`: verde, que
// afirmaba «esto es ganancia» sobre una etiqueta de origen.
export const NET_SOURCE_VIEW: Record<NetDepositSource, StatusView> = {
  crm: { kind: 'info', labelKey: 'hr.srcCrm' },
  manual: { kind: 'neutral', labelKey: 'hr.srcManual' },
  frozen: { kind: 'neutral', labelKey: 'hr.srcFrozen' },
  none: { kind: 'stale', labelKey: 'hr.srcNone' },
};

// ── Warnings acumulados ────────────────────────────────────────────────────
// El umbral es el de Daniela (warnings-tab.tsx): con dos empieza a mirar de
// cerca, con tres se habla de despido. Se conserva tal cual; sólo cambia el
// color de paleta por el significado.
export const WARNING_WATCH_AT = 2;
export const WARNING_SERIOUS_AT = 3;

export function warningSeverity(total: number): StatusKind {
  if (!Number.isFinite(total)) return 'neutral';
  if (total >= WARNING_SERIOUS_AT) return 'bad';
  if (total >= WARNING_WATCH_AT) return 'pend';
  return 'neutral';
}

// ── Alertas de rebates IB ──────────────────────────────────────────────────
// Antes: verde/amarillo/naranja/rojo de paleta cruda con `dark:` (24 clases).
// Amarillo y naranja son los dos «hay que actuar» (pend); la etiqueta —que ya
// decía el nivel— los distingue, el color no tiene un sexto significado.
export const IB_ALERT_KIND: Record<AlertLevel, StatusKind> = {
  green: 'ok',
  yellow: 'pend',
  orange: 'pend',
  red: 'bad',
};

// ── Árbol de la estructura → filas de tabla ────────────────────────────────
export interface TreeNodeLike<N> {
  profileId: string;
  children: N[];
}

export interface FlatTreeRow<N> {
  node: N;
  depth: number;
  hasKids: boolean;
  collapsed: boolean;
}

/**
 * Aplana el árbol en orden de lectura (padre, después sus hijos), saltando lo
 * que cuelga de un nodo colapsado. Es lo que antes hacían `RollupRows` y
 * `ProductionRows` recursivos devolviendo fragmentos de <tr>; FinTable quiere
 * una lista de filas.
 */
export function flattenTree<N extends TreeNodeLike<N>>(
  roots: readonly N[],
  collapsed: ReadonlySet<string>,
): FlatTreeRow<N>[] {
  const out: FlatTreeRow<N>[] = [];
  const walk = (nodes: readonly N[], depth: number) => {
    for (const node of nodes) {
      const isCollapsed = collapsed.has(node.profileId);
      out.push({ node, depth, hasKids: node.children.length > 0, collapsed: isCollapsed });
      if (!isCollapsed) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

// ── Jerarquía como metadato bajo el nombre ─────────────────────────────────
/**
 * «HEAD Hugo › BDM Ana»: los supervisores de la persona, de arriba hacia abajo.
 * Corta en `maxDepth` y en ciclos (un `head_id` que apunta a sí mismo o a un
 * descendiente no debería existir, pero el CHECK no lo impide): una pantalla
 * que se cuelga por un dato raro es peor que una cadena cortada.
 */
export function supervisorChain<P extends { id: string; name: string; head_id?: string | null }>(
  profile: P,
  byId: ReadonlyMap<string, P>,
  maxDepth = 4,
): P[] {
  const chain: P[] = [];
  const seen = new Set<string>([profile.id]);
  let cur = profile.head_id ? byId.get(profile.head_id) : undefined;
  while (cur && !seen.has(cur.id) && chain.length < maxDepth) {
    chain.unshift(cur);
    seen.add(cur.id);
    cur = cur.head_id ? byId.get(cur.head_id) : undefined;
  }
  return chain;
}

// ── Filtro de estado de la lista de perfiles ───────────────────────────────
export type ProfileStatusFilter = 'all' | 'active' | 'inactive';
export const PROFILE_STATUS_FILTERS: readonly ProfileStatusFilter[] = ['all', 'active', 'inactive'];

/** `inactive` incluye a los despedidos: los dos «no está trabajando hoy». */
export function matchesStatusFilter(p: { status: string }, filter: ProfileStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return p.status === 'active';
  return p.status !== 'active';
}

// ── KPIs del dashboard ─────────────────────────────────────────────────────

/**
 * Headcount = la gente que hoy está trabajando: administrativos activos o en
 * prueba (cobran igual) + comerciales activos. Las dos tablas no se pisan —
 * los comerciales viven sólo en `commercial_profiles` (hr/employees-list.ts) —
 * así que sumarlas no cuenta dos veces a nadie.
 */
export function headcount(
  employees: readonly { status: string }[],
  profiles: readonly { status: string }[],
): { total: number; admin: number; commercial: number; probation: number } {
  const admin = employees.filter((e) => e.status !== 'inactive').length;
  const probation = employees.filter((e) => e.status === 'probation').length;
  const commercial = profiles.filter((p) => p.status === 'active').length;
  return { total: admin + commercial, admin, commercial, probation };
}

/**
 * Nómina del período = lo que la pantalla ya sumaba (comisión real + salario
 * pagado de cada fila guardada). Lo único nuevo: sin NINGUNA fila guardada el
 * total es `null` («—», «sin resultados guardados»), no $0 — un período que
 * todavía no se calculó en /comisiones no es un período que pagó cero.
 */
export function payrollOfPeriod(
  rows: readonly { real_payment: number | null; salary_paid: number | null }[],
): { total: number | null; commissions: number | null; salaries: number | null; rows: number } {
  if (rows.length === 0) return { total: null, commissions: null, salaries: null, rows: 0 };
  let commissions = 0;
  let salaries = 0;
  for (const r of rows) {
    commissions += r.real_payment ?? 0;
    salaries += r.salary_paid ?? 0;
  }
  return { total: commissions + salaries, commissions, salaries, rows: rows.length };
}

export type KpiState = 'ok' | 'loading' | 'missing';

/**
 * Net deposit del equipo (lo atribuido a la estructura) desde el overview del
 * mes — la MISMA lectura que la pestaña Net Deposit (`data.net`, RPC
 * `hr_net_deposit_by_profile`). Sin overview, con el slice `net` en `partial`
 * o con error: `null` y el estado dice por qué. Nunca $0.
 */
export function teamNetKpi(
  overview: HrOverviewResponse | null,
  loading: boolean,
): { state: KpiState; assigned: number | null; unassigned: number | null; totalCrm: number | null } {
  const net = overview && !overview.partial.includes('net') ? overview.data.net : null;
  if (net) {
    return { state: 'ok', assigned: net.totalAssigned, unassigned: net.unassigned, totalCrm: net.totalCrm };
  }
  return { state: loading && !overview ? 'loading' : 'missing', assigned: null, unassigned: null, totalCrm: null };
}

/**
 * Alertas del mes = warnings cargados en el mes + sugeridos sin firmar + los
 * que acumulan dos o más. Mismo slice que la pestaña Warnings.
 */
export function alertsKpi(
  overview: HrOverviewResponse | null,
  loading: boolean,
): { state: KpiState; ofMonth: number | null; suggested: number | null; repeat: number | null } {
  const w = overview && !overview.partial.includes('warnings') ? overview.data.warnings : null;
  if (w) {
    const repeat = Object.values(w.totals).filter((n) => n >= WARNING_WATCH_AT).length;
    return { state: 'ok', ofMonth: w.ofMonth.length, suggested: w.suggestions.length, repeat };
  }
  return { state: loading && !overview ? 'loading' : 'missing', ofMonth: null, suggested: null, repeat: null };
}

/**
 * Suma una columna que puede traer nulls SIN convertirlos en 0: devuelve la
 * suma de lo conocido y cuántos faltaron. Todo null → `sum: null`.
 * Para los totales de Negociaciones IB, donde `network` null es «no se pudo
 * resolver la red», no «la red no movió plata».
 */
export function sumKnown<T>(rows: readonly T[], value: (r: T) => number | null | undefined): {
  sum: number | null;
  missing: number;
} {
  let sum = 0;
  let known = 0;
  let missing = 0;
  for (const r of rows) {
    const v = value(r);
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      known += 1;
    } else {
      missing += 1;
    }
  }
  return { sum: known === 0 ? null : sum, missing };
}

/** «12.5 %» de un porcentaje guardado como número; null → null (la UI pone «—»). */
export function pctText(v: number | null | undefined): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? `${v}%` : null;
}
