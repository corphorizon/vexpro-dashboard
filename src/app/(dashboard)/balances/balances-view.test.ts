// balances-view: agrupación por tipo, fuente, frescura, barra de distribución
// y conteo de excluidos. Lo que la tabla «Saldo por canal» decide sin dibujar.
import { describe, it, expect } from 'vitest';
import { LOCATION_TYPES, tallyCash } from '@/lib/cash-locations';
import {
  CHANNEL_GROUP_OF_TYPE,
  CHANNEL_GROUP_ORDER,
  buildChannelRow,
  channelFreshness,
  channelSourceKind,
  countChannels,
  distributionInputs,
  freshnessSummary,
  liquidSharePct,
  sortByGroup,
  type BalanceMeta,
  type RowSource,
} from './balances-view';

const loc = (over: Partial<RowSource> & Pick<RowSource, 'channel_key'>): RowSource => ({
  label: over.channel_key,
  location_type: 'wallet',
  holder: null,
  balance: 0,
  ...over,
});
const meta = (over: Partial<BalanceMeta> = {}): BalanceMeta => ({
  source: 'ledger',
  asOf: '2026-10-01',
  degraded: false,
  stale: false,
  ...over,
});

describe('agrupación por tipo', () => {
  it('todo tipo del catálogo tiene grupo, y todo grupo está en el orden', () => {
    for (const t of LOCATION_TYPES) {
      expect(CHANNEL_GROUP_ORDER).toContain(CHANNEL_GROUP_OF_TYPE[t]);
    }
  });

  it('pasarelas, wallets, bancos (con efectivo y trading), prestado y deudas', () => {
    const g = (location_type: string) => buildChannelRow(loc({ channel_key: 'x', location_type }), meta()).group;
    expect(g('gateway')).toBe('gateway');
    expect(g('wallet')).toBe('wallet');
    expect(g('bank')).toBe('bank');
    expect(g('cash')).toBe('bank');
    expect(g('trading')).toBe('bank');
    expect(g('loan')).toBe('lent');
    expect(g('debt')).toBe('debt');
    // Un tipo desconocido cae al default del catálogo (wallet), no a un grupo inventado.
    expect(g('raro')).toBe('wallet');
  });

  it('sortByGroup ordena por grupo y respeta el orden de entrada adentro', () => {
    const rows = [
      buildChannelRow(loc({ channel_key: 'banco', location_type: 'bank' }), meta()),
      buildChannelRow(loc({ channel_key: 'cb', location_type: 'gateway' }), meta()),
      buildChannelRow(loc({ channel_key: 'deuda', location_type: 'debt' }), meta()),
      buildChannelRow(loc({ channel_key: 'up', location_type: 'gateway' }), meta()),
      buildChannelRow(loc({ channel_key: 'trust', location_type: 'wallet' }), meta()),
    ];
    expect(sortByGroup(rows).map((r) => r.channelKey)).toEqual(['cb', 'up', 'trust', 'banco', 'deuda']);
  });
});

describe('fila', () => {
  it('una deuda suma con signo −; el saldo guardado queda positivo', () => {
    const r = buildChannelRow(loc({ channel_key: 'd', location_type: 'debt', balance: 10_000 }), meta());
    expect(r.balance).toBe(10_000);
    expect(r.signed).toBe(-10_000);
    expect(r.liquid).toBe(false);
  });

  it('sin dato → signed null, nunca 0', () => {
    const r = buildChannelRow(loc({ channel_key: 'x', balance: 0 }), meta({ source: 'missing', asOf: null }));
    expect(r.freshness).toBe('missing');
    expect(r.signed).toBeNull();
  });

  it('un 0 del libro ES un dato', () => {
    const r = buildChannelRow(loc({ channel_key: 'x', balance: 0 }), meta());
    expect(r.signed).toBe(0);
    expect(r.freshness).toBe('fresh');
  });

  it('vista por unidad: clave única por unidad y porción', () => {
    const r = buildChannelRow(
      loc({ channel_key: 'trust', balance: 50, share: 0.5, fullBalance: 100 }),
      meta(),
      'u1',
    );
    expect(r.rowKey).toBe('u1:trust');
    expect(r.share).toBe(0.5);
    expect(r.fullBalance).toBe(100);
  });
});

