// ─────────────────────────────────────────────────────────────────────────────
// El ARMADO del overview de RRHH — todo lo que el módulo necesita de un mes.
//
// ── El porqué ──────────────────────────────────────────────────────────────
// Cada pestaña de /rrhh se cargaba sola: siete endpoints distintos más lo que
// ya venía del bootstrap, y cambiar de pestaña volvía a pedir lo mismo. Peor:
// cada una preguntaba por SU mes (ver hr/period-filter.ts), así que dos
// pantallas del mismo módulo podían mostrar dos meses distintos sin decirlo.
//
// Mismo patrón que /api/bootstrap: una llamada, slices independientes, y un
// slice que falla vuelve `null` (≠ `[]`) con su nombre en `partial`. "No lo
// sabemos" y "no hay filas" son datos distintos (§1.3) — y una lista vacía
// muda es indistinguible de un cruce roto (§1.2).
//
// Este archivo es PURO: recibe filas y devuelve el objeto de respuesta. Todo el
// IO (Supabase, la RPC `hr_net_deposit_by_profile`) vive en la ruta
// src/app/api/admin/hr-overview/route.ts. Así el armado se testea sin base.
//
// ── Lo que NO hace ─────────────────────────────────────────────────────────
// No escribe nada, y no unifica el net del CRM con las comisiones cargadas a
// mano: eso es la tanda 2. Acá el calculado y el manual viajan uno al lado del
// otro, como ya los devolvía /api/admin/hr-net-deposit-rollup.
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildRollup,
  resolveNetDepositGoal,
  suggestNetDepositWarnings,
  type NetDepositGoal,
  type NetDepositSuggestion,
  type RollupNode,
  type RollupProfile,
} from './net-deposit';

/** Los pedazos que puede traer —o no— una respuesta del overview. */
export const HR_OVERVIEW_SLICES = [
  'profiles',
  'net',
  'monthlyResults',
  'goals',
  'warnings',
] as const;

export type HrOverviewSlice = (typeof HR_OVERVIEW_SLICES)[number];

/**
 * Sin `profiles` no hay estructura ni sugerencias: el resto del overview sería
 * un árbol vacío con cara de "no hay nadie". Igual que `periods` en /bootstrap,
 * si este slice falla la respuesta entera es un error.
 */
export const HR_OVERVIEW_CRITICAL: readonly HrOverviewSlice[] = ['profiles'];

export type HrWarningRow = {
  id: string;
  profile_id: string;
  month: string;
  motive: string;
  detail: string | null;
  created_by_name: string | null;
  created_at: string;
};

/** Fila de `commercial_monthly_results` tal como la mira este módulo. */
export type HrMonthlyResultRow = {
  profile_id: string;
  net_deposit_current: number | string | null;
  /**
   * Bajo qué head está cargada esa fila. Hace falta para distinguir la fila del
   * head EN SU PROPIO GRUPO (head_id === profile_id, donde el
   * `net_deposit_current` no es la producción de su estructura) de la fila que
   * lleva su total hacia arriba. Ver `manualDeEstructura`.
   */
  head_id?: string | null;
};

export type HrPeriodRow = { id: string; year: number; month: number; is_closed?: boolean };

/**
 * Escalón de meta TAL COMO ESTÁ EN LA BASE, con su `id`. Viaja aparte de
 * `goals` (que son sólo números, para el cálculo) porque el editor de metas de
 * la pestaña Warnings necesita el id de la fila para editarla.
 */
export type HrGoalRow = { id: string; salary: number; min_net_deposit: number };

export type HrNetSlice = {
  /** El árbol de la estructura con own/team/total y el manual al lado. */
  tree: RollupNode[];
  /** Neto de clientes cuya cadena de sponsors no llega a la estructura. */
  unassigned: number;
  totalAssigned: number;
  /** Lo atribuido + lo huérfano: el número contra el que se cuadra el CRM. */
  totalCrm: number;
};

export type HrWarningsSlice = {
  /** Los del mes seleccionado. */
  ofMonth: HrWarningRow[];
  /** Acumulado HISTÓRICO por perfil — el mes filtra qué se ve, no qué se cuenta. */
  totals: Record<string, number>;
  suggestions: NetDepositSuggestion[];
  /** Net y meta de cada perfil, haya o no sugerencia (la pantalla pinta "12k / 30k"). */
  metrics: { profileId: string; net: number; goal: number | null }[];
};

