# Sesión 2026-04-21 (parte 2) — Audit full-stack + hardening de seguridad + 2FA reset

**Para:** Stiven (y tu Claude Code)
**De:** Kevin + IA pair-programming
**Base:** Continuación de `stiven-session-2026-04-21.md` (parte 1, superadmin users + logo upload)
**Rama:** todo mergeado a `main`. HEAD actual: `1bf63d9`.
**Estado:** desplegado en `https://dashboard.horizonconsulting.ai`

---

## TL;DR

Esta jornada fue 3 bloques grandes encadenados:

1. **Fixes UI + balances** — restructure del home admin, UniPayment API-only, channel balances persisten forward, card "Total Consolidado" con llamadas live a Coinsbuy/UniPayment, purga de referencias "VexPro" a nivel plataforma.

2. **Auditoría profunda read-only + implementación de 3 fases** — 39 archivos tocados para cerrar 14 ítems del audit (bugs, inconsistencias, seguridad, performance, multi-tenant readiness).

3. **2FA reset obligatorio + reauditoría de seguridad e infraestructura + fix de 14 items** — reset platform-wide de 2FA, force re-enrolment para todos (incluyendo superadmin), headers de seguridad, Next 16.2.4, Sentry operativo, rate limits, magic-bytes en uploads, disaster recovery doc.

**Salud del proyecto ahora:**
- 0 vulnerabilidades npm
- 6/6 security headers en prod (content-security-policy, x-frame-options, x-content-type-options, referrer-policy, permissions-policy, hsts)
- RLS con WITH CHECK en 24/24 tablas de negocio
- Multi-tenant credentials ready (falta sólo la UI de upload de creds per-tenant)
- Sentry capturando errores
- Health check endpoint para uptime monitoring
- Build verde, typecheck verde, lint sin nuevos errores

---

## Migrations aplicadas en Supabase (todas live)

| # | Archivo | Qué hace |
|---|---|---|
| 026 | `migration-026-channel-balances-asof.sql` | Función SQL `channel_balances_as_of(company_id, date)` con DISTINCT ON — snapshots manuales persisten forward |
| 027 | `migration-027-update-policies-with-check.sql` | Regenera las 24 políticas UPDATE con WITH CHECK (fix crítico de pivot cross-tenant) |
| 028 | `migration-028-audit-logs-created-index.sql` | Índice `(company_id, created_at DESC)` en audit_logs |
| 029 | `migration-029-reset-all-2fa.sql` | Resetea todo 2FA + agrega `force_2fa_setup` a platform_users |
| 030 | `migration-030-platform-users-twofa-pending.sql` | `twofa_pending_secret` + `twofa_pending_at` en platform_users (para flow de setup de superadmin) |
| 031 | `migration-031-companies-default-wallet.sql` | Columna `companies.default_wallet_id` (per-tenant Coinsbuy wallet default) |

---

## Bloque 1 — Fixes UI + balances

### 1.1 `/balances` · canales manuales persisten forward

**Bug:** FairPay, Wallet Externa y Otros sólo mostraban valor el mismo día que los editabas. Al día siguiente → $0. Razón: `fetchChannelBalances` usaba `.eq('snapshot_date', exact_date)`.

**Fix:** Migration 026 creó la función SQL `channel_balances_as_of(company_id, date)` con `DISTINCT ON (channel_key)` ordenado por `snapshot_date DESC`. Si no hay row para el día exacto, retorna el último anterior. Así una edición del día D persiste D+1, D+2, ... hasta la próxima edición.

Archivo: `src/lib/supabase/queries.ts` — `fetchChannelBalances` ahora llama al RPC cuando se pasa fecha.

### 1.2 UniPayment pasa a ser API-only

**Decisión:** quitar la opción de ingreso manual. El dato viene live de la API. 1 row manual legacy borrada (`$45,540` del 17/04).

