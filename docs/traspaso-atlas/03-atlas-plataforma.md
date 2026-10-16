# Atlas (horizon-dashboard): informe de hechos verificados en código

Fue solo lectura. No edité nada, no me conecté a ninguna base y no corrí build ni tests. Todas las rutas son relativas a `/Users/kevinshark/dev/horizon-dashboard`.

## 1. Tenancy

**Modelos** (`prisma/schema.prisma`: 7.575 líneas, 166 modelos, 20 enums)

| Modelo | Hechos clave |
|---|---|
| `Organization` | `slug` único. `appDomain` único (marca blanca). `operatorHost` (de qué host de operador salen los enlaces). Marca: `logoUrl`, `logoUrlDark`, `ogImageUrl`, `primaryColor` (default `#7F77DD`). Además `timezone`, `defaultLocale`, `active`/`suspended`, `isOperator` (debe haber una sola org operadora). Plan y `subscriptionStatus`. 9 campos `limit*` más 2 de IA (0 = no disponible, -1 = ilimitado). `enabledModules ModuleKey[]`. Contadores `usage*` mensuales. Campos de Stripe (`stripeCustomerId`, `stripeSubscriptionId`, período, `cancelAtPeriodEnd`). `bdmLevels` es Json. |
| `OrgMember` | Único por `(orgId, userId)`. `orgRole` y `allowedModules ModuleKey[]` (lista vacía = sin módulos). |
| `ConnectedDomain` | Dominios de **correo** (SendGrid), no de app. SPF/DKIM/DMARC, `sendgridDomainId`, `dnsRecords` Json, `inboundConfigured`. |
| `OrgAddon` | `addonType` String, `quantity`, `priceCents`, `expiresAt`. |
| `SubscriptionHistory` | Plan anterior y nuevo, precios, `changedById`, `stripeEventId` (sirve para la idempotencia del webhook). |
| `PlatformSettings` | Fila única `"singleton"`: `requireTwoFactorForSuperAdmins` (default false) y el hash de la contraseña maestra de plataforma. |
| `ImpersonationLog` | `superAdminId`, `targetOrgId`, `targetUserId?`, `reason`, `startedAt`/`endedAt`. |
| `OrgMasterPassword` | La clave primaria es `orgId` (una sola maestra por org). Campos `hash`, `expiresAt`, `active`, `usageCount`, `lastUsedAt`. |

En 45 modelos el `orgId` tiene un default `dbgenerated("'cmo74cw2w…'")`, que es un ID literal de org. Ese mismo ID aparece como `HORIZON_ORG_ID` en `src/lib/audit.ts:52`.

**Cómo se resuelve la org de una petición**

- `src/middleware.ts` (no existe `proxy.ts`) es `withAuth` de next-auth. Hace tres cosas:
  - Redirige a `/security/2fa` si `token.twoFactorRequired`.
  - Abre `/admin` según `canAccessAdminArea`.
  - Su matcher cubre `/dashboard`, `/admin`, `/super-admin` y `/security`. No resuelve la org.
- `src/lib/atlas/request-org.ts` lee el header `Host` y llama a `getOrgByAppDomain` (`app-domain.ts`). Esa función:
  - Descarta el host canónico, `localhost` y los hosts de operador.
  - Busca `findUnique({appDomain})` vía `atlasReadAsSuperAdmin`, con `cache()` de React.
- Precedencia en `resolveAtlasContext` (`orgContext.ts`, 1.029 líneas): cookie de suplantación > org del host de marca blanca > `User.currentOrgId`.
- Errores que devuelve: `NO_ORG_ACTIVE` (404), `ORG_INACTIVE` y org suspendida (403), sin membresía (404/403).
- `canonical-domain.ts`: `CANONICAL_APP_HOST = "atlas.exuraglobal.com"`. `appBaseUrl()` prueba en orden `NEXT_PUBLIC_APP_URL` → `VERCEL_URL` → la canónica.
- `operator-hosts.ts`: lista cerrada `OPERATOR_HOSTS = ["atlas.exuraglobal.com", "atlas.horizonconsulting.ai"]`. Son hosts multiempresa y no anclan la sesión a una org.
- `app-domain.ts` existe pero solo en `src/lib/atlas/` (no hay uno en `src/lib/`).

**Marca blanca**

