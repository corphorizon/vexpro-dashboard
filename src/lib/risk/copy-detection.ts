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

import { withMt5Connection, type Mt5Session } from '@/lib/api-integrations/mt5-sql/client';

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
    const t = r.cuando instanceof Date ? r.cuando : new Date(String(r.cuando));
    if (Number.isNaN(t.getTime())) continue;
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
