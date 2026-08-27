// ─────────────────────────────────────────────────────────────────────────────
// Detección de copia de operaciones entre cuentas.
//
// ── POR QUÉ NO SE MIRAN LAS IPs ────────────────────────────────────────────
// Porque la IP no distingue copiar de compartir operadora. Medido el
// 2026-08-27 sobre las cuentas reales de Vex Pro:
//
//     104.194.10.113   164 cuentas
//     172.96.140.136   134 cuentas
//     172.96.142.7     115 cuentas
//
// Ciento sesenta y cuatro cuentas en una IP no son 164 personas copiándose:
// es una VPN o el CGNAT de una operadora móvil. Como regla automática eso
// acusa a gente que sólo comparte proveedor de internet.
//
// La evidencia de copiar son las OPERACIONES: dos cuentas que abren el mismo
// símbolo, en la misma dirección, con segundos de diferencia, una y otra vez.
// Eso ES el comportamiento, no un indicio de él. La IP queda como
// corroboración —y sólo cuando el grupo que la comparte es chico—.
//
// ── POR QUÉ EN MEMORIA Y NO CON UN SELF-JOIN ───────────────────────────────
// `mt5_deals` tiene 68 millones de filas y un self-join por ventana de tiempo
// sobre eso no termina. Pero las aperturas de las cuentas de prop firm en 120
// días son 42.914 sobre 1.115 cuentas: se traen y se emparejan acá.
//
// ── LO QUE ESTE MÓDULO NO AFIRMA ───────────────────────────────────────────
// No dice que alguien copió. Dice que dos cuentas operan sincronizadas, con
// qué cobertura y con qué retraso típico. Dos personas de la misma sala
// siguiendo la misma señal dan la misma huella que un copiador, y la
// diferencia no está en los datos.
// ─────────────────────────────────────────────────────────────────────────────

import { withMt5Connection, mt5DateUtc, type Mt5Session } from '@/lib/api-integrations/mt5-sql/client';

/**
 * Ventana para considerar dos aperturas "a la vez", en segundos.
 *
 * Un copiador real tiene retraso: la señal viaja, el puente ejecuta. Treinta
 * segundos cubre desde un copiador instantáneo hasta uno lento sin abarcar
 * tanto que dos personas reaccionando a la misma vela cuenten como copia.
 */
export const VENTANA_SEGUNDOS = 30;

/** Mínimo de coincidencias para que un par valga la pena mirar. */
export const MIN_COINCIDENCIAS = 5;

/**
 * Fracción de la cuenta MÁS CHICA que tiene que estar replicada.
 *
 * Se mide contra la más chica a propósito: si A hizo 20 operaciones y B hizo
 * 400, que las 20 de A estén todas dentro de las de B es copia de A a B —
 * dividir por 400 lo escondería.
 */
export const MIN_COBERTURA = 0.6;

/**
 * ── EL ESCAPE DE LA BARRA, RESUELTO DE RAÍZ ────────────────────────────────
 * Los grupos de MT5 usan barra invertida (`real\PropFirm\...`) y en un LIKE
 * normal la barra es el carácter de escape, así que hay que duplicarla — y la
 * cantidad cambia según se escriba como literal SQL o como parámetro. Ya falló
 * dos veces: en el módulo de PNL y otra vez acá, en un archivo nuevo, DESPUÉS
 * de haberlo documentado. Contar barras no es una técnica.
 *
 * `ESCAPE '~'` declara otro carácter de escape, así que la barra pierde su
 * significado especial y basta con UNA. Comprobado contra la base:
 *
 *     literal con 4 barras   → 1.281   (correcto, pero hay que acertar 4)
 *     literal con 2 barras   → 0       (falla EN SILENCIO)
 *     parámetro con 1 barra  → 0       (falla EN SILENCIO)
 *     ESCAPE '~' con 1 barra → 1.281   ✓
 *
 * Los dos modos de fallo devuelven cero filas sin error, que se lee como
 * "ninguna cuenta opera" en vez de "el filtro está roto".
 */
const GRUPO_PROPFIRM = 'real\\PropFirm%';
const GRUPO_APALANCADAS = 'real\\Broker\\%Apalancad%';

const SQL_APERTURAS = [
  'SELECT d.Login AS login, d.Symbol AS simbolo, d.Action AS direccion, d.TimeMsc AS cuando',
  '  FROM mt5_deals d',
  '  JOIN mt5_users u ON u.Login = d.Login',
  " WHERE (u.`Group` LIKE ? ESCAPE '~' OR u.`Group` LIKE ? ESCAPE '~')",
  '   AND d.Entry = 0 AND d.Action IN (0,1)',
  '   AND d.TimeMsc >= ?',
  ' ORDER BY d.Symbol, d.Action, d.TimeMsc',
].join('\n');