- `org-base-url.ts`: `orgBaseUrl()` sigue el orden appDomain → operatorHost → host de la request → env. Las reglas puras están en `org-base-url-rules.ts`.
- `src/lib/atlas/operator-brand.ts` (no está en `src/lib/`) define la marca por host:
  - Precedencia: marca blanca > Exura (solo `atlas.exuraglobal.com`, con logos `/logos/exura-*`) > Atlas.
  - El nombre del producto sigue siendo «Atlas» en los tres casos.
- Correos: `resolveOrgEmail` (en `email-events.ts`). La precedencia del remitente está en `sendgrid-config.ts`: primero el SendGrid propio de la org (`IntegrationConfig`), después `platformSenderForOrg` según el host de operador.

**Super admin**

- Es el flag `User.isSuperAdmin`. `isSuperAdmin()` está en `permissions.ts`.
- El panel es `src/app/super-admin/`, y su layout redirige a `/dashboard` si el usuario no es super admin. Secciones: alerts, inbound-quarantine, master-passwords, organizations, revenue, support.
- API: 17 handlers en `src/app/api/atlas/super-admin/**`.
- Suplantación (`impersonation.ts`): cookie cifrada `atlas_impersonation` con TTL de 4 h. Solo cambia `orgId`; el `userId` sigue siendo el del super admin. Rutas: `impersonate`, `/status`, `/end`.

**ModuleKey: 26 valores**

PROJECTS, TASKS, CHANNELS, DIRECT_MESSAGES, CALENDAR, FINANCES, INVOICING, WEBMAIL, MARKETING_CONTACTS, MARKETING_EMAIL, MARKETING_SMS, MARKETING_WHATSAPP, MARKETING_LANDING_PAGES, MARKETING_FORMS, MARKETING_AUTOMATIONS, MARKETING_ANALYTICS, CRM, MANAGEMENT, KNOWLEDGE, TEAM, HR, ESIGN, SUPPORT_SHIFTS, REVIEWS, CALLCENTER, ADMIN.

**Cómo se otorgan los módulos**

- `module-access.ts` (función pura):
  - Módulos efectivos = `allowedModules` del miembro ∩ `enabledModules` de la org.
  - SUPER_ADMIN y ORG_OWNER ven todo lo que la org tiene habilitado.
  - Si la org no tiene el módulo, la respuesta es `ORG_MODULE_DISABLED` para todos, incluido el super admin.
- Gates: `requireOrgModule` responde 403 `MODULE_FORBIDDEN`. Variantes: `hasOrgModule` (no lanza) y `requireOrgModuleEnabled` (solo mira la org, para aprovisionamiento).
- `module-grants.ts` → `modulesToGrant`: idempotente y nunca concede un módulo que la org no tiene.
- `DEFAULT_MEMBER_MODULES` (en `orgContext.ts`): PROJECTS, TASKS, CHANNELS, DIRECT_MESSAGES, CALENDAR, TEAM.
- `plans.ts` → `PLAN_TEMPLATES` (`priceCents` mensual/anual):

| Plan | Mensual | Anual | Usuarios | Módulos |
|---|---|---|---|---|
| EXPLORER | $0 | — | 3 | OPERATIONAL |
| STARTER | $39 | $390 | 10 | STARTER |
| PRO | $99 | $990 | 25 | PRO |
| BUSINESS | $249 | $2.490 | 100 | todos |
| BROKER | negociado | — | 50 | `BROKER_MODULES` (15) |
| CUSTOM | — | — | — | ninguno |

- Hay 5 addons en `ADDON_CATALOG`.
- Las plantillas se aplican a `enabledModules` desde dos sitios: `api/atlas/organizations/[orgId]/plan` (con `applyDefaults`) y el webhook de Stripe.
- Según `docs/atlas-authz-matrix.md`, TEAM y ADMIN no tienen gate de módulo en servidor.

## 2. Auth

**`src/lib/auth.ts`** (770 líneas)

