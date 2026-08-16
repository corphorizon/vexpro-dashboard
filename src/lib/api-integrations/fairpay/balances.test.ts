// ─────────────────────────────────────────────────────────────────────────────
// FairPay Banking — canje de token + balance real.
//
// Lo que protegen estos tests es plata: el número que sale de acá se asienta
// como el saldo del canal 'fairpay' en el snapshot diario. Un parseo flojo
// (balance string, 4 cuentas de 2 monedas) asienta un total inventado.
//
// Se mockea `fetch` global y el resolver de credenciales: ni una llamada real
// al banking ni una lectura de la DB de producción.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../credentials')>();
  return {
    ...actual,
    resolveFairpayBankingCredentials: vi.fn(),
  };
});

// El admin client sólo se usa para leer companies.currency; en test devuelve USD.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { currency: 'USD' }, error: null }),
        }),
      }),
    }),
  }),
}));

import { resolveFairpayBankingCredentials } from '../credentials';
import {
  getFairpayBankingToken,
  isFairpayBankingEnabled,
  getFairpayBankingBaseUrl,
  __clearFairpayBankingTokenCache,
  FAIRPAY_BANKING_USER_AGENT,
} from './banking-auth';
import {
  fetchFairpayBalances,
  parseFairpayAccount,
  extractAccountList,
  selectFairpayAccount,
  type FairpayBalanceEntry,
} from './balances';

const mockCreds = vi.mocked(resolveFairpayBankingCredentials);

const COMPANY = '11111111-1111-1111-1111-111111111111';
const BASE = 'https://banking.fairpay.online';
// JWT de mentira, pero con los 3 segmentos que el banking exige.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.firma-de-prueba';

/** Respuesta REAL de prod (2026-08-17, Vex Pro): 4 cuentas, balance string. */
const REAL_ACCOUNTS = [
  {
    id: 26713,
    account_number: 'FP20227709',
    account_type: 'Personal Account',
    currency: 'EUR',
    balance: '12.50',
    status: 1,
    opening_balance: '0.00',
  },
  {
    id: 26714,
    account_number: 'FP20227710',
    account_type: 'Personal Account',
    currency: 'USD',
    balance: '99.99',
    status: 1,
    opening_balance: '0.00',
  },
  {
    id: 26715,
    account_number: 'FP20227711',
    account_type: 'Corporate Account',
    currency: 'EUR',
    balance: '77.00',
    status: 1,
    opening_balance: '0.00',
  },
  {
    id: 26716,
    account_number: 'FP20227712',
    account_type: 'Corporate Account',
    currency: 'USD',
    balance: '0.00',
    status: 1,
    opening_balance: '0.00',
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __clearFairpayBankingTokenCache();
  mockCreds.mockReset();
  mockCreds.mockResolvedValue({ apiKey: 'api-key-de-prueba', baseUrl: BASE });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Responde SIEMPRE lo mismo, pero con un `Response` nuevo cada vez: el cuerpo
 * de un Response se consume una sola vez, así que reusar el objeto haría
 * fallar la segunda llamada con "no es JSON" en vez de con lo que se testea.
 */
function respondAlways(body: unknown, status = 200) {
  fetchMock.mockImplementation(async () => jsonResponse(body, status));
}

/** Encola: 1º el canje de token, 2º la respuesta de /api/v1/accounts. */
function stubTokenThenAccounts(accountsBody: unknown, accountsStatus = 200) {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ result: true, access_token: JWT }))
    .mockResolvedValueOnce(jsonResponse(accountsBody, accountsStatus));
}

// ── banking-auth ────────────────────────────────────────────────────────────

