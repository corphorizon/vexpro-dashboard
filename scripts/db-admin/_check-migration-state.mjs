// Quick one-off: what multi-tenant objects exist vs missing.
import { withClient } from './_client.mjs';

await withClient(async (c) => {
  const checks = [
    { kind: 'table',    name: 'platform_users',  src: 'migration-021' },
    { kind: 'function', name: 'is_superadmin',   src: 'migration-021' },
    { kind: 'function', name: 'auth_can_edit',   src: 'migration-022' },
    { kind: 'function', name: 'auth_can_manage', src: 'migration-022' },
    { kind: 'column',   table: 'companies', name: 'status',     src: 'migration-023' },
    { kind: 'column',   table: 'companies', name: 'created_by', src: 'migration-023' },
  ];

  console.log('─── Multi-tenant migration state ───\n');
  for (const ch of checks) {
    let exists = false;
    if (ch.kind === 'table') {
      const { rows } = await c.query(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`public.${ch.name}`],
      );
      exists = rows[0].exists;
    } else if (ch.kind === 'function') {
      const { rows } = await c.query(
        `SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = $1) AS exists`,
        [ch.name],
      );
      exists = rows[0].exists;
    } else if (ch.kind === 'column') {
      const { rows } = await c.query(
        `SELECT EXISTS(
           SELECT 1 FROM information_schema.columns
           WHERE table_name = $1 AND column_name = $2
         ) AS exists`,
        [ch.table, ch.name],
      );
      exists = rows[0].exists;
    }
    const icon = exists ? '✅' : '❌';
    const label = ch.kind === 'column' ? `${ch.table}.${ch.name}` : ch.name;
    console.log(`  ${icon}  ${ch.kind.padEnd(8)} ${label.padEnd(28)} (from ${ch.src})`);
  }

  // VexPro still OK?
  const { rows: vex } = await c.query(
    `SELECT id, name, slug FROM companies WHERE slug = 'vexprofx' LIMIT 1`,
  );
  console.log('\n─── VexPro FX baseline ───');
  if (vex.length === 0) {
    console.log('  ❌ VexPro FX NOT FOUND');
  } else {
    console.log(`  ✅ VexPro FX present (id=${vex[0].id})`);
  }
});
