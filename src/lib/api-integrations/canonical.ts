import type { ProviderTransaction } from './types';

/**
 * Extract the canonical USD amount for a provider transaction.
 *
 * Each provider exposes the amount under a different field name:
 *   - Coinsbuy deposit:    `amountTarget`
 *   - Coinsbuy withdrawal: `chargedAmount`
 *   - FairPay:             `net`
 *   - UniPayment:          `netAmount`
 *
 * The function picks the first field present in the transaction and
 * returns 0 when none match. Used by persistence.ts (to fill the
 * api_transactions.amount column) and by the totals layer (to sum the
 * dashboard numbers). Both call sites need to agree on the same
 * canonical value, so the logic lives here.
 */
export function canonicalAmount(tx: ProviderTransaction): number {
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
  if ('commission' in tx) return tx.commission ?? 0;            // unipayment / fairpay variants
  if ('mdr' in tx) return tx.mdr ?? 0;                          // fairpay merchant discount rate
  if ('fee' in tx) return tx.fee ?? 0;                          // coinsbuy
  return 0;
}
