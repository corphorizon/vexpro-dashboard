Las cuatro áreas están verificadas leyendo el código, sin editar nada ni conectarme a ninguna base. Lo que no pude verificar está al final. Las rutas son relativas a `horizon-dashboard/`.

## 1. Orion

**Origen de los datos: lo decide `ORION_SOURCE`** (`src/lib/orion/source.ts`)
- La variable se lee en cada llamada, no al cargar el módulo.
- Solo el valor exacto `partner-api` activa la API. Cualquier otro valor, o la variable vacía, cae en `mongo`, que es el valor por defecto.
- El encabezado dice que desde el 2026-08-25 solo Smart Dashboard se conecta a Orion. La vuelta atrás es cambiar la variable de entorno; el código de Mongo no se borró.

**Origen `mongo`** (`src/lib/orion/sync.ts`): base `vexpro-prod`, que es la única permitida (`ORION_ALLOWED_DATABASES`).

| Colección | Uso |
|---|---|
| `users` | `find` con proyección explícita, incremental por `updatedAt` con `$gte`, lotes de 1.000, tope de 40 lotes por corrida |
| `wallets` | suma de `balance` con `walletType: "BALANCE"`, va a `balanceUsd` |
| `deposits` | `depositStatus: "COMPLETED"`: suma de `amountPaid`, conteo y máximo de `depositDate` |
| `withdrawals` | `status: "COMPLETED"`: suma de `requestedAmount` |
| `tradingaccounts` | conteo total y conteo con `real: true` (cuentas live) |
| `socialtradingaccounts` | conteo |
| `ibprograms` | catálogo de 509 documentos, se lee entero en cada corrida |

- Usa `maxTimeMS` y `allowDiskUse: false`.
- La re-agregación de una ventana de 24 h (`ORION_REAGG_WINDOW_HOURS`, lotes de 100 a 2.000) solo funciona con Mongo.

**Origen `partner-api`** (`src/lib/orion/partner-api.ts`)

| Aspecto | Detalle |
|---|---|
| URL base | `ORION_PARTNER_DEFAULT_BASE = "https://dashboard.horizonconsulting.ai"` (`uri.ts:74`); se puede cambiar por organización con `partnerBase` |
| Endpoint | `GET {base}/api/partner/v1/customers?since=<ISO>&limit=<n>[&afterId=<uuid>]` |
| Autenticación | `authorization: Bearer <token>`. El token define qué empresa se lee del lado del productor (`auth.companyId`). Un 401 o 403 se reporta como `ORION_UNAUTHORIZED`; el comentario menciona que falta el permiso `mt5:read` |
| Respuesta | `{ success, source, asOf, count, items[], hasMore, nextSince, nextAfterId }` |
| Paginación | cursor compuesto `since` + `afterId`. El `since` es el reloj de Smart Dashboard (`synced_at`) |
| Timeout | 25 s por página |
| Campos del item | `userId, username, email, firstName, lastName, clientId, country, countryIso, language, status, kycStatus, kycLevel` (llega como string), `userType, rank, sponsorUsername, sponsorEmail, ibProgramBrokerName, registerDate, enabledWithdrawals, walletBalance, totalDeposits, depositCount, lastDepositAt, totalWithdrawals, accountsCount, liveAccountsCount, socialAccountsCount, phoneRaw, phoneCountryCode, ibRewards, hierarchy, sourceUpdatedAt, asOf` |
| Campos que la API no envía (según el código, al 2026-08-31) | `ibProgramBrokerId`, `ibProgramFundingId`, `ibProgramFundingName` |
| Regla de descarte | un item sin `depositCount` numérico se descarta y cuenta como `skipped`. Los demás agregados caen a 0 si vienen nulos |

**Credenciales** (`src/lib/orion/config.ts`)
- Viven en `IntegrationConfig` con `provider="ORION"`, una fila por organización, cifradas con AES-256-GCM.
- Campos: `uriEncrypted` (URI de Mongo), `partnerTokenEncrypted`, `partnerBase`, `database`, `syncIntervalMinutes` (15 por defecto).
- No hay respaldo en variables de entorno. La pantalla nunca devuelve la URI y del token solo muestra una pista enmascarada.

