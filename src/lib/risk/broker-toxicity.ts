// ─────────────────────────────────────────────────────────────────────────────
// Toxicidad hacia el BRÓKER: cuánto le cuesta esta cuenta a la casa.
//
// ── POR QUÉ ES UN MÓDULO APARTE ────────────────────────────────────────────
// `account-review.ts` responde «cómo opera este cliente» — martingala, grid,
// duraciones. Esto responde otra cosa: «esta operativa extrae valor de la
// ejecución». Son casi opuestas: una cuenta con martingala y sin stop es
// pésima para el CLIENTE y excelente negocio para la casa; una que arbitra
// latencia es lo contrario.
//
// Mezclarlas en un solo puntaje daría un número que no significa nada. Van
// separadas, con su propio vocabulario y su propio nivel.
//
// ── LO QUE SE MIDIÓ ANTES DE ESCRIBIR ESTO (2026-08-31, Vex Pro) ───────────
//
//  · `MarketBid`/`MarketAsk` están COMPLETOS: 6.248 de 6.248 filas. Y las
//    ejecuciones caen EXACTAMENTE en el bid o el ask. Eso es lo que hace útil
//    la señal de ejecución: no hay ruido de fondo, así que cualquier desvío
//    sistemático a favor del cliente destaca solo.
//
//  · `Gateway` y `Dealer` vienen VACÍOS. El análisis de ruteo —saber si pasó
//    por la mesa o fue directo al LP— no se puede hacer. Se descartó.
//
//  · `Reason = 16` no es un valor estándar de MT5 (define 0..9). Mirando los
//    deals: `Entry = 3` y comentario `#2092250 by #2092242`. Es CLOSE-BY,
//    cerrar una posición contra otra opuesta. En la cuenta 137983 concentra
//    -24.548 contra +15.974 del resto.
//
//  · `Reason = MOBILE` NO significa que operó una persona: la cuenta 137983
//    tiene 259 operaciones móviles con comentario «EMABOT R1 M1». El bot vive
//    en `Comment`, porque `ExpertID` viene en 0. Clasificar sólo por `Reason`
//    diría «manual» donde hay cuatro variantes de un EA.
//
//  · `Reason = STOP LOSS` aparece con ganancia POSITIVA: son trailing stops.
//    La cuenta 152870 cerró 701 operaciones así, +63.847 en total, con una
//    duración media de 57 minutos. Por eso «tasa de acierto alta» NO alcanza
//    como señal: marcaría cuentas sanas. Hace falta cruzarla con duración.
//
//  · Las cuentas Cent están en CENTAVOS (regla G3). Los importes de este
//    módulo son comparativos dentro de la misma cuenta —ratios y porcentajes—
//    justamente para no depender de eso.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trade } from '@/lib/risk/types';

// ── Los `Reason` de MT5 ────────────────────────────────────────────────────
export const MOTIVOS: Record<number, string> = {
  0: 'Escritorio',
  1: 'Móvil',
  2: 'Web',
  3: 'Experto (bot)',
  4: 'Stop loss',
  5: 'Take profit',
  6: 'Stop out',
  7: 'Rollover',
  8: 'Margen variable',
  9: 'Split',
  16: 'Cierre contra otra posición',
};

export function nombreMotivo(r: number | null | undefined): string {
  if (r === null || r === undefined) return 'Sin dato';
  return MOTIVOS[r] ?? `Motivo ${r}`;
}

/** Segundos por debajo de los cuales una operación es «relámpago». */
export const SEGUNDOS_RELAMPAGO = 60;
/** Mínimo de operaciones para que un porcentaje signifique algo. */
export const MINIMO_OPERACIONES = 20;

export interface ConteoMotivo {
  reason: number;
  label: string;
  count: number;
  pct: number;
  pnl: number;
}

export interface Origen {
  /** De dónde vino cada apertura. */
  aperturas: ConteoMotivo[];
  /** Cómo terminó cada operación (stop, take profit, cierre contra otra…). */
  cierres: ConteoMotivo[];
  /**
   * Nombres de EA encontrados en los comentarios.
   *
   * Es la identidad REAL del bot: `ExpertID` viene en 0 en este bróker. Varias
   * variantes numeradas del mismo nombre («EMABOT R1 M1…M4») son la firma de
   * una escalera de grid.
   */
  bots: Array<{ name: string; count: number }>;
  /**
   * `true` si hay comentarios de EA aunque el `Reason` diga móvil o escritorio.
   * Es el caso que rompe la lectura ingenua de `Reason`.
   */
  botDisfrazado: boolean;
}

