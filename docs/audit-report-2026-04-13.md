# Auditoría Integral — Financial Dashboard
**Fecha:** 2026-04-13  
**Proyecto:** VexPro FX Dashboard (`financial-dashboard`)  
**Alcance:** Seguridad, conflictos/inconsistencias, y plan de pruebas

---

# AUDITORÍA 1 — CIBERSEGURIDAD

## 🔴 CRÍTICO (8 hallazgos)

### SEC-01: 2FA es un PIN estático en texto plano, verificado client-side
**Archivos:**
- `src/lib/auth-context.tsx` líneas 159, 172-178
- `src/app/setup-2fa/page.tsx` línea 50

**Problema:** El sistema "2FA" no es real TOTP. Almacena un PIN de 6 dígitos en texto plano en la columna `twofa_secret` de `company_users`. La verificación ocurre completamente en el cliente (`targetUser.twofa_secret === pin`). Un atacante que bypasee el JS del cliente (llamando directamente a Supabase con credenciales válidas) se salta el 2FA por completo.

**Impacto:** En una app fintech, 2FA debe ser server-side. Esta implementación provee cero protección real.

**Fix sugerido:** Implementar TOTP real (librería `otpauth`), verificación server-side, almacenar el secret encriptado, nunca exponerlo al cliente.

---

### SEC-02: 2FA secret y datos de TODOS los usuarios expuestos a cada usuario autenticado
**Archivos:**
- `src/lib/auth-context.tsx` líneas 60-70, 73-94

**Problema:** `fetchUserProfile` y `fetchAllUsers` hacen `select('*')` sobre `company_users`, devolviendo `twofa_secret` al browser. Todo usuario autenticado recibe el PIN 2FA de todos los demás usuarios de su empresa.

**Impacto:** Cualquier usuario puede ver el PIN 2FA de cualquier otro usuario e impersonarlo.

**Fix sugerido:** Usar `select('id, email, name, role, company_id, allowed_modules, twofa_enabled')` — excluir explícitamente `twofa_secret`.

---

### SEC-03: /api/send-email y /api/auth/login-notification sin autenticación
**Archivos:**
- `src/app/api/send-email/route.ts` línea 97
- `src/app/api/auth/login-notification/route.ts` línea 59

**Problema:** Ambos endpoints son públicamente accesibles. Cualquiera puede enviar emails arbitrarios a través de tu cuenta SendGrid llamando `/api/send-email`. El endpoint de login-notification puede usarse para enviar emails de notificación falsificados.

**Impacto:** Un atacante puede usar tu cuota de SendGrid para phishing o spam desde tu dominio verificado.

**Fix sugerido:** Agregar `verifyAdminAuth()` a `/api/send-email`. Para login-notification, verificar que el caller es el usuario autenticado.

---

### SEC-04: /api/send-email/test expone configuración sin auth
**Archivo:** `src/app/api/send-email/test/route.ts` líneas 20-27

**Problema:** `GET /api/send-email/test` (sin auth) retorna estado de configuración de SendGrid incluyendo `SENDGRID_FROM_EMAIL` y `SENDGRID_FROM_NAME`.

**Fix sugerido:** Agregar autenticación o eliminar este endpoint.

---

### SEC-05: Middleware de auth está comentado — sin protección server-side de rutas
**Archivo:** `src/lib/supabase/middleware.ts` líneas 38-49

**Problema:** La lógica de auth-redirect está completamente comentada. NO hay archivo `src/middleware.ts` activo. La protección de rutas depende enteramente del hook `useAuth()` client-side en el layout del dashboard.

**Impacto:** Un usuario puede acceder a cualquier página del dashboard navegando directamente por URL.

**Fix sugerido:** Crear `src/middleware.ts` activo que importe y ejecute `updateSession`, y descomentar la lógica de auth redirect.

---

### SEC-06: delete-user y reset-password pueden operar entre empresas (cross-tenant)
**Archivos:**
- `src/app/api/admin/delete-user/route.ts` líneas 31-35
- `src/app/api/admin/reset-password/route.ts` líneas 33-43

**Problema:** En `delete-user`, el `companyUserId` del request body se busca con `createAdminClient()` (bypasea RLS) sin filtrar por `auth.companyId`. Un admin de Empresa A podría eliminar un usuario de Empresa B. Lo mismo en `reset-password`: busca entre TODOS los auth users por email sin scope de empresa.

