import type { Trade, RuleConfig, RuleResult, RuleViolation, AnalysisResult } from './types';
import type { ParseResult } from './parser';

// ─── Rule 1: Consistencia (Volume Consistency) ───
function ruleConsistencia(
  trades: Trade[],
  config: RuleConfig['consistencia'],
): RuleResult {
  if (!config.enabled) {
    return { ruleName: 'consistencia', displayName: 'Consistencia de Volumen', isActive: false, status: 'skipped', violations: [], violationPct: 0, computedParams: {} };
  }

  const volumes = trades.map((t) => t.volume);
  const avgVolume = volumes.reduce((s, v) => s + v, 0) / volumes.length;
  const minAllowed = avgVolume * config.factorMin;
  const maxAllowed = avgVolume * config.factorMax;

  const violations: RuleViolation[] = [];
  for (const t of trades) {
    if (t.volume < minAllowed || t.volume > maxAllowed) {
      violations.push({
        tradeIndex: t.index,
        detail: `Vol ${t.volume} fuera de rango [${minAllowed.toFixed(4)}, ${maxAllowed.toFixed(4)}] (avg=${avgVolume.toFixed(4)})`,
      });
    }
  }

  return {
    ruleName: 'consistencia',
    displayName: 'Consistencia de Volumen',
    isActive: true,
    status: violations.length > 0 ? 'fail' : 'pass',
    violations,
    violationPct: (violations.length / trades.length) * 100,
    computedParams: {
      avgVolume: avgVolume.toFixed(4),
      minAllowed: minAllowed.toFixed(4),
      maxAllowed: maxAllowed.toFixed(4),
    },
  };
}

// ─── Rule 2: Porcentaje de Profit ───
function ruleProfitPct(
  trades: Trade[],
  totalNetProfit: number,
  config: RuleConfig['profitPct'],
): RuleResult {
  if (!config.enabled) {
    return { ruleName: 'profitPct', displayName: 'Porcentaje de Profit', isActive: false, status: 'skipped', violations: [], violationPct: 0, computedParams: {} };
  }

  const limite = totalNetProfit * (config.pct / 100);
  const violations: RuleViolation[] = [];

  for (const t of trades) {
    if (t.profit > 0 && t.profit > limite) {
      violations.push({
        tradeIndex: t.index,
        detail: `Profit $${t.profit.toFixed(2)} > límite $${limite.toFixed(2)} (${config.pct}% de $${totalNetProfit.toFixed(2)})`,
      });
    }
  }

  return {
    ruleName: 'profitPct',
    displayName: 'Porcentaje de Profit',
    isActive: true,
    status: violations.length > 0 ? 'fail' : 'pass',
    violations,
    violationPct: (violations.length / trades.length) * 100,
    computedParams: {
      limite: limite.toFixed(2),
      totalNetProfit: totalNetProfit.toFixed(2),
      pct: config.pct,
    },
  };
}

// ─── Rule 3: Tiempo Mínimo ───
function ruleTiempoMin(
  trades: Trade[],
  config: RuleConfig['tiempoMin'],
): RuleResult {
  if (!config.enabled) {
    return { ruleName: 'tiempoMin', displayName: 'Tiempo Mínimo', isActive: false, status: 'skipped', violations: [], violationPct: 0, computedParams: {} };
  }

  const violations: RuleViolation[] = [];

  for (const t of trades) {
    if (isNaN(t.durationMinutes)) continue; // exclude unparseable
    if (t.durationMinutes < config.minutos) {
      violations.push({
        tradeIndex: t.index,
        detail: `Duración ${t.durationMinutes.toFixed(1)}min < mínimo ${config.minutos}min`,
      });
    }
  }

  return {
    ruleName: 'tiempoMin',
    displayName: 'Tiempo Mínimo',
    isActive: true,
    status: violations.length > 0 ? 'fail' : 'pass',
    violations,
    violationPct: (violations.length / trades.length) * 100,
    computedParams: { minutosMinimos: config.minutos },
  };
}

