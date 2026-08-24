import { readFileSync } from 'node:fs'; import pkg from 'pg'; const { Client } = pkg;
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^(SUPABASE_DB_[A-Z]+)=(.*)$/); if(m)process.env[m[1]]=m[2].replace(/^"|"$/g,''); }
async function main(){
  const CID='71715987-5479-52c4-a990-c414fb3a9b36';
  const CASOS=['wilmarrojasquimbaya@gmail.com','ana.261@gmail.com'];
  const { withOrionMongo } = await import('../src/lib/api-integrations/orion-mongo/client');
  const pg=new Client({host:process.env.SUPABASE_DB_HOST,port:Number(process.env.SUPABASE_DB_PORT||5432),user:process.env.SUPABASE_DB_USER,password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}});
  await pg.connect();
  await withOrionMongo(CID, async ({ db }: any) => {
    for (const mail of CASOS) {
      const u = await db.collection('users').findOne({ email: mail }, { projection: { userId:1, clientId:1, _id:1, email:1 } });
      console.log('\n═══', mail);
      console.log('  ORION usuario -> userId:', u?.userId, '| clientId:', u?.clientId, '| _id:', String(u?._id));
      const deps = await db.collection('deposits').find({ userId: u?.userId }, { projection:{ depositId:1, amountPaid:1, depositStatus:1, depositDate:1 } }).toArray();
      const comp = deps.filter((d:any)=>d.depositStatus==='COMPLETED');
      console.log('  ORION depósitos:', deps.length, 'total |', comp.length, 'COMPLETED | suma $'+comp.reduce((s:number,d:any)=>s+(d.amountPaid||0),0).toFixed(2));
      // mi espejo
      const perfil = await pg.query(`select user_external_id from crm_user_snapshots where company_id=$1 and lower(email)=$2`,[CID, mail]);
      const uid = perfil.rows[0]?.user_external_id;
      console.log('  MI perfil user_external_id:', uid, uid===u?.userId ? '(coincide)' : '(NO COINCIDE con userId de Orion)');
      const mios = await pg.query(`select count(*)::int n, count(*) filter (where status_norm='completed')::int c, round(coalesce(sum(amount_paid) filter (where status_norm='completed'),0)::numeric,2) suma from crm_deposits where company_id=$1 and user_external_id=$2`,[CID, u?.userId]);
      console.log('  MI espejo (por userId de Orion):', JSON.stringify(mios.rows[0]));
      const agg = await pg.query(`select deposit_count, total_deposits from crm_customer_aggregates where company_id=$1 and user_external_id=$2`,[CID, uid]);
      console.log('  MI agregado guardado:', JSON.stringify(agg.rows[0] ?? null));
    }
    return null;
  });
  await pg.end();
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,250)));
