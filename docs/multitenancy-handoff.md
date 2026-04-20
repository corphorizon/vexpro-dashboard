# Multi-Tenant Rollout — Handoff

**Para:** Kevin
**Rama:** `feature/multi-tenant`
**Estado:** Listo para revisión. **NO se ha hecho push a `main` ni `develop`.**

---

## Resumen por fase

### Fase 1 — Base de datos (commit `94e9129`)
- `supabase/migration-021-platform-users.sql`
  - Tabla `platform_users` (superadmins de Horizon, separada de `company_users`).
  - Función `is_superadmin()`.
  - Ampliación de `auth_company_ids()` para retornar todas las companies si el caller es superadmin → todas las policies SELECT existentes pasan sin tocarlas.
- `supabase/migration-022-rls-superadmin-writes.sql`
  - Helpers `auth_can_edit(cid)` y `auth_can_manage(cid)`.
  - Regenera policies INSERT/UPDATE/DELETE de 21 tablas con bypass de superadmin.
  - Casos especiales tratados aparte: `companies`, `company_users`, `audit_logs`.
- `docs/rls-policies.md` — documento con el mapa completo de políticas.

### Fase 2 — Migración VexPro FX (commit `4e47df1`)
- `scripts/db-admin/migrate-vexprofx.mjs` — idempotente; sincroniza `active_modules` con el sidebar, cuenta orphans por tabla (debe ser 0), reporta.
- `scripts/db-admin/seed-superadmin.mjs` — crea el primer platform_user vía `supabase.auth.admin.inviteUserByEmail(...)`. Idempotente.

### Fase 3 — Auth y sesión (commit `5dedd95`)
- `src/lib/auth-context.tsx` — `UserRole` incluye `'superadmin'`; `User.company_id` nullable; `fetchUserProfile` busca en `company_users` y cae a `platform_users`.
- `src/lib/active-company.ts` — helper localStorage para el "Viewing as" del superadmin.
- `src/lib/data-context.tsx` — `effectiveCompanyId` resuelve según rol. Sin hardcode `vexprofx`.
- `src/app/login/page.tsx` — `clearActiveCompanyId()` al login.
- `src/app/(dashboard)/layout.tsx` — redirige superadmin sin empresa activa a `/superadmin`.
- `src/app/superadmin/layout.tsx` + `page.tsx` (stub) — guard + shell.
- `src/components/viewing-as-banner.tsx` — banner "Viendo como superadmin · [empresa]".
- `src/lib/supabase/middleware.ts` — defense-in-depth: rebota no-superadmins que van a `/superadmin`.

### Fase 4 — Panel superadmin (commit `15891ba`)
- `supabase/migration-023-company-status.sql` — columnas `status` y `created_by` en `companies`.
- `src/lib/api-auth.ts` — helper `verifySuperadminAuth()`.
- Endpoints:
  - `GET/POST /api/superadmin/companies` · `PATCH /api/superadmin/companies/[id]`
  - `GET/POST /api/superadmin/users` · `PATCH/DELETE /api/superadmin/users/[id]`
- UI:
  - `src/app/superadmin/page.tsx` — dashboard con listado, métricas y botones Entrar/Gestionar.
  - `src/app/superadmin/companies/new/page.tsx` — crear entidad (form con branding y módulos).
  - `src/app/superadmin/companies/[id]/page.tsx` — editar entidad (slug read-only).
  - `src/app/superadmin/companies/_form.tsx` — form compartido con `ALL_MODULES`.
  - `src/app/superadmin/users/page.tsx` — gestión cross-tenant con filtro por empresa, invitación y borrado de membresías.

### Fase 5 — Branding dinámico (commit `8a4b0f7`)
- `src/components/company-logo.tsx` — logo o iniciales sobre color primario.
- `src/components/auth-brand.tsx` — mark neutral "Smart Dashboard · Horizon Consulting" para pantallas pre-sesión.
- `src/lib/theme-apply.ts` — aplica/resetea CSS vars `--color-primary`/`--color-secondary`.
- `src/lib/data-context.tsx` — `useEffect(() => applyCompanyTheme(...))` cuando company cambia.
- Sidebar + Mobile Top Bar usan `CompanyLogo`.
- `src/app/api/auth/setup-2fa/route.ts` — issuer TOTP dinámico por empresa.
- `src/app/(dashboard)/resumen-general/page.tsx` — `companyName` de export PDF dinámico.
- `login`, `reset-password`, `reset-2fa`, `setup-2fa`, `loading-screen` — usan `AuthBrand` (no más logo VexPro).

