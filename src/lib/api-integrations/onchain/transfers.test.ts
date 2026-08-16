// ─────────────────────────────────────────────────────────────────────────────
// Historial de transferencias on-chain (migración 085).
//
// Lo que más importa acá no es el parseo: es que estas transferencias NUNCA
// entren a Net Deposit. Son tesorería propia (mover plata entre wallets de la
// empresa, pagar gastos) y viven en la misma tabla de la que sale el Net
// Deposit de clientes. Ver el último describe.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ONCHAIN_PROVIDER,
  ONCHAIN_STATUS,
  fetchOnchainTransfers,
  parseExplorerTransfers,
  parseTronTransfers,
  toApiTransactionRow,
} from './transfers';

const TRON_ADDR = 'TEkSDmWk3KMxSeSK9ogefYkhEEnVtZVTkJ';
const OTHER_TRON = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const EVM_ADDR = '0x321814ca95a24348551239466d778e2fc93539c9';
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const mockFetch = vi.fn();
beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BSCSCAN_API_KEY;
});

// ── Tron ────────────────────────────────────────────────────────────────────

const TRON_PAGE = {
  data: [
    {
      transaction_id: 'aa11',
      from: OTHER_TRON,
      to: TRON_ADDR,
      value: '1500000000', // 1.500 USDT
      block_timestamp: 1_755_000_000_000,
      token_info: { address: USDT_TRON, decimals: 6, symbol: 'USDT' },
    },
    {
      transaction_id: 'bb22',
      from: TRON_ADDR,
      to: OTHER_TRON,
      value: '561000000', // 561 USDT — un pago de gastos
      block_timestamp: 1_755_086_400_000,
      token_info: { address: USDT_TRON, decimals: 6, symbol: 'USDT' },
    },
  ],
  meta: { fingerprint: 'PAGE2' },
};

describe('parseTronTransfers', () => {
  it('decide el sentido contra la dirección consultada', () => {
    const { transfers } = parseTronTransfers(TRON_PAGE, TRON_ADDR);
    expect(transfers.map((t) => t.direction)).toEqual(['in', 'out']);
    expect(transfers[0].amount).toBe(1500);
    expect(transfers[1].amount).toBe(561);
    expect(transfers[0].at).toBe(new Date(1_755_000_000_000).toISOString());
  });

  it('descarta cualquier token que no sea USDT', () => {
    const { transfers } = parseTronTransfers(
      {
        data: [
          {
            transaction_id: 'cc33',
            from: OTHER_TRON,
            to: TRON_ADDR,
            value: '1000000',
            block_timestamp: 1_755_000_000_000,
            token_info: { address: 'TOtroContrato', symbol: 'SHIB' },
          },
        ],
      },
      TRON_ADDR,
    );
    expect(transfers).toHaveLength(0);
  });

  it('descarta una transferencia entre terceros (no toca esta wallet)', () => {
    const { transfers } = parseTronTransfers(
      {
        data: [
          {
            transaction_id: 'dd44',
            from: OTHER_TRON,
            to: OTHER_TRON,
            value: '1000000',
            block_timestamp: 1_755_000_000_000,
            token_info: { address: USDT_TRON },
          },
        ],
      },
      TRON_ADDR,
    );
    expect(transfers).toHaveLength(0);
  });

  it('devuelve el fingerprint para pedir la página siguiente', () => {
    expect(parseTronTransfers(TRON_PAGE, TRON_ADDR).fingerprint).toBe('PAGE2');
  });

  it('el externalId distingue entrada de salida del mismo hash', () => {
    const { transfers } = parseTronTransfers(
      {
        data: [
          {
            transaction_id: 'ee55',
            from: TRON_ADDR,
            to: TRON_ADDR,
            value: '1000000',
            block_timestamp: 1_755_000_000_000,
            token_info: { address: USDT_TRON },
          },
        ],
      },
      TRON_ADDR,
    );
    expect(transfers[0].externalId).toContain('tron:ee55:');
  });
});

describe('fetchOnchainTransfers (Tron)', () => {
  it('trae la primera página y corta cuando no hay más', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(TRON_PAGE))
      .mockResolvedValueOnce(jsonResponse({ data: [], meta: {} }));
    const res = await fetchOnchainTransfers('tron', TRON_ADDR, 0);
    expect(res.error).toBeUndefined();
    expect(res.transfers).toHaveLength(2);
  });

  it('un error de TronGrid no lanza: viaja en el resultado', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('rate limited', false, 429));
    const res = await fetchOnchainTransfers('tron', TRON_ADDR, 0);
    expect(res.error).toMatch(/TronGrid trc20 429/);
  });
});

// ── BSC / Ethereum ──────────────────────────────────────────────────────────

