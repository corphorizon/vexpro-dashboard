// ─────────────────────────────────────────────────────────────────────────────
// El RELOJ del módulo RRHH: un mes de anclaje + un preset, y de ahí sale todo.
//
// ── El porqué ──────────────────────────────────────────────────────────────
// Hasta el 2026-08-31 el módulo tenía TRES relojes distintos y ninguno se
// hablaba con los otros:
//   1. La pestaña Comercial filtraba por preset (trimestre/semestre/año) contra
//      los períodos CONTABLES, anclada en un `period_id`.
//   2. Net Deposit (y su vista de producción IB) tenían su propio <input
//      type="month">, por defecto el mes anterior.
//   3. Las tarjetas de equipo traían el Net del CRM del MES CORRIENTE fijo,
//      hardcodeado en la página.
// Resultado: tres números en pantalla que decían "el mes" y eran tres meses
// distintos, sin que nada lo dijera. Ahora el ancla es UNA y vive en el
// contexto del módulo (rrhh/_components/hr-period-context.tsx).
//
// Este archivo es PURO a propósito: es la única decisión de "qué períodos entran"
// y se testea sin React ni base de datos.
// ─────────────────────────────────────────────────────────────────────────────

export const HR_PERIOD_PRESETS = [
  'total',
  'month',
  'quarter',
  'semester',
  'annual',
  'custom',
] as const;

export type HrPeriodPreset = (typeof HR_PERIOD_PRESETS)[number];

/** Lo mínimo que hace falta de un período contable para filtrar. */
export type PeriodoRef = { id: string; year: number; month: number };

/** `2026-08` — la forma canónica del ancla en todo el módulo. */
export type MesAncla = string;

export function esMesValido(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

/** El mes de un período contable, en la forma del ancla. */
export function mesDePeriodo(p: { year: number; month: number }): MesAncla {
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/**
 * El mes ANTERIOR al de `ref`. Es el que RRHH revisa: el corriente todavía
 * corre y sus números cambian mientras se los mira. Era el default de las
 * pestañas Net Deposit y Warnings, y queda como default del módulo entero.
 */
export function mesAnterior(ref: Date = new Date()): MesAncla {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function partesDelMes(month: MesAncla): { year: number; month: number } | null {
  if (!esMesValido(month)) return null;
  return { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
}

/**
 * Los períodos contables que entran en el cálculo, según el preset.
 *
 * Diferencia con la versión vieja (getFilteredPeriodIds en rrhh/page.tsx): el
 * ancla es un MES, no un `period_id`. Antes, si el período del ancla no existía
 * en la tabla, trimestre/semestre/año devolvían `[]` — o sea "cero pesos" con
 * cara de dato bueno. Ahora el trimestre de un mes se conoce sin que ese mes
 * tenga fila: se devuelven los períodos que existan dentro del rango, y si no
 * existe ninguno la lista vacía significa lo mismo que antes pero por el
 * motivo correcto.
 */
export function periodIdsForPreset(
  periods: readonly PeriodoRef[],
  preset: HrPeriodPreset,
  anchorMonth: MesAncla,
  customIds: readonly string[],
): string[] {
  if (preset === 'total') return periods.map((p) => p.id);
  if (preset === 'custom') return [...customIds];

  const ref = partesDelMes(anchorMonth);
  if (!ref) return [];

  if (preset === 'month') {
    return periods.filter((p) => p.year === ref.year && p.month === ref.month).map((p) => p.id);
  }
  if (preset === 'annual') {
    return periods.filter((p) => p.year === ref.year).map((p) => p.id);
  }
  if (preset === 'quarter') {
    const inicio = (Math.ceil(ref.month / 3) - 1) * 3 + 1;
    return periods
      .filter((p) => p.year === ref.year && p.month >= inicio && p.month <= inicio + 2)
      .map((p) => p.id);
  }
  // semester
  const [desde, hasta] = ref.month <= 6 ? [1, 6] : [7, 12];
  return periods
    .filter((p) => p.year === ref.year && p.month >= desde && p.month <= hasta)
    .map((p) => p.id);
}