**Impacto:** Manipulación cross-tenant en una app fintech multi-tenant.

**Fix sugerido:** En `delete-user`, agregar `.eq('company_id', auth.companyId)`. En `reset-password`, verificar que el email pertenezca a un usuario de `auth.companyId`.

---

### SEC-07: update-auth-user opera sobre auth user IDs arbitrarios sin scope de empresa
**Archivo:** `src/app/api/admin/update-auth-user/route.ts` líneas 18-19, 83

**Problema:** El `authUserId` viene del request body. La ruta verifica que el caller sea admin pero NO verifica que el target `authUserId` pertenezca a la empresa del caller.

**Impacto:** Un admin podría cambiar email o contraseña de cualquier usuario Supabase de cualquier empresa.

**Fix sugerido:** Antes de actualizar, verificar que existe un registro en `company_users` con `user_id = authUserId AND company_id = auth.companyId`.

---

### SEC-08: delete de commercial_profiles borra monthly_results sin scope de company_id
**Archivo:** `src/app/api/admin/commercial-profiles/route.ts` líneas 60-61

**Problema:** Al eliminar un perfil, la ruta primero borra todos los `commercial_monthly_results` donde `profile_id = id` pero NO filtra por `company_id`. Usa `createAdminClient()` (bypasea RLS).

**Fix sugerido:** Agregar `.eq('company_id', company_id)` a la eliminación de monthly results.

---

## 🟡 ADVERTENCIA (8 hallazgos)

### SEC-09: changePassword no verifica la contraseña actual
**Archivo:** `src/lib/auth-context.tsx` línea 392

**Problema:** La función `changePassword` acepta `_currentPassword` pero lo ignora. Llama `supabase.auth.updateUser({ password: newPassword })` directamente.

**Fix sugerido:** Verificar la contraseña actual server-side antes de permitir el cambio.

---

### SEC-10: XSS en templates de email HTML
**Archivo:** `src/services/emailService.ts` líneas 85, 107, 153, 182

**Problema:** Valores del usuario como `userName`, `title`, `message` se interpolan directamente en HTML sin escapar.

**Fix sugerido:** HTML-encode todos los valores del usuario antes de interpolar.

---

### SEC-11: Sin rate limiting en ningún endpoint
**Archivos:** Todos los archivos en `src/app/api/`

**Problema:** Ninguna ruta API implementa rate limiting. Login, reset-password, send-email — sin throttle.

**Fix sugerido:** Agregar rate limiting con `@upstash/ratelimit` o similar. Priorizar login, reset-password, send-email.

---

### SEC-12: Sin configuración CORS explícita
**Archivo:** `next.config.ts`

**Problema:** No hay configuración CORS explícita. Next.js usa same-origin por defecto, pero sin headers explícitos la postura no está documentada.

---

### SEC-13: Audit log en localStorage — manipulable y per-device
**Archivo:** `src/lib/audit-log.ts` líneas 27-46

**Problema:** El audit trail se almacena en `localStorage` del browser. Cualquier usuario puede limpiar o modificar entradas. Ya existe una tabla `audit_logs` en la DB con RLS, pero la app usa localStorage.

**Fix sugerido:** Escribir entradas de auditoría a la tabla `audit_logs` de Supabase.

---

### SEC-14: Slug de empresa hardcodeado 'vexprofx'
**Archivo:** `src/lib/data-context.tsx` línea 189

**Problema:** `DataProvider` siempre carga `fetchCompany('vexprofx')` independientemente de la empresa del usuario autenticado. Rompe multi-tenancy.

**Fix sugerido:** Resolver la empresa desde `auth.companyId` en vez de slug hardcodeado.

---

### SEC-15: /api/integrations/movements sin autenticación
**Archivo:** `src/app/api/integrations/movements/route.ts` línea 30

**Problema:** Endpoint que expone datos financieros de movimientos (Coinsbuy, Fairpay, Unipayment) sin verificación de auth.

**Fix sugerido:** Agregar `verifyAdminAuth()`.

---

### SEC-16: Políticas INSERT de RLS sin WITH CHECK constraints
**Problema:** Las políticas INSERT en todas las tablas tienen `qual=NULL`. Cualquier usuario autenticado podría insertar filas con cualquier `company_id`.

**Fix sugerido:** Agregar `WITH CHECK (company_id IN (SELECT auth_company_ids()))` a todas las políticas INSERT.

