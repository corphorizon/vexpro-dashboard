// ─────────────────────────────────────────────────────────────────────────────
// Pay-Pros — punto de entrada del módulo.
//
// Dos piezas:
//   · `protocol` — webhook entrante (modelo PUSH) para depósitos/retiros.
//     Pay-Pros no expone endpoint de LISTADO de transacciones.
//   · `balance`  — GET v2/getBalance, que sí existe y lo consume el cron
//     daily-balance-snapshot. Sale por el proxy Fixie porque Pay-Pros exige
//     IP whitelisteada.
// ─────────────────────────────────────────────────────────────────────────────

export * from './protocol';
export * from './balance';