export type HrOverviewResponse = {
  /** `YYYY-MM-01`, la forma que aceptan la RPC y el CHECK de hr_warnings. */
  month: string;
  /** Hay período contable creado para ese mes. Sin él no hay "manual". */
  hasPeriod: boolean;
  period: HrPeriodRow | null;
  /** Slices que no se pudieron leer. Vienen como `null`, NUNCA como `[]`. */
  partial: HrOverviewSlice[];
  /** Las metas con su `id`, para el editor. `null` = el slice falló. */
  goalRows: HrGoalRow[] | null;
  data: {
    profiles: RollupProfile[] | null;
    net: HrNetSlice | null;
    monthlyResults: HrMonthlyResultRow[] | null;
    goals: NetDepositGoal[] | null;
    warnings: HrWarningsSlice | null;
  };
};

/**
 * Lo cargado a mano por perfil en el período.
 *
 * Un perfil puede tener MÁS DE UNA fila en el mes (una por head bajo el que
 * aparece); lo cargado para esa persona es la suma. Devuelve un Map vacío si no
 * hay filas — pero ojo: "no hay filas" lo decide el llamador pasando `null`
 * cuando el slice falló, no esta función.
 */
export function sumarManualPorPerfil(rows: readonly HrMonthlyResultRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.profile_id) continue;
    out.set(r.profile_id, (out.get(r.profile_id) ?? 0) + (Number(r.net_deposit_current) || 0));
  }
  return out;
}

/**
 * Lo cargado a mano COMO TOTAL DE ESTRUCTURA, que es lo que compite contra el
 * `total` del rollup.
 *
 * Se diferencia de `sumarManualPorPerfil` a propósito, y la diferencia es una
 * sola fila: la del head en SU PROPIO grupo (`head_id === profile_id`). En esa
 * fila el `net_deposit_current` no es la producción de la estructura —es 0 en
 * los heads con padre, y la línea de ajuste personal en los heads sin padre
 * (Hugo Ortiz, julio 2026: −3.489, contra los 535.154 que produjo su estructura
 * entera). Sumarla como si fuera producción hacía que un head raíz apareciera
 * "con override manual de −3.489" tapando medio millón del CRM.
 *
 * Los BDM no se ven afectados: su fila va bajo su head, nunca bajo sí mismos.
 */
export function manualDeEstructura(rows: readonly HrMonthlyResultRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.profile_id) continue;
    if (r.head_id && r.head_id === r.profile_id) continue;
    out.set(r.profile_id, (out.get(r.profile_id) ?? 0) + (Number(r.net_deposit_current) || 0));
  }
  return out;
}

/** El acumulado histórico de warnings por perfil. */
export function contarWarningsPorPerfil(rows: readonly HrWarningRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of rows) out[w.profile_id] = (out[w.profile_id] ?? 0) + 1;
  return out;
}

/** Los warnings del mes pedido (se compara `YYYY-MM`, no el día). */
export function warningsDelMes(rows: readonly HrWarningRow[], month: string): HrWarningRow[] {
  return rows.filter((w) => w.month.slice(0, 7) === month.slice(0, 7));
}

/**
 * Parte el resultado del RPC en "lo atribuido a un perfil" y "lo huérfano".
 *
 * `profile_id` NULL = clientes cuya cadena de sponsors no llega a ningún
 * comercial. Medido en julio 2026: 18.314 de 556.917, el 3,3%. Se devuelve
 * aparte y la pantalla lo muestra como "sin asignar" — repartirlo entre los
 * heads sería inventar producción.
 */
export function separarNetDelCrm(
  rows: readonly { profile_id: string | null; net: number | string }[],
): { netByProfile: Map<string, number>; unassigned: number } {
  const netByProfile = new Map<string, number>();
  let unassigned = 0;
  for (const r of rows) {
    const v = Number(r.net) || 0;
    if (r.profile_id) netByProfile.set(r.profile_id, v);
    else unassigned += v;
  }
  return { netByProfile, unassigned };
}