**Tablas que escribe**

| Tabla | Qué guarda |
|---|---|
| `OrionCustomer` | único por `(orgId, orionUserId)`: identidad, KYC, `sponsorEmail`, `ibProgram*`, `ibPropFirmLevel1Pct/Levels`, `ibRewardsTotal/Broker/PropFirm/HedgeUsd`, `ibDepth`, `ibAncestorIds`, `balanceUsd, totalDeposits, depositCount, lastDepositAt, totalWithdrawals, accountsCount, liveAccountsCount, socialAccountsCount`, `contactId`, `lastDepositCountSeen`, `raw` (Json) |
| `OrionSyncState` | único por `(orgId, collection="users")`: cursores separados por origen (`lastSourceUpdatedAt` para Mongo; `lastPartnerSince` y `lastPartnerAfterId` para la API), más `lastRunAt`, `lastSuccessAt`, `stats`, `error` |
| `Contact` y `ContactActivity` | de forma indirecta, en dos casos: cuando `depositCount` pasa de 0 a más de 0 se llama a `runHandover` (traspaso a Retención, solo si el contacto sigue en Ventas); y `grantConsentFromOrion` escribe vía `consent-apply.ts`, que hace `contactActivity.createMany` (líneas 151 y 270) |

**Datos financieros:** saldo de billetera, total y cantidad de depósitos, fecha del último depósito, total de retiros, conteo de cuentas, IB rewards en cuatro columnas e historial de IB (`hierarchy`). No hay un "net deposit" guardado.

**Cron:** `/api/cron/orion-sync` corre `*/15 * * * *` según `vercel.json`, con `maxDuration` de 300 s y protegido por `CRON_SECRET`. Recorre las organizaciones con `IntegrationConfig(ORION, enabled)` y respeta el `syncIntervalMinutes` de cada una. Al final de la corrida llama a `applyOrionAutoRules`.

**Rutas de API**
- `GET/PUT /api/atlas/orion/config`: la configuración, de solo escritura para los secretos.
- `GET /api/atlas/orion/health`.
- `GET/POST /api/atlas/orion/sync`: el POST es una corrida manual acotada por `limit`, con opción `full`.

**Alerta de frescura** (`src/lib/atlas/orionSyncFreshness.ts`): es CRITICAL y se mide contra `lastSuccessAt`. El umbral es el mayor entre 45 minutos (configurable con `ORION_SYNC_STALE_ALERT_MINUTES`) y 3 veces el intervalo de la organización.

**Promote** (`promote.ts` y `promote-plan.ts`)
- Convierte clientes de un segmento en `Contact` del CRM y los agrega como `CallListMember`.
- El cruce es por `externalRefs.orion`, luego por email, luego por teléfono.
- Trabaja en lotes de 500 con un tope por defecto de 5.000. El enlace de vuelta (`OrionCustomer.contactId`) se hace con un `UPDATE … FROM unnest`.
- No crea contactos "por si acaso": solo materializa lo que se va a trabajar.

**Segmentos** (`segments.ts`): son módulos puros que arman un `where` sobre `OrionCustomer`. Hay 9: `active_sin_kyc`, `kyc_rechazado`, `kyc_solicitado`, `deposito_sin_cuenta_live`, `con_saldo_inactivo`, `sin_deposito`, `verificado_sin_deposito`, `sin_sponsor`, `todos`. Los parámetros por defecto son `minBalance` 50 y `daysInactive` 60.

**Reglas automáticas** (`auto-rules.ts`, modelo `OrionAutoRule`)
- Cada regla combina segmento, países (en modo incluir o excluir), idioma y sponsor, y define a qué lista va y a qué agente se asigna.
- Solo mira clientes desde `sinceAt` y procesa hasta 5.000 por corrida.
- Usa `runningSince` como candado para que dos corridas no se pisen.
- No le cambia el dueño a un contacto que ya tiene otro.
- Las rutas están en `src/app/api/atlas/callcenter/orion/{segments, lists-from-segment, auto-rules}`.

