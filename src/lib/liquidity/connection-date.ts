// ─────────────────────────────────────────────────────────────────────────────
// La fecha de conexión de una cuenta al pool: validarla y mostrarla.
//
// ── POR QUÉ SE PUEDE EDITAR ────────────────────────────────────────────────
// Al agregar una cuenta, la fecha de conexión es hoy: el PnL se mide desde que
// entró al pool. Pero para validar el módulo hace falta cargar cuentas que YA
// venían operando y ver su historia — con la fecha de hoy el PnL arrancaría
// vacío y no habría nada que comparar.
//
// ── ESTE ARCHIVO NO TOCA MT5 NI LA BASE, A PROPÓSITO ───────────────────────
// Lo importa la pantalla, que es un componente de cliente. El recálculo del
// PnL —que sí abre MT5— vive en `monthly-pnl-calculator.ts`: tenerlo acá
// arrastraría el cliente MySQL al bundle del navegador.
// ─────────────────────────────────────────────────────────────────────────────


/** Nada anterior a esto es una conexión real: es un dedazo o un dato corrupto.
 *  Sin piso, un año tipeado mal (1900) haría que el calculador recorriera dos
 *  siglos de calendario y devolviera una tabla sin sentido. */
const PISO = Date.UTC(2000, 0, 1);

/**
 * `DD/MM/YYYY` leyendo el instante en UTC.
 *
 * `formatDate` del repo usa `getDate()`, que es hora local: con la conexión
 * guardada a las 00:00 UTC, un navegador en UTC-5 mostraría el día anterior.
 * Acá la fecha de conexión ES un día —no un instante—, así que se lee en el
 * mismo huso en el que se guardó.
 */
export function formatFechaConexion(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

export type FechaValidada =
  | { ok: true; fecha: Date }
  | { ok: false; error: string };

/**
 * Valida lo que llega del cliente. Devuelve el error en castellano listo para
 * mostrar: quien lo llama no tiene que redactar el mensaje, así los dos
 * endpoints dicen exactamente lo mismo ante el mismo dato malo.
 *
 * Acepta `YYYY-MM-DD` (lo que manda un <input type="date">) y también un ISO
 * completo.
 *
 * ── EL DÍA ARRANCA A LAS 00:00 UTC, NO A MEDIODÍA ──────────────────────────
 * La primera versión anclaba a las 12:00 para que `formatDate` —que usa hora
 * local— no mostrara el día anterior en un navegador al oeste de UTC. Costó
 * medio día de operaciones: la cuenta 136773, conectada el 06/03, daba
 * -2.662,49 en marzo contra los -3.437,67 que mostraba el MT5 Manager. Las 17
 * operaciones que faltaban eran de esa madrugada, entre las 02h y las 03h.
 *
 * "Conectada el 6 de marzo" significa desde el arranque del 6 de marzo. El
 * problema de cómo se ve la fecha se arregla donde se ve —formateándola en
 * UTC—, no corriendo el instante que se guarda.
 */
export function validarFechaConexion(valor: unknown): FechaValidada {
  const texto = String(valor ?? '').trim();
  if (!texto) return { ok: false, error: 'Falta la fecha de conexión.' };

  const soloDia = /^\d{4}-\d{2}-\d{2}$/.test(texto);
  // La `Z` explícita es lo que evita el corrimiento de día: sin ella, el
  // navegador interpretaría el texto en su propio huso. Con ella, las 00:00
  // UTC son las 00:00 UTC en todas partes.
  const fecha = new Date(soloDia ? `${texto}T00:00:00.000Z` : texto);

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
