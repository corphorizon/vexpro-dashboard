# Plan de unificación: Smart Dashboard → Atlas

**Fecha:** 2026-10-16 · **Decisión de Kevin:** «mover todo lo que tiene Smart Dashboard a Atlas, integrar todo; Atlas tiene cosas que Smart no tiene». Exura Global organiza.
**Base de este plan:** cinco informes de solo lectura sobre los tres repositorios (carpeta `docs/traspaso-atlas/`, archivos 01 a 05). Todo lo que se afirma acá tiene su fuente en esos informes; nada se verificó contra bases de producción.

---

## 1. Lo que hay hoy, en una página

| | Smart Dashboard (SD) | Atlas | Codench Finance (socio) |
|---|---|---|---|
| Repo | `corphorizon/vexpro-dashboard` | `corphorizon/workspace-horizon` | `CorredorManuel/contabilidad` |
| Stack | Next 16, Supabase JS, RLS por `auth_company_ids()`, 129 migraciones SQL a mano | Next 16, Prisma 5, Postgres (otro proyecto Supabase), RLS **estricto** por GUC, next-auth, next-intl | FastAPI + MySQL + Next; Docker en EC2 |
| Tamaño | 187k líneas, 147 endpoints, 52 páginas, ≥ 99 tablas en prod, **2.617 tests en verde** | 325k líneas, 456 endpoints, 120 páginas, 166 modelos, 383 archivos de test | 126 archivos, 46 tablas, 85 endpoints, 20 tests |
| Tenancy | `companies` + `company_users`; módulos en `active_modules`; modelo de negocio broker / company / liquidity_provider | `Organization` + `OrgMember`; 26 `ModuleKey`; planes (hay plan **BROKER** con 15 módulos); marca blanca por dominio; super admin con suplantación | `organizations` + membresías; permisos cargados pero **nunca consultados** |
| Finanzas | Cadena de distribución con **deuda arrastrada**, períodos con snapshot congelado, balances por canal con libro diario, órdenes de pago, egresos/ingresos, comisiones RRHH, riesgo, hedge fund | Libro de movimientos, saldos por cuenta, multi-moneda **sin tipo de cambio**, aprobación con control dual, períodos cerrados (bloqueo), CSV, recurrentes, KPIs, **sociedad sin arrastre de deuda**, facturación completa con Stripe | Movimientos COP/USD con TRM oficial, conciliación por corte, facturación con link público, nómina, cripto FIFO, cola de revisión |
| Datos externos | **Productor**: Orion Mongo directo, MT5 por Fixie, Coinsbuy, UniPayment, FairPay, Pay-Pros, on-chain, CoinGecko | **Consumidor de SD**: `orion-sync` y `trading-sync` leen `dashboard.horizonconsulting.ai/api/partner/v1/*` | Superfinanciera (TRM), CoinGecko, SMTP |

**Tres hechos que condicionan todo:**

1. **Atlas depende de Smart Dashboard.** Orion y MT5 entran a Atlas por la API de partners de SD (`ORION_SOURCE=partner-api`, `MT5_DEFAULT_BASE`). Si se apaga SD sin mover antes el motor de sincronización, Atlas se queda sin CRM ni MT5. Por eso el motor de espejos es la **primera** fase, no la última.
2. **Las fórmulas de socios no coinciden.** SD cubre primero la deuda arrastrada de meses negativos y recién después reserva y reparte (`distribution.ts`). Atlas retiene reserva mes a mes y no arrastra nada (`society-calc.ts`). Con la de SD se les pagó a los socios de Vex: **manda la de SD**. Además `SocietyConfig.year` en Atlas es único global, no por organización (defecto a corregir).
3. **El activo más valioso de SD es portable.** Las reglas de dinero viven en librerías TypeScript puras con tests (`distribution*.ts`, `broker-pnl.ts`, `commission-calculator.ts`, `cash-locations.ts`, `movements-ledger.ts`, `withdrawal-risk/score.ts`, `exposure.ts`, `period-close-checklist.ts`, `close-auto-inputs.ts`). No dependen de Supabase. Se portan **con sus tests** (2.617 casos) y se les cambia solo la capa de datos. Lo que NO se porta tal cual: SQL (RPCs, triggers, políticas), rutas y pantallas.

---

## 2. Decisiones de arquitectura

