import { describe, it, expect } from 'vitest';
import {
  HEDGE_FUND_TEST_FUND_KEYS,
  HEDGE_FUND_TEST_USER_IDS,
  exclusionReason,
  isTestFundKey,
  isTestUserId,
  splitTestData,
} from './test-data';

describe('exclusión de datos de prueba', () => {
  // Se ITERA sobre el registro único a propósito: el día que alguien agregue un
  // fondo de prueba a la lista, este test lo cubre solo. Escribir 'qa-tst' a
  // mano acá sería la segunda lista (§1.1).
  it('reconoce todo lo que está en la lista canónica', () => {
    expect(HEDGE_FUND_TEST_FUND_KEYS.length).toBeGreaterThan(0);
    for (const k of HEDGE_FUND_TEST_FUND_KEYS) expect(isTestFundKey(k)).toBe(true);
    for (const u of HEDGE_FUND_TEST_USER_IDS) expect(isTestUserId(u)).toBe(true);
  });

  // ── La mitad negativa ────────────────────────────────────────────────────
  // La exclusión es por llave EXACTA. El criterio que se descartó —"fondos
  // TERMINATED cuyo nombre contenga TAQ"— habría borrado dinero de clientes
  // reales de un fondo que se cerró.
  it('NO excluye por parecido, ni por estado, ni por substring', () => {
    expect(isTestFundKey('qa-tst-2')).toBe(false);
    expect(isTestFundKey('QA-TST')).toBe(false);
    expect(isTestFundKey('growth')).toBe(false);
    expect(isTestUserId('702d25d4-1b37-4528-a676-2b027f985d96')).toBe(false);
    expect(isTestFundKey(null)).toBe(false);
    expect(isTestFundKey(undefined)).toBe(false);
    expect(isTestUserId(42)).toBe(false);
  });

  it('dice POR QUÉ excluyó, no sólo que excluyó', () => {
    expect(exclusionReason({ fund_key: HEDGE_FUND_TEST_FUND_KEYS[0] })).toBe('test_fund');
    expect(exclusionReason({ user_external_id: HEDGE_FUND_TEST_USER_IDS[0] })).toBe('test_user');
    expect(exclusionReason({ fund_key: 'growth', user_external_id: 'u1' })).toBeNull();
  });

  it('parte la lista devolviendo SIEMPRE el conteo de lo excluido', () => {
    // La regla del repo: una exclusión silenciosa es indistinguible de un cruce
    // roto. `splitTestData` no permite quedarse con `kept` sin ver el conteo.
    const filas = [
      { fund_key: 'growth', user_external_id: 'u1' },
      { fund_key: HEDGE_FUND_TEST_FUND_KEYS[0], user_external_id: 'u2' },
      { fund_key: 'growth', user_external_id: HEDGE_FUND_TEST_USER_IDS[0] },
    ];
    const r = splitTestData(filas);
    expect(r.kept).toHaveLength(1);
    expect(r.excludedCount).toBe(2);
    expect(r.byReason).toEqual({ test_fund: 1, test_user: 1 });
  });

  it('sin nada de prueba el conteo es 0 y no se pierde ninguna fila', () => {
    const filas = [{ fund_key: 'growth', user_external_id: 'u1' }];
    const r = splitTestData(filas);
    expect(r.kept).toEqual(filas);
    expect(r.excludedCount).toBe(0);
  });
});