---

## 🔵 RECOMENDACIÓN (5 hallazgos)

### SEC-17: Upload contract confía en Content-Type del cliente
**Archivo:** `src/app/api/admin/upload-contract/route.ts` línea 58

**Sugerencia:** Derivar content type de la extensión validada, no de `file.type`.

### SEC-18: console.log statements con PII en producción
**Archivos:** Múltiples API routes.

**Sugerencia:** Usar structured logger con redacción de emails y user IDs.

### SEC-19: Sin requisitos de complejidad de contraseña
**Archivos:** create-user, reset-password, change-password.

**Sugerencia:** Mínimo 8 caracteres + complejidad.

### SEC-20: SSL con rejectUnauthorized: false en scripts de DB
**Archivo:** `scripts/db-admin/_client.mjs` línea 67.

**Sugerencia:** Usar `rejectUnauthorized: true` con CA cert adecuado.

### SEC-21: Frontend queries usan browser client en vez de server client
**Archivo:** `src/lib/supabase/queries.ts` línea 1.

**Sugerencia:** Considerar Server Components con server-side client para data fetching.

---

# AUDITORÍA 2 — CONFLICTOS E INCONSISTENCIAS

## 🔴 CRÍTICO (4 hallazgos)

### CON-01: `realPayment` se calcula diferente entre comisiones directas y diferenciales
**Archivos:**
- `src/lib/commission-calculator.ts` línea 54: `realPayment = round2(commission)` (permite negativos)
- `src/lib/commission-calculator.ts` línea 195: `realPayment = round2(Math.max(0, commission))` (clamped a 0)

**Problema:** Para BDMs, `realPayment` puede ser negativo (afecta el total del grupo). Para HEAD diferenciales, nunca es negativo. El comentario en línea 34 dice `real_payment = MAX(0, commission)` pero la implementación en línea 54 contradice esto.

**Impacto:** Inconsistencia en cálculos financieros. El grupo total puede ser incorrecto si un BDM tiene comisión negativa.

**Fix sugerido:** Clarificar si negativos son intencionales. Actualizar comentario para coincidir con la implementación.

---

### CON-02: Columna `head_id` escrita por API pero ausente del schema
**Archivos:**
- `src/app/api/admin/commission-entries/route.ts` línea 27: escribe `head_id`
- `supabase/schema.sql` líneas 292-310: tabla `commercial_monthly_results` sin `head_id`
- `src/lib/types.ts` línea 244: `head_id?: string | null` (opcional)

**Problema:** La API escribe `head_id` y lo usa en queries, pero no hay columna en el schema. O fue agregada manualmente a la DB sin migración, o los inserts están fallando silenciosamente. La constraint UNIQUE es `(profile_id, period_id)`, haciendo el filtro `.eq('head_id', ...)` redundante.

**Impacto:** Desync schema-código. Un fresh deployment fallaría.

**Fix sugerido:** Crear migración para agregar `head_id UUID` y actualizar `schema.sql`.

---

### CON-03: `reserve_pct` en DOS tablas con defaults diferentes y company-level nunca leído
**Archivos:**
- `supabase/schema.sql` línea 34: `companies.reserve_pct DEFAULT 0.25` (25%)
- `src/lib/types.ts` línea 20: `Period.reserve_pct: number`
- `src/lib/data-context.tsx` línea 516: hardcoded `reserve_pct: 0.10`
- `src/app/(dashboard)/socios/page.tsx` línea 51: fallback `?? 0.10` (10%)

**Problema:** Company tiene `reserve_pct = 0.25` pero el TypeScript `Company` no incluye este campo. Frontend usa exclusivamente `period.reserve_pct` con fallback de `0.10`. El valor company-level (25%) es código muerto.

**Fix sugerido:** Eliminar `reserve_pct` de `companies` o usarlo como default al crear períodos.

---

### CON-04: ALLOWED_FIELDS en commercial-profiles API descarta campos críticos
**Archivos:**
- `src/app/api/admin/commercial-profiles/route.ts` líneas 10-13
- `src/lib/supabase/mutations.ts` líneas 490-505

**Problema:** El whitelist es:
```
['name', 'role', 'head_id', 'net_deposit_pct', 'extra_pct', 'status', 'email', 'phone']
```
Pero el frontend envía estos campos adicionales que se descartan silenciosamente:
- `pnl_pct`, `commission_per_lot`, `salary`, `fixed_salary`, `benefits`, `comments`, `hire_date`, `birthday`, `contract_url`