describe('fuente y frescura', () => {
  it('API / On-chain / Manual / Calculado', () => {
    expect(channelSourceKind({ channel_key: 'coinsbuy' })).toBe('api');
    expect(
      channelSourceKind({ channel_key: 'wallet_externa', onchain_wallets: [{ network: 'tron', address: 'T' + 'a'.repeat(33) }] }),
    ).toBe('onchain');
    expect(channelSourceKind({ channel_key: 'custom_1' })).toBe('manual');
    expect(channelSourceKind({ channel_key: 'liquidez' }, 'computed')).toBe('computed');
  });

  it('missing gana sobre degradado; degradado sobre viejo; en vivo', () => {
    expect(channelFreshness(meta({ source: 'missing', degraded: true }))).toBe('missing');
    expect(channelFreshness(meta({ degraded: true, stale: true }))).toBe('degraded');
    expect(channelFreshness(meta({ stale: true }))).toBe('stale');
    expect(channelFreshness(meta({ source: 'live' }))).toBe('live');
    expect(channelFreshness(undefined)).toBe('fresh');
  });

  it('freshnessSummary nombra y suma lo viejo (con signo), y aparte lo sin dato', () => {
    const rows = [
      buildChannelRow(loc({ channel_key: 'a', label: 'FairPay', balance: 1000 }), meta({ stale: true })),
      buildChannelRow(loc({ channel_key: 'b', label: 'Coinsbuy', balance: 500.5 }), meta({ degraded: true })),
      buildChannelRow(loc({ channel_key: 'c', label: 'Socio', location_type: 'debt', balance: 200 }), meta({ stale: true })),
      buildChannelRow(loc({ channel_key: 'd', label: 'Kraken' }), meta({ source: 'missing' })),
      buildChannelRow(loc({ channel_key: 'e', label: 'Banco', balance: 9 }), meta()),
    ];
    const s = freshnessSummary(rows);
    expect(s.outdated.labels).toEqual(['FairPay', 'Coinsbuy', 'Socio']);
    expect(s.outdated.amount).toBe(1300.5);
    expect(s.missing.labels).toEqual(['Kraken']);
  });
});

describe('conteo de excluidos', () => {
  it('sumados = con dato; excluidos = sin dato + ocultos', () => {
    const rows = [
      { freshness: 'live' as const },
      { freshness: 'stale' as const },
      { freshness: 'missing' as const },
    ];
    expect(countChannels(rows, 2)).toEqual({ summed: 2, missing: 1, hidden: 2, excluded: 3 });
  });

  it('ocultos inválidos no inventan excluidos', () => {
    expect(countChannels([], Number.NaN)).toEqual({ summed: 0, missing: 0, hidden: 0, excluded: 0 });
  });
});

describe('barra de distribución', () => {
  const rows = [
    buildChannelRow(loc({ channel_key: 'cb', location_type: 'gateway', balance: 600 }), meta({ source: 'live' })),
    buildChannelRow(loc({ channel_key: 'bank', location_type: 'bank', balance: 400 }), meta({ stale: true })),
    buildChannelRow(loc({ channel_key: 'loan', location_type: 'loan', balance: 300 }), meta()),
    buildChannelRow(loc({ channel_key: 'debt', location_type: 'debt', balance: 250 }), meta()),
    buildChannelRow(loc({ channel_key: 'x', location_type: 'wallet' }), meta({ source: 'missing' })),
  ];

  it('sólo líquidos, antes de restar deuda; sin dato entra como null; viejo rayado', () => {
    expect(distributionInputs(rows)).toEqual([
      { key: 'cb', label: 'cb', value: 600, stale: false },
      { key: 'bank', label: 'bank', value: 400, stale: true },
      { key: 'x', label: 'x', value: null, stale: false },
    ]);
  });

  it('el % del líquido usa la misma base que tallyCash.liquid', () => {
    const liquid = tallyCash(rows.map((r) => ({ location_type: r.type, balance: r.balance }))).liquid;
    expect(liquid).toBe(1000);
    expect(liquidSharePct(rows[0], liquid)).toBe(60);
    expect(liquidSharePct(rows[1], liquid)).toBe(40);
    expect(liquidSharePct(rows[2], liquid)).toBeNull(); // prestado
    expect(liquidSharePct(rows[3], liquid)).toBeNull(); // deuda
    expect(liquidSharePct(rows[4], liquid)).toBeNull(); // sin dato
    expect(liquidSharePct(rows[0], 0)).toBeNull();
  });
});
