// ─────────────────────────────────────────────────────────────────────────────
// Cobertura entre cuentas DISTINTAS del mismo cliente.
//
// ── QUÉ BUSCA Y POR QUÉ IMPORTA ────────────────────────────────────────────
// Dos posiciones opuestas —una compra y una venta— sobre el MISMO símbolo, en
// el MISMO instante, en cuentas DISTINTAS. En conjunto el riesgo de mercado es
// cero: una gana lo que la otra pierde. Lo que queda es lo que se extrae del
// bróker — bono, rebate, o simplemente el spread pagado de un lado y cobrado
// del otro.
//
// Es la contracara de la detección de copia: aquélla busca la MISMA dirección
// —alguien replicando una señal—, ésta busca la OPUESTA. Son el mismo gesto
// técnico con intenciones opuestas, y por eso viven separadas.
//
// ── POR QUÉ ES BARATO ──────────────────────────────────────────────────────
// No consulta MT5. El análisis por cliente ya carga todas sus cuentas juntas
// —`loadTradesByLogin` devuelve un mapa login → operaciones— así que el cruce
// se hace sobre lo que ya está en memoria.
//
// ── EL ALCANCE ES EL MISMO CLIENTE, A PROPÓSITO ────────────────────────────
// Cruzar todas las cuentas del bróker contra todas es cuadrático y no cabe en
// una función. Y el caso que importa es éste: alguien abriendo las dos puntas
// en cuentas propias. La coordinación entre clientes distintos se detecta por
// otro camino —IP y nombre compartidos— y ya existe en `copy-detection.ts`.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trade } from '@/lib/risk/types';
import { VENTANA_SEGUNDOS } from '@/lib/risk/copy-detection';

/**
 * Cuánto puede diferir el volumen de las dos puntas y seguir contando.
 *
 * Una cobertura deliberada usa tamaños parecidos: es lo que neutraliza el
 * riesgo. Con tolerancia amplia entrarían dos operaciones sin relación que por
 * casualidad cayeron juntas y en direcciones opuestas.
 */
export const TOLERANCIA_VOLUMEN = 0.25;

/** Mínimo de pares para que valga la pena mirarlo. */
export const MIN_PARES = 3;

export interface ParCobertura {
  /** Las dos cuentas involucradas. */
  loginA: number;
  loginB: number;
  symbol: string;
  /** Cuántas veces se repitió el patrón entre esas dos cuentas. */
  pares: number;
  /** Volumen total cubierto, sumando una sola punta. */
  lotes: number;
  /** Cuándo pasó la primera y la última vez. */
  desde: string;
  hasta: string;
}

export interface CoberturaCruzada {
  pares: ParCobertura[];
  /** Total de coincidencias en todas las combinaciones. */
  total: number;
  /** Logins involucrados en al menos un par. */
  logins: number[];
}

const vacio: CoberturaCruzada = { pares: [], total: 0, logins: [] };

/** Índice símbolo → operaciones ordenadas por apertura. */
function porSimbolo(trades: Trade[]): Map<string, Trade[]> {
  const m = new Map<string, Trade[]>();
  for (const t of trades) {
    let arr = m.get(t.symbol);
    if (!arr) { arr = []; m.set(t.symbol, arr); }
    arr.push(t);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  return m;
}

/** Primer índice cuya apertura es >= `desde`. Búsqueda binaria. */
function primeroDesde(arr: Trade[], desde: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].openTime.getTime() < desde) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Busca posiciones opuestas simultáneas entre las cuentas de un mismo cliente.
 *
 * `porCuenta` es el mapa que ya devuelve `loadTradesByLogin`.
 *
 * Con una sola cuenta devuelve vacío sin recorrer nada: hacen falta dos para
 * que haya cobertura ENTRE cuentas. Cubrirse dentro de la misma cuenta es otra
 * cosa y ya la mide la señal de `cierre contra opuesta`.
 */
export function detectarCoberturaCruzada(
  porCuenta: Map<number, Trade[]>,
  opts: { ventanaSeg?: number } = {},
): CoberturaCruzada {
  const logins = [...porCuenta.keys()];
  if (logins.length < 2) return vacio;

  const ventanaMs = (opts.ventanaSeg ?? VENTANA_SEGUNDOS) * 1000;
  const indices = new Map(logins.map((l) => [l, porSimbolo(porCuenta.get(l) ?? [])]));

  const pares: ParCobertura[] = [];
  let total = 0;

  // Cada combinación una sola vez: (A,B) y (B,A) son el mismo hallazgo.
  for (let i = 0; i < logins.length; i += 1) {
    for (let j = i + 1; j < logins.length; j += 1) {
      const a = indices.get(logins[i])!;
      const b = indices.get(logins[j])!;

      for (const [symbol, opsA] of a) {
        const opsB = b.get(symbol);
        if (!opsB || opsB.length === 0) continue;

        let n = 0;
        let lotes = 0;
        let desde = Infinity;
        let hasta = -Infinity;
        // Una operación de B se usa UNA vez: sin esto, una sola cobertura
        // contra un racimo de operaciones contaría como muchas.
        const usadas = new Set<number>();

        for (const ta of opsA) {
          const t0 = ta.openTime.getTime();
          let k = primeroDesde(opsB, t0 - ventanaMs);
          while (k < opsB.length && opsB[k].openTime.getTime() <= t0 + ventanaMs) {
            const tb = opsB[k];
            k += 1;
            if (usadas.has(tb.index)) continue;
            // Opuestas: una compra contra una venta.
            if (tb.type === ta.type) continue;
            // Y de tamaño parecido, que es lo que neutraliza el riesgo.
            const mayor = Math.max(ta.volume, tb.volume);
            if (mayor <= 0) continue;
            if (Math.abs(ta.volume - tb.volume) / mayor > TOLERANCIA_VOLUMEN) continue;

            usadas.add(tb.index);
            n += 1;
            lotes += Math.min(ta.volume, tb.volume);
            desde = Math.min(desde, t0);
            hasta = Math.max(hasta, t0);
            break; // una punta de A se cubre con una sola de B
          }
        }

        if (n >= MIN_PARES) {
          total += n;
          pares.push({
            loginA: logins[i],
            loginB: logins[j],
            symbol,
            pares: n,
            lotes: Math.round(lotes * 100) / 100,
            desde: new Date(desde).toISOString(),
            hasta: new Date(hasta).toISOString(),
          });
        }
      }
    }
  }

  pares.sort((x, y) => y.pares - x.pares);
  const involucrados = new Set<number>();
  for (const p of pares) { involucrados.add(p.loginA); involucrados.add(p.loginB); }

  return { pares, total, logins: [...involucrados].sort((a, b) => a - b) };
}
