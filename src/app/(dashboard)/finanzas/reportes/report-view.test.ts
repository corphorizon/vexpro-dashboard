// /finanzas/reportes: las comparaciones de los KPIs y el saldo de un canal
// sin dato («Libro mayor», 2026-10-12). Ninguna convierte un null en cero.
import { describe, it, expect } from 'vitest';
import { moneyText } from '@/components/ui/money';
import {
  channelAmount,
  channelSourceKind,
  missingChannelLabels,
  pctOfMonth,
  pctVariation,
  roundPct,
} from './report-view';

describe('pctVariation', () => {
  it('variación contra el mes anterior, con el anterior en valor absoluto', () => {
    expect(pctVariation(110, 100)).toBeCloseTo(10);
    expect(pctVariation(-50, -100)).toBeCloseTo(50);
  });

  it('null de cualquier lado o anterior en 0 → sin comparación (nunca −100 %)', () => {
    expect(pctVariation(null, 100)).toBeNull();
    expect(pctVariation(100, null)).toBeNull();
    expect(pctVariation(100, 0)).toBeNull();
  });
});

describe('pctOfMonth', () => {
  it('el rango como % del mes', () => {
    expect(pctOfMonth(25, 100)).toBeCloseTo(25);
    expect(pctOfMonth(25, -100)).toBeCloseTo(25);
  });

  it('sin mes o sin rango → sin referencia', () => {
    expect(pctOfMonth(25, 0)).toBeNull();
    expect(pctOfMonth(25, null)).toBeNull();
    expect(pctOfMonth(null, 100)).toBeNull();
  });
});

describe('roundPct', () => {
  it('un decimal, como antes', () => {
    expect(roundPct(12.345)).toBe('12.3');
    expect(roundPct(-0.04)).toBe('0');
  });
});

describe('channelAmount', () => {
  it("'missing' es «—», no $0.00", () => {
    const v = channelAmount({ amount: 0, source: 'missing' });
    expect(v).toBeNull();
    expect(moneyText(v)).toBe('—');
  });

  it('cualquier otra fuente, el monto tal cual (un 0 real es 0)', () => {
    expect(channelAmount({ amount: 0, source: 'live' })).toBe(0);
    expect(channelAmount({ amount: 1500.25, source: 'snapshot' })).toBe(1500.25);
  });

  it('lista los canales sin dato para el aviso', () => {
    expect(
      missingChannelLabels([
        { label: 'Coinsbuy', source: 'live' },
        { label: 'FairPay', source: 'missing' },
        { label: 'Banco', source: 'ledger' },
      ]),
    ).toEqual(['FairPay']);
  });
});

describe('channelSourceKind', () => {
  it('manual es manual; api y auto van como fuente automática', () => {
    expect(channelSourceKind('manual')).toBe('manual');
    expect(channelSourceKind('api')).toBe('api');
    expect(channelSourceKind('auto')).toBe('api');
  });
});
