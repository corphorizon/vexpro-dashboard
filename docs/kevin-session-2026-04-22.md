# Sesión 2026-04-22 (lado Stiven) — Superadmin viewing-as + credenciales per-tenant correctas + unificación RRHH + sistema de despidos

**Para:** Kevin (y tu Claude Code)
**De:** Stiven + IA pair-programming
**Base:** `main` después de tu commit `5daed54` (2 slots de logo por empresa)
**Estado:** pusheado a `main`, deploy en Vercel. HEAD actual: `d958191`.
**Commits:** 3 — `5850ab3`, `3f69e9b`, `d958191` (`git log 5daed54..d958191 --oneline`)

---

## TL;DR

Tres bloques grandes, todos tenant-scoped y compatibles con el rollout multi-tenant que venías armando:

1. **Habilitar "viewing as" real en endpoints tenant-scoped** — hasta hoy, un superadmin viendo la empresa VexPro desde `/superadmin/viewing/[id]` se comía un `403 "Usuario sin empresa asignada"` en todos los `/api/integrations/*`, `/api/admin/*` y `/api/balances/total-consolidado`. `verifyAuth`/`verifyAdminAuth` ahora aceptan un `NextRequest` y, si el caller está en `platform_users`, resuelven la empresa desde `?company_id=<id>`. El frontend ganó un helper `withActiveCompany(url)` que appendea el id desde localStorage para el superadmin y es no-op para el regular user. Cero cambios en la ruta feliz tenant-user.

2. **Reescritura del panel API Credentials** — el form mostraba campos genéricos (`API key/secret + Merchant ID + Webhook URL`) para los 3 procesadores, pero tu resolver `credentials.ts` espera otra forma:
   - coinsbuy / unipayment → `encrypted_secret = JSON({client_id, client_secret})`
   - fairpay → `encrypted_secret` = raw api_key string
   Lo que se guardara por el panel viejo era ciphertext que el resolver no podía parsear, así que los tres providers caían siempre a env. Ahora el form rinde los inputs correctos por provider y arma el payload en la shape exacta. Coinsbuy además edita `companies.default_wallet_id` (columna que tú agregaste en migration 031) — ese campo está en el whitelist del PATCH de `/api/superadmin/companies/[id]`.

3. **RRHH: unificación Empleados+Comerciales + sistema de despido completo** — el tab Empleados ahora hace merge visual de `employees` + `commercial_profiles` (sin duplicar en BD) con buscador, columna Tipo (admin/comercial) y columnas Fecha contratación / Fecha despido. Un perfil comercial con `status='inactive'` + `termination_date` aparece con badge gris "Despedido", fila opaca y nombre tachado en los 3 módulos donde aparece (rrhh Empleados, rrhh Fuerza Comercial, comisiones Teams/Individual/History). Todavía participa del cálculo de comisiones para poder cargar net deposits negativos post-despido. Nuevo flow: botón `UserX` abre `FireModal` con categoría obligatoria + detalles + fecha; botón `UserCheck` admin-only reincorpora.

Bonus: enterré un bug pre-existente que venía de antes — el `handleSubmit` de `ProfileForm` en `/rrhh` **omitía 5 campos** (`comments`, `benefits`, `commission_per_lot`, `hire_date`, `birthday`) en el payload del UPDATE. El UPDATE se ejecutaba OK (rowsAffected: 1) pero esos campos nunca se tocaban. Unificamos el payload de update con el de create + agregamos un 404 defensivo al endpoint cuando matches=0 rows.

---

## ⚠️ Importante — cambios que pueden afectar tu código

### 1. `verifyAuth(request?)` y `verifyAdminAuth(request?)` aceptan NextRequest

Firma extendida, no breaking. Uso nuevo opcional:

```ts
// src/lib/api-auth.ts
export async function verifyAuth(request?: NextRequest): Promise<AuthInfo | NextResponse>
export async function verifyAdminAuth(request?: NextRequest): Promise<AuthInfo | NextResponse>
```

Si el caller es **platform superadmin** (fila en `platform_users`) y pasás el `request`:
- Lee `company_id` de `request.nextUrl.searchParams`
- Si está presente → retorna `AuthInfo` con `companyId = <query>`, `role = 'admin'`, `isSuperadmin = true`
- Si NO está presente → `400: "Superadmin debe especificar empresa (?company_id=...)"`