**Interfaz:** `src/components/crm/OrionSnapshotCard.tsx` (768 líneas) se usa en `ContactContextPanel.tsx`. Qué campos ve cada usuario depende de los permisos `callcenter:balance|deposits|kyc|broker:view`.

## 2. MT5 y trading

- **De dónde vienen los datos:** no hay conexión directa a MT5. El productor es Smart Dashboard, con la misma base `https://dashboard.horizonconsulting.ai` (`MT5_DEFAULT_BASE` en `src/lib/support/mt5Config.ts`).
- **Credencial:** `IntegrationConfig` con `provider="MT5"`, el token en `tokenEncrypted` y `baseUrl`, una fila por organización y sin respaldo en variables de entorno.

| Modo | Endpoint | Escribe en |
|---|---|---|
| Masivo (`trading/client.ts`) | `GET /api/partner/v1/trading-activity?since&limit=500[&afterLogin]`, Bearer. Responde `{success, source, asOf, count, items[], hasMore, nextSince, nextAfterLogin, notice}` | `TradingActivity`, único por `(orgId, email)` |
| Por correo (`support/trading-client.ts`, timeout de 6 s) | `GET …/trading-activity?email=<correo>`. Responde `{found, summary, accounts[]}` | `TradingMtAccount`, único por `(orgId, login)`; solo se escribe al abrir la ficha (`ficha.ts`, se considera fresco por 6 h) |

- **Campos del masivo:** `email, accounts` (es un conteo), `demoAccounts, tradeCount, firstTradeAt, lastTradeAt, accountEquityUsd, accountBalanceUsd, propFirmVirtualEquityUsd`, y `money[]` por familia (`family, accounts, tradeCount, balance{amount,unit}, profit{amount,unit}, isVirtual`).
- **Columnas de `TradingActivity`:** `mtEquityUsd`, `mtBalanceUsd`, `mtPropFirmVirtualUsd`.
- **Columnas de `TradingMtAccount`:** `login, group, family, balanceAmount/Unit, equityAmount/Unit, profitAmount/Unit, tradeCount, first/lastTradeAt, registeredAt`.
- **Familias y unidades:** Broker, Cent, Copy y PropFirm. La unidad es `cents` (centésimas de dólar) o `account_currency`. Los campos `*Usd` llegan ya convertidos. El capital de PropFirm es virtual y se excluye del equity.
- **Cursor:** se guarda en `OrionSyncState` con `collection="trading-activity"`.
- **Cron:** `/api/cron/trading-sync` corre `20 5 * * *` (una vez al día), con `maxDuration` de 300 s y hasta 60 páginas de 500.
- **El "cruce" de trading solo se cuenta.** Si un cliente operó desde la última vez (`traded++` en `sync.ts:317`), el número queda registrado pero no dispara ninguna acción.
- **Posiciones abiertas, símbolos, volumen, lotes, exposición, margen y apalancamiento:** no existen. La búsqueda en `src/lib/trading` y `src/lib/support/trading*` da 0 coincidencias.
- **Escritura en MT5:** no hay. Los únicos POST y PUT de estos módulos van a las rutas propias `/api/atlas/orion`.
- **Interfaz:** ficha 360 (`OrionSnapshotCard`, ruta `callcenter/contacts/[id]/orion`), "La Base" (`BaseExplorer.tsx`, `BaseTable.tsx`, exportación, filtros en `base-filters.ts`, `segment-presets.ts`) y el asistente (`assist-server.ts`).
- **Comentario desactualizado:** `trading/client.ts` dice que `orion/partner-api.ts` lee el token de `ORION_PARTNER_TOKEN`. `config.ts` documenta que ese token ya se movió a `IntegrationConfig`.

## 3. Ingesta de la app de FX Expo y otras APIs con token

