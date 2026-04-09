# scripts/db-admin/

One-off scripts that connect **directly** to the Supabase Postgres database
(bypassing PostgREST and RLS) for operations PostgREST cannot do:

- Running DDL migrations (`CREATE POLICY`, `ALTER TABLE`, …)
- Auditing schema / RLS / indexes
- Backfilling data through transactions

Everything in here reads credentials from `.env.local` via `_client.mjs` —
never hard-code the DB password.

## How to run

```bash
export PATH="$HOME/local/node/bin:$PATH"  # if node is in ~/local/node
node scripts/db-admin/<script>.mjs
```

## Scripts

| File | Purpose |
|---|---|
| `_client.mjs` | Shared connection helper (`withClient(async (c) => ...)`) |
| `audit.mjs`   | Read-only health check: RLS coverage, public policies, unindexed FKs, orphan data, table sizes |
| `run-sql-file.mjs` | Execute an arbitrary `.sql` file: `node scripts/db-admin/run-sql-file.mjs supabase/migration-XXX.sql` |

## Safety rules

- **Never commit `.env.local`** — it's gitignored.
- Read-only audits: prefer `SELECT` queries, never `UPDATE` / `DELETE` without
  wrapping in a transaction you can `ROLLBACK`.
- Migrations: always idempotent (`DROP POLICY IF EXISTS` before `CREATE`,
  `CREATE TABLE IF NOT EXISTS`, etc.), and also mirrored into `supabase/schema.sql`.
- Never `DROP TABLE` / `TRUNCATE` without explicit user confirmation.