Si el caller es regular user, todo sigue igual (company_users + role check como siempre).

**Acción requerida si agregás endpoints tenant-scoped nuevos**: aceptá `request: NextRequest` en el handler y pasá `request` al helper. Si olvidás pasar el request, el superadmin viewing-as se va a comer 403 en ese endpoint específico.

### 2. Helper client-side `withActiveCompany(url)`

Nuevo archivo `src/lib/api-fetch.ts`. Usalo en todo fetch a `/api/integrations/*`, `/api/admin/*`, `/api/balances/*` desde client components:

```ts
import { withActiveCompany } from '@/lib/api-fetch';
const res = await fetch(withActiveCompany('/api/integrations/coinsbuy/wallets'));
```

Para regular users es no-op. Para superadmin (con `activeCompanyId` en localStorage) appendea `?company_id=<id>`.

Ya está aplicado en: `admin-home.tsx`, `balances/page.tsx`, `balances/channel-config-modal.tsx`, `comisiones/page.tsx`, `movimientos/desglose/[slug]`, `rrhh/page.tsx`, `rrhh/perfil/page.tsx`, `usuarios/page.tsx`, `charts/monthly-chart.tsx`, `realtime-movements-banner.tsx`, `settings/roles-panel.tsx`, `audit-log.ts`, `auth-context.tsx` (CRUD), `mutations.ts` (commercial-profiles, employees, commission-entries), `orion-crm/client.ts`, y por supuesto el `api-credentials-panel.tsx`.

### 3. `User.auth_user_id` (breaking-ish)

Agregué un campo nuevo al tipo `User` en `auth-context.tsx`:

```ts
export interface User {
  id: string;             // company_users.id | platform_users.id (PK membership)
  auth_user_id: string;   // NUEVO — auth.users.id (para FKs tipo terminated_by)
  ...
}
```

Los dos `return` de `resolveUser` (path company_users + path platform_users) ya lo setean con `authUser.id`. `fetchCompanyUsers` lo setea con `u.user_id`. La firma de `createUser` cambió a `Omit<User, 'id' | 'auth_user_id'>` (ambos los genera el server al crear).

Si tocás alguna función que construya un `User` desde cero vas a necesitar setear `auth_user_id`.

### 4. `CommercialProfile` con 4 campos nuevos (migrations 036, 037 aplicadas)

```ts
interface CommercialProfile {
  // ... todo lo que había
  termination_date: string | null;
  termination_reason: string | null;
  termination_category: string | null; // 'performance' | 'misconduct' | 'voluntary' | 'restructuring' | 'other' | null
  terminated_by: string | null;        // auth.users.id del que ejecutó — hoy lo dejamos null desde el modal
}
export type TerminationCategory = 'performance' | 'misconduct' | 'voluntary' | 'restructuring' | 'other';
export const TERMINATION_CATEGORIES: TerminationCategory[] = [...];
```

`ALLOWED_FIELDS` de `/api/admin/commercial-profiles/route.ts` incluye los 4.
`CommercialProfileInput` en `mutations.ts` también.

### 5. Helper `appearsInCommissions` en `/comisiones`

Un perfil aparece en el calculador si es `active` **O** (`inactive` + `termination_date` seteado). Inactivos sin termination (licencia/pausa) NO aparecen. Reemplazó 10 filtros `status === 'active'` dispersos por `/comisiones/page.tsx`. La lógica de cálculo (`calculateCommission`, `calculateGroupSummary`, tiers, `getAccumulatedIn`, `applyTotalEarnedDebt`, etc.) **NO se tocó**, solo se ajustó quién entra al pipeline.

### 6. Pequeñas cosas

- `/api/superadmin/companies/[id]` PATCH: `default_wallet_id` ahora está en el whitelist (tu PR de `logo_url_white` también está, no colisionó).
- `/api/admin/commercial-profiles` UPDATE: si matches = 0 filas, retorna **404** con mensaje en vez de `{success:true}` silencioso. Defensa contra el bug que encontramos hoy.
- `components/fire-modal.tsx` y `components/fired-badge.tsx` son nuevos — reutilizalos si armás UIs relacionadas a termination.

---

## Archivos nuevos (5)

```
src/lib/api-fetch.ts
src/components/fire-modal.tsx
src/components/fired-badge.tsx
supabase/migration-036-add-termination-date-to-commercial-profiles.sql
supabase/migration-037-add-termination-metadata.sql
```