/** Cuántas cuentas matchea el filtro. Ver el comentario de arriba. */
const SQL_CUENTAS = [
  'SELECT COUNT(*) AS n FROM mt5_users',
  " WHERE `Group` LIKE ? ESCAPE '~' OR `Group` LIKE ? ESCAPE '~'",
].join('\n');

export interface Apertura {
  login: number;
  simbolo: string;
  direccion: number;
  cuando: number;
}

export interface ParSincronizado {
  loginA: number;
  loginB: number;
  /** Operaciones de A que tienen gemela en B dentro de la ventana. */
  coincidencias: number;
  operacionesA: number;
  operacionesB: number;
  /** coincidencias / min(operacionesA, operacionesB). */
  cobertura: number;
  /** Retraso típico entre las dos, en segundos. */
  retrasoMedianoSeg: number;
  /** Símbolos en los que coinciden, los más frecuentes primero. */
  simbolos: string[];
}

/**
 * Aperturas de un conjunto EXPLÍCITO de cuentas.
 *
 * Es la variante que usa la revisión de cuentas normales (BROKER/SOCIAL), donde
 * el universo no es «un grupo de MT5» sino la lista de logins que ya venimos
 * analizando.
 *
 * Filtrar por `Login IN (...)` en vez de por `Group LIKE` esquiva de raíz la
 * trampa del escape de la barra invertida, que ya falló dos veces en este repo
 * — y de paso usa el índice que arranca por `Login`.
 *
 * El llamador acota la lista: el costo depende enteramente de cuántas cuentas
 * y cuánta actividad tengan.
 */
export async function loadAperturasByLogins(
  companyId: string,
  logins: number[],
  desde: Date,
): Promise<Apertura[]> {
  if (logins.length === 0) return [];
  const corte = desde.toISOString().slice(0, 19).replace('T', ' ');
  const ph = logins.map(() => '?').join(',');
  const sql = [
    'SELECT Login AS login, Symbol AS simbolo, Action AS direccion, TimeMsc AS cuando',
    '  FROM mt5_deals',
    ` WHERE Login IN (${ph})`,
    '   AND Entry = 0 AND Action IN (0,1)',
    '   AND TimeMsc >= ?',
    ' ORDER BY Symbol, Action, TimeMsc',
  ].join('\n');

  const filas = await withMt5Connection(companyId, async (s: Mt5Session) =>
    s.query<Record<string, unknown>>(sql, [...logins, corte]),
  );

  const out: Apertura[] = [];
  for (const r of filas) {
    // Parseo UTC explícito, igual que en el resto: acá los emparejamientos usan
    // DIFERENCIAS (la zona se cancela), pero normalizar evita que alguien
    // compare estos epochs contra Orion y herede el desfase fantasma.
    const t = mt5DateUtc(r.cuando);
    if (!t) continue;
    out.push({
      login: Number(r.login),
      simbolo: String(r.simbolo ?? ''),
      direccion: Number(r.direccion),
      cuando: t.getTime(),
    });
  }
  return out;
}

/** Trae las aperturas de las cuentas de prop firm desde una fecha. */
export async function loadAperturas(
  companyId: string,
  desde: Date,
): Promise<Apertura[]> {
  const corte = desde.toISOString().slice(0, 19).replace('T', ' ');
  const { filas, cuentas } = await withMt5Connection(companyId, async (s: Mt5Session) => ({
    cuentas: await s.query<{ n: unknown }>(SQL_CUENTAS, [GRUPO_PROPFIRM, GRUPO_APALANCADAS]),
    filas: await s.query<Record<string, unknown>>(SQL_APERTURAS, [GRUPO_PROPFIRM, GRUPO_APALANCADAS, corte]),
  }));

  // Si el filtro de grupos no matchea NINGUNA cuenta, está roto — no es que
  // nadie opere. Los dos casos devuelven cero aperturas y se ven idénticos.
  const nCuentas = Number(cuentas[0]?.n ?? 0);
  if (nCuentas === 0) {
    throw new Error(
      'El filtro de grupos de prop firm no matchea ninguna cuenta: la consulta está mal, ' +
      'no es que no haya actividad. Revisar el escape de la barra invertida.',
    );
  }
  const out: Apertura[] = [];
  for (const r of filas) {
    // Parseo UTC explícito. Acá los emparejamientos usan DIFERENCIAS de tiempo
    // (la zona se cancela), pero normalizar igual evita que alguien compare
    // estos epochs contra Orion o el calendario y herede el desfase fantasma.
    const t = mt5DateUtc(r.cuando);
    if (!t) continue;
    out.push({
      login: Number(r.login),
      simbolo: String(r.simbolo ?? ''),
      direccion: Number(r.direccion),
      cuando: t.getTime(),
    });
  }
  return out;
}

