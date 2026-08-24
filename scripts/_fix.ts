import { readFileSync } from 'node:fs'; import pkg from 'pg'; const { Client } = pkg;
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^(SUPABASE_DB_[A-Z]+)=(.*)$/); if(m)process.env[m[1]]=m[2].replace(/^"|"$/g,''); }
async function main(){
  const CID='71715987-5479-52c4-a990-c414fb3a9b36';
  const { createAdminClient } = await import('../src/lib/supabase/admin');
  const { syncCustomerAggregates } = await import('../src/lib/crm-sync/aggregates');
  const r = await syncCustomerAggregates(createAdminClient(), CID);
  console.log('recalculado:', r.customers, 'clientes en', Math.round(r.elapsedMs/1000),'s');
  const pg=new Client({host:process.env.SUPABASE_DB_HOST,port:Number(process.env.SUPABASE_DB_PORT||5432),user:process.env.SUPABASE_DB_USER,password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}});
  await pg.connect();
  const q = await pg.query(`
    select u.email,
           a.deposit_count agregado_n, a.total_deposits agregado_suma,
           (select count(*) from crm_deposits d where d.company_id=$1 and d.user_external_id=u.user_external_id and d.status_norm='completed') real_n,
           (select round(coalesce(sum(d.amount_paid),0)::numeric,2) from crm_deposits d where d.company_id=$1 and d.user_external_id=u.user_external_id and d.status_norm='completed') real_suma
    from crm_user_snapshots u join crm_customer_aggregates a on a.user_external_id=u.user_external_id and a.company_id=u.company_id
    where u.company_id=$1 and lower(u.email) in ('wilmarrojasquimbaya@gmail.com','ana.261@gmail.com')`,[CID]);
  console.log('\n## Los dos casos que fallaban'); console.table(q.rows);
  // Y la comprobación global: ¿el agregado coincide con el espejo para TODOS?
  const g = await pg.query(`
    with real as (select user_external_id, count(*) n, round(sum(amount_paid)::numeric,2) suma
                  from crm_deposits where company_id=$1 and status_norm='completed' group by 1)
    select count(*)::int clientes_con_depositos,
           count(*) filter (where a.deposit_count is distinct from r.n)::int difieren_en_conteo,
           count(*) filter (where round(a.total_deposits::numeric,2) is distinct from r.suma)::int difieren_en_suma
    from real r join crm_customer_aggregates a on a.user_external_id=r.user_external_id and a.company_id=$1`,[CID]);
  console.log('\n## ¿El agregado coincide con el espejo para TODOS?'); console.table(g.rows);
  await pg.end();
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,250)));
