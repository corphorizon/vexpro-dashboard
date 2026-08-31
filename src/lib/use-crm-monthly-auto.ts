'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { sumAutoForMonths } from '@/lib/crm-auto-values';

// ─────────────────────────────────────────────────────────────────────────────
// La serie mensual del espejo del CRM (`crm_monthly_totals`), sumada sobre los
// períodos que la pantalla está mirando.
//
// UNA sola lectura de /api/admin/crm-monthly-totals para TODAS las métricas que
// la pantalla necesite. La primera versión de esto (2026-08-31, prop firm) hacía
// su propio fetch dentro de /movimientos y devolvía dos campos con nombre fijo;
// al cablear P2P y comisiones IB con el mismo criterio habrían sido tres
// efectos idénticos pidiendo el MISMO endpoint tres veces por render.
//
// `null` por métrica = no hay serie para ninguno de los meses activos. Es «no lo
// sabemos», no cero: quien lo consuma tiene que caer al manual, no mostrar $0.
// Un fallo de red deja TODAS las métricas en `null` por la misma razón.
// ─────────────────────────────────────────────────────────────────────────────

export interface CrmMonthlyAutoState {
  /** Suma de la serie por métrica. `null` = sin datos para los meses activos. */
  auto: Record<string, number | null>;
  /**
   * La respuesta vino recortada por el techo de filas del endpoint. Si esto es
   * `true` los totales de abajo pueden estar cortos y la pantalla lo dice.
   */
  truncated: boolean;
}

export function useCrmMonthlyAuto(
  activePeriods: ReadonlyArray<{ year: number; month: number }>,
  metrics: readonly string[],
  refreshKey: number = 0,
): CrmMonthlyAutoState {
  const empty = (): Record<string, number | null> =>
    Object.fromEntries(metrics.map((m) => [m, null]));

  const [state, setState] = useState<CrmMonthlyAutoState>(() => ({
    auto: empty(),
    truncated: false,
  }));

  // `metrics` llega como literal en el call site y cambiaría de identidad en
  // cada render: se compara por contenido para no re-pedir en bucle.
  const metricsKey = metrics.join(',');
  const monthsKey = activePeriods.map((p) => `${p.year}-${p.month}`).join(',');

  useEffect(() => {
    let cancel = false;
    (async () => {
      const keys = metricsKey ? metricsKey.split(',') : [];
      const blank = Object.fromEntries(keys.map((m) => [m, null])) as Record<
        string,
        number | null
      >;
      try {
        const res = await apiFetch('/api/admin/crm-monthly-totals');
        if (!res.ok || cancel) return;
        const json = (await res.json()) as {
          rows?: Array<{ year: number; month: number; metric: string; auto: number | null }>;
          truncated?: boolean;
        };
        const rows = json.rows ?? [];
        const months = new Set(monthsKey ? monthsKey.split(',') : []);
        const auto: Record<string, number | null> = { ...blank };
        for (const m of keys) auto[m] = sumAutoForMonths(rows, m, months);
        if (!cancel) setState({ auto, truncated: json.truncated === true });
      } catch {
        // Sin serie, cada consumidor cae a su valor manual con su rótulo.
        // No se inventa un $0.
        if (!cancel) setState({ auto: blank, truncated: false });
      }
    })();
    return () => {
      cancel = true;
    };
  }, [monthsKey, metricsKey, refreshKey]);

  return state;
}
