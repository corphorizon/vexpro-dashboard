// ─────────────────────────────────────────────────────────────────────────────
// El GUARD DE GUARDADO de /comisiones y la frescura del insumo CRM.
//
// ── POR QUÉ (dueño, 2026-10-20) ────────────────────────────────────────────
// Septiembre se cerró con grupos a medias: el insumo del CRM tardaba (o
// fallaba), la pantalla mostraba «sin datos», y alguien apretó Guardar en esa
// ventana. Guardar FIJA lo que se ve; con el insumo a medio llegar, lo que se
// ve es plausible y falso — el fallo que no da error (§1.2) y el incidente de
// agosto que describe §6 («ND = 0 es indistinguible de no cargado»).
//
// El pedido: que sea IMPOSIBLE guardar con el insumo a medio llegar. Es una
// función pura para que la decida un test y no un `disabled={...}` armado a
// mano en tres botones distintos (eso es una lista duplicada, §1.1).
//
// ── LA REGLA ───────────────────────────────────────────────────────────────
//   · Mes que NO usa el automático (cerrado, o anterior al corte de agosto
//     2026) → nunca bloquea: lee lo congelado, no el CRM.
//   · Mes abierto, fetch en curso (o «Actualizar» en curso) → bloquea.
//   · Mes abierto, el ND no llegó → bloquea todo lo que guarda ND.
//   · Mes abierto, el PnL no llegó → bloquea lo que guarda PnL (el ND sí
//     puede guardarse: son dos insumos de dos grupos de gente, la misma regla
//     del endpoint, que no deja que el PnL tumbe el ND).
//   · Cache VIEJA → NO bloquea. El dato es válido, sólo tiene una edad, y la
//     edad está en pantalla. Bloquear por vejez dejaría a la pantalla sin
//     guardar cada vez que el cron se atrasa.
//
// Import-safe desde cliente y servidor: no toca Supabase ni React.
// ─────────────────────────────────────────────────────────────────────────────

export type MotivoBloqueoGuardado =
  /** El fetch del insumo (o «Actualizar») todavía no terminó. */
  | 'esperando'
  /** El net deposit del CRM no llegó (falló). */
  | 'sin-nd'
  /** El insumo PnL del CRM no llegó (falló). */
  | 'sin-pnl';

/** Qué insumos escribe un botón de guardado. */
export type InsumosQueGuarda = { nd: boolean; pnl: boolean };

export type EstadoInsumoCrm = {
  /** ¿El mes elegido usa el automático? (abierto y desde el corte). */
  usaAutomatico: boolean;
  /** El GET del insumo está en curso. */
  cargando: boolean;
  /** El POST de «Actualizar» está en curso. */
  refrescando: boolean;
  /** Llegó el índice de net deposit del mes que se está mirando. */
  ndListo: boolean;
  /** Llegó el índice PnL del mes que se está mirando. */
  pnlListo: boolean;
};

/**
 * `null` = se puede guardar. Si no, el motivo — que la pantalla convierte en
 * el `title` del botón deshabilitado.
 */
export function motivoBloqueoGuardado(
  estado: EstadoInsumoCrm,
  guarda: InsumosQueGuarda,
): MotivoBloqueoGuardado | null {
  if (!estado.usaAutomatico) return null;
  if (!guarda.nd && !guarda.pnl) return null;
  if (estado.cargando || estado.refrescando) return 'esperando';
  if (guarda.nd && !estado.ndListo) return 'sin-nd';
  if (guarda.pnl && !estado.pnlListo) return 'sin-pnl';
  return null;
}

/**
 * Cuánto hace que se calculó el insumo, para «CRM calculado hace X».
 *
 * `null` cuando no hay fecha o no se puede leer: la pantalla no muestra nada
 * en vez de inventar un «hace 0 min» (§1.3). Un reloj del cliente adelantado
 * contra el servidor daría un negativo: se aplana a 0 («recién»).
 */
export function edadDelCalculo(
  computedAt: string | null | undefined,
  ahoraMs: number,
): { unidad: 'recien' | 'min' | 'h' | 'd'; n: number } | null {
  if (!computedAt) return null;
  const t = Date.parse(computedAt);
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.floor((ahoraMs - t) / 60_000));
  if (min < 1) return { unidad: 'recien', n: 0 };
  if (min < 60) return { unidad: 'min', n: min };
  const h = Math.floor(min / 60);
  if (h < 48) return { unidad: 'h', n: h };
  return { unidad: 'd', n: Math.floor(h / 24) };
}
