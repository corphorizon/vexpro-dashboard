import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MT5_SQL_ENGINE_UNSUPPORTED,
  normalizeMt5Engine,
  parseMt5SqlSecret,
  redactMt5Error,
  validateMt5SqlFields,
} from './validate';
import { mysqlGrantsVerdict, postgresGrantsVerdict } from './read-only';

// ─────────────────────────────────────────────────────────────────────────────
// La réplica de MT5 es una base AJENA: si guardamos mal las credenciales o
// damos por bueno un usuario con permisos de escritura, el riesgo no es un
// número mal calculado sino tocar la producción de un broker. Estos tests
// cubren el parseo/validación y el veredicto de solo lectura sin abrir una
// sola conexión real.
// ─────────────────────────────────────────────────────────────────────────────

const VALID = {
  engine: 'mysql',
  host: 'db.broker.com',
  port: 3306,
  database: 'mt5',
  user: 'lector',
  password: 'clave-secreta',
};

describe('validate — motores', () => {
  it('normaliza los alias conocidos', () => {
    expect(normalizeMt5Engine('MySQL')).toBe('mysql');
    expect(normalizeMt5Engine('mariadb')).toBe('mysql');
    expect(normalizeMt5Engine('postgresql')).toBe('postgres');
    expect(normalizeMt5Engine('pg')).toBe('postgres');
  });

  it('rechaza mssql y oracle con el mensaje accionable', () => {
    for (const engine of ['mssql', 'sqlserver', 'oracle']) {
      const r = validateMt5SqlFields({ ...VALID, engine });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(MT5_SQL_ENGINE_UNSUPPORTED);
    }
  });
});

