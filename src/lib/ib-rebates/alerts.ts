import type { IbRebateConfig, IbRebateThresholds, AlertResult } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// computeAlert — calcula al vuelo el nivel de alerta de una config IB
// según los días transcurridos desde `config_date` y el modo
// (inicial vs. recurrente, derivado de `last_change_type`).
//
// Modo inicial:    null o 'edit'        → 60 / 90 (defaults)
// Modo recurrente: 'upgrade'/'downgrade' → 30 / 60 / 90 (más estricto)
// ─────────────────────────────────────────────────────────────────────────────

export function computeAlert(
  config: IbRebateConfig,
  thresholds: IbRebateThresholds,
): AlertResult {
  const today = new Date();
  // Las alertas se cuentan desde la última actualización (cada
  // edit/upgrade/downgrade resetea este valor). `original_config_date`
  // queda preservada como referencia histórica y NO entra en este cálculo.
  const updateDate = new Date(config.last_update_date);
  const ms = today.getTime() - updateDate.getTime();
  const daysSince = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));

  const mode: 'initial' | 'recurring' =
    config.last_change_type === 'upgrade' || config.last_change_type === 'downgrade'
      ? 'recurring'
      : 'initial';

  if (mode === 'initial') {
    if (daysSince < thresholds.initial_yellow_days) {
      return { level: 'green', message: 'OK', daysSince, mode };
    }
    if (daysSince < thresholds.initial_red_days) {
      return { level: 'yellow', message: 'Alertar net deposit', daysSince, mode };
    }
    return { level: 'red', message: 'Pendiente revisar IB', daysSince, mode };
  }

  // mode === 'recurring'
  if (daysSince < thresholds.recurring_yellow_days) {
    return { level: 'green', message: 'OK', daysSince, mode };
  }
  if (daysSince < thresholds.recurring_orange_days) {
    return { level: 'yellow', message: 'Revisar upgrade/downgrade', daysSince, mode };
  }
  if (daysSince < thresholds.recurring_red_days) {
    return { level: 'orange', message: 'Revisión urgente', daysSince, mode };
  }
  return { level: 'red', message: 'Pendiente revisar IB', daysSince, mode };
}
