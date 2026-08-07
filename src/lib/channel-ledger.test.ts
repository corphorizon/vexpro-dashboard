import { describe, it, expect } from 'vitest';
import {
  withRunningBalance,
  balanceAsOf,
  computeTotals,
  validateEntry,
  isAutoLedger,
  hasLedger,
  previousDay,
  signedAmount,
  type LedgerEntry,
  resolveInternalTransfers,
} from './channel-ledger';

// Fábrica mínima: los tests solo miran fecha, tipo, categoría y monto.
let seq = 0;
function entry(partial: Partial<LedgerEntry>): LedgerEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    company_id: 'c1',
    channel_key: 'wallet_externa',
    entry_date: '2026-08-01',
    kind: 'in',
    source: 'manual',
    concept: 'Movimiento',
    category: null,
    reference: null,
    amount: 100,
    notes: null,
    created_by: null,
    created_at: `2026-08-01T00:00:${String(seq).padStart(2, '0')}Z`,
    updated_at: '2026-08-01T00:00:00Z',
    ...partial,
  };
}

describe('signedAmount', () => {
  it('resta solo los egresos', () => {
    expect(signedAmount({ kind: 'in', amount: 100 })).toBe(100);
    expect(signedAmount({ kind: 'out', amount: 100 })).toBe(-100);
    // El saldo inicial suma: es el punto de partida, no un movimiento.
    expect(signedAmount({ kind: 'opening', amount: 100 })).toBe(100);
  });
});

describe('withRunningBalance', () => {
  it('acumula el saldo en orden cronológico', () => {
    const rows = withRunningBalance([
      entry({ entry_date: '2026-08-03', kind: 'out', amount: 500 }),
      entry({ entry_date: '2026-08-01', kind: 'opening', amount: 1000, category: 'opening' }),
      entry({ entry_date: '2026-08-02', kind: 'in', amount: 250 }),
    ]);
    expect(rows.map((r) => r.balance)).toEqual([1000, 1250, 750]);
  });

  it('pone el saldo inicial primero aunque comparta fecha con un movimiento', () => {
    const rows = withRunningBalance([
      entry({ entry_date: '2026-08-01', kind: 'in', amount: 40 }),
      entry({ entry_date: '2026-08-01', kind: 'opening', amount: 10, category: 'opening' }),
    ]);
    expect(rows[0].kind).toBe('opening');
    expect(rows[1].balance).toBe(50);
  });

  it('ordena las líneas automáticas del día en orden contable', () => {
    const rows = withRunningBalance([
      entry({ entry_date: '2026-08-02', kind: 'in', amount: 1, category: 'adjustment' }),
      entry({ entry_date: '2026-08-02', kind: 'out', amount: 30, category: 'internal' }),
      entry({ entry_date: '2026-08-02', kind: 'in', amount: 100, category: 'deposits' }),
      entry({ entry_date: '2026-08-02', kind: 'out', amount: 20, category: 'withdrawals' }),
    ]);
    expect(rows.map((r) => r.category)).toEqual([
      'deposits', 'withdrawals', 'internal', 'adjustment',
    ]);
  });
});

describe('balanceAsOf', () => {
  const book = [
    entry({ entry_date: '2026-08-01', kind: 'opening', amount: 1000, category: 'opening' }),
    entry({ entry_date: '2026-08-02', kind: 'in', amount: 500 }),
    entry({ entry_date: '2026-08-05', kind: 'out', amount: 200 }),
  ];

  it('incluye el día consultado (saldo al CIERRE de esa fecha)', () => {
    expect(balanceAsOf(book, '2026-08-02')).toBe(1500);
    expect(balanceAsOf(book, '2026-08-05')).toBe(1300);
  });

  it('ignora los asientos posteriores', () => {
    expect(balanceAsOf(book, '2026-08-03')).toBe(1500);
  });

  it('da cero antes de abrirse el libro', () => {
    expect(balanceAsOf(book, '2026-07-31')).toBe(0);
  });
});

