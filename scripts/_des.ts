import { readFileSync } from 'node:fs';
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
async function main(){
  const { withOrionMongo } = await import('../src/lib/api-integrations/orion-mongo/client');
  await withOrionMongo('71715987-5479-52c4-a990-c414fb3a9b36', async ({ db }: any) => {
    const d = await db.collection('deposits').findOne({ depositStatus:'COMPLETED', purchaseIntent:{$exists:true}, $expr:{$ne:['$amountPaid','$depositValue']} });
    console.log('\n## Un depósito donde los dos importes difieren, campos completos:');
    console.log(JSON.stringify(d, null, 2).slice(0, 1400));
    console.log('\n## ¿Los movimientos de billetera siguen a cuál?');
    const w = await db.collection('wallettransfers').findOne({});
    console.log('  campos de wallettransfers:', w ? Object.keys(w).join(', ') : '(vacía)');
    const t = await db.collection('transactions').findOne({});
    console.log('  campos de transactions   :', t ? Object.keys(t).join(', ') : '(vacía)');
    return null;
  });
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,250)));