| # | Decisión | Por qué |
|---|---|---|
| D1 | **Una organización de Atlas por empresa de SD** (Vex Pro, AP Markets, Exura Prime, Exura Liquidez, Horizon, Horizon Atlas, Horizon Global, Vonix). El `business_model` de SD pasa a ser plan/módulos de Atlas: broker → plan BROKER; company → módulos FINANCES + INVOICING; liquidity_provider → módulo nuevo LIQUIDITY_POOL. | Atlas ya aísla por org con RLS estricto, marca blanca por dominio y super admin. Reproducir «empresa» como sub-entidad duplicaría la tenancy (registro doble: el modo de falla número uno de SD). |
| D2 | **Las librerías puras de SD se portan con sus tests; la capa de datos se reescribe en Prisma con los helpers RLS de Atlas** (`withAtlasContext`, `runAtlasTenantTx`, `atlasReadFromOrgId`). Nada de `prisma.*` pelado. | Es la regla 1 de Atlas: una consulta sin GUC devuelve 0 filas con HTTP 200. Y es la regla de SD: el fallo que no da error. |
| D3 | **La cadena de distribución de SD reemplaza a `society-calc`.** `FinancialClose` de Atlas se amplía a «período con snapshot congelado» (insumos, no resultados; `auto_sources`; checklist; cierre en orden cronológico; reapertura con motivo). | Hecho 2. Los números históricos de Vex (jul/ago/sep-26) son los del snapshot de SD y se migran **tal cual**. |
| D4 | **Atlas pasa de consumidor a productor.** El motor `crm-sync` (Mongo directo, 20+ colecciones, cursores con solape, barrido completo de espejos críticos) y `mt5-sync` (SQL READ ONLY por SOCKS5, timeouts duros) se reconstruyen en Atlas como crons propios. La API de partners de SD se apaga al final. | Hecho 1. Además elimina un salto de red y un token. |
| D5 | **Las credenciales por empresa viajan de `api_credentials` (AES-256-GCM) a `IntegrationConfig` (AES-256-GCM)** con un script de re-cifrado que corre el equipo con las dos claves; **sin fallback a variables de entorno** para proveedores por empresa. | Fuga entre empresas del 2026-05-01 en SD. Atlas ya tiene la misma política (`anthropicKey.ts`). |
| D6 | **Atlas necesita salida con IP fija** (Fixie SOCKS5 o equivalente) para MT5, Coinsbuy, UniPayment y Pay-Pros. | Esos proveedores tienen allowlist de IP. La credencial de Fixie se rota al moverla (estaba pendiente). |
| D7 | **El módulo Finanzas actual de Atlas se conserva para las orgs que no son broker** (facturación, aprobación con control dual, CSV, recurrentes, KPIs). Lo nuevo se suma por módulos; lo que se superpone se unifica en un solo registro (categorías, cuentas = canales, períodos). | Atlas tiene cosas que SD no: facturación con Stripe, control dual, recurrentes, presupuestos. No se tiran. |
| D8 | **De Codench se adoptan requisitos, no código.** Siete ideas (sección 5). El código Python no se migra: tiene reverso con impacto doble, borrados físicos, permisos muertos y path traversal. | Informe 05, §5. |
| D9 | **Agentes Opus/Sonnet construyen por PR contra staging de Atlas; Fable supervisa; el equipo aplica migraciones y despliega.** | Reglas 0 de Atlas: ningún agente toca producción, variables ni despliegues. |
| D10 | **El dominio del panel es `atlas.exuraglobal.com`.** Se frena la mudanza de SD a `dashboard.exuraglobal.com` (DNS pendiente en Hostinger). `dashboard.horizonconsulting.ai` redirige a Atlas al cortar; `/api/partner/v1` se mantiene hasta que D4 esté en producción. | No vale la pena mover un dominio que se va a apagar. |

---

## 3. Mapa: qué de SD va a dónde en Atlas

**Leyenda:** ✅ existe en Atlas y se reutiliza · 🔧 existe y se extiende · 🆕 se construye nuevo · ↪ se porta la librería pura de SD con tests.