/** Lo que la ruta leyó. `null` en cualquier campo = ese slice falló. */
export type HrOverviewInput = {
  /** `YYYY-MM-01`. */
  month: string;
  period: HrPeriodRow | null;
  profiles: RollupProfile[] | null;
  netRows: { profile_id: string | null; net: number | string }[] | null;
  monthlyResults: HrMonthlyResultRow[] | null;
  goals: NetDepositGoal[] | null;
  /** Las mismas metas con su `id`; `null` cuando el slice falló. */
  goalRows: HrGoalRow[] | null;
  allWarnings: HrWarningRow[] | null;
};

/**
 * Arma la respuesta del overview y declara qué faltó.
 *
 * Reglas que se respetan acá, y que son el motivo de que esto sea una función
 * y no cinco `map` sueltos en la ruta:
 *  · Un slice que no se pudo leer es `null` y su nombre va en `partial`.
 *  · `net` depende de `profiles` Y de `netRows`: si falta cualquiera de los
 *    dos, el árbol es `null` — no un árbol con todos en cero, que se leería
 *    como "este mes no produjo nadie".
 *  · Sin `monthlyResults` (o sin período) el `manual` de cada nodo queda `null`
 *    = "no lo sabemos", que es distinto de `0` = "cargaron cero".
 *  · Las sugerencias de warning necesitan perfiles + net + metas; sin las tres
 *    no se sugiere nada en vez de sugerir de menos (una sugerencia faltante es
 *    invisible y puede costarle un llamado de atención a quien no corresponde).
 */
export function armarOverview(input: HrOverviewInput): HrOverviewResponse {
  const partial: HrOverviewSlice[] = [];
  if (input.profiles === null) partial.push('profiles');
  if (input.netRows === null) partial.push('net');
  if (input.monthlyResults === null) partial.push('monthlyResults');
  if (input.goals === null) partial.push('goals');
  if (input.allWarnings === null) partial.push('warnings');

  const profiles = input.profiles;
  const manualByProfile =
    input.monthlyResults === null ? undefined : sumarManualPorPerfil(input.monthlyResults);

  let net: HrNetSlice | null = null;
  let netByProfile: Map<string, number> | null = null;
  if (profiles && input.netRows) {
    const separado = separarNetDelCrm(input.netRows);
    netByProfile = separado.netByProfile;
    const tree = buildRollup(profiles, separado.netByProfile, manualByProfile);
    const totalAssigned = [...separado.netByProfile.values()].reduce((s, v) => s + v, 0);
    net = {
      tree,
      unassigned: separado.unassigned,
      totalAssigned,
      totalCrm: totalAssigned + separado.unassigned,
    };
  }

  let warnings: HrWarningsSlice | null = null;
  if (input.allWarnings) {
    const ofMonth = warningsDelMes(input.allWarnings, input.month);
    const alreadyWarned = new Set(
      ofMonth.filter((w) => w.motive === 'net_deposit').map((w) => w.profile_id),
    );
    // Las sugerencias y las métricas sólo existen con las tres piezas. Si falta
    // alguna, la lista va vacía y el slice del que dependía ya está en
    // `partial`: la pantalla sabe que no es "nadie quedó bajo la meta".
    const puedeSugerir = !!profiles && !!netByProfile && !!input.goals;
    warnings = {
      ofMonth,
      totals: contarWarningsPorPerfil(input.allWarnings),
      suggestions: puedeSugerir
        ? suggestNetDepositWarnings({
            profiles: profiles as RollupProfile[],
            netByProfile: netByProfile as Map<string, number>,
            goals: input.goals as NetDepositGoal[],
            month: input.month,
            alreadyWarned,
          })
        : [],
      metrics:
        puedeSugerir
          ? (profiles as RollupProfile[]).map((p) => ({
              profileId: p.id,
              net: (netByProfile as Map<string, number>).get(p.id) ?? 0,
              goal: resolveNetDepositGoal(p.salary, input.goals as NetDepositGoal[]),
            }))
          : [],
    };
  }

  return {
    month: input.month,
    hasPeriod: !!input.period,
    period: input.period,
    partial,
    goalRows: input.goalRows,
    data: {
      profiles,
      net,
      monthlyResults: input.monthlyResults,
      goals: input.goals,
      warnings,
    },
  };
}