/** Clave estable de un par, sin importar el orden. */
const clavePar = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Empareja aperturas simultáneas del mismo símbolo y dirección.
 *
 * Recorre cada grupo (símbolo, dirección) ordenado por tiempo con una ventana
 * deslizante: para cada apertura, mira sólo hacia atrás hasta donde llega la
 * ventana. Eso deja el costo en O(n · k) con k = cuántas caben en 30 segundos,
 * en vez del O(n²) de comparar todas contra todas.
 */
export function findSynchronizedPairs(
  aperturas: Apertura[],
  opts: { ventanaSeg?: number; minCoincidencias?: number; minCobertura?: number } = {},
): ParSincronizado[] {
  const ventana = (opts.ventanaSeg ?? VENTANA_SEGUNDOS) * 1000;
  const minCo = opts.minCoincidencias ?? MIN_COINCIDENCIAS;
  const minCob = opts.minCobertura ?? MIN_COBERTURA;

  const porCuenta = new Map<number, number>();
  for (const a of aperturas) porCuenta.set(a.login, (porCuenta.get(a.login) ?? 0) + 1);

  interface Acc { n: number; retrasos: number[]; simbolos: Map<string, number>; }
  const pares = new Map<string, Acc>();

  // Agrupar por (símbolo, dirección) conservando el orden temporal.
  const grupos = new Map<string, Apertura[]>();
  for (const a of aperturas) {
    const k = `${a.simbolo}|${a.direccion}`;
    const g = grupos.get(k);
    if (g) g.push(a);
    else grupos.set(k, [a]);
  }

  for (const g of grupos.values()) {
    g.sort((x, y) => x.cuando - y.cuando);
    let inicio = 0;
    for (let i = 0; i < g.length; i++) {
      while (g[i].cuando - g[inicio].cuando > ventana) inicio++;
      for (let j = inicio; j < i; j++) {
        // La misma cuenta abriendo dos veces seguidas no es copia: es su
        // propia operativa.
        if (g[j].login === g[i].login) continue;
        const k = clavePar(g[i].login, g[j].login);
        const acc: Acc = pares.get(k) ?? { n: 0, retrasos: [], simbolos: new Map<string, number>() };
        acc.n += 1;
        acc.retrasos.push((g[i].cuando - g[j].cuando) / 1000);
        acc.simbolos.set(g[i].simbolo, (acc.simbolos.get(g[i].simbolo) ?? 0) + 1);
        pares.set(k, acc);
      }
    }
  }

  const salida: ParSincronizado[] = [];
  for (const [k, acc] of pares) {
    const [a, b] = k.split('|').map(Number);
    const opsA = porCuenta.get(a) ?? 0;
    const opsB = porCuenta.get(b) ?? 0;
    const menor = Math.min(opsA, opsB);
    if (menor === 0) continue;
    // La cobertura se acota a 1: una cuenta puede coincidir varias veces con
    // la misma de enfrente, y sin el tope daría más del 100%, que no significa
    // nada y hace desconfiar de todo el número.
    const cobertura = Math.min(1, acc.n / menor);
    if (acc.n < minCo || cobertura < minCob) continue;

    const ordenados = [...acc.retrasos].sort((x, y) => x - y);
    salida.push({
      loginA: a, loginB: b,
      coincidencias: acc.n, operacionesA: opsA, operacionesB: opsB,
      cobertura: Math.round(cobertura * 1000) / 1000,
      retrasoMedianoSeg: Math.round(ordenados[Math.floor(ordenados.length / 2)] * 10) / 10,
      simbolos: [...acc.simbolos.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([s]) => s),
    });
  }

  return salida.sort((x, y) => y.cobertura - x.cobertura || y.coincidencias - x.coincidencias);
}

// ─────────────────────────────────────────────────────────────────────────────
// LA IP, COMO DATO Y NUNCA COMO REGLA
//
// La cabecera de este archivo explica por qué la IP no puede ser una regla
// automática: medido el 2026-08-27 sobre las cuentas reales de Vex Pro hay una
// IP con 164 cuentas, otra con 134 y otra con 115. Eso es una VPN o el CGNAT
// de una operadora, no 164 personas copiándose.
//
// Pero el revisor lo pidió explícitamente (Kevin, 2026-08-27: «da el dato de
// la ip, si ves que coinciden ips, da ese dato y di con cuántas cuentas y
// cuáles»), y como DATO sí sirve: dos cuentas de nombres distintos en una IP
// que sólo comparten ellas dos es algo que mirar. Por eso esto devuelve
// SIEMPRE el tamaño del grupo junto a la lista: sin el tamaño, «comparte IP
// con otras cuentas» miente por omisión.
//
// El veredicto del retiro NO lo toca: se guarda en `review_facts`, que son los
// datos para que los lea una persona, no en `review_checks`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A partir de cuántas cuentas el grupo deja de decir nada.
 *
 * Diez es holgado a propósito: una familia, un cibercafé o una oficina chica
 * caben debajo; una VPN de 164 no. Por encima de este número la pantalla dice
 * que es probable VPN u operadora en vez de listar las cuentas — listarlas
 * daría un muro de logins que se lee como una acusación.
 */
