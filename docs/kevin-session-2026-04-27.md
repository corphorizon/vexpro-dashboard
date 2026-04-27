# Sesión 2026-04-27 (lado Stiven) — Refactor invitación de usuarios + fixes superadmin viewing-as + tabla duración Risk

**Para:** Kevin (y tu Claude Code)
**De:** Stiven + IA pair-programming
**Base:** `main` con tus últimos commits incluidos (`dbecb79` net deposit + safety-net per-provider).
**Estado:** pusheado a `main`, deploy en Vercel.
**Commits:** 3 — ver `git log --oneline -3` después del push.

---

## TL;DR

Cuatro cambios agrupados en 3 commits porque no comparten archivos entre sí.

1. **Refactor invitación de usuarios** — abandono total del patrón
   "admin tipea contraseña inicial". Ahora superadmin y tenant admin
   crean al usuario, el sistema le manda email con link de setup, y el
   usuario crea su propia contraseña en `/reset-password?token=...&mode=setup`.
   Helper compartido `src/lib/invite-user.ts`. Botón "Reenviar invitación"
   en ambos panels (superadmin y tenant admin) para los usuarios que
   todavía no activaron su cuenta.

2. **Fix lista usuarios vacía cuando superadmin entra "viewing-as"** — el
   browser-side `from('company_users').select(...).eq('company_id', X)`
   en `auth-context.tsx` quedaba filtrado por RLS porque el superadmin
   no tiene fila en `company_users` del tenant target. Solución: nueva
   ruta `GET /api/admin/list-company-users` que va por `createAdminClient()`
   (service-role, bypass RLS). `fetchAllUsers` en `auth-context` ahora
   llama a esta ruta vía `withActiveCompany()`. Además se agregó un
   listener `subscribeActiveCompanyId` para refetchear cuando el
   superadmin cambia de empresa "viewing-as" sin recargar la página.

3. **Unificación UI módulos del form Crear Usuario** — el form de
   `/usuarios` ahora importa `ALL_MODULES` desde
   `@/app/superadmin/companies/_form` (single source of truth) y usa
   la misma grilla de checkboxes 2/3-col que el superadmin. Antes eran
   botones rectangulares con lista desordenada distinta. Misma fuente,
   mismo orden, mismas labels.

4. **Tabla "Distribución por Duración" en Risk PropFirm + parser fixes** —
   panel adicional en `/risk/retiros-propfirm` que agrupa retiros por
   bucket de duración. Parser de Excel (`src/lib/risk/parser.ts`)
   ahora maneja UTF-16 y celdas merged vacías sin tirar todo el row.

---

## ⚠️ Importante — cambios que pueden afectar tu código

### 1. Flujo de creación de usuario — ya no se acepta password inicial

`POST /api/admin/create-user` y `POST /api/superadmin/users` **NO**
aceptan más `password` en el body. El cliente debe pasar
`{ email, name, role, allowed_modules }` (más `company_id` en el caso
del superadmin) y nada más.

El usuario invitado recibe un email con link a
`/reset-password?token=<token>&mode=setup`. El token se guarda en una
nueva tabla `password_setup_tokens` (ya migrada). Expira a las 24h.

**Si tenés código que llama a estos endpoints con `password`**, hay que
removerlo. El backend ahora ignora ese campo y el usuario no podrá
loguear con esa contraseña — debe pasar por el flujo de invitación.

### 2. `GET /api/admin/list-company-users` — endpoint nuevo

Devuelve los `company_users` de la empresa del caller, con
`effective_role` resuelto server-side (custom roles → base_role).
Bypassa RLS via `createAdminClient()`. Auth: `verifyAdminAuth(request)`
(misma que el resto de `/api/admin/*` — admin/auditor/hr; superadmin
con `?company_id=<uuid>`).

Lo usa `auth-context.tsx::fetchAllUsers` para popular `users[]` en el
provider. Si toqás algo del listado de usuarios desde el browser, usá
este endpoint en vez de query directa a Supabase.

### 3. `auth-context.tsx::effectiveCompanyIdFor(profile)`

Helper nuevo que devuelve `profile.company_id ?? getActiveCompanyId()`.
Para tenant users es su company_id; para superadmin (company_id=null)
es la empresa del "viewing-as" (localStorage).

Todos los call-sites del provider que necesitan companyId ya lo usan
(init, SIGNED_IN, refresh, login, loginWith2fa, createUser, updateUser,
updateUserDirect, deleteUser).

### 4. `subscribeActiveCompanyId` — listener nuevo en el provider

Cuando cambia `horizon.superadmin.activeCompanyId` en localStorage, el
provider refetchea `users[]`. Solo aplica a superadmin (tenant users
ignoran el listener porque tienen `company_id` no nulo).

Si en algún componente tuyo dependés de `users[]` del provider,
ahora se actualiza automáticamente al cambiar de "viewing-as".

### 5. `/reset-password?mode=setup`

