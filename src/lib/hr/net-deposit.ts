// ─────────────────────────────────────────────────────────────────────────────
// El net deposit del equipo, la línea de ajuste y las metas por salario.
//
// Todo lo de este archivo es PURO: recibe filas y devuelve filas. La parte cara
// (subir la cadena de sponsors del CRM cliente por cliente) vive en Postgres,
// en `hr_net_deposit_by_profile` (migración 097), porque son 21.182 clientes y
// 2.616 con movimiento en un mes normal: traerlos al servidor de Node para
// sumarlos sería mover 27.000 filas por una consulta que la base resuelve sola.
// Acá queda solo el armado del árbol y las reglas, que es lo que hay que poder
// testear sin base de datos.
//
// ── QUÉ ES LA "LÍNEA DE AJUSTE" Y POR QUÉ NO ES UN PARCHE ───────────────────
// Daniela lo describió así: «cuando sumo todo lo de ellos tengo que restar o
// sumar para que me dé el valor que sale en el CRM y ese valor se lo pongo al
// head». Parecía un redondeo a ojo. No lo es: medido en julio 2026, el ajuste
// que ella carga es EXACTAMENTE la producción propia del líder — los clientes
// que cuelgan del head directamente y no de ninguno de sus BDM.
//
//   Estructura de Hugo Ortiz, julio 2026
//     suma de sus cuatro heads     529.280
//     ajuste cargado al head        −3.489   ← su propia línea directa
//     total que muestra el CRM     525.791   ← el número que ella citó
//
//   Estructura de Luka Angeles, mismo mes
//     suma de sus miembros         496.568
//     ajuste                       −11.228
//     total                        485.340   ← lo que Luka aporta hacia arriba
//
// Por eso `adjustment` es `own`: no hay una segunda fuente, es el mismo dato
// mirado desde la estructura. Se muestra SIEMPRE, aunque dé cero, porque es la
// diferencia entre "la suma de mis BDM" y "lo que dice el CRM" y esa diferencia
// es lo que ella hoy calcula de memoria.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo mínimo que hace falta de un perfil comercial para armar la estructura. */
export type RollupProfile = {
  id: string;
  name: string;
  role: string;
  head_id: string | null;
  salary: number | null;
  hire_date: string | null;
  status: string;
  termination_date?: string | null;
};

/** Un nodo de la estructura, con lo suyo y lo de los que cuelgan de él. */
export type RollupNode = {
  profileId: string;
  name: string;
  role: string;
  headId: string | null;
  /** Neto del mes de los clientes que cuelgan DIRECTAMENTE de esta persona. */
  own: number;
  /** Suma de los `total` de sus miembros directos. */
  team: number;
  /** own + team. Es lo que esta estructura aporta hacia arriba. */
  total: number;
  /**
   * La línea que Daniela carga a mano. Es `own` por definición (ver cabecera):
   * se expone con nombre propio porque en la pantalla se lee como "ajuste",
   * no como "producción del head".
   */
  adjustment: number;
  /** Lo que hay cargado hoy en commercial_monthly_results. null = nada cargado. */
  manual: number | null;
  children: RollupNode[];
};

/** Escalón de meta: a tal salario, tal net deposit mínimo. */
export type NetDepositGoal = { salary: number; min_net_deposit: number };

/**
 * El ARMADO DEL ÁRBOL, sin métricas: la única implementación del bosque por
 * `head_id` que hay en el repo.
 *
 * Existe separada de `buildRollup` porque hay más de una cosa que rollar hacia
 * arriba por la misma estructura —el net deposit y, desde 2026-08, la
 * producción IB (lotes, comisión, PNL, forex/sintéticos)— y tener dos copias
 * del recorrido es cómo se termina con dos organigramas distintos en dos
 * pantallas. Quien necesite otra métrica llama a esto y pliega lo suyo.
 *
 * `combine` suma la métrica de un hijo al acumulado; `zero` es el neutro; `rank`
 * dice por qué número se ordenan los hermanos (de mayor a menor).
 *
 * Los perfiles cuyo `head_id` apunta a alguien que no está en la lista (por
 * ejemplo si se filtró por activos) se tratan como raíces: perder una rama
 * entera por un padre ausente sería peor que mostrarla suelta.
 */
