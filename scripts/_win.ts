import { readFileSync } from 'node:fs';
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
async function main(){
  const { withOrionMongo } = await import('../src/lib/api-integrations/orion-mongo/client');
  await withOrionMongo('71715987-5479-52c4-a990-c414fb3a9b36', async ({ db }: any) => {
    const DEP='fec85ebe-04f2-4055-bdc7-02c2c9939a47';
    const w = await db.collection('wallettransfers').find({ relatedConceptId: DEP }).toArray();
    console.log('\n## El depósito: depositValue=500,50  amountPaid=608');
    console.log('## Lo que dice el libro de la billetera:');
    console.table(w.map((x:any)=>({ concepto:x.concept, bruto:x.grossAmount, comision:x.fee, neto:x.netAmount, tipo:x.walletTransferType })));
    // a escala: ¿el neto sigue a amountPaid o a depositValue?
    const muestra = await db.collection('deposits').find({ depositStatus:'COMPLETED', $expr:{$ne:['$amountPaid','$depositValue']} },
      { projection:{ depositId:1, amountPaid:1, depositValue:1 }, limit: 300 }).toArray();
    const ids = muestra.map((d:any)=>d.depositId);
    const trans = await db.collection('wallettransfers').find({ relatedConceptId: { $in: ids } },
      { projection:{ relatedConceptId:1, grossAmount:1, netAmount:1 } }).toArray();
    const porId = new Map(trans.map((t:any)=>[t.relatedConceptId, t]));
    let sigueAPagado=0, sigueADeclarado=0, ninguno=0, sinTransfer=0;
    for (const d of muestra) {
      const t:any = porId.get(d.depositId);
      if (!t) { sinTransfer++; continue; }
      const cerca=(a:number,b:number)=>Math.abs(a-b)<0.02;
      if (cerca(t.grossAmount, d.amountPaid) || cerca(t.netAmount, d.amountPaid)) sigueAPagado++;
      else if (cerca(t.grossAmount, d.depositValue) || cerca(t.netAmount, d.depositValue)) sigueADeclarado++;
      else ninguno++;
    }
    console.log('\n## Sobre 300 depósitos donde los dos importes DIFIEREN,');
    console.log('   ¿a cuál se parece lo que entró a la billetera?');
    console.table([{ 'coincide con amountPaid': sigueAPagado, 'coincide con depositValue': sigueADeclarado, 'ninguno': ninguno, 'sin movimiento': sinTransfer }]);
    return null;
  });
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,250)));
