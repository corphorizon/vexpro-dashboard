// ─────────────────────────────────────────────────────────────────────────────
// La fecha de conexión de una cuenta al pool: validación y recálculo.
//
// ── POR QUÉ SE PUEDE EDITAR ────────────────────────────────────────────────
// Al agregar una cuenta, la fecha de conexión es hoy: el PnL se mide desde que
// entró al pool. Pero para validar el módulo hace falta cargar cuentas que YA
// venían operando y ver su historia — con la fecha de hoy el PnL arrancaría
// vacío y no habría nada que comparar.
//
// ── LO QUE HACE PELIGROSO CAMBIARLA ────────────────────────────────────────
// El PnL mensual NO se calcula al leer: se calcula una vez y se guarda en
// `platform_liquidity_monthly_pnl`. Esas filas son un DERIVADO de esta fecha.
//
// El guardado usa `upsert`, que agrega y pisa pero nunca borra. Entonces mover
// la fecha hacia adelante dejaría vivos los meses del rango viejo —meses en los
// que la cuenta ya no estaba en el pool— sumando al total sin que nada avise.
// Es exactamente el modo de falla que este repo persigue: un número plausible
// y equivocado, sin excepción de por medio.
//
// Por eso `recalcularPnlMensual` BORRA y vuelve a calcular, en vez de upsertear
// encima.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { calculateMonthlyPnL } from '@/lib/liquidity/monthly-pnl-calculator';

/** Nada anterior a esto es una conexión real: es un dedazo o un dato corrupto.
 *  Sin piso, un año tipeado mal (1900) haría que el calculador recorriera dos
 *  siglos de calendario y devolviera una tabla sin sentido. */
const PISO = Date.UTC(2000, 0, 1);

export type FechaValidada =
  | { ok: true; fecha: Date }
  | { ok: false; error: string };

/**
 * Valida lo que llega del cliente. Devuelve el error en castellano listo para
 * mostrar: quien lo llama no tiene que redactar el mensaje, así los dos
 * endpoints dicen exactamente lo mismo ante el mismo dato malo.
 *
 * Acepta `YYYY-MM-DD` (lo que manda un <input type="date">) y también un ISO
 * completo. El primero se ancla a mediodía UTC a propósito: a medianoche, un
 * navegador en UTC-5 corre la fecha al día anterior y el mes de conexión sale
 * cambiado.
 */
export function validarFechaConexion(valor: unknown): FechaValidada {
  const texto = String(valor ?? '').trim();
  if (!texto) return { ok: false, error: 'Falta la fecha de conexión.' };

  const soloDia = /^\d{4}-\d{2}-\d{2}$/.test(texto);
  const fecha = new Date(soloDia ? `${texto}T12:00:00.000Z` : texto);

  if (Number.isNaN(fecha.getTime())) {
    return { ok: false, error: 'La fecha de conexión no es válida.' };
  }
  if (fecha.getTime() < PISO) {
    return { ok: false, error: 'La fecha de conexión no puede ser anterior al año 2000.' };
  }
  // Un margen de un día cubre la diferencia de reloj entre el navegador y el
  // servidor sin dejar pasar una fecha futura de verdad. Con una fecha futura
  // el PnL sale vacío y la cuenta parece no haber operado nunca.
  if (fecha.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    return { ok: false, error: 'La fecha de conexión no puede estar en el futuro.' };
  }

  return { ok: true, fecha };
}

/**
 * Rehace el PnL mensual de una cuenta para una fecha de conexión nueva.
 *
 * Borra primero. El `upsert` solo no alcanza: los meses del rango anterior que
 * ya no entran en el nuevo se quedarían, y una fila vieja y una nueva se ven
 * idénticas en la tabla.
 *
 * Devuelve cuántos meses quedaron, o lanza si MT5 no responde — el llamador
 * decide si eso corta la operación o sólo avisa.
 */
export async function recalcularPnlMensual(
  admin: SupabaseClient,
  cuenta: { id: string; company_id: string; mt5_account: string },
  fechaConexion: Date,
): Promise<number> {
  const pnl = await calculateMonthlyPnL(cuenta.company_id, cuenta.mt5_account, fechaConexion);

  // El borrado va DESPUÉS del cálculo: si MT5 falla, la cuenta se queda con el
  // PnL viejo —desactualizado pero coherente— en vez de quedarse sin ninguno.
  const { error: eBorrado } = await admin
    .from('platform_liquidity_monthly_pnl')
    .delete()
    .eq('account_id', cuenta.id);
  if (eBorrado) throw new Error(`No se pudo limpiar el PnL anterior: ${eBorrado.message}`);

  if (pnl.length === 0) return 0;

  const { error } = await admin
    .from('platform_liquidity_monthly_pnl')
    .insert(pnl.map((m) => ({ account_id: cuenta.id, ...m })));
  if (error) throw new Error(`No se pudo guardar el PnL mensual: ${error.message}`);

  return pnl.length;
}
