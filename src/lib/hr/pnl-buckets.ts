// ─────────────────────────────────────────────────────────────────────────────
// EL BUCKET DE LOS RESULTADOS DEL GRUPO PnL — registro único (§1.1)
//
// ── LA DOCTRINA ────────────────────────────────────────────────────────────
// **Los resultados del grupo PnL viven SIEMPRE en el bucket PROPIO**:
// `commercial_monthly_results.head_id === profile.id`. El PnL no pertenece a
// ninguna estructura de heads —no hay un head que cobre diferencial sobre él—,
// así que su `head_id` no es "de quién cuelga esta persona" sino simplemente
// "la fila propia de esta persona". Mezclarlo con los buckets de estructura es
// lo que creó el desastre que esto arregla.
//
// ── EL INCIDENTE QUE LO ESCRIBIÓ (medido el 2026-09-16) ────────────────────
// Hector Gamboa (grupo PnL) mostraba TOTAL **$319,77** en el tab del mes y
// **$740,61** en el tab Historial, para el MISMO agosto. Causa: tenía TRES
// filas de agosto bajo tres `head_id` distintos — dos copias con el manual
// vigente (319,77) y una vieja con el CRM automático de antes (740,61). Cada
// pantalla pescaba una fila distinta. Es la violación exacta del invariante A3
// (§2.1): *un mismo número tiene que salir del mismo camino*. Y nunca lanzó
// una excepción: los dos números eran plausibles (§1.2).
//
// El barrido a todos los perfiles PnL mostró el desastre general: filas de la
// MISMA persona/mes bajo buckets de Hugo Ortiz, Luka, Ana, Nicolas Garzaro y
// «propio», guardadas en distintas épocas con distinta lógica. El culpable era
// heredar el bucket de lo que hubiera: `r.head_id ?? profile.head_id ?? p.id`
// —cada guardado copiaba el bucket de la fila vieja que encontrara primero—.
// Hay meses cuya ÚNICA fila vive bajo un bucket ajeno (Millones693 en enero,
// febrero y mayo), así que las lecturas necesitan el fallback documentado de
// abajo mientras la migración de datos no se haya corrido.
//
// ── LA EXCEPCIÓN QUE NO SE ROMPE: la línea ND del MASTER IB ────────────────
// Jose Emanuel (grupo PnL Especial) es ADEMÁS Master IB colgado de Ana García
// (`is_master_ib`, `head_id` = Ana). Su fila de agosto bajo el bucket de Ana
// (TOTAL −110.151,25 · `net_deposit_current` 284.557,45) **no es** un duplicado
// del PnL: es su LÍNEA DE NET DEPOSIT dentro del grupo de Ana, que se guarda
// desde el tab Equipos y que tiene su propio carril (ver la cabecera del carril
// ND de los masters en /comisiones). Esas filas quedan FUERA de todo lo de este
// archivo: ni se migran, ni se borran, ni se leen como resultado de PnL.
// `esLineaNdDeMasterIb` es el único lugar donde vive esa excepción.
//
// ── POR QUÉ ACÁ Y NO EN LA PÁGINA ──────────────────────────────────────────
// Lo consumen cinco escrituras de /comisiones, cuatro lecturas de la misma
// página y el script de migración de datos. Ese es exactamente el caso del
// §1.1: dejarlo inline lo convertía en nueve copias que se desincronizan en
// silencio — que es, literalmente, el bug que se está arreglando.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo mínimo de un perfil para decidir dónde vive su PnL. */
export type PerfilPnl = {
  id: string;
  head_id?: string | null;
  /** Master IB (migración 129): su fila bajo su head es ND, no PnL. */
  is_master_ib?: boolean | null;
};

/** Lo mínimo de una fila de `commercial_monthly_results` para clasificarla. */
export type FilaDeResultado = {
  profile_id: string;
  head_id?: string | null;
};

/**
 * EL bucket de los resultados del grupo PnL de un perfil: el suyo propio.
 *
 * Es una función y no un `profile.id` suelto a propósito: el nombre es lo que
 * hace que en el punto de guardado se lea la doctrina y no "el head de esta
 * persona". Lo que se descartó: dejar `head_id` en `null` para el PnL. No se
 * puede — el UNIQUE de producción incluye `head_id` y en Postgres dos `null`
 * no chocan, así que cada guardado habría insertado una fila nueva en vez de
 * pisar la anterior. El bucket propio da la misma semántica ("no cuelga de
 * nadie") con una clave que sí desempata.
 */
