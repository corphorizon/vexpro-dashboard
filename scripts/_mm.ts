import { readFileSync } from 'node:fs';
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
async function main(){
  const { withOrionMongo } = await import('../src/lib/api-integrations/orion-mongo/client');
  await withOrionMongo('71715987-5479-52c4-a990-c414fb3a9b36', async ({ db }: any) => {
    // ¿Cuántos depósitos se acreditan en MÁS de un movimiento de billetera?
    const r = await db.collection('wallettransfers').aggregate([
      { $match: { concept: 'DEPOSIT' } },
      { $group: { _id: '$relatedConceptId', movimientos: { $sum: 1 }, total: { $sum: '$netAmount' } } },
      { $group: { _id: '$movimientos', depositos: { $sum: 1 }, suma: { $sum: '$total' } } },
      { $sort: { _id: 1 } },
    ], { maxTimeMS: 120000 }).toArray();
    console.log('\n## ¿En cuántos movimientos se acredita un depósito?');
    console.table(r.map((x:any)=>({ movimientos:x._id, depositos:x.depositos, suma:'$'+Number(x.suma).toLocaleString('es',{maximumFractionDigits:0}) })));
    const tot = r.reduce((s:number,x:any)=>s+x.depositos,0);
    const multi = r.filter((x:any)=>x._id>1).reduce((s:number,x:any)=>s+x.depositos,0);
    console.log(`\n  depósitos con MÁS de un movimiento: ${multi} de ${tot} (${(100*multi/tot).toFixed(1)}%)`);
    console.log('  → Si el negocio dijera que cada movimiento es un depósito,');
    console.log(`    el conteo subiría en ${multi} casos y el traspaso a Retención SÍ cambiaría.`);
    return null;
  });
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,250)));
