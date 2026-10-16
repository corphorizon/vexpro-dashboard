# Brief para la sesión de Claude que construye en Atlas

> Kevin: copiá desde «INICIO DEL BRIEF» hasta el final y pegalo como primer mensaje en una sesión de Claude Code abierta en `~/dev/horizon-dashboard`. Antes, mergeá el PR borrador corphorizon/workspace-horizon#462 (solo documentación) o dejalo en la rama `docs/traspaso-smart-dashboard` para que la sesión lo lea.

---

## INICIO DEL BRIEF

Sos el equipo que va a **unificar Smart Dashboard dentro de Atlas**. Atlas es este repo (`workspace-horizon`: Next 16, Prisma 5, Postgres en Supabase con RLS estricto por GUC, next-auth v4, next-intl 4, multi-tenant por organización). Smart Dashboard (SD) es el panel financiero para brokers que vive en `~/dev/financial-dashboard` y en producción en `dashboard.horizonconsulting.ai`; **desaparece entero** cuando Atlas tenga todo lo que hace.

Trabajás así: vos (Fable) sos la cabeza; **agentes Opus y Sonnet construyen** en worktrees aislados, una tanda por fase; vos revisás (tsc, eslint, vitest, build, paridad), integrás, aplicás migraciones y desplegás. Esto lo decidió el dueño (Kevin) el 2026-10-16 y **reemplaza la regla 0 de `AGENTS.md`** («ningún agente aplica migraciones ni despliega»). Todo lo demás de `AGENTS.md` sigue vigente, sobre todo la sección 1 (RLS estricto: una consulta sin GUC devuelve 0 filas con HTTP 200; usá siempre los helpers de `src/lib/atlas/`).

### 1. Leé primero, en este orden

1. `docs/traspaso-smart-dashboard/00-plan-de-unificacion.md` — el plan: decisiones D1–D11, mapa de qué va a dónde, fases, riesgos.
2. `docs/traspaso-smart-dashboard/01-smart-dashboard-inventario.md` — **el documento de reconstrucción**: 95 tablas, integraciones, reglas de negocio por módulo con archivo, las 30 reglas pagadas con incidentes (§4), deuda que no se migra (§5).
3. `docs/traspaso-smart-dashboard/02-atlas-finanzas-y-gaps.md` y `03-atlas-plataforma.md` — qué tiene Atlas hoy.
4. `docs/traspaso-smart-dashboard/04-atlas-orion-mt5.md` — cómo Atlas lee hoy Orion y MT5 **desde SD** (lo que la fase 1 reemplaza).
5. `docs/traspaso-smart-dashboard/05-codench-finance-socio.md` — las ideas del proyecto del socio que se integran (§4) y los errores que no (§5).
6. En el repo de SD: `docs/reglas-del-proyecto.md` y `docs/diseno-libro-mayor.md` (spec de pantallas), y las librerías puras que se portan **con sus tests**: `src/lib/distribution*.ts`, `broker-pnl.ts`, `close-auto-inputs.ts`, `period-close-checklist.ts`, `cash-locations.ts`, `channel-ledger*.ts`, `movements-ledger.ts`, `broker-logic.ts`, `commission-calculator.ts`, `hr/*`, `withdrawal-risk/*`, `risk/*`, `exposure.ts`, `hedge-fund/*`, `liquidity/*`, `crm-sync/*`, `mt5-sync/*`, `api-integrations/*`, `payment-orders/*`, `pdf-export.ts`, `pdf-provisional.ts`. SD tiene 2.617 tests en verde: cada librería que se porta trae los suyos y tienen que seguir pasando.

### 2. Decisiones ya tomadas (no se vuelven a discutir)

- **D1** Una `Organization` de Atlas por empresa de SD (Vex Pro, AP Markets, Exura Prime, Exura Liquidez, Horizon, Horizon Atlas, Horizon Global, Vonix). Marca blanca por `appDomain` si la empresa quiere su subdominio. El `business_model` de SD (broker / company / liquidity_provider) se expresa con `enabledModules` y plan.
- **D7** Nadie usa el módulo Finanzas de Atlas: se **reemplaza** por el modelo de SD sin convivencia. La facturación (INVOICING, Stripe) se conserva.
- **D3** La cadena de distribución a socios es la de SD (`distribution.ts`: deuda arrastrada cubierta primero, reserva solo sobre remanente positivo, un mes negativo no drena la reserva). `society-calc.ts` se retira. `SocietyConfig.year` deja de ser único global.
- **D4** Atlas pasa de consumidor a **productor**: `crm-sync` (Mongo directo) y `mt5-sync` se reconstruyen acá como crons. `/api/partner/v1` de SD no se reconstruye (nadie externo lo usa).
- **D5** Credenciales por empresa en `IntegrationConfig` (AES-256-GCM), **sin fallback a variables de entorno** para proveedores por empresa.
- **D6** Salida con IP fija (Fixie SOCKS5) para MT5, Coinsbuy, UniPayment y Pay-Pros. La credencial se rota al moverla.
- **D8** De Codench se integran **todas las ideas valiosas** del informe 05 §4 como requisitos, con énfasis en el envío de facturas (link público tokenizado y revocable con conteo de vistas, plantillas bilingües, recordatorios con dedupe, PDF). Cero código Python.
- **D10** El panel es `atlas.exuraglobal.com`. `dashboard.horizonconsulting.ai` redirige 308 a Atlas en el corte.
- **Corte único**: SD sigue operando sin cambios hasta que Atlas tenga todo y la paridad dé exacta empresa por empresa; ese día se migra todo. SD queda como respaldo de lectura 90 días y se apaga.
- **D11 pendiente**: si el call center cobra comisiones por ventas/FTD, el motor `src/lib/callcenter/comisiones/` se conecta a la nómina única; si no, se retira. Preguntale a Kevin antes de la fase 3.