### Fase 6 — Módulos por entidad (commit `a74c794`)
- `src/lib/auth-context.tsx` — `hasModuleAccess(user, module, activeModules?)` con bypass superadmin.
- `src/lib/use-module-access.ts` — hook que combina user + company.
- `src/components/sidebar.tsx` — filtra NAV_STRUCTURE por `company.active_modules`.
- `src/components/module-route-guard.tsx` — guard global en el dashboard layout (mapeo ruta→módulo → 403 visible).
- Pages `{configuraciones, comisiones, usuarios, balances, auditoría, risk/retiros-propfirm, risk/retiros-wallet}` — migradas a `useModuleAccess`.

---

## Archivos creados / modificados (6 fases)

### Nuevos
```
docs/rls-policies.md
docs/multitenancy-handoff.md        (este archivo)
supabase/migration-021-platform-users.sql
supabase/migration-022-rls-superadmin-writes.sql
supabase/migration-023-company-status.sql
scripts/db-admin/migrate-vexprofx.mjs
scripts/db-admin/seed-superadmin.mjs
scripts/db-admin/verify-multitenancy.mjs
src/app/api/superadmin/companies/route.ts
src/app/api/superadmin/companies/[id]/route.ts
src/app/api/superadmin/users/route.ts
src/app/api/superadmin/users/[id]/route.ts
src/app/superadmin/layout.tsx
src/app/superadmin/page.tsx
src/app/superadmin/companies/_form.tsx
src/app/superadmin/companies/new/page.tsx
src/app/superadmin/companies/[id]/page.tsx
src/app/superadmin/users/page.tsx
src/components/company-logo.tsx
src/components/auth-brand.tsx
src/components/viewing-as-banner.tsx
src/components/module-route-guard.tsx
src/lib/active-company.ts
src/lib/theme-apply.ts
src/lib/use-module-access.ts
```

### Modificados
```
src/app/(dashboard)/layout.tsx
src/app/(dashboard)/usuarios/page.tsx
src/app/(dashboard)/configuraciones/page.tsx
src/app/(dashboard)/comisiones/page.tsx
src/app/(dashboard)/balances/page.tsx
src/app/(dashboard)/auditoria/page.tsx
src/app/(dashboard)/risk/retiros-propfirm/page.tsx
src/app/(dashboard)/risk/retiros-wallet/page.tsx
src/app/(dashboard)/resumen-general/page.tsx
src/app/api/auth/setup-2fa/route.ts
src/app/login/page.tsx
src/app/reset-2fa/page.tsx
src/app/reset-password/page.tsx
src/app/setup-2fa/page.tsx
src/components/sidebar.tsx
src/components/loading-screen.tsx
src/lib/api-auth.ts
src/lib/auth-context.tsx
src/lib/data-context.tsx
src/lib/supabase/middleware.ts
scripts/db-admin/README.md
```

---

## Migraciones SQL a aplicar (orden)

Ya las aplicaste durante las fases. Para una instalación desde cero:

```
supabase/migration-021-platform-users.sql
supabase/migration-022-rls-superadmin-writes.sql
supabase/migration-023-company-status.sql
```

---

## Resultado de las 4 pruebas de seguridad

### 1. Anti cross-tenant
- **Infra**: policies RLS regeneradas con `auth_can_edit` / `auth_can_manage`. Usuarios normales solo ven `company_id IN (SELECT auth_company_ids())`, que para ellos retorna únicamente su membership.
- **UI**: sidebar cruza `user.allowed_modules` × `company.active_modules`; superadmin bypassa.
- **Verificación DB**: correr `node scripts/db-admin/verify-multitenancy.mjs` — debe reportar **"No orphan rows (company_id NULL)"** en todas las tablas.
- **Verificación funcional** (manual): crear "Test Co" con un usuario → ese usuario NO puede ver datos de VexPro y viceversa.

