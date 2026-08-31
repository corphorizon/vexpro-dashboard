// ─────────────────────────────────────────────────────────────────────────────
// «El automático del CRM manda; el manual, si existe, es un override» — la
// regla, en una sola función pura.
//
// POR QUÉ EXISTE (2026-08-31, auditoría de finanzas, ítems 17 y 18)
// La regla se escribió por primera vez el mismo día, a mano y en línea, para
// prop firm en /movimientos (`pfAuto`). Al cablear P2P y comisiones IB con el
// MISMO criterio, la alternativa era copiarla dos veces más: cuatro copias de
// una decisión sobre dinero en un archivo de UI, que es el modo de falla número
// uno del repo. Acá vive una vez y se testea.
//
// LA REGLA, y por qué cada rama es así:
//
//   · Período HISTÓRICO (≤ mar-2026) → manda el MANUAL, siempre. Los meses
//     viejos se cargaron a mano y se distribuyeron con esos números; que una
//     serie calculada hoy les cambie el pasado sería reescribir plata ya
//     repartida.
//
//   · Período DERIVADO con manual > 0 → manda el MANUAL, rotulado como
//     override. Alguien tecleó un número a sabiendas y el sistema no le pisa la
//     decisión. Caso real: `p2p_transfers` tiene UN solo período cargado en
//     toda la historia de Vex Pro (nov-2025, $9.787,04) y coincide al centavo
//     con el automático — el override no cambia nada y aun así se respeta,
//     porque la regla no puede depender de que los dos números coincidan.
//
//   · Período DERIVADO sin manual y CON serie → manda el AUTOMÁTICO, rotulado
//     'api'. Es el arreglo: la fila mostraba $0,00 hace meses contra una serie
//     que sí tenía el dato.
//
//   · Período DERIVADO sin manual y SIN serie → manda el manual (aunque sea 0),
//     rotulado 'manual'. `null` es «no lo sabemos», y no lo sabemos NO habilita
//     a inventar un número.
//
// ⚠ `manual > 0` y no `manual !== 0`: un 0 cargado a mano es indistinguible del
// 0 que trae el formulario vacío (el default del input es 0 — ver §6 de las
// reglas del proyecto: «ND = 0 es indistinguible de no cargado»). Tratar ese 0
// como un override deliberado dejaría la fila en cero para siempre, que es
// exactamente el bug que se está arreglando.
// ─────────────────────────────────────────────────────────────────────────────

/** De dónde salió el número que se muestra. La pantalla lo rotula. */
export type AutoValueSource = 'manual' | 'api';

export interface ResolvedAutoValue {
  value: number;
  source: AutoValueSource;
}

export function resolveAutoOrManual(input: {
  /** ¿El período usa la regla derivada (abr-2026+)? */
  derived: boolean;
  /** Lo cargado a mano. 0 = no cargó nada (ver la nota de arriba). */
  manual: number;
  /** La serie del espejo del CRM. `null` = sin dato para ese mes, NO cero. */
  auto: number | null;
}): ResolvedAutoValue {
  const { derived, manual, auto } = input;
  if (!derived) return { value: manual, source: 'manual' };
  if (manual > 0) return { value: manual, source: 'manual' };
  if (auto === null) return { value: manual, source: 'manual' };
  return { value: auto, source: 'api' };
}

/**
 * Suma la serie automática de una métrica sobre los meses activos.
 *
 * `null` si NINGÚN mes activo tiene dato: sumar los que sí tienen y presentar
 * el resultado como el total de un consolidado de seis meses sería un número
 * más chico que el real sin ningún aviso. Con al menos un mes con dato se
 * devuelve la suma de esos — y el consolidado que mezcla meses con y sin serie
 * es un caso que la pantalla ya trata como «derivado sólo si TODOS lo son».
 */
export function sumAutoForMonths(
  rows: ReadonlyArray<{ year: number; month: number; metric: string; auto: number | null }>,
  metric: string,
  months: ReadonlySet<string>,
): number | null {
  let total: number | null = null;
  for (const r of rows) {
    if (r.metric !== metric) continue;
    if (!months.has(`${r.year}-${r.month}`)) continue;
    if (r.auto === null) continue; // sin dato ≠ 0
    total = (total ?? 0) + r.auto;
  }
  return total;
}
