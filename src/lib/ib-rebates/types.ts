// ─────────────────────────────────────────────────────────────────────────────
// ib-rebates/types — tipos del módulo Configuración IBs (Rebates).
// Backed by 3 tablas:
//   · ib_rebate_configs        — una fila por IB con sus niveles
//   · ib_rebate_config_history — log de cambios (create/edit/upgrade/...)
//   · ib_rebate_thresholds     — umbrales de alerta por empresa
// Todos scopeados por company_id.
// ─────────────────────────────────────────────────────────────────────────────

export interface IbRebateConfig {
  id: string;
  company_id: string;
  username: string;
  archivo: string | null;
  /** Legacy: hoy se mantiene sincronizada con `last_update_date`. La fuente
   *  de verdad para alertas es `last_update_date`; la fecha histórica del
   *  primer setup está en `original_config_date`. */
  config_date: string; // ISO date (YYYY-MM-DD)
  /** Fecha del primer setup. Inmutable después de crear la fila. */
  original_config_date: string;
  /** Fecha del último cambio (edit/upgrade/downgrade). Las alertas
   *  cuentan días desde aquí. `goals_met` no la modifica. */
  last_update_date: string;
  stp: number;
  ecn: number;
  cent: number;
  pro: number;
  vip: number;
  elite: number;
  syntheticos_level: number;
  propfirm_level: number;
  notes: string | null;
  goals_met: boolean;
  /** null = nunca cambió ('inicial'); 'edit' tampoco penaliza alertas. */
  last_change_type: 'upgrade' | 'downgrade' | 'edit' | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface IbRebateThresholds {
  company_id: string;
  initial_yellow_days: number;
  initial_red_days: number;
  recurring_yellow_days: number;
  recurring_orange_days: number;
  recurring_red_days: number;
}

export interface IbRebateHistoryEntry {
  id: string;
  config_id: string;
  company_id: string;
  change_type: 'create' | 'edit' | 'upgrade' | 'downgrade' | 'goals_met' | 'note';
  snapshot: Partial<IbRebateConfig>;
  changed_by: string | null;
  changed_by_name: string | null;
  notes: string | null;
  created_at: string;
}

export type AlertLevel = 'green' | 'yellow' | 'orange' | 'red';

export interface AlertResult {
  level: AlertLevel;
  message: string;
  daysSince: number;
  mode: 'initial' | 'recurring';
}

export const DEFAULT_THRESHOLDS: Omit<IbRebateThresholds, 'company_id'> = {
  initial_yellow_days: 60,
  initial_red_days: 90,
  recurring_yellow_days: 30,
  recurring_orange_days: 60,
  recurring_red_days: 90,
};