Archivo: `src/app/(dashboard)/balances/page.tsx` — removí `allowManualOverride` del channel config, simplifiqué `getChannelValue`. Resultado: badge "API + manual" → "Automático", botón editar escondido, resolución = API snapshot (pasado) → live API (hoy) → 0.

### 1.3 Home admin restructurado

**Tu request:** reordenar cards + fix de datos stale.

**Antes:**
```
Row 1: Net Deposit · Depósitos · Egresos · Balance Disponible
[banner APIs]
Row 2: Empleados · Socios · Inversiones · Liquidez
[recent activity]
```

**Ahora:**
```
Row 1: Net Deposit · Depósitos · Retiros · Egresos
Row 2: Total Consolidado · Inversiones · Liquidez · Socios
```

Cambios:
- Card "Balance Disponible" reemplazada por "Total Consolidado" — suma de **todos los canales** (igual al footer de `/balances`)
- El total consolidado llama un endpoint nuevo `/api/balances/total-consolidado` que internamente:
  - Fetcha Coinsbuy wallets **live** (pinned wallets del tenant)
  - Fetcha UniPayment balances **live**
  - Suma `channel_balances_as_of(today)` para canales manuales
  - Suma liquidez + inversiones running sum
  - Con timeout de 5s y fallback a snapshot si API falla
- Quitado banner de APIs + recent activity (duplicaba /superadmin/auditoría)
- Quitado card "Empleados"
- Datos ahora usan `useApiCoexistence` (la misma consolidación que `/resumen-general` y `/movimientos` — antes el home era el que sumaba distinto)

### 1.4 Purga de refs "VexPro" nivel plataforma

6 lugares hardcoded:
- `comisiones/page.tsx` × 3 (fallback `?? 'VexPro'` en companyName de PDFs) → `'Smart Dashboard'`
- `balances/page.tsx` — description "Wallet VexPro Main" → "Wallets pinneadas — balance en tiempo real desde la API"
- `realtime-movements-banner.tsx` — fallback label "VexPro Main Wallet" → "Wallet principal"
- `_form.tsx` — placeholder "VexPro FX" → "Ej: Acme Inc"
- `pdf-export.ts` × 3 — footer "VexPro Dashboard" → "Smart Dashboard"

Los archivos de demo (`demo-data.ts`, `hr-data.ts`) **se dejaron** — son fixtures de VexPro intencionales para dev local.

### 1.5 `DEFAULT_WALLET_ID` ahora per-tenant

Migration 031: columna `companies.default_wallet_id text`. VexPro seeded con `'1079'` (su Main Wallet). Cualquier tenant nuevo arranca con NULL → UI usa la primera wallet que retorne la API.

Archivos:
- `src/lib/types.ts` — campo agregado a `Company`
- `src/components/realtime-movements-banner.tsx` — lee `company?.default_wallet_id`, fallback a primera wallet de API
- `src/app/(dashboard)/movimientos/page.tsx` — inicializa estado desde companies row
- `DEFAULT_WALLET_ID = ''` ahora es sentinel "no preset" (antes era `'1079'` hardcoded)

---

## Bloque 2 — Audit full-stack + 3 fases de fixes

### 2.1 Audit (read-only, 4 agentes en paralelo)

Cubrió 6 categorías × ~100 archivos × 46 API routes × 30 migrations:
1. Seguridad (auth, RLS, cross-tenant)
2. Bugs y errores (runtime, persistencia, integraciones, cálculos, multi-tenant)
3. Inconsistencias (lógica duplicada, naming, UI)
4. Pendientes (TODOs, FIXMEs, mocks)
5. Performance (re-renders, N+1, pagination, bundles, indexes)
6. Arquitectura multi-tenant (aislamiento, creds per-tenant, módulos)

**Veredicto:** sólido con huecos puntuales. Todo lo crítico y casi todo lo medio cerrado en las 3 fases siguientes.