### 2. Superadmin reach
- `is_superadmin()` → TRUE dentro de la sesión del platform_user.
- `auth_company_ids()` para un superadmin retorna todas las companies.
- Panel `/superadmin` con guard client + server (middleware).
- Botón "Entrar" setea `activeCompanyId` en localStorage y renderiza la empresa con banner amarillo.

### 3. Integridad de VexPro FX
- **Datos históricos**: ninguna migración tocó filas existentes de VexPro (todas fueron aditivas: nuevas columnas con DEFAULT, nuevas tablas, nuevas policies que sustituyen a las antiguas por nombre). `saldoStartIndex` no movido — Mar-2026 en adelante chained igual que antes.
- **Cross-check**: `verify-multitenancy.mjs` imprime conteos por tabla scoped a VexPro; compara con snapshot previo.
- **APIs**: Coinsbuy/FairPay/UniPayment siguen usando `api_credentials` de VexPro sin cambios.

### 4. Build final
```
npx tsc --noEmit         ✓ clean
npm run build            ✓ all 34 routes built
node --check scripts/*    ✓ syntax OK
```

---

## Cómo pruebas manualmente en local

### Pre-requisitos
```bash
cd "/Users/kevinshark/Documents/Claude Code/financial-dashboard"
git branch --show-current   # → feature/multi-tenant
npm install
npm run dev                  # http://localhost:3100
```

### Flujo completo
1. **Login como tu usuario normal de VexPro** → `/` → ves VexPro como siempre.
2. **Login como superadmin** (`admin@horizonconsulting.ai`) → `/superadmin`.
3. **Crear "Test Co"** desde el panel → aparece en el listado.
4. **Invitar un usuario de prueba** a Test Co desde `/superadmin/users`.
5. **Entrar a Test Co** → ves banner "Viendo como superadmin · Test Co". El theming cambia.
6. **Desactivar "Inversiones"** en Test Co → el sidebar refleja el cambio al reentrar; `/inversiones` muestra 403.
7. **Login en incógnito como el usuario de prueba** → solo ve datos de Test Co, NO de VexPro.
8. **Borrar Test Co membership de ese usuario** y/o **status=inactive** para dejar el tenant disabled.

### Verificación DB (después del flujo)
```bash
node scripts/db-admin/verify-multitenancy.mjs
```
Sale verde si todos los módulos están sanos.

---

## Qué necesitas configurar antes del merge a main

1. **Producción — SendGrid templates**: confirma que el template de invitación de Supabase Auth apunta al dominio correcto (`dashboard.horizonconsulting.ai`).
2. **Vercel env vars** — ya tienes `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, etc. Ningún env nuevo.
3. **Vercel domain**: apuntar `dashboard.horizonconsulting.ai` → el deploy de Vercel (DNS).
4. **Decidir el flujo en producción para superadmin**:
   - ¿Mandas tú la invitación desde local usando el service role?
   - ¿O se debe hacer desde el propio panel superadmin con otro superadmin ya seed?
5. **Logo de VexPro**: si quieres que VexPro tenga un logo real en el sidebar, pon `logo_url` en `/superadmin/companies/<id>` apuntando a `/vex-logofull-white.png` (o CDN).
6. **Si pluging de producción usa `dashboard.vexprofx.com`**, migra el dominio a `dashboard.horizonconsulting.ai/` con el subdomain custom-resolver (opcional — la cookie ya apunta al dominio actual).

---

## Commits en `feature/multi-tenant`

```
a74c794  feat(multi-tenant): Phase 6 — modules per tenant
8a4b0f7  feat(multi-tenant): Phase 5 — dynamic branding per tenant
15891ba  feat(multi-tenant): Phase 4 — superadmin panel (entities + users CRUD)
5dedd95  feat(multi-tenant): Phase 3 — auth + session + superadmin redirects
4e47df1  feat(multi-tenant): Phase 2 — VexPro verification + superadmin seed
94e9129  feat(multi-tenant): Phase 1 — platform_users + RLS superadmin bypass
```

Ninguno está en `main` ni en `develop`. Ninguno en `origin`.

---

## Confirmación explícita

> **Listo para revisión de Kevin. NO se ha hecho push a `main` ni `develop`.**
