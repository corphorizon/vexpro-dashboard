// Verifica que las funciones SECURITY DEFINER "server-only" NO sean
// ejecutables por los roles del navegador (`anon` / `authenticated`).
//
//   npx tsx scripts/check-rpc-grants.ts
//
// Sale con código != 0 si algo está mal → sirve para colgarlo de CI.
// Es SOLO LECTURA (consulta el catálogo de Postgres); se puede correr contra
// producción sin riesgo.
//
// ── POR QUÉ EXISTE ESTE SCRIPT ────────────────────────────────────────────
// Postgres concede EXECUTE a PUBLIC automáticamente al CREAR una función.
// PUBLIC incluye a `anon` y `authenticated`. Y —acá está la trampa— hacer
//
//     REVOKE EXECUTE ON FUNCTION foo() FROM anon, authenticated;
//
// NO quita el grant de PUBLIC: revoca un permiso directo que esos roles
// nunca tuvieron, así que el comando "funciona" (sin error, sin warning) y
// la función SIGUE siendo ejecutable por cualquiera con la anon key.
// Por eso los revokes de las migraciones 051/054/076 parecían aplicados y no
// lo estaban; recién 077/078 agregaron el `REVOKE ... FROM PUBLIC` que hacía
// falta. La forma correcta de VERIFICAR el resultado no es leer los revokes
// del SQL ni mirar `proacl`, sino preguntarle a Postgres por el permiso
// efectivo del rol:
//
//     has_function_privilege('anon', p.oid, 'EXECUTE')
//
// que ya considera PUBLIC, la herencia de roles y los grants directos.
//
// ── EL MATIZ DE LOS HELPERS DE AUTH ───────────────────────────────────────
// Los helpers (is_superadmin, auth_company_ids, …) los invocan las políticas
// de RLS, que se evalúan CON EL ROL DEL CONSULTANTE. Si se les revoca EXECUTE
// a `authenticated`, toda consulta de un usuario logueado falla: hay que
// dejarlos ejecutables por `authenticated` y bloqueados sólo para `anon`.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import pkg from 'pg';

const { Client } = pkg;

for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

/** Funciones que sólo debe poder llamar el service_role (server-side). */
const SERVER_ONLY = [
  'get_period_totals_by_month',
  'next_payment_order_number',
  'close_period',
  'reopen_period',
  'replace_channel_ledger_day',
  'split_liquidity_movement',
  'rls_auto_enable',
];

/** Helpers que usan las políticas de RLS: anon NO, authenticated SÍ. */
const AUTH_HELPERS = [
  'is_superadmin',
  'auth_company_ids',
  'auth_user_company_id',
  'auth_user_role', // dos sobrecargas: () y (p_company_id uuid)
  'auth_can_edit',
  'auth_can_manage',
];

interface Row {
  schema: string;
  name: string;
  args: string;
  prosecdef: boolean;
  anon_exec: boolean;
  auth_exec: boolean;
}

const SQL = `
  SELECT n.nspname                                         AS schema,
         p.proname                                         AS name,
         pg_get_function_identity_arguments(p.oid)         AS args,
         p.prosecdef                                       AS prosecdef,
         has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = ANY($1::text[])
   ORDER BY p.proname, args
`;

async function main() {
  const host = process.env.SUPABASE_DB_HOST;
  const user = process.env.SUPABASE_DB_USER;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!host || !user || !password) {
    console.error('Faltan SUPABASE_DB_HOST / SUPABASE_DB_USER / SUPABASE_DB_PASSWORD en .env.local');
    process.exit(2);
  }

  const client = new Client({
    host,
    port: Number(process.env.SUPABASE_DB_PORT || 5432),
    user,
    database: process.env.SUPABASE_DB_NAME || 'postgres',
    password,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 30_000,
    query_timeout: 30_000,
  });

  await client.connect();
  const problems: string[] = [];
  try {
    const { rows } = await client.query<Row>(SQL, [[...SERVER_ONLY, ...AUTH_HELPERS]]);
    const byName = new Map<string, Row[]>();
    for (const r of rows) {
      const list = byName.get(r.name) ?? [];
      list.push(r);
      byName.set(r.name, list);
    }

    const check = (names: string[], kind: 'server-only' | 'helper') => {
      console.log(`\n── ${kind === 'server-only' ? 'Server-only (anon NO, authenticated NO)' : 'Helpers de RLS (anon NO, authenticated SÍ)'} ──`);
      for (const name of names) {
        const found = byName.get(name);
        // Una función que ya no existe deja el chequeo vacío sin que nadie se
        // entere: se reporta como problema, no como "pasó".
        if (!found || found.length === 0) {
          problems.push(`${name}: no existe en el esquema public (¿renombrada o borrada? actualizá la lista)`);
          console.log(`  ✗ ${name} — NO ENCONTRADA`);
          continue;
        }
        for (const r of found) {
          const sig = `${r.name}(${r.args})`;
          const anonBad = r.anon_exec;
          const authBad = kind === 'server-only' ? r.auth_exec : !r.auth_exec;
          if (anonBad) {
            problems.push(`${sig}: EJECUTABLE POR anon — falta REVOKE EXECUTE ... FROM PUBLIC (revocarle sólo a anon/authenticated no alcanza)`);
          }
          if (authBad && kind === 'server-only') {
            problems.push(`${sig}: EJECUTABLE POR authenticated — falta REVOKE EXECUTE ... FROM PUBLIC`);
          }
          if (authBad && kind === 'helper') {
            problems.push(`${sig}: NO ejecutable por authenticated — las políticas de RLS lo llaman con el rol del consultante y romperían el acceso de todos`);
          }
          const ok = !anonBad && !authBad;
          console.log(
            `  ${ok ? '✓' : '✗'} ${sig}` +
            `  [definer=${r.prosecdef ? 'sí' : 'NO'}, anon=${r.anon_exec}, authenticated=${r.auth_exec}]`,
          );
        }
      }
    };

    console.log(`Grants efectivos vía has_function_privilege() — ${host}`);
    check(SERVER_ONLY, 'server-only');
    check(AUTH_HELPERS, 'helper');
  } finally {
    await client.end();
  }

  if (problems.length > 0) {
    console.error(`\n❌ ${problems.length} problema(s) de permisos:`);
    for (const p of problems) console.error(`   · ${p}`);
    console.error('\nArreglo: REVOKE EXECUTE ON FUNCTION <f> FROM PUBLIC; (y GRANT sólo a quien corresponda).');
    process.exit(1);
  }
  console.log('\n✅ Todos los grants son los esperados.');
}

main().catch((err) => {
  console.error('❌ check-rpc-grants falló:', err instanceof Error ? err.message : err);
  process.exit(2);
});