export function bucketDePnl(profile: PerfilPnl): string {
  return profile.id;
}

/**
 * ¿Esta fila es la LÍNEA ND del Master IB (y por lo tanto NO es un resultado
 * de PnL)? Ver la excepción en la cabecera: es la fila de Jose Emanuel bajo
 * Ana García, y tocarla borra plata real del grupo de Ana.
 *
 * El `head_id !== profile.id` del final es defensa en profundidad: si alguna
 * vez apareciera un perfil colgado de sí mismo, su bucket propio seguiría
 * siendo PnL y no se perdería.
 */
export function esLineaNdDeMasterIb(row: FilaDeResultado, profile: PerfilPnl): boolean {
  return (
    !!profile.is_master_ib &&
    !!profile.head_id &&
    row.head_id === profile.head_id &&
    row.head_id !== profile.id
  );
}

/** Las filas de ESTE perfil que son resultados de PnL (sin la línea ND del master). */
export function filasPnlDe<T extends FilaDeResultado>(
  rows: readonly T[],
  profile: PerfilPnl,
): T[] {
  return rows.filter((r) => r.profile_id === profile.id && !esLineaNdDeMasterIb(r, profile));
}

/**
 * LA fila de PnL que manda para este perfil dentro del conjunto que se le pasa
 * (normalmente, las filas de un período).
 *
 * Primero el bucket PROPIO. Si no hay, **fallback documentado**: cualquier otra
 * fila de PnL del perfil — porque hay meses cuya única fila vive bajo un bucket
 * ajeno (Millones693, enero/febrero/mayo 2026) y una empresa que todavía no
 * corrió `scripts/migrar-buckets-pnl.ts` no puede quedarse sin número. Ese
 * fallback es TEMPORAL y se puede sacar cuando ya no queden datos viejos: lo
 * que NO se puede es que exista la fila propia y se lea otra — ese es el bug.
 *
 * OJO: esto NO es `planDeBucketPnl`. Acá se elige qué MOSTRAR con los datos tal
 * como están (determinista, sin mirar fechas); allá se elige qué SOBREVIVE a la
 * migración (lo último que alguien guardó). Son dos preguntas distintas y por
 * eso son dos funciones: para leer, la fila propia es la verdad por definición.
 */
export function filaPnlVigente<T extends FilaDeResultado>(
  rows: readonly T[],
  profile: PerfilPnl,
): T | null {
  const propias = filasPnlDe(rows, profile);
  const bucket = bucketDePnl(profile);
  return propias.find((r) => r.head_id === bucket) ?? propias[0] ?? null;
}

// ─── La aritmética peligrosa: elegir qué fila sobrevive a la migración ───────

/** Lo que la migración mira de cada fila. `updated_at` puede no estar. */
export type FilaMigrable = FilaDeResultado & {
  id?: string;
  updated_at?: string | null;
};

export type MotivoSuperviviente =
  /** No hay ninguna fila de PnL para este perfil/período. */
  | 'sin-filas'
  /** Hay una sola y ya vive en el bucket propio. */
  | 'ya-propia'
  /** Ganó la de `updated_at` más reciente. */
  | 'updated_at'
  /** Ninguna tiene `updated_at` usable: gana la del bucket propio. */
  | 'propia-sin-fecha'
  /** Empate (o nada usable) sin fila propia: se desempata por id. AVISA. */
  | 'desempate-id';

export type PlanBucketPnl<T> = {
  /** Nada que hacer: sin filas, o una sola y ya es la propia. */
  sinCambios: boolean;
  /** La fila cuyos VALORES quedan (lo último que alguien guardó). */
  superviviente: T | null;
  /** La fila que ya vive en el bucket propio, si existe. */
  filaPropia: T | null;
  /** La fila que queda EN PIE en la base (la propia si existe; si no, el superviviente). */
  queda: T | null;
  /** Hay que copiar los valores del superviviente SOBRE `queda`. */
  necesitaCopia: boolean;
  /** Hay que re-homear `queda` a `head_id = profile.id` (no existía fila propia). */
  necesitaRehome: boolean;
  /** Todas las demás filas del set: se borran. */
  aBorrar: T[];
  motivo: MotivoSuperviviente;
  /** Texto a IMPRIMIR cuando la elección no fue obvia (§1.2: avisar siempre). */
  advertencia: string | null;
};

