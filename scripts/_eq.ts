import { readFileSync } from 'node:fs';
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
async function main(){
  const { withMt5Connection } = await import('../src/lib/api-integrations/mt5-sql/client');
  await withMt5Connection('71715987-5479-52c4-a990-c414fb3a9b36', async (s:any) => {
    const c = await s.query('SHOW COLUMNS FROM mt5_users');
    console.log('  mt5_users tiene Equity?', c.some((x:any)=>x.Field==='Equity'));
    const a = await s.query('SHOW COLUMNS FROM mt5_accounts');
    console.log('  mt5_accounts:', a.map((x:any)=>x.Field).join(', '));
    const t0=Date.now();
    const r = await s.query("SELECT COUNT(*) n, SUM(CASE WHEN Equity<>Balance THEN 1 ELSE 0 END) difieren FROM mt5_accounts");
    console.log('  cuentas en mt5_accounts:', JSON.stringify(r[0]), `(${Date.now()-t0}ms)`);
    return null;
  });
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,200)));
