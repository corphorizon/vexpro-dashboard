import { readFileSync } from 'node:fs';
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
async function main(){
  const CID='71715987-5479-52c4-a990-c414fb3a9b36';
  const { withOrionMongo } = await import('../src/lib/api-integrations/orion-mongo/client');
  await withOrionMongo(CID, async ({ db }: any) => {
    const u = await db.collection('users').findOne({ email:'ocamposimon25@gmail.com' }, { projection:{ userId:1 } });
    const deps = await db.collection('deposits').find({ userId: u.userId, depositStatus:'COMPLETED' },
      { projection:{ depositId:1, amountPaid:1, depositValue:1, coin:1, network:1, isFIATPayment:1, depositDate:1 } }).toArray();
    console.log('\n## ocamposimon25 — depósitos COMPLETED en Orion:', deps.length);
    console.table(deps.map((d:any)=>({ amountPaid:d.amountPaid, depositValue:d.depositValue, moneda:d.coin, red:d.network, fiat:d.isFIATPayment })));
    const sPaid = deps.reduce((s:number,d:any)=>s+(d.amountPaid||0),0);
    const sVal  = deps.reduce((s:number,d:any)=>s+(d.depositValue||0),0);
    console.log('\n  suma amountPaid   :', sPaid.toFixed(4), ' <- lo que sumo YO');
    console.log('  suma depositValue :', sVal.toFixed(8), ' <- lo que suma ATLAS');
    console.log('  Atlas reportó     : 603.11709649');
    console.log('  nosotros          : 687.90');
    return null;
  });
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,250)));
