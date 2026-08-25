import { readFileSync } from 'node:fs'; import pkg from 'pg'; const { Client } = pkg;
const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH+'/.env.prod','utf8').split('\n')) { const m=l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if(m)process.env[m[1]]=m[2]; }
for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^(SUPABASE_DB_[A-Z]+)=(.*)$/); if(m)process.env[m[1]]=m[2].replace(/^"|"$/g,''); }
async function main(){
  const CID='71715987-5479-52c4-a990-c414fb3a9b36';
  const pg=new Client({host:process.env.SUPABASE_DB_HOST,port:Number(process.env.SUPABASE_DB_PORT||5432),user:process.env.SUPABASE_DB_USER,password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}});
  await pg.connect();
  const r = await pg.query(`select a.login from mt5_account_activity a
    join crm_user_snapshots u on lower(u.email)=a.email and u.company_id=a.company_id
    join crm_withdrawals w on w.user_external_id=u.user_external_id and w.company_id=u.company_id
    where a.company_id=$1 and not a.is_demo and a.deals_count>0 and w.status_norm='pending' limit 60`,[CID]);
  const logins = r.rows.map(x=>String(x.login));
  console.log('cuentas de prueba:', logins.length);
  const { withMt5Connection } = await import('../src/lib/api-integrations/mt5-sql/client');
  await withMt5Connection(CID, async (s:any) => {
    const ph = logins.map(()=>'?').join(',');
    let t=Date.now();
    // duración por posición: se emparejan entrada y salida por PositionID
    const dur = await s.query(
      `SELECT Login, COUNT(*) posiciones,
              AVG(dur) dur_media_seg, MIN(dur) dur_min, 
              SUM(CASE WHEN dur < 60 THEN 1 ELSE 0 END) menos_1min,
              SUM(CASE WHEN dur < 300 THEN 1 ELSE 0 END) menos_5min
         FROM (SELECT Login, PositionID,
                      TIMESTAMPDIFF(SECOND, MIN(TimeMsc), MAX(TimeMsc)) dur
                 FROM mt5_deals
                WHERE Login IN (${ph}) AND Entry IN (0,1) AND PositionID > 0
                GROUP BY Login, PositionID
                HAVING COUNT(*) >= 2) x
        GROUP BY Login`, logins);
    console.log('\n## Duración de operaciones (' + (Date.now()-t) + ' ms) — ' + dur.length + ' cuentas');
    console.table(dur.slice(0,6).map((x:any)=>({ Login:String(x.Login), posiciones:Number(x.posiciones),
      dur_media_seg:Math.round(Number(x.dur_media_seg)), menos_1min:Number(x.menos_1min), menos_5min:Number(x.menos_5min) })));
    return null;
  });
  await pg.end();
}
main().catch(e=>console.log('EXCEPCION:', (e?.message??String(e)).slice(0,250)));
