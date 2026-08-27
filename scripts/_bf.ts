import { readFileSync } from 'node:fs';
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
const CO='71715987-5479-52c4-a990-c414fb3a9b36';
const APLICAR = process.argv.includes('--aplicar');

async function main(){
  const { createAdminClient } = await import('../src/lib/supabase/admin');
  const { withMt5Connection } = await import('../src/lib/api-integrations/mt5-sql/client');
  const admin = createAdminClient();

  // 1. Equity de TODAS las cuentas del servidor, en una consulta
  const equities = await withMt5Connection(CO, async (s) => {
    const r = await s.query('SELECT Login, Equity FROM mt5_accounts');
    return new Map<number, number>(r.map((x)=>[Number(x.Login), Number(x.Equity)]));
  });
  console.log(`equity leído de MT5: ${equities.size} cuentas`);

  // 2. Las filas del espejo que no lo tienen
  const faltan: number[] = [];
  for (let from=0;;from+=1000) {
    const { data, error } = await admin.from('mt5_account_activity')
      .select('login').eq('company_id', CO).is('equity', null)
      .order('login',{ascending:true}).range(from, from+999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) faltan.push(Number(r.login));
    if ((data?.length ?? 0) < 1000) break;
  }
  const conDato = faltan.filter(l => equities.has(l));
  console.log(`filas sin equity: ${faltan.length}   de esas, con dato en MT5: ${conDato.length}`);
  console.log(`sin dato en MT5 (cuenta borrada o sin fila): ${faltan.length - conDato.length}`);

  if (!APLICAR) { console.log('\n(simulación — nada escrito)'); return; }

  // 3. Rellenar. `synced_at` se mueve A PROPÓSITO: es el cursor del consumidor,
  //    y si no se mueve nunca verían el valor nuevo.
  const ahora = new Date().toISOString();
  let escritas = 0;
  for (let i=0; i<conDato.length; i+=500) {
    const lote = conDato.slice(i, i+500).map(login => ({
      company_id: CO, login, equity: equities.get(login)!, synced_at: ahora,
    }));
    const { error } = await admin.from('mt5_account_activity')
      .upsert(lote, { onConflict: 'company_id,login' });
    if (error) throw new Error(error.message);
    escritas += lote.length;
    if (escritas % 5000 === 0) console.log(`  ${escritas}...`);
  }
  console.log(`\nrellenadas: ${escritas}`);
}
main().catch(e=>console.log('EXCEPCION:', e?.message??String(e)));
