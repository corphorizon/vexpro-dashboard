import fs from 'node:fs'; import pg from 'pg';
const env=Object.fromEntries(fs.readFileSync(new URL('../.env.local',import.meta.url),'utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const c=new pg.Client({host:env.SUPABASE_DB_HOST,port:+env.SUPABASE_DB_PORT,user:env.SUPABASE_DB_USER,database:env.SUPABASE_DB_NAME,password:env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},application_name:'diag_grants_ro'});
await c.connect(); await c.query('SET default_transaction_read_only = on');
const r=await c.query(`select p.proname, pg_get_userbyid(p.proowner) owner, p.proacl::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('auth_company_ids','is_superadmin','auth_is_hr_reader')`);
console.log(r.rows);
for (const role of ['anon','authenticated','service_role']) {
  for (const fn of ['auth_company_ids','is_superadmin','auth_is_hr_reader']) {
    const q=await c.query(`select has_function_privilege($1, $2, 'EXECUTE') e`,[role, `public.${fn}()`]).catch(e=>({rows:[{e:'ERR '+e.message.slice(0,50)}]}));
    console.log(role.padEnd(14), fn.padEnd(20), q.rows[0].e);
  }
}
// policy permissive/restrictive
const p=await c.query(`select tablename, policyname, permissive, cmd, roles::text from pg_policies where schemaname='public' and tablename in ('commercial_monthly_results','commercial_profiles','employees','periods','companies') order by tablename`);
console.table(p.rows);
// table-level grants
const g=await c.query(`select table_name, grantee, string_agg(privilege_type,',') p from information_schema.role_table_grants where table_schema='public' and table_name in ('companies','periods','commercial_monthly_results','expenses','deposits') and grantee in ('anon','authenticated','service_role') group by 1,2 order by 1,2`);
console.table(g.rows);
await c.end();
