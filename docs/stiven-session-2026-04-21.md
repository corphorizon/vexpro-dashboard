# Sesión 2026-04-21 — Panel Superadmin: gestión de usuarios por organización + upload de logo

**Para:** Stiven (y tu Claude Code)
**De:** Kevin + IA pair-programming
**Base:** `main` (commit `41aa2a9` — deploy multi-tenant + Smart Dashboard branding)
**Estado:** pusheado a `origin/feature/superadmin-users-logo`, **NO mergeado a main** todavía — pending QA manual
**Rama para tu code:** `feature/superadmin-users-logo`
**PR URL:** https://github.com/corphorizon/vexpro-dashboard/pull/new/feature/superadmin-users-logo

---

## TL;DR

Dos features nuevas en el panel Superadmin:

1. **Gestión de usuarios por organización** — `/superadmin/companies/[id]/users`. Lista roster con avatar/rol/estado/2FA/último acceso, y un slide-over para editar cada usuario (nombre, email, rol, módulos accesibles, reset password, desactivar 2FA, activar/desactivar, historial últimas 5 acciones). Toda acción del superadmin queda auditada con diff legible.

2. **Upload de logo** — en el form de editar organización, el input de URL se reemplaza por un drag-and-drop que sube a Supabase Storage (bucket `company-logos`, se autocrea). Valida PNG/JPG/WEBP/SVG con magic bytes, 2MB máx. Preview inmediato y botón quitar logo (vuelve a iniciales).

Ambas features cierran huecos identificados en la Fase 6 del multitenancy rollout.

---

## 1. Schema change — migration 025

```sql
-- supabase/migration-025-company-users-status.sql
ALTER TABLE company_users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_company_users_status ON company_users(status);
```

**Ya aplicada** en el Supabase de prod via `node scripts/db-admin/run-sql-file.mjs`. Si tienes un entorno separado, córrela antes del merge.

**Por qué:**
- `status` — el superadmin necesita desactivar a un usuario sin borrar el row (preservamos audit continuity).
- `last_login_at` — se muestra en el roster. Lo stampea el login exitoso (ver punto 4).

---

## 2. Feature 1 — Panel de usuarios por organización

### Entrada UI
`/superadmin/companies/[id]` ahora tiene un link **Usuarios** al lado de los tabs existentes (Configuración / APIs externas / Auditoría). El link lleva a:

`/superadmin/companies/[id]/users`

### Lista (page.tsx)
Tabla con:
- Avatar con iniciales (color primario de la empresa)
- Nombre + email
- Badge de rol (6 colores, uno por rol)
- Estado (Activo/Inactivo con dot)
- 2FA (Activo / No configurado)
- Último acceso ("hace X min/h/d" relativo, o fecha absoluta si >30d)
- Botón **Gestionar** → abre slide-over

### Slide-over `_manage-panel.tsx`
Panel lateral derecho (`max-w-xl`, cierra con ESC o clic en backdrop). 4 secciones:

**Información básica**
- Nombre (editable)
- Email (editable — sincroniza con `auth.users.email` via Admin API)
- Estado toggle (Activo / Inactivo)

**Rol y permisos**
- Selector de rol: `admin | socio | auditor | soporte | hr | invitado` (los que permite el CHECK de `company_users.role` hoy)
- Checkboxes por módulo — filtrados por `companies.active_modules` de la empresa. El usuario no puede tener acceso a un módulo que la empresa no tenga activo.
- Botón "Guardar cambios"

**Seguridad**
- **Resetear contraseña** — usa `admin.auth.admin.generateLink({ type: 'recovery' })` con `redirectTo=/reset-password`. También limpia `failed_login_count` + `locked_until` (si un usuario está bloqueado, reset le devuelve acceso).
- **Desactivar 2FA** — borra `twofa_secret`, `twofa_pending_secret`, `twofa_enabled`. En el próximo login el flow fuerza re-enrolment.
- **Desactivar usuario** — toggle que flip `status`. Auditado por separado.

**Historial**
- Últimas 5 entries de `audit_logs` del usuario (filtradas por `company_id` + `user_id`).
- Link "Ver historial completo →" lleva a `/superadmin/companies/[id]?tab=audit`.

### 5 API routes nuevas
Todas protegidas con `verifySuperadminAuth()`:

| Método + path | Función |
|---|---|
| `GET /api/superadmin/companies/:id/users` | Roster con role/status/allowed_modules/twofa_enabled/last_login_at. Nunca retorna `twofa_secret`. |
| `PATCH /api/superadmin/companies/:id/users/:userId` | Whitelist: name, email, role, status, allowed_modules. Valida rol (enum DB) y status (active/inactive). Si cambia email, sync a `auth.users` primero; si falla auth, no tocamos el row. |
| `POST /api/superadmin/companies/:id/users/:userId/reset-password` | Genera recovery link + limpia lockout. |
| `POST /api/superadmin/companies/:id/users/:userId/disable-2fa` | Clear de los 3 campos de 2FA. |
| `GET /api/superadmin/companies/:id/users/:userId/audit?limit=5` | Audit entries del auth_user_id scoped por company_id. |

