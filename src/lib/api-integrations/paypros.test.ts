import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import {
  buildIngoingResponse,
  buildUnparseableResponse,
  computeOutgoingSignature,
  isDeposit,
  limaToUtcIso,
  outgoingSignedFields,
  parseOutgoing,
  statusLabel,
  toNormalizedTx,
  verifyOutgoingSignature,
  PAYPROS_DEPOSIT_STATUS,
  SIGNATURE_VARIANTS,
} from './paypros';
import { fetchPayprosBalance, parsePayprosBalance } from './paypros/balance';
import { proxiedFetch } from './proxy';
import { resolvePayprosCredentials } from './credentials';

// El balance sale por red y por la DB: las dos puntas se mockean.
vi.mock('./proxy', () => ({ proxiedFetch: vi.fn() }));
vi.mock('./credentials', () => ({ resolvePayprosCredentials: vi.fn() }));

const mockFetch = vi.mocked(proxiedFetch);
const mockCreds = vi.mocked(resolvePayprosCredentials);

// ─────────────────────────────────────────────────────────────────────────────
// Pay-Pros es PUSH puro: si el parseo o la firma están mal, la plata
// directamente no entra al dashboard y NO hay API para recuperarla. Estos
// tests cubren todas las funciones puras del protocolo.
// ─────────────────────────────────────────────────────────────────────────────

const SIGN_KEY = 'sign-key-de-prueba';
const API_KEY = 'api-key-de-prueba';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Arma un body válido firmado con la variante indicada. */
function makeBody(
  fields: string[],
  variant: 'concat' | 'amp' | 'amp-fields' = 'concat',
  signKey = SIGN_KEY,
): string {
  const payload =
    variant === 'concat'
      ? fields.join('') + signKey
      : variant === 'amp'
        ? [...fields, signKey].join('&')
        : fields.join('&') + signKey;
  return [...fields, sha256(payload)].join('&');
}

const FIELDS = ['2023-03-03T09:45:15', '76', 'BAN0009876236', '10', 'USD', '4'];

// ── parseOutgoing ───────────────────────────────────────────────────────