El mismo endpoint sirve para 2 casos:
- `?mode=reset` (default) — usuario olvidó su password
- `?mode=setup` — primera activación tras invitación

Cambia el copy ("Crear contraseña" vs "Restablecer contraseña") y
limpia el flag `must_change_password` cuando es setup.

### 6. `src/lib/invite-user.ts` — helper compartido

Centraliza:
- `generateAndSendInvite({ admin, authUserId, recipientEmail, ... })`
- `resolveInviterName(admin, userId)` — nombre del que invita para el email
- `originFromRequest(request)` / `ipFromRequest(request)` — utilidades para audit

Tanto `/api/admin/create-user` como `/api/superadmin/users` lo usan.
También las rutas `/api/admin/users/[id]/resend-invite` y
`/api/superadmin/users/[id]/resend-invite` (botón "Reenviar").

### 7. UI módulos — fuente única `@/app/superadmin/companies/_form`

`ALL_MODULES` con `{ key, label }` está en
`src/app/superadmin/companies/_form.tsx`. Lo importan
`/superadmin/users/page.tsx` y `/usuarios/page.tsx`. Si querés
agregar un módulo nuevo a la app, agregalo ahí y se ve en los 2 forms
automáticamente.

`MODULE_LABELS` en `auth-context.tsx` se mantiene para las celdas de
las tablas de usuarios (no toqué eso porque la regla del task lo
prohibía y está OK como segunda referencia hasta unificarse).

### 8. Risk PropFirm — `getDurationDistribution()` en `src/lib/risk/duration-distribution.ts`

Función nueva que recibe los retiros parseados y devuelve buckets
por duración (`< 1 día`, `1-3 días`, `3-7 días`, `7-15 días`,
`15-30 días`, `30+ días`). La componente
`src/components/risk/duration-distribution-table.tsx` la consume.

Si tenés algún reporte que use el parser de Excel de PropFirm, no
debería romper nada — los fixes del parser (UTF-16, celdas merged)
son aditivos, no rompen el contrato anterior.

---

## Archivos tocados / nuevos

### Refactor invitación + fix viewing-as
**Modificados:**
- `src/app/api/admin/create-user/route.ts`
- `src/app/api/superadmin/users/route.ts`
- `src/app/(dashboard)/usuarios/page.tsx`
- `src/app/superadmin/users/page.tsx`
- `src/app/reset-password/page.tsx`
- `src/lib/auth-context.tsx`
- `src/lib/i18n.tsx` (labels `users.sendInvite`, `users.resendInvite`)
- `src/services/emailService.ts` (`sendInvitationEmail`)

**Nuevos:**
- `src/lib/invite-user.ts`
- `src/app/api/admin/list-company-users/route.ts`
- `src/app/api/admin/users/[id]/resend-invite/route.ts`
- `src/app/api/superadmin/users/[id]/resend-invite/route.ts`

### Risk PropFirm — tabla duración
**Modificados:**
- `src/app/(dashboard)/risk/retiros-propfirm/page.tsx`
- `src/lib/risk/parser.ts`

**Nuevos:**
- `src/lib/risk/duration-distribution.ts`
- `src/components/risk/duration-distribution-table.tsx`

---

## Cosas que NO toqué (por reglas)

- `comisiones`, `RRHH`, `despidos`, `PnL Especial` — todo lo de tu sesión `530554c` queda intacto.
- Parser de Excel "regular" (movimientos/egresos/etc.) — solo el de Risk PropFirm.
- `forgot-password`, `reset-password-confirm`, página inicial de `reset-password` — UI nueva por
  `?mode=setup` se adicionó sin tocar el flujo de reset existente.
- `auth-context.onAuthStateChange`, login/logout, inactivity timer — quedan como estaban.
- Tabla de usuarios registrados en `/usuarios` (columnas, botones) — no la toqué; solo el form de creación.

---

## Estado deploy / verificación

- `npx tsc --noEmit` ✅ sin errores
- `npm run build` ✅ sin errores
- `localhost:3100` testeado:
  - Superadmin entra "viewing as" Vex Pro → `/usuarios` muestra la lista (antes: 0).
  - Cambio de empresa "viewing-as" sin reload → lista refresca solo.
  - Form "Crear Usuario" tenant admin → grilla 2/3-col idéntica a superadmin, sin password.
  - Click "Enviar invitación" → recibe correo con link de setup → password creado → login OK.
  - Botón "Reenviar invitación" para usuarios con `must_change_password=true`.
  - Risk PropFirm — tabla "Distribución por Duración" se renderiza correctamente con un .xlsx UTF-16.

---

## Próximos pasos pendientes (no urgentes)

- Unificar `MODULE_LABELS` (auth-context) con `ALL_MODULES` (_form). Hoy
  conviven porque la tabla de usuarios todavía usa el primero. Pull
  request chico cuando haya espacio.
- Activar el tab "Roles" en `/usuarios` cuando `hasModuleAccess()` sepa
  resolver custom roles via `effective_role` (TODO ya documentado en
  el comentario de la página).