Todas las escrituras llaman a `serverAuditLog()` con un diff legible:

```
"Superadmin actualizó usuario foo@bar.com · role: \"admin\" → \"hr\" | status: \"active\" → \"inactive\""
```

### Helper nuevo — `src/lib/server-audit.ts`
Equivalente server-side de `src/lib/audit-log.ts`. El browser helper POSTea a `/api/admin/audit-log`; el server helper inserta directamente en `audit_logs` con el admin client (fire-and-forget, nunca throws).

```ts
serverAuditLog(admin, {
  companyId,
  actorId: auth.userId,
  actorName: auth.name || auth.email,
  action: 'update',
  module: 'users',
  details: '…',
});
```

---

## 3. Feature 2 — Upload de logo a Supabase Storage

### Route nuevo
`POST/DELETE /api/superadmin/companies/:id/logo`

- Acepta PNG, JPG, WEBP, SVG
- Máx 2MB, rechaza archivo vacío
- **Validación servidor-side autoritativa por magic bytes** (no confía en el MIME del cliente):
  - PNG: `89 50 4E 47 0D 0A 1A 0A`
  - JPEG: `FF D8 FF`
  - WEBP: `RIFF...WEBP`
  - SVG: detecta `<svg` en los primeros 512 bytes decodificados como UTF-8
- Path: `{companyId}/{timestamp}.{ext}`
- Autocrea el bucket `company-logos` en la primera subida con `{ public: true, fileSizeLimit: 2MB, allowedMimeTypes: [...] }`
- Al reemplazar, limpia el logo anterior del bucket (best-effort)
- Actualiza `companies.logo_url` con la public URL
- Audita cada upload + delete

**No se requiere crear el bucket manualmente.** El código lo hace al vuelo con service role key.

### Componente nuevo — `src/components/logo-uploader.tsx`
Drag-and-drop + click-to-browse. Reemplaza el input de URL en `CompanyForm`. Muestra preview inmediato via el `<CompanyLogo>` existente. Botón "Quitar logo" confirma y dispara DELETE.

Layout:
```
┌──────┬──────────────────────────────────────┐
│      │ ┌─ drop zone ────────────────────┐   │
│ LOGO │ │ 📤 Arrastra o elige archivo    │   │
│      │ │ PNG/SVG/JPG/WEBP — máx 2MB     │   │
│      │ └────────────────────────────────┘   │
│      │ 🗑 Quitar logo                      │
└──────┴──────────────────────────────────────┘
```

En modo `create` (`companyId` no existe todavía), el uploader muestra *"Podrás subir el logo después de crear la organización."* Hay que guardarla primero, después editar.

### Storage bucket — permisos
- Creado con `public: true` → cualquiera puede LEER los logos (necesario: aparecen en login page sin auth).
- ESCRITURA: sólo service role. Las routes que escriben ya validan superadmin.
- **No agregamos policies explícitas** porque sin policy INSERT pública, el anon key no puede subir — que es exactamente lo que queremos.
- Si más adelante dan permiso a admins no-superadmin para cambiar logo, hay que agregar policy basada en `company_id` en `storage.objects`.

---

## 4. Side effect — `last_login_at` se stampea en login

Dos puntos de escritura (dependiendo si el usuario tiene 2FA):

**`src/app/api/auth/login-gate/route.ts`** — si NO tiene 2FA, stampear después de validar password.

**`src/app/api/auth/verify-2fa/route.ts`** — si TIENE 2FA, stampear después de validar PIN (es el "success real" del login).

En ambos casos hacemos `UPDATE company_users SET last_login_at = now() WHERE id = <membership_id>`.

---

## 5. Archivos tocados

**Nuevos (10):**
```
supabase/migration-025-company-users-status.sql
src/lib/server-audit.ts
src/components/logo-uploader.tsx
src/app/api/superadmin/companies/[id]/logo/route.ts
src/app/api/superadmin/companies/[id]/users/route.ts
src/app/api/superadmin/companies/[id]/users/[userId]/route.ts
src/app/api/superadmin/companies/[id]/users/[userId]/reset-password/route.ts
src/app/api/superadmin/companies/[id]/users/[userId]/disable-2fa/route.ts
src/app/api/superadmin/companies/[id]/users/[userId]/audit/route.ts
src/app/superadmin/companies/[id]/users/page.tsx
src/app/superadmin/companies/[id]/users/_manage-panel.tsx
```