describe('parseOutgoing', () => {
  it('parsea el ejemplo LITERAL de la documentación', () => {
    const body =
      '2023-03-03T09:45:15&76&BAN0009876236&10&USD&4&' +
      '0d15132a598cd9a90ba83ea3f8f3108125ab25034c8b3b14912babb5b3f0494d';
    const parsed = parseOutgoing(body);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      datetime: '2023-03-03T09:45:15',
      notifyReference: '76',
      uid: 'BAN0009876236',
      amountRaw: '10',
      amount: 10,
      currencyCode: 'USD',
      status: 4,
      signature: '0d15132a598cd9a90ba83ea3f8f3108125ab25034c8b3b14912babb5b3f0494d',
    });
  });

  it('acepta montos decimales', () => {
    expect(parseOutgoing(makeBody(['2026-01-15T10:00:00', 'n1', 'u1', '1234.56', 'PEN', '4']))?.amount)
      .toBe(1234.56);
  });

  it('tolera el \\r\\n final de algunos clientes HTTP', () => {
    expect(parseOutgoing(`${makeBody(FIELDS)}\r\n`)).not.toBeNull();
  });

  it('acepta los 6 status documentados', () => {
    for (const s of [1, 2, 4, 5, 6, 7]) {
      const body = makeBody(['2026-01-15T10:00:00', 'n', 'u', '5', 'USD', String(s)]);
      expect(parseOutgoing(body)?.status).toBe(s);
    }
  });

  it('rechaza status fuera del set documentado (0, 3, 8)', () => {
    for (const s of [0, 3, 8, 99]) {
      const body = makeBody(['2026-01-15T10:00:00', 'n', 'u', '5', 'USD', String(s)]);
      expect(parseOutgoing(body)).toBeNull();
    }
  });

  it('rechaza un body con menos o más de 7 campos', () => {
    expect(parseOutgoing('2023-03-03T09:45:15&76&BAN1&10&USD&4')).toBeNull();
    expect(parseOutgoing(`${makeBody(FIELDS)}&extra`)).toBeNull();
  });

  it('rechaza body vacío o no-string', () => {
    expect(parseOutgoing('')).toBeNull();
    expect(parseOutgoing('   ')).toBeNull();
    expect(parseOutgoing(null as unknown as string)).toBeNull();
  });

  it('rechaza un datetime con formato distinto al documentado', () => {
    expect(parseOutgoing(makeBody(['2023-03-03 09:45:15', 'n', 'u', '5', 'USD', '4']))).toBeNull();
    expect(parseOutgoing(makeBody(['2023-03-03T09:45:15Z', 'n', 'u', '5', 'USD', '4']))).toBeNull();
    expect(parseOutgoing(makeBody(['03/03/2023T09:45:15', 'n', 'u', '5', 'USD', '4']))).toBeNull();
  });

  it('rechaza una fecha imposible aunque el formato encaje', () => {
    expect(parseOutgoing(makeBody(['2026-02-31T09:45:15', 'n', 'u', '5', 'USD', '4']))).toBeNull();
  });

  it('rechaza un monto no numérico o negativo', () => {
    expect(parseOutgoing(makeBody(['2026-01-15T10:00:00', 'n', 'u', 'diez', 'USD', '4']))).toBeNull();
    expect(parseOutgoing(makeBody(['2026-01-15T10:00:00', 'n', 'u', '-10', 'USD', '4']))).toBeNull();
    expect(parseOutgoing(makeBody(['2026-01-15T10:00:00', 'n', 'u', '', 'USD', '4']))).toBeNull();
  });

  it('rechaza notifyReference, uid o currency vacíos', () => {
    expect(parseOutgoing(makeBody(['2026-01-15T10:00:00', '', 'u', '5', 'USD', '4']))).toBeNull();
    expect(parseOutgoing(makeBody(['2026-01-15T10:00:00', 'n', '', '5', 'USD', '4']))).toBeNull();
    expect(parseOutgoing(makeBody(['2026-01-15T10:00:00', 'n', 'u', '5', '', '4']))).toBeNull();
  });

  it('rechaza una firma que no es sha256 hex de 64 caracteres', () => {
    expect(parseOutgoing([...FIELDS, 'abc'].join('&'))).toBeNull();
    expect(parseOutgoing([...FIELDS, 'z'.repeat(64)].join('&'))).toBeNull();
  });
});

// ── Firma entrante ──────────────────────────────────────────────────────

describe('computeOutgoingSignature / verifyOutgoingSignature', () => {
  it('la variante por defecto concatena campos + signKey sin separador', () => {
    const parsed = parseOutgoing(makeBody(FIELDS))!;
    expect(computeOutgoingSignature(parsed, SIGN_KEY)).toBe(sha256(FIELDS.join('') + SIGN_KEY));
  });

  it('outgoingSignedFields devuelve los 6 campos en el orden de la doc', () => {
    const parsed = parseOutgoing(makeBody(FIELDS))!;
    expect(outgoingSignedFields(parsed)).toEqual(FIELDS);
  });

  it('acepta las tres variantes de concatenación e informa cuál coincidió', () => {
    for (const variant of SIGNATURE_VARIANTS) {
      const parsed = parseOutgoing(makeBody(FIELDS, variant))!;
      expect(verifyOutgoingSignature(parsed, SIGN_KEY)).toEqual({ valid: true, variant });
    }
  });

  it('acepta la firma en MAYÚSCULAS (hex case-insensitive)', () => {
    const parsed = parseOutgoing(makeBody(FIELDS))!;
    const upper = { ...parsed, signature: parsed.signature.toUpperCase() };
    expect(verifyOutgoingSignature(upper, SIGN_KEY).valid).toBe(true);
  });

  it('rechaza una firma calculada con OTRA sign key', () => {
    const parsed = parseOutgoing(makeBody(FIELDS, 'concat', 'key-del-atacante'))!;
    expect(verifyOutgoingSignature(parsed, SIGN_KEY)).toEqual({ valid: false, variant: null });
  });

  it('rechaza si un campo fue manipulado después de firmar (monto inflado)', () => {
    const parsed = parseOutgoing(makeBody(FIELDS))!;
    const tampered = { ...parsed, amountRaw: '10000', amount: 10000 };
    expect(verifyOutgoingSignature(tampered, SIGN_KEY).valid).toBe(false);
  });

  it('rechaza cuando no hay sign key configurada', () => {
    const parsed = parseOutgoing(makeBody(FIELDS))!;
    expect(verifyOutgoingSignature(parsed, '')).toEqual({ valid: false, variant: null });
  });

  it('el orden de los campos importa (permutar rompe la firma)', () => {
    const permutados = ['76', '2023-03-03T09:45:15', 'BAN0009876236', '10', 'USD', '4'];
    const parsed = parseOutgoing(makeBody(FIELDS))!;
    expect(computeOutgoingSignature(permutados, SIGN_KEY)).not.toBe(parsed.signature);
  });
});

