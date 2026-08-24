import { readFileSync } from 'node:fs'; import pkg from 'pg'; const { Client } = pkg;
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^(SUPABASE_DB_[A-Z]+)=(.*)$/); if(m)process.env[m[1]]=m[2].replace(/^"|"$/g,''); }
async function main(){
  const CID='71715987-5479-52c4-a990-c414fb3a9b36';
  const pg=new Client({host:process.env.SUPABASE_DB_HOST,port:Number(process.env.SUPABASE_DB_PORT||5432),user:process.env.SUPABASE_DB_USER,password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}});
  await pg.connect();
  // Clientes con depositos reales en Orion y con cuentas en MT5
  const r = await pg.query(`
    with dep as (select lower(trim(u.email)) email, sum(d.amount_paid) depositado, count(*) n
                 from crm_deposits d join crm_user_snapshots u on u.user_external_id=d.user_external_id and u.company_id=d.company_id
                 where d.company_id=$1 and d.status_norm='completed' and u.email is not null group by 1 having sum(d.amount_paid) > 500),
         mt as (select email, sum(account_balance) saldo_mt5, count(*) cuentas from mt5_account_activity where company_id=$1 and not is_demo group by 1)
    select dep.email, round(dep.depositado::numeric,2) orion_depositado, dep.n movs,
           round(mt.saldo_mt5::numeric,2) mt5_saldo, mt.cuentas
    from dep join mt on mt.email=dep.email order by dep.depositado desc limit 8`,[CID]);
  console.log('\n## Depositado en Orion (PSP) contra saldo en cuentas MT5');
  console.table(r.rows);
  const { withMt5Connection } = await import('../src/lib/api-integrations/mt5-sql/client');
  await withMt5Connection(CID, async (s:any)=>{
    const a = await s.query('select Action, Entry, count(*) n from mt5_deals where Login in (select Login from mt5_users limit 200) group by 1,2 order by n desc limit 10');
    console.log('\n## Tipos de movimiento en mt5_deals (muestra)'); console.table(a.map((x:any)=>({Action:x.Action, Entry:x.Entry, n:Number(x.n)})));
    return null;
  });
  await pg.end();
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,200)));