**Modificados (4):**
```
src/app/api/auth/login-gate/route.ts         (+last_login_at stamp)
src/app/api/auth/verify-2fa/route.ts         (+last_login_at stamp)
src/app/superadmin/companies/[id]/page.tsx   (+link Usuarios)
src/app/superadmin/companies/_form.tsx       (URL input → <LogoUploader />)
```

---

## 6. Limitaciones / decisiones conscientes

1. **Roles cerrados a los 6 existentes**: `admin | socio | auditor | soporte | hr | invitado`. El spec original mencionaba "Gerente, Supervisor, Team Member, Support" pero el CHECK de DB no los permite. No expandí el enum para no romper compatibilidad; si quieres agregar, necesita migración que extienda el CHECK.

2. **`audit_logs` no tiene `target_user_id`** (su schema existente tiene `user_id` = actor). Uso `details` para incluir el target (`"Superadmin actualizó usuario foo@bar.com..."`). El endpoint `/audit` del panel consulta por `user_id = target.user_id` para poder mostrar las acciones DEL usuario (no las HECHAS SOBRE el usuario). Si quieren separar "acciones hechas por X" de "acciones hechas sobre X", hay que agregar `target_user_id UUID` al schema.

3. **Cambio de email sincroniza a `auth.users`** via `admin.auth.admin.updateUserById`. Si la sync de auth falla, el PATCH retorna 500 y NO actualizamos `company_users.email` (consistencia fail-safe).

4. **Cleanup del bucket al quitar logo**: best-effort. Si el delete del file falla (permiso, transient), seguimos adelante y borramos el URL de la DB. El file queda huérfano pero no es visible en ningún lado.

5. **`/configuraciones/usuarios` (el panel de admin por empresa) NO cambió**. Sigue siendo el flujo para que el admin de una empresa invite/edite a sus usuarios. Este panel nuevo es exclusivamente para superadmin (CRUD sobre cualquier tenant).

---

## 7. QA manual sugerido antes de merge

Pending de parte de Kevin antes de mergear a main:

- [ ] Login superadmin → VexPro FX → tab Usuarios → abrir un usuario
- [ ] Cambiar rol + módulos → Guardar → verificar audit entry
- [ ] Resetear contraseña → confirmar que llega el email + el user puede loguear
- [ ] Desactivar 2FA en alguien con 2FA → re-login debería pedir enrolar de nuevo
- [ ] Desactivar usuario → intentar loguear con sus creds → debería bloquear (TODO: actualmente `status=inactive` NO bloquea login; ver nota abajo)
- [ ] Subir PNG pequeño como logo de VexPro → verificar que aparece en sidebar + login + lista superadmin
- [ ] Intentar subir `.exe` renombrado a `.png` → debería rechazar ("no es imagen válida")
- [ ] Subir archivo de 5MB → debería rechazar (2MB limit)
- [ ] Quitar logo → fallback a iniciales

### ⚠️ Gap conocido — status='inactive' no bloquea el login

Actualmente login-gate solo consulta `twofa_enabled`, `failed_login_count`, `locked_until`, `must_change_password`. **No consulta `status`.** Por lo tanto un usuario marcado como inactivo todavía puede loguear.

**Fix trivial** — agregar a `login-gate/route.ts` (después de verificar password, antes de retornar success):

```ts
if (companyUser?.status === 'inactive') {
  return NextResponse.json(
    { success: false, error: 'Tu cuenta está desactivada. Contacta al administrador.' },
    { status: 403 },
  );
}
```

No lo incluí en este commit porque quería confirmar que ese es el comportamiento deseado (vs. bloquear sólo la UI). **Proponlo a Kevin y si confirma, es PR de 3 líneas.**

---

## 8. Build + typecheck

- `npx tsc --noEmit` ✅ clean
- `npm run build` ✅ clean (38 rutas)
- Smoke tests locales (localhost:3100): `/superadmin/companies/x/users` → 307, API routes → 401 sin auth ✅

---

## 9. Cómo bajar y probar

```bash
git fetch origin
git checkout feature/superadmin-users-logo
npm install
# migration ya está aplicada en prod Supabase, pero si tienes DB local:
node scripts/db-admin/run-sql-file.mjs supabase/migration-025-company-users-status.sql
npm run dev
# Login con superadmin → /superadmin → entrar a VexPro FX → tab Usuarios
```

---

## 10. Pendientes para después del merge

- Fix del gap `status='inactive'` bloqueando login (ver punto 7)
- Considerar agregar `target_user_id` al schema de `audit_logs` si quieren separación clara actor/target
- El `/configuraciones/usuarios` (panel por-empresa para admins) podría adoptar el mismo slide-over UX — hoy usa modal-style. No bloquea nada, puramente consistency.

---

**Cualquier duda, los commits tienen messages claros:** `git log 41aa2a9..feature/superadmin-users-logo --oneline`.
