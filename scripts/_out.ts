import { readFileSync } from 'node:fs';
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
async function main(){
  const { withOrionMongo } = await import('../src/lib/api-integrations/orion-mongo/client');
  await withOrionMongo('71715987-5479-52c4-a990-c414fb3a9b36', async ({ db }: any) => {
    const r = await db.collection('wallettransfers').aggregate([
      { $match: { concept:'DEPOSIT' } },
      { $group: { _id:'$relatedConceptId', n:{$sum:1} } },
      { $sort: { n:-1 } }, { $limit: 3 },
    ], { maxTimeMS: 120000 }).toArray();
    console.log('\n## Los grupos más grandes:');
    for (const g of r) console.log('   relatedConceptId =', JSON.stringify(g._id), '->', g.n, 'movimientos');
    const raro = r[0]._id;
    console.log('\n## ¿Existe un depósito con ese id?');
    const dep = await db.collection('deposits').findOne({ depositId: raro });
    console.log('   ', dep ? 'sí' : 'NO — es un grupo de movimientos SIN depósito asociado');
    const muestra = await db.collection('wallettransfers').find({ concept:'DEPOSIT', relatedConceptId: raro },
      { projection:{ netAmount:1, relatedConceptName:1, walletTransferDate:1 }, limit: 4 }).toArray();
    console.log('\n## Muestra de esos movimientos:');
    console.table(muestra.map((x:any)=>({ neto:x.netAmount, concepto:x.relatedConceptName, fecha:String(x.walletTransferDate).slice(0,10) })));
    return null;
  });
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,250)));
