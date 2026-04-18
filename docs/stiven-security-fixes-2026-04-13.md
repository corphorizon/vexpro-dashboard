# Correcciones de Seguridad — Financial Dashboard

**Fecha:** 13 de abril de 2026
**Autor:** Kevin (revisado con IA)
**Destinatario:** Stiven
**Commit:** `139529c` en `main`
**Referencia:** `docs/audit-report-2026-04-13.md`

---

## Resumen

Se realizó una auditoría completa de seguridad del dashboard. Se encontraron **8 hallazgos críticos** y **8 advertencias**, todos corregidos en un solo commit. Este documento detalla qué se encontró, qué se cambió, y qué archivos fueron afectados para que puedas revisarlo.

---

## Hallazgos Críticos (Corregidos)

### 1. 2FA verificado solo en el cliente
**Problema:** El PIN de 2FA se verificaba en el navegador comparando contra `twofa_secret` que venía en la respuesta del servidor. Cualquier usuario podía ver el secreto en DevTools.

**Corrección:**
- Nuevos endpoints server-side: `/api/auth/verify-2fa` y `/api/auth/verify-pin`
- `twofa_secret` eliminado de la interfaz `User` y de todas las queries al cliente
- Nuevo tipo `UserUpdate` para escrituras a BD que necesiten el campo
- Rate limiting: máximo 3 intentos, bloqueo de 15 minutos

**Archivos:**
- `src/app/api/auth/verify-2fa/route.ts` (NUEVO)
- `src/app/api/auth/verify-pin/route.ts` (NUEVO)
- `src/lib/auth-context.tsx` (modificado — `loginWith2fa`, `fetchUserProfile`, `fetchAllUsers`)
- `src/app/login/page.tsx` (modificado — `handle2faSubmit` ahora async)
- `src/app/(dashboard)/perfil/page.tsx` (modificado — desactivación de 2FA server-side)

---

### 2. Endpoints de email sin autenticación
**Problema:** `/api/send-email`, `/api/send-email/test` y `/api/auth/login-notification` eran accesibles públicamente sin ningún tipo de autenticación.

**Corrección:** Se agregó `verifyAdminAuth()` a send-email y send-email/test. Se reescribió login-notification para requerir sesión activa de Supabase.

**Archivos:**
- `src/app/api/send-email/route.ts`
- `src/app/api/send-email/test/route.ts`
- `src/app/api/auth/login-notification/route.ts`

---

### 3. Acceso cross-tenant en rutas admin
**Problema:** Un admin de la empresa A podía eliminar usuarios, resetear contraseñas, o modificar datos de la empresa B. Las queries no filtraban por `company_id`.

**Corrección:**
- `delete-user`: agregado `.eq('company_id', auth.companyId)` en lookup y delete
- `reset-password`: reescrito para buscar usuario por email + company_id en `company_users`, eliminando la paginación insegura
- `update-auth-user`: agregada verificación de que el `authUserId` pertenece a la empresa del caller

**Archivos:**
- `src/app/api/admin/delete-user/route.ts`
- `src/app/api/admin/reset-password/route.ts`
- `src/app/api/admin/update-auth-user/route.ts`

---

### 4. Middleware de autenticación desactivado
**Problema:** El middleware de Supabase tenía la lógica de redirección comentada. Las rutas del dashboard dependían solo del hook `useAuth()` en el cliente, lo cual se puede saltar.

**Corrección:**
- Creado `src/middleware.ts` con matcher para todas las rutas excepto estáticos
- Activada la lógica de redirección en `src/lib/supabase/middleware.ts`
- Rutas públicas definidas: `/login`, `/auth`, `/api`, `/_next`, `/favicon.ico`

**Archivos:**
- `src/middleware.ts` (NUEVO)
- `src/lib/supabase/middleware.ts`

---

### 5. ALLOWED_FIELDS incompleto en commercial-profiles
**Problema:** El whitelist de campos permitidos para actualizar perfiles comerciales no incluía campos legítimos como `email`, `hire_date`, `birthday`, `contract_url`, `fixed_salary`, etc. Intentar actualizar esos campos fallaba silenciosamente.

**Corrección:** Lista expandida a 16 campos. Se eliminó `phone` que no existe en el schema.

**Archivo:** `src/app/api/admin/commercial-profiles/route.ts`

---

### 6. Cascade delete sin scope de empresa
**Problema:** Al eliminar un perfil comercial, se borraban los `commercial_monthly_results` de TODAS las empresas para ese `profile_id`, no solo los de la empresa del admin.

**Corrección:** Agregado `.eq('company_id', company_id)` al delete de monthly_results.

**Archivo:** `src/app/api/admin/commercial-profiles/route.ts`

---

### 7. Endpoint de movimientos sin autenticación
**Problema:** `/api/integrations/movements` permitía insertar movimientos financieros sin autenticación.

**Corrección:** Agregado `verifyAdminAuth()`.

**Archivo:** `src/app/api/integrations/movements/route.ts`

---

## Advertencias (Corregidas)

### 8. changePassword no verificaba contraseña actual
**Problema:** La función aceptaba `currentPassword` como parámetro pero lo ignoraba. Cualquier sesión activa podía cambiar la contraseña sin confirmar la actual.

**Corrección:** Se agregó `signInWithPassword(email, currentPassword)` antes de permitir el update.

**Archivo:** `src/lib/auth-context.tsx`

---

### 9. XSS en templates de email
**Problema:** Variables como `userName`, `title`, `message` se interpolaban directamente en HTML sin escapar.

**Corrección:** Se creó función `escapeHtml()` y se aplica a todos los valores de usuario en los templates.

**Archivo:** `src/services/emailService.ts`

---