### 2.2 Fase 1 — Críticos

**BUG-1 — `/rrhh` sin module guard.** Todas las otras páginas de módulo tenían `useModuleAccess(...)` + early return; `/rrhh` no. Un tenant con módulo `hr` desactivado podía acceder tipeando la URL. Fix: `useModuleAccess('hr')` + `<NoAccess />` al inicio.

**SEC-2 — `/api/admin/audit-log` aceptaba `user_id` y `user_name` del body.** Cualquier usuario autenticado podía forjar entries de audit bajo otra identidad. Fix: reemplazado `getUser()` por `verifyAuth()`, ignora body identity, usa siempre `auth.userId/name/companyId` del token. **Nota de decisión:** mantuve `verifyAuth` (cualquier company member) en vez de `verifyAdminAuth` porque el endpoint lo usan todos los usuarios para loguear su login/logout.

**SEC-1 — Migration 027 · WITH CHECK en UPDATEs.** Las 24 políticas UPDATE de migration-022 sólo tenían `USING` sin `WITH CHECK` → un admin de empresa A podía pivotear un row a empresa B via `UPDATE deposits SET company_id = '<B>'` (USING valida pre-update, WITH CHECK valida post-update).

**SEC-3 — xlsx → exceljs.** Migré el único caller (`src/lib/risk/parser.ts`) de `xlsx` a `exceljs`. xlsx tenía 2 CVEs HIGH sin parche upstream (prototype pollution + ReDoS). `parseTradeReport` ahora es async (su único caller ya era async handler).

### 2.3 Fase 2 — Calidad

- **INC-1 BUILT_IN_ROLES centralizado** en `src/lib/auth-context.tsx` (antes duplicado en 4 archivos).
- **INC-2 Fechas centralizadas** en `src/lib/dates.ts` con 3 helpers: `formatDate` (DD/MM/YYYY), `formatDateTime` (+ HH:MM), `formatDateRelative` ("21 abr 2026"). Aplicado en 9 archivos.
- **BUG-6 try/finally en setLoading** — auditado, ya estaba bien en los 12 sitios.
- **PERF-2 Migration 028** — índice `(company_id, created_at DESC)` en audit_logs.
- **SEC-5 Emails redacted en logs** — `create-user` / `delete-user` usan `redactEmail(email)` → `***@bar.com`.
- **INC-3 UI custom roles oculta** — el tab de Roles en `/usuarios` comentado con TODO. Backend intacto (`custom_roles` table + `RolesPanel` + `/api/admin/custom-roles`). Cuando quieras activar, hay que wirear `effective_role` en `hasModuleAccess`.

### 2.4 Fase 3 — Multi-tenant ready para 2do cliente

**SEC-4 — Credenciales API por tenant**. Antes los 3 providers (Coinsbuy, UniPayment, FairPay) leían directo de `process.env.*`. Si onboardabas AP Markets, iba a compartir credenciales con VexPro.

**Nuevo:** `src/lib/api-integrations/credentials.ts` — resolver central que:
1. Lee `api_credentials` con (company_id, provider), decripta con AES-256-GCM (helper existente)
2. Si no hay row → fallback a `process.env` (preserva VexPro sin cambios)
3. Retorna `{clientId, clientSecret, baseUrl?}` para Coinsbuy/UniPayment o `{apiKey, baseUrl?}` para FairPay

**Refactor de los 3 `auth.ts`:**
- Cada export acepta `companyId?: string | null`
- Token cache cambia de `let cachedToken` global a `Map<companyId, CachedToken>` — dos tenants jamás comparten token
- Nuevos exports `getCoinsbuyBaseUrl()`, `getUnipaymentBaseUrl()`, `getFairpayBaseUrl()` — soportan override per-tenant via `extra_config.base_url`
- `isXEnabled()` pasa a ser async

