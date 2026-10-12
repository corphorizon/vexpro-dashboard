// ─────────────────────────────────────────────────────────────────────────────
// Huella de los egresos MANUALES de un período — el registro ÚNICO que usan el
// servidor (POST /api/admin/expenses) y la pantalla de Carga de Datos para
// detectar que el período cambió debajo de una pantalla vieja.
//
// EL INCIDENTE (2026-10-08, Horizon): `replace_period_expenses` BORRA todas las
// filas manuales del período y re-inserta lo que el cliente tiene en pantalla
// (reglas §2.4). Una pestaña abierta desde antes guardó su buffer viejo y pisó
// en silencio dos egresos creados minutos antes desde otra pestaña: "Pago
// soporte hector" ($3,500) y "FX Expo Argentina" ($2,500). Sin error y sin log
// de borrado — el buffer nunca los conoció, así que para la RPC no existían.
// Es exactamente el fallo que no da error (reglas §1.2).
//
// LA HUELLA: { count, maxUpdatedAt } de las filas manuales del período.
//   · count cambia si otra pestaña agregó o borró filas.
//   · maxUpdatedAt cambia si otra pestaña GUARDÓ (la RPC re-inserta TODAS las
//     filas manuales con updated_at = now(), migración 079) o si alguna ruta
//     editó una fila suelta (fixed-forward, adjuntos: el trigger
//     trg_expenses_updated_at la sube). Por eso alcanza aunque el count quede
//     igual (borrar una y agregar otra).
//
// POR QUÉ SOLO LAS MANUALES: las filas nacidas de órdenes de pago
// (payment_order_id no nulo) las administra tesorería y la RPC NO las toca
// (migración 079, DELETE e INSERT filtran `payment_order_id IS NULL`). Que
// tesorería pague una OP mientras alguien carga egresos no pone en riesgo nada
// de lo que el guardado pisa — contarlas bloquearía el guardado del mes sin
// motivo.
//
// POR QUÉ LA COMPARACIÓN LEXICOGRÁFICA DE updated_at ES VÁLIDA: PostgREST
// devuelve timestamptz como ISO 8601 en UTC con el mismo offset para todas las
// filas ("2026-10-08T14:03:22.123456+00:00"). Con ese formato fijo, el orden de
// los strings es el orden temporal — incluso cuando Postgres recorta ceros de
// la fracción: "…22+00:00" < "…22.1+00:00" < "…22.12+00:00" porque '+' (0x2B)
// < '.' (0x2E) < cualquier dígito. Mezclar offsets distintos ROMPERÍA esto;
// no pasa porque las dos puntas leen la misma columna por el mismo PostgREST.
// Entre cliente y servidor la huella se compara por IGUALDAD, no por orden.
//
// DESCARTES:
//   · Columna `version` + chequeo dentro de la RPC: cierra también la ventana
//     de carrera (ver route.ts), pero exige migración y tocar la RPC, que es
//     justamente la pieza más frágil del flujo (§2.4). Queda como siguiente
//     paso si la ventana alguna vez se ve en la práctica.
//   · Hash del contenido de cada fila: detecta lo mismo que updated_at pero
//     obliga a que cliente y servidor serialicen idéntico (números, nulls,
//     orden) — una segunda lista de columnas que se desincroniza en silencio.
//   · Solo el count: no ve "otra pestaña editó un monto" ni "borró una y
//     agregó otra".
// ─────────────────────────────────────────────────────────────────────────────

export interface HuellaEgresos {
  /** Cantidad de filas manuales del período. 0 = "no hay", no "no sé". */
  count: number;
  /** Máximo updated_at (ISO) de esas filas; null si no hay filas o ninguna lo trae. */
  maxUpdatedAt: string | null;
}

/**
 * Código de error del 409. Lo emite la route y lo reconoce el cliente: un solo
 * string para que no diverjan.
 */
export const CONFLICTO_PERIODO = 'conflict' as const;

export function huellaDeEgresosManuales(
  rows: Array<{ payment_order_id?: string | null; updated_at?: string | null }>,
): HuellaEgresos {
  let count = 0;
  let maxUpdatedAt: string | null = null;
  for (const r of rows) {
    // null, undefined y '' cuentan como manual: es el mismo criterio que la
    // RPC (`nullif(r->>'payment_order_id', '') is null`).
    if (r.payment_order_id) continue;
    count++;
    const u = r.updated_at;
    if (typeof u === 'string' && u !== '' && (maxUpdatedAt === null || u > maxUpdatedAt)) {
      maxUpdatedAt = u;
    }
  }
  return { count, maxUpdatedAt };
}

export function mismaHuella(a: HuellaEgresos, b: HuellaEgresos): boolean {
  return a.count === b.count && a.maxUpdatedAt === b.maxUpdatedAt;
}

/**
 * Valida la huella que manda el cliente en el body. Devuelve null si la forma
 * no es la esperada — la route responde 400 en ese caso en vez de caer al
 * guardado sin guard: un baseline roto no puede degradar a "pisar a ciegas".
 */
export function parsearHuella(v: unknown): HuellaEgresos | null {
  if (typeof v !== 'object' || v === null) return null;
  const { count, maxUpdatedAt } = v as Record<string, unknown>;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
  if (maxUpdatedAt !== null && typeof maxUpdatedAt !== 'string') return null;
  return { count, maxUpdatedAt };
}

/**
 * Texto del 409, con los números reales de las dos puntas. Si el count no
 * cambió (misma cantidad, otra pestaña EDITÓ montos o re-guardó), decir
 * "ahora tiene 3; partió de 3" confunde: en ese caso se dice qué pasó.
 */
export function mensajeConflicto(actual: HuellaEgresos, baseline: HuellaEgresos): string {
  const detalle =
    actual.count === baseline.count
      ? `se modificaron egresos desde otra pantalla (sigue habiendo ${actual.count})`
      : `ahora tiene ${actual.count} egresos manuales; esta pantalla partió de ${baseline.count}`;
  return (
    `Este período cambió desde que se cargó esta pantalla (${detalle}). Recargá la página ` +
    `para traer lo último — guardar ahora pisaría esos cambios.`
  );
}