| Dominio SD | Atlas | Qué se hace |
|---|---|---|
| `companies`, `company_users`, roles admin/socio/auditor/soporte/hr, `active_modules`, superadmin, «ver como» | ✅ `Organization`, `OrgMember`, `OrgRole` + `CustomRole`, `ModuleKey`, super admin + suplantación | Mapear roles de SD a permisos de Atlas (`access-shared.ts`): `finances:*`, nuevos `finances:approve`, `finances:close`, `hr:commissions`, `risk:*`. «Leer lo decide el módulo; escribir el rol» se conserva. |
| `periods`, `closing_snapshot`, `close_period`, `reopen_period`, checklist | 🔧 `FinancialClose` → `FinancePeriod` con `closingSnapshot Json`, `autoSources`, `closedBy`, `reopenReason`; `FinancePeriodChecklist` | ↪ `period-close-checklist.ts`, `close-auto-inputs.ts`, `distribution-snapshot.ts`. Orden cronológico obligatorio. El guard de período cerrado existe en Atlas (`closed-periods-guard.ts`): se extiende a los modelos nuevos. |
| Cadena de distribución, `partners`, `partner_distributions`, reserva % | 🔧 `Shareholder` (+ historial de porcentajes), `SocietyConfig` por org (corregir `year @unique`) | ↪ `distribution.ts`, `distribution-inputs.ts`, `chain-view.ts`, `broker-pnl.ts`. Reemplaza `society-calc.ts`. |
| `operating_income`, `income_lines`, `expenses` (fijos, huella, referencias, adjuntos), `expense_templates`, `investments` | 🔧 `Transaction` + `FinanceCategory` + `FinanceRecurring` (los fijos de SD son recurrentes de Atlas) | 🆕 modelo `IncomeLine` (facturado/cobrado/pendiente por cliente, modelo `company`); 🆕 huella del período (409 ante concurrencia); 🆕 adjuntos múltiples (hoy Atlas tiene uno). Devengado vs caja por modelo de negocio. |
| `channel_configs`, `business_units`, `location_business_units`, `channel_ledger_entries`, `channel_balances`, `pinned_coinsbuy_wallets`, `api_transactions`, `excluded_transactions` | 🔧 `FinancialAccount` → gana `channelType` (gateway/wallet/bank/cash/trading/loan/debt), `provider`, `visible`, `holder`, `onchainWallets`; 🆕 `BusinessUnit`, `AccountUnitShare`, `ChannelLedgerEntry`, `ChannelBalanceSnapshot`, `PinnedWallet`, `ExternalTransaction`, `ExcludedTransaction` | ↪ `cash-locations.ts`, `channel-ledger.ts`, `channel-balance-source.ts`, `movements-ledger.ts`, `broker-logic.ts` (Net Deposit). Cron de snapshot 00:00 («gana la primera escritura del día»), cron de pasarelas 4×/día. |
| `payment_orders`, `payment_beneficiaries`, proofs, attachments | 🆕 `PaymentOrder`, `PaymentBeneficiary` (datos bancarios **cifrados**, no en claro como SD), `PaymentOrderFile` | ↪ `payment-orders/*` (estados, preparar vs decidir, PDF). Al pagar crea la `Transaction` en el período de la fecha de pago. Integra con la aprobación con control dual de Atlas. |
| Comisiones y RRHH: `commercial_profiles`, `commercial_monthly_results`, negociaciones, IB, warnings, metas, onboarding | 🔧 HR de Atlas (`Employee`, `EmploymentContract`, `Leave`, `EmployeeDocument`, `SalaryRecord`, `Department`, `IntroducingBroker`; motor de comisiones de call center sin uso) | ↪ `commission-calculator.ts` (344 tests), `net-deposit-input.ts`, `hr/*`. 🆕 `CommercialProfile`, `CommissionResult`, `IbNegotiation`, `HrWarning`, `HrGoal`. La RPC `hr_net_deposit_by_profile` (árbol de 4 capas) se reescribe como SQL de Prisma con tests de paridad. El motor de comisiones del call center de Atlas (sin uso) se retira o se unifica. |
| Riesgo: `withdrawal_reviews`, eventos, `mt5_exposure_snapshots`, `mt5_account_review`, prop firm | 🆕 módulo RISK | ↪ `withdrawal-risk/*` (score calibrado, bandas), `risk/*` (programas prop firm, veredicto, copia), `exposure.ts` (nunca sumar entre familias). Eventos solo-inserción (trigger). Segregación: soporte escala, finanzas decide; `executedInCrm:false`. |
| Hedge fund `crm_hf_*` (9 tablas) | 🆕 módulo HEDGE_FUND | ↪ `hedge-fund/*`. Barrido completo, `unseen` contado, vigilante de configuración de comisiones (AP 0/0/0). Rótulo por org (Vex Capital). |
| Pool de liquidez `platform_liquidity_*`, `liquidity_*` | 🆕 módulo LIQUIDITY_POOL (org Exura Liquidez con selector de empresa) | ↪ `liquidity/*` con reglas L1–L7 (L1: el equity a liquidez nunca se recalcula). |
| Espejos CRM/MT5: `crm_*`, `crm_daily_pnl*`, `crm_monthly_totals`, `mt5_*` | 🔧 `OrionCustomer`, `OrionSyncState`, `TradingActivity`, `TradingMtAccount` + 🆕 `CrmDailyPnl`, `CrmDailyPnlUser`, `CrmMonthlyTotal`, `CrmWithdrawal`, `CrmDeposit`, `CrmIbRewardDaily`, `Mt5*` | ↪ `crm-sync/*`, `mt5-sync/*`, `account-scope.ts`. **No se migran los datos: se re-sincronizan** (backfill de `pnl_daily` desde 2025-10 entra en una llamada). |
| `api_credentials`, `channel_configs` de proveedores | ✅ `IntegrationConfig` (+ proveedores COINSBUY, UNIPAYMENT, FAIRPAY, PAYPROS, FIXIE, TRONGRID) | D5. |
| `partner_api_tokens`, `/api/partner/v1` | ✅ precedente `ExpoIngestKey` (hash SHA-256) | Se decide en D4 si Atlas expone una API de lectura para terceros. Si nadie externo la usa, no se construye. |
| `upload` (Excel por período) | 🔧 asistente CSV de Atlas | 🆕 soporte xlsx (hoy Atlas no tiene la librería), secciones por modelo de negocio, cola de revisión (idea de Codench). |
| Asistente IA | ✅ `AiConversation` + Anthropic por org | Portar las herramientas de solo lectura filtradas por módulo. |
| Notificaciones, `audit_logs`, reportes por email (diario/semanal/mensual), PDFs | ✅ `Notification`, `AuditLog`, SendGrid por org | ↪ generadores de PDF (cierre mensual, socios, provisional en mes abierto, libro, exposición). Las alertas por email de SD nunca se enviaron: en Atlas sí (hay `email-sender`). |
| Diseño «Libro mayor» (tokens, primitivas, sidebar oscuro de marca) | Atlas tiene su propio sistema | Se lleva como **spec de pantallas** (`docs/diseno-libro-mayor.md`), no como código: color = significado, null ≠ 0, recortes contados, estados stale. |

