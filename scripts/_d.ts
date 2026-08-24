import { readFileSync } from 'node:fs'; import pkg from 'pg'; const { Client } = pkg;
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^(SUPABASE_DB_[A-Z]+)=(.*)$/); if(m)process.env[m[1]]=m[2].replace(/^"|"$/g,''); }
async function main(){
  const CID='71715987-5479-52c4-a990-c414fb3a9b36';
  const pg=new Client({host:process.env.SUPABASE_DB_HOST,port:Number(process.env.SUPABASE_DB_PORT||5432),user:process.env.SUPABASE_DB_USER,password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}});
  await pg.connect();
  const mios = await pg.query(`select count(*)::int total, count(*) filter (where status_norm='completed')::int completados from crm_deposits where company_id=$1`,[CID]);
  const { withOrionMongo } = await import('../src/lib/api-integrations/orion-mongo/client');
  const orion = await withOrionMongo(CID, async ({ db }: any) => ({
    total: await db.collection('deposits').estimatedDocumentCount(),
    completados: await db.collection('deposits').countDocuments({ depositStatus: 'COMPLETED' }),
  }));
  console.log('\n## ¿Tengo TODOS los depósitos?');
  console.table([{ fuente:'Orion', total:orion.total, completados:orion.completados },
                 { fuente:'mi espejo', total:mios.rows[0].total, completados:mios.rows[0].completados }]);
  console.log('   FALTAN:', orion.total - mios.rows[0].total, 'documentos');
  await pg.end();
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,200)));
