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
// Fase 1: conexión DIRECTA, sin proxy TCP. Si la base del broker exige IP fija
// hay que autorizar las IPs de salida de Vercel (ver el probe); el cableado
// por proxy queda para la fase 2.
//
// No hay sincronización acá: esto es sólo la puerta de lectura que van a usar
// los syncs de las tandas siguientes.
// ─────────────────────────────────────────────────────────────────────────────

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

async function withMysql<T>(
  creds: Mt5SqlCredentials,
  fn: (session: Mt5Session) => Promise<T>,
): Promise<T> {
  // Import dinámico: mysql2 es pesado y sólo hace falta cuando el tenant usa
  // este motor. Además mantiene el driver fuera de los bundles que no lo usan.
  const mysql = await import('mysql2/promise');

  let conn: Awaited<ReturnType<typeof mysql.createConnection>> | null = null;
  try {
    conn = await mysql.createConnection({
      host: creds.host,
      port: creds.port,
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

    const query: Mt5Query = async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const [rows] = await conn!.query(sql, params ?? []);
      return (Array.isArray(rows) ? rows : []) as R[];
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
