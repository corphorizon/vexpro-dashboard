import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseMongoUri, redactMongoError } from './validate';
import { mongoReadOnlyVerdict } from './read-only';

// ─────────────────────────────────────────────────────────────────────────────
// La connection string de Mongo lleva usuario y contraseña adentro: si se
// escapa en un mensaje de error, el acceso al CRM del broker queda expuesto en
// un log. Y si damos por bueno un usuario con readWrite, el dashboard podría
// escribir en el CRM. Las dos cosas se cubren acá, sin red.
// ─────────────────────────────────────────────────────────────────────────────

describe('parseMongoUri', () => {
  it('acepta mongodb:// y saca host y base', () => {
    const r = parseMongoUri('mongodb://lector:clave@db.broker.com:27017/orion');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scheme).toBe('mongodb');
      expect(r.value.hostHint).toBe('db.broker.com:27017');
      expect(r.value.uriDatabase).toBe('orion');
    }
  });

  it('acepta mongodb+srv:// con opciones y sin base', () => {
    const r = parseMongoUri('mongodb+srv://u:p@cluster0.abcd.mongodb.net/?retryWrites=true');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scheme).toBe('mongodb+srv');
      expect(r.value.hostHint).toBe('cluster0.abcd.mongodb.net');
      expect(r.value.uriDatabase).toBeNull();
    }
  });

  it('soporta replica set con varios hosts', () => {
    const r = parseMongoUri('mongodb://u:p@a.com:27017,b.com:27017/orion?replicaSet=rs0');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.hostHint).toBe('a.com:27017,b.com:27017');
  });

  it('funciona sin credenciales en la URI', () => {
    const r = parseMongoUri('mongodb://localhost:27017/orion');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.hostHint).toBe('localhost:27017');
  });

  it('rechaza esquemas inválidos', () => {
    for (const uri of ['', 'http://db.broker.com', 'postgres://x', 'mongo://x', 'db.broker.com']) {
      expect(parseMongoUri(uri).ok, uri).toBe(false);
    }
  });

  it('rechaza una URI sin host', () => {
    expect(parseMongoUri('mongodb:///orion').ok).toBe(false);
  });
});

describe('redactMongoError', () => {
  const URI = 'mongodb+srv://lector:clave-secreta@cluster0.mongodb.net/orion';

  it('borra la URI completa del mensaje', () => {
    const msg = redactMongoError(`connect ECONNREFUSED ${URI}`, URI);
    expect(msg).not.toContain('clave-secreta');
    expect(msg).not.toContain(URI);
  });

  it('borra credenciales aunque el driver haya reescrito la URI', () => {
    const msg = redactMongoError(
      'MongoServerError from mongodb+srv://lector:clave-secreta@cluster0.mongodb.net/otra?ssl=true',
      URI,
    );
    expect(msg).not.toContain('clave-secreta');
  });
});

describe('veredicto de solo lectura — Mongo', () => {
  it('ok con rol read', () => {
    const r = mongoReadOnlyVerdict({ roles: [{ role: 'read', db: 'orion' }] });
    expect(r.verdict).toBe('ok');
  });

  it('ok con readAnyDatabase', () => {
    expect(mongoReadOnlyVerdict({ roles: [{ role: 'readAnyDatabase', db: 'admin' }] }).verdict).toBe('ok');
  });

  it('detecta readWrite / dbAdmin / root', () => {
    for (const role of ['readWrite', 'dbAdmin', 'root', 'dbOwner', 'restore']) {
      const r = mongoReadOnlyVerdict({ roles: [{ role, db: 'orion' }] });
      expect(r.verdict, role).toBe('ESCRITURA DETECTADA');
    }
  });

  it('marca como no verificable un rol a medida sin privilegios expandidos', () => {
    const r = mongoReadOnlyVerdict({ roles: [{ role: 'crmCustomRole', db: 'orion' }] });
    expect(r.verdict).toBe('ESCRITURA DETECTADA');
    expect(r.detail).toMatch(/a medida/);
  });

  it('los privilegios expandidos mandan sobre el nombre del rol', () => {
    // Rol a medida que en realidad sólo lee → ok.
    const ok = mongoReadOnlyVerdict({
      roles: [{ role: 'crmCustomRole', db: 'orion' }],
      privileges: [{ resource: { db: 'orion', collection: '' }, actions: ['find', 'listCollections'] }],
    });
    expect(ok.verdict).toBe('ok');

    // Rol que se llama "read" pero puede insertar → escritura.
    const bad = mongoReadOnlyVerdict({
      roles: [{ role: 'read', db: 'orion' }],
      privileges: [{ resource: { db: 'orion', collection: '' }, actions: ['find', 'insert'] }],
    });
    expect(bad.verdict).toBe('ESCRITURA DETECTADA');
    expect(bad.detail).toMatch(/insert/);
  });
});

