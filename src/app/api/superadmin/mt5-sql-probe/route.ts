import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { withMt5Connection, Mt5SqlError, type Mt5Session } from '@/lib/api-integrations/mt5-sql/client';
import { mysqlGrantsVerdict, postgresGrantsVerdict, type ReadOnlyVerdict } from '@/lib/api-integrations/mt5-sql/read-only';

// ─────────────────────────────────────────────────────────────────────────────
// PROBAR CONEXIÓN — réplica SQL de MetaTrader 5.
//
// Herramienta de diagnóstico del superadmin. Con las credenciales cifradas del
// tenant: conecta, lista tablas, cuenta filas de mt5_users / mt5_deals y —lo
// más importante— VERIFICA que el usuario sea de SOLO LECTURA mirando sus
// permisos reales. NUNCA ejecuta una escritura para probarlo.
//
// IMPORTANTE (fase 1): la conexión sale DIRECTA desde la función de Vercel,
// sin proxy TCP (Fixie). Si la base del broker filtra por IP hay que autorizar
// las IPs de salida que devolvemos en el `hint`; el proxy TCP se cablea en la
// fase 2.
//
// Todo lo que hace son SELECTs. La sesión además se fuerza a solo lectura en
// el motor (ver mt5-sql/client.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

/** Presupuesto total del sondeo. Por encima de esto contestamos con el error. */
const PROBE_TIMEOUT_MS = 20_000;

/** IPs de salida fijas disponibles hoy (proxy de la fase 2 todavía sin cablear). */
const FIREWALL_HINT =
  'si la base exige IP fija, autorizar 3.224.144.155 y 3.223.196.67 — y avisar: la conexión por proxy TCP aún no está cableada (fase 2)';

interface TableInfo {
  name: string;
  isMt5: boolean;
}

interface ProbeResponse {
  success: true;
  connected: true;
  engine: 'mysql' | 'postgres';
  serverVersion: string;
  database: string;
  tables: TableInfo[];
  tableCountTotal: number;
  dealsPartitioned: boolean;
  samples: {
    mt5_users: { count: number | null; lastRegistration: string | null } | null;
    deals: { table: string; count: number | null; lastTime: string | null } | null;
  };
  readOnly: ReadOnlyVerdict;
  elapsedMs: number;
}

export async function GET(request: NextRequest) {
  const auth = await verifySuperadminAuth();
  if (auth instanceof NextResponse) return auth;

  const companyId = request.nextUrl.searchParams.get('company_id');
  if (!companyId || !/^[0-9a-f-]{36}$/i.test(companyId)) {
    return NextResponse.json({ success: false, error: 'company_id requerido' }, { status: 400 });
  }

  const startedAt = Date.now();
  try {
    const payload = await withTimeout(
      withMt5Connection(companyId, (session) => runProbe(session, startedAt)),
      PROBE_TIMEOUT_MS,
    );
    return NextResponse.json(payload);
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const { message, code } = describeError(err);
    return NextResponse.json(
      {
        success: false,
        connected: false,
        error: message,
        code,
        hint: looksLikeFirewall(code, message) ? FIREWALL_HINT : null,
        elapsedMs,
      },
      // 200 a propósito: es un diagnóstico, no un fallo del dashboard. El
      // panel decide el color mirando `connected`.
      { status: 200 },
    );
  }
}

// ─── Sondeo ───────────────────────────────────────────────────────────────

async function runProbe(session: Mt5Session, startedAt: number): Promise<ProbeResponse> {
  const allTables = await listTables(session);
  const tables: TableInfo[] = allTables
    .slice(0, 40)
    .map((name) => ({ name, isMt5: name.toLowerCase().startsWith('mt5_') }));

  // El SQL Export puede partir los deals por año (mt5_deals_2024, _2025…) o
  // dejarlos en una sola tabla. Detectamos ambas formas y elegimos a cuál
  // preguntarle: la sin sufijo si existe, si no la del año más alto.
  const dealTables = allTables.filter((t) => /^mt5_deals(_\d{4})?$/i.test(t)).sort();
  const dealsPartitioned = dealTables.some((t) => /_\d{4}$/.test(t));
  const dealsTable =
    dealTables.find((t) => /^mt5_deals$/i.test(t)) ?? dealTables[dealTables.length - 1] ?? null;

  const hasUsers = allTables.some((t) => /^mt5_users$/i.test(t));

  const [users, deals, readOnly] = await Promise.all([
    hasUsers ? sampleUsers(session) : Promise.resolve(null),
    dealsTable ? sampleDeals(session, dealsTable) : Promise.resolve(null),
    verifyReadOnly(session),
  ]);

  return {
    success: true,
    connected: true,
    engine: session.engine,
    serverVersion: session.serverVersion,
    database: session.database,
    tables,
    tableCountTotal: allTables.length,
    dealsPartitioned,
    samples: { mt5_users: users, deals },
    readOnly,
    elapsedMs: Date.now() - startedAt,
  };
}

async function listTables(session: Mt5Session): Promise<string[]> {
  if (session.engine === 'mysql') {
    const rows = await session.query<{ name: string }>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME`,
    );
    return rows.map((r) => String(r.name));
  }
  const rows = await session.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_name`,
  );
  return rows.map((r) => String(r.name));
}

/**
 * mt5_users: cuántos clientes hay y cuál es el último registro. El COUNT(*)
 * sobre esta tabla es barato incluso con cientos de miles de filas.
 */
