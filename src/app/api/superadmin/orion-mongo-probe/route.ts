import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { withOrionMongo, OrionMongoError, type OrionMongoSession } from '@/lib/api-integrations/orion-mongo/client';
import {
  mongoReadOnlyVerdict,
  type MongoAuthPrivilege,
  type MongoAuthRole,
  type ReadOnlyVerdict,
} from '@/lib/api-integrations/orion-mongo/read-only';

// ─────────────────────────────────────────────────────────────────────────────
// PROBAR CONEXIÓN — MongoDB del CRM Orion.
//
// Gemelo del sondeo de MT5 SQL: conecta con la credencial cifrada del tenant,
// lista colecciones, cuenta documentos de las primeras y verifica que el
// usuario sea de SOLO LECTURA leyendo sus roles/privilegios reales. Ninguna
// operación de escritura, ni siquiera para probar.
//
// IMPORTANTE (fase 1): conexión DIRECTA desde la función de Vercel, sin proxy
// TCP. Si el cluster filtra por IP (Atlas casi siempre lo hace) hay que
// autorizar las IPs del `hint`; el proxy TCP se cablea en la fase 2.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

const PROBE_TIMEOUT_MS = 20_000;

const FIREWALL_HINT =
  'si la base exige IP fija, autorizar 3.224.144.155 y 3.223.196.67 — y avisar: la conexión por proxy TCP aún no está cableada (fase 2)';

/** Nombres que suele tener un CRM. Se marcan para orientar el mapeo posterior. */
const CRM_HINT_NAMES = [
  'users',
  'clients',
  'deposits',
  'withdrawals',
  'transactions',
  'accounts',
  'kyc',
];

/** Cuántas colecciones se listan y de cuántas se cuenta el volumen. */
const MAX_COLLECTIONS = 40;
const MAX_COUNTED = 8;

interface CollectionInfo {
  name: string;
  /** true si el nombre coincide con uno de los típicos de un CRM. */
  isCrmLike: boolean;
  /** estimatedDocumentCount (sólo para las primeras MAX_COUNTED). */
  count: number | null;
}

export async function GET(request: NextRequest) {
  const auth = await verifySuperadminAuth();
  if (auth instanceof NextResponse) return auth;

  const companyId = request.nextUrl.searchParams.get('company_id');
  if (!companyId || !/^[0-9a-f-]{36}$/i.test(companyId)) {
    return NextResponse.json({ success: false, error: 'company_id requerido' }, { status: 400 });
  }

  // ?schema=deposits,withdrawals — devuelve SOLO los nombres de campo (y el
  // tipo BSON) del documento más reciente de cada colección pedida. Nunca
  // valores: es descubrimiento de esquema para diseñar los syncs sin exponer
  // datos de clientes. Máx 8 colecciones por llamada.
  const schemaParam = request.nextUrl.searchParams.get('schema');
  const schemaTargets = (schemaParam ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^[a-z0-9_]{1,64}$/i.test(x))
    .slice(0, 8);

  // ?facets=1 — distribución de valores de los campos CLASIFICADORES de las
  // colecciones de dinero (tipo, estado, procesador): conteo y suma por grupo.
  // Son agregados, sin un solo dato de cliente. Es lo que define las reglas de
  // clasificación del sync (¿'paypros' o 'PayPros'? ¿qué estados existen?).
  const wantFacets = request.nextUrl.searchParams.get('facets') === '1';

  const startedAt = Date.now();
  try {
    const payload = await withTimeout(
      withOrionMongo(companyId, (session) => runProbe(session, startedAt, schemaTargets, wantFacets)),
      PROBE_TIMEOUT_MS,
    );
    return NextResponse.json(payload);
  } catch (err) {
    const { message, code } = describeError(err);
    return NextResponse.json(
      {
        success: false,
        connected: false,
        error: message,
        code,
        hint: looksLikeFirewall(code, message) ? FIREWALL_HINT : null,
        elapsedMs: Date.now() - startedAt,
      },
      // 200 a propósito: diagnóstico, no fallo del dashboard.
      { status: 200 },
    );
  }
}