Además, `phone` está en el whitelist pero NO existe como columna en la tabla.

**Impacto:** Los campos salary, benefits, hire_date, birthday, etc. nunca se guardan a través de la API.

**Fix sugerido:** Expandir `ALLOWED_FIELDS` con todos los campos legítimos. Eliminar `phone`.

---

## 🟡 ADVERTENCIA (10 hallazgos)

### CON-05: Tipo `UserRole` duplicado
**Archivos:**
- `src/lib/types.ts` línea 264
- `src/lib/auth-context.tsx` línea 8

**Problema:** Definido idénticamente en dos archivos. Si uno se actualiza sin el otro, divergen silenciosamente.

**Fix:** Importar desde una fuente única.

---

### CON-06: `SaldoInfo` y `computeSaldoChain` duplicados
**Archivos:**
- `src/lib/demo-data.ts` líneas 475-530
- `src/lib/data-context.tsx` líneas 64-70, 307-366

**Problema:** Ambos archivos definen la misma interfaz e implementan lógica similar pero NO idéntica.

**Fix:** Extraer a módulo compartido.

---

### CON-07: Hardcoded `'vexprofx'` rompe multi-tenancy
**Archivo:** `src/lib/data-context.tsx` línea 189

(Duplicado con SEC-14 — mismo hallazgo, diferente perspectiva)

---

### CON-08: reset-password no pagina `listUsers()` como sí lo hace create-user
**Archivos:**
- `src/app/api/admin/reset-password/route.ts` línea 33 (sin paginación)
- `src/app/api/admin/create-user/route.ts` líneas 20-30 (pagina 20 páginas)

**Problema:** Si el usuario target está después de la página 1 (~50 users), el reset falla con "No auth user found."

**Fix:** Extraer `findAuthUserByEmail()` como utility compartido.

---

### CON-09: Flow de login 2FA hace signOut() antes de verificar PIN
**Archivo:** `src/lib/auth-context.tsx` líneas 162, 172-182

**Problema:** Después de detectar 2FA, llama `supabase.auth.signOut()`. Luego `loginWith2fa()` busca en `users` state — pero el signOut puede haber vaciado ese state. Además, después de verificar el PIN, NO re-autentica con Supabase, dejando al usuario sin sesión JWT activa.

**Impacto:** Queries RLS-protected retornarán arrays vacíos después del "login" con 2FA.

---

### CON-10: Migración 006 tiene comentario "Migration 002"
**Archivo:** `supabase/migration-006-commissions.sql` línea 1

**Fix:** Actualizar comentario a "Migration 006".

---

### CON-11: Migración 006 crea índice que migración 005 elimina
**Archivos:**
- `supabase/migration-006-commissions.sql` línea 11 (CREATE INDEX)
- `supabase/migration-005.sql` línea 28 (DROP INDEX)

**Problema:** Dependiendo del orden de ejecución, el índice puede existir o no. El UNIQUE constraint ya lo cubre.

---

### CON-12: Tres sistemas de PDF/export con formatting duplicado
**Archivos:**
- `src/lib/pdf-export.ts` (jsPDF)
- `src/lib/export-utils.ts` (HTML print-based)
- `src/lib/csv-export.ts` (CSV)
- `src/lib/utils.ts` línea 8 (`formatCurrency`)

**Problema:** Cada archivo tiene su propia lógica de formateo de moneda. Ninguno usa `formatCurrency()` de utils.ts.

**Fix:** Consolidar usando la función compartida.

---

### CON-13: `periods` table sin columna `reserve_pct` en schema.sql
**Archivos:**
- `supabase/schema.sql` líneas 55-65 (no tiene `reserve_pct`)
- `src/lib/types.ts` línea 20 (requiere `reserve_pct: number`)

**Problema:** TypeScript requiere el campo, mutations escriben a él, pero el schema no lo tiene. Un fresh deployment fallaría.

**Fix:** Agregar `reserve_pct NUMERIC DEFAULT 0.10` al CREATE TABLE de `periods`.

---

### CON-14: `canAdd` permite auditor pero `canEdit`/`canDelete` solo admin
**Archivo:** `src/lib/auth-context.tsx` líneas 449-462

**Problema:** Auditors pueden insertar datos pero no corregir errores. Las políticas RLS SÍ permiten a auditors hacer UPDATE.