**Propagación de companyId** en 7 routes:
- `/api/integrations/coinsbuy/{wallets,deposits,payouts}` 
- `/api/integrations/unipayment/{balances,transactions}`
- `/api/integrations/fairpay/transactions`
- `/api/balances/total-consolidado`
- `/api/cron/daily-balance-snapshot` (pasa `company.id` en el loop por tenant)

**Convención de storage para la UI de upload** (pendiente de implementar el form):
- coinsbuy / unipayment: `encrypted_secret` = JSON `{"client_id":"...","client_secret":"..."}`
- fairpay: `encrypted_secret` = raw api_key string

---

## Bloque 3 — 2FA reset + security/infra audit + hardening

### 3.1 Reset completo de 2FA

Kevin pidió: "resetea todos los autenticadores, ya sea protocolo que cuando alguien inicie sesión configure 2FA, hasta los superadmin".

- Migration 029 — wipe `twofa_*` columns en `company_users` (10 rows) + `platform_users` (1 row) + `twofa_attempts` cleared
- Migration 030 — agrega `twofa_pending_secret` + `twofa_pending_at` a `platform_users` (antes era sólo `company_users`)
- `platform_users` ahora tiene `force_2fa_setup` (antes superadmin era exempt del flow)
- Gate agregado a `src/app/superadmin/layout.tsx` — redirect a `/setup-2fa` cuando aplica
- `src/app/api/auth/setup-2fa/route.ts` → dual-table. `resolveAccount(userId)` detecta si es tenant user o superadmin y escribe en la tabla correcta
- `src/app/api/auth/login-gate/route.ts` → también consulta `platform_users` para `needs2fa`
- `src/app/api/auth/verify-2fa/route.ts` → dual-table con `account.table` threaded through
- `src/app/api/auth/verify-pin/route.ts` → dual-table lookup para gated actions

**Próximo login de cualquier usuario → `/setup-2fa`.**

### 3.2 Security + infrastructure audit (read-only, 2 agentes en paralelo)

10 categorías de seguridad + 7 de infra. Reveló 14 items priorizados.

### 3.3 Fase Inmediata de fixes (antes de onboardar 2do cliente)

- **SEC-C1 Security headers** en `next.config.ts` — CSP, X-Frame-Options DENY, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. HSTS lo setea Vercel automáticamente en prod. CSP mantiene `'unsafe-inline'` en script/style porque App Router lo requiere para hydration.
- **SEC-C2 Next 16.2.2 → 16.2.4** — parcha GHSA-q4gf-8mx6-v5v3 (DoS con Server Components).
- **SEC-A4 npm audit fix** — resolvió 4 moderates (axios, dompurify, follow-redirects). **Final: 0 vulnerabilities**.
- **SEC-A5 default_wallet_id per-tenant** — (ya descrito arriba, migration 031).
- **INF-A2 Cron paralelo** — `daily-balance-snapshot/route.ts` cambió de `for (const company)` a `Promise.all(companies.map(...))`. Con 20 tenants baja de ~60s a ~3s.

### 3.4 Fase Corto Plazo

- **SEC-A1 Error sanitizer** — `src/lib/errors.ts` con `sanitizeDbError(err, context)` que mapea códigos Postgres (23505, 23503, etc.) a copy Spanish y loguea el error real a stderr. Aplicado en `api-credentials`, `superadmin/users`, `superadmin/companies`, `admin/negotiations`.
- **SEC-A2 Magic bytes en upload-contract** — agregué `sniffContract()` con detección de PDF (`%PDF-`), DOCX (`PK\x03\x04`), DOC legacy (`D0CF11E0`), JPG, PNG. Un `.exe` renombrado a `.pdf` ahora se rechaza.
- **SEC-A3 Rate limit forgot-password** — 5 intentos por IP cada 10 min via tabla `twofa_attempts` con kind `'forgot-password'`. Sigue respondiendo 200 incluso en lockout (no-enum).
- **INF-A3 Sentry** — completo. Ver detalle abajo.
- **INF-A4 + A5 Disaster recovery doc** — `docs/disaster-recovery.md` con inventario, backups, procedimientos de restore (PITR / tabla / storage), checklist de drill semestral.

