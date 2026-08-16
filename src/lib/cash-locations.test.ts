import { describe, it, expect } from 'vitest';
import {
  LOCATION_TYPES,
  normalizeLocationType,
  isLiquid,
  isAutomatic,
  isOnchain,
  isValidOnchainAddress,
  normalizeOnchainAddress,
  parseOnchainWallets,
  validateOnchainWallets,
  summarize,
  groupByUnit,
  groupByType,
  primaryUnitId,
  unitShareOfLocation,
  unitLocationShares,
  type BusinessUnit,
  type CashLocation,
} from './cash-locations';

function unit(partial: Partial<BusinessUnit> & { id: string }): BusinessUnit {
  return {
    company_id: 'c1', name: partial.id, counts_to_fund: true,
    is_active: true, sort_order: 0, ...partial,
  };
}

let seq = 0;
function loc(partial: Partial<CashLocation>): CashLocation {
  seq += 1;
  return {
    channel_key: `k${seq}`, label: `Ubicación ${seq}`,
    location_type: 'wallet', business_unit_id: null, holder: null,
    is_visible: true, sort_order: seq, balance: 0,
    ...partial,
  };
}

describe('tipos de ubicación', () => {
  it('un valor desconocido cae en wallet, no rompe', () => {
    expect(normalizeLocationType('inventado')).toBe('wallet');
    expect(normalizeLocationType(null)).toBe('wallet');
  });

  // La regla que da sentido a todo el módulo: lo prestado es patrimonio pero
  // no es caja disponible.
  it('solo lo prestado deja de ser líquido', () => {
    for (const t of LOCATION_TYPES) {
      expect(isLiquid(t), t).toBe(t !== 'loan');
    }
  });

  it('solo las pasarelas se sincronizan solas', () => {
    expect(isAutomatic('gateway')).toBe(true);
    expect(isAutomatic('bank')).toBe(false);
    expect(isAutomatic('wallet')).toBe(false);
  });
});

describe('summarize', () => {
  // Números reales de Horizon: $48.351 prestados que no volvieron.
  it('separa lo disponible de lo prestado sin perder el total', () => {
    const s = summarize([
      loc({ location_type: 'wallet', balance: 20_000 }),
      loc({ location_type: 'bank', balance: 5_000 }),
      loc({ location_type: 'loan', balance: 48_351, holder: 'Kevin' }),
    ], []);
    expect(s.liquid).toBe(25_000);
    expect(s.lent).toBe(48_351);
    expect(s.total).toBe(73_351);
  });

  it('el fondo excluye a las unidades que se llevan aparte', () => {
    const horizon = unit({ id: 'u1', name: 'Horizon', counts_to_fund: true });
    const exura = unit({ id: 'u2', name: 'Exura', counts_to_fund: false, sort_order: 1 });
    const s = summarize([
      loc({ business_unit_id: 'u1', balance: 10_000 }),
      loc({ business_unit_id: 'u2', balance: 7_000 }),
    ], [horizon, exura]);
    expect(s.fund).toBe(10_000);
    expect(s.outsideFund).toBe(7_000);
  });

  // Una ubicación sin unidad asignada no puede desaparecer del ahorro real:
  // esa plata existe igual.
  it('lo que no tiene unidad asignada entra al fondo', () => {
    const s = summarize([loc({ business_unit_id: null, balance: 3_000 })], [
      unit({ id: 'u1', counts_to_fund: false }),
    ]);
    expect(s.fund).toBe(3_000);
    expect(s.outsideFund).toBe(0);
  });

  it('un saldo negativo resta, no se ignora', () => {
    const s = summarize([
      loc({ balance: 1_000 }),
      loc({ balance: -300 }),
    ], []);
    expect(s.liquid).toBe(700);
  });

  // El reparto cambia de quién es la plata, no cuánta hay: el total y el
  // patrimonio tienen que salir iguales con o sin porcentajes.
  it('el reparto por porcentaje no cambia el total ni parte el fondo de más', () => {
    const horizon = unit({ id: 'u1', name: 'Horizon', counts_to_fund: true });
    const exura = unit({ id: 'u2', name: 'Exura', counts_to_fund: false, sort_order: 1 });
    const s = summarize([
      loc({
        business_unit_id: 'u1',
        unit_shares: [
          { business_unit_id: 'u1', share: 0.6 },
          { business_unit_id: 'u2', share: 0.4 },
        ],
        balance: 10_000,
      }),
    ], [horizon, exura]);

    expect(s.total).toBe(10_000);
    expect(s.fund).toBe(6_000);
    expect(s.outsideFund).toBe(4_000);
  });

  it('con partes que no suman 1 el sobrante entra al fondo', () => {
    const exura = unit({ id: 'u2', name: 'Exura', counts_to_fund: false });
    const s = summarize([
      loc({ unit_shares: [{ business_unit_id: 'u2', share: 0.25 }], balance: 4_000 }),
    ], [exura]);

    expect(s.outsideFund).toBe(1_000);
    expect(s.fund).toBe(3_000);
    expect(s.fund + s.outsideFund).toBe(s.total);
  });

  it('sin ubicaciones da todo en cero', () => {
    expect(summarize([], [])).toEqual({ liquid: 0, lent: 0, total: 0, fund: 0, outsideFund: 0 });
  });
});