async function sampleUsers(
  session: Mt5Session,
): Promise<{ count: number | null; lastRegistration: string | null }> {
  const rows = await session.query<{ c: unknown; last: unknown }>(
    session.engine === 'mysql'
      ? 'SELECT COUNT(*) AS c, MAX(Registration) AS last FROM mt5_users'
      : 'SELECT COUNT(*) AS c, MAX("Registration") AS last FROM mt5_users',
  );
  return { count: toNumber(rows[0]?.c), lastRegistration: toIsoish(rows[0]?.last) };
}

/**
 * Deals: idem sobre la tabla elegida. El nombre viene de information_schema
 * (no del usuario), pero igual se valida contra el patrón antes de
 * interpolarlo — los identificadores no admiten parámetros.
 */
async function sampleDeals(
  session: Mt5Session,
  table: string,
): Promise<{ table: string; count: number | null; lastTime: string | null }> {
  if (!/^mt5_deals(_\d{4})?$/i.test(table)) {
    return { table, count: null, lastTime: null };
  }
  const rows = await session.query<{ c: unknown; last: unknown }>(
    session.engine === 'mysql'
      ? `SELECT COUNT(*) AS c, MAX(Time) AS last FROM \`${table}\``
      : `SELECT COUNT(*) AS c, MAX("Time") AS last FROM "${table}"`,
  );
  return { table, count: toNumber(rows[0]?.c), lastTime: toIsoish(rows[0]?.last) };
}

/**
 * ¿El usuario es realmente de solo lectura? Se pregunta al motor por sus
 * permisos; el veredicto lo emiten funciones puras (mt5-sql/read-only.ts).
 */
async function verifyReadOnly(session: Mt5Session): Promise<ReadOnlyVerdict> {
  try {
    if (session.engine === 'mysql') {
      // SHOW GRANTS devuelve una única columna cuyo nombre depende del
      // usuario ("Grants for lector@%"), así que tomamos el primer valor.
      const rows = await session.query<Record<string, unknown>>('SHOW GRANTS FOR CURRENT_USER()');
      const lines = rows.map((r) => String(Object.values(r)[0] ?? ''));
      return mysqlGrantsVerdict(lines);
    }
    const rows = await session.query<{ privilege_type: string; table_name: string }>(
      `SELECT privilege_type, table_name
         FROM information_schema.role_table_grants
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND grantee IN (
            SELECT rolname FROM pg_roles WHERE pg_has_role(current_user, oid, 'member')
          )`,
    );
    return postgresGrantsVerdict(rows);
  } catch (err) {
    // No poder leer los permisos NO es prueba de que sea de solo lectura.
    return {
      verdict: 'ESCRITURA DETECTADA',
      detail: `No se pudieron leer los permisos del usuario (${
        err instanceof Error ? err.message.slice(0, 160) : 'error desconocido'
      }). Pedí al hosting la confirmación de que el usuario sólo tiene SELECT.`,
    };
  }
}

// ─── Utilidades ───────────────────────────────────────────────────────────

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Los DATETIME llegan como string (dateStrings) o Date según el driver. */
function toIsoish(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  return s === '' ? null : s;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Mt5SqlError(`El sondeo superó los ${ms / 1000} s sin respuesta`, 'PROBE_TIMEOUT')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Traduce el error del driver a algo que Kevin pueda accionar. Los mensajes
 * ya vienen redactados desde el cliente (sin contraseña).
 */
function describeError(err: unknown): { message: string; code: string | null } {
  const code = err instanceof Mt5SqlError ? err.code : null;
  const raw = err instanceof Error ? err.message : String(err);

  const table: Record<string, string> = {
    NOT_CONFIGURED: 'No hay credenciales de MT5 SQL cargadas para esta empresa.',
    PROBE_TIMEOUT: `Sin respuesta en ${PROBE_TIMEOUT_MS / 1000} s: el host no contesta (firewall, puerto cerrado o base caída).`,
    ECONNREFUSED: 'Conexión rechazada: el host contesta pero nada escucha en ese puerto.',
    ETIMEDOUT: 'Timeout de red: el host no contesta (lo más común es un firewall por IP).',
    ENOTFOUND: 'Host no encontrado (DNS): revisá el nombre del servidor.',
    EHOSTUNREACH: 'Host inalcanzable desde el servidor del dashboard.',
    ECONNRESET: 'El servidor cortó la conexión (a veces es TLS obligatorio o IP no autorizada).',
    ER_ACCESS_DENIED_ERROR: 'Usuario o contraseña incorrectos (acceso denegado por MySQL).',
    ER_DBACCESS_DENIED_ERROR: 'El usuario existe pero no tiene acceso a esa base de datos.',
    ER_BAD_DB_ERROR: 'La base de datos indicada no existe en ese servidor.',
    ER_HOST_NOT_PRIVILEGED: 'MySQL rechaza el origen: la IP del dashboard no está autorizada para este usuario.',
    '28P01': 'Contraseña incorrecta (Postgres).',
    '28000': 'Autenticación rechazada por Postgres (usuario o regla pg_hba).',
    '3D000': 'La base de datos indicada no existe (Postgres).',
  };

  const friendly = code ? table[code] : undefined;
  return { message: friendly ? `${friendly} [${code}]` : raw, code };
}

/** ¿El fallo huele a firewall / IP no autorizada? */
function looksLikeFirewall(code: string | null, message: string): boolean {
  if (code && ['ETIMEDOUT', 'PROBE_TIMEOUT', 'EHOSTUNREACH', 'ECONNRESET', 'ER_HOST_NOT_PRIVILEGED'].includes(code)) {
    return true;
  }
  return /timeout|timed out|not allowed|no autorizad|whitelist|not privileged/i.test(message);
}
