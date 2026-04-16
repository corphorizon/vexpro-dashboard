// ─── Risk Management Types ───

export interface Trade {
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
