import { readFileSync } from 'node:fs';
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
async function main(){
  const { withOrionMongo } = await import('../src/lib/api-integrations/orion-mongo/client');
  await withOrionMongo('71715987-5479-52c4-a990-c414fb3a9b36', async ({ db }: any) => {
    const [g] = await db.collection('deposits').aggregate([
      { $match: { depositStatus: 'COMPLETED' } },
      { $group: { _id: null, n:{$sum:1},
          sumaPagado: { $sum: '$amountPaid' }, sumaDeclarado: { $sum: '$depositValue' },
          iguales: { $sum: { $cond: [{ $eq: ['$amountPaid','$depositValue'] }, 1, 0] } },
          pagoMas: { $sum: { $cond: [{ $gt: ['$amountPaid','$depositValue'] }, 1, 0] } },
          pagoMenos:{ $sum: { $cond: [{ $lt: ['$amountPaid','$depositValue'] }, 1, 0] } },
          maxDeclarado: { $max: '$depositValue' }, maxPagado: { $max: '$amountPaid' } } },
    ]).toArray();
    console.log('\n## Los 17.769 depósitos COMPLETED de Orion');
    console.log('  suma de amountPaid   (lo que llegó)      : $' + Number(g.sumaPagado).toLocaleString('es',{maximumFractionDigits:2}));
    console.log('  suma de depositValue (lo que se declaró) : $' + Number(g.sumaDeclarado).toLocaleString('es',{maximumFractionDigits:2}));
    console.log('  diferencia                               : $' + (g.sumaPagado-g.sumaDeclarado).toLocaleString('es',{maximumFractionDigits:2}));
    console.log('\n  coinciden exactamente :', g.iguales, `(${(100*g.iguales/g.n).toFixed(1)}%)`);
    console.log('  llegó MÁS de lo declarado :', g.pagoMas);
    console.log('  llegó MENOS               :', g.pagoMenos);
    console.log('\n  máximo declarado (depositValue):', Number(g.maxDeclarado).toExponential(3));
    console.log('  máximo pagado    (amountPaid)  :', Number(g.maxPagado).toLocaleString('es'));
    // ¿esta corrupto depositValue incluso en los completados?
    const raros = await db.collection('deposits').countDocuments({ depositStatus:'COMPLETED', depositValue: { $gt: 1e6 } });
    console.log('\n  depósitos COMPLETED con depositValue > 1 millón:', raros);
    return null;
  });
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,250)));
