// ─────────────────────────────────────────────────────────────────────────────
// Validación y parseo del secreto de la réplica SQL de MetaTrader 5.
//
// El "SQL Export" del Backup Server de MT5 vuelca las tablas mt5_* a una base
// relacional que el hosting del broker administra. Nosotros SÓLO leemos de esa
// réplica; nunca del servidor MT5 en vivo.
//
// Estas funciones son PURAS a propósito: las usan el upsert (para rechazar
// datos malos antes de cifrar), el resolver (para parsear lo guardado) y los
// tests. Duplicar la validación entre la route y el resolver es la receta para
// que se desincronicen en silencio, así que vive acá sola.
//
// Motores soportados HOY: MySQL/MariaDB y PostgreSQL. MSSQL y Oracle también
// son destinos válidos del SQL Export de MT5, pero no tenemos driver cableado
// todavía: se rechazan con un mensaje accionable en vez de fallar al conectar.
// ─────────────────────────────────────────────────────────────────────────────

/** Motores que sabemos leer hoy. MariaDB entra como 'mysql' (mismo protocolo). */
export const MT5_SQL_ENGINES = ['mysql', 'postgres'] as const;
export type Mt5SqlEngine = (typeof MT5_SQL_ENGINES)[number];

/** Mensaje único para los motores que MT5 soporta pero nosotros todavía no. */
export const MT5_SQL_ENGINE_UNSUPPORTED =
  'Motor no soportado: de momento MySQL/MariaDB o PostgreSQL; pedir al hosting ese engine o avisarnos.';

/** Forma exacta del JSON que se cifra en `encrypted_secret`. */
export interface Mt5SqlSecret {
  engine: Mt5SqlEngine;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Normaliza el nombre del motor que llega del panel o de una fila vieja.
 * 'mariadb' y 'mysql' colapsan a 'mysql'; 'postgres'/'postgresql'/'pg' a
 * 'postgres'. Cualquier otra cosa → null (el caller decide el mensaje).
 */
export function normalizeMt5Engine(raw: unknown): Mt5SqlEngine | null {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'mysql' || v === 'mariadb') return 'mysql';
  if (v === 'postgres' || v === 'postgresql' || v === 'pg') return 'postgres';
  return null;
}

/**
 * Valida los campos sueltos de la conexión. Se usa tanto sobre el JSON que
 * manda el panel como sobre el JSON descifrado.
 *
 * Reglas:
 *  · engine ∈ {mysql, postgres} (mariadb → mysql).
 *  · host no vacío y SIN esquema (http://, https://, mysql://…): es un host de
 *    red, no una URL. Un pegado con esquema es el error más típico y produce
 *    un ENOTFOUND críptico si lo dejamos pasar.
 *  · port entero 1..65535.
 *  · database / user / password no vacíos.
 */
export function validateMt5SqlFields(input: {
  engine?: unknown;
  host?: unknown;
  port?: unknown;
  database?: unknown;
  user?: unknown;
  password?: unknown;
}): ParseResult<Mt5SqlSecret> {
  const engine = normalizeMt5Engine(input.engine);
  if (!engine) return { ok: false, error: MT5_SQL_ENGINE_UNSUPPORTED };

  const host = typeof input.host === 'string' ? input.host.trim() : '';
  if (!host) return { ok: false, error: 'MT5 SQL: el host es obligatorio.' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    return {
      ok: false,
      error: 'MT5 SQL: el host va sin esquema (sin http://, https:// ni mysql://). Ej: db.hosting.com',
    };
  }
  if (/[\s/\\]/.test(host)) {
    return { ok: false, error: 'MT5 SQL: el host no puede tener espacios ni barras.' };
  }

  const portNum =
    typeof input.port === 'number'
      ? input.port
      : typeof input.port === 'string' && input.port.trim() !== ''
        ? Number(input.port)
        : NaN;
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { ok: false, error: 'MT5 SQL: el puerto debe ser un entero entre 1 y 65535.' };
  }

  const database = typeof input.database === 'string' ? input.database.trim() : '';
  const user = typeof input.user === 'string' ? input.user.trim() : '';
  // La contraseña NO se trimea: puede terminar en espacio a propósito.
  const password = typeof input.password === 'string' ? input.password : '';
  if (!database) return { ok: false, error: 'MT5 SQL: la base de datos es obligatoria.' };
  if (!user) return { ok: false, error: 'MT5 SQL: el usuario es obligatorio.' };
  if (!password) return { ok: false, error: 'MT5 SQL: la contraseña es obligatoria.' };

  return { ok: true, value: { engine, host, port: portNum, database, user, password } };
}

/** Igual que el anterior pero partiendo del JSON crudo (string). */
export function parseMt5SqlSecret(raw: string): ParseResult<Mt5SqlSecret> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: 'MT5 SQL: el secreto debe ser JSON {engine, host, port, database, user, password}.',
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'MT5 SQL: el secreto debe ser un objeto JSON.' };
  }
  return validateMt5SqlFields(parsed as Record<string, unknown>);
}

/**
 * Saca la contraseña (y cualquier cosa parecida a una URI con credenciales)
 * del texto de un error antes de devolverlo al panel. Los drivers a veces
 * incluyen la config completa en el mensaje.
 */
export function redactMt5Error(message: string, password: string | null | undefined): string {
  let out = message;
  if (password && password.length >= 3) {
    // split/join en vez de RegExp: la contraseña puede tener metacaracteres.
    out = out.split(password).join('«contraseña oculta»');
  }
  // user:pass@host en cualquier URI que se haya colado.
  out = out.replace(/\/\/[^\s/@]+:[^\s/@]+@/g, '//«credenciales ocultas»@');
  return out;
}