describe('agrupaciones', () => {
  it('agrupa por unidad y deja lo no asignado al final', () => {
    const g = groupByUnit([
      loc({ business_unit_id: null, balance: 100 }),
      loc({ business_unit_id: 'u2', balance: 200 }),
      loc({ business_unit_id: 'u1', balance: 300 }),
      loc({ business_unit_id: 'u1', balance: 50 }),
    ], [unit({ id: 'u1', name: 'Horizon', sort_order: 0 }), unit({ id: 'u2', name: 'Exura', sort_order: 1 })]);

    expect(g[0].unit?.name).toBe('Horizon');
    expect(g[0].total).toBe(350);
    expect(g[1].unit?.name).toBe('Exura');
    expect(g[g.length - 1].unit).toBeNull();
  });

  it('reparte una ubicación compartida entre sus unidades', () => {
    const g = groupByUnit([
      loc({
        business_unit_id: 'u1',
        unit_shares: [
          { business_unit_id: 'u1', share: 0.6 },
          { business_unit_id: 'u2', share: 0.4 },
        ],
        balance: 10_000,
      }),
    ], [unit({ id: 'u1', name: 'Horizon', sort_order: 0 }), unit({ id: 'u2', name: 'Exura', sort_order: 1 })]);

    expect(g[0].total).toBe(6_000);
    expect(g[1].total).toBe(4_000);
    // El saldo entero sigue disponible: la fila muestra su parte, no miente
    // sobre cuánta plata hay en esa wallet.
    expect(g[0].locations[0].fullBalance).toBe(10_000);
    expect(g[0].locations[0].balance).toBe(6_000);
  });

  it('lo que falta para el 100% queda sin unidad, no se evapora', () => {
    const g = groupByUnit([
      loc({ unit_shares: [{ business_unit_id: 'u1', share: 0.7 }], balance: 1_000 }),
    ], [unit({ id: 'u1', name: 'Horizon' })]);

    expect(g[0].total).toBe(700);
    expect(g[g.length - 1].unit).toBeNull();
    expect(g[g.length - 1].total).toBe(300);
  });

  it('un reparto que se pasa del 100% se normaliza', () => {
    const g = groupByUnit([
      loc({
        unit_shares: [
          { business_unit_id: 'u1', share: 1 },
          { business_unit_id: 'u2', share: 1 },
        ],
        balance: 900,
      }),
    ], [unit({ id: 'u1', sort_order: 0 }), unit({ id: 'u2', sort_order: 1 })]);

    expect(g[0].total + g[1].total).toBe(900);
    expect(g[0].total).toBe(450);
  });

  it('agrupa por tipo en el orden del catálogo', () => {
    const g = groupByType([
      loc({ location_type: 'loan', balance: 500 }),
      loc({ location_type: 'gateway', balance: 1_000 }),
      loc({ location_type: 'gateway', balance: 250 }),
    ]);
    expect(g.map((x) => x.type)).toEqual(['gateway', 'loan']);
    expect(g[0]).toEqual({ type: 'gateway', total: 1_250, count: 2 });
  });
});

