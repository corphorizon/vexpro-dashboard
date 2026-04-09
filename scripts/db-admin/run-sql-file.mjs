// Generic SQL file runner.
// Usage: node scripts/db-admin/run-sql-file.mjs <path-to-sql-file>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withClient } from './_client.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/db-admin/run-sql-file.mjs <path-to-sql-file>');
  process.exit(1);
}

const fullPath = resolve(process.cwd(), file);
const sql = readFileSync(fullPath, 'utf8');

await withClient(async (client) => {
  console.log(`→ Executing ${fullPath}`);
  const res = await client.query(sql);
  const results = Array.isArray(res) ? res : [res];
  const lastWithRows = [...results].reverse().find((r) => r && r.rows && r.rows.length > 0);
  if (lastWithRows) {
    console.log(`\n→ Last SELECT returned ${lastWithRows.rows.length} rows:`);
    console.table(lastWithRows.rows);
  }
  console.log('\n✅ Done');
});