describe('computeTotals', () => {
  // Reproduce la forma real de un día de Coinsbuy: depósitos, retiros,
  // una transferencia interna y el ajuste de comisiones de red.
  const book = [
    entry({ entry_date: '2026-07-31', kind: 'opening', amount: 10_000, category: 'opening' }),
    entry({ entry_date: '2026-08-01', kind: 'in', amount: 3_000, category: 'deposits' }),
    entry({ entry_date: '2026-08-01', kind: 'out', amount: 1_000, category: 'withdrawals' }),
    entry({ entry_date: '2026-08-01', kind: 'out', amount: 500, category: 'internal' }),
    entry({ entry_date: '2026-08-01', kind: 'out', amount: 4, category: 'adjustment' }),
  ];

  const totals = computeTotals(book, '2026-08-01', '2026-08-31');

  it('arranca del saldo anterior al rango', () => {
    expect(totals.opening).toBe(10_000);
  });

  it('separa las transferencias internas de los retiros reales', () => {
    expect(totals.outflows).toBe(1_000);
    expect(totals.internalTransfers).toBe(500);
  });

  it('lleva el ajuste con signo, no en valor absoluto', () => {
    expect(totals.adjustments).toBe(-4);
  });

  it('cierra: inicial + ingresos − retiros − internas + ajustes', () => {
    expect(totals.closing).toBe(11_496);
    expect(totals.closing).toBe(balanceAsOf(book, '2026-08-31'));
  });
});

describe('previousDay', () => {
  it('cruza el fin de mes sin depender de la zona horaria local', () => {
    expect(previousDay('2026-08-01')).toBe('2026-07-31');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
  });
});

describe('qué canales llevan libro', () => {
  it('excluye liquidez e inversiones — ya son libros en su propio módulo', () => {
    expect(hasLedger('liquidez')).toBe(false);
    expect(hasLedger('inversiones')).toBe(false);
    expect(hasLedger('coinsbuy')).toBe(true);
    expect(hasLedger('custom_abc')).toBe(true);
  });

  it('marca como automáticos solo a los canales por API', () => {
    expect(isAutoLedger('coinsbuy')).toBe(true);
    expect(isAutoLedger('unipayment')).toBe(true);
    expect(isAutoLedger('fairpay')).toBe(false);
    expect(isAutoLedger('wallet_externa')).toBe(false);
  });
});

describe('validateEntry', () => {
  const ok = {
    channel_key: 'wallet_externa',
    entry_date: '2026-08-06',
    kind: 'in' as const,
    concept: 'Transferencia recibida',
    amount: 250,
  };

  it('acepta un asiento manual bien formado', () => {
    expect(validateEntry(ok)).toBeNull();
  });

  it('rechaza asientos a mano en canales automáticos', () => {
    expect(validateEntry({ ...ok, channel_key: 'coinsbuy' })).toMatch(/automática/);
  });

  it('rechaza canales sin libro', () => {
    expect(validateEntry({ ...ok, channel_key: 'liquidez' })).toMatch(/no lleva libro/);
  });

  it('rechaza montos negativos — el signo lo da el tipo de movimiento', () => {
    expect(validateEntry({ ...ok, amount: -50 })).toMatch(/negativo/);
  });

  it('rechaza monto cero y concepto vacío', () => {
    expect(validateEntry({ ...ok, amount: 0 })).not.toBeNull();
    expect(validateEntry({ ...ok, concept: '   ' })).not.toBeNull();
  });

  it('rechaza fechas mal formadas', () => {
    expect(validateEntry({ ...ok, entry_date: '06/08/2026' })).toMatch(/fecha/i);
  });
});

describe('resolveInternalTransfers', () => {
  // Caso real 2026-08-04: $70.000 internos que SÍ salieron del agregado
  // (destino: wallet no fijada). El ajuste correcto es el de comisiones.
  it('detecta la interna que salió del agregado (04/08 real)', () => {
    const r = resolveInternalTransfers({
      baseWithoutInternal: 527_159.81 + 46_604.88 - 18_594.24, // 555.170,45
      internal: 70_000,
      actualClose: 527_159.81 + 46_604.88 - 18_594.24 - 70_000 - 1.07,
    });
    expect(r.internalLeftAggregate).toBe(true);
    expect(r.adjustment).toBeCloseTo(-1.07, 2);
  });

  // Caso real 2026-08-06: $35.000 de 1079 → 1705, AMBAS fijadas. La plata
  // nunca salió; asentar la interna habría creado un par ficticio de ±35K.
  it('detecta la interna entre wallets fijadas (06/08 real)', () => {
    const base = 573_884.41 + 38_397.58 + 37_870.99 - 91_063.68; // 559.089,30
    const r = resolveInternalTransfers({
      baseWithoutInternal: base,
      internal: 35_000,
      actualClose: 559_084.37,
    });
    expect(r.internalLeftAggregate).toBe(false);
    expect(r.adjustment).toBeCloseTo(-4.93, 2);
  });

  it('sin internas, el ajuste es directo', () => {
    const r = resolveInternalTransfers({ baseWithoutInternal: 1000, internal: 0, actualClose: 998 });
    expect(r.internalLeftAggregate).toBe(false);
    expect(r.adjustment).toBe(-2);
  });
});