**Fix:** Alinear `canEdit` para incluir `auditor`, o remover `auditor` de `canAdd`.

---

## 🔵 RECOMENDACIÓN (6 hallazgos)

### CON-15: `any` type en auth-context fetchAllUsers
**Archivo:** `src/lib/auth-context.tsx` línea 84. Usar tipo explícito.

### CON-16: Naming mixto español/inglés
- Rutas URL en español (`/comisiones`, `/egresos`, `/socios`)
- Funciones en Spanglish (`computeSaldoChain`, `isPeriodAfterSaldoStart`)
- Tablas en inglés (`partner_distributions`)

**Sugerencia:** Estandarizar identificadores en inglés, usar i18n para strings visibles.

### CON-17: Tipo `Negotiation` vs tabla `commercial_negotiations`
Rompe la convención naming de otras entidades (`Deposit`/`deposits`).

### CON-18: schema.sql tiene CHECK constraint de roles que migración 011 eliminó
**Archivo:** `supabase/schema.sql` línea 277. Desactualizado.

### CON-19: `commercial_negotiations` ausente de schema.sql
La tabla solo existe en migrations. Fresh deployment la omite.

### CON-20: Formato de respuesta de API inconsistente
- Algunos: `{ success: true, data }`, otros: `{ error }` sin `success`, negotiations GET retorna array directo.

### CON-21: `formatPercent` multiplica por 100 pero algunos campos ya son enteros
- `reserve_pct = 0.10` (decimal) vs `net_deposit_pct = 7` (entero).
- Latent bug: `formatPercent(7)` = `700.0%`.

### CON-22: Double-fetch de commercialProfiles
**Archivo:** `src/lib/data-context.tsx` líneas 234-235 + `queries.ts` línea 393.

### CON-23: Period selector sin guard de sincronización inicial
**Archivo:** `src/lib/period-context.tsx` líneas 22-25. Riesgo mínimo pero código podría ser más claro.

---

# LISTA DE PRUEBAS MANUALES

## Prioridad 1 — Críticas (ejecutar primero)

### TEST-01: Verificar que rutas admin requieren autenticación
**Módulo:** API Security  
**Pasos:**
1. Abrir terminal
2. Ejecutar: `curl -s http://localhost:3000/api/admin/upload-contract -X POST`
3. Ejecutar: `curl -s http://localhost:3000/api/admin/negotiations`
4. Ejecutar: `curl -s http://localhost:3000/api/admin/commercial-profiles -X POST -H "Content-Type: application/json" -d '{"action":"create"}'`
5. Ejecutar: `curl -s http://localhost:3000/api/admin/create-user -X POST -H "Content-Type: application/json" -d '{}'`
6. Ejecutar: `curl -s http://localhost:3000/api/admin/delete-user -X POST -H "Content-Type: application/json" -d '{}'`
7. Ejecutar: `curl -s http://localhost:3000/api/admin/reset-password -X POST -H "Content-Type: application/json" -d '{}'`

**✅ Esperado:** Todas retornan `{"success":false,"error":"No autenticado"}` con status 401.  
**❌ Problema:** Si alguna retorna datos o un error diferente a 401.

---

