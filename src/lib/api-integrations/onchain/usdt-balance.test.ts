// ─────────────────────────────────────────────────────────────────────────────
// Lectura de saldos on-chain (migración 085).
//
// Todo con `fetch` mockeado: estos endpoints son públicos y con cuota, y un
// test que salga a la red daría distinto cada día. Los fixtures son la forma
// REAL de cada respuesta, verificada contra la wallet de Vex Pro el 2026-08-17.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ONCHAIN_ASSETS,
  encodeBalanceOf,
  fetchNetworkBalance,
  fetchOnchainTotal,
  fetchUsdtBalance,
  parseEvmHexBalance,
  parseTronNativeRaw,
  parseTronUsdtRaw,
  rawToAmount,
} from './usdt-balance';

// Direcciones reales de la Trust Wallet de Vex Pro (son públicas).
const TRON_ADDR = 'TEkSDmWk3KMxSeSK9ogefYkhEEnVtZVTkJ';
const EVM_ADDR = '0x321814ca95a24348551239466d778e2fc93539c9';

/** Respuesta de TronGrid: 17.051,70 USDT y 220,88 TRX. */
const TRON_ACCOUNT = {
  data: [
    {
      balance: 220_880_000, // sun → 220,88 TRX
      trc20: [
        { TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: '17051700000' },
        { TAnotherTokenContractAddress0000000: '5000000' },
      ],
    },
  ],
  success: true,
  meta: { at: 1_755_000_000_000, page_size: 1 },
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const mockFetch = vi.fn();

// balanceOf(USDT) del contrato para TRON_ADDR: 17.051,70 USDT. Desde el
// 2026-09-04 el USDT de Tron se lee acá y NO en `data[0].trc20` (cuentas
// GasFree sin activar: la cuenta no existe pero el contrato sí las conoce).
const TRON_BALANCEOF = { constant_result: ['00000000000000000000000000000000000000000000000000000003f85c4b20'], result: { result: true } };

/** Enruta por URL/cuerpo en vez de por orden: las redes se leen en paralelo. */
function routeFetch(routes: { tronContract?: Response; tronAccount?: Response; evmCall?: Response; evmNative?: Response }) {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/wallet/triggerconstantcontract')) return routes.tronContract ?? jsonResponse(TRON_BALANCEOF);
    if (u.includes('/v1/accounts/')) return routes.tronAccount ?? jsonResponse(TRON_ACCOUNT);
    const body = typeof init?.body === 'string' ? init.body : '';
    if (body.includes('eth_getBalance')) return routes.evmNative ?? jsonResponse({ result: '0x0' });
    return routes.evmCall ?? jsonResponse({ result: '0x0' });
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  vi.stubEnv('TRONGRID_MIN_INTERVAL_MS', '0'); // sin freno en tests
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers puros ───────────────────────────────────────────────────────────

describe('rawToAmount', () => {
  it('no pierde precisión con 18 decimales (el saldo crudo supera 2^53)', () => {
    // 1.400.000.000.000 wei = 0,0000014 BNB — el caso que rompe Number/1e18.
    expect(rawToAmount(BigInt('1400000000000'), 18)).toBeCloseTo(0.0000014, 12);
    expect(rawToAmount(BigInt('1400000000000000'), 18)).toBeCloseTo(0.0014, 12);
  });

  it('aplica 6 decimales para TRC20/ERC20', () => {
    expect(rawToAmount(BigInt('17051700000'), 6)).toBe(17051.7);
  });

  it('devuelve 0 sin inventar decimales', () => {
    expect(rawToAmount(BigInt(0), 18)).toBe(0);
  });
});

describe('encodeBalanceOf', () => {
  it('arma el calldata con la dirección rellenada a 32 bytes', () => {
    const data = encodeBalanceOf(EVM_ADDR);
    expect(data.startsWith('0x70a08231')).toBe(true);
    expect(data).toHaveLength(10 + 64);
    expect(data.endsWith(EVM_ADDR.slice(2))).toBe(true);
  });
});

describe('parseTronUsdtRaw', () => {
  it('encuentra el contrato de USDT dentro del array de tokens', () => {
    expect(parseTronUsdtRaw(TRON_ACCOUNT)).toBe(BigInt('17051700000'));
  });

  it('una cuenta con otros tokens pero sin USDT vale 0, no error', () => {
    expect(parseTronUsdtRaw({ data: [{ trc20: [{ TOtro: '9' }] }] })).toBe(BigInt(0));
  });

  it('una cuenta inexistente vale 0, no error', () => {
    expect(parseTronUsdtRaw({ data: [] })).toBe(BigInt(0));
  });

  it('una respuesta que no es la esperada devuelve null (no un saldo inventado)', () => {
    expect(parseTronUsdtRaw({ ok: true })).toBeNull();
    expect(parseTronUsdtRaw('<html>')).toBeNull();
  });
});

describe('parseTronNativeRaw', () => {
  it('lee el saldo nativo en sun', () => {
    expect(parseTronNativeRaw(TRON_ACCOUNT)).toBe(BigInt(220_880_000));
  });

  it('sin campo balance la cuenta tiene 0 TRX', () => {
    expect(parseTronNativeRaw({ data: [{ trc20: [] }] })).toBe(BigInt(0));
  });
});

describe('parseEvmHexBalance', () => {
  it("'0x' pelado es 0: el contrato nunca vio esa dirección", () => {
    expect(parseEvmHexBalance('0x')).toBe(BigInt(0));
  });

  it('convierte el hex a unidades crudas', () => {
    expect(parseEvmHexBalance('0x4fb84201f00')).toBe(BigInt('5478300000000'));
  });

  it('rechaza cualquier cosa que no sea hex', () => {
    expect(parseEvmHexBalance('<!DOCTYPE html>')).toBeNull();
    expect(parseEvmHexBalance(undefined)).toBeNull();
  });
});

// ── fetchUsdtBalance ────────────────────────────────────────────────────────

describe('fetchUsdtBalance', () => {
  it('lee el saldo TRC20 real (por el contrato, no por la cuenta)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(TRON_BALANCEOF));
    const res = await fetchUsdtBalance('tron', TRON_ADDR);
    expect(String(mockFetch.mock.calls[0][0])).toContain('/wallet/triggerconstantcontract');
    expect(res).toMatchObject({ balance: 17051.7, raw: '17051700000', source: 'trongrid' });
  });

  it('lee el saldo BEP20 con 18 decimales', async () => {
    // 0,0014 USDT en BSC = 1.4e15 unidades crudas.
    mockFetch.mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x4f94ae6af8000' }));
    const res = await fetchUsdtBalance('bsc', EVM_ADDR);
    expect('balance' in res && res.balance).toBeCloseTo(0.0014, 10);
  });

  it('lee el saldo ERC20 con 6 decimales (NO 18 como BSC)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ result: '0x' }));
    const res = await fetchUsdtBalance('ethereum', EVM_ADDR);
    expect(res).toMatchObject({ balance: 0, source: 'eth-rpc' });
    expect(ONCHAIN_ASSETS.ethereum.decimals).toBe(6);
  });

  it('NO llama a la red con una dirección inválida', async () => {
    const res = await fetchUsdtBalance('tron', '0xabc');
    expect('error' in res && res.error).toMatch(/Tron inválida/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('un HTML del RPC es error, no un saldo 0', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('<!DOCTYPE html><html>', true));
    const res = await fetchUsdtBalance('ethereum', EVM_ADDR);
    expect('error' in res && res.error).toMatch(/no es JSON/);
  });

  it('un error JSON-RPC con HTTP 200 es error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: { code: -32000, message: 'nope' } }));
    const res = await fetchUsdtBalance('bsc', EVM_ADDR);
    expect('error' in res && res.error).toMatch(/RPC bsc error/);
  });

  it('un timeout se reporta como timeout y no tumba al caller', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    mockFetch.mockRejectedValueOnce(err);
    const res = await fetchUsdtBalance('tron', TRON_ADDR);
    expect('error' in res && res.error).toMatch(/Timeout/);
  });

  it('un 404 de TronGrid es error con el cuerpo recortado', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('not found', false, 404));
    const res = await fetchUsdtBalance('tron', TRON_ADDR);
    expect('error' in res && res.error).toMatch(/TronGrid 404/);
  });
});

