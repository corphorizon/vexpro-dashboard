// ─────────────────────────────────────────────────────────────────────────────
// Lector base de la réplica SQL de MetaTrader 5 (SQL Export del Backup Server).
//
// Qué hace y qué NO hace:
//   · Abre UNA conexión por invocación (serverless: no hay pool que sobreviva
//     entre requests) y la cierra siempre en `finally`.
//   · Fuerza la sesión a SOLO LECTURA donde el motor lo permite. Es defensa en
//     profundidad: el usuario que nos den YA tiene que ser de solo lectura, y
//     el probe del superadmin lo verifica. Esto sólo evita que un bug nuestro
//     escriba en la base de un cliente.
//   · Timeouts cortos (8 s conectar, 15 s por consulta) porque todo esto corre
//     dentro de funciones de Vercel con presupuesto limitado.
//   · Los errores salen SIN contraseña ni cadena de conexión (redactMt5Error).
//
// SALIDA POR IP FIJA. El hosting del broker filtra por IP: probado el
// 2026-08-24, el MySQL de Vex Pro (57.129.140.227) acepta la IP de Kevin y las
// dos del proxy —que son las que el propio sondeo sugiere autorizar— pero NO
// las de Vercel, que son dinámicas. Por eso, cuando FIXIE_URL está definida la
// conexión se tuneliza por SOCKS5 y sale siempre por 3.224.144.155 o
// 3.223.196.67. Sin FIXIE_URL (desarrollo local) va directa, que es lo que
// hace falta para probar desde una máquina ya autorizada.
//
// No hay sincronización acá: esto es sólo la puerta de lectura que van a usar
// los syncs de las tandas siguientes.
// ─────────────────────────────────────────────────────────────────────────────

import type { Socket } from 'node:net';
import 'server-only';
import type { Mt5SqlCredentials } from '../credentials';
import { resolveMt5SqlCredentials } from '../credentials';
import { redactMt5Error, type Mt5SqlEngine } from './validate';

export const MT5_CONNECT_TIMEOUT_MS = 8_000;
export const MT5_QUERY_TIMEOUT_MS = 15_000;

/** Ejecuta una consulta parametrizada y devuelve las filas tipadas. */
export type Mt5Query = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

export interface Mt5Session {
  engine: Mt5SqlEngine;
  /** Versión del servidor, útil para el diagnóstico. */
  serverVersion: string;
  /** Nombre de la base a la que estamos conectados. */
  database: string;
  query: Mt5Query;
}

/** Error de conexión/consulta ya redactado, listo para mostrar al superadmin. */
export class Mt5SqlError extends Error {
  /** Código del driver (ECONNREFUSED, ER_ACCESS_DENIED_ERROR, 28P01…). */
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'Mt5SqlError';
    this.code = code;
  }
}

function toMt5Error(err: unknown, password: string): Mt5SqlError {
  const raw = err instanceof Error ? err.message : String(err);
  const code =
    typeof (err as { code?: unknown })?.code === 'string'
      ? ((err as { code: string }).code)
      : null;
  return new Mt5SqlError(redactMt5Error(raw, password), code);
}

/**
 * Abre la conexión con las credenciales del tenant y ejecuta `fn`.
 * Lanza Mt5SqlError si la empresa no tiene credenciales cargadas.
 */
export async function withMt5Connection<T>(
  companyId: string,
  fn: (session: Mt5Session) => Promise<T>,
): Promise<T> {
  const creds = await resolveMt5SqlCredentials(companyId);
  if (!creds) {
    throw new Mt5SqlError('MT5 SQL no configurado para esta empresa', 'NOT_CONFIGURED');
  }
  return creds.engine === 'mysql'
    ? withMysql(creds, fn)
    : withPostgres(creds, fn);
}

// ── MySQL / MariaDB ──────────────────────────────────────────────────────

/**
 * Abre un socket TCP al destino a través del proxy SOCKS5 de Fixie, para que
 * la conexión salga por una IP fija y autorizada.
 *
 * Devuelve null cuando no hay FIXIE_URL: en local se conecta directo, que es
 * justo lo que permite probar desde una máquina ya autorizada.
 *
 * Si el proxy está configurado pero falla, se PROPAGA el error en vez de caer
 * a la conexión directa. Un fallback silencioso daría un "no se pudo conectar"
 * genérico desde una IP que el broker jamás va a aceptar, y perderíamos el
 * verdadero motivo.
 */
