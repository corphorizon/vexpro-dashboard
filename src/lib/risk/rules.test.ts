import { describe, it, expect } from 'vitest';
import { analyzeReport } from './rules';
import { DEFAULT_RULE_CONFIG } from './types';
import type { Trade, RuleConfig, ReportMetadata } from './types';
import type { ParseResult } from './parser';

// QA-01: motor de análisis de riesgo de prop firm. Decide reglas/violaciones
// sobre trades — alta complejidad, cero cobertura previa. Testeamos vía la
// única función pública (analyzeReport); las reglas individuales son privadas.

const trade = (o: Partial<Trade>): Trade =>
  ({
    index: 0, position: 0, symbol: 'EURUSD', type: 'buy', volume: 1,
    openPrice: 1, closePrice: 1, sl: null, tp: null,
    openTime: new Date('2026-05-01T10:00:00Z'), closeTime: new Date('2026-05-01T10:10:00Z'),
    commission: 0, swap: 0, profit: 0, durationMinutes: 10, ...o,
  } as Trade);

const meta: ReportMetadata = {
  traderName: 'T', accountNumber: '1', broker: 'B', period: 'May', totalNetProfit: 1000,
};

const parsed = (trades: Trade[]): ParseResult => ({ trades, metadata: meta });

const cfg = (over: Partial<RuleConfig>): RuleConfig => ({ ...DEFAULT_RULE_CONFIG, ...over });

describe('analyzeReport — estructura', () => {
  it('devuelve una RuleResult por cada una de las 5 reglas', () => {
    const r = analyzeReport(parsed([trade({})]), DEFAULT_RULE_CONFIG);
    expect(r.ruleResults).toHaveLength(5);
    expect(r.ruleResults.map((x) => x.ruleName).sort()).toEqual(
      ['consistencia', 'grid', 'martingala', 'profitPct', 'tiempoMin'].sort(),
    );
    expect(r.trades).toHaveLength(1);
    expect(r.metadata.traderName).toBe('T');
  });
});

describe('analyzeReport — regla Tiempo Mínimo', () => {
  it('marca fail cuando hay trades por debajo del mínimo', () => {
    const r = analyzeReport(
      parsed([trade({ index: 1, durationMinutes: 2 }), trade({ index: 2, durationMinutes: 8 })]),
      cfg({ tiempoMin: { enabled: true, minutos: 5 } }),
    );
    const t = r.ruleResults.find((x) => x.ruleName === 'tiempoMin')!;
    expect(t.status).toBe('fail');
    expect(t.violations).toHaveLength(1);        // solo el de 2min viola
    expect(t.violations[0].tradeIndex).toBe(1);
    expect(t.violationPct).toBeCloseTo(50, 1);   // 1 de 2 trades
    expect(t.isActive).toBe(true);
  });

  it('pass cuando todos superan el mínimo', () => {
    const r = analyzeReport(
      parsed([trade({ durationMinutes: 6 }), trade({ durationMinutes: 10 })]),
      cfg({ tiempoMin: { enabled: true, minutos: 5 } }),
    );
    expect(r.ruleResults.find((x) => x.ruleName === 'tiempoMin')!.status).toBe('pass');
  });

  it('regla deshabilitada → status skipped, isActive false', () => {
    const r = analyzeReport(
      parsed([trade({ durationMinutes: 1 })]),
      cfg({ tiempoMin: { enabled: false, minutos: 5 } }),
    );
    const t = r.ruleResults.find((x) => x.ruleName === 'tiempoMin')!;
    expect(t.status).toBe('skipped');
    expect(t.isActive).toBe(false);
    expect(t.violations).toHaveLength(0);
  });

  it('ignora trades con durationMinutes NaN (no parseable)', () => {
    const r = analyzeReport(
      parsed([trade({ durationMinutes: NaN }), trade({ durationMinutes: 2 })]),
      cfg({ tiempoMin: { enabled: true, minutos: 5 } }),
    );
    const t = r.ruleResults.find((x) => x.ruleName === 'tiempoMin')!;
    expect(t.violations).toHaveLength(1); // el NaN se omite, solo cuenta el de 2min
  });
});

describe('analyzeReport — sin trades', () => {
  it('no explota con lista vacía; cada regla resuelve', () => {
    const r = analyzeReport(parsed([]), DEFAULT_RULE_CONFIG);
    expect(r.ruleResults).toHaveLength(5);
    for (const rr of r.ruleResults) {
      expect(['pass', 'fail', 'skipped']).toContain(rr.status);
    }
  });
});
