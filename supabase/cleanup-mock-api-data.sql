-- One-off cleanup: wipe any mock / fabricated rows that may have leaked
-- into api_transactions / api_balance_snapshots / api_sync_log before the
-- `isMock` guards were added to the persistence layer.
--
-- Heuristic: the mock generators produced deterministic ids that start with
-- known prefixes and balance snapshots tagged wallet_id = 'mock-*'. It's
-- safe to delete everything and let the next "Refrescar" repopulate with
-- real data.
--
-- Safe to re-run; does not touch manual `deposits` / `withdrawals` / `expenses`.

BEGIN;

DELETE FROM api_transactions
WHERE external_id LIKE 'mock-%'
   OR external_id LIKE 'cb-mock-%'
   OR external_id LIKE 'fp-mock-%'
   OR external_id LIKE 'up-mock-%';

DELETE FROM api_balance_snapshots
WHERE wallet_id LIKE 'mock-%';

COMMIT;