describe('validate — campos', () => {
  it('acepta un JSON completo', () => {
    const r = parseMt5SqlSecret(JSON.stringify(VALID));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(VALID);
  });

  it('acepta el puerto como string y lo convierte', () => {
    const r = validateMt5SqlFields({ ...VALID, port: '5432', engine: 'postgres' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.port).toBe(5432);
  });

  it('rechaza un JSON incompleto', () => {
    for (const missing of ['host', 'database', 'user', 'password'] as const) {
      const input = { ...VALID } as Record<string, unknown>;
      delete input[missing];
      const r = parseMt5SqlSecret(JSON.stringify(input));
      expect(r.ok, `falta ${missing}`).toBe(false);
    }
  });

  it('rechaza texto que no es JSON', () => {
    const r = parseMt5SqlSecret('no-soy-json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it('rechaza un host con esquema o con barras', () => {
    expect(validateMt5SqlFields({ ...VALID, host: 'https://db.broker.com' }).ok).toBe(false);
    expect(validateMt5SqlFields({ ...VALID, host: 'mysql://db.broker.com' }).ok).toBe(false);
    expect(validateMt5SqlFields({ ...VALID, host: 'db.broker.com/mt5' }).ok).toBe(false);
  });

  it('rechaza puertos fuera de rango o no enteros', () => {
    for (const port of [0, -1, 65536, 3306.5, 'abc', '']) {
      expect(validateMt5SqlFields({ ...VALID, port }).ok, String(port)).toBe(false);
    }
  });

  it('no trimea la contraseña (puede terminar en espacio)', () => {
    const r = validateMt5SqlFields({ ...VALID, password: 'clave ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.password).toBe('clave ');
  });
});

describe('redacción de secretos en errores', () => {
  it('borra la contraseña del mensaje', () => {
    const msg = redactMt5Error('Access denied for user using password clave-secreta', 'clave-secreta');
    expect(msg).not.toContain('clave-secreta');
    expect(msg).toContain('«contraseña oculta»');
  });

  it('borra credenciales embebidas en una URI', () => {
    const msg = redactMt5Error('connect failed: postgres://lector:clave@db.broker.com:5432/mt5', 'otra');
    expect(msg).not.toContain('lector:clave@');
  });

  it('tolera contraseñas con metacaracteres de regex', () => {
    const pass = 'a.*+?[]()';
    expect(redactMt5Error(`fail ${pass} end`, pass)).not.toContain(pass);
  });
});

describe('veredicto de solo lectura — MySQL', () => {
  it('da ok cuando sólo hay SELECT', () => {
    const r = mysqlGrantsVerdict([
      'GRANT USAGE ON *.* TO `lector`@`%`',
      'GRANT SELECT ON `mt5`.* TO `lector`@`%`',
    ]);
    expect(r.verdict).toBe('ok');
  });

  it('detecta INSERT/UPDATE/DELETE', () => {
    const r = mysqlGrantsVerdict(['GRANT SELECT, INSERT, UPDATE ON `mt5`.* TO `app`@`%`']);
    expect(r.verdict).toBe('ESCRITURA DETECTADA');
    expect(r.detail).toMatch(/INSERT/);
  });

  it('detecta ALL PRIVILEGES', () => {
    expect(mysqlGrantsVerdict(['GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost`']).verdict).toBe(
      'ESCRITURA DETECTADA',
    );
  });

  it('no se confunde con una base llamada "insert_logs"', () => {
    // La palabra INSERT aparece DESPUÉS del ON: no es un privilegio.
    expect(mysqlGrantsVerdict(['GRANT SELECT ON `insert_logs`.* TO `lector`@`%`']).verdict).toBe('ok');
  });

  it('respeta las comas dentro de los privilegios por columna', () => {
    const r = mysqlGrantsVerdict(['GRANT SELECT (Login, Balance) ON `mt5`.`mt5_users` TO `lector`@`%`']);
    expect(r.verdict).toBe('ok');
  });

  it('marca escritura si el privilegio por columna es UPDATE', () => {
    const r = mysqlGrantsVerdict(['GRANT UPDATE (Balance) ON `mt5`.`mt5_users` TO `app`@`%`']);
    expect(r.verdict).toBe('ESCRITURA DETECTADA');
  });

  it('sin filas, no afirma que haya escritura', () => {
    expect(mysqlGrantsVerdict([]).verdict).toBe('ok');
  });
});

describe('veredicto de solo lectura — PostgreSQL', () => {
  it('da ok con sólo SELECT', () => {
    const r = postgresGrantsVerdict([
      { privilege_type: 'SELECT', table_name: 'mt5_users' },
      { privilege_type: 'SELECT', table_name: 'mt5_deals' },
    ]);
    expect(r.verdict).toBe('ok');
  });

  it('detecta cualquier privilegio de escritura', () => {
    for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) {
      const r = postgresGrantsVerdict([{ privilege_type: p, table_name: 'mt5_deals' }]);
      expect(r.verdict, p).toBe('ESCRITURA DETECTADA');
    }
  });
});

// ─── Cliente: con los drivers mockeados ──────────────────────────────────────

vi.mock('../credentials', () => ({ resolveMt5SqlCredentials: vi.fn() }));

const mysqlQuery = vi.fn();
const mysqlEnd = vi.fn().mockResolvedValue(undefined);
const createConnection = vi.fn();
vi.mock('mysql2/promise', () => ({
  default: { createConnection: (...a: unknown[]) => createConnection(...a) },
  createConnection: (...a: unknown[]) => createConnection(...a),
}));

const pgConnect = vi.fn();
const pgQuery = vi.fn();
const pgEnd = vi.fn().mockResolvedValue(undefined);
vi.mock('pg', () => ({
  Client: class {
    connect = pgConnect;
    query = pgQuery;
    end = pgEnd;
  },
}));

describe('withMt5Connection', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mysqlEnd.mockResolvedValue(undefined);
    pgEnd.mockResolvedValue(undefined);
    createConnection.mockResolvedValue({ query: mysqlQuery, end: mysqlEnd });
    mysqlQuery.mockResolvedValue([[{ v: '8.0.36' }]]);
    pgConnect.mockResolvedValue(undefined);
    pgQuery.mockResolvedValue({ rows: [{ v: '16.2' }] });
    const { resolveMt5SqlCredentials } = await import('../credentials');
    vi.mocked(resolveMt5SqlCredentials).mockResolvedValue({ ...VALID, engine: 'mysql' });
  });

  it('fuerza la sesión de MySQL a solo lectura y cierra siempre', async () => {
    const { withMt5Connection } = await import('./client');
    const out = await withMt5Connection('company-1', async (s) => s.serverVersion);
    expect(out).toBe('8.0.36');
    const sentencias = mysqlQuery.mock.calls.map((c) => String(c[0]));
    expect(sentencias).toContain('SET SESSION TRANSACTION READ ONLY');
    expect(mysqlEnd).toHaveBeenCalled();
  });

  it('cierra la conexión aunque fn falle, y redacta la contraseña', async () => {
    const { withMt5Connection, Mt5SqlError } = await import('./client');
    const err = await withMt5Connection('company-1', async () => {
      throw new Error(`boom con ${VALID.password}`);
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Mt5SqlError);
    expect((err as Error).message).not.toContain(VALID.password);
    expect(mysqlEnd).toHaveBeenCalled();
  });

  it('fuerza la sesión de Postgres a solo lectura', async () => {
    const { resolveMt5SqlCredentials } = await import('../credentials');
    vi.mocked(resolveMt5SqlCredentials).mockResolvedValue({
      ...VALID,
      engine: 'postgres',
      port: 5432,
    });
    const { withMt5Connection } = await import('./client');
    await withMt5Connection('company-1', async (s) => s.serverVersion);
    const sentencias = pgQuery.mock.calls.map((c) => String(c[0]));
    expect(sentencias).toContain('SET default_transaction_read_only = on');
    expect(pgEnd).toHaveBeenCalled();
  });

  it('falla claro si la empresa no tiene credenciales', async () => {
    const { resolveMt5SqlCredentials } = await import('../credentials');
    vi.mocked(resolveMt5SqlCredentials).mockResolvedValue(null);
    const { withMt5Connection, Mt5SqlError } = await import('./client');
    const err = await withMt5Connection('company-1', async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(Mt5SqlError);
    expect((err as { code: string }).code).toBe('NOT_CONFIGURED');
  });
});
