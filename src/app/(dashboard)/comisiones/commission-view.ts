// ─────────────────────────────────────────────────────────────────────────────
// /comisiones — decisiones de PRESENTACIÓN, puras y testeables.
//
// POR QUÉ (2026-10-12, migración al diseño «Libro mayor»): page.tsx tenía
// 3.693 líneas y 144 clases de paleta cruda; cada decisión visual (qué color
// lleva la procedencia del net deposit, cuándo un % es manual, cómo se rotula
// un rol) estaba escrita inline, a veces repetida en cuatro tablas. Acá vive
// UNA vez cada una. Nada de esto toca un número: los cálculos siguen enteros
// en commission-calculator.ts y los guardados en page.tsx.
//
// Medición del antes: 144 clases `(text|bg|border)-<paleta>-NNN`, 26 `dark:`
// de color, 24 `text-[10px]/[11px]`, 51 recetas de foco propias
// (`focus:ring-*`/`focus:outline-none`).
//
// DESCARTADO:
//   · Poner acá `applyTotalEarnedDebt` envuelto («total con deuda»): es una
//     regla de dinero (§2.1 #6) y se llama donde siempre — en page.tsx — para
//     que la tabla, el guardado y el PDF sigan saliendo del mismo camino.
//   · Mapear la procedencia a `StatusBadge`: «CRM» / «manual» no son estados
//     de un flujo sino fuentes de un número; van con la etiqueta de fuente de
//     Movimientos (`movimientos/source-tag.tsx`, spec §5.5 `.src`).
// ─────────────────────────────────────────────────────────────────────────────
import type { NetDepositSource } from '@/lib/hr/net-deposit-input';

/**
 * Rótulo visible de cada rol comercial. Lo leen también los PDF
 * (`ROLE_LABEL[profile.role] || profile.role`), así que es el MISMO mapa que
 * vivía en page.tsx, mudado sin cambiar un valor.
 */
export const ROLE_LABEL: Record<string, string> = {
  sales_manager: 'Sales Manager',
  head: 'HEAD',
  bdm: 'BDM',
  bdm_global: 'BDM GLOBAL',
};

/** Rótulo de un rol; un rol desconocido se muestra tal cual (nunca vacío). */
export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

/**
 * Cómo se rotula la PROCEDENCIA del insumo (net deposit, PnL o lotes).
 *
 *   crm    → etiqueta de fuente automática (`info`, como «API» en Movimientos)
 *   manual → etiqueta neutra + el automático al lado (quien corrige a mano ve
 *            contra qué corrige — la razón de existir del rótulo)
 *   frozen → etiqueta neutra «cerrado»
 *   none   → texto `text-3` «sin datos»: no hay número, y NO se muestra $0
 *            (reglas-del-proyecto §1.3)
 *
 * Antes: «manual» iba en ámbar (`text-warning`). Un override no requiere
 * acción de nadie — `pend` afirmaría algo falso (spec §2.1).
 */
export type NdSourceTagSpec =
  | { kind: 'api' | 'manual'; labelKey: string; showAuto: boolean }
  | { kind: 'none'; labelKey: string; showAuto: false };

export function ndSourceTag(source: NetDepositSource): NdSourceTagSpec {
  switch (source) {
    case 'crm':
      return { kind: 'api', labelKey: 'comm.ndSourceCrm', showAuto: false };
    case 'manual':
      return { kind: 'manual', labelKey: 'comm.ndSourceManual', showAuto: true };
    case 'frozen':
      return { kind: 'manual', labelKey: 'comm.ndSourceFrozen', showAuto: false };
    default:
      return { kind: 'none', labelKey: 'comm.ndSourceNone', showAuto: false };
  }
}

/**
 * ¿El campo del % del mes tiene un valor manual? Vacío (o un «-» a medio
 * teclear) = automático. Un «0» SÍ es manual: ese mes no cobra (§1.3).
 * Misma condición que tenía `PctOverrideInput` en page.tsx.
 */
export function isPctManual(value: string): boolean {
  const v = value.trim();
  return v !== '' && v !== '-';
}

/**
 * Resumen de la deuda arrastrada (`bonus` negativo del mes anterior) de un
 * conjunto de filas, para el aviso de la pestaña Individual.
 *
 * Sólo cuentan los negativos: `bonus` ≥ 0 es «sin deuda» (así lo lee
 * `applyTotalEarnedDebt`). El total se redondea a centavos para que el aviso
 * diga el mismo número que sumarían las filas.
 */
export function carriedDebtSummary(debts: readonly number[]): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (const d of debts) {
    if (Number.isFinite(d) && d < 0) {
      count += 1;
      sum += d;
    }
  }
  return { count, sum: Math.round(sum * 100) / 100 };
}

/**
 * Grupo del Historial. El Historial ya ordenaba Sales Manager → HEAD → BDM y
 * dibujaba una raya al cambiar de rol; ahora es una fila de grupo con conteo.
 * BDM GLOBAL va con los BDM (el orden original los mezclaba) y se distingue
 * por su etiqueta junto al nombre.
 */
export type HistoryGroup = 'sales_manager' | 'head' | 'bdm';

export function historyGroupKey(role: string): HistoryGroup {
  if (role === 'sales_manager') return 'sales_manager';
  if (role === 'head') return 'head';
  return 'bdm';
}

/** Rótulo de la fila de grupo del Historial. */
export function historyGroupLabel(key: string): string {
  if (key === 'sales_manager') return ROLE_LABEL.sales_manager;
  if (key === 'head') return ROLE_LABEL.head;
  return ROLE_LABEL.bdm;
}

/**
 * Cuántos perfiles de la lista no tienen usuario en el CRM (el PnL no se
 * puede cargar solo). Un perfil que no está en la respuesta del CRM
 * (`undefined`) NO cuenta: eso es «no se pidió» (mes cerrado) o «falló la
 * RPC», que ya tienen su propio aviso.
 */
export function countSinDatoCrm(
  ids: readonly string[],
  info: (id: string) => { sinDatoCrm: boolean } | undefined,
): number {
  let n = 0;
  for (const id of ids) if (info(id)?.sinDatoCrm) n += 1;
  return n;
}

/**
 * Rótulo de un período en selectores y cabeceras del Historial: el `label`
 * cargado, o «AAAA-MM». Estaba escrito cinco veces inline en page.tsx.
 */
export function periodLabel(p: { label: string | null; year: number; month: number }): string {
  return p.label || `${p.year}-${String(p.month).padStart(2, '0')}`;
}
