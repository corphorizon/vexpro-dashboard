// One-off: delete 3 orphan auth.users flagged by audit.mjs.
// These users have no company_users row, so the app shows them nothing.
// Kevin will recreate them later.
//
// Wrapped in a transaction with row verification before COMMIT.
import { withClient } from './_client.mjs';

const ORPHANS = [
  { id: '94be6735-4a5f-45b7-a26b-692e8f6b880c', email: 'sergioavilacortes24@gmail.com' },
  { id: 'bc00ec1d-afda-407f-90cf-6d0327a1abab', email: 'jessica.yeme@vexprofx.com' },
  { id: '0e77f8a9-5d9d-4594-8765-97e7308b0a56', email: 'sergio@vexprofx.com' },
];

await withClient(async (c) => {
  await c.query('BEGIN');
  try {
    // Sanity: confirm each row is still orphan (no company_users) before deleting.
    const ids = ORPHANS.map((o) => o.id);
    const { rows: linked } = await c.query(
      `SELECT user_id FROM public.company_users WHERE user_id = ANY($1::uuid[])`,
      [ids],
    );
    if (linked.length > 0) {
      throw new Error(
        `Refusing to delete: ${linked.length} of the target users now have company_users rows.`,
      );
    }

    // Delete from auth.users — cascades through Supabase's own FKs
    // (sessions, refresh tokens, identities, mfa factors, etc).
    const { rows: deleted } = await c.query(
      `DELETE FROM auth.users WHERE id = ANY($1::uuid[]) RETURNING id, email`,
      [ids],
    );
    console.log(`→ Deleted ${deleted.length} auth.users rows:`);
    console.table(deleted);

    if (deleted.length !== ORPHANS.length) {
      throw new Error(
        `Expected to delete ${ORPHANS.length} rows but deleted ${deleted.length}. Rolling back.`,
      );
    }

    await c.query('COMMIT');
    console.log('\n✅ Orphan users removed.');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  }
});