- Un único `CredentialsProvider` con campos email, password y `twoFactorCode`.
- Sesión JWT de 30 días, con `updateAge` de 24 h. Login en `/login` y `signOut` también apunta a `/login`.
- `authorize` incluye: rate limit (`checkRateLimit`, por email y por IP), contraseña maestra de plataforma y maestra por org (`verifyMasterPasswordDetailed`, `notifyMasterPasswordUse`), 2FA con `checkTwoFactor` y auditoría.
- El token lleva: `id`, `systemRole`, `departmentId`/`Name`, `jobTitle`, `managerId`, `avatarUrl` (pasado por `tokenSafeAvatar`), `customRoleId`/`Name`/`Permissions`/`OrgId`, `viaMasterPassword`, `twoFactorRequired`, `twoFactorCheckedAt`, `lastRefreshedAt`.
- El token se refresca contra la base cada 60 s como máximo.

**2FA**

- Modelo `TwoFactorAuth`: `secret`, `enabled`, `backupCodes[]`. Usa la librería `otpauth` y `qrcode`.
- `two-factor-enforcement.ts` decide si el usuario está obligado a enrolarse:
  - Super admin: según `PlatformSettings.requireTwoFactorForSuperAdmins`.
  - Resto: según `AppSettings.requireTwoFactorForAdmins` de la org.
  - Los dos interruptores están apagados por defecto.
- La regla pura está en `two-factor-policy.ts`. La cortan el middleware (navegación) y `resolveAtlasContext` (APIs, 403).

**Roles**

| Enum | Valores |
|---|---|
| `OrgRole` | SUPER_ADMIN (virtual), ORG_OWNER, ORG_ADMIN, MANAGER, MEMBER, VIEWER |
| `SystemRole` (global) | ADMIN, GERENTE, SUPERVISOR, TEAM_MEMBER |
| `CommercialRank` | COMMERCIAL_ADMIN, MANAGER, SALES_MANAGER, HEAD, BDM |

- `CustomRole`: tiene `permissions Json` (default `[]`), `baseRole SystemRole`, `orgId`, y es único por `(orgId, name)`.
- `Department`: no tiene permisos; solo `name`, `color`, `orgId`.
- Catálogo de permisos: `src/lib/access-shared.ts`. El tipo `Permission` tiene unos 61 literales en 18 familias (admin, audit, callcenter, crm, finances, tasks…), además de `ALL_PERMISSIONS`, `rolePermissions` por SystemRole y `SCOPE_PERMISSIONS`.
- `src/lib/atlas/permissions.ts` (470 líneas): `isSuperAdmin`, `canManageSupportAgents`, `getOrgMembership`, `getEffectiveLimits` y los checks de límites (contactos, campañas, invitaciones, assistant, copilot).

**Resumen de la matriz de autorización** (`docs/atlas-authz-matrix.md`)

- Conviven dos sistemas de roles. El mapeo canónico es:

| systemRole | orgRole | Peso |
|---|---|---|
| ADMIN | ORG_ADMIN | 60 |
| GERENTE | MANAGER | 40 |
| SUPERVISOR | MEMBER | 20 |
| TEAM_MEMBER | MEMBER | 20 |

- Fase 1b: cada ruta privilegiada añade un piso por org con `requireOrgRole`.
- Fase 1d: `ctx.actor` lleva el `systemRole` topeado por el orgRole (ORG_ADMIN+ → ADMIN, MANAGER → GERENTE, MEMBER → SUPERVISOR, VIEWER → TEAM_MEMBER). Además, los permisos del rol personalizado solo cuentan si el `CustomRole` es de la org activa.
- Hay tres formas de preguntar: `can(ctx, perm)`, los helpers con `ctx.actor` y `requireOrgRole`.

## 3. RLS

- **GUCs**: `atlas.user_id`, `atlas.org_id` y `atlas.is_super_admin`. Se ponen con `set_config(…, true)` en un solo SELECT.
- **`dbContext.ts`**: `runInAtlasTx` es la primitiva base. Usa AsyncLocalStorage, `timeout` de 15 s y `maxWait` de 5 s, con `isolationLevel` opcional.
- **`readGuc.ts`**: `atlasReadBatch`, `atlasReadAsSuperAdmin` y `atlasReadFromOrgId`. Son transacciones batch sobre el pooler de transacción (puerto 6543).
- **`orgContext.ts`**: `withAtlasContext`, `runAtlasTenantTx`, `runInAtlasTxFromOrgId`, `runInAtlasTxForUser` y `runInAtlasTxAsSuperAdmin`.
- **`page-authority.ts`**: `requirePageContext` y `resolvePageAuthority`.
- **`api.ts`**: solo contiene `requireSession` y `handleAuthError` (47 líneas).
- **`docs/atlas-rls-strict.sql`**: 1.007 líneas, generado el 2026-08-21. Cubre 155 tablas, con 156 `FORCE ROW LEVEL SECURITY` y 158 `CREATE POLICY` (política `org_isolation`).
  - `docs/staging.md` habla de 133 tablas y 136 políticas, pero esa cifra es del ensayo del 2026-08-17.
  - `PlatformSettings` está fuera de RLS.
