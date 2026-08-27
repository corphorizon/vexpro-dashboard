import fs from 'node:fs';
import pg from 'pg';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env.local', import.meta.url),'utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const c = new pg.Client({host:env.SUPABASE_DB_HOST,port:+env.SUPABASE_DB_PORT,user:env.SUPABASE_DB_USER,database:env.SUPABASE_DB_NAME,password:env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},application_name:'diag_rls_readonly'});
await c.connect();
await c.query('SET default_transaction_read_only = on');

// 1. Which users exist per company
const u = await c.query(`select cu.user_id, cu.role, cu.company_id, co.name
  from company_users cu join companies co on co.id=cu.company_id
  order by co.name limit 60`);
console.log('company_users:', u.rowCount);
for (const r of u.rows) console.log('  ', r.name, r.role, r.user_id);
const pu = await c.query(`select id, user_id from platform_users limit 20`).catch(e=>({rows:[],err:e.message}));
console.log('platform_users:', pu.rows.length);

// 2. RLS policies on the boot tables
const pol = await c.query(`select tablename, policyname, cmd, qual from pg_policies where schemaname='public' and tablename = any($1)`,[[
 'companies','periods','employees','commercial_profiles','commercial_monthly_results','deposits','withdrawals','expenses','expense_templates','expense_template_period_hidden','preoperative_expenses','operating_income','broker_balance','financial_status','partners','partner_distributions','prop_firm_sales','p2p_transfers','liquidity_movements','investments']]);
console.log('\n=== SELECT POLICIES ===');
for (const r of pol.rows.filter(r=>r.cmd==='SELECT'||r.cmd==='ALL')) console.log(`${r.tablename.padEnd(32)} ${r.cmd.padEnd(6)} ${r.policyname} :: ${String(r.qual).slice(0,180)}`);
// tables with rls forced/enabled
const rls = await c.query(`select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relname = any($1)`,[[
 'companies','periods','employees','commercial_profiles','commercial_monthly_results','deposits','withdrawals','expenses','partners','investments']]);
console.log('\nRLS flags:', rls.rows.map(r=>`${r.relname}:${r.relrowsecurity?'on':'OFF'}${r.relforcerowsecurity?'/force':''}`).join(' '));
await c.end();