describe('getFairpayBankingToken', () => {
  it('canjea la api_key por el JWT y lo cachea (una sola llamada de red)', async () => {
    respondAlways({ result: true, access_token: JWT });

    const first = await getFairpayBankingToken(COMPANY);
    const second = await getFairpayBankingToken(COMPANY);

    expect(first).toBe(JWT);
    expect(second).toBe(JWT);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/auth/getAccessToken`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('api_key=api-key-de-prueba');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // Sin UA de navegador el banking devuelve 403 antes de llegar a la app.
    expect(init.headers['User-Agent']).toBe(FAIRPAY_BANKING_USER_AGENT);
  });

  it('cachea por tenant: otra empresa vuelve a canjear', async () => {
    respondAlways({ result: true, access_token: JWT });
    await getFairpayBankingToken(COMPANY);
    await getFairpayBankingToken('22222222-2222-2222-2222-222222222222');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rechaza un token que no tiene 3 segmentos (el banking lo rechazaría con 401)', async () => {
    respondAlways({ result: true, access_token: 'api-key-cruda' });
    await expect(getFairpayBankingToken(COMPANY)).rejects.toThrow(/JWT \(3 segmentos\)/);
  });

  it('no cachea el token inválido: el siguiente intento vuelve a pedirlo', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: true, access_token: 'nope' }));
    await expect(getFairpayBankingToken(COMPANY)).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: true, access_token: JWT }));
    await expect(getFairpayBankingToken(COMPANY)).resolves.toBe(JWT);
  });

  it('propaga result=false con su mensaje y no vuelca la api_key', async () => {
    respondAlways({ result: false, message: 'Invalid API key' });
    await expect(getFairpayBankingToken(COMPANY)).rejects.toThrow(/Invalid API key/);
    await expect(getFairpayBankingToken(COMPANY)).rejects.not.toThrow(/api-key-de-prueba/);
  });

  it('sin credencial lanza un error descriptivo y no llama a la red', async () => {
    mockCreds.mockResolvedValue(null);
    await expect(getFairpayBankingToken(COMPANY)).rejects.toThrow(/no está configurado/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('isFairpayBankingEnabled / getFairpayBankingBaseUrl', () => {
  it('refleja la presencia de la credencial', async () => {
    await expect(isFairpayBankingEnabled(COMPANY)).resolves.toBe(true);
    mockCreds.mockResolvedValue(null);
    await expect(isFairpayBankingEnabled(COMPANY)).resolves.toBe(false);
  });

  it('cae al default cuando no hay credencial', async () => {
    mockCreds.mockResolvedValue(null);
    await expect(getFairpayBankingBaseUrl(COMPANY)).resolves.toBe(BASE);
  });
});

// ── Parseo puro ─────────────────────────────────────────────────────────────

describe('parseFairpayAccount', () => {
  it('convierte el balance string a número', () => {
    expect(parseFairpayAccount(REAL_ACCOUNTS[1])).toEqual({
      currency: 'USD',
      availableBalance: 99.99,
      accountNumber: 'FP20227710',
      accountType: 'Personal Account',
    });
  });

  it('acepta "0.00" como cero (no como ausencia de balance)', () => {
    expect(parseFairpayAccount(REAL_ACCOUNTS[3])?.availableBalance).toBe(0);
  });

  it('descarta filas sin balance numérico', () => {
    expect(parseFairpayAccount({ account_number: 'X', balance: 'n/a' })).toBeNull();
    expect(parseFairpayAccount({ account_number: 'X' })).toBeNull();
    expect(parseFairpayAccount('nope')).toBeNull();
  });
});

describe('extractAccountList', () => {
  it('acepta array directo (formato real) y {data:[…]}', () => {
    expect(extractAccountList(REAL_ACCOUNTS)).toHaveLength(4);
    expect(extractAccountList({ data: REAL_ACCOUNTS })).toHaveLength(4);
  });

  it('devuelve null ante un shape desconocido', () => {
    expect(extractAccountList({ result: true })).toBeNull();
    expect(extractAccountList('texto')).toBeNull();
  });
});

describe('selectFairpayAccount', () => {
  const parsed = REAL_ACCOUNTS.map(parseFairpayAccount).filter(
    (a): a is FairpayBalanceEntry => a !== null,
  );

  it('1º: Corporate en la moneda de la empresa', () => {
    expect(selectFairpayAccount(parsed, 'USD')?.accountNumber).toBe('FP20227712');
    expect(selectFairpayAccount(parsed, 'EUR')?.accountNumber).toBe('FP20227711');
  });

  it('2º: sin Corporate en esa moneda, la primera Corporate', () => {
    expect(selectFairpayAccount(parsed, 'GBP')?.accountNumber).toBe('FP20227711');
  });

  it('3º: sin ninguna Corporate, la primera en la moneda de la empresa', () => {
    const personales = parsed.filter((a) => a.accountType === 'Personal Account');
    expect(selectFairpayAccount(personales, 'USD')?.accountNumber).toBe('FP20227710');
  });

  it('4º: si nada califica, null (nunca "la primera que haya")', () => {
    const personales = parsed.filter((a) => a.accountType === 'Personal Account');
    expect(selectFairpayAccount(personales, 'GBP')).toBeNull();
  });
});

// ── fetchFairpayBalances ────────────────────────────────────────────────────

describe('fetchFairpayBalances', () => {
  it('sin credencial devuelve notConfigured y NO llama a la red', async () => {
    mockCreds.mockResolvedValue(null);
    const res = await fetchFairpayBalances(COMPANY);
    expect(res.notConfigured).toBe(true);
    expect(res.balances).toEqual([]);
    expect(res.error).toBe('FairPay Banking no está configurado para esta empresa');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('elige la Corporate USD (FP20227712) y devuelve UNA sola entrada', async () => {
    stubTokenThenAccounts(REAL_ACCOUNTS);
    const res = await fetchFairpayBalances(COMPANY);

    expect(res.error).toBeUndefined();
    // Una sola: el cron suma `balances` y con las 4 mezclaría EUR con USD.
    expect(res.balances).toHaveLength(1);
    expect(res.balances[0]).toMatchObject({
      accountNumber: 'FP20227712',
      currency: 'USD',
      availableBalance: 0,
    });
    expect(typeof res.balances[0].availableBalance).toBe('number');
    expect(res.otherAccounts).toHaveLength(3);
    // El total que asienta el cron.
    const total = res.balances.reduce((s, b) => s + (b.availableBalance ?? 0), 0);
    expect(total).toBe(0);
  });

  it('manda el Bearer y el User-Agent de navegador a /api/v1/accounts', async () => {
    stubTokenThenAccounts(REAL_ACCOUNTS);
    await fetchFairpayBalances(COMPANY);

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/api/v1/accounts`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(init.headers['User-Agent']).toBe(FAIRPAY_BANKING_USER_AGENT);
  });

  it('acepta el envoltorio {data:[…]}', async () => {
    stubTokenThenAccounts({ data: REAL_ACCOUNTS });
    const res = await fetchFairpayBalances(COMPANY);
    expect(res.balances[0]?.accountNumber).toBe('FP20227712');
  });

  it('shape desconocido → error con el crudo y sin balance', async () => {
    stubTokenThenAccounts({ result: true, cuentas: [] });
    const res = await fetchFairpayBalances(COMPANY);
    expect(res.balances).toEqual([]);
    expect(res.error).toMatch(/lista de cuentas reconocible/);
    expect(res.error).toMatch(/"cuentas"/);
  });

  it('HTTP no-OK → error con status y cuerpo truncado', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ result: true, access_token: JWT }))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    const res = await fetchFairpayBalances(COMPANY);
    expect(res.balances).toEqual([]);
    expect(res.error).toMatch(/403/);
  });

  it('lista vacía de cuentas → error, nunca un total 0 inventado', async () => {
    stubTokenThenAccounts([]);
    const res = await fetchFairpayBalances(COMPANY);
    expect(res.balances).toEqual([]);
    expect(res.error).toMatch(/ninguna cuenta trae un balance numérico/);
  });

  it('cuentas que no califican → error explícito, sin elegir al azar', async () => {
    stubTokenThenAccounts([
      { account_number: 'FP1', account_type: 'Personal Account', currency: 'EUR', balance: '5.00' },
    ]);
    const res = await fetchFairpayBalances(COMPANY);
    expect(res.balances).toEqual([]);
    expect(res.error).toMatch(/ninguna cuenta califica/);
    expect(res.otherAccounts).toHaveLength(1);
  });

  it('nunca marca endpointMissing (el endpoint real existe y está verificado)', async () => {
    stubTokenThenAccounts(REAL_ACCOUNTS);
    const res = await fetchFairpayBalances(COMPANY);
    expect(res.endpointMissing).toBeUndefined();
  });
});
