// ─────────────────────────────────────────────────────────────────────────────
// Pay-Pros — punto de entrada del módulo.
//
// Hoy solo existe el protocolo del webhook (modelo PUSH: Pay-Pros no expone
// endpoint de listado ni de balance, así que no hay fetcher ni cron que
// agregar al aggregator). Cuando publiquen un endpoint de balance, el
// fetcher va en `balances.ts` de esta misma carpeta, siguiendo el patrón de
// `fairpay/`.
// ─────────────────────────────────────────────────────────────────────────────

export * from './protocol';