export interface Ejecucion {
  /** Operaciones donde se pudo comparar contra el mercado. */
  comparables: number;
  /** Ejecutadas a favor del cliente (compra bajo el ask, venta sobre el bid). */
  aFavor: number;
  /** Ejecutadas en contra. */
  enContra: number;
  /** Exactamente al precio de mercado — lo normal en este bróker. */
  enMercado: number;
  /** `aFavor / comparables`, en porcentaje. */
  pctAFavor: number;
  /** Spread medio al abrir, en unidades del símbolo. `null` si no se pudo. */
  spreadMedio: number | null;
}

export type NivelToxico = 'ok' | 'medio' | 'alto';

export interface SenalToxica {
  key: string;
  label: string;
  /** `null` = no se pudo comprobar. No es lo mismo que «limpio». */
  hit: boolean | null;
  detail: string;
}

export interface BrokerToxicity {
  origen: Origen;
  ejecucion: Ejecucion;
  senales: SenalToxica[];
  /** Cuántas señales dieron positivo. */
  flagged: number;
  level: NivelToxico;
}

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Agrupa por `Reason` y ordena por frecuencia. */
function contarMotivos(trades: Trade[], cual: 'openReason' | 'closeReason'): ConteoMotivo[] {
  const acc = new Map<number, { count: number; pnl: number }>();
  let total = 0;
  for (const t of trades) {
    const r = t[cual];
    if (r === undefined || r === null) continue;
    total += 1;
    const a = acc.get(r) ?? { count: 0, pnl: 0 };
    a.count += 1;
    a.pnl += t.profit + t.swap + t.commission;
    acc.set(r, a);
  }
  return [...acc.entries()]
    .map(([reason, a]) => ({
      reason,
      label: nombreMotivo(reason),
      count: a.count,
      pct: pct(a.count, total),
      pnl: r2(a.pnl),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Nombres de EA a partir de los comentarios.
 *
 * Se descartan los comentarios que MT5 genera solo —los `#123 by #456` de un
 * cierre contra otra posición— porque no son el nombre de nada: son un
 * identificador distinto en cada operación, y contarlos daría cientos de «bots»
 * inexistentes.
 */
function detectarBots(trades: Trade[]): Array<{ name: string; count: number }> {
  const acc = new Map<string, number>();
  for (const t of trades) {
    const c = (t.comment ?? '').trim();
    if (!c) continue;
    if (/^#\d+\s+by\s+#\d+$/i.test(c)) continue;
    // Un comentario que es sólo un número tampoco identifica nada.
    if (/^[\d.\-\s]+$/.test(c)) continue;
    acc.set(c, (acc.get(c) ?? 0) + 1);
  }
  return [...acc.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

/**
 * Calidad de ejecución contra el mercado del momento.
 *
 * Una COMPRA debería pagar el ask; si pagó menos, la ejecución fue a favor del
 * cliente. Una VENTA debería cobrar el bid; si cobró más, ídem.
 *
 * Se mira la APERTURA: es donde el cliente elige el instante. En el cierre
 * pueden intervenir stops y trailing, que no son decisión suya.
 */
export function analizarEjecucion(trades: Trade[]): Ejecucion {
  let comparables = 0;
  let aFavor = 0;
  let enContra = 0;
  let enMercado = 0;
  let sumaSpread = 0;
  let conSpread = 0;

  for (const t of trades) {
    const bid = t.openBid ?? 0;
    const ask = t.openAsk ?? 0;
    if (!(bid > 0) || !(ask > 0) || !(t.openPrice > 0)) continue;
    comparables += 1;
    if (ask > bid) { sumaSpread += ask - bid; conSpread += 1; }

    const referencia = t.type === 'buy' ? ask : bid;
    // Tolerancia de medio tick implícita: se comparan iguales cuando la
    // diferencia es cero. Los precios vienen ya redondeados a los dígitos del
    // símbolo, así que no hace falta épsilon.
    if (t.openPrice === referencia) enMercado += 1;
    else if (t.type === 'buy' ? t.openPrice < ask : t.openPrice > bid) aFavor += 1;
    else enContra += 1;
  }

  return {
    comparables,
    aFavor,
    enContra,
    enMercado,
    pctAFavor: pct(aFavor, comparables),
    spreadMedio: conSpread > 0 ? r2(sumaSpread / conSpread) : null,
  };
}

export function analizarOrigen(trades: Trade[]): Origen {
  const bots = detectarBots(trades);
  // «Disfrazado» = hay nombre de EA pero el motivo de apertura dice humano.
  const humanas = new Set([0, 1, 2]); // escritorio, móvil, web
  const botDisfrazado =
    bots.length > 0 &&
    trades.some((t) => (t.comment ?? '').trim() !== '' && humanas.has(t.openReason ?? -1));

  return {
    aperturas: contarMotivos(trades, 'openReason'),
    cierres: contarMotivos(trades, 'closeReason'),
    bots,
    botDisfrazado,
  };
}

/**
 * Las señales de toxicidad hacia el bróker.
 *
 * Ninguna decide sola: `level` sale de cuántas dieron positivo. Y `hit = null`
 * es «no se pudo comprobar», que NO cuenta como limpio — la diferencia importa
 * cuando faltan datos de mercado.
 */
export function evaluarToxicidad(
  trades: Trade[],
  /**
   * Cobertura con OTRAS cuentas del mismo cliente, si el llamador la calculó.
   *
   * Se pasa desde afuera porque no se puede ver mirando una cuenta sola: hace
   * falta cruzarla contra las demás del cliente. `undefined` deja la señal en
   * «no comprobada» en vez de darla por limpia.
   */
  cobertura?: { pares: number; conCuentas: number[] },
): BrokerToxicity {
  const origen = analizarOrigen(trades);
  const ejecucion = analizarEjecucion(trades);
  const n = trades.length;
  const senales: SenalToxica[] = [];

  const pocas = n < MINIMO_OPERACIONES;

  // ── 1. Ejecución a favor del cliente ──────────────────────────────────
  // La más fuerte. En este bróker las ejecuciones caen exactamente en el bid o
  // el ask, así que un desvío sistemático a favor no es ruido.
  senales.push({
    key: 'ejecucion_favorable',
    label: 'Ejecución mejor que el mercado',
    hit: ejecucion.comparables < MINIMO_OPERACIONES ? null : ejecucion.pctAFavor >= 5,
    detail:
      ejecucion.comparables < MINIMO_OPERACIONES
        ? `Sólo ${ejecucion.comparables} operación(es) con precio de mercado: no alcanza para medirlo.`
        : `${ejecucion.aFavor} de ${ejecucion.comparables} (${ejecucion.pctAFavor}%) se ejecutaron a favor del cliente. ` +
          `${ejecucion.enMercado} exactamente en el mercado, ${ejecucion.enContra} en contra.`,
  });

  // ── 2. Ganador relámpago ──────────────────────────────────────────────
  // Las tres condiciones JUNTAS. Por separado no sirven: la cuenta 152870
  // tiene 98% de acierto y NO es arbitraje —son trailing stops, 57 minutos de
  // duración media.
  const relampago = trades.filter((t) => t.durationMinutes * 60 < SEGUNDOS_RELAMPAGO);
  const netoRelampago = relampago.reduce((s, t) => s + t.profit + t.swap + t.commission, 0);
  const ganadasRelampago = relampago.filter((t) => t.profit > 0).length;
  const aciertoRelampago = pct(ganadasRelampago, relampago.length);
  senales.push({
    key: 'ganador_relampago',
    label: 'Gana consistente en operaciones de menos de un minuto',
    hit: relampago.length < MINIMO_OPERACIONES ? null : aciertoRelampago >= 80 && netoRelampago > 0,
    detail:
      relampago.length < MINIMO_OPERACIONES
        ? `Sólo ${relampago.length} operación(es) de menos de ${SEGUNDOS_RELAMPAGO} s: no alcanza para medirlo.`
        : `${relampago.length} operaciones de menos de un minuto, ${aciertoRelampago}% ganadas, ` +
          `neto ${r2(netoRelampago)}.`,
  });

  // ── 3. Ganancia del tamaño del spread ─────────────────────────────────
  // Si lo que gana por operación se parece al spread que pagó, no está
  // operando la dirección del mercado: está cobrando la horquilla.
  const conMercado = trades.filter((t) => (t.openAsk ?? 0) > (t.openBid ?? 0) && t.profit > 0);
  let hitSpread: boolean | null = null;
  let detalleSpread = `Sólo ${conMercado.length} operación(es) ganadoras con precio de mercado: no alcanza.`;
  if (conMercado.length >= MINIMO_OPERACIONES) {
    const cercanas = conMercado.filter((t) => {
      const spread = (t.openAsk ?? 0) - (t.openBid ?? 0);
      if (!(spread > 0) || !(t.volume > 0)) return false;
      // Movimiento capturado por unidad, comparado con el spread pagado.
      const recorrido = Math.abs(t.closePrice - t.openPrice);
      return recorrido > 0 && recorrido <= spread * 2;
    });
    const p = pct(cercanas.length, conMercado.length);
    hitSpread = p >= 50;
    detalleSpread = `${cercanas.length} de ${conMercado.length} ganadoras (${p}%) recorrieron menos de dos spreads.`;
  }
  senales.push({
    key: 'captura_spread',
    label: 'Ganancias del tamaño del spread',
    hit: hitSpread,
    detail: detalleSpread,
  });

  // ── 4. Operar en el rollover ──────────────────────────────────────────
  // Entre las 23:59 y las 00:01 se aplica el swap. Concentrar actividad ahí es
  // arbitraje de swap, no operativa.
  const enRollover = trades.filter((t) => {
    const h = t.openTime.getUTCHours();
    const m = t.openTime.getUTCMinutes();
    return (h === 23 && m >= 59) || (h === 0 && m <= 1);
  });
  const pctRollover = pct(enRollover.length, n);
  senales.push({
    key: 'rollover',
    label: 'Opera en el minuto del rollover',
    hit: pocas ? null : pctRollover >= 10,
    detail: pocas
      ? `Sólo ${n} operación(es): no alcanza para medirlo.`
      : `${enRollover.length} de ${n} (${pctRollover}%) abrieron entre las 23:59 y las 00:01 UTC.`,
  });

  // ── 5. Cierre contra otra posición ────────────────────────────────────
  // El `Reason = 16`. Cerrar una posición contra su opuesta neutraliza el
  // riesgo direccional; en volumen es extracción, no operativa.
  const closeBy = trades.filter((t) => t.closeReason === 16).length;
  const pctCloseBy = pct(closeBy, n);
  senales.push({
    key: 'cierre_contra_opuesta',
    label: 'Cierra posiciones contra sus opuestas',
    hit: pocas ? null : pctCloseBy >= 20,
    detail: pocas
      ? `Sólo ${n} operación(es): no alcanza para medirlo.`
      : `${closeBy} de ${n} (${pctCloseBy}%) cerraron contra una posición opuesta de la misma cuenta.`,
  });

  // ── 6. Cobertura con otras cuentas del mismo cliente ──────────────────
  // Posiciones opuestas, mismo símbolo, mismo instante, en cuentas distintas.
  // En conjunto el riesgo de mercado es cero: lo que queda es lo que se extrae
  // del bróker. Es la contracara de la detección de copia, que busca la MISMA
  // dirección.
  senales.push({
    key: 'cobertura_entre_cuentas',
    label: 'Se cubre con otras cuentas del mismo cliente',
    hit: cobertura === undefined ? null : cobertura.pares > 0,
    detail:
      cobertura === undefined
        ? 'No se comprobó — hace falta cruzar esta cuenta con las demás del cliente.'
        : cobertura.pares > 0
          ? `${cobertura.pares} par(es) de posiciones opuestas simultáneas con la(s) cuenta(s) ` +
            `${cobertura.conCuentas.join(', ')}.`
          : 'Ninguna posición opuesta simultánea con las otras cuentas del cliente.',
  });

  const flagged = senales.filter((s) => s.hit === true).length;
  // Dos o más señales para «alto». Una sola puede tener explicación honesta;
  // dos que coinciden ya no.
  const level: NivelToxico = flagged >= 2 ? 'alto' : flagged === 1 ? 'medio' : 'ok';

  return { origen, ejecucion, senales, flagged, level };
}
