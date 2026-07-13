// ─────────────────────────────────────────────────────────────────────────────
// Cache-Control headers para respuestas de API (PERF-04, 2026-07-12).
//
// SOLO `private`: nunca `s-maxage`/`public`. Estos endpoints son multi-tenant
// y resuelven la empresa del JWT, no de la URL — un cache compartido (CDN de
// Vercel, keyed por URL) serviría la respuesta de una empresa a otra
// (leak cross-tenant). `private` cachea solo en el browser del propio usuario.
//
// Se aplica únicamente a lecturas de APIs EXTERNAS (Coinsbuy/UniPayment/
// FairPay/Orion) — datos que el usuario no edita en la app, así que una
// ventana corta de staleness no genera confusión de "guardé pero sigue viejo".
// NO usar en endpoints que respaldan vistas de edición (period-totals,
// movements, config), donde la frescura importa.
// ─────────────────────────────────────────────────────────────────────────────

export function privateCache(
  maxAgeSeconds = 30,
  swrSeconds = maxAgeSeconds * 4,
): { 'Cache-Control': string } {
  return {
    'Cache-Control': `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${swrSeconds}`,
  };
}
