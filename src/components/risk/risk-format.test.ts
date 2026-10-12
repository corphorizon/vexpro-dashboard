import { describe, expect, it } from 'vitest';
import { shortWallet, snapshotFreshness, unitOfCategory, unitSuffix, SNAPSHOT_STALE_MIN } from './risk-format';
import { checkTally, filterByFinalStatus, finalStatusCounts } from './propfirm-view';

describe('shortWallet', () => {
  it('acorta una TRC20 a 6 + … + 4', () => {
    expect(shortWallet('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE')).toBe('TQn9Y2…bLSE');
  });
  it('una dirección corta queda entera', () => {
    expect(shortWallet('abc123')).toBe('abc123');
  });
  it('vacía o null → «—»', () => {
    expect(shortWallet(null)).toBe('—');
    expect(shortWallet('   ')).toBe('—');
  });
});

describe('snapshotFreshness', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  it('hasta 30 min no es stale; más de 30 sí', () => {
    expect(snapshotFreshness('2026-10-12T11:30:00Z', now)).toEqual({ minutes: 30, stale: false });
    expect(snapshotFreshness('2026-10-12T11:29:00Z', now)).toEqual({ minutes: 31, stale: true });
    expect(SNAPSHOT_STALE_MIN).toBe(30);
  });
  it('una foto «del futuro» (reloj adelantado) cuenta 0 min, nunca negativo', () => {
    expect(snapshotFreshness('2026-10-12T12:05:00Z', now)).toEqual({ minutes: 0, stale: false });
  });
  it('fecha inválida o ausente → null (no se inventa una antigüedad)', () => {
    expect(snapshotFreshness('no-es-fecha', now)).toBeNull();
    expect(snapshotFreshness(null, now)).toBeNull();
    expect(snapshotFreshness('', now)).toBeNull();
  });
});

describe('unidades de MT5', () => {
  it('sólo CENT está en centavos', () => {
    expect(unitOfCategory('CENT')).toBe('cents');
    expect(unitOfCategory('STANDARD')).toBe('account_currency');
    expect(unitSuffix('cents')).toBe('¢');
    expect(unitSuffix('account_currency')).toBe('USD');
  });
});

describe('propfirm-view', () => {
  it('checkTally cuenta los tres SIEMPRE y no asume «cumple» para un estado raro', () => {
    expect(
      checkTally([{ status: 'pass' }, { status: 'fail' }, { status: 'unverifiable' }, { status: 'unverifiable' }, { status: 'raro' }]),
    ).toEqual({ pass: 1, fail: 1, unverifiable: 2 });
    expect(checkTally(null)).toEqual({ pass: 0, fail: 0, unverifiable: 0 });
  });

  it('finalStatusCounts sale de los datos (un estado nuevo tiene su chip) y agrupa null como «—»', () => {
    const rows = [
      { status: 'APPROVED' },
      { status: 'REJECTED' },
      { status: 'APPROVED' },
      { status: null },
      { status: 'ON_HOLD_NUEVO' },
    ];
    expect(finalStatusCounts(rows)).toEqual([
      { status: 'APPROVED', count: 2 },
      { status: 'ON_HOLD_NUEVO', count: 1 },
      { status: 'REJECTED', count: 1 },
      { status: '—', count: 1 },
    ]);
    // Los conteos suman todas las filas: ninguna queda fuera de los chips.
    expect(finalStatusCounts(rows).reduce((a, b) => a + b.count, 0)).toBe(rows.length);
  });

  it('filterByFinalStatus: null = todos; «—» trae los sin estado', () => {
    const rows = [{ status: 'APPROVED' }, { status: null }];
    expect(filterByFinalStatus(rows, null)).toHaveLength(2);
    expect(filterByFinalStatus(rows, '—')).toEqual([{ status: null }]);
    expect(filterByFinalStatus(rows, 'APPROVED')).toEqual([{ status: 'APPROVED' }]);
  });
});