export const UMBRAL_IP_MASIVA = 10;

/** Cuántas cuentas del grupo se guardan cuando el grupo es chico. */
const MAX_CUENTAS_LISTADAS = 25;

export interface SharedIpFacts {
  /** `mt5_users.LastIP` del login revisado. */
  ip: string | null;
  /** OTRAS cuentas reales (no demo) con esa misma IP. */
  sharedIpTotal: number;
  /** Las primeras, con nombre para poder reconocer al titular. */
  sharedIpAccounts: Array<{ login: number; name: string }>;
  /** `sharedIpTotal > UMBRAL_IP_MASIVA`: el grupo no distingue nada. */
  sharedIpMassive: boolean;
}

/**
 * Las demo no cuentan: comparten IP con cualquiera y no hay dinero detrás.
 *
 * `ESCAPE '~'` por costumbre de este archivo: acá el patrón no lleva barra
 * invertida, pero el día que alguien lo cambie por un grupo que sí la lleve el
 * escape ya está puesto y no vuelve a fallar en silencio. Ver el comentario de
 * GRUPO_PROPFIRM.
 */
/** Placeholders explícitos: la expansión de arrays de mysql2 no vale para el
 *  camino de Postgres del mismo cliente, y acá no cuesta nada escribirlos. */
const sqlIpDeLogins = (n: number) =>
  `SELECT Login, LastIP FROM mt5_users WHERE Login IN (${Array.from({ length: n }, () => '?').join(',')})`;
const SQL_IP_TOTAL = [
  'SELECT COUNT(*) AS n FROM mt5_users',
  " WHERE LastIP = ? AND Login <> ? AND `Group` NOT LIKE 'demo%' ESCAPE '~'",
].join('\n');
const SQL_IP_CUENTAS = [
  'SELECT Login, Name FROM mt5_users',
  " WHERE LastIP = ? AND Login <> ? AND `Group` NOT LIKE 'demo%' ESCAPE '~'",
  ' ORDER BY Login',
  ` LIMIT ${MAX_CUENTAS_LISTADAS}`,
].join('\n');

/**
 * IP de cada login y las otras cuentas reales que la comparten.
 *
 * Se resuelve en una sola conexión para los logins que se le pasen: en el
 * cron son los pendientes (hoy tres), y abrir una conexión al MySQL del broker
 * por retiro sería tres veces el mismo saludo.
 */
export async function loadSharedIpFacts(
  companyId: string,
  logins: number[],
): Promise<Map<number, SharedIpFacts>> {
  const salida = new Map<number, SharedIpFacts>();
  const unicos = [...new Set(logins.filter((l) => Number.isFinite(l) && l > 0))];
  if (unicos.length === 0) return salida;

  await withMt5Connection(companyId, async (s: Mt5Session) => {
    const ips = await s.query<Record<string, unknown>>(sqlIpDeLogins(unicos.length), unicos);
    for (const fila of ips) {
      const login = Number(fila.Login);
      const ip = String(fila.LastIP ?? '').trim();
      if (!ip) {
        // Sin IP no se inventa una: la cuenta puede no haberse conectado nunca
        // desde que el servidor guarda el campo.
        salida.set(login, { ip: null, sharedIpTotal: 0, sharedIpAccounts: [], sharedIpMassive: false });
        continue;
      }
      const total = Number((await s.query<{ n: unknown }>(SQL_IP_TOTAL, [ip, login]))[0]?.n ?? 0);
      // Cuando el grupo es masivo ni se traen las cuentas: no se van a mostrar
      // y son 164 filas que nadie va a leer.
      const cuentas = total > 0 && total <= UMBRAL_IP_MASIVA
        ? (await s.query<Record<string, unknown>>(SQL_IP_CUENTAS, [ip, login])).map((r) => ({
            login: Number(r.Login),
            name: String(r.Name ?? '—'),
          }))
        : [];
      salida.set(login, {
        ip,
        sharedIpTotal: total,
        sharedIpAccounts: cuentas,
        sharedIpMassive: total > UMBRAL_IP_MASIVA,
      });
    }
    return null;
  });

  return salida;
}