/** `updated_at` parseable a milisegundos, o `null` si no se puede usar. */
function fechaDe(row: FilaMigrable): number | null {
  if (!row.updated_at) return null;
  const t = Date.parse(row.updated_at);
  return Number.isFinite(t) ? t : null;
}

/** Desempate ESTABLE cuando la fecha no alcanza: por id, y después por bucket. */
function porClave(a: FilaMigrable, b: FilaMigrable): number {
  const ia = String(a.id ?? '');
  const ib = String(b.id ?? '');
  if (ia !== ib) return ia < ib ? -1 : 1;
  const ha = String(a.head_id ?? '');
  const hb = String(b.head_id ?? '');
  return ha === hb ? 0 : ha < hb ? -1 : 1;
}

/**
 * EL PLAN para un (perfil PnL, período): qué fila sobrevive y qué se borra.
 *
 * ── Por qué gana el `updated_at` más reciente y no "la propia" ─────────────
 * Porque lo último que alguien guardó es lo que la persona está viendo hoy en
 * el tab del mes, y es el número que ya se usó para pagar. Para Hector en
 * agosto eso es la fila de **319,77** (el manual vigente), no la de 740,61 (el
 * CRM automático de una lógica anterior) — aunque la de 740,61 fuera la que el
 * Historial mostraba. Elegir por bucket habría conservado la vieja en los
 * meses cuya única fila está bajo un bucket ajeno.
 *
 * Lo que se descartó: elegir la de mayor `total_earned` (paga de más por
 * construcción) y elegir siempre la propia (pierde los meses sin fila propia).
 *
 * `updated_at` no es opcional en la tabla (tiene DEFAULT now() y trigger), pero
 * se trata como si pudiera faltar: una fila sin fecha usable no puede ganar la
 * comparación, y si NINGUNA la tiene se cae al bucket propio. El único caso que
 * queda ambiguo —empate o nada usable, y sin fila propia— se desempata por id
 * y sale con `advertencia`, para que el dry-run lo muestre y una persona mire.
 */
export function planDeBucketPnl<T extends FilaMigrable>(
  rows: readonly T[],
  profile: PerfilPnl,
): PlanBucketPnl<T> {
  const set = filasPnlDe(rows, profile);
  const bucket = bucketDePnl(profile);
  const filaPropia = set.find((r) => r.head_id === bucket) ?? null;

  const nada = (motivo: MotivoSuperviviente, superviviente: T | null): PlanBucketPnl<T> => ({
    sinCambios: true,
    superviviente,
    filaPropia,
    queda: superviviente,
    necesitaCopia: false,
    necesitaRehome: false,
    aBorrar: [],
    motivo,
    advertencia: null,
  });

  if (set.length === 0) return nada('sin-filas', null);
  if (set.length === 1 && filaPropia) return nada('ya-propia', filaPropia);

  let superviviente: T;
  let motivo: MotivoSuperviviente;
  let advertencia: string | null = null;

  const conFecha = set.filter((r) => fechaDe(r) !== null);
  if (conFecha.length === 0) {
    if (filaPropia) {
      superviviente = filaPropia;
      motivo = 'propia-sin-fecha';
    } else {
      superviviente = [...set].sort(porClave)[0];
      motivo = 'desempate-id';
      advertencia = 'ninguna fila tiene updated_at usable y no hay fila propia: elegida por id';
    }
  } else {
    const masReciente = Math.max(...conFecha.map((r) => fechaDe(r) as number));
    const empatadas = conFecha.filter((r) => fechaDe(r) === masReciente);
    if (empatadas.length === 1) {
      superviviente = empatadas[0];
      motivo = 'updated_at';
    } else if (filaPropia && empatadas.includes(filaPropia)) {
      // Empate → la del bucket propio.
      superviviente = filaPropia;
      motivo = 'updated_at';
    } else {
      superviviente = [...empatadas].sort(porClave)[0];
      motivo = 'desempate-id';
      advertencia = `empate de updated_at entre ${empatadas.length} filas sin fila propia: elegida por id`;
    }
  }

  const queda = filaPropia ?? superviviente;
  return {
    sinCambios: false,
    superviviente,
    filaPropia,
    queda,
    necesitaCopia: filaPropia !== null && superviviente !== filaPropia,
    necesitaRehome: filaPropia === null,
    aBorrar: set.filter((r) => r !== queda),
    motivo,
    advertencia,
  };
}