## Archivos modificados (notables)

```
src/lib/api-auth.ts                            ← verifyAuth/verifyAdminAuth con request
src/lib/types.ts                                ← CommercialProfile + TerminationCategory
src/lib/auth-context.tsx                        ← User.auth_user_id
src/lib/i18n.tsx                                ← ~40 keys nuevas EN+ES
src/lib/supabase/mutations.ts                   ← CommercialProfileInput + wraps
src/lib/hr-data.ts                              ← mocks extendidos
src/app/(dashboard)/rrhh/page.tsx               ← unified list + FireModal wiring + ProfileForm fix
src/app/(dashboard)/comisiones/page.tsx         ← FiredBadge + appearsInCommissions en 10 sitios
src/components/settings/api-credentials-panel.tsx ← rewrite per-provider
src/app/api/admin/commercial-profiles/route.ts  ← ALLOWED_FIELDS + defensive 404
src/app/api/superadmin/companies/[id]/route.ts  ← +default_wallet_id whitelist
+ 18 endpoints admin/integrations/balances    ← aceptan request y lo pasan a verifyAuth
+ 14 archivos frontend                          ← wraps con withActiveCompany
```

---

## Verificación hecha

- `npx tsc --noEmit` → clean
- `npm run build` → 58/58 páginas, no new errors
- Manual QA contra prod DB (local apunta a `krohysnnppwcetdjhyyz`):
  - Superadmin viewing VexPro → `/movimientos` carga APIs live OK (antes: "Usuario sin empresa asignada")
  - Superadmin → Coinsbuy panel → guardar client_id + client_secret + wallet_id 1079 → se persiste, `/movimientos` selecciona la wallet pre-configurada
  - Despedir un BDM → badge gris aparece en /rrhh Empleados, /rrhh Fuerza Comercial, y /comisiones Teams/Individual/History
  - Cargar net deposit negativo al BDM despedido → guarda OK, no lo filtra del pipeline
  - Reincorporar como admin → vuelve a estado activo en todos los módulos sin F5

---

## Pendientes / deuda técnica que dejo abierta

1. **`terminated_by` se escribe null desde FireModal** — el User del auth-context trae `id = company_users.id`, no `auth.users.id`. Agregué `auth_user_id` al tipo pero el modal no lo usa todavía porque el flow más simple era dejarlo null. Si querés trackear quién despide a quién, basta cambiar el modal a usar `user.auth_user_id`. La FK permite NULL, así que funciona.

2. **Animation/optimistic update al despedir** — el modal cierra inmediato pero la fila del tab Empleados tarda ~500ms en mostrar el badge (lo que tarda `refresh()` del DataProvider). No es bloqueante, pero un optimistic state en DataProvider lo haría instantáneo.

3. **`/rrhh` tab Empleados: botón delete solo en admins** — hoy cualquier rol con acceso al módulo `hr` puede borrar administrativos. Debería gatearlo con `effective_role === 'admin'` (el reinstate ya lo hace). Cosa chica, 2 líneas.

4. **Fix del ProfileForm pre-existente** — el bug que encontré hoy (5 campos omitidos en update) venía desde mucho antes. Si hay datos en producción con comments/benefits/hire_date vacíos sospechosamente, probablemente nunca se persistieron. No hay forma automática de detectar esto; si aparecen reportes raros, acordarse.

5. **Migration paths** — los archivos 036/037 quedaron como `supabase/migration-XXX-*.sql` (convención del repo) en vez de `supabase/migrations/<ts>_*.sql` que podría ser más estándar. Si querés moverlos, es rename simple.

---

## Salud del proyecto

| Check | Estado |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npm run build` | ✅ clean |
| `npm audit --omit=dev` | no corrió en esta sesión (última lectura: 0 vulnerabilities, tu commit `a2280cb`) |
| RLS + multi-tenant | ✅ respetado — todos los endpoints nuevos pasan por `verifyAdminAuth/verifyAuth` con scoping explícito |
| Lógica de comisiones | ✅ sin tocar (solo `appearsInCommissions` que expande el set de profiles visibles, no el cálculo) |
| i18n | ✅ EN + ES cubiertas |

---

**Cualquier duda, `git log 5daed54..d958191` muestra los 3 commits con mensajes detallados.**

— Stiven
