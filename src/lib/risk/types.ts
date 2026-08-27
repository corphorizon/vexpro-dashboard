// ─── Risk Management Types ───

export interface Trade {
  /**
   * Posición en el array `trades`, EMPEZANDO EN CERO.
   *
   * No es un identificador: `ruleGrid` y `ruleMartingala` juntan violaciones
   * por este campo y después resuelven la operación con `trades[index]`. Si
   * `index` no coincide con la posición, no falla nada — se señala la
   * operación equivocada, y la última da `undefined`.
   *
   * El acoplamiento estaba implícito y ya hizo tropezar a un segundo cargador
   * de datos (el automático desde MT5, que numeraba desde 1).
   */
  index: number;
  position: number;
  symbol: string;
  type: 'buy' | 'sell';
  volume: number;
  openPrice: number;
  closePrice: number;
  sl: number | null;
  tp: number | null;
  openTime: Date;
  closeTime: Date;
  commission: number;
  swap: number;
  profit: number;
  durationMinutes: number;
}

export interface RuleViolation {
  tradeIndex: number;
  detail: string;
}

export interface RuleResult {
  ruleName: string;
  displayName: string;
  isActive: boolean;
  status: 'pass' | 'fail' | 'skipped';
  violations: RuleViolation[];
  violationPct: number;
  computedParams: Record<string, number | string>;
}

export interface ReportMetadata {
  traderName: string;
  accountNumber: string;
  broker: string;
  period: string;
  totalNetProfit: number;
}

export interface AnalysisResult {
  trades: Trade[];
  metadata: ReportMetadata;
  ruleResults: RuleResult[];
}

export interface RuleConfig {
  consistencia: { enabled: boolean; factorMin: number; factorMax: number };
  profitPct: { enabled: boolean; pct: number };
  tiempoMin: { enabled: boolean; minutos: number };
  grid: { enabled: boolean; minGrid: number };
  martingala: { enabled: boolean; gapMaximo: number };
}

export type ApprovalMode = 'none' | 'global' | 'per-rule';

export interface ApprovalLimits {
  mode: ApprovalMode;
  globalMax: number;
  perRule: {
    consistencia: number;
    profitPct: number;
    tiempoMin: number;
    grid: number;
    martingala: number;
  };
}

export const DEFAULT_APPROVAL_LIMITS: ApprovalLimits = {
  mode: 'none',
  globalMax: 0,
  perRule: {
    consistencia: 0,
    profitPct: 0,
    tiempoMin: 0,
    grid: 0,
    martingala: 0,
  },
};

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  consistencia: { enabled: true, factorMin: 0.25, factorMax: 2.0 },
  profitPct: { enabled: true, pct: 30 },
  tiempoMin: { enabled: true, minutos: 5 },
  grid: { enabled: true, minGrid: 3 },
  martingala: { enabled: true, gapMaximo: 5 },
};
