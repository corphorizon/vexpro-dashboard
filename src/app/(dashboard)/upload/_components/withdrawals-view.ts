// ─────────────────────────────────────────────────────────────────────────────
// Retiros de /upload: qué fila es automática y cuánto suma el pie.
//
// POR QUÉ (2026-10-12, migración «Libro mayor» de /upload): estas dos
// decisiones estaban dentro del JSX de la tabla (un `map` y un `reduce` en el
// <tfoot>). Al extraer la pestaña a `withdrawals-panel.tsx` se sacan a
// funciones puras, COPIADAS tal cual, para poder fijarlas con un test: el pie
// de Retiros es un número de dinero y una migración de presentación no puede
// moverlo ni un centavo.
//
// La regla que fija el pie (la escribió quien cableó el IB automático):
//   · cada fila entra por su monto manual, salvo el IB, que entra por su valor
//     EFECTIVO (`ibEffective.value`: el del espejo del CRM si nadie lo tecleó);
//   · el broker derivado de las APIs se SUMA aparte cuando el período usa la
//     lógica derivada, porque el input de la fila broker es un ajuste manual
//     que convive con él.
// Con las dos puntas alineadas el total es idéntico al de antes del IB
// automático: cambia el REPARTO entre Broker e IB, no la suma.
//
// DESCARTADO: recalcular acá `ibEffective` / `derivedBrokerAmount`. Los
// calcula page.tsx (useMemo sobre el espejo y las APIs); esto sólo los usa.
// ─────────────────────────────────────────────────────────────────────────────

export interface WithdrawalLike {
  id: string;
  category: string;
  amount: number;
}

export interface WithdrawalAutoContext {
  /** El período usa la lógica de broker derivado (API). */
  brokerIsDerived: boolean;
  derivedBrokerAmount: number;
  /** Valor efectivo del IB y de dónde salió ('api' = espejo del CRM). */
  ibEffective: { value: number; source: string };
}

export interface WithdrawalRowFlags {
  /** Fila broker en un período derivado: muestra el monto API al lado del manual. */
  isBrokerAutoRow: boolean;
  /** Fila IB tomada del espejo del CRM (nadie la tecleó). */
  isIbAutoRow: boolean;
}

export function withdrawalRowFlags(w: WithdrawalLike, ctx: WithdrawalAutoContext): WithdrawalRowFlags {
  return {
    isBrokerAutoRow: w.category === 'broker' && ctx.brokerIsDerived,
    isIbAutoRow: w.category === 'ib_commissions' && ctx.ibEffective.source === 'api',
  };
}

/** Total del pie de Retiros. Ver la cabecera: IB por su valor efectivo + broker derivado. */
export function withdrawalsFormTotal(rows: readonly WithdrawalLike[], ctx: WithdrawalAutoContext): number {
  return (
    rows.reduce((s, w) => s + (w.category === 'ib_commissions' ? ctx.ibEffective.value : w.amount), 0) +
    (ctx.brokerIsDerived ? ctx.derivedBrokerAmount : 0)
  );
}
