// ─────────────────────────────────────────────────────────────────────────────
// Alta de usuarios de AP Markets con acceso de sólo lectura a todo.
//
// ── POR QUÉ UN SCRIPT Y NO /api/admin/create-user ──────────────────────────
// La ruta normal hace dos cosas que acá NO se quieren:
//   · pone una contraseña aleatoria de un solo uso, y
//   · MANDA UN CORREO DE INVITACIÓN a cada persona.
// Kevin pidió una clave fija y no pidió avisar a nadie. Mandar siete correos
// a personas reales no es un efecto secundario aceptable de "creá los usuarios".
//
// ── EL ROL ─────────────────────────────────────────────────────────────────
// `socio` con TODOS los módulos. En este dashboard el rol decide qué se puede
// CAMBIAR y `allowed_modules` decide qué se VE: un socio con todo marcado ve
// la aplicación entera y no puede escribir nada. Es exactamente "el rol que
// puede ver todo", y es además la etiqueta (Partner) que ya tenían.
//
// Correr con `--aplicar` para que escriba. Sin eso, sólo dice qué haría.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';

const SCRATCH = process.env.SCRATCH!;
for (const l of readFileSync(SCRATCH + '/.env.prod', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const COMPANY_ID = '356ada44-b7af-4983-ac84-8685dcc8c22e'; // AP Markets
const PASSWORD = process.env.AP_PWD!;
const APLICAR = process.argv.includes('--aplicar');

const PERSONAS = [
  { name: 'Mateo Ibañez', email: 'm.ibanez@mail.ap-markets.com' },
  { name: 'Yuri Bustamante', email: 'y.bustamante@mail.ap-markets.com' },
  { name: 'Lucas Macias Estrada', email: 'l.macias@mail.ap-markets.com' },
  { name: 'Natalia Morales', email: 'n.morales@mail.ap-markets.com' },
  { name: 'Jhonnatan Hernandez', email: 'j.hernandez@mail.ap-markets.com' },
  { name: 'Alejandro Palau', email: 'a.palau@mail.ap-markets.com' },
  { name: 'Juan Daniel Escobar', email: 'j.escobar@mail.ap-markets.com' },
];

async function main() {
  const { createAdminClient } = await import('../src/lib/supabase/admin');
  const { MODULES } = await import('../src/lib/modules');
  const admin = createAdminClient();

  const modulos = MODULES.map((m) => m.key);
  console.log(`\nEmpresa      : AP Markets (${COMPANY_ID})`);
  console.log(`Rol          : socio (solo lectura)`);
  console.log(`Módulos      : ${modulos.length} — ${modulos.join(', ')}`);
  console.log(`Contraseña   : ${PASSWORD ? '(la misma para los 7)' : '(NO DEFINIDA — abortar)'}`);
  console.log(`Modo         : ${APLICAR ? 'APLICAR' : 'simulación (no escribe nada)'}\n`);
  if (!PASSWORD) process.exit(1);

  // Se copian los ajustes de seguridad del admin que ya existe en la empresa,
  // en vez de inventar unos nuevos: si AP Markets exige 2FA, estos también.
  const { data: refe } = await admin
    .from('company_users')
    .select('force_2fa_setup, preferred_language')
    .eq('company_id', COMPANY_ID)
    .eq('role', 'admin')
    .limit(1)
    .maybeSingle();
  console.log(`Referencia del admin de la empresa: 2FA obligatorio=${refe?.force_2fa_setup} idioma=${refe?.preferred_language}\n`);

  // NO se pagina auth.users: son 21.000 y `listUsers` revienta con "Database
  // error finding users". Se comprobó por SQL que ninguno de los siete existe,
  // así que se crean directo y el error de duplicado —si algún día lo hubiera—
  // se reporta por persona en vez de abortar la corrida entera.
  const existentes = new Map<string, string>();

  for (const p of PERSONAS) {
    const email = p.email.trim().toLowerCase();
    let authId: string | null = existentes.get(email) ?? null;

    const { data: yaEs } = await admin
      .from('company_users')
      .select('id, role')
      .eq('company_id', COMPANY_ID)
      .ilike('email', email)
      .maybeSingle();

    if (yaEs) {
      console.log(`SALTA   ${p.name.padEnd(24)} ${email} — ya es miembro (rol ${yaEs.role})`);
      continue;
    }

    if (!APLICAR) {
      console.log(
        `CREARÍA ${p.name.padEnd(24)} ${email} — auth ${authId ? 'ya existe, se le pone la clave' : 'nuevo'}`,
      );
      continue;
    }

    if (authId) {
      const { error } = await admin.auth.admin.updateUserById(authId, { password: PASSWORD });
      if (error) { console.log(`ERROR   ${email}: ${error.message}`); continue; }
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        // Sin confirmar, el login rebota pidiendo verificar el correo — y no
        // se está mandando ningún correo.
        email_confirm: true,
      });
      if (error || !data?.user?.id) { console.log(`ERROR   ${email}: ${error?.message}`); continue; }
      authId = data.user.id;
    }

    const { error: memErr } = await admin.from('company_users').insert({
      user_id: authId,
      company_id: COMPANY_ID,
      email,
      name: p.name,
      role: 'socio',
      allowed_modules: modulos,
      // La clave la eligió Kevin y se la va a pasar él: forzar el cambio en el
      // primer login convertiría esa clave en inútil sin avisarle.
      must_change_password: false,
      force_2fa_setup: refe?.force_2fa_setup ?? true,
      preferred_language: refe?.preferred_language ?? 'es',
      status: 'active',
    });
    if (memErr) { console.log(`ERROR   ${email}: ${memErr.message}`); continue; }

    console.log(`CREADO  ${p.name.padEnd(24)} ${email}`);
  }

  console.log('\nListo.');
}

main().catch((e) => { console.log('EXCEPCION:', e?.message ?? String(e)); process.exit(1); });