// ── Respuesta (ingoing string) ──────────────────────────────────────────

describe('buildIngoingResponse', () => {
  const parsed = parseOutgoing(makeBody(FIELDS))!;

  it('respeta el formato errorCode&notifyReference&uid&amount&currencyCode&signature', () => {
    const out = buildIngoingResponse(0, parsed, SIGN_KEY, API_KEY);
    const parts = out.split('&');
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 5)).toEqual(['0', '76', 'BAN0009876236', '10', 'USD']);
    expect(parts[5]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('firma con la signature key Y LA API KEY, en ese orden', () => {
    const out = buildIngoingResponse(0, parsed, SIGN_KEY, API_KEY);
    const esperado = sha256(['0', '76', 'BAN0009876236', '10', 'USD'].join('') + SIGN_KEY + API_KEY);
    expect(out.split('&')[5]).toBe(esperado);
  });

  it('cambia la firma si cambia el errorCode', () => {
    const ok = buildIngoingResponse(0, parsed, SIGN_KEY, API_KEY).split('&')[5];
    const firma = buildIngoingResponse(1, parsed, SIGN_KEY, API_KEY).split('&')[5];
    const datos = buildIngoingResponse(2, parsed, SIGN_KEY, API_KEY).split('&')[5];
    expect(new Set([ok, firma, datos]).size).toBe(3);
  });

  it('soporta firmar la respuesta con la misma variante que validó la entrante', () => {
    const out = buildIngoingResponse(0, parsed, SIGN_KEY, API_KEY, 'amp');
    const esperado = sha256(['0', '76', 'BAN0009876236', '10', 'USD', SIGN_KEY, API_KEY].join('&'));
    expect(out.split('&')[5]).toBe(esperado);
  });

  it('buildUnparseableResponse devuelve errorCode 2 con los campos vacíos', () => {
    const out = buildUnparseableResponse(SIGN_KEY, API_KEY);
    expect(out.split('&').slice(0, 5)).toEqual(['2', '', '', '', '']);
    expect(out.split('&')[5]).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Lima → UTC ──────────────────────────────────────────────────────────

describe('limaToUtcIso', () => {
  it('suma 5 horas (Lima es GMT-5 fijo, sin horario de verano)', () => {
    expect(limaToUtcIso('2023-03-03T09:45:15')).toBe('2023-03-03T14:45:15.000Z');
  });

  it('cruza el día correctamente', () => {
    expect(limaToUtcIso('2026-01-15T21:30:00')).toBe('2026-01-16T02:30:00.000Z');
  });

  it('cruza el año correctamente', () => {
    expect(limaToUtcIso('2025-12-31T20:00:00')).toBe('2026-01-01T01:00:00.000Z');
  });

  it('NO aplica DST: julio y enero usan el mismo offset', () => {
    expect(limaToUtcIso('2026-07-15T12:00:00')).toBe('2026-07-15T17:00:00.000Z');
    expect(limaToUtcIso('2026-01-15T12:00:00')).toBe('2026-01-15T17:00:00.000Z');
  });

  it('devuelve null si el formato no es el documentado', () => {
    expect(limaToUtcIso('2026-01-15 12:00:00')).toBeNull();
    expect(limaToUtcIso('2026-01-15T12:00:00Z')).toBeNull();
    expect(limaToUtcIso('')).toBeNull();
  });
});

// ── Normalización ───────────────────────────────────────────────────────

describe('toNormalizedTx', () => {
  it('mapea el ejemplo de la doc a la fila de api_transactions', () => {
    const parsed = parseOutgoing(makeBody(FIELDS))!;
    const tx = toNormalizedTx(parsed)!;
    expect(tx).toMatchObject({
      provider: 'paypros',
      external_id: 'BAN0009876236',   // uid, NO notifyReference
      amount: 10,
      fee: 0,
      currency: 'USD',
      status: 'paid',
      transaction_date: '2023-03-03T14:45:15.000Z',
    });
  });

  it('conserva el notifyReference dentro de raw (idempotencia / auditoría)', () => {
    const parsed = parseOutgoing(makeBody(FIELDS))!;
    expect(toNormalizedTx(parsed)!.raw.notifyReference).toBe('76');
  });

  it('traduce cada código de estado a su texto legible', () => {
    const esperado: Record<number, string> = {
      1: 'refund_approved',
      2: 'refund_declined',
      4: 'paid',
      5: 'unpaid',
      6: 'payout_paid',
      7: 'payout_declined',
    };
    for (const [code, label] of Object.entries(esperado)) {
      const parsed = parseOutgoing(makeBody(['2026-01-15T10:00:00', 'n', 'u', '5', 'USD', code]))!;
      expect(toNormalizedTx(parsed)!.status).toBe(label);
      expect(statusLabel(parsed.status)).toBe(label);
    }
  });

  it('solo el status 4 cuenta como depósito', () => {
    expect(PAYPROS_DEPOSIT_STATUS).toBe(4);
    for (const code of [1, 2, 4, 5, 6, 7]) {
      const parsed = parseOutgoing(makeBody(['2026-01-15T10:00:00', 'n', 'u', '5', 'USD', String(code)]))!;
      expect(isDeposit(parsed)).toBe(code === 4);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Balance (GET v2/getBalance)
//
// No conocemos el shape real de la respuesta, así que el parser es defensivo:
// acepta varias formas plausibles y, ante cualquier otra, devuelve error con
// el crudo en vez de inventar un saldo. Estos tests fijan ese contrato: si
// mañana Pay-Pros manda algo distinto, tiene que fallar RUIDOSO, no en cero.
// ─────────────────────────────────────────────────────────────────────────────

/** Respuesta HTTP mínima con el cuerpo JSON indicado. */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: '',
    text: async () => text,
  } as unknown as Response;
}

const ENVELOPE = { status: 'E00', response: 'OK', datetime: '2026-08-16 10:00:00' };

describe('parsePayprosBalance', () => {
  it('FORMATO REAL de prod: "balaces" (typo de Pay-Pros) con available_balance', () => {
    // Payload literal de la primera llamada real (Vex Pro, 2026-08-16). La
    // clave viene mal escrita del lado de Pay-Pros — NO "corregirla" acá:
    // si el parser exige "balances", el balance vuelve a salir irreconocible.
    const real = {
      status: 'E00',
      response: 'OK',
      datetime: '2026-08-16T16:00:35.000Z',
      balaces: [{ currency: 'USD', available_balance: 6073 }],
    };
    expect(parsePayprosBalance(real)).toEqual({ balance: 6073, currency: 'USD' });
  });

  it('acepta también "balances" bien escrito, por si Pay-Pros lo corrige', () => {
    expect(parsePayprosBalance({ ...ENVELOPE, balances: [{ currency: 'USD', available_balance: '12.5' }] }))
      .toEqual({ balance: 12.5, currency: 'USD' });
  });

  it('acepta balance escalar', () => {
    expect(parsePayprosBalance({ ...ENVELOPE, balance: 1234.56, currency: 'usd' }))
      .toEqual({ balance: 1234.56, currency: 'USD' });
  });

  it('acepta balance como objeto con available/amount', () => {
    expect(parsePayprosBalance({ ...ENVELOPE, balance: { available: 900, currency: 'PEN' } }))
      .toEqual({ balance: 900, currency: 'PEN' });
    expect(parsePayprosBalance({ ...ENVELOPE, balance: { amount: '750.25' } }))
      .toEqual({ balance: 750.25, currency: null });
  });

  it('acepta available en la raíz', () => {
    expect(parsePayprosBalance({ ...ENVELOPE, available: 42, currency: 'USD' }))
      .toEqual({ balance: 42, currency: 'USD' });
  });

  it('acepta la lista balances[] y se queda con la primera entrada', () => {
    expect(
      parsePayprosBalance({
        ...ENVELOPE,
        balances: [{ currency: 'usd', amount: '10500.10' }, { currency: 'PEN', amount: 5 }],
      }),
    ).toEqual({ balance: 10500.1, currency: 'USD' });
  });

  it('acepta amount en la raíz como último recurso', () => {
    expect(parsePayprosBalance({ ...ENVELOPE, amount: 7 })).toEqual({ balance: 7, currency: null });
  });

  it('devuelve null cuando no hay ningún número reconocible', () => {
    expect(parsePayprosBalance({ ...ENVELOPE, wallet: { saldo_total: 100 } })).toBeNull();
    expect(parsePayprosBalance({ ...ENVELOPE, balance: 'no-es-un-numero' })).toBeNull();
    expect(parsePayprosBalance(null)).toBeNull();
  });
});

describe('fetchPayprosBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreds.mockResolvedValue({
      merchantId: 'M123',
      apiKey: 'api-key',
      signKey: 'sign-key',
      baseUrl: 'https://master-api.pay-pros.com/',
    });
  });

  it('sin credenciales no llama a la API y marca not_configured', async () => {
    mockCreds.mockResolvedValue(null);
    const res = await fetchPayprosBalance('empresa-1');
    expect(res).toEqual({
      balance: null,
      currency: null,
      isMock: false,
      error: 'not_configured',
      notConfigured: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('pega a {base}v2/getBalance con Basic auth y User-Agent', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ...ENVELOPE, balance: 100 }));
    const res = await fetchPayprosBalance('empresa-1');

    expect(res.balance).toBe(100);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://master-api.pay-pros.com/v2/getBalance');
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('M123:api-key').toString('base64')}`,
    );
    expect(headers['User-Agent']).toContain('SmartDashboard');
  });

  it('no duplica la barra cuando el base_url del tenant no la trae', async () => {
    mockCreds.mockResolvedValue({
      merchantId: 'M123', apiKey: 'k', signKey: 's', baseUrl: 'https://sb.pay-pros.com',
    });
    mockFetch.mockResolvedValue(jsonResponse({ ...ENVELOPE, balance: 1 }));
    await fetchPayprosBalance('empresa-1');
    expect(mockFetch.mock.calls[0][0]).toBe('https://sb.pay-pros.com/v2/getBalance');
  });

  it('un status distinto de E00 es error, no un balance', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'E03', response: 'Invalid IP' }));
    const res = await fetchPayprosBalance('empresa-1');
    expect(res.balance).toBeNull();
    expect(res.error).toContain('status=E03');
    expect(res.error).toContain('response=Invalid IP');
    expect(res.raw).toMatchObject({ status: 'E03' });
  });

  it('shape desconocido → error con el crudo, nunca un saldo inventado', async () => {
    const body = { ...ENVELOPE, wallet: { saldo_total: '999' } };
    mockFetch.mockResolvedValue(jsonResponse(body));
    const res = await fetchPayprosBalance('empresa-1');

    expect(res.balance).toBeNull();
    expect(res.error).toContain('no contiene un balance reconocible');
    expect(res.error).toContain('saldo_total');   // el crudo va en el mensaje
    expect(res.raw).toEqual(body);
  });

  it('respuesta que no es JSON → error con el snippet', async () => {
    mockFetch.mockResolvedValue(jsonResponse('<html>403 Forbidden</html>'));
    const res = await fetchPayprosBalance('empresa-1');
    expect(res.balance).toBeNull();
    expect(res.error).toContain('no es JSON');
  });

  it('HTTP no-OK termina en error (y no rompe el cron)', async () => {
    mockFetch.mockResolvedValue(jsonResponse('IP not allowed', { ok: false, status: 403 }));
    const res = await fetchPayprosBalance('empresa-1');
    expect(res.balance).toBeNull();
    expect(res.error).toContain('403');
  });
});