async function openProxiedSocket(host: string, port: number): Promise<Socket | null> {
  const proxyUrl = process.env.FIXIE_URL;
  if (!proxyUrl) return null;

  const u = new URL(proxyUrl);
  const { SocksClient } = await import('socks');
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: u.hostname,
      port: Number(u.port),
      type: 5,
      userId: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    },
    command: 'connect',
    destination: { host, port },
    timeout: MT5_CONNECT_TIMEOUT_MS,
  });
  return socket;
}

async function withMysql<T>(
  creds: Mt5SqlCredentials,
  fn: (session: Mt5Session) => Promise<T>,
): Promise<T> {
  // Import dinámico: mysql2 es pesado y sólo hace falta cuando el tenant usa
  // este motor. Además mantiene el driver fuera de los bundles que no lo usan.
  const mysql = await import('mysql2/promise');

  // El túnel se abre ANTES que el driver: mysql2 recibe un socket ya conectado
  // al destino y no se entera de que hay un proxy en el medio.
  const stream = await openProxiedSocket(creds.host, creds.port);

  let conn: Awaited<ReturnType<typeof mysql.createConnection>> | null = null;
  try {
    conn = await mysql.createConnection({
      host: creds.host,
      port: creds.port,
      // Cuando hay túnel, mysql2 usa este socket en vez de abrir el suyo. El
      // host/port de arriba quedan igual porque el driver los usa para el
      // saludo y para los mensajes de error.
      ...(stream ? { stream } : {}),
      user: creds.user,
      password: creds.password,
      database: creds.database,
      connectTimeout: MT5_CONNECT_TIMEOUT_MS,
      // El SQL Export de MT5 usa DATETIME; que vuelvan como string evita que
      // el driver los reinterprete en la zona horaria del servidor de Vercel.
      dateStrings: true,
      // Sin multipleStatements: un ';' inyectado no puede abrir una segunda
      // sentencia (que podría ser una escritura).
      multipleStatements: false,
      // El hosting típico del broker sirve MySQL con certificado autofirmado.
      // Ciframos igual pero sin exigir cadena de confianza; lo contrario es no
      // poder conectarse a casi ninguno.
      ssl: { rejectUnauthorized: false },
    });

    // Defensa extra: la transacción de esta sesión no puede escribir.
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query(`SET SESSION max_execution_time = ${MT5_QUERY_TIMEOUT_MS}`).catch(() => {
      // MariaDB no tiene max_execution_time (usa max_statement_time, en
      // segundos). Si falla, seguimos: el timeout del socket nos cubre.
    });

    const [versionRows] = await conn.query('SELECT VERSION() AS v');
    const serverVersion = String(
      (Array.isArray(versionRows) ? (versionRows[0] as { v?: unknown })?.v : '') ?? '',
    );

    // ── EL TIMEOUT QUE ESTA CABECERA PROMETÍA Y NO CUMPLÍA ────────────────
    //
    // Arriba dice «15 s por consulta», pero eso sólo se pedía con el
    // `SET SESSION max_execution_time` de más arriba — que va con `.catch(() =>
    // {})` porque MariaDB no lo tiene, y que además sólo limita la EJECUCIÓN en
    // el motor, no la espera de la respuesta por la red.
    //
    // `mysql2` no tiene un equivalente a `query_timeout` de `pg`: si los
    // paquetes dejan de llegar, `conn.query()` no resuelve NUNCA. Y como acá la
    // conexión sale por un túnel SOCKS —Londres → el proxy en Virginia → el
    // MySQL del broker en Europa—, hay bastante camino donde quedarse esperando.
    //
    // Sin este corte, una consulta trabada se come el presupuesto entero de la
    // función y Vercel la mata con «Task timed out after 120 seconds». Se vio en
    // producción el 2026-08-28 en `/api/superadmin/liquidity/accounts` y en el
    // cron `account-review`: 504 exactamente en el límite, que es la firma de un
    // cuelgue y no de un trabajo lento.
    //
    // Con el corte, lo mismo falla en 15 s con un mensaje que dice qué pasó.
    const query: Mt5Query = async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      let temporizador: NodeJS.Timeout | undefined;
      try {
        const rows = await Promise.race([
          conn!.query(sql, params ?? []).then(([r]) => r),
          new Promise<never>((_, rechazar) => {
            temporizador = setTimeout(() => {
              // La conexión se destruye: quedó en un estado del que no se
              // vuelve, y reutilizarla colgaría la consulta siguiente.
              conn?.destroy();
              rechazar(new Error(
                `La consulta a MT5 superó los ${MT5_QUERY_TIMEOUT_MS / 1000} s sin respuesta. ` +
                `Puede ser el enlace con el broker o una consulta demasiado pesada.`,
              ));
            }, MT5_QUERY_TIMEOUT_MS);
          }),
        ]);
        return (Array.isArray(rows) ? rows : []) as R[];
      } finally {
        // Se limpia siempre: un temporizador vivo mantiene despierto el proceso
        // aunque la consulta ya haya respondido.
        if (temporizador) clearTimeout(temporizador);
      }
    };

    return await fn({ engine: 'mysql', serverVersion, database: creds.database, query });
  } catch (err) {
    throw toMt5Error(err, creds.password);
  } finally {
    // end() puede rechazar si la conexión ya murió: no debe tapar el error real.
    await conn?.end().catch(() => {});
  }
}