export function buildForest<T, N extends { children: N[] }>(
  profiles: RollupProfile[],
  make: (p: RollupProfile, own: T, team: T, total: T, children: N[]) => N,
  ownOf: (p: RollupProfile) => T,
  combine: (a: T, b: T) => T,
  zero: () => T,
  rank: (n: N) => number,
): N[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const childrenOf = new Map<string, RollupProfile[]>();
  const roots: RollupProfile[] = [];

  for (const p of profiles) {
    if (p.head_id && byId.has(p.head_id) && p.head_id !== p.id) {
      const list = childrenOf.get(p.head_id);
      if (list) list.push(p);
      else childrenOf.set(p.head_id, [p]);
    } else {
      roots.push(p);
    }
  }

  // Cortacircuitos: si alguna vez head_id forma un ciclo (A→B→A), la recursión
  // se comería la pila y la pantalla quedaría en blanco sin explicación. Con el
  // set de visitados el ciclo se corta y el resto del árbol se sigue viendo.
  const seen = new Set<string>();

  // El `total` de cada hijo se necesita para acumular el del padre, pero `N` es
  // opaco acá adentro (cada llamador arma su propio nodo). Se guarda al costado
  // en vez de exigirle a `N` una forma concreta.
  const totalDe = new WeakMap<object, T>();

  const build = (p: RollupProfile): N => {
    seen.add(p.id);
    const own = ownOf(p);
    const kids = (childrenOf.get(p.id) ?? [])
      .filter((c) => !seen.has(c.id))
      .map(build)
      .sort((a, b) => rank(b) - rank(a));
    let team = zero();
    for (const k of kids) team = combine(team, totalDe.get(k) as T);
    const total = combine(own, team);
    const node = make(p, own, team, total, kids);
    totalDe.set(node, total);
    return node;
  };

  const out = roots.filter((r) => !seen.has(r.id)).map(build);

  // Nadie se pierde. Si head_id forma un ciclo (A→B→A) ninguno de los dos es
  // raíz y el bucle de arriba no los alcanza: sin esta pasada la estructura
  // entera desaparecía de la pantalla en silencio, que es la peor forma de
  // fallar cuando lo que se muestra es plata. Se emiten como raíces sueltas.
  for (const p of profiles) {
    if (!seen.has(p.id)) out.push(build(p));
  }

  return out.sort((a, b) => rank(b) - rank(a));
}

/**
 * Arma el bosque por `head_id` y calcula own/team/total de abajo hacia arriba.
 *
 * `netByProfile` viene del RPC y NO trae a todos: un perfil sin clientes con
 * movimiento simplemente no aparece, y vale 0. `manualByProfile` es opcional
 * porque hay meses sin período contable creado.
 */
export function buildRollup(
  profiles: RollupProfile[],
  netByProfile: Map<string, number>,
  manualByProfile?: Map<string, number>,
): RollupNode[] {
  return buildForest<number, RollupNode>(
    profiles,
    (p, own, team, total, children) => {
      const manual = manualByProfile?.get(p.id);
      return {
        profileId: p.id,
        name: p.name,
        role: p.role,
        headId: p.head_id,
        own,
        team,
        total,
        adjustment: own,
        manual: manual === undefined ? null : manual,
        children,
      };
    },
    (p) => netByProfile.get(p.id) ?? 0,
    (a, b) => a + b,
    () => 0,
    (n) => n.total,
  );
}

/** Recorre el árbol en orden de lectura (padre, después hijos). */
export function flattenRollup(nodes: RollupNode[], depth = 0): { node: RollupNode; depth: number }[] {
  const out: { node: RollupNode; depth: number }[] = [];
  for (const n of nodes) {
    out.push({ node: n, depth });
    out.push(...flattenRollup(n.children, depth + 1));
  }
  return out;
}

/**
 * La meta que le toca a un salario.
 *
 * Daniela dictó tres escalones —1.000→30.000, 1.500→40.000, 2.000→50.000— pero
 * en la base hay salarios que no caen exactos (1.200, 2.500). Se usa el escalón
 * MÁS ALTO que no supere el salario: 1.200 exige 30.000 y 2.500 exige 50.000.
 * Un salario por debajo del primer escalón (o sin salario) no tiene meta y por
 * lo tanto no genera warning — que el sistema invente una exigencia para alguien
 * que cobra 300 dólares sería peor que no sugerir nada.
 */
