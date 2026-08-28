// ─────────────────────────────────────────────────────────────────────────────
// Traer TODAS las filas de una consulta PostgREST, no las primeras mil.
//
// ── LAS DOS TRAMPAS ────────────────────────────────────────────────────────
//
//  1. PostgREST corta en 1.000 filas y NO avisa. La respuesta tiene cara de
//     completa. En este repo, con 39.000 depósitos, los agregados se
//     calculaban sobre el 2,5% de los datos.
//
//  2. Cada consulta que se pagine DEBE traer un `.order(...)` por una columna
//     ÚNICA. Sin orden explícito, Postgres no garantiza que las páginas sean
//     consistentes entre sí: una fila puede salir en dos páginas y otra en
//     ninguna. No da error — da números mal.
//
// La segunda costó 15.095 diferencias en la comparación con Atlas del
// 2026-08-25: un cliente con 5 depósitos aparecía con 0, y otro con 1 depósito
// de $300 aparecía con 2 de $600 (exactamente el doble). El espejo estaba
// perfecto; lo que estaba mal era la paginación.
//
// ── POR QUÉ ESTE ARCHIVO ───────────────────────────────────────────────────
// Esta función existía copiada dentro de `crm-sync/aggregates.ts` y
// `crm-sync/wallet-sources.ts`, privada en las dos. Acá queda la versión
// compartida para que el próximo que la necesite la importe en vez de hacer
// una tercera copia — las listas duplicadas que se desincronizan en silencio
// son el modo de falla número uno de este repo. Las dos copias viejas siguen
// en su lugar: migrarlas es un cambio aparte, en código que no es de este
// módulo.
// ─────────────────────────────────────────────────────────────────────────────

export const TAMANO_PAGINA = 1000;

/**
 * Recorre la consulta de a mil filas hasta que devuelva una página incompleta.
 *
 * `page(from, to)` tiene que aplicar `.range(from, to)` sobre una consulta que
 * YA tenga un `.order(...)` por columna única.
 *
 * Lanza si la consulta falla: un error de lectura devuelto como lista vacía se
 * lee como «no hay datos», que es justo la confusión que este repo persigue.
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += TAMANO_PAGINA) {
    const { data, error } = await page(from, from + TAMANO_PAGINA - 1);
    if (error) throw new Error(error.message);
    const lote = data ?? [];
    out.push(...lote);
    if (lote.length < TAMANO_PAGINA) return out;
  }
}