describe('fetchOnchainTransfers (EVM)', () => {
  it('sin API key del explorador queda SIN historial, pero no es una falla', async () => {
    const res = await fetchOnchainTransfers('bsc', EVM_ADDR, 0);
    expect(res.unsupported).toBe(true);
    expect(res.transfers).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('con API key usa el explorador', async () => {
    process.env.BSCSCAN_API_KEY = 'k';
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: '1',
        result: [
          {
            hash: '0xabc',
            from: EVM_ADDR,
            to: '0x1111111111111111111111111111111111111111',
            value: '1400000000000000',
            timeStamp: '1755000000',
            contractAddress: '0x55d398326f99059ff775485246999027b3197955',
            logIndex: '3',
          },
        ],
      }),
    );
    const res = await fetchOnchainTransfers('bsc', EVM_ADDR, 0);
    expect(res.transfers).toHaveLength(1);
    expect(res.transfers[0]).toMatchObject({ direction: 'out', network: 'bsc' });
    expect(res.transfers[0].amount).toBeCloseTo(0.0014, 10);
  });
});

describe('parseExplorerTransfers', () => {
  it('"No transactions found" es una wallet nueva, no un error', () => {
    const res = parseExplorerTransfers(
      { status: '0', message: 'No transactions found', result: 'No transactions found' },
      'bsc',
      EVM_ADDR,
    );
    expect(res.error).toBeUndefined();
    expect(res.transfers).toHaveLength(0);
  });

  it('ERC20 usa 6 decimales aunque BEP20 use 18', () => {
    const row = {
      hash: '0xdef',
      from: '0x2222222222222222222222222222222222222222',
      to: EVM_ADDR,
      value: '1000000',
      timeStamp: '1755000000',
      contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      logIndex: '0',
    };
    const res = parseExplorerTransfers({ status: '1', result: [row] }, 'ethereum', EVM_ADDR);
    expect(res.transfers[0].amount).toBe(1);
    expect(res.transfers[0].direction).toBe('in');
  });
});

// ── Persistencia ────────────────────────────────────────────────────────────

describe('toApiTransactionRow', () => {
  const transfer = {
    network: 'tron' as const,
    hash: 'aa11',
    from: OTHER_TRON,
    to: TRON_ADDR,
    raw: '1500000000',
    amount: 1500,
    at: '2026-08-17T00:00:00.000Z',
    direction: 'in' as const,
    externalId: 'tron:aa11:in',
  };

  it('guarda la CLAVE DEL CANAL en wallet_id — de ahí agrupa la RPC del libro', () => {
    const row = toApiTransactionRow('co-1', 'wallet_externa', transfer);
    expect(row.wallet_id).toBe('wallet_externa');
    expect(row.wallet_label).toBe('tron');
    expect(row.provider).toBe(ONCHAIN_PROVIDER);
    expect(row.status).toBe(ONCHAIN_STATUS.in);
  });

  it('marca la fila como INTERNA: es tesorería propia, no plata de clientes', () => {
    expect(toApiTransactionRow('co-1', 'wallet_externa', transfer).internal).toBe(true);
  });

  it('una salida se guarda con el status de salida', () => {
    const row = toApiTransactionRow('co-1', 'wallet_externa', {
      ...transfer,
      direction: 'out',
    });
    expect(row.status).toBe(ONCHAIN_STATUS.out);
  });
});

// ── LA REGLA DE ORO ─────────────────────────────────────────────────────────
//
// Estas filas viven en api_transactions, que es la tabla de la que sale Net
// Deposit. Los cuatro agregadores whitelistean los providers que aceptan, así
// que 'onchain-usdt' queda afuera — pero eso es un acuerdo tácito repartido en
// cuatro archivos, y este test es lo que lo vuelve explícito: si alguien
// agrega el provider a cualquiera de esas listas, se entera acá y no cuando el
// Net Deposit del mes salga con $17.000 de más.

describe('las transferencias on-chain no entran a Net Deposit', () => {
  const NET_DEPOSIT_PROVIDERS = [
    'coinsbuy-deposits',
    'coinsbuy-withdrawals',
    'fairpay',
    'unipayment',
    'paypros',
  ];

  it('el provider on-chain no es ninguno de los que suman a Net Deposit', () => {
    expect(NET_DEPOSIT_PROVIDERS).not.toContain(ONCHAIN_PROVIDER);
  });

  it('sus status tampoco chocan con los de esos providers', () => {
    // loadPersistedTotals y reports/data.ts filtran por status DENTRO de cada
    // provider; que además sean nombres propios evita cualquier colisión si
    // algún día alguien agrupa por status en vez de por provider.
    const OTHER_STATUSES = ['Confirmed', 'Approved', 'Completed', 'paid', 'payout_paid'];
    expect(OTHER_STATUSES).not.toContain(ONCHAIN_STATUS.in);
    expect(OTHER_STATUSES).not.toContain(ONCHAIN_STATUS.out);
  });
});
