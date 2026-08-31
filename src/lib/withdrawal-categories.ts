// ─────────────────────────────────────────────────────────────────────────────
// Categorías de RETIRO — registro único, y por fin traducidas.
//
// POR QUÉ EXISTE (2026-08-31, auditoría de finanzas, ítem 15)
// Las mismas cuatro categorías estaban en CINCO lugares:
//   1. `types.ts` — el union de `Withdrawal['category']`.
//   2. `types.ts` — `WITHDRAWAL_LABELS`, castellano fijo.
//   3. `movimientos/page.tsx` — `ALL_CATEGORIES`, el orden de la tabla.
//   4. `upload/page.tsx` — cuatro `<option>` escritas a mano en el selector.
//   5. `socios/page.tsx` — que ya había tenido su propio mapa y lo cambió por
//      `WITHDRAWAL_LABELS` en una corrección anterior del mismo día.
//
// Y el bug que se ve: **la tarjeta de Retiros NO se traduce al inglés**.
// `WITHDRAWAL_LABELS` es castellano fijo, así que un usuario en inglés ve la
// columna Depósitos traducida (los canales SÍ pasan por i18n desde
// `deposit-channels.ts`) y justo al lado «Comisiones IB / Broker / Prop Firm /
// Otros» en castellano. El CSV exportado, igual: `handleExport` escribe los
// encabezados traducidos y las filas de retiro en castellano.
//
// Es el simétrico exacto de `deposit-channels.ts` y usa el mismo mecanismo:
// clave i18n `movements.categoryLabel.<categoría>`, con el castellano de
// `WITHDRAWAL_LABELS` como respaldo si la clave faltara.
//
// CLIENT-SAFE: no importa Supabase ni nada de servidor.
// ─────────────────────────────────────────────────────────────────────────────

import { WITHDRAWAL_LABELS, type Withdrawal } from './types';

/** Clave tal como se guarda en `withdrawals.category`. */
export type WithdrawalCategory = Withdrawal['category'];

/**
 * Las cuatro categorías, EN EL ORDEN DE PANTALLA. Ese orden es parte del
 * registro: la tabla de /movimientos y el selector de /upload lo comparten, y
 * cuando cada uno tenía el suyo no había forma de saber cuál era el bueno.
 */
export const ALL_WITHDRAWAL_CATEGORIES: readonly WithdrawalCategory[] = [
  'ib_commissions',
  'broker',
  'prop_firm',
  'other',
] as const;

/**
 * Categorías que NO suman a «Retiros Totales» ni al Net Deposit.
 *
 * `broker` sí suma (es el suplemento Coinsbuy que la API no alcanzó a
 * reportar — decisión de Kevin del 2026-06-06, ver broker-logic.ts). Las otras
 * tres son informativas: el usuario las carga y se muestran, pero los retiros
 * REALES ya están contados en el total de la API. Comisiones IB además es deuda
 * interna con el IB, no caja (ver crm-monthly.ts).
 *
 * Está acá para que «esta fila no suma» se pueda preguntar en vez de recordarse.
 */
export const INFORMATIONAL_WITHDRAWAL_CATEGORIES: readonly WithdrawalCategory[] = [
  'ib_commissions',
  'prop_firm',
  'other',
] as const;

export function isInformationalWithdrawal(category: string): boolean {
  return (INFORMATIONAL_WITHDRAWAL_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Etiqueta traducida de la categoría. La clave i18n es
 * `movements.categoryLabel.<categoría>`; si falta, cae a `WITHDRAWAL_LABELS`
 * (castellano), que es lo que se mostraba antes de que esto se tradujera.
 *
 * Mismo contrato que `depositChannelLabel`: el respaldo existe para que una
 * clave olvidada muestre el nombre viejo y no la clave cruda en pantalla.
 */
export function withdrawalCategoryLabel(
  category: string,
  t: (key: string) => string,
): string {
  const key = `movements.categoryLabel.${category}`;
  const translated = t(key);
  return translated === key ? WITHDRAWAL_LABELS[category] ?? category : translated;
}