// ── Reparto de una ubicación entre unidades (auditoría 2026-08, A5) ────────
// El libro por unidad resolvía sus canales solo por
// channel_configs.business_unit_id: una wallet 50/50 aparecía entera en una
// unidad y en ninguna otra.

describe('primaryUnitId', () => {
  it('la principal es la de MAYOR parte, no la primera cargada', () => {
    expect(primaryUnitId([
      { business_unit_id: 'u1', share: 0.3 },
      { business_unit_id: 'u2', share: 0.7 },
    ])).toBe('u2');
  });

  it('con empate manda la primera', () => {
    expect(primaryUnitId([
      { business_unit_id: 'u1', share: 0.5 },
      { business_unit_id: 'u2', share: 0.5 },
    ])).toBe('u1');
  });

  it('sin reparto no hay principal', () => {
    expect(primaryUnitId([])).toBeNull();
    expect(primaryUnitId(null)).toBeNull();
  });
});

describe('unitShareOfLocation', () => {
  it('devuelve la parte de la unidad', () => {
    expect(unitShareOfLocation('u2', [
      { business_unit_id: 'u1', share: 0.5 },
      { business_unit_id: 'u2', share: 0.5 },
    ], 'u1')).toBe(0.5);
  });

  it('una unidad ajena al reparto no ve nada', () => {
    expect(unitShareOfLocation('u3', [{ business_unit_id: 'u1', share: 1 }], 'u1')).toBe(0);
  });

  it('sin filas de reparto manda channel_configs', () => {
    expect(unitShareOfLocation('u1', [], 'u1')).toBe(1);
    expect(unitShareOfLocation('u1', null, 'u2')).toBe(0);
  });

  it('un reparto que se pasa del 100% se prorratea (igual que allocateShares)', () => {
    expect(unitShareOfLocation('u1', [
      { business_unit_id: 'u1', share: 1 },
      { business_unit_id: 'u2', share: 1 },
    ], null)).toBe(0.5);
  });
});