// ── fetchNetworkBalance: token + gas ────────────────────────────────────────

describe('fetchNetworkBalance', () => {
  it('Tron necesita dos llamadas: balanceOf del contrato y la cuenta para el TRX', async () => {
    routeFetch({});
    const res = await fetchNetworkBalance('tron', TRON_ADDR);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({
      usdt: 17051.7,
      native: { symbol: 'TRX', amount: 220.88 },
    });
  });

  it('EVM necesita dos llamadas: balanceOf y eth_getBalance', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ result: '0x4f94ae6af8000' })) // USDT 0,0014
      .mockResolvedValueOnce(jsonResponse({ result: '0x1f9e80ba804000' })); // BNB 0,0089
    const res = await fetchNetworkBalance('bsc', EVM_ADDR);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect('native' in res && res.native.symbol).toBe('BNB');
    expect('native' in res && res.native.amount).toBeCloseTo(0.0089, 8);
  });

  it('si falla el gas, NO devuelve el token solo (sería tapar una lectura rota)', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ result: '0x4f94ae6af8000' }))
      .mockResolvedValueOnce(jsonResponse('boom', false, 500));
    const res = await fetchNetworkBalance('bsc', EVM_ADDR);
    expect('error' in res && res.error).toMatch(/RPC bsc 500/);
  });
});

