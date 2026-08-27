import fs from 'node:fs';
import pg from 'pg';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env.local', import.meta.url),'utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const c = new pg.Client({host:env.SUPABASE_DB_HOST,port:+env.SUPABASE_DB_PORT,user:env.SUPABASE_DB_USER,database:env.SUPABASE_DB_NAME,password:env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},application_name:'diag_time_readonly'});
await c.connect();

const VEX='71715987-5479-52c4-a990-c414fb3a9b36';
const AP='356ada44-b7af-4983-ac84-8685dcc8c22e';
const USER_VEX='6e6da2dc-afb7-43cd-b1f0-057647d22693'; // Vex Pro admin
const USER_VEX_SOP='d6fcff74-2c4b-45dd-9926-9bccf9025c0c'; // soporte
const USER_AP='13060f21-6f37-4543-9890-4cd801b18de6'; // AP admin

const Q = [
 ['companies',       `select * from public.companies where id=$1`],
 ['periods',         `select * from public.periods where company_id=$1 order by year, month`],
 ['employees',       `select * from public.employees where company_id=$1 order by name`],
 ['commercial_profiles', `select * from public.commercial_profiles where company_id=$1 order by name`],
 ['commercial_monthly_results', `select * from public.commercial_monthly_results where company_id=$1 limit 10000`],
 ['deposits',        `select * from public.deposits where company_id=$1 limit 10000`],
 ['withdrawals',     `select * from public.withdrawals where company_id=$1 limit 10000`],
 ['expenses',        `select * from public.expenses where company_id=$1 order by sort_order limit 10000`],
 ['expense_templates',`select * from public.expense_templates where company_id=$1 order by sort_order`],
 ['expense_template_period_hidden',`select id,company_id,template_id,period_id from public.expense_template_period_hidden where company_id=$1`],
 ['preoperative_expenses',`select * from public.preoperative_expenses where company_id=$1 order by sort_order`],
 ['operating_income',`select * from public.operating_income where company_id=$1 limit 10000`],
 ['broker_balance',  `select * from public.broker_balance where company_id=$1 limit 10000`],
 ['financial_status',`select * from public.financial_status where company_id=$1 limit 10000`],
 ['partners',        `select * from public.partners where company_id=$1`],
 ['partner_distributions',`select * from public.partner_distributions where company_id=$1 limit 10000`],
 ['prop_firm_sales', `select * from public.prop_firm_sales where company_id=$1 limit 10000`],
 ['p2p_transfers',   `select * from public.p2p_transfers where company_id=$1 limit 10000`],
 ['liquidity_movements',`select * from public.liquidity_movements where company_id=$1 order by date limit 10000`],
 ['investments',     `select * from public.investments where company_id=$1 order by date limit 10000`],
];

async function run(label, uid, comp) {
  console.log(`\n=== ${label} (uid=${uid ?? 'SERVICE(no RLS)'} company=${comp.slice(0,8)}) ===`);
  let total = 0;
  for (const [name, sql] of Q) {
    await c.query('BEGIN');
    await c.query('SET LOCAL default_transaction_read_only = on');
    if (uid) {
      await c.query(`SET LOCAL ROLE authenticated`);
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({sub:uid, role:'authenticated'})]);
    }
    // warm
    try { await c.query(sql,[comp]); } catch(e){ console.log(`${name.padEnd(32)} ERROR ${e.message.slice(0,90)}`); await c.query('ROLLBACK'); continue; }
    const times=[];
    let rows=0, bytes=0;
    for (let i=0;i<3;i++){ const t=process.hrtime.bigint(); const r=await c.query(sql,[comp]); times.push(Number(process.hrtime.bigint()-t)/1e6); rows=r.rowCount; bytes=Buffer.byteLength(JSON.stringify(r.rows)); }
    await c.query('ROLLBACK');
    const med = times.sort((a,b)=>a-b)[1];
    total += med;
    console.log(`${name.padEnd(32)} ${med.toFixed(1).padStart(8)} ms  rows=${String(rows).padStart(5)}  json=${(bytes/1024).toFixed(1).padStart(8)} KB`);
  }
  console.log(`${'TOTAL (serial)'.padEnd(32)} ${total.toFixed(1).padStart(8)} ms`);
}

await run('SERVICE / VexPro', null, VEX);
await run('RLS authenticated / VexPro admin', USER_VEX, VEX);
await run('RLS authenticated / VexPro soporte', USER_VEX_SOP, VEX);
await run('RLS authenticated / AP admin', USER_AP, AP);
await c.end();