export function resolveNetDepositGoal(salary: number | null, goals: NetDepositGoal[]): number | null {
  if (salary == null) return null;
  let best: NetDepositGoal | null = null;
  for (const g of goals) {
    if (g.salary <= salary && (best === null || g.salary > best.salary)) best = g;
  }
  return best ? best.min_net_deposit : null;
}

/**
 * ¿Es `month` el primer mes calendario de esta persona?
 *
 * «El primer mes se les paga igual, es el riesgo que corre la empresa». Se
 * compara el MES, no los 30 días: quien entró el 28 de julio y quien entró el 1
 * de julio tienen los dos julio exento, aunque el primero haya trabajado tres
 * días. Es la lectura literal de la regla y la más benévola, que es la que
 * corresponde cuando la consecuencia es un llamado de atención.
 *
 * Sin `hire_date` no hay exención posible: se devuelve false y la meta aplica.
 * Es deliberado — la alternativa (exentar a todos los que no tienen fecha)
 * apagaría el módulo para los perfiles que hoy no la tienen cargada.
 */
export function isFirstCalendarMonth(hireDate: string | null, month: string): boolean {
  if (!hireDate) return false;
  return hireDate.slice(0, 7) === month.slice(0, 7);
}

export type WarningMotive = 'net_deposit' | 'new_lines' | 'team_creation';

/**
 * Los TRES motivos, y no hay un cuarto. Daniela: «uno depósito net deposit, el
 * segundo es creación de líneas nuevas y el tercero es creación de equipo».
 * Registro único: el CHECK de `hr_warnings` (migración 096) repite esta lista y
 * es la aduana real; acá está para que el selector de la pantalla y la
 * validación del endpoint salgan del mismo lugar.
 */
export const WARNING_MOTIVES: readonly WarningMotive[] = [
  'net_deposit',
  'new_lines',
  'team_creation',
] as const;

export function isWarningMotive(v: unknown): v is WarningMotive {
  return typeof v === 'string' && (WARNING_MOTIVES as readonly string[]).includes(v);
}

export type NetDepositSuggestion = {
  profileId: string;
  name: string;
  role: string;
  salary: number;
  goal: number;
  net: number;
  /** Cuánto le faltó para la meta. Siempre positivo. */
  shortfall: number;
};

/**
 * Quiénes quedaron por debajo de su meta este mes.
 *
 * Devuelve SUGERENCIAS, no warnings. Nada de esto se guarda hasta que una
 * persona lo confirma en la pantalla — el mismo criterio que el resto del
 * dashboard: el sistema sugiere, la persona firma. Un llamado de atención puede
 * terminar en un despido; no lo puede disparar un cron.
 *
 * Se saltean los ya despedidos (no tiene sentido advertir a quien ya no está) y
 * los que ya tienen un warning de net_deposit cargado ese mes.
 */
export function suggestNetDepositWarnings(params: {
  profiles: RollupProfile[];
  netByProfile: Map<string, number>;
  goals: NetDepositGoal[];
  month: string;
  alreadyWarned: Set<string>;
}): NetDepositSuggestion[] {
  const { profiles, netByProfile, goals, month, alreadyWarned } = params;
  const out: NetDepositSuggestion[] = [];
  for (const p of profiles) {
    if (p.status !== 'active' || p.termination_date) continue;
    if (isFirstCalendarMonth(p.hire_date, month)) continue;
    if (alreadyWarned.has(p.id)) continue;
    const goal = resolveNetDepositGoal(p.salary, goals);
    if (goal == null) continue;
    const net = netByProfile.get(p.id) ?? 0;
    if (net >= goal) continue;
    out.push({
      profileId: p.id,
      name: p.name,
      role: p.role,
      salary: p.salary as number,
      goal,
      net,
      shortfall: goal - net,
    });
  }
  return out.sort((a, b) => b.shortfall - a.shortfall);
}

/**
 * Normaliza "el mes" a la única forma que acepta la DB: el día 1.
 * El CHECK de `hr_warnings` rechaza cualquier otro día, así que si esto se
 * olvida el INSERT falla en vez de guardar dos filas para el mismo mes.
 */
export function monthToFirstDay(month: string): string {
  return `${month.slice(0, 7)}-01`;
}