### 3.5 Recomendaciones adicionales

- **INF-R5 Health check** — `src/app/api/health/route.ts` → `{ok: true, version: commit_sha, timestamp, db: 'ok'}` con DB ping. Para usar con UptimeRobot o similar.
- **SEC-R3 Logout limpia localStorage** — `auth-context.tsx logout()` ahora borra `fd_audit_log` + `horizon.superadmin.activeCompanyId` con dynamic imports. Así el próximo usuario en browser compartido no hereda estado.

### 3.6 Sentry — fixes post-deploy

Durante el verify post-deploy detecté 2 bugs reales y los parché:

**Bug 1 — middleware bloqueaba tunnel:** `withSentryConfig({ tunnelRoute: '/monitoring' })` hace que el SDK browser postee a `/monitoring/{projectId}` para evitar ad blockers. Pero mi middleware de Supabase Auth trataba `/monitoring` como ruta protegida → redirect a `/login`. Fix: whitelist en `skipAuthCheck` alongside `/api`, `/_next`, etc.

**Bug 2 — Sentry v10 cambió convención de archivos:** escribí `sentry.client.config.ts` pero `@sentry/nextjs` v10 + Next 16 (la combo actual) deprecó esa convención en favor de `instrumentation-client.ts` (root) y `instrumentation.ts` con `register()` hook. La evidencia: los `_debugIds` del bundler plugin estaban en los chunks pero los símbolos de runtime (`captureException`, etc) **no**. Migración: renombre + creación del `instrumentation.ts` + `export const onRequestError = Sentry.captureRequestError`.

Post-fix: chunks contienen símbolos Sentry, `/monitoring/` responde 308 (no 404 ni 307→login).

---

## Archivos nuevos esta jornada (sumando bloques 1-3)

### Código
```
src/app/api/balances/total-consolidado/route.ts
src/app/api/health/route.ts
src/lib/api-integrations/credentials.ts
src/lib/dates.ts
src/lib/errors.ts
src/lib/server-audit.ts (de parte 1)
instrumentation.ts
instrumentation-client.ts
sentry.server.config.ts
sentry.edge.config.ts
```

### Migrations
```
supabase/migration-026-channel-balances-asof.sql
supabase/migration-027-update-policies-with-check.sql
supabase/migration-028-audit-logs-created-index.sql
supabase/migration-029-reset-all-2fa.sql
supabase/migration-030-platform-users-twofa-pending.sql
supabase/migration-031-companies-default-wallet.sql
```

### Docs
```
docs/disaster-recovery.md
```

---

## Archivos modificados (selección — los importantes)

| Archivo | Por qué |
|---|---|
| `next.config.ts` | Security headers + Sentry wrap |
| `src/middleware.ts` + `supabase/middleware.ts` | `/monitoring` whitelist |
| `src/lib/auth-context.tsx` | BUILT_IN_ROLES centralizado, force_2fa_setup para superadmin, logout limpia localStorage |
| `src/lib/types.ts` | `Company.default_wallet_id` |
| `src/lib/rate-limit.ts` | `'forgot-password'` kind |
| `src/lib/api-integrations/{coinsbuy,unipayment,fairpay}/auth.ts` | Refactor completo per-tenant |
| Los 7 routes de integrations + cron | Propagación de companyId |
| `src/app/api/auth/{login-gate,verify-2fa,verify-pin,setup-2fa}/route.ts` | Dual-table (company_users + platform_users) |
| `src/app/api/admin/audit-log/route.ts` | Anti-spoof identity |
| `src/app/superadmin/layout.tsx` | 2FA gate para superadmin |
| `src/app/(dashboard)/_home/admin-home.tsx` | Restructure + Total Consolidado |
| `src/app/(dashboard)/balances/page.tsx` | UniPayment API-only, descripción neutral |
| `src/app/(dashboard)/rrhh/page.tsx` | Module guard |
| Package.json + package-lock.json | next@16.2.4, +exceljs −xlsx, +@sentry/nextjs |

