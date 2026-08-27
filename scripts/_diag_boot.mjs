import fs from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter(l => /^[A-Z_]+=/.test(l))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);

const client = new pg.Client({
  host: env.SUPABASE_DB_HOST, port: +env.SUPABASE_DB_PORT,
  user: env.SUPABASE_DB_USER, database: env.SUPABASE_DB_NAME,
  password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
  application_name: 'diag_boot_readonly',
});
await client.connect();
await client.query('SET default_transaction_read_only = on');

const TABLES = [
  'companies','periods','employees','commercial_profiles','commercial_monthly_results',
  'deposits','withdrawals','expenses','expense_templates','expense_template_period_hidden',
  'preoperative_expenses','operating_income','broker_balance','financial_status',
  'partners','partner_distributions','prop_firm_sales','p2p_transfers',
  'liquidity_movements','investments',
];
const COMPANIES = {
  'VexPro': '71715987-5479-52c4-a990-c414fb3a9b36',
  'APMarkets': '356ada44-b7af-4983-ac84-8685dcc8c22e',
};

console.log('=== TOTAL ROWS PER TABLE ===');
for (const t of TABLES) {
  const r = await client.query(`select count(*)::int n from public.${t}`);
  const parts = [];
  for (const [name, id] of Object.entries(COMPANIES)) {
    const col = t === 'companies' ? 'id' : 'company_id';
    const c = await client.query(`select count(*)::int n, coalesce(sum(octet_length(to_jsonb(x)::text)),0)::bigint b from public.${t} x where ${col} = $1`, [id]);
    parts.push(`${name}=${c.rows[0].n} rows / ${(Number(c.rows[0].b)/1024).toFixed(1)} KB`);
  }
  const sz = await client.query(`select pg_size_pretty(pg_total_relation_size('public.${t}')) s`);
  console.log(`${t.padEnd(34)} total=${String(r.rows[0].n).padStart(8)}  disk=${sz.rows[0].s.padStart(9)}  ${parts.join('  ')}`);
}
await client.end();
