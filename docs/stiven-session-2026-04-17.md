# Sesión de seguridad + features — 2026-04-17

**Para:** Stiven
**De:** Kevin (pair-programming con IA)
**Rama base:** `main` (ya mergeado, desplegado en Vercel)
**Commits en esta sesión:** `07059e1` → `59c3c0f`

---

## TL;DR

Después de tu última tanda de PRs (#11-14), se corrieron dos auditorías paralelas (seguridad + calidad) sobre ese código y se cerraron todos los hallazgos críticos. Luego se agregaron tres tandas de features pedidos por Kevin: UX quick wins, hardening de auth (lockout + recovery), y un módulo nuevo de configuraciones con roles custom y API keys encriptadas.

**Toca 5 migraciones nuevas (ya aplicadas), 3 env vars nuevas, varios endpoints nuevos y cambios al flujo de login.** Lee las secciones marcadas **⚠️ Importante** antes de seguir programando.

---

## Commits en orden

| Commit | Descripción | Archivos |
|--------|-------------|----------|
| `07059e1` | Fixes post-auditoría de tus PRs #11-14 | 11 archivos, +446/-106 |
| `8d07878` | Tanda 1 — UX quick wins | 6 archivos, +284/-114 |
| `078a8c1` | Tanda 2 — auth hardening | 17 archivos, +1271/-75 |
| `a48d089` | Tanda 3 — custom roles + API credentials | 9 archivos, +1248/-23 |
| `59c3c0f` | Email wiring a credenciales per-company | 6 archivos, +112/-51 |

---

## ⚠️ Importante — lo que cambió y puede afectar tu código

### 1. Migraciones nuevas (ya aplicadas en BD)
- `migration-014-twofa-pending-and-attempts.sql` — columnas `twofa_pending_secret`, `twofa_pending_at` en `company_users`; tabla `twofa_attempts`.
- `migration-015-auth-hardening.sql` — columnas `failed_login_count`, `locked_until`, `force_2fa_setup`, `must_change_password` en `company_users`; tablas `password_reset_tokens` y `twofa_reset_codes`.
- `migration-016-settings-module.sql` — tablas `custom_roles` y `api_credentials`.

**Si tocas `company_users` en tu código, considera estas columnas nuevas.**

### 2. Env vars nuevas requeridas
```
SENDGRID_API_KEY=<ya configurado>
SENDGRID_FROM_EMAIL=dashboard@vexprofx.com
API_CREDENTIALS_MASTER_KEY=<ya configurado, 32 bytes base64>
```
Las tres viven solo en `.env.local` (gitignored). **No rotar `API_CREDENTIALS_MASTER_KEY`** sin un script de re-encriptación: todas las credenciales almacenadas se volverían ilegibles.

### 3. El tipo `User` cambió
```ts
interface User {
  // ... existentes
  effective_role: UserRole;        // NUEVO — usar esto para permisos, no `role`
  force_2fa_setup: boolean;        // NUEVO
  must_change_password: boolean;   // NUEVO
}
```
- `effective_role`: resuelve roles custom al `base_role` heredado. **Usar `user.effective_role` en lugar de `user.role`** en cualquier check de permisos (`canEdit`, `canDelete`, etc.).
- `role` sigue siendo el string original (puede ser un nombre de rol custom).

Las funciones `hasModuleAccess`, `canAdd`, `canEdit`, `canDelete` ya se migraron a `effective_role`. Si agregas nuevos checks de rol, usa `effective_role`.

### 4. El login ya no llama directo a Supabase
- `login()` en `auth-context.tsx` ahora llama a `/api/auth/login-gate` **primero** (server-side password check + counter + lockout).
- Solo después hace el `signInWithPassword` en el cliente si el gate lo permite.
- Si creas otro flujo de auth, respeta este gate o te salta el lockout.

### 5. Primer login obliga 2FA setup
- Usuarios con `force_2fa_setup = true` y `twofa_enabled = false` son redirigidos automáticamente a `/setup-2fa` por el layout.
- Usuarios nuevos creados vía `/usuarios` tienen `force_2fa_setup = true` por default.
- `setup-2fa` libera la flag al completar la activación.

### 6. Rutas públicas nuevas (middleware)
`/reset-password` y `/reset-2fa` ahora son públicas (están en el matcher del middleware). No requieren sesión.

### 7. Emails ya usan credenciales per-empresa
`emailService.sendEmail(to, subject, html, text, companyId?)` — todas las helpers aceptan un `companyId` opcional. Si lo pasas, busca las credenciales de SendGrid de esa empresa en `api_credentials` antes de caer al env. **Cuando agregues un nuevo email, pásale el `companyId` del caller** para que funcione bien en multi-tenant.

---

## Detalle de cada commit

### `07059e1` — Fixes post-auditoría a tus PRs #11-14

Problemas que se encontraron en tu código y se corrigieron:

| # | Archivo | Problema | Fix |
|---|---------|----------|-----|
| 1 | `api/auth/setup-2fa/route.ts` | El secret TOTP viajaba del server al cliente y volvía en el verify → XSS podía reemplazarlo | Secret ahora se persiste server-side en `twofa_pending_secret`; verify lo lee de la BD |
| 2 | Mismo archivo | `generate` no exigía TOTP actual cuando 2FA ya estaba activo → rotación silenciosa con sesión robada | Ahora exige `currentToken` válido antes de regenerar |
| 3 | `lib/risk/rules.ts` | División por cero en las 5 reglas si `trades.length === 0` → "NaN%" en UI | Guard en cada regla, helper `safePct` |
| 4 | `api/auth/verify-pin/route.ts` | Sin rate-limit — brute-force viable con sesión robada | 3 intentos / 15 min lockout vía tabla Supabase |
| 5 | `api/auth/verify-2fa/route.ts` | Rate-limit en `Map` en memoria — se resetea por instancia en serverless | Migrado a tabla `twofa_attempts` (durable) |
| 6 | `risk/retiros-propfirm/page.tsx` | Sin guard de módulo — cualquier usuario autenticado podía entrar | `hasModuleAccess(user, 'risk')` + `'risk'` añadido a `ALL_MODULES` |
| 7 | `rrhh/page.tsx` | `company_id: 'vexpro-001'` hardcoded en `EmployeeForm` | Viene por props del `DataContext` |
| 8 | `lib/risk/parser.ts` | Parser xlsx no manejaba formato europeo (`1.234,56`) ni paréntesis contables (`($1,234)`) | Reescrito con soporte US + europeo + accounting |
| 9 | `risk/retiros-propfirm/page.tsx` | 2× `@ts-ignore` + 3× `any` | Tipos propios + dynamic imports limpios |

**Verificación:** build pasa, tsc clean, 0 errores nuevos de ESLint.

**NO se tocó** la lógica de `commission-calculator.ts`. Ver sección "Pendientes con decisión de producto" abajo.

---

### `8d07878` — Tanda 1: UX quick wins

1. **Login en inglés** + botón Eye/EyeOff para mostrar/ocultar contraseña (+ autocomplete hints).
2. **Botón "Reset 2FA"** admin-only por usuario en `/usuarios` (nuevo endpoint `/api/admin/reset-user-2fa`, scope por company, limpia pending y rate-limits).
3. **Paginación de 25 items** en `/liquidez` e `/inversiones` (reset al cambiar de filtro).
4. **Dashboard limpiado**: se quitaron las tarjetas "Recent Hires" y "Departments by Department".

---

### `078a8c1` — Tanda 2: Auth hardening

Cinco sub-features pedidos por Kevin. **Esta es la tanda que más flujos nuevos agrega**, revísala con atención.

#### 1. Lockout tras 3 intentos fallidos
- **Password:** nuevo `/api/auth/login-gate` verifica credenciales server-side, mantiene `failed_login_count`, y setea `locked_until` en 3er fallo. Lock dura 24h pero se libera en el instante en que el usuario resetea la contraseña.
- **2FA:** `verify-2fa` también escala al 3er fallo y bloquea la cuenta (status 423).

#### 2. Self-service password recovery
- Link "Forgot your password?" en `/login` → envía email con link a `/reset-password?token=...`
- `/api/auth/forgot-password` — respuesta neutra 200 (no leakea si el email existe)
- Token SHA-256 en BD, TTL 1h, one-shot
- `/api/auth/reset-password-confirm` — actualiza password vía Supabase Admin API + limpia `locked_until` + `failed_login_count` + `must_change_password`

#### 3. Self-service 2FA reset por email code
- Link "Can't access your authenticator?" en el paso 2FA del login → `/reset-2fa`
- Flow: email + password → código 6 dígitos por email → entrar código → desactiva 2FA + fuerza re-setup en próximo login
- Código 15 min TTL, 3 intentos, hash SHA-256 en BD
- `/api/auth/request-2fa-reset` y `/api/auth/confirm-2fa-reset`

#### 4. Primer login obliga 2FA setup
- Columna `force_2fa_setup` en `company_users` (default `true` para nuevos)
- Layout redirige a `/setup-2fa` si `force_2fa_setup && !twofa_enabled`
- Botón "Omitir por ahora" oculto si está forzado
- Setup exitoso limpia la flag

#### 5. Política de desbloqueo (decisión de producto)
Kevin eligió la **opción A**: password reset desbloquea la cuenta sin forzar reset de 2FA. El 2FA sigue intacto tras recuperar password.

---

### `a48d089` — Tanda 3: Custom roles + API credentials

Nuevo módulo `settings` + página `/configuraciones` con dos tabs.

#### Tab "Roles personalizados"
- CRUD per-empresa de roles con: nombre, descripción, `base_role` (uno de los 6 built-in), `default_modules[]`
- El `base_role` determina capacidades (admin hereda admin, socio hereda view-only, etc.)
- Al asignar un custom role a un usuario en `/usuarios`, se pre-rellenan los módulos desde `default_modules`
- **`user.effective_role` resuelve automáticamente al `base_role` del custom role** — los permission checks siguen funcionando

Endpoints: `GET/POST /api/admin/custom-roles` (admin-only, scope por company).

#### Tab "APIs externas"
- 4 providers: SendGrid, Coinsbuy, Unipayment, Fairpay
- Cada uno tiene un card que muestra estado (Configurado / No configurado)
- Configurado muestra `••••••••xyz` + extra_config fields (from_email, merchant_id, etc.) + botones Cambiar / Eliminar
- Secrets encriptados con **AES-256-GCM** (nueva lib `src/lib/crypto.ts`)
- Master key en `API_CREDENTIALS_MASTER_KEY` (32 bytes random base64). Nunca rotar sin re-encriptar todo.

Endpoints: `GET/POST /api/admin/api-credentials` (admin-only).

---

### `59c3c0f` — Email wiring a credenciales per-empresa

Después del commit anterior las API keys quedaban almacenadas pero `emailService` seguía leyendo de env. Este commit cierra ese gap.

- `getSendGridConfig(companyId?)` resuelve credenciales: BD primero, env como fallback
- `sendEmail(to, subject, html, text, companyId?)` — todas las helpers especializadas lo aceptan
- `new MailService()` por llamada en vez de mutar el singleton global → no hay leak entre empresas concurrentes
- Routes actualizadas: `/api/send-email`, `/api/send-email/test`, `/api/auth/forgot-password`, `/api/auth/request-2fa-reset`, `/api/auth/login-notification`

---

## Endpoints nuevos (cheatsheet)

| Método | Ruta | Descripción | Auth |
|--------|------|-------------|------|
| POST | `/api/auth/login-gate` | Pre-check + password verify + lockout tracking | public (credentials) |
| POST | `/api/auth/forgot-password` | Inicia recovery por email | public |
| POST | `/api/auth/reset-password-confirm` | Consume token, cambia password | public (token) |
| POST | `/api/auth/request-2fa-reset` | Envía código por email | public (credentials) |
| POST | `/api/auth/confirm-2fa-reset` | Consume código, desactiva 2FA | public (code) |
| POST | `/api/admin/reset-user-2fa` | Admin resetea 2FA de un usuario | admin session |
| GET/POST | `/api/admin/custom-roles` | CRUD de roles custom | admin session |
| GET/POST | `/api/admin/api-credentials` | CRUD de credenciales API | admin session |

Existentes modificados:
- `/api/auth/setup-2fa` — pending-secret server-side + bloqueo de regenerate si ya activo
- `/api/auth/verify-2fa` — rate-limit durable + escalation a account-lock
- `/api/auth/verify-pin` — rate-limit agregado
- `/api/send-email` + `/test` + `/api/auth/login-notification` — pasan `companyId`

---

## Pendientes con decisión de producto (te toca)

### 1. ⚠️ `commission-calculator.ts` — docstring vs implementación divergen

La auditoría detectó que el docstring dice una cosa y el código hace otra en:

- `accumulated_out` — comentario dice "base (division + accumulated_in) si comisión < 0", código siempre devuelve `division`.
- `applyTotalEarnedDebt` — posible doble contabilización cuando `currentRaw < 0` y `previousDebt ≥ 0`.
- Inconsistencia de signo entre `calculateBdmPctFromND` (rechaza ND<0) y `calculateSalaryFromND` (usa `Math.abs`).

**No se tocó nada** porque cambiar la lógica afecta nóminas reales de comerciales. Kevin quiere que tú decidas cuál era la intención correcta:
- Opción A: arreglar el código para coincidir con el comentario (cambian los números futuros → avisar a comerciales)
- Opción B: actualizar el comentario para coincidir con el código (mantener comportamiento actual)

Sugerencia: escribir tests unitarios con casos reales de tu Excel de referencia y elegir la opción que reproduzca esos números.

### 2. Lógica de `must_change_password` no está conectada al UI

La columna `must_change_password` existe y el layout redirige a `/perfil?forceChangePassword=1`, pero `/perfil` aún no lee ese query param para abrir el dialog automáticamente. Por ahora el usuario ve su perfil normal. **Cuando lo conectes**: en `perfil/page.tsx`, lee `useSearchParams().get('forceChangePassword')` y si es `'1'`, abre el dialog de cambio de password y bloquea otras acciones.

### 3. `/api/auth/login-gate` pre-flight race window

Entre el gate y el `signInWithPassword` del cliente hay ~100ms. Si un atacante acumula fallos exactamente en esa ventana, puede saltarse el counter por uno. Aceptable para v1 pero si quieres cerrarlo completamente: mueve el signIn real al server-side también (devolviendo tokens al cliente para que setee cookies). No prioritario.

### 4. Persistence de empleados en RRHH

`rrhh/page.tsx` todavía guarda empleados solo en estado local (`setEmployees`), no en BD. Cuando lo conectes a una tabla `employees`, ya tienes `companyId` disponible vía props (se arregló el hardcode anterior).

---

## Lo que yo (IA) sugerí y no se hizo

Cosas que identifiqué en las auditorías pero que Kevin decidió posponer:

1. **Rate-limit global** (login, forgot-password, send-email) con `@upstash/ratelimit` o similar. Hoy sólo `login-gate`, `verify-2fa` y `verify-pin` tienen rate-limit. El resto puede sufrir brute-force distribuido.

2. **Validación de complejidad de contraseña** — hoy solo se valida longitud ≥ 8. Considerar añadir reglas (mayúsculas, símbolos, dictionary check).

3. **Structured logging con redacción de PII** — hay varios `console.log` que loguean emails. En prod esto termina en los logs de Vercel.

4. **CORS explícito** en `next.config.ts` — default same-origin está bien, pero documentarlo previene sustos.

5. **Refactor de `commission-calculator.ts`** con tests unitarios antes de tocar la lógica (ver "Pendientes" arriba).

6. **SSL `rejectUnauthorized: false`** en `scripts/db-admin/*.mjs` — aceptable para scripts locales pero en CI no.

7. **Validar que `dashboard@vexprofx.com` tiene un mailbox real** o al menos MX hacia algún lado para que no se pierdan respuestas de clientes.

8. **Rotar el API key de SendGrid que fue compartido por chat** (Kevin ya lo sabe). El actual está en `.env.local`, pero conviene crear uno nuevo con permisos solo de Mail Send y borrar el viejo.

---

## Cómo probar rápido

1. Crear un usuario nuevo en `/usuarios` → debería ser forzado a `/setup-2fa` al login inicial.
2. En login, fallar password 3 veces → cuenta bloqueada.
3. "Forgot your password?" → email → `/reset-password?token=...` → nueva password → desbloqueado.
4. En el paso 2FA del login, "Can't access your authenticator?" → código por email → reset.
5. En `/configuraciones` → tab Roles → crear un rol "Sales Lead" con `base_role=socio` y módulos `[summary, movements, liquidity]` → asignarlo a un usuario → ese usuario solo ve esos módulos.
6. En `/configuraciones` → tab APIs → configurar SendGrid con un key de prueba → enviar password recovery → verificar que sale con ese key (no el env).
7. Admin puede resetear 2FA de otro usuario desde `/usuarios` (botón con ícono de escudo tachado).

---

## Referencias rápidas

- Reporte de auditoría original: `docs/audit-report-2026-04-13.md`
- Fixes de auditoría previa: `docs/stiven-security-fixes-2026-04-13.md`
- Migraciones: `supabase/migration-014-*.sql`, `015-*.sql`, `016-*.sql`
- Master key: `API_CREDENTIALS_MASTER_KEY` en `.env.local` (guardarla en password manager!)

---

Cualquier duda pregúntale a Kevin. El branch feature (`security/post-audit-fixes-2026-04-17`) sigue vivo en remote por si quieres referenciarlo, pero ya está todo mergeado en `main`.