// ── PostgreSQL ───────────────────────────────────────────────────────────

async function withPostgres<T>(
  creds: Mt5SqlCredentials,
  fn: (session: Mt5Session) => Promise<T>,
): Promise<T> {
  const { Client } = await import('pg');

  const client = new Client({
    host: creds.host,
    port: creds.port,
    user: creds.user,
    password: creds.password,
    database: creds.database,
    connectionTimeoutMillis: MT5_CONNECT_TIMEOUT_MS,
    query_timeout: MT5_QUERY_TIMEOUT_MS,
    statement_timeout: MT5_QUERY_TIMEOUT_MS,
    // Igual que en MySQL: TLS sí, verificación de cadena no (certificados
    // autofirmados en el hosting del broker). Configurable por si algún
    // tenant sí tiene una CA pública.
    ssl: postgresSslOption(),
  });

  let connected = false;
  try {
    await client.connect();
    connected = true;

    // Defensa extra: cualquier INSERT/UPDATE en esta sesión falla en el motor.
    await client.query('SET default_transaction_read_only = on');

    const version = await client.query<{ v: string }>('SHOW server_version');
    const serverVersion = version.rows[0]?.v ?? '';

    const query: Mt5Query = async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const res = await client.query(sql, params ?? []);
      return res.rows as R[];
    };

    return await fn({ engine: 'postgres', serverVersion, database: creds.database, query });
  } catch (err) {
    throw toMt5Error(err, creds.password);
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

/**
 * TLS de Postgres. Por defecto ciframos sin verificar la cadena; poner
 * MT5_SQL_PG_STRICT_SSL=true exige un certificado válido (para el tenant que
 * tenga una CA de verdad).
 */
function postgresSslOption(): { rejectUnauthorized: boolean } {
  return { rejectUnauthorized: process.env.MT5_SQL_PG_STRICT_SSL === 'true' };
}


// ─────────────────────────────────────────────────────────────────────────────
// Parseo de fechas de MT5 — SIEMPRE como UTC, nunca al gusto del runtime.
//
// ── LA MEDICIÓN FANTASMA QUE MOTIVÓ ESTO ───────────────────────────────────
// El 2026-08-27 una medición reportó «MT5 va 4 horas atrás de Orion, constante
// en 266/269 casos, sin horario de verano». Sonaba a zona horaria del bróker.
// Era la NUESTRA: este cliente devuelve DATETIME como texto (`dateStrings`), y
// `new Date('2026-08-25 18:10:00')` sin zona se interpreta en la del proceso.
// La Mac de Kevin corre en UTC+4 (Golfo, sin DST — por eso el desfase era
// «constante sin verano»); Vercel corre en UTC y por eso producción acertaba.
//
// Verificado con parseo explícito contra Orion (authorizedDate, UTC real):
// Δ = 0 minutos en los 8 casos sondeados. Los sellos de MT5 SON UTC.
//
// La moraleja: producción era correcta DE CASUALIDAD — dependía de que el
// runtime estuviera en UTC. Esta función quita esa dependencia. Todo consumo
// de fechas venidas de MT5 pasa por acá.
// ─────────────────────────────────────────────────────────────────────────────
export function mt5DateUtc(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  // `2026-08-25 18:10:00.593000` → `2026-08-25T18:10:00.593Z`. Los microsegundos
  // se truncan a milisegundos: JS no tiene más resolución.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/);
  if (!m) {
    // Cualquier otro formato (ISO con zona, etc.) se parsea tal cual: si trae
    // zona propia, respetarla es lo correcto.
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const ms = m[3] ? m[3].slice(0, 3).padEnd(3, '0') : '000';
  const d = new Date(`${m[1]}T${m[2]}.${ms}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