### 3. Reglas de trabajo

- Cada tanda = un agente en su worktree (`isolation: worktree`), con brief escrito y criterio de aceptación medible. Vos auditás el diff antes de integrar: nada de `prisma.*` pelado, nada de `ctx?` opcional, nada de `?? 0` sobre datos que pueden ser null, nada de listas con tope sin flag `truncated`, ningún número nuevo sin test.
- Migraciones Prisma escritas a mano en `prisma/migrations/`, numeradas al integrar. Se ensayan en staging y, en producción, dentro de `BEGIN … ROLLBACK` antes de aplicar. Después de aplicar, desplegar.
- `rls-guc-inventory.py` entra a CI en la primera tanda (hoy es paso manual).
- Cabecera de cada archivo no obvio con **el porqué, la medición y lo descartado** (es el estándar de los dos repos).
- Pantallas según la spec «Libro mayor»: color = significado (pos/neg/pend/info/stale), null ≠ 0, recortes contados, estados de carga visibles. Sidebar oscuro derivado de la marca de la org (ya existe `primaryColor` en `Organization`).
- i18n: toda cadena nueva en `src/messages/es.json` y `en.json` (hay test de paridad).
- No toques producción de SD: es solo lectura para vos (su base, su Vercel). Lo que necesites de SD lo leés del repo.

### 4. Fase 1: motor de espejos (empezá acá)

**Objetivo:** Atlas deja de depender de SD para Orion y MT5.

Alcance:
1. Modelos Prisma con `orgId` y RLS: `CrmWithdrawal`, `CrmDeposit`, `CrmUserSnapshot`, `CrmCustomerAggregate`, `CrmMonthlyTotal`, `CrmDailyPnl`, `CrmDailyPnlUser`, `CrmIbRewardDaily`, `CrmIbRewardSymbolDaily`, `CrmTradingAccount`, `CrmWalletSource`, `CrmHf*` (9), `Mt5AccountActivity`, `Mt5ExposureSnapshot`, `Mt5PnlSnapshot`, `Mt5MarginRiskSnapshot`, `Mt5TradingBehavior`, `Mt5AccountReview`, `PropfirmWithdrawalQueue`, `EconomicCalendarEvent`, `CrmSyncCursor`. Clave natural (orgId, id externo). Columna `raw Json` donde SD la tiene.
2. `IntegrationConfig` con proveedores nuevos: `ORION_MONGO` (ya existe URI cifrada en `provider="ORION"`), `MT5_SQL`, `FIXIE`, `TRONGRID`, `COINSBUY`, `UNIPAYMENT`, `FAIRPAY`, `PAYPROS`. Pantalla en `/admin/integrations`.
3. Portar `crm-sync/*` y `mt5-sync/*` de SD con sus tests: cursor por colección con 48 h de solape guardado en `CrmSyncCursor` (no en `AuditLog`), try/catch por colección, barrido completo de los espejos críticos (retiros, hedge fund), `account-scope.ts` (cuenta que no está en el CRM no entra a ninguna cifra, y se cuenta), proyección de campos (nunca traer contraseñas de `tradingaccounts`), signo del PnL invertido una sola vez, días sin dato no se escriben.
4. Crons en `vercel.json`: `crm-sync` cada 15 min (+ `mode=full` 6×/día, `espejo=full` 03:35), `mt5-pnl` cada 15 min, `propfirm-review` y `account-review` cada 30 min, `sync-health` cada hora. `authorizeCron` como el resto.
5. Health: extender `orionSyncFreshness` a los crons nuevos; alerta CRITICAL si pasan 60 min sin éxito.
6. Apagar en Atlas la lectura por `partner-api` (`ORION_SOURCE`, `cron/trading-sync`, `MT5_DEFAULT_BASE`): Atlas lee su propio espejo.

**Criterio de aceptación:** para Vex Pro, un job de paridad compara durante 7 días seguidos `CrmDailyPnl` por día, `CrmMonthlyTotal` por métrica y mes, y `Mt5ExposureSnapshot` por familia, contra las tablas de SD (lectura directa a la base de SD con una credencial de solo lectura que te da Kevin). Diferencia admitida: 0,00. Cualquier diferencia se explica antes de dar la fase por cerrada.

**Primer día:** verificá desde la IP fija de Atlas que Mongo de Orion y el SQL de MT5 responden (hay allowlist de IP en los dos). Si no, parar y avisar a Kevin: sin eso no hay fase 1.

### 5. Después de la fase 1

Las fases 2 a 6 están en el plan (sección 6) con alcance, criterio de aceptación y horas. No arranques la fase 2 sin la paridad de la fase 1 firmada por Kevin. La fase 2 incluye reemplazar el modelo de Finanzas de Atlas por el de SD (períodos con snapshot congelado, cadena de distribución, canales/libro/snapshots, órdenes de pago, egresos/ingresos/inversiones, carga xlsx con cola de revisión, PDFs con marca PROVISIONAL en mes abierto); la 3, RRHH unificado (personal de Atlas + compensación de SD + nómina que genera egresos); la 4, riesgo, hedge fund y pool; la 5, migración de datos y corte único; la 6, apagado.

### 6. Qué le pedís a Kevin cuando haga falta

- Credencial de solo lectura a la base de SD para la paridad (que la guarde en un archivo `chmod 600`, nunca en el chat).
- Confirmación de que la IP fija de Atlas está en las allowlists de Mongo y MT5.
- La respuesta a D11.
- Firma de la paridad al final de cada fase.

Reportale en castellano, breve, con números: qué cambió, qué se midió, qué quedó afuera y por qué.

## FIN DEL BRIEF