- **`scripts/rls-guc-inventory.py`** (687 líneas): detector léxico con 5 barridos sobre `src/` (`.ts` y `.tsx`). Sale con código 1 si queda algo pendiente. Las excepciones se marcan con `// rls-guc-ok:`. Saca la lista de tablas de `atlas-rls-strict.sql`.

## 4. i18n

- Dos idiomas: `src/messages/es.json` y `en.json`, con 7.467 líneas cada uno.
- 37 namespaces de primer nivel y 6.278 claves hoja en cada idioma; los conteos coinciden.
- Namespaces: admin, auth, billing, calendar, callcenter, channels, common, constants, crm, dashboard, email, emailMarketing, errors, esign, **finances** (838 claves), hr, invoicing, management, messages, nav, notifications, orgRoles, pay, profile, projects, reports, resources, search, superAdmin, support, tasks, tasksHub, team, trustpilot, userCard, workspacePage, workspaces.
- La paridad entre idiomas la fija `src/messages/parity.test.ts`.

## 5. Crons (`vercel.json`, región `lhr1`, 25 crons)

| Ruta | Schedule | Qué hace |
|---|---|---|
| /api/cron/reminders | */15 | Recordatorios de reuniones y facturas, marca facturas vencidas, resumen semanal |
| /api/invoicing/reminders/run | 0 9 * * * | Recordatorios automáticos de facturas (antes y después del vencimiento) |
| /api/cron/cleanup-typing | */5 | Borra filas viejas de `TypingPresence` |
| /api/cron/verify-domains | 0 6 * * * | Re-verifica el DNS de `ConnectedDomain` |
| /api/cron/check-alerts | 0 * * * * | Genera `SuperAdminAlert` |
| /api/cron/reset-monthly-usage | 0 0 1 * * | Reinicia los contadores `usage*` |
| /api/cron/trial-reminders | 0 9 * * * | Alerta de orgs en TRIAL cerca del fin (solo SuperAdminAlert) |
| /api/cron/email-marketing/poll-scheduled | */5 | Campañas programadas a más de 7 días (límite de QStash) |
| /api/cron/email-marketing/sequences | */5 | Pasos vencidos de secuencias |
| /api/cron/email-marketing/drain-dlq | 25 * * * * | Consume la cola de descartados (DLQ) de QStash |
| /api/cron/esign-expire | 20 * * * * | Expira solicitudes de firma vencidas y registra un `SignatureEvent` |
| /api/cron/support-shifts | */15 | Cierra solos los turnos y pausas olvidados |
| /api/cron/finance-recurring | 30 3 * * * | Genera las transacciones recurrentes |
| /api/cron/invoicing-recurring | 15 4 * * * | Emite las facturas recurrentes (retainers) |
| /api/cron/trustpilot-send | 40 * * * * | Publica un mensaje de QStash por org con invitaciones |
| /api/cron/email-retention | 45 2 * * * | Vacía la papelera del webmail |
| /api/cron/data-retention | 10 3 * * * | Purga notificaciones, tokens y eventos viejos |
| /api/cron/callcenter-callbacks | */15 | Avisa al dueño de cada callback vencido |
| /api/cron/callcenter-sla | */15 | Avisa al agente y al shift manager cuando se supera el SLA de primer contacto |
| /api/cron/callcenter-retention | 0 4 * * * | Expira grabaciones según la retención configurada por org |
| /api/cron/orion-sync | */15 | (Orion: fuera de alcance) |
| /api/cron/trading-sync | 20 5 * * * | (MT5: fuera de alcance) |
| /api/cron/support-template-mining | 40 4 * * * | Propone plantillas de soporte en estado DRAFT, con IA |
| /api/cron/callcenter-voiso-health | 7 * * * * | Revisa saldo y salud de la cuenta Voiso |
| /api/cron/callcenter-cdr-reconcile | 35 5 * * * | Compara los CDR de Voiso de ayer con las `Call` |