### 10. Audit log solo en localStorage
**Problema:** El registro de auditoría se guardaba solo en localStorage del navegador, fácilmente manipulable.

**Corrección:** Se creó `/api/admin/audit-log` que persiste en tabla `audit_logs` de Supabase. `logAction()` ahora escribe en ambos (localStorage + BD, fire-and-forget).

**Archivos:**
- `src/app/api/admin/audit-log/route.ts` (NUEVO)
- `src/lib/audit-log.ts`

---

### 11. Company slug hardcodeado
**Problema:** `DataProvider` siempre cargaba `fetchCompany('vexprofx')` independientemente de qué empresa tuviera el usuario autenticado. En un sistema multi-tenant esto es un bug grave.

**Corrección:** Ahora lee `authUser.company_id` del contexto de autenticación y usa `fetchCompanyById()`. Mantiene fallback a `'vexprofx'` solo si no hay usuario autenticado.

**Archivos:**
- `src/lib/data-context.tsx`
- `src/lib/supabase/queries.ts` (nueva función `fetchCompanyById`)

---

### 12. INSERT policies sin WITH CHECK
**Problema:** Las políticas RLS de INSERT en 14 tablas no tenían cláusula `WITH CHECK`, permitiendo a cualquier usuario autenticado insertar filas con el `company_id` de otra empresa.

**Corrección:** Migración que recrea las 14 políticas con `WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid()))`.

**Archivo:** `supabase/migration-013-fix-insert-policies.sql` (NUEVO, ya aplicado en BD)

---

### 13. Otros ajustes menores
- `src/app/(dashboard)/usuarios/page.tsx` — Eliminado `twofa_secret: null` en createUser (campo no existe en la interfaz)
- `src/lib/types.ts` — `UserRole` ahora se re-exporta desde `auth-context.tsx` para evitar duplicación
- `src/lib/pdf-export.ts` — Consolidado `formatNumber` desde utils en vez de función duplicada
- `supabase/migration-006-commissions.sql` — Corregido comentario "Migration 002" → "Migration 006"

---

## Archivos nuevos (6)

| Archivo | Propósito |
|---------|-----------|
| `src/middleware.ts` | Middleware de Next.js para proteger rutas del dashboard |
| `src/app/api/auth/verify-2fa/route.ts` | Verificación server-side de 2FA durante login |
| `src/app/api/auth/verify-pin/route.ts` | Verificación server-side de PIN para desactivar 2FA |
| `src/app/api/admin/audit-log/route.ts` | Persistencia de audit log en Supabase |
| `supabase/migration-013-fix-insert-policies.sql` | Corrección de políticas INSERT con WITH CHECK |
| `docs/audit-report-2026-04-13.md` | Reporte completo de auditoría (44 hallazgos) |

## Archivos modificados (20)

| Archivo | Cambio principal |
|---------|-----------------|
| `src/lib/auth-context.tsx` | 2FA server-side, UserUpdate type, changePassword verification, fetchAllUsers sin select(*) |
| `src/app/login/page.tsx` | handle2faSubmit async con server verification |
| `src/app/(dashboard)/perfil/page.tsx` | Desactivación 2FA via /api/auth/verify-pin |
| `src/app/(dashboard)/usuarios/page.tsx` | Eliminado twofa_secret de createUser |
| `src/app/api/admin/delete-user/route.ts` | Scope por company_id |
| `src/app/api/admin/reset-password/route.ts` | Reescrito: lookup por company_users en vez de paginación |
| `src/app/api/admin/update-auth-user/route.ts` | Verificación de pertenencia a empresa |
| `src/app/api/admin/commercial-profiles/route.ts` | ALLOWED_FIELDS expandido + cascade delete con scope |
| `src/app/api/send-email/route.ts` | verifyAdminAuth() agregado |
| `src/app/api/send-email/test/route.ts` | verifyAdminAuth() agregado |
| `src/app/api/auth/login-notification/route.ts` | Reescrito con sesión requerida |
| `src/app/api/integrations/movements/route.ts` | verifyAdminAuth() agregado |
| `src/lib/audit-log.ts` | Persistencia dual (localStorage + BD) |
| `src/lib/data-context.tsx` | Multi-tenant: company_id dinámico |
| `src/lib/supabase/middleware.ts` | Lógica de redirect activada |
| `src/lib/supabase/queries.ts` | fetchCompanyById() nueva |
| `src/lib/types.ts` | Re-export UserRole |
| `src/lib/pdf-export.ts` | formatNumber consolidado |
| `src/services/emailService.ts` | HTML escaping para XSS |
| `supabase/migration-006-commissions.sql` | Comentario corregido |

---

## Pendientes para futuro

Estos items fueron identificados en la auditoría pero no son bloqueantes. Se recomienda abordarlos en sprints futuros:

1. **Rate limiting global** — Implementar `@upstash/ratelimit` para login, reset-password, y endpoints de email
2. **Complejidad de contraseña** — Validar mínimo 8 caracteres + complejidad
3. **Logging estructurado** — Reemplazar `console.log/error` con logger que redacte PII
4. **CORS explícito** — Configurar headers en `next.config.ts`
5. **Validación SSL en scripts** — Eliminar `rejectUnauthorized: false` en scripts de BD

---

## Verificación realizada

| Test | Resultado |
|------|-----------|
| `next build` | ✅ Sin errores |
| `tsc --noEmit` | ✅ 0 errores |
| `eslint src/` | ✅ 0 issues nuevos |
| 8 rutas API sin auth → 401 | ✅ Todas protegidas |
| 3 rutas dashboard sin sesión → redirect /login | ✅ 307 redirect |
| `twofa_secret` en respuestas de API | ✅ No expuesto |

---

*Documento generado el 13 de abril de 2026. Referencia completa: `docs/audit-report-2026-04-13.md`*