describe('unitLocationShares', () => {
  const configs = [
    { channel_key: 'wallet_ab', business_unit_id: 'u1' },
    { channel_key: 'banco_u1', business_unit_id: 'u1' },
    { channel_key: 'banco_u2', business_unit_id: 'u2' },
    { channel_key: 'sin_unidad', business_unit_id: null },
  ];
  const shares = [
    { channel_key: 'wallet_ab', business_unit_id: 'u1', share: 0.5 },
    { channel_key: 'wallet_ab', business_unit_id: 'u2', share: 0.5 },
  ];

  it('la unidad principal ya no ve el 100% de una wallet compartida', () => {
    const m = unitLocationShares('u1', configs, shares);
    expect(m.get('wallet_ab')).toBe(0.5);
  });

  it('la otra unidad ahora SÍ ve la wallet compartida', () => {
    const m = unitLocationShares('u2', configs, shares);
    expect(m.get('wallet_ab')).toBe(0.5);
    expect(m.get('banco_u2')).toBe(1);
  });

  it('las dos partes suman exactamente la ubicación entera', () => {
    const a = unitLocationShares('u1', configs, shares).get('wallet_ab') ?? 0;
    const b = unitLocationShares('u2', configs, shares).get('wallet_ab') ?? 0;
    expect(a + b).toBe(1);
  });

  it('no devuelve las ubicaciones de otra unidad', () => {
    const m = unitLocationShares('u1', configs, shares);
    expect(m.has('banco_u2')).toBe(false);
    expect(m.has('sin_unidad')).toBe(false);
    expect(m.get('banco_u1')).toBe(1);
  });

  it('dedup: una ubicación con reparto Y fallback aparece una sola vez', () => {
    const m = unitLocationShares('u1', configs, [
      { channel_key: 'banco_u1', business_unit_id: 'u1', share: 1 },
    ]);
    expect([...m.keys()].filter((k) => k === 'banco_u1')).toHaveLength(1);
    expect(m.get('banco_u1')).toBe(1);
  });

  it('con reparto cargado, el fallback de channel_configs NO suma de nuevo', () => {
    // wallet_ab tiene business_unit_id = u1 en channel_configs, pero el
    // reparto explícito le da 0.5: manda el reparto.
    const m = unitLocationShares('u1', configs, [
      { channel_key: 'wallet_ab', business_unit_id: 'u2', share: 1 },
    ]);
    expect(m.has('wallet_ab')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wallets on-chain (migración 085)
// ─────────────────────────────────────────────────────────────────────────────

describe('direcciones on-chain', () => {
  const TRON = 'TEkSDmWk3KMxSeSK9ogefYkhEEnVtZVTkJ';
  const EVM = '0x321814cA95A24348551239466d778E2Fc93539c9';

  it('acepta el formato de cada red y rechaza el cruzado', () => {
    expect(isValidOnchainAddress('tron', TRON)).toBe(true);
    expect(isValidOnchainAddress('bsc', EVM)).toBe(true);
    expect(isValidOnchainAddress('ethereum', EVM)).toBe(true);
    // Una dirección EVM no es una dirección Tron ni al revés.
    expect(isValidOnchainAddress('tron', EVM)).toBe(false);
    expect(isValidOnchainAddress('bsc', TRON)).toBe(false);
    // Base58 no incluye 0/O/I/l: una "T" seguida de ceros no es una dirección.
    expect(isValidOnchainAddress('tron', 'T000000000000000000000000000000000')).toBe(false);
  });

  it('normaliza EVM a minúsculas y deja Tron como está (es case-sensitive)', () => {
    expect(normalizeOnchainAddress('bsc', ` ${EVM} `)).toBe(EVM.toLowerCase());
    expect(normalizeOnchainAddress('tron', ` ${TRON} `)).toBe(TRON);
  });

  it('la MISMA dirección 0x en dos cadenas NO es un duplicado', () => {
    const res = validateOnchainWallets([
      { network: 'bsc', address: EVM },
      { network: 'ethereum', address: EVM },
    ]);
    expect(res.error).toBeUndefined();
    expect(res.wallets).toHaveLength(2);
  });

  it('la misma (red, dirección) dos veces SÍ es un duplicado', () => {
    const res = validateOnchainWallets([
      { network: 'bsc', address: EVM },
      // Distinto casing, misma wallet: se detecta porque se normaliza antes.
      { network: 'bsc', address: EVM.toLowerCase() },
    ]);
    expect(res.error).toMatch(/repetida/);
  });

  it('rechaza una red inventada y una dirección mal pegada', () => {
    expect(validateOnchainWallets([{ network: 'solana', address: EVM }]).error).toMatch(/no soportada/);
    expect(validateOnchainWallets([{ network: 'tron', address: 'TEkS' }]).error).toMatch(/inválida/);
  });

  it('null y [] son válidos: así se desconecta una wallet sin borrarla', () => {
    expect(validateOnchainWallets(null).wallets).toEqual([]);
    expect(validateOnchainWallets([]).wallets).toEqual([]);
  });

  it('parseOnchainWallets descarta la basura sin lanzar (datos ya guardados)', () => {
    const parsed = parseOnchainWallets([
      { network: 'tron', address: TRON },
      { network: 'tron', address: 'roto' },
      'no soy un objeto',
      null,
    ]);
    expect(parsed).toEqual([{ network: 'tron', address: TRON }]);
    expect(parseOnchainWallets('cualquier cosa')).toEqual([]);
  });

  it('isOnchain mira la FILA; isAutomatic sigue mirando el TIPO', () => {
    const wallet = { location_type: 'wallet', onchain_wallets: [{ network: 'tron', address: TRON }] };
    expect(isOnchain(wallet)).toBe(true);
    // Una wallet a secas NO es automática por su tipo: eso solo lo son las
    // pasarelas. Las dos preguntas son distintas y así deben seguir.
    expect(isAutomatic(wallet.location_type)).toBe(false);
    expect(isOnchain({ onchain_wallets: [] })).toBe(false);
    expect(isOnchain(null)).toBe(false);
  });

  it('una wallet on-chain sigue siendo líquida', () => {
    expect(isLiquid('wallet')).toBe(true);
  });
});