/** Tipo BSON legible de un valor, sin revelar el valor. */
function bsonTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length ? bsonTypeOf(v[0]) : 'vacío'})`;
  if (v instanceof Date) return 'date';
  const t = typeof v;
  if (t === 'object') {
    const ctor = (v as object).constructor?.name;
    if (ctor === 'ObjectId') return 'objectId';
    if (ctor === 'Decimal128' || ctor === 'Long' || ctor === 'Double' || ctor === 'Int32') return 'number';
    return 'object';
  }
  return t;
}

/** Facetas fijas: colección → [campos de agrupación, campo de monto]. */
const FACET_SPECS: ReadonlyArray<[collection: string, groupBy: string[], amountField: string]> = [
  ['deposits', ['depositType', 'depositStatus'], 'amountPaid'],
  ['withdrawals', ['processor', 'type', 'status'], 'transactionAmount'],
  ['transactions', ['transactionType', 'transactionStatus'], 'transactionValue'],
  ['fairpaytransactions', ['type', 'status'], 'amountUsd'],
  ['coinsbuytransactions', ['status'], 'amount'],
];

async function runProbe(session: OrionMongoSession, startedAt: number, schemaTargets: string[] = [], wantFacets = false) {
  const admin = session.db.admin();

  // connectionStatus es de las poquísimas órdenes que cualquier usuario puede
  // correr, y es la que dice QUIÉN somos y QUÉ podemos hacer.
  const status = (await admin.command({ connectionStatus: 1, showPrivileges: true })) as {
    authInfo?: {
      authenticatedUsers?: Array<{ user?: string; db?: string }>;
      authenticatedUserRoles?: MongoAuthRole[];
      authenticatedUserPrivileges?: MongoAuthPrivilege[];
    };
  };
  const roles = status.authInfo?.authenticatedUserRoles ?? [];
  const privileges = status.authInfo?.authenticatedUserPrivileges ?? null;
  const readOnly: ReadOnlyVerdict = mongoReadOnlyVerdict({ roles, privileges });

  // buildInfo necesita clusterMonitor: si el usuario es sólo `read`, falla.
  // No es motivo para dar el sondeo por perdido.
  let serverVersion = '';
  try {
    const build = (await admin.command({ buildInfo: 1 })) as { version?: string };
    serverVersion = build.version ?? '';
  } catch {
    serverVersion = '';
  }

  const names = (await session.db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => String(c.name))
    .sort();

  const collections: CollectionInfo[] = [];
  for (const [i, name] of names.slice(0, MAX_COLLECTIONS).entries()) {
    let count: number | null = null;
    if (i < MAX_COUNTED) {
      // estimatedDocumentCount lee los metadatos de la colección: no recorre
      // documentos, así que es barato incluso con millones de filas.
      count = await session.db
        .collection(name)
        .estimatedDocumentCount()
        .catch(() => null);
    }
    collections.push({
      name,
      isCrmLike: CRM_HINT_NAMES.includes(name.toLowerCase()),
      count,
    });
  }

  // Esquema por colección: claves + tipo del doc más reciente (por _id desc).
  // Los subdocumentos se describen un nivel: {cliente: 'object(keys: name, email)'}
  // sin bajar a los valores.
  const schemas: Record<string, Record<string, string> | { error: string }> = {};
  for (const name of schemaTargets) {
    try {
      const doc = await session.db.collection(name)
        .find({}, { sort: { _id: -1 }, limit: 1 })
        .next();
      if (!doc) { schemas[name] = { error: 'colección vacía' }; continue; }
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(doc)) {
        const t = bsonTypeOf(v);
        out[k] = t === 'object' && v
          ? `object(keys: ${Object.keys(v as object).slice(0, 15).join(', ')})`
          : t;
      }
      schemas[name] = out;
    } catch (err) {
      schemas[name] = { error: (err as Error).message.slice(0, 120) };
    }
  }

  // Facetas: $group con conteo, suma y rango de fechas por combinación.
  const facets: Record<string, unknown> = {};
  if (wantFacets) {
    for (const [coll, groupBy, amountField] of FACET_SPECS) {
      try {
        const idExpr: Record<string, string> = {};
        for (const g of groupBy) idExpr[g] = `$${g}`;
        const rows = await session.db.collection(coll).aggregate([
          { $group: {
              _id: idExpr,
              n: { $sum: 1 },
              total: { $sum: { $ifNull: [`$${amountField}`, 0] } },
              desde: { $min: '$createdAt' },
              hasta: { $max: '$createdAt' },
          } },
          { $sort: { n: -1 } },
          { $limit: 30 },
        ], { allowDiskUse: false, maxTimeMS: 8000 }).toArray();
        facets[coll] = rows.map((r) => ({ ...(r._id as object), n: r.n, total: Math.round(Number(r.total) * 100) / 100, desde: r.desde, hasta: r.hasta }));
      } catch (err) {
        facets[coll] = { error: (err as Error).message.slice(0, 120) };
      }
    }
  }

  return {
    success: true as const,
    connected: true as const,
    database: session.databaseName,
    serverVersion,
    user: status.authInfo?.authenticatedUsers?.[0]?.user ?? null,
    collections,
    collectionCountTotal: names.length,
    crmMatches: names.filter((n) => CRM_HINT_NAMES.includes(n.toLowerCase())),
    readOnly,
    schemas: Object.keys(schemas).length ? schemas : undefined,
    facets: wantFacets ? facets : undefined,
    elapsedMs: Date.now() - startedAt,
  };
}

// ─── Utilidades ───────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new OrionMongoError(`El sondeo superó los ${ms / 1000} s sin respuesta`, 'PROBE_TIMEOUT')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describeError(err: unknown): { message: string; code: string | null } {
  const code = err instanceof OrionMongoError ? err.code : null;
  const raw = err instanceof Error ? err.message : String(err);

  const table: Record<string, string> = {
    NOT_CONFIGURED: 'No hay connection string de Orion MongoDB cargada para esta empresa.',
    NO_DATABASE: 'Falta el nombre de la base de datos.',
    PROBE_TIMEOUT: `Sin respuesta en ${PROBE_TIMEOUT_MS / 1000} s: el cluster no contesta (lo más común es la lista de IPs permitidas).`,
    AuthenticationFailed: 'Usuario o contraseña incorrectos (autenticación rechazada por MongoDB).',
    Unauthorized: 'El usuario se autenticó pero no tiene permiso para leer esta base.',
    ECONNREFUSED: 'Conexión rechazada: nada escucha en ese host/puerto.',
    ENOTFOUND: 'Host no encontrado (DNS): revisá el host de la connection string.',
    ETIMEDOUT: 'Timeout de red: el cluster no contesta (firewall o IP no autorizada).',
  };
  const friendly = code ? table[code] : undefined;
  if (friendly) return { message: `${friendly} [${code}]`, code };

  // El driver no siempre pone un código: los mensajes más útiles vienen en el
  // texto ("Server selection timed out", "bad auth", "IP that isn't whitelisted").
  if (/server selection timed out|serverselectiontimeout/i.test(raw)) {
    return {
      message:
        'No se pudo elegir servidor dentro del timeout: el cluster no responde desde esta IP (típico de Atlas con lista de IPs).',
      code: 'SERVER_SELECTION_TIMEOUT',
    };
  }
  if (/bad auth|authentication failed/i.test(raw)) {
    return { message: 'Autenticación rechazada: usuario o contraseña incorrectos.', code: 'AuthenticationFailed' };
  }
  return { message: raw, code };
}

function looksLikeFirewall(code: string | null, message: string): boolean {
  if (code && ['PROBE_TIMEOUT', 'SERVER_SELECTION_TIMEOUT', 'ETIMEDOUT'].includes(code)) return true;
  return /timed out|timeout|whitelist|not allowed|ip address|no autorizad/i.test(message);
}