---

### 3.1 RRHH: un solo módulo con dos partes

Atlas ya tiene RRHH **administrativo** (`/dashboard/hr`, 13 endpoints): legajo de empleados importado desde usuarios, contratos con firma electrónica, licencias con aprobación, documentos sensibles, historial salarial y departamentos. No genera egresos en Finanzas ni calcula comisiones. Además tiene un **motor de comisiones de call center** (`src/lib/callcenter/comisiones/`, 1.324 líneas con tests: por ventas y FTD, bonos por umbral, todo en centavos) que **ninguna pantalla usa**; su contrato dice que SD lo consumiría para nómina y nunca se conectó.

Smart Dashboard tiene la parte **comercial**: perfiles HEAD/BDM, comisiones por net deposit con tramos y acumulados, diferencial del jefe, negociaciones con IBs, amonestaciones y metas, producción IB, onboarding.

Propuesta (fase 3):
- **Personal** = lo de Atlas, sin cambios. `Employee` es el registro único de la persona.
- **Compensación** = `CommercialProfile` colgado de `Employee`; la **nómina del mes** junta salario fijo (`SalaryRecord`), comisiones comerciales (motor de SD, 344 tests) y, si aplica, comisiones de call center (motor de Atlas), y genera los egresos en Finanzas con la regla de Codench «pagar o solo marcar» y detección de duplicados.
- **Decisión pendiente (D11):** si el call center cobra comisiones hoy, su motor se conecta a esa nómina; si no, se retira para no dejar una segunda fórmula viva.

## 4. Las reglas que no se pueden perder

Las 30 reglas pagadas con incidentes están en el informe 01, §4, con archivo y origen. Resumen de las que cambian la arquitectura de Atlas:

- **El cierre congela insumos, no resultados, incluidos los valores del CRM calculados en el servidor** (incidente 2026-10-12: Ago-26 congeló $671.000 en vez de $304.392,24). Se cierra en orden cronológico; reabrir exige motivo.
- **Cargando no es cero; sin dato no es cero.** Series del CRM en vuelo marcan el período incompleto; la cadena nunca cae a 0 (cae al manual heredado). PDF deshabilitados mientras carga; PDF de mes abierto marcado PROVISIONAL.
- **Un mes negativo no drena la reserva; la pérdida se arrastra como deuda.**
- **Escrituras por período son atómicas y server-authoritative** (`replace_period_*` con huella + 409). SD perdió $6.000 el 2026-10-08 por no tenerlo.
- **Toda exclusión se cuenta y todo recorte lleva `truncated`.** PostgREST recortaba a 1.000 filas en silencio. En Prisma no hay tope implícito, pero los `take` sí: cada listado paginado declara si quedó corto.
- **Comisión sin clamp** (negativa = deuda), **ND = 0 ambiguo conserva el acumulado**, **el tramo es un piso**, **el diferencial del head nunca es negativo**, **`bonus` es deuda**. Cada una costó dinero real.
- **Nunca se suma dinero entre familias MT5** (Cent en centavos). **Cuenta que no está en el CRM no entra a ninguna cifra.** **Depósitos por `amountPaid`, retiros por `requestedAmount`.**
- **Registro único**: módulos, roles, canales, categorías, checklist, proveedores. Atlas ya lo cumple con `ModuleKey`, `access-shared.ts`, `finance-permission-flags.ts`; los módulos nuevos se cuelgan de esos registros, nunca de una lista aparte.
- **Credenciales por empresa sin fallback a env.**

**Deuda de SD que no se migra** (informe 01, §5): webhook de Pay-Pros (nunca recibió eventos), secretos 2FA legibles, `companies_update` sin control de rol, datos bancarios en claro, Orion REST, endpoints huérfanos, dos parsers de fecha MT5, `handleRecalcHistory` sin auditoría, drift de 18 tablas sin DDL. Atlas lo resuelve de fábrica (RLS estricto, cifrado, auditoría obligatoria dentro de transacción).

---

## 5. Qué se integra de Codench Finance (el proyecto del socio)

El informe 05 lo muestra con detalle: el modelo de datos es más ambicioso que lo construido, y varias reglas declaradas se contradicen en el código. Se toman **ideas**, con sus pruebas de aceptación, y se descartan los errores.

| Idea | Qué aporta | Dónde encaja en Atlas | Qué NO se copia |
|---|---|---|---|
| **Multi-moneda con tasa oficial** | Movimiento con monto original + tasa del día + equivalente en moneda base. TRM COP desde Superfinanciera (datos.gov.co), sugerida por fecha y editable. | Atlas hoy separa por moneda **sin convertir**. Se agrega `exchangeRate`/`baseAmount` a `Transaction` y una tabla `ExchangeRate` por org. Permite consolidar USD/AED/EUR/COP. | La TRM por defecto = 1 en pagos (error de Codench). La tasa se guarda siempre; nunca se infiere. |
| **Conciliación por corte** | Saldo observado del extracto vs saldo en libros a una fecha; diferencia; historial del descuadre; «dónde revisar primero». | Se suma al libro por canal de SD (que concilia **API vs libro** automáticamente); esto cubre los canales **manuales** (bancos sin API, efectivo). | La migración que reescribió cortes como «balanced». |
| **Cola de revisión de importaciones** | Cada fila importada conserva el `raw`; las anomalías no se alteran y van a una cola con resolver/descartar. | Carga de datos (xlsx) de SD + asistente CSV de Atlas. | El mapeo vacío de la importación web (mandaba todo a revisión). |
| **Control de nómina** | Pago mensual por trabajador con «crear egreso o solo marcar» y detección de un egreso ya cargado (±7 días, mismo monto). | Comisiones de SD producen la nómina comercial; `SalaryRecord` de Atlas la administrativa. Un solo flujo de «pagar nómina» que genera la `Transaction`. | Borrado físico de nómina pagada. |
| **Tesorería cripto con lotes FIFO** | Costo por lote, realizado por venta, posiciones con precio de CoinGecko. | SD sabe el **saldo** on-chain; no sabe el **costo**. Útil para Exura y para las wallets de Vex. | FIFO global entre wallets (debe ser por wallet) y empates sin orden. |
| **Facturación con link público** | Token revocable, conteo de vistas, PDF bilingüe, recordatorios con dedupe. | Atlas ya tiene facturación con Stripe, recordatorios y link de pago: **redundante**. Solo se revisa si falta el conteo de vistas y la revocación explícita. | Recordatorios que crean un link nuevo por envío. |
| **Analítica de cobranza** | Aging en 5 tramos, días de pago promedio y mediana, concentración por cliente, comparación con período anterior. | Atlas tiene aging y top 5 deudores en `kpis-calc.ts`: se completa con mediana y concentración. | Mezcla de monedas en el dashboard. |