- **Qué es:** la app de FX Expo envía leads y escaneos al CRM.
- **Endpoint:** `POST /api/public/expo/ingest`, con `Authorization: Bearer expk_…` y hasta 100 items por llamada (`MAX_ITEMS_PER_BATCH`).
- **Respuesta:** un estado por item (`created`, `updated`, `skipped` o `rejected` con `reason`).
- **Clave:**
  - Es `expk_` seguido de 32 bytes aleatorios en base64url.
  - Se guarda como SHA-256 hex sin sal en `ExpoIngestKey.keyHash` (único), para poder resolver la organización con una búsqueda indexada.
  - Se registra `lastUsedAt`. El tope es de 5 claves activas por organización.
  - Una clave desconocida, revocada o apagada devuelve el mismo 401.
- **Límites de uso:** 600 llamadas por minuto por IP y 120 por minuto por clave.
- **Gestión de claves:** `POST/GET /api/atlas/crm/expo/keys` y `DELETE …/keys/<id>`, con rol `ORG_ADMIN` o superior. La clave en claro se muestra una sola vez y revocar no borra el registro.
- **Idempotencia:** `ExpoIngestEvent` es único por `(orgId, dedupeKey)`, reclamado con `INSERT … ON CONFLICT DO NOTHING` dentro de la misma transacción.
- **Otros endpoints con token en `src/app/api/public/`:**
  - Trustpilot (`eligible` y `review-detected`): clave `tpk_` con SHA-256 en `trustpilotConfig.ingestApiKeyHash`.
  - Voiso (`events`): `Bearer vwk_` con hash, más un `secret` en el cuerpo comparado en tiempo constante.
  - `email/inbound`: verificado por firma.
- **No hay una API "de partners" saliente en este repo:** `src/app/api/partner` no existe. El productor `/api/partner/v1/*` vive en Smart Dashboard.

## 4. Tests (vitest)

Son 14 archivos, 3.681 líneas y 262 casos (conteo de `it` y `test` con grep).

| Archivo | Casos | Líneas |
|---|---|---|
| `src/lib/orion/mapping.test.ts` | 48 | 685 |
| `src/lib/orion/promote-plan.test.ts` | 42 | 491 |
| `src/lib/orion/segments.test.ts` | 41 | 420 |
| `src/lib/orion/client.test.ts` | 8 | 201 |
| `src/lib/orion/partner-api.test.ts` | 3 | 94 |
| `src/lib/trading/feed.test.ts` | 23 | 337 |
| `src/lib/atlas/orionSyncFreshness.test.ts` | 15 | 277 |
| `src/lib/support/trading.test.ts` | 18 | 240 |
| `src/lib/support/trading-client.test.ts` | 14 | 235 |
| `src/lib/callcenter/base-trading.test.ts` | 18 | 217 |
| `src/lib/expo/ingest.test.ts` | 19 | 209 |
| `src/lib/atlas/expoIngestHealth.test.ts` | 11 | 206 |
| `src/app/api/atlas/callcenter/orion/lists-from-segment/audit-tx.test.ts` | 1 | 38 |
| `src/app/api/atlas/callcenter/orion/auto-rules/[id]/run/audit-tx.test.ts` | 1 | 31 |

- No hay archivo de test propio para `orion/sync.ts` (1.895 líneas), `promote.ts`, `auto-rules.ts`, `trading/sync.ts`, `trading/accounts.ts` ni `ficha.ts`.
- Los archivos de Orion y trading que pediste suman 14.156 líneas, de las cuales unas 11.860 no son tests.

## No verificado

- Qué valor tiene `ORION_SOURCE` en producción (está en el entorno de Vercel, no en el código).
- Qué organizaciones tienen `IntegrationConfig` de ORION o MT5 activo (los comentarios dicen "solo Vex Pro").
- El contrato real del lado de Smart Dashboard: solo lo conozco por los comentarios de este repo.
- El cuerpo completo de `summary` y `accounts[]` en el modo por correo.
- Si Mongo sigue siendo accesible desde Vercel (los comentarios avisan de una lista blanca de IPs).