// ── fetchOnchainTotal: la suma de la ubicación ──────────────────────────────

describe('fetchOnchainTotal', () => {
  const wallets = [
    { network: 'tron' as const, address: TRON_ADDR },
    { network: 'bsc' as const, address: EVM_ADDR },
  ];
  const prices = { TRX: 0.331, BNB: 603, ETH: 2400 };

  it('suma USDT + gas valuado de todas las redes', async () => {
    routeFetch({
      evmCall: jsonResponse({ result: '0x4f94ae6af8000' }), // bsc USDT 0,0014
      evmNative: jsonResponse({ result: '0x1f9e80ba804000' }), // bsc BNB 0,0089
    }); // tron: 17051,70 + 220,88 TRX

    const res = await fetchOnchainTotal(wallets, { prices, priceAt: '2026-08-17T00:00:00Z' });
    expect(res.error).toBeUndefined();
    // 17.051,70 + (220,88 TRX × 0,331 = 73,11) + 0,0014 + (0,0089 BNB × 603 = 5,37)
    expect(res.total).toBeCloseTo(17_130.18, 1);
    expect(res.breakdown).toHaveLength(2);
    expect(res.breakdown[0].native).toMatchObject({ symbol: 'TRX', priceUsd: 0.331 });
    expect(res.priceAt).toBe('2026-08-17T00:00:00Z');
  });

  it('FAIL-CLOSED: si una red falla no devuelve el total de las otras', async () => {
    routeFetch({ evmCall: jsonResponse('gateway timeout', false, 504) });

    const res = await fetchOnchainTotal(wallets, { prices });
    expect(res.total).toBeUndefined();
    expect(res.error).toMatch(/No se pudo leer 1 de 2/);
    // El desglose de lo que SÍ se pudo leer viaja igual, para diagnosticar.
    expect(res.breakdown).toHaveLength(1);
  });

  it('sin precio, un polvo de gas se cuenta 0 y no bloquea el canal', async () => {
    routeFetch({
      tronContract: jsonResponse({ constant_result: [(5_000_000).toString(16).padStart(64, '0')] }),
      tronAccount: jsonResponse({ data: [{ balance: 1_000_000, trc20: [{ [ONCHAIN_ASSETS.tron.contract]: '5000000' }] }] }),
    });
    const res = await fetchOnchainTotal([wallets[0]], { prices: {} });
    expect(res.error).toBeUndefined();
    expect(res.total).toBe(5); // 5 USDT; 1 TRX sin precio → 0
    expect(res.breakdown[0].native.priceUsd).toBeNull();
  });

  it('sin precio y con gas RELEVANTE falla cerrado: no se valúa a ciegas', async () => {
    routeFetch({}); // 220,88 TRX
    const res = await fetchOnchainTotal([wallets[0]], { prices: {} });
    expect(res.total).toBeUndefined();
    expect(res.error).toMatch(/sin precio para 220.88 TRX/);
  });

  it('una ubicación sin direcciones es un error de configuración, no un 0', async () => {
    const res = await fetchOnchainTotal([]);
    expect(res.error).toMatch(/no tiene direcciones/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});


describe('Tron: USDT por el contrato (cuentas GasFree sin activar)', () => {
  it('decodifica base58check a los 20 bytes hex (vector real)', async () => {
    const { tronBase58ToHex20 } = await import('./usdt-balance');
    expect(tronBase58ToHex20('TMwSxJMjdPJzKXpdqrr69gfPawQ3sK5GaV')).toBe(
      '834c530af3aefc74aa31195ad2e6e2814a6f43e2',
    );
    expect(tronBase58ToHex20('0x321814ca95a24348551239466d778e2fc93539c9')).toBeNull();
  });

  it('una cuenta que NO existe para /v1/accounts pero tiene USDT en el contrato NO da 0', async () => {
    // El caso real del 2026-09-04: data: [] y 29.938,57 USDT en el contrato.
    routeFetch({
      tronContract: jsonResponse({ constant_result: [(29_938_570_000).toString(16).padStart(64, '0')] }),
      tronAccount: jsonResponse({ data: [], success: true }),
    });
    const res = await fetchNetworkBalance('tron', 'TMwSxJMjdPJzKXpdqrr69gfPawQ3sK5GaV');
    expect(res).toMatchObject({ usdt: 29938.57, native: { symbol: 'TRX', amount: 0 } });
  });

  it('constant_result ilegible es error, no 0', async () => {
    const { parseTronConstantResult } = await import('./usdt-balance');
    expect(parseTronConstantResult({ constant_result: ['zz'] })).toBeNull();
    expect(parseTronConstantResult({})).toBeNull();
    expect(parseTronConstantResult({ constant_result: [''] })).toBe(BigInt(0));
  });
});