// ─── Cliente: driver mockeado ────────────────────────────────────────────────

vi.mock('../credentials', () => ({ resolveOrionMongoCredentials: vi.fn() }));

const mongoConnect = vi.fn();
const mongoClose = vi.fn().mockResolvedValue(undefined);
const mongoDb = vi.fn();
const ctorArgs: unknown[][] = [];
vi.mock('mongodb', () => ({
  MongoClient: class {
    constructor(...args: unknown[]) {
      ctorArgs.push(args);
    }
    connect = mongoConnect;
    db = mongoDb;
    close = mongoClose;
  },
}));

const CREDS = { uri: 'mongodb://lector:clave@db.broker.com:27017/orion', database: 'orion' };

describe('withOrionMongo', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ctorArgs.length = 0;
    mongoConnect.mockResolvedValue(undefined);
    mongoClose.mockResolvedValue(undefined);
    mongoDb.mockReturnValue({ name: 'orion' });
    const { resolveOrionMongoCredentials } = await import('../credentials');
    vi.mocked(resolveOrionMongoCredentials).mockResolvedValue({ ...CREDS });
  });

  it('abre con pool de 1 y timeouts cortos, y cierra siempre', async () => {
    const { withOrionMongo } = await import('./client');
    const out = await withOrionMongo('company-1', async (s) => s.databaseName);
    expect(out).toBe('orion');
    const opts = ctorArgs[0][1] as Record<string, number>;
    expect(opts.maxPoolSize).toBe(1);
    expect(opts.serverSelectionTimeoutMS).toBe(8000);
    expect(opts.socketTimeoutMS).toBe(15000);
    expect(mongoClose).toHaveBeenCalled();
  });

  it('redacta la URI si el driver falla', async () => {
    mongoConnect.mockRejectedValue(new Error(`bad auth for ${CREDS.uri}`));
    const { withOrionMongo, OrionMongoError } = await import('./client');
    const err = await withOrionMongo('company-1', async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(OrionMongoError);
    expect((err as Error).message).not.toContain('clave');
    expect(mongoClose).toHaveBeenCalled();
  });

  it('falla claro sin credenciales', async () => {
    const { resolveOrionMongoCredentials } = await import('../credentials');
    vi.mocked(resolveOrionMongoCredentials).mockResolvedValue(null);
    const { withOrionMongo } = await import('./client');
    const err = await withOrionMongo('company-1', async () => 1).catch((e) => e);
    expect((err as { code: string }).code).toBe('NOT_CONFIGURED');
  });

  it('falla claro si no hay base de datos', async () => {
    const { resolveOrionMongoCredentials } = await import('../credentials');
    vi.mocked(resolveOrionMongoCredentials).mockResolvedValue({ uri: CREDS.uri, database: null });
    const { withOrionMongo } = await import('./client');
    const err = await withOrionMongo('company-1', async () => 1).catch((e) => e);
    expect((err as { code: string }).code).toBe('NO_DATABASE');
  });
});