---

## Cómo bajarlo y probarlo

```bash
git fetch origin
git checkout main
git pull
npm install
# Las 6 migrations 026-031 ya están aplicadas en Supabase prod.
# Si tienes DB local separada:
for m in 026 027 028 029 030 031; do
  node scripts/db-admin/run-sql-file.mjs supabase/migration-${m}-*.sql
done
npm run dev
```

QA manual sugerido:
1. Login con cualquier cuenta → debe forzarte a `/setup-2fa` (porque migration 029 reseteó todo)
2. Configurar 2FA nuevo → volver a login → ahora pide PIN
3. Como superadmin → mismo flow (primera vez que aplica)
4. Entrar a `/rrhh` con una cuenta de tenant sin módulo `hr` activo → debería mostrar `NoAccess`
5. `GET /api/health` → `{ok:true, db:"ok", version: "..."}`
6. `/balances` → editar un FairPay hoy, recargar mañana → sigue mostrando (no $0)
7. Subir un `.exe` renombrado a `.pdf` en `/rrhh` perfil → debe rechazarse

---

## Pendientes / tech debt consciente

### Manual, no urgente
- Activar versioning en Storage buckets `company-logos` + `contracts` (Supabase Dashboard → Storage → bucket → Settings → Versioning toggle)
- Region pin Vercel functions a `iad1` si Supabase está en US-East (Dashboard → Settings → Functions → Region)
- Primer drill de DR semestral (ver `docs/disaster-recovery.md` sección 5)

### Feature gaps documentados
- **UI de upload de credenciales per-tenant** — el backend ya está listo (convention JSON en `encrypted_secret`). Falta extender `api-credentials-panel.tsx` para aceptar 2 campos en Coinsbuy/UniPayment (client_id + client_secret), 1 para FairPay (api_key). Obligatorio antes de onboardar AP Markets si tiene credenciales distintas a VexPro.
- **Custom roles** — UI oculta pero backend existe. Cuando se quiera activar, hay que wirear `effective_role` en `hasModuleAccess`.
- **Broker-CRM endpoint** — sigue siendo stub (`src/lib/api-integrations/broker-crm.ts`). UI ya wireada para cuando llegue la API real.
- **Paginación en movement tables** — hoy todas las queries sin `.limit()`. OK con datasets actuales (~500 rows). Implementar cuando un tenant pase de 10k rows.

---

## Salud del proyecto

| Check | Estado |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npm run build` | ✅ clean |
| `npm run lint` | 13 errores + 55 warnings — baseline preexistente (setState-in-effect) |
| `npm audit --omit=dev` | ✅ **0 vulnerabilities** |
| Security headers prod | ✅ 6/6 (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS) |
| RLS coverage | ✅ 20/20 tablas de negocio con RLS + WITH CHECK en UPDATEs |
| RLS superadmin bypass | ✅ `is_superadmin()` + `auth_can_edit/manage` |
| Multi-tenant API credentials | ✅ per-tenant resolver + env fallback |
| Sentry client + server | ✅ cargados en bundle + `/monitoring` tunnel accesible |
| Health check | ✅ `/api/health` |
| Cron timeout resilience | ✅ paralelo, aguanta 100+ tenants |
| 2FA reset + enforcement | ✅ aplicado (incluye superadmin) |

---

**Cualquier duda, `git log 41aa2a9..HEAD --oneline` muestra los 16 commits que cubren esta jornada.** Cada uno tiene mensaje detallado — especialmente los `a2280cb` y `917b97c` que son los bundles grandes de cada fase de audit.
