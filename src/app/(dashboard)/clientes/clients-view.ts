// ─────────────────────────────────────────────────────────────────────────────
// Filtro y conteos de /clientes, fuera del JSX para poder fijarlos con tests
// (migración «Libro mayor», 2026-10-12).
//
// POR QUÉ: con la lista pasada a FinTable y los filtros a `Chip`, cada chip
// lleva su conteo («Con deuda 7») y el pie dice «Mostrando N de M». Si el
// conteo del chip y el filtro real usaran dos reglas distintas (p. ej. una
// `> 0` y otra `> 0,009`), el chip diría 7 y la tabla mostraría 8: dos
// números para la misma pregunta. Una sola función decide «debe».
//
// No hay cálculo nuevo: el umbral y la búsqueda son los de la pantalla vieja.
// ─────────────────────────────────────────────────────────────────────────────

import { UNASSIGNED_CLIENT_KEY, type ClientCard } from '@/lib/clients';

/** Una deuda por debajo del centavo es ruido de redondeo, no una deuda. */
export const DEBT_EPSILON = 0.009;

export function owes(card: Pick<ClientCard, 'pending'>): boolean {
  return card.pending > DEBT_EPSILON;
}

export type ClientFilter = 'all' | 'debt';

/** Nombre a mostrar: la ficha sin cliente se rotula, no se muestra la clave cruda. */
export function clientDisplayName(card: Pick<ClientCard, 'key' | 'name'>, unassignedLabel: string): string {
  return card.key === UNASSIGNED_CLIENT_KEY ? unassignedLabel : card.name;
}

export function filterClients<C extends Pick<ClientCard, 'key' | 'name' | 'pending'>>(
  cards: C[],
  opts: { query: string; filter: ClientFilter; unassignedLabel: string },
): C[] {
  const q = opts.query.trim().toLowerCase();
  return cards.filter((c) => {
    if (opts.filter === 'debt' && !owes(c)) return false;
    if (!q) return true;
    return clientDisplayName(c, opts.unassignedLabel).toLowerCase().includes(q);
  });
}

/** Conteo de cada chip, con la MISMA regla del filtro. */
export function filterCounts(cards: ReadonlyArray<Pick<ClientCard, 'pending'>>): Record<ClientFilter, number> {
  let debt = 0;
  for (const c of cards) if (owes(c)) debt += 1;
  return { all: cards.length, debt };
}