**Explícitamente descartado**: reverso de movimientos (impacto doble), borrados físicos, modelo de permisos (tabla muerta), 2FA desactivable sin OTP, documentos sin control de ruta, referencias sin validar entre organizaciones.

---

## 6. Fases

Las estimaciones son horas de agente (Opus/Sonnet) con revisión de Fable, por PR a staging de Atlas. No incluyen el tiempo del equipo para aplicar migraciones y desplegar. Supuesto: una fase a la vez con 2–3 agentes en paralelo por tanda, como en el rediseño.

| Fase | Qué entra | Entregable verificable | Horas |
|---|---|---|---|
| **0. Decisiones y congelamiento** (1 semana) | Confirmar D1–D10. Lista de orgs y planes. Fecha en que SD pasa a solo lectura. Inventario de prod de SD (≥ 99 tablas: hay 18 sin DDL). | Este documento aprobado; `docs/traspaso-atlas/` en el repo de Atlas; matriz roles SD → permisos Atlas. | 8–12 |
| **1. Motor de espejos** | `crm-sync` (Mongo directo, cursores, barrido completo, extras) y `mt5-sync` en Atlas como crons; modelos `Crm*`/`Mt5*`; `IntegrationConfig` para Fixie, Mongo, MT5; health-check con alerta (Atlas ya tiene `orionSyncFreshness`). Atlas deja de leer la API de partners de SD. | Para Vex Pro: `crm_daily_pnl`, `crm_monthly_totals` y exposición MT5 en Atlas coinciden al centavo con SD durante 7 días seguidos (job de paridad). | 70–90 |
| **2. Núcleo financiero broker** | Períodos con snapshot y checklist; cadena de distribución; Broker P&L automático; canales/unidades/libro/snapshots; pasarelas (Coinsbuy, UniPayment, FairPay, Pay-Pros saldo, on-chain); Net Deposit; movimientos; egresos/ingresos/inversiones; órdenes de pago; carga xlsx con cola de revisión; PDFs. Pantallas según spec «Libro mayor». | Para Vex Pro, con los mismos datos: `/socios`, `/balances`, `/resumen-general` y el PDF de cierre dan los mismos números que SD en Ago-26 y Sep-26 (los del snapshot). | 140–180 |
| **3. RRHH y comisiones** | Perfiles comerciales, net deposit por perfil (árbol de 4 capas), calculadora de comisiones con sus 344 tests, negociaciones, IB, warnings, metas, nómina unificada con `SalaryRecord`. | Liquidación de Sep-26 de Vex y AP idéntica a la guardada en SD (`commercial_monthly_results`). | 70–90 |
| **4. Riesgo, hedge fund y pool** | Score de retiros + cola + decisiones; prop firm (programas, veredicto, copia, noticias); exposición; revisión de cuentas; hedge fund con vigilante; pool de liquidez L1–L7. | Las decisiones históricas de `withdrawal_reviews` migradas; score recalculado coincide con el guardado (`factors` congelados). | 70–90 |
| **5. Migración de datos y corte por empresa** | ETL `company_id → orgId`: períodos + snapshots **tal cual**, egresos/ingresos/inversiones, canales y libro, órdenes de pago y archivos (Supabase Storage → `UploadedFile`), perfiles y resultados de comisiones, decisiones de riesgo, auditoría. Espejos: re-sync, no migración. Re-cifrado de credenciales. Orden: Horizon y Exura Liquidez (chicas) → AP Markets → Vex Pro. SD en solo lectura desde el corte de cada empresa. | Por empresa: reporte de paridad (totales por tabla y por período) firmado antes de habilitar la org en Atlas. | 50–70 |
| **6. Apagado** | Redirección 308 de `dashboard.horizonconsulting.ai` → `atlas.exuraglobal.com`; apagar crons de SD; apagar `/api/partner/v1` (si nadie externo lo usa); archivar repo; rotar Fixie y claves; dar de baja el proyecto Supabase de SD tras 90 días de respaldo. | Cero tráfico al dominio viejo durante 30 días; respaldo verificado. | 12–20 |
| | | **Total** | **420–550 h** |