- Existe `src/app/api/cron/migrate-uploads/route.ts`, pero **no** está en `vercel.json`.
- `docs/staging.md` todavía dice «15 crons».
- Los 24 crons de `src/app/api/cron` usan `authorizeCron`.

## 6. Integraciones

**SendGrid**

- `@sendgrid/mail` 8. Archivos: `src/lib/sendgrid.ts`, `email-sender.ts` y `sendgrid-config.ts`. La config va por org (`IntegrationConfig`, clave cifrada) y, si no hay, cae al remitente de plataforma.
- Inbound Parse llega a `/api/email/inbound`. El webhook de eventos de marketing es `/api/email-marketing/webhooks/sendgrid`.
- `src/lib/email/local-delivery.ts` hace entrega local de correo entre buzones propios. Motivo medido: 19 de 19 correos internos se perdían.

**Stripe**

- `stripe` 22. Dos webhooks:
  - `/api/billing/webhook`: suscripciones. Eventos `customer.subscription.created/updated/deleted/trial_will_end`, `invoice.paid` e `invoice.payment_failed`. La idempotencia es la clave primaria de `StripeEventLog` (P2002 → 200).
  - `/api/invoicing/stripe/webhook`: `payment_intent.succeeded/failed`.
- Otras rutas: checkout, portal, subscription y `create-intent`.
- Planes pagos en Stripe: STARTER, PRO y BUSINESS (`src/lib/billing/stripe-products.ts`).

**IA (Anthropic)**

- `@anthropic-ai/sdk` ^0.90.
- Clave por org en `IntegrationConfig` con `provider="ANTHROPIC"`, cifrada con AES-256-GCM. A propósito no hay respaldo a `ANTHROPIC_API_KEY` (ver `anthropicKey.ts`, 386 líneas).
- El modelo se elige por org (`aiModels.ts`). Catálogo: `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`. Por defecto `claude-sonnet-5`.
- `ai.ts` usa `cache_control` en el system prompt.
- Modelos de datos: `AiConversation` (tipos ASSISTANT, COPILOT, SUPPORT_ASSIST) y `AiUsageLog` (tokens, `costCents`, `model`).
- Rutas: `atlas/ai/assistant/**` (3), `support/assist/...`, `admin/integrations/anthropic(/test)` y el cron de template-mining.

**Voiso**

- 88 archivos no-test lo mencionan. Código en `src/lib/callcenter/voiso/` (client, events, recording, simulator…) y 9 rutas en `atlas/callcenter/voiso/**`.
- El webhook es `POST /api/public/voiso/events`. Autentica con un Bearer `vwk_…` (que resuelve la org) más un `secret` en el cuerpo. Responde 200 casi siempre, porque Voiso desactiva el webhook tras 5 fallos.

**Trustpilot**

- Código en `src/lib/trustpilot/`. 12 rutas, entre ellas `/api/public/trustpilot/{eligible,review-detected}`.
- El plan contratado no incluye la Invitations API, así que hay dos vías de entrega: WEBHOOK (hacia Zapier) o ATLAS_EMAIL.

**Supabase**

- No usa el SDK. Storage se llama por REST (`fetch …/storage/v1/object`) desde `src/lib/fileStorage.ts`.
- **Realtime no está implementado.** El tiempo real es SSE con polling (`src/lib/sse.ts`). `docs/design-realtime-supabase.md` es solo una PROPUESTA.

**Otros**: Upstash QStash y Redis.

## 7. Auditoría

- Modelo `AuditLog`: `action`, `entityType`, `entityId`, `description`, `metadata` Json, `userId?` (SetNull) y `orgId`.
- `src/lib/audit.ts`:
  - `logAudit` exige estar dentro de `runInAtlasTx`. Si hay suplantación, la añade a `metadata`.
  - `logAuditAsSystem` abre su propia transacción con `runInAtlasTxFromOrgId`. Su org por defecto es `HORIZON_ORG_ID`.
- Uso: 250 archivos de `src/app` contienen `logAudit` y 37 usan `logAuditAsSystem`.
- `GET /api/audit` exige `can(ctx,"audit:view")` y `requireOrgRole(ORG_ADMIN)`.

## 8. Uploads y documentos