// ─── Rule 4: Grid ───
function ruleGrid(
  trades: Trade[],
  config: RuleConfig['grid'],
): RuleResult {
  if (!config.enabled) {
    return { ruleName: 'grid', displayName: 'Grid / Cobertura', isActive: false, status: 'skipped', violations: [], violationPct: 0, computedParams: {} };
  }

  // Group by symbol
  const bySymbol = new Map<string, Trade[]>();
  for (const t of trades) {
    const list = bySymbol.get(t.symbol) || [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }

  const violatedIndices = new Set<number>();
  let maxSimultaneas = 0;

  for (const [, symbolTrades] of bySymbol) {
    for (const ti of symbolTrades) {
      // Count total simultaneous trades INCLUDING self
      const simultaneous = symbolTrades.filter(
        (tj) => tj.openTime.getTime() < ti.closeTime.getTime()
          && ti.openTime.getTime() < tj.closeTime.getTime()
      );

      if (simultaneous.length >= config.minGrid) {
        for (const tj of simultaneous) violatedIndices.add(tj.index);
        if (simultaneous.length > maxSimultaneas) maxSimultaneas = simultaneous.length;
      }
    }
  }

  const violations: RuleViolation[] = [...violatedIndices]
    .sort((a, b) => a - b)
    .map((idx) => {
      const t = trades[idx];
      return {
        tradeIndex: idx,
        detail: `${t.symbol}: operación simultánea detectada (grid)`,
      };
    });

  return {
    ruleName: 'grid',
    displayName: 'Grid / Cobertura',
    isActive: true,
    status: violations.length > 0 ? 'fail' : 'pass',
    violations,
    violationPct: (violations.length / trades.length) * 100,
    computedParams: {
      minGrid: config.minGrid,
      maxSimultaneas,
    },
  };
}

// ─── Rule 5: Martingala ───
function ruleMartingala(
  trades: Trade[],
  config: RuleConfig['martingala'],
): RuleResult {
  if (!config.enabled) {
    return { ruleName: 'martingala', displayName: 'Martingala', isActive: false, status: 'skipped', violations: [], violationPct: 0, computedParams: {} };
  }

  // Group by symbol, sort by openTime
  const bySymbol = new Map<string, Trade[]>();
  for (const t of trades) {
    const list = bySymbol.get(t.symbol) || [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }

  const violatedIndices = new Set<number>();
  const details = new Map<number, string>();

  for (const [, symbolTrades] of bySymbol) {
    const sorted = [...symbolTrades].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());

    for (let i = 0; i < sorted.length - 1; i++) {
      const curr = sorted[i];
      const next = sorted[i + 1];

      // Check if linked (simultaneous or sequential within gap)
      const simultaneas = next.openTime.getTime() < curr.closeTime.getTime();
      const gapMinutes = (next.openTime.getTime() - curr.closeTime.getTime()) / 60000;
      const secuenciales = !simultaneas && gapMinutes <= config.gapMaximo;

      if ((simultaneas || secuenciales) && next.volume > curr.volume) {
        violatedIndices.add(curr.index);
        violatedIndices.add(next.index);
        const tipo = simultaneas
          ? 'Simultáneas'
          : `Secuenciales, gap ${gapMinutes.toFixed(0)}m`;
        const d = `${curr.volume} → ${next.volume} (${tipo})`;
        details.set(curr.index, d);
        details.set(next.index, d);
      }
    }
  }

  const violations: RuleViolation[] = [...violatedIndices]
    .sort((a, b) => a - b)
    .map((idx) => ({
      tradeIndex: idx,
      detail: details.get(idx) ?? 'Martingala detectada',
    }));

  return {
    ruleName: 'martingala',
    displayName: 'Martingala',
    isActive: true,
    status: violations.length > 0 ? 'fail' : 'pass',
    violations,
    violationPct: (violations.length / trades.length) * 100,
    computedParams: { gapMaximo: config.gapMaximo },
  };
}

// ─── Run all rules ───
export function analyzeReport(parsed: ParseResult, config: RuleConfig): AnalysisResult {
  const { trades, metadata } = parsed;

  const ruleResults: RuleResult[] = [
    ruleConsistencia(trades, config.consistencia),
    ruleProfitPct(trades, metadata.totalNetProfit, config.profitPct),
    ruleTiempoMin(trades, config.tiempoMin),
    ruleGrid(trades, config.grid),
    ruleMartingala(trades, config.martingala),
  ];

  return { trades, metadata, ruleResults };
}