**Secuencia mínima para no romper nada:** 1 antes que 6 (Atlas depende de SD); 2 antes que 3 (las comisiones leen períodos y net deposit); 5 por empresa y solo después de que la paridad de la fase 2 dé exacto para esa empresa.

---

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| Divergencia de número en algún mes ya pagado a socios | Los snapshots de SD se migran tal cual y son la fuente del mes cerrado; test de paridad por período antes de habilitar la org. |
| RLS estricto de Atlas devuelve 0 filas sin error en un camino nuevo | Cada endpoint nuevo pasa por los helpers de `src/lib/atlas/`; `rls-guc-inventory.py` entra a CI (hoy es paso manual). |
| Allowlist de IP de proveedores | Fixie (o equivalente) configurado en Atlas antes de la fase 2; probar cada proveedor desde staging. |
| Dos equipos editando el mismo dato durante la transición | SD pasa a solo lectura por empresa en el corte (fase 5); ninguna empresa opera en los dos a la vez. |
| El motor de Mongo de Atlas quedó sin uso desde 2026-08-25 (allowlist de IP de Mongo) | Verificar acceso desde la IP fija de Atlas en la fase 1, primer día. |
| Scope creep con Codench | Solo las 7 ideas de la sección 5, cada una como PR con criterio de aceptación. |

---

## 8. Decisiones que necesita tomar Kevin

1. **D1**: ¿una org de Atlas por empresa? (recomendado) ¿O Exura Global como org única con «empresas» adentro?
2. **D7**: ¿alguien usa hoy el módulo Finanzas de Atlas en producción? Si nadie, se puede reemplazar sin coexistencia.
3. **D4**: ¿algún tercero externo consume `/api/partner/v1` de SD además de Atlas? Si no, no se reconstruye.
4. **D10**: confirmar que se frena la mudanza a `dashboard.exuraglobal.com` y que no se cargan esos registros en Hostinger.
5. **Fecha** de solo lectura de SD por empresa (propuesta: tras el cierre de Oct-26, empezando por Horizon y Exura Liquidez).
6. **Codench**: ¿las 7 ideas, o un subconjunto? ¿Manuel participa en la especificación de conciliación y multi-moneda?
7. **Equipo**: quién aplica migraciones y despliega en Atlas (regla 0 de Atlas: no los agentes).
8. **D11 (RRHH)**: ¿el call center cobra comisiones por ventas/FTD hoy? Decide si el motor de Atlas se conecta a la nómina o se retira.

---

## 9. Qué recibe Atlas (contenido de `docs/traspaso-atlas/`)

| Archivo | Contenido |
|---|---|
| `00-plan-de-unificacion.md` | Este plan. |
| `01-smart-dashboard-inventario.md` | Modelo de datos (95 tablas con DDL o en uso, ≥ 99 en prod), integraciones, reglas de negocio por módulo con archivo, las 30 reglas pagadas con incidentes, deuda a no migrar, números. **Es el documento de reconstrucción.** |
| `02-atlas-finanzas-y-gaps.md` | Qué tiene Atlas hoy en Finanzas (35 endpoints, 11 modelos, reglas, tests) y la tabla de gaps existe / parcial / no existe. |
| `03-atlas-plataforma.md` | Tenancy, auth, roles, RLS, i18n, 25 crons, integraciones, auditoría, uploads, tests, CI, migraciones. |
| `04-atlas-orion-mt5.md` | Cómo Atlas consume hoy Orion y MT5 desde Smart Dashboard (lo que la fase 1 reemplaza). |
| `05-codench-finance-socio.md` | Inventario, reglas con archivo:línea, madurez, ideas a integrar y errores a no copiar. |

Fuentes de código que acompañan al traspaso (en el repo de SD): `docs/reglas-del-proyecto.md`, `docs/diseno-libro-mayor.md`, `src/lib/distribution*.ts`, `src/lib/broker-pnl.ts`, `src/lib/close-auto-inputs.ts`, `src/lib/commission-calculator.ts`, `src/lib/cash-locations.ts`, `src/lib/withdrawal-risk/`, `src/lib/risk/`, `src/lib/crm-sync/`, `src/lib/mt5-sync/`, `supabase/migration-061-period-close.sql`, `migration-111`, `migration-131`.
