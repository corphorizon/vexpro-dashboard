import { readFileSync } from 'node:fs';
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
const CO='71715987-5479-52c4-a990-c414fb3a9b36';
async function main(){
  const { withMt5Connection } = await import('../src/lib/api-integrations/mt5-sql/client');
  const { withOrionMongo } = await import('../src/lib/api-integrations/orion-mongo/client');

  // Transferencias del CRM hacia cuentas Cent, en USD
  const transfers = await withOrionMongo(CO, async ({ db }:any) =>
    db.collection('wallettransfers').find(
      { walletTransferType:'OUT', concept:{ $in:['TRANSFER_FUNDS','WALLET_TRANSFER'] } },
      { projection:{ userId:1, netAmount:1, accountId:1, concept:1, createdAt:1 } }).limit(4000).toArray());
  const porCuenta = new Map<string, number>();
  for (const t of transfers) {
    const k = String(t.accountId ?? '');
    if (!k) continue;
    porCuenta.set(k, (porCuenta.get(k) ?? 0) + (Number(t.netAmount)||0));
  }
  console.log(`transferencias del CRM leídas: ${transfers.length}, sobre ${porCuenta.size} cuentas`);

  await withMt5Connection(CO, async (s:any) => {
    const logins = [...porCuenta.keys()].map(Number).filter(Number.isFinite).slice(0,400);
    if (!logins.length) { console.log('sin cuentas cruzables'); return null; }
    const ph = logins.map(()=>'?').join(',');
    const r = await s.query(
      `SELECT u.Login, g.Currency,
              (SELECT SUM(d.Profit) FROM mt5_deals d WHERE d.Login=u.Login AND d.Action=2 AND d.Profit>0) entrado
         FROM mt5_users u JOIN mt5_groups g ON g.\`Group\`=u.\`Group\`
        WHERE u.Login IN (${ph})`, logins);
    console.log('\n## MT5 (lo que entró a la cuenta) vs CRM (lo que salió de la billetera, en USD)\n');
    let cent=0, usd=0;
    for (const x of r) {
      const crm = porCuenta.get(String(x.Login)) ?? 0;
      const mt5 = Number(x.entrado)||0;
      if (crm <= 0 || mt5 <= 0) continue;
      const ratio = mt5/crm;
      if (String(x.Currency)==='USC' && cent<5) { cent++;
        console.log(`  USC  login=${String(x.Login).padEnd(7)} MT5=${String(mt5).padStart(12)}  CRM=${String(crm.toFixed(2)).padStart(10)} USD  ratio=${ratio.toFixed(1)}`); }
      if (String(x.Currency)==='USD' && usd<3) { usd++;
        console.log(`  USD  login=${String(x.Login).padEnd(7)} MT5=${String(mt5).padStart(12)}  CRM=${String(crm.toFixed(2)).padStart(10)} USD  ratio=${ratio.toFixed(1)}`); }
    }
    // el veredicto agregado
    let ratiosC:number[]=[], ratiosU:number[]=[];
    for (const x of r) {
      const crm = porCuenta.get(String(x.Login)) ?? 0; const mt5 = Number(x.entrado)||0;
      if (crm<=0||mt5<=0) continue;
      (String(x.Currency)==='USC'?ratiosC:ratiosU).push(mt5/crm);
    }
    const med=(a:number[])=>a.length?a.sort((x,y)=>x-y)[Math.floor(a.length/2)]:NaN;
    console.log(`\n  ratio MEDIANO en cuentas Cent (USC): ${med(ratiosC).toFixed(2)}   (n=${ratiosC.length})`);
    console.log(`  ratio MEDIANO en cuentas USD       : ${med(ratiosU).toFixed(2)}   (n=${ratiosU.length})`);
    return null;
  });
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,300)));