### TEST-02: Verificar que run-sql fue eliminado
**Módulo:** API Security  
**Pasos:**
1. Ejecutar: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/admin/run-sql -X POST -H "Content-Type: application/json" -d '{"sql":"SELECT 1"}'`

**✅ Esperado:** Status 404.  
**❌ Problema:** Si retorna 200 o cualquier respuesta JSON.

---

### TEST-03: Verificar que upload-contract rechaza extensiones no permitidas
**Módulo:** File Upload  
**Pasos (requiere sesión admin):**
1. Iniciar sesión como admin en el dashboard
2. Ir a RRHH → abrir un perfil
3. Intentar subir un archivo `.exe` o `.html` como contrato
4. Intentar subir un archivo `.pdf` (válido)

**✅ Esperado:** `.exe`/`.html` rechazado con mensaje "Tipo de archivo no permitido". `.pdf` se sube correctamente.  
**❌ Problema:** Si acepta archivos con extensiones no permitidas.

---

### TEST-04: Verificar RLS en commercial_negotiations
**Módulo:** Database Security  
**Pasos:**
1. Ejecutar en terminal:
```bash
cd financial-dashboard && PATH="$HOME/local/node/bin:$PATH" node -e "
const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env.local','utf8');
const get = k => env.match(new RegExp(k+'=(.+)'))?.[1]?.trim();
const client = new Client({host:get('SUPABASE_DB_HOST'),port:parseInt(get('SUPABASE_DB_PORT')),user:get('SUPABASE_DB_USER'),password:get('SUPABASE_DB_PASSWORD'),database:get('SUPABASE_DB_NAME'),ssl:{rejectUnauthorized:false}});
(async()=>{await client.connect();
const r=await client.query(\"SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename LIKE 'commercial_%' ORDER BY tablename, cmd\");
console.log(JSON.stringify(r.rows,null,2));
await client.end();})();
"
```

**✅ Esperado:** `commercial_negotiations` tiene 4 policies (SELECT, INSERT, UPDATE, DELETE). `commercial_profiles` y `commercial_monthly_results` también tienen policies.  
**❌ Problema:** Si alguna tabla tiene 0 policies.

---

### TEST-05: Verificar endpoints sin auth (VULNERABLES)
**Módulo:** API Security  
**Pasos:**
1. Ejecutar: `curl -s http://localhost:3000/api/send-email -X POST -H "Content-Type: application/json" -d '{"to":"test@test.com","subject":"test","html":"<p>test</p>"}'`
2. Ejecutar: `curl -s http://localhost:3000/api/integrations/movements`

**✅ Esperado (actual — VULNERABLES):** Probablemente retornan datos o intentan enviar email.  
**📝 Nota:** Este test documenta la vulnerabilidad SEC-03 y SEC-15. Después de aplicar fixes, deben retornar 401.

---

## Prioridad 2 — Funcionalidad Core

### TEST-06: Login y navegación del dashboard
**Módulo:** Auth  
**Pasos:**
1. Ir a `http://localhost:3000/login`
2. Ingresar credenciales válidas
3. Verificar que redirige al dashboard principal
4. Navegar por cada módulo: Resumen, Movimientos, Egresos, Comisiones, RRHH, Socios, Liquidez, Inversiones, Periodos

**✅ Esperado:** Todas las páginas cargan sin errores en consola. Los datos de VexPro se muestran.  
**❌ Problema:** Página en blanco, error 500, o datos vacíos.

---

### TEST-07: Selector de período
**Módulo:** Period Context  
**Pasos:**
1. Desde el dashboard, cambiar el período seleccionado en el dropdown
2. Verificar que los datos de CADA módulo se actualizan al período seleccionado
3. Verificar montos en Resumen, Movimientos, Egresos

**✅ Esperado:** Los datos cambian consistentemente al cambiar período.  
**❌ Problema:** Datos que no cambian, montos incorrectos, o período que se resetea.

---

### TEST-08: Módulo Comisiones — Cálculos
**Módulo:** Commission Calculator  
**Pasos:**
1. Ir a Comisiones
2. Seleccionar un HEAD
3. Verificar que el ND total del equipo, comisión propia y diferenciales se calculan
4. Guardar los resultados
5. Cambiar de período y volver — verificar que los datos guardados persisten
6. Generar PDF y verificar que los montos coinciden

**✅ Esperado:** Cálculos correctos, guardado exitoso, PDF legible con datos correctos.  
**❌ Problema:** Montos de comisión incorrectos, error al guardar, PDF corrupto.

---

### TEST-09: Módulo RRHH — Perfiles comerciales
**Módulo:** Commercial Profiles  
**Pasos:**
1. Ir a RRHH
2. Crear un nuevo perfil (nombre, rol, porcentajes)
3. Editar el perfil — cambiar nombre y rol
4. Verificar que el perfil se actualiza
5. Intentar cambiar salary, benefits, hire_date (estos campos actualmente NO se guardan — ver CON-04)

**✅ Esperado:** Nombre y rol se guardan. Salary/benefits/hire_date probablemente NO se guardan (bug conocido CON-04).  
**❌ Problema:** Error al crear o editar perfil.

---

### TEST-10: Módulo RRHH — Negociaciones
**Módulo:** Negotiations  
**Pasos:**
1. Ir a RRHH → abrir un perfil
2. Crear una nueva negociación (título, descripción)
3. Editar la negociación — cambiar título y status
4. Eliminar la negociación

**✅ Esperado:** CRUD completo funciona sin errores.  
**❌ Problema:** Error en creación, edición o eliminación.

---

### TEST-11: Módulo Socios — Distribuciones
**Módulo:** Partners  
**Pasos:**
1. Ir a Socios
2. Verificar que la tabla de distribución muestra los socios con sus porcentajes
3. Verificar que el monto total coincide con el cálculo de distribución
4. Verificar que el gráfico circular se renderiza

**✅ Esperado:** Tabla con socios, montos calculados, gráfico visible.  
**❌ Problema:** Datos vacíos, montos en 0, gráfico que no renderiza.

---

### TEST-12: Exportación PDF individual
**Módulo:** PDF Export  
**Pasos:**
1. Ir a Comisiones
2. Seleccionar un HEAD y un BDM
3. Generar PDF individual
4. Abrir el PDF descargado

**✅ Esperado:** PDF bien formateado con nombre, período, cálculos detallados, total a pagar.  
**❌ Problema:** PDF corrupto, datos faltantes, layout roto.

---

## Prioridad 3 — Edge Cases

### TEST-13: Acceso directo a rutas sin sesión
**Módulo:** Auth Middleware  
**Pasos:**
1. Cerrar sesión (o abrir ventana incógnito)
2. Navegar directamente a `http://localhost:3000/` (dashboard)
3. Navegar a `http://localhost:3000/comisiones`
4. Navegar a `http://localhost:3000/rrhh`

**✅ Esperado (ideal):** Redirige a `/login`.  
**❌ Estado actual:** Probablemente muestra la página pero sin datos (SEC-05 — middleware comentado).

---

### TEST-14: Upload de contrato con archivo > 10MB
**Módulo:** File Upload  
**Pasos:**
1. Desde RRHH → perfil, intentar subir un archivo de más de 10MB

**✅ Esperado:** Error "Archivo demasiado grande (máx 10 MB)".  
**❌ Problema:** Si acepta el archivo o muestra error genérico.

---

### TEST-15: Verificar consola del browser por leaks de datos
**Módulo:** Frontend Security  
**Pasos:**
1. Abrir DevTools (F12) → Console
2. Navegar por el dashboard completo
3. Buscar logs con emails, passwords, tokens, o datos de otras empresas
4. Ir a Network tab → buscar respuestas que incluyan `twofa_secret`

**✅ Esperado:** No hay datos sensibles en consola. No hay `twofa_secret` en responses de network.  
**❌ Estado actual:** `twofa_secret` probablemente visible en network responses (SEC-02).

---

### TEST-16: Verificar usuarios y roles
**Módulo:** User Management  
**Pasos:**
1. Ir a Usuarios
2. Crear un nuevo usuario con rol "auditor"
3. Cerrar sesión
4. Iniciar sesión con el nuevo usuario
5. Verificar que puede ver datos pero las acciones de admin están restringidas
6. Verificar que puede agregar datos pero NO editar (CON-14)

**✅ Esperado:** Auditor ve datos, puede agregar, pero no puede editar ni eliminar.  
**❌ Problema:** Auditor ve opciones de admin o no puede ver nada.

---

## Resumen de Pruebas

| Prioridad | Tests | Descripción |
|-----------|-------|-------------|
| 🔴 P1 | TEST-01 a TEST-05 | Seguridad — auth, RLS, uploads, endpoints vulnerables |
| 🟡 P2 | TEST-06 a TEST-12 | Funcionalidad core — login, módulos, cálculos, PDF |
| 🔵 P3 | TEST-13 a TEST-16 | Edge cases — acceso sin sesión, límites, leaks |

---

## RESUMEN EJECUTIVO

| Auditoría | 🔴 Crítico | 🟡 Advertencia | 🔵 Recomendación |
|-----------|-----------|----------------|------------------|
| Seguridad | 8 | 8 | 5 |
| Conflictos | 4 | 10 | 9 |
| **Total** | **12** | **18** | **14** |

### Top 5 prioridades absolutas antes de producción:
1. **SEC-06/07:** Cross-tenant access en delete-user, reset-password, update-auth-user
2. **SEC-03:** Endpoints send-email y login-notification sin auth
3. **SEC-01/02:** 2FA falso + secretos expuestos al cliente
4. **CON-04:** ALLOWED_FIELDS descartando campos críticos silenciosamente
5. **SEC-05:** Middleware de auth comentado

*Documento generado automáticamente — VexPro Dashboard Audit 2026-04-13*
