import { config } from 'dotenv';
config({ path: '.env.local' });
import { withMt5Connection } from '../src/lib/api-integrations/mt5-sql/client';
const VEXPRO = '71715987-5479-52c4-a990-c414fb3a9b36';

async function main() {
  await withMt5Connection(VEXPRO, async (s) => {
    for (const [login, conexion] of [['148257','2026-06-10'],['146052','2026-06-12'],['146417','2026-06-12']] as const) {
      const antes = await s.query<Record<string, unknown>>(
        `SELECT SUM(CASE WHEN Entry IN (1,3) THEN 1 ELSE 0 END) ops,
                SUM(Profit+Storage+Commission) pnl
           FROM mt5_deals WHERE Login=? AND Action IN (0,1)
            AND TimeMsc>=? AND TimeMsc<?`,
        [Number(login), '2026-06-01 00:00:00', `${conexion} 00:00:00`]);
      const a = antes[0]!;
      const ops = Number(a.ops) || 0;
      console.log(
        `Cuenta ${login} (conectada ${conexion}) — del 1 de junio hasta conectarse: ` +
        `${ops} ops, pnl=${(Number(a.pnl)||0).toFixed(2)}  ${ops > 0 ? '<- SI opero antes' : '<- no opero antes'}`);
    }
  });
}
main().then(()=>process.exit(0)).catch((e)=>{console.error(e.message??e);process.exit(1);});