- Toda subida es una fila de `UploadedFile` y se sirve por `GET /api/files/[id]` (control de acceso en `file-access.ts`). `orgId` es nullable y hay una columna `data` de tipo bytea.
- Hay dos backends, elegidos en `fileStorage.ts`:
  - `db` (bytea): el default.
  - Supabase Storage: solo si están las 3 variables `SUPABASE_*`. Bucket privado; la clave del objeto es `<uploaderId>/<fileId>/<nombre>` y se recalcula en cada lectura.
- **No se usa Vercel Blob.**
- Límites: 4 MB por subida (`MAX_BYTES` en `/api/upload`), 10 MB por adjunto entrante.
- `Attachment` es otra cosa: archivos de tareas guardados como URL, con `taskId`.
- Documentación interna:
  - `DocPage`: `content`, o archivo vía `fileUrl`.
  - `DocFolder`: con visibilidad, más `DocFolderShare`.
  - 5 rutas en `atlas/docs`.
- Firma electrónica: modelos `SignatureRequest` (`publicToken`, `documentFileId`/`signedFileId`, `status`), `SignatureParty`, `SignatureEvent` y `SignatureRequestShare`. Flujo público en `/api/sign/[token]` (4 rutas) y en la página `src/app/sign`.

## 9. Sentry, tests, CI y migraciones

**Sentry** (`@sentry/nextjs` 10)

- Archivos de config: `sentry.server.config.ts` y `sentry.edge.config.ts`. `src/instrumentation.ts` los registra en `register()` y re-exporta `onRequestError`.
- `src/instrumentation-client.ts`: `tracesSampleRate` 0.1, replays en 0.
- En servidor descarta los errores "Content-Type was not one of".

**Tests**

| Ubicación | Archivos |
|---|---|
| `src/**/*.test.ts` (unit) | 184 |
| `tests/routes/**/*.test.ts` | 147 |
| `tests/components/**/*.test.tsx` | 52 |
| **Total** | **383** |

- `vitest.config.ts` define 3 proyectos: `unit` y `routes` (entorno node) y `components` (happy-dom).
- Harness: `tests/harness/` (`route-harness`, `fake-prisma`, `strict-rls-double`…).

**CI** (`.github/workflows/ci.yml`, en cada PR y en push a main)

- Tres jobs: `lint` (eslint src/), `typecheck` (tsc con 6 GB de heap) y `test` (`npm run test`).
- CI no corre `next build` ni `rls-guc-inventory.py`. Los dos figuran en la plantilla de PR como pasos manuales.
- Existe `.github/CODEOWNERS`.

**Flujo de PR y staging**

- Rama de Supabase `staging` con app local en el puerto 3999. `scripts/staging/{seed,smoke,rls-check,diff}.ts`.
- Batería de humo: 11 perfiles × ~121 llamadas. Compara código HTTP y la forma de la respuesta.

**Migraciones**

- `prisma/migrations`: 116 migraciones con timestamp, desde `20260409000000_baseline` hasta `20261012180000_orion_auto_rules_origen`. Se escriben a mano y se aplican con `db execute`.
- `prisma/migrations/manual/`: 3 SQL.
- `migrations-pending/` está en la raíz del repo, no en `prisma/`, y tiene 35 `.sql`. AGENTS.md la llama `prisma/migrations-pending/`, que no existe.

## 10. Conteos

| Métrica | Valor |
|---|---|
| Route handlers (`src/app/api/**/route.ts`) | 456 |
| `page.tsx` en `src/app` | 120 |
| `layout.tsx` | 19 |
| Archivos `.ts`/`.tsx` en `src` | 1.436 |
| Líneas totales `.ts`/`.tsx` en `src` | ~325.000 (~287.000 sin tests) |
| Líneas de JSON i18n | 14.934 adicionales |
| Copias "archivo 2.ts" | 0 |

## Lo que no pude verificar

- Que haya paridad real de políticas entre producción y `atlas-rls-strict.sql`, o la cantidad de tablas en prod: no me conecté a ninguna base.
- Valores de variables de entorno (por ejemplo, si las 3 `SUPABASE_*` están puestas en prod). Por eso no sé qué backend de almacenamiento está activo.
- Que la batería de tests pase hoy: no la ejecuté.
- La cantidad exacta de permisos distintos: los ~61 literales del tipo `Permission` salen de un conteo con grep.
- La semántica fina de cada cron: me basé en sus cabeceras, no leí cada implementación completa.
