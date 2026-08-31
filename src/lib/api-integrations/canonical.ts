import type { ProviderTransaction } from './types';

/**
 * Extract the canonical USD amount for a provider transaction.
 *
 * Each provider exposes the amount under a different field name:
 *   - Coinsbuy deposit:    `amountTarget`
 *   - Coinsbuy withdrawal: `chargedAmount`
 *   - FairPay:             `net`
 *   - UniPayment:          `netAmount`
 *   - Pay-Pros:            `amount`
 *
 * Pay-Pros se resuelve por `provider` y NO por "tiene la propiedad amount":
 * `CoinsbuyWithdrawalTx` también tiene `amount` (el solicitado, distinto del
 * `chargedAmount` que es el que cuenta), así que un `'amount' in tx` genérico
 * elegiría el campo equivocado para Coinsbuy el día que alguien reordene los
 * ifs. Un número plausible y equivocado, que es el modo de falla del repo.
 *
 * The function picks the first field present in the transaction and
 * returns 0 when none match. Used by persistence.ts (to fill the
 * api_transactions.amount column) and by the totals layer (to sum the
 * dashboard numbers). Both call sites need to agree on the same
 * canonical value, so the logic lives here.
 */
export function canonicalAmount(tx: ProviderTransaction): number {
  if (tx.provider === 'paypros') return tx.amount ?? 0;         // pay-pros
  if ('amountTarget' in tx) return tx.amountTarget ?? 0;       // coinsbuy deposit
  if ('chargedAmount' in tx) return tx.chargedAmount ?? 0;     // coinsbuy withdrawal
  if ('net' in tx) return tx.net ?? 0;                          // fairpay
  if ('netAmount' in tx) return tx.netAmount ?? 0;              // unipayment
  return 0;
}

/**
 * Extract the canonical fee for a provider transaction, with the same
 * provider-specific fallbacks as canonicalAmount.
 */
export function canonicalFee(tx: ProviderTransaction): number {
  // Pay-Pros no informa comisión (ni el webhook ni el espejo del CRM la
  // traen). 0 acá es «el proveedor dice que no hay», no «no lo sabemos».
  if (tx.provider === 'paypros') return 0;
  if ('commission' in tx) return tx.commission ?? 0;            // unipayment / fairpay variants
  if ('mdr' in tx) return tx.mdr ?? 0;                          // fairpay merchant discount rate
  if ('fee' in tx) return tx.fee ?? 0;                          // coinsbuy
  return 0;
}
