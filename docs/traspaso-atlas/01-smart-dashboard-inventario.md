# Smart Dashboard: inventario funcional para reconstruirlo en Atlas

Todo lo que sigue sale de leer el repo `/Users/kevinshark/dev/financial-dashboard`; no se tocó la base ni ningún archivo. Corrí `npx vitest run`: pasan 166 archivos con 2.617 tests. Las rutas son relativas a la raíz del repo.

**Cuatro correcciones al encargo:**
- **No son 36 tablas, son 95.** Hay 77 con `CREATE TABLE` en `supabase/` (20 en `schema.sql` y 57 en migraciones). Otras 18 las usa el código pero no se crean en ningún archivo del repo. Producción tiene al menos 99, contando 4 tablas de backup.
- **No existe integración con Binance.** «binance» aparece sólo como RPC público de BSC (`onchain/usdt-balance.ts:68`) y como id de precio en CoinGecko (`onchain/prices.ts:26`).
- **Orion vía Mongo no pasa por Fixie.** La conexión es directa (`orion-mongo/client.ts:17`). Fixie lo usan MT5 SQL, Coinsbuy, UniPayment, Pay-Pros y Orion REST.
- **No hay `db-providers` ni tabla `providers`.** El registro de proveedores está repartido en tres sitios: el CHECK de `api_credentials.provider` (migraciones 087 y 102), `src/lib/api-channels.ts` y la tabla `channel_configs` (migración 035).

---

## 1. Modelo de datos

RLS, en abreviatura:
- **R-co**: lectura con `company_id IN auth_company_ids()`; el superadmin ve todas las empresas.
- **W-edit**: escritura con `auth_can_edit` (admin o auditor).
- **SR**: sin policy de escritura; sólo escribe el service role.

### 1.1 Empresa y tenancy

| Tabla | Para qué sirve y campos clave | Quién escribe | Quién lee |
|---|---|---|---|
| `companies` | El tenant. Guarda `slug`/`subdomain` únicos, `active_modules text[]` (los módulos por empresa viven aquí; no hay tabla aparte), `status`, `default_wallet_id`, `business_model` (broker / company / liquidity_provider, migraciones 069 y 124), `hedge_fund_label` (126), `reserve_pct` (default 0,25 en `schema.sql:34`), logos y colores | Superadmin (`/api/superadmin/companies*`) | Todo el sistema |
| `company_users` | Membresía usuario↔empresa. `role` con CHECK admin/socio/auditor/soporte/hr/invitado, `allowed_modules`, `twofa_secret` y `twofa_pending_secret` en claro, bloqueos, `preferred_language` | admin (`create-user`, `update-company-user`) | auth, guards |
| `platform_users` | Superadmins, con sus columnas de 2FA (021) | seed y superadmin | `is_superadmin()` |
| `custom_roles` | Plantillas de rol (`base_role`, `default_modules`) | admin | /usuarios |
| `report_configs` | Secciones y cadencia de los reportes por email | `/api/reports/config` | crons de reporte |
| `partner_api_tokens` | Tokens para Atlas: SHA-256, `token_prefix`, `scopes`. RLS sin policies | superadmin | `/api/partner/v1/*` |
| `api_credentials` | Credenciales cifradas AES-256-GCM (`encrypted_secret`, `iv`, `auth_tag`, `extra_config`), únicas por (empresa, proveedor) | `/api/admin/api-credentials` (SR) | integraciones |

### 1.2 Períodos y cierre

| Tabla | Para qué sirve y campos clave | Quién escribe | Quién lee |
|---|---|---|---|
| `periods` | Mes contable, único por (empresa, año, mes). Campos `is_closed`, `closed_at/by/by_name`, `closing_snapshot jsonb` (061) y `reserve_pct` (se usa pero ninguna migración la crea). Trigger `guard_closed_period_inputs` | cron `create-new-period`, RPCs `close_period` / `reopen_period` | la cadena de distribución |
| `period_close_checklists` | Foto de los pendientes en el momento de cerrar; una fila por cada cierre (111) | el flujo de cierre (SR) | auditoría |

### 1.3 Ingresos, egresos e inversiones

Todas llevan `period_id` salvo `investments`, que va por fecha.

| Tabla | Campos clave y notas | Quién escribe |
|---|---|---|
| `deposits` | `channel` CHECK (coinsbuy/fairpay/unipayment/paypros/other) | RPC `replace_period_deposits` |
| `withdrawals` | `category` CHECK (ib_commissions/broker/prop_firm/other), única por período desde la 065 | `replace_period_withdrawals` |
| `operating_income` | `broker_pnl`, `other`, única por período | `/api/admin/data` |
| `prop_firm_sales`, `p2p_transfers` | Únicas por período (044); `p2p.source` manual/api | `/api/admin/data` |
| `expenses` | `paid`, `pending`, `is_fixed`, `expense_date` (056), `payment_order_id` (058), `reference` y adjunto (060) | `replace_period_expenses` |
| `expense_templates`, `expense_template_period_hidden` | Egresos fijos con vigencia (050) | `/upload` |
| `income_lines` | Facturación del modelo company: `client`, `amount`, `received`, `pending` (068) | `replace_income_lines` |
| `investments` | Por fecha; `profit` y `movement_type` (062, sin DDL en el repo) | `/upload` |
| `liquidity_movements`, `liquidity_accounts` | Conciliación de liquidez (020, 062 sin DDL) | `liquidity-reconcile` |
| Legado | `broker_balance`, `financial_status`, `preoperative_expenses` | — |

### 1.4 Canales, balances y libro mayor

| Tabla | Campos clave | Quién escribe | Quién lee |
|---|---|---|---|
| `channel_configs` | `channel_key`, `channel_type` (api/manual/auto), `is_visible`, `is_custom`, `location_type` (gateway/wallet/bank/cash/trading/loan/debt), `business_unit_id`, `holder`, `onchain_wallets jsonb` (085). **Es la tabla de "cash locations"** | `/api/admin/channel-configs` | balances, reportes, cron |
| `business_units` | `counts_to_fund` (070) | `/api/admin/business-units` | `summarize` |
| `location_business_units` | Reparto (canal, unidad) con `share` de 0 a 1 (071, 075) | `/api/admin/location-units` | `allocateShares` |
| `channel_balances` | Snapshot diario por canal y por wallet (`coinsbuy:<wallet>`); `source` manual/api/derived; `meta` | cron 00:00 (gana la primera escritura del día) | respaldo del libro |
| `channel_ledger_entries` | `kind` opening/in/out, `amount ≥ 0`, `source` manual/api, una sola apertura por canal, un asiento api por día y categoría (059, 063, 112) | cron (api) y `/api/admin/channel-ledger` (manual) | libro, balances |
| `pinned_coinsbuy_wallets` | `role` operating/internal (017, 084) | `/api/admin/data` | Net Deposit, balances |
| `api_transactions` | Única por (empresa, proveedor, external_id); `internal` (053), `wallet_label` | `sync-external-apis`, `sync-crm` (Pay-Pros), webhook | movimientos, RPC `get_period_totals_by_month` |
| `api_balance_snapshots`, `api_sync_log` | Bitácora de syncs | sync | red de seguridad de los reportes |
| `paypros_webhook_events` | Body crudo de cada webhook (081) | webhook | — |
| `excluded_transactions` (sin DDL) | Exclusiones manuales | `/api/integrations/excluded-transactions` | RPC (109) |

### 1.5 Socios

- **`partners`**: `percentage` y `user_id`.
- **`partner_distributions`**: el socio ve sólo su fila; admin y auditor ven todas. **El `amount` guardado nunca se lee**: siempre se deriva como `montoDistribuir × pct`. La tabla quedó fuera a propósito del guard de cierre (066).
- No hay tabla de snapshot de distribución: el congelado es `periods.closing_snapshot`.

### 1.6 Órdenes de pago

- `payment_orders` (054, 055, 057): número `OP-AAAA-NNNN`, estados, `lines jsonb`, `expense_id`, trigger `payment_orders_guard`.
- `payment_beneficiaries`: datos bancarios y cripto en claro.
- `payment_order_proofs` (086) y `payment_order_attachments` (127).
- Todas con lectura R-co y escritura SR.

### 1.7 Comisiones y RRHH

Todas llevan además una policy RESTRICTIVE `auth_is_hr_reader()` (064).

| Tabla | Campos clave |
|---|---|
| `commercial_profiles` | `head_id` (autorreferencia), `role` libre, `net_deposit_pct`, `pnl_pct`, `extra_pct`, `fixed_salary`, `pnl_special_mode`, `nd_pct_fixed` (128), `is_master_ib` y `pct_linea` (129/130), `pct_sobre_bdm_global`, `hire_date`, `contract_url`, `termination_*` |
| `commercial_monthly_results` | ND actual/acumulado, `division`, `real_payment`, `accumulated_out`, `salary_paid`, `total_earned`, `bonus` (= deuda arrastrada), `pct_override` (129) y `head_id` (sin DDL; `schema.sql:309` tiene `UNIQUE(profile_id, period_id)`, que prohibiría el modelo actual) |
| `employees`, `commercial_negotiations` | — |
| `hr_warnings` | Única por (perfil, mes, motivo); motivos net_deposit / new_lines / team_creation; sin UPDATE |
| `hr_net_deposit_goals` | Meta por salario (096) |
| `ib_negotiations` | Una activa por (IB, tipo) (099) |
| `crm_ib_reward_daily`, `crm_ib_reward_symbol_daily` | Producción IB, 098 (SR) |
| Sin DDL | `onboarding_checklist`, `ib_rebate_configs`, `ib_rebate_config_history`, `ib_rebate_thresholds` |

### 1.8 Riesgo

| Tabla | Notas |
|---|---|
| `withdrawal_reviews` | Una fila por retiro: score, banda, `factors` congelados, decisión (088) |
| `withdrawal_review_events` | Sólo admite INSERT; un trigger bloquea UPDATE y DELETE incluso al service role (089) |
| `mt5_exposure_snapshots` | Por familia y símbolo, con `unit`; nunca un total; se guardan 48 h (095) |
| `mt5_account_review` | `checks`, `violations`, `risk`, `truncated` y toxicidad (101, 104, 119) |
| Sin DDL | `risk_revisions` (tope 50 por empresa: las viejas se borran), `propfirm_withdrawal_queue`, `mt5_pnl_snapshots`, `mt5_pnl_daily`, `mt5_margin_risk_snapshots`, `mt5_trading_behavior`, `economic_calendar_events` |

### 1.9 Hedge fund (migración 125)

Nueve tablas `crm_hf_*`: funds, investments, ledger_entries, payouts, commissions, commission_config_snapshots, withdrawal_requests, monthly_returns y certificates. Clave compuesta (empresa, id externo) y columna `raw jsonb`. Las escribe sólo el sync del CRM (SR).

### 1.10 Espejos del CRM y de MT5

Todas SR; se escriben desde `sync-crm`.

| Tabla | Clave | Migración |
|---|---|---|
| `crm_withdrawals`, `crm_deposits` | `status_norm` normalizado | 088 |
| `crm_user_snapshots` | — | 088, 103 |
| `crm_customer_aggregates` | — | 093 |
| `crm_monthly_totals` | (año, mes, métrica) | 100 |
| `crm_daily_pnl` | `utc_day` | 106 |
| `crm_daily_pnl_users` | — | 122 |
| `mt5_account_activity` | Su columna `equity` no tiene DDL | 090 |
| `mt5_email_sync_state` | — | 092 |
| Sin DDL | `crm_trading_accounts`, `crm_wallet_sources` | — |

### 1.11 Pool de liquidez

Las tres tablas `platform_liquidity_accounts`, `platform_liquidity_monthly_pnl` y `platform_liquidity_transfers` no tienen DDL. Las migraciones 116, 117 y 118 sólo les agregan columnas.

### 1.12 Usuarios, auditoría, notificaciones y asistente

| Tabla | Notas |
|---|---|
| `twofa_attempts`, `password_reset_tokens`, `twofa_reset_codes` | Nacieron con `DISABLE RLS` (014, 015); la 047 las cerró (SR) |
| `audit_logs` | `action` con CHECK; INSERT exige `user_id = auth.uid()` (077). También guarda el cursor del sync del CRM (module `crm_sync`) |
| `notifications` | `dedupe_key` único; se escribe con la RPC `push_notifications` (067) |
| `ai_chats`, `ai_chat_messages` | Cada usuario ve sólo lo suyo (102) |

### 1.13 RPCs clave

| RPC | Qué hace |
|---|---|
| `auth_company_ids`, `is_superadmin`, `auth_can_edit` / `auth_can_manage` | Helpers de tenancy (`SECURITY DEFINER`) |
| `auth_is_hr_reader` | Sin filtro de empresa: basta ser admin o hr en cualquiera |
| `replace_period_expenses / deposits / withdrawals`, `replace_income_lines` | Borran e insertan todo el período en una transacción |
| `materialize_fixed_expenses` | Copia los egresos fijos al período nuevo |
| `get_period_totals_by_month` | Depósitos y retiros mensuales desde `api_transactions` |
| `get_channel_day_movements`, `replace_channel_ledger_day`, `get_channel_ledger_last_entry` | Libro mayor por canal |
| `next_payment_order_number` | Correlativo de órdenes de pago |
| `hr_net_deposit_by_profile`, `hr_padres_resueltos`, `hr_pnl_input_by_profile`, `hr_ib_production_by_profile` | RRHH |
| `close_period`, `reopen_period` | Cierre (ver §3.1) |
| Triggers `guard_closed_period*` | Bloqueo de escrituras sobre meses cerrados |
| `split_liquidity_movement` | Sin DDL |

---

## 2. Integraciones externas

**Credenciales.** Viven en `api_credentials`, cifradas con AES-256-GCM e IV de 12 bytes (`src/lib/crypto.ts:14-60`). La clave es `API_CREDENTIALS_MASTER_KEY`, que `crypto.ts` decodifica como base64 de 32 bytes. `env.ts:38-40` la valida como hex de 64 caracteres, incompatible, pero **`env.ts` no lo importa nadie**: es código muerto.

**Fallback a variables de entorno.** Se quitó para Coinsbuy, UniPayment y FairPay el 2026-05-01, por una fuga de datos entre empresas (`coinsbuy/auth.ts:67-73`). Sigue activo para Anthropic, SendGrid y Orion REST; Orion REST repite el mismo patrón que causó la fuga.

**Proxy Fixie.** SOCKS5 con IPv4 forzado y timeout de 15 s (`api-integrations/proxy.ts`). IPs de salida: 3.224.144.155 y 3.223.196.67.

| Integración | Qué lee | Cada cuánto | Escribe en | Fallos y «sin dato ≠ 0» |
|---|---|---|---|---|
| **Orion CRM (Mongo)** | `withdrawals`, `deposits`, `users`, 9 colecciones `hedgefund*` y `hedgefundcommissionconfigs`, `wallets`, `tradingaccounts`, `socialtradingaccounts`, `pnl_daily`, `servergroups`, `wallettransfers`, `transferp2ps`, `userpropfirms`, `withdrawalpropfirms`, `ib_reward_daily`, `ibrewards`. Se piden sólo los campos necesarios: `tradingaccounts` trae contraseñas en claro y hay una lista de campos prohibidos (`aggregates.ts:46-60`) | `sync-crm` cada 15 min (rápido); `?mode=full` 6 veces al día; `?espejo=full` a las 03:35 | `crm_*`, `crm_hf_*`, `api_transactions` (Pay-Pros) | Cursor = `updatedAt` máximo con 48 h de solape, guardado en `audit_logs`. try/catch por colección (si falla, su cursor no avanza), por extra y por empresa. Un extra que no corrió queda `null`. Días sin dato no se escriben como 0 (`daily-pnl-sync.ts`). `sync-health` (:40 de cada hora) avisa `crm_sync.stale` si pasan más de 60 min |
| **MT5 (SQL)** | `mt5_users`, `mt5_accounts`, `mt5_deals`, `mt5_positions`, `mt5_groups` | `mt5-pnl` cada 15 min; `sync-crm` (exposición y actividad); `propfirm-review` y `account-review` cada 30 min | `mt5_*`, `propfirm_withdrawal_queue` | mysql2 o pg, una conexión por invocación, túnel Fixie, `SET SESSION TRANSACTION READ ONLY`. Timeout de 15 s por consulta con `Promise.race` que destruye la conexión (`mt5-sql/client.ts:173-212`). Nunca se consulta en vivo desde una pantalla |
| **Coinsbuy** | OAuth `/token/`, `/transfer/` (status 2), `/wallet/` | `sync-external-apis` 4 veces al día (ventana de 35 días); snapshot 00:00 | `api_transactions`, `channel_balances`, libro | Sólo wallets fijadas. Si falta una wallet fijada, ese día no se escribe nada. **Tope silencioso de 2.000 transferencias por ventana** (`transfers.ts:29`) |
| **UniPayment** | `/connect/token`, `/v1.0/invoices` (Complete), `/wallet/balances` | Igual | Igual | Un 429 devuelve lo parcial con status `stale` y 300 ms entre páginas. Incidente: espejo congelado desde el 08-08, con $32.510 contra $140.963 |
| **FairPay** | Portal: `getTransactionList`. Banking: `/api/v1/accounts`, eligiendo una sola cuenta Corporate en la moneda de la empresa | Igual | `api_transactions`, `channel_balances` | No hay API de movimientos bancarios; el libro sale de la variación de saldo. Desde la 108 el portal no alimenta el libro |
| **Pay-Pros** | Webhook `POST /api/webhooks/paypros/[token]` (guarda el body crudo, verifica firma, siempre responde 200). Saldo: `GET v2/getBalance` | Snapshot 00:00 | `paypros_webhook_events`, `api_transactions`, `channel_balances` | **El webhook nunca recibió un evento**: la URL registrada en Pay-Pros es la del CRM. Los datos reales se proyectan desde `crm_deposits` y `crm_withdrawals` (prefijos `crm:` / `crmw:`), con riesgo de doble conteo si algún día se registra la URL. El parser del saldo acepta el typo `balaces` (`paypros/balance.ts:85-91`). **No se puede confirmar desde el código que el saldo esté roto**: si falla, devuelve `null`, no escribe y avisa `ledger.not_posted` |
| **Trust Wallet / Tron / BSC / ETH** | Tron: `triggerconstantcontract balanceOf` para USDT y TRX. BSC/ETH: `eth_call`. Historial: TronGrid, BscScan, Etherscan. Precios: CoinGecko | Snapshot 00:00 | `channel_balances.meta`, `api_transactions` (`onchain-usdt`, `internal = true`) | «Sin USDT» es 0 y no error. Incidente del 2026-09-04: una wallet GasFree con $29.938 se leía como 0 |
| **Calendario económico MetaQuotes** | `mql5.com/en/economic-calendar` | `propfirm-review` | `economic_calendar_events` | Alimenta la regla de noticias de prop firm |
| **SendGrid** | — | Reportes, creación de período, reset de contraseña y 2FA, aviso de login, invitaciones, órdenes de pago | — | Nunca lanza; devuelve `{success:false}` |
| **Anthropic** | Modelo `claude-opus-5` (`assistant/loop.ts:31`), 16k tokens, hasta 8 vueltas, SSE | Bajo demanda | `ai_chats`, `ai_chat_messages` | Herramientas de sólo lectura sobre Supabase, filtradas por módulo antes de armar el prompt |
| **Sentry** | — | — | — | 10 % de trazas, `captureRequestError`; capturas manuales en el webhook y en el snapshot |

**Resto de crons** (`vercel.json`, región `lhr1`). Todos exigen `Bearer CRON_SECRET` y fallan cerrados si falta.

| Cron | Horario | Qué hace |
|---|---|---|
| `daily-balance-snapshot` | 00:00 | Snapshot de saldos y libro del día anterior |
| `create-new-period` | 00:01 del día 1 | Abre el mes heredando `reserve_pct` (o 0,10) y materializa los egresos fijos |
| Reportes diario / semanal / mensual | 00:05 | Antes de enviar, re-sincroniza si el último sync tiene más de 15 min o falló un proveedor (incidente del 27-04: el reporte dijo $61K y eran $260K) |
| `notification-sweep` | 07:30 | Órdenes aprobadas sin pagar más de 3 días, meses viejos abiertos y alertas del hedge fund |

---

## 3. Reglas de negocio por módulo

### 3.1 Distribución a socios — `src/lib/distribution.ts` (fuente única)

**Fórmula, en orden cronológico obligatorio:**
- `ingresos = round2(brokerPnl + other + propFirmNetIncome + investmentProfits)`
- `saldo = ingresos − egresos`
- **Mes con `saldo ≤ 0`:** `carryDebt += |saldo|`, no se reparte nada y la reserva acumulada **no se drena**.
- **Mes con `saldo > 0`:**
  - primero se cubre `carryDebt`;
  - `reserva = remanente × reservePct` (si viene null, 0,10);
  - `accReserve += reserva`;
  - `montoDistribuir = remanente − reserva`.
- Por socio: `amount = round2(montoDistribuir × pct)` (`socios/page.tsx:258-282`). Se avisa si la suma de los % se aparta de 1 en más de 0,001.

**Qué entra en la fórmula** (`distribution-inputs.ts`):
- `propFirmNet = ventas − retiros de categoría prop_firm`, y esos retiros se **suman**, nunca se pisan con `.set()`.
- Egresos en **base caja** (`paid`) sólo si `features().cashBasisExpenses`, que hoy es sólo el modelo `company`. Si `paid` viene `null`, se usa el devengado. En `broker` es siempre devengado: AP Markets tiene ~$24.900 con `paid = 0`.
- Las inversiones se asignan al período por año y mes de su fecha.
- Neutralización por modelo de negocio: sin `brokerPnl` en el modelo, Broker P&L y Prop Firm entran en 0; sin `investments`, las inversiones entran en 0.
- Prop Firm automático (`crm_monthly_totals`) sólo en períodos abiertos; un valor manual mayor que 0 lo pisa.

**«Cargando» no es «cero»** (incidente del 2026-10-05: el PDF dijo $23.616,52 y eran $263.469,99):
- Cada serie automática lleva su estado (`loading` / `ready` / `failed`).
- `computeCheckedChain` devuelve `null` en el sumando cuya serie no llegó y marca el período `pendiente`, y también todos los posteriores (`heredaIncompleto`).
- Los PDF se deshabilitan mientras alguna serie carga.
- `chain-view.ts` hace que el consolidado dé `null` en lugar de `?? 0` (había 6 lecturas así en `/socios`).

**Snapshot congelado** (`distribution-snapshot.ts`):
- En un mes cerrado, lo congelado reemplaza a lo vivo y se reporta la deriva campo por campo si la diferencia supera 0,01.
- No se compara la deriva de los campos listados en `auto_sources` (131).

**Cierre: RPC `close_period`** (migraciones 061, 111 y 131):
- Rechaza cerrar si hay meses anteriores abiertos (`check_violation`).
- Congela los **insumos**, no el resultado: `broker_pnl`, `other_income`, `prop_firm_sales`, `prop_firm_withdrawals`, `investment_profits`, `total_expenses` (como `sum(amount)`, es decir devengado), depósitos, retiros, `reserve_pct`, `auto_sources` y `frozen_at`.
- Escribe en `audit_logs`. Ejecutable sólo por service_role.
- **131:** acepta `p_overrides`. Los calcula el servidor en `close-auto-inputs.ts`, con las mismas reglas que la pantalla del período abierto. Incidente: Ago-26 congeló $671.000 en lugar de $304.392,24.

**Bloqueo de meses cerrados:**
- Trigger `guard_closed_period` sobre expenses, deposits, withdrawals, operating_income, prop_firm_sales y p2p. Mira el `period_id` nuevo y el viejo.
- `guard_closed_period_by_date` para `investments`.
- `reserve_pct` no se puede cambiar con el mes cerrado (066).

**Reabrir: `reopen_period`.** Exige motivo y lo audita. No borra el snapshot.

**Checklist de cierre** (`period-close-checklist.ts`). Ítems:
- egresos sin comprobante;
- ingresos sin cobrar;
- liquidez sin conciliar;
- órdenes aprobadas sin pagar;
- inversiones `mixed`;
- deriva contra el CRM (sólo métricas de prop firm, con tolerancia absoluta y relativa);
- salto devengado/caja (Horizon Ago-26: −5.365);
- meses anteriores abiertos (**bloqueante**);
- ajuste de FairPay.

Al cerrar se guarda la foto en `period_close_checklists`.

**Corolario sin protección:** como se congelan insumos y no resultados, cambiar `distribution.ts` recalcula retroactivamente todos los meses cerrados.

**Observación propia, sin verificar contra la base:** el snapshot congela `reserve_pct = coalesce(reserve_pct, 0)` (061:97, 111:140), mientras la fórmula en vivo usa 0,10 cuando viene `null`. Un período con `reserve_pct` nulo cambiaría su reserva al cerrarse.

### 3.2 Broker P&L automático — `src/lib/broker-pnl.ts`

- **Regla 1.** Si el período está cerrado, o es anterior al corte `BROKER_PNL_AUTO_DESDE = 2026-08`, manda el número congelado o el manual. El corte responde a «julio ya lo cerramos como estaba».
- **Regla 2.** Período abierto → la serie `crm_daily_pnl`. El corte es por estado del período, no por fecha.
- **Regla 3.** Sin filas, o con todas en `null` → `value: null`, `source: 'none'`, y la pantalla dice «sin datos». Para la cadena, `brokerPnlForChain` cae al manual heredado y **nunca a 0**.
- **Signo.** `crm_daily_pnl.pnl_usd` es el PnL del cliente; se invierte una sola vez. La copia de esa lógica está atada por test a `brokerPnlFromClients`, que no se puede importar porque es server-only.
- **Meses incompletos.** Viajan `daysWithData` y `daysInMonth`: Vex 2025-10 tiene 27/31 días, AP 2026-06 tiene 9/30.
- **Prop Firm automático.** `propFirmAutoForMonth` (`close-auto-inputs.ts:61`): si no hay ninguna de las dos métricas devuelve `null`; si hay una, la otra vale 0. Ventas = `amountPaid`, nunca `price`. P2P = `netAmount` de la pata OUT, sólo de transferencias COMPLETED en `transferp2ps`; las excluidas se cuentan (`crm-monthly.ts`).
- **PDF de mes abierto.** Lleva marca de agua PROVISIONAL, una nota y el nombre de archivo `_PROVISIONAL` (`pdf-provisional.ts`). Motivo: el CRM recalcula hasta 7 días hacia atrás.

### 3.3 Balances — `cash-locations.ts`, `channel-balance-source.ts`, `channel-ledger*.ts`

**Saldos por tipo de ubicación:**
- `isLiquid` es todo menos `loan` y `debt`.
- `signedBalance`: la deuda vale −saldo; es el único lugar que pone el signo.
- `tallyCash` calcula `liquid`, `lent`, `owed`, `gross = liquid + lent` y `total = gross − owed`.
- `allocateShares`: si las partes suman más de 1 se normalizan; si suman menos, el resto queda sin unidad. Lo no asignado cuenta como fondo.
- Una deuda exige `holder`.

**Qué número se muestra:**
- Libro > snapshot > `missing`.
- Coinsbuy se muestra por wallet, más una fila de ajuste si la diferencia es ≥ 0,005.
- Un saldo guardado de más de `STALE_BALANCE_DAYS = 30` días se marca viejo.

**Libro diario automático:**
- `ajuste = cierreReal − (previo + manuales + depósitos − retiros − internas)`.
- Topes por canal: coinsbuy 150k, unipayment y fairpay 25k, paypros 5k, on-chain 50k; el tope se multiplica por los días cubiertos.
- Tras `RECOVERY_AFTER_DAYS = 3` se asienta igual como `regularization`, con aviso crítico.
- `closing = opening + in − out − internal + adjustments`.

**Cadena de balance:** `balanceMes = NetDeposit − egresos − montoDistribuir`. En `company`, los ingresos ocupan el lugar del Net Deposit.

**Net Deposit** (`broker-logic.ts`, `computeDerivedNetDeposit`, fuente única):
- `depósitos = API (sólo wallets operativas) + manual`.
- `retiros = API (Coinsbuy + payouts de Pay-Pros) + manual «broker»`.
- IB, Prop Firm y Otros son informativos.
- Antes de abril de 2026 rige el broker manual (`isDerivedBrokerPeriod`).
- Una transferencia interna (retiro de Coinsbuy con `txid` vacío) no cuenta.

**Snapshot.** Gana la primera escritura del día. Incidente del 2026-08-06: el snapshot se pisó y el cierre quedó inflado en ~$11.700.

### 3.4 Movimientos

- Cada fila cae en una sola categoría, por precedencia: excluida > interna > cuenta > pendiente > rechazada. Un test fija que la suma de lo que cuenta coincide con el total canónico.
- El mes se toma del prefijo de texto de la fecha (con `new Date`, el 1/9 caía en agosto en UTC−3).
- Paginación de 1.000 filas × 20 páginas, con `truncatedSlugs` que llega hasta la UI. `TX_ROW_CAP = 10.000` con `truncated`.
- `channel_configs.is_visible = false` oculta el canal por empresa.

### 3.5 Egresos

- **La trampa de `replace_period_expenses`.** Borra e inserta el período entero con lo que manda el cliente. Una columna nueva tiene que viajar en 4 lugares: `upload/page.tsx`, `mutations.ts`, `api/admin/expenses` y la RPC.
- **Egresos de órdenes de pago.** La RPC filtra en el servidor y de forma simétrica (DELETE e INSERT) las filas con `payment_order_id` (079). Origen: se perdieron $1.700.
- **Huella del período.** `{count, maxUpdatedAt}` de las filas manuales; si cambió, responde 409. Las escrituras pasan por la cola `enqueueExpenseWrite` (Horizon perdió $6.000).
- **Pendiente:** `pending = explícito || round2(amount − paid)`.
- **Estado del egreso:** pagado si `pending ≤ 0,005` y `paid > 0,005`; pendiente si `paid ≤ 0,005`; parcial en el resto.
- **Fijos.** Se materializan el día 1 respetando la vigencia y las plantillas ocultas. `fixed-forward` nunca toca meses anteriores.

### 3.6 Ingresos

- `income_lines`: lo cobrado tiene que ser ≤ facturado + 0,01.
- `replace_income_lines` escribe **lo cobrado** en `operating_income.other`. Preserva el «Otros ingresos (histórico)» manual (073; se perdían $4.900).

### 3.7 Órdenes de pago

- **Estados:** draft → pending o cancelled; pending → approved, rejected, draft o cancelled; approved → paid o cancelled; rejected → draft o cancelled. Sólo se editan draft y rejected.
- **Totales:** los recalcula siempre el servidor: `línea = round2(unitario × cantidad)`, `total = subtotal + fees`.
- **Roles:** preparar = admin, auditor y hr (2026-10-05). Decidir (aprobar, rechazar, pagar, anular algo pending o approved) = admin y auditor (`roles.ts:79-127`). La autoaprobación está permitida (055).
- **Requisitos:** rechazar exige motivo; pagar exige referencia.
- **Al marcar pagada** se crea el egreso en el período de `payment_date`. Si ese mes está cerrado o no existe, va al último abierto con aviso. Si ya existe un egreso con ese `payment_order_id`, se reutiliza.
- **Archivos:** hasta 10 comprobantes (en lote atómico) y hasta 10 respaldos (uno por request); se validan magic bytes; URL firmada de 10 minutos.
- **PDF** con el índice de archivos y el sello PAGADA.
- **Borrar** primero el egreso; un período cerrado da 409.
- **Notificaciones:** pending → admins; approved o rejected → creador.

### 3.8 Comisiones — `src/lib/commission-calculator.ts`

**`calculateCommission`:**
- `division = round2(ND/2)`.
- `commission = round2((division + accIn) × pct/100)`.
- `realPayment = commission`, **sin clamp a 0**: una comisión negativa es deuda.
- `accOut = division`.
- ND = 0 sin cargar → paga 0 y `accOut = accIn`.
- ND = 0 «medido» (fuente CRM, sin nada tecleado) → paga `accIn × pct` y `accOut = 0`. Caso Yudy: $75,99.

**Tramos** (tablas en orden descendente):

| Tabla | Base | Tramos |
|---|---|---|
| Salario BDM | ND individual | ≥200k → 2.000 · ≥100k → 1.000 · ≥50k → 500 |
| Salario head | ND del equipo | 1.000 a 5.000 por escalones de 100k |
| % BDM | ND individual | ≥200k → 6 % · ≥100k → 5 % · ≥50k → 4 % |

**Precedencia del % de un BDM:**
1. `fixed_salary` → su % pactado, sin tramos.
2. Si no → `Math.max(tierPct, profilePct)`: el tramo es **piso, nunca techo**.
3. `nd_pct_fixed` o rol `bdm_global` → sin tramos (128).
4. `pct_override ?? auto`; un 0 tecleado significa «no cobra» (129).

**Diferencial del head:** `diffNaturalDeLinea`:
- natural > 0 → paga el natural;
- natural = 0 → paga `extra_pct`;
- natural < 0 → paga 0.
- `pct_linea` del hijo lo pisa, sin clamp (130).
- Un master IB colgado de `head_id` se vuelve raíz: su subred se corta del BDM.

**Resto del motor:**
- `calculatePnlSpecial` está aislada: `pnl × pct − lotes`, sin acumular.
- `applyTotalEarnedDebt`: `bonus` es la deuda arrastrada y hay que recorrer los meses en orden.
- `prorateFixedSalary`: mes de ingreso = `(díasMes − díaIngreso + 1) / díasMes`.

**Guardado:**
- La fila se identifica por (empresa, perfil, período, `head_id`).
- Guards anti-pisón sólo en el tab Equipos: bloqueo si el total del equipo no cuadra con el padre, y confirmación **con nombres** si un ND guardado quedaría en 0.
- `handleRecalcHistory` reescribe todo con `prevDebt = 0`, sin mirar si el mes está cerrado y sin auditoría.
- Historial y CSV leen lo **guardado**; Equipos, Individual y todos los PDF se calculan **en vivo**.
- Los PDF ya aplican la deuda (`pdf-export.ts:519`); la regla §7 #2 del doc de reglas está desactualizada.

### 3.9 RRHH — net deposit por perfil

RPC `hr_net_deposit_by_profile`, construida en las migraciones 097, 113, 114, 115, 120, 121 y 123:
- Sube la cadena de sponsors hasta el primer perfil de la estructura (máximo 25 saltos); los huérfanos van a `NULL`.
- Llaves canónicas: depósitos `amount_paid` por `deposit_at` con status completed; retiros approved por `processed_at` y por `transaction_amount` (neto de fee; $930 de diferencia).
- Un usuario del CRM mapea a un solo perfil (gana el `created_at` más reciente).
- El árbol se arma con 4 capas en precedencia estricta: username > email (quitando `mail.`) > IDs históricos de `crm_withdrawals` > `hierarchy`.
- `statement_timeout` de 30 s.

Resolución del insumo (`net-deposit-input.ts`): cerrado o anterior a 2026-08 → congelado; manual distinto de 0 → manual; si no, CRM; si no, `null`. Guardar fija el mes.

Otras reglas:
- **Warnings:** la meta es el escalón más alto que no supere el salario; el primer mes calendario está exento; el sistema sugiere y una persona confirma.
- **Despedido** = `status = 'inactive'` **y** `termination_date`. El perfil no se borra y sigue contando para el equipo.
- **Contratos** en un bucket privado, con URL firmada de 10 minutos.
- **IB rebates:** alertas por días desde el último cambio, con umbrales por empresa.

### 3.10 Riesgo

**Score de retiros** (`withdrawal-risk/score.ts`), regresión logística por pesos de evidencia (WoE):
- `logOdds = logit(base) + WoE(rechazos previos) + 0,8 × [WoE(ratio) + WoE(antigüedad) + WoE(neto) + WoE(p2p)]`.
- Calibración `RECENT_6M`: n = 9.785, base 5,10 %; AUC 0,8626.
- Bandas atadas a la base: low si score > 94,90; high si < 82,15.
- Las señales se calculan con lo estrictamente anterior a la solicitud; nunca se mira el futuro.
- KYC, deuda de comisiones y dirección compartida tienen peso 0, porque se midieron y no predicen.
- Staff se reconoce por el dominio `@vexprofx.com`, fijo en el código.
- **El score nunca decide.**

**Cola de retiros** (`query.ts`):
- Solicitados = `REQUESTED`, el más reciente arriba. Instantáneos = comisión de $5, el de menor score arriba.
- Topes: pendientes 500 (**sin flag `truncated`**), instantáneos 1.000, resueltos 500 en 7 días.

**Decisiones:**
- Leer, escalar o dejar pendiente: admin, auditor y soporte.
- Aprobar o rechazar: sólo admin y auditor.
- Rechazar o escalar exige nota. El score se recalcula en el servidor. El evento se escribe antes que el estado.
- La respuesta lleva `executedInCrm: false`: el dashboard nunca ejecuta el retiro en el CRM.

**Prop firm** (`risk/programs.ts`):

| Programa | Pérdida diaria / total | Reglas |
|---|---|---|
| Vex Instant | 3 % / 6 % | duración mínima 5 min, consistencia de lotes entre ×0,25 y ×2, ninguna operación > 30 % del beneficio, grid (≥3 simultáneas), martingala (hueco ≤ 5 min), no operar tras pedir el retiro, 30 días |
| Vex2Pro | 5 % / 10 % | duración mínima 2 min, sin noticias (±5 min), sin fines de semana, mínimo 5 días operados |
| Elite | 3 % / 6 % | 14 días |
| X12 | 10 % / 10 % | grid y martingala permitidos |

- Prohibidas siempre: HFT, copy trading (cobertura ≥ 60 %) y delegar la cuenta.
- Veredicto: hasta 3 operaciones deducibles; operar tras pedir el retiro o 4+ violaciones → `denied_no_new_period`; exactamente 3 → `denied_new_period`.

**Copia** (`copy-detection.ts`): ventana de 30 s, mínimo 5 coincidencias, cobertura ≥ 0,6 medida contra la cuenta más chica, escape con `ESCAPE '~'`. La IP no se usa: una sola IP tenía 164 cuentas.

**Revisión de cuentas:** sólo `hft`, `news_window` y `copy_trading` cuentan para el riesgo (1 señal → medio, 2 → alto). La toxicidad hacia el broker es un eje aparte (mínimo 20 operaciones; si no, `null`).

**Exposición MT5:** importes por familia y en su unidad (centavos aparte), lotes = `Volume / 10.000`, cuenta en riesgo si el nivel de margen está entre 0 y 100 %, sólo cuentas vinculadas al CRM. **Hay dos definiciones de «Cent»**: por moneda (PnL) y por nombre de grupo (exposición y API de socios).

### 3.11 Hedge fund

- Espejo `crm_hf_*` con **barrido completo** (el incremental perdió 6 retiros por $9.536,98).
- Lo que desaparece del CRM no se borra: se cuenta como `unseen`.
- Comisiones 0/0/0 en AP Markets: un fingerprint de los niveles detecta cambios y deja snapshot, audit log y notificación.
- Rótulo por empresa (`hedge_fund_label`: «Vex Capital»).
- El capital sale de `hedgefundinvestments.balance` (`totalAmountByHedge` vale 0 para todos).
- No entra en balances ni en la distribución.
- Datos de prueba excluidos por clave exacta y contados.
- El espejo se considera viejo a las 24 h.

### 3.12 Liquidez y pool

- **`liquidity`**: conciliación de Vex. Un split tiene que sumar exactamente el original.
- **`liquidity_pool`**: vive en Exura Liquidez (`onlyWhereActivated`). Reglas L1–L7 de `reglas-del-proyecto.md` §3.2.
- **Equity a la fecha de conexión:** `balance_hoy − Σ(Profit + Storage + Commission)`.
- **Detector de duplicados**, 4 escenarios: cliente nuevo; cuenta previa en cero (la vieja queda superada); transferencia detectada (se resta de la vieja); varias cuentas sin transferencia (aviso).
- **Inversiones:** `balance = Σ(depósito − retiro + profit)`; el rendimiento es `null` sin capital positivo.

### 3.13 Forecast

- Promedio de los últimos 3 meses cerrados.
- Escenarios 0,8 / 1 / 1,2, aplicados sólo a ingresos.
- Pasa por `computeDistributionChain`, la misma fórmula que el reparto real.

### 3.14 Reportes por modelo de negocio — `business-model.ts`

| Modelo | Qué tiene |
|---|---|
| `broker` | Todo, salvo pool, `incomeLines` y base caja |
| `company` | Sólo `incomeLines`, base caja y contabilidad; su reporte propio está en `reports/company-report.ts` |
| `liquidity_provider` | Sólo pool e inversiones; no participa de la cadena ni recibe el reporte diario |

`blockedModules`, `blockedReportSections` y `blockedConsolidatedColumns` se derivan todos de `features()`.

### 3.15 Multitenancy y permisos

- **Leer lo decide el módulo; escribir lo decide el rol** (`api-auth.ts`, `puedeLlamarRuta`).
- Tres casos en que no se relaja el rol: `requireAdmin`; ruta sin módulos declarados; llamada sin método.
- **Orden de `canAccessModule`** (`modules.ts`):
  1. modelo de negocio, que bloquea incluso al superadmin;
  2. `onlyWhereActivated`;
  3. superadmin;
  4. reservados (`audit`, `settings`);
  5. `upload` sólo para roles que escriben;
  6. admin, o `allowed_modules`;
  7. `active_modules`.
- **Roles que escriben:** admin, auditor, hr. Finanzas = admin + auditor; RRHH = admin + hr.
- **Sello 2FA** también en `/api`.
- `company_id` sale siempre del token. El superadmin puede pasar `?company_id=` sólo en el query string.
- Con el admin client hay que poner `.eq('company_id', …)` en toda query; el spread del body va antes del `company_id`.
- En el cliente, `apiFetch()` y no `fetch` directo.
- «Viewing-as» se recuerda en localStorage (`active-company.ts`).
- Módulos con los que nace una empresa: `DEFAULT_ACTIVE_MODULES`.

### 3.16 Dinero en pantalla — `src/lib/money.ts`

- El signo va antes del símbolo, `round2` antes de formatear, nunca «-$0.00».
- `null` no se formatea: el llamador decide qué mostrar.

---

## 4. Lo que no se puede perder: 30 reglas pagadas con bugs

| # | Regla | Incidente | Dónde |
|---|---|---|---|
| 1 | Una sola fórmula de distribución | `/balances` y `/socios` daban números distintos (BUG-01) | `distribution.ts`, `distribution-contract.test.ts` |
| 2 | Cerrar congela lo que se veía (overrides del CRM) | Ago-26 congeló $671.000 contra $304.392,24 | mig 131, `close-auto-inputs.ts` |
| 3 | «Cargando» o «falló» no es 0 | PDF de socios con $0 contra $263.469,99 | `distribution-inputs.ts:22-60` |
| 4 | Sin serie del CRM: `null` en pantalla, el manual en la cadena, nunca 0 | — | `broker-pnl.ts` regla 3 |
| 5 | Cerrar en orden cronológico | El arrastre de un mes «cerrado» seguía moviéndose | mig 111 |
| 6 | PDF de mes abierto = PROVISIONAL | Sep +294,60 tras enviarlo | `pdf-provisional.ts` |
| 7 | Comisión negativa sin clamp | — | `commission-calculator.ts` |
| 8 | ND = 0 conserva el acumulado; el cero medido lo consume | $50.000 borrados; Yudy cobró $0 en vez de $75,99 | `:43-56` |
| 9 | El tramo es piso (`Math.max`) | 7 % pactado cobrando 5 % | `:331` |
| 10 | `nd_pct_fixed` y `pct_override` (el 0 significa 0) | Ana García al 6 % en vez del 4 % | migs 128 y 129 |
| 11 | Diferencial del head nunca negativo; extra sólo con natural = 0 | Al head se le restaban $1.000 | `:451` |
| 12 | `bonus` es deuda; guardar Equipos no la pone en 0 | A3 #4 | `comisiones/page.tsx:2167` |
| 13 | Un usuario del CRM, un solo perfil; árbol de 4 capas; retiros por `transaction_amount` | +$3.140,79; $930 | migs 114, 120, 121 |
| 14 | `replace_period_*` es atómico: nunca dos llamadas HTTP | Egresos de VexPro mayo vaciados | mig 043 |
| 15 | El filtro de egresos de órdenes de pago va en el servidor y es simétrico | $1.700 perdidos | mig 079 |
| 16 | Huella del período y 409 ante pestaña vieja | Horizon perdió $6.000 | `huella-periodo.ts` |
| 17 | Base caja sólo donde el registro lo dice | AP Markets se habría inflado ~$24.900 | `distribution-inputs.ts` |
| 18 | Wallets internas fuera del Net Deposit | Retiros $932k contra $469k | mig 084 |
| 19 | Exclusiones manuales dentro de la RPC | $319.866,35 en el Net Deposit | mig 109 |
| 20 | El snapshot diario no se pisa (gana la primera escritura) | +$11.700 en el cierre | `daily-balance-snapshot` |
| 21 | El libro se auto-regulariza después de 3 días | Libro congelado 10 días, $91.756 de brecha | `channel-ledger-sync.ts:65` |
| 22 | Con la API caída se muestra el último saldo marcado, nunca $0 | Coinsbuy en $0 con $244.079 reales | `channel-balance-source.ts:161` |
| 23 | Cuenta MT5 que no está en el CRM no entra a ninguna cifra, y se cuenta | PnL de 6.198 inflado a 12.836 | `crm-sync/account-scope.ts` |
| 24 | MT5: `TimeMsc` contra fechas, `Action IN (0,1)`, `ESCAPE '~'`, `mt5DateUtc` | 68 M de filas; 425 M de depósitos como PnL; PropFirm desaparecía | `mt5-sync/pnl.ts`, `copy-detection.ts` |
| 25 | Nunca sumar dinero entre familias (centavos) | 101 M contra 7,6 M reales | `exposure.ts` |
| 26 | Sync del CRM: barrido completo diario, cursor `$gte` con solape | 6 retiros perdidos ($9.536,98) | `sync-crm/route.ts:26-52` |
| 27 | Depósitos por `amountPaid`, retiros por `requestedAmount`, ventas de prop firm por `amountPaid` | `depositValue` corrupto (1,4e16) | `normalize.ts` |
| 28 | Toda lista con tope lleva flag `truncated` hasta la UI | 2.078 filas devolvían 1.000 | `persisted-movements/route.ts` |
| 29 | Un registro único por módulo, rol, canal y categoría | `ib_rebates` se descartaba al guardar; 8 de 16 roles daban 400; 5 listas de canales | `modules.ts`, `roles.ts`, `api-channels.ts` |
| 30 | Leer = módulo, escribir = rol; segregación preparar/decidir y soporte/auditor | Sergio sin acceso con 6 módulos marcados | `roles.ts`, `api-auth.ts` |

Dos más:
- **Credenciales sin fallback a variables de entorno**, por la fuga entre empresas del 2026-05-01.
- **Anclar el valor inicial antes de encender un detector**: Atlas disparó 45 traspasos falsos.

---

## 5. Deuda y lo que no conviene migrar tal cual

1. **Drift de esquema.** 18 tablas y varias columnas no tienen DDL (`head_id`, `periods.reserve_pct`, `equity`, la 062). Faltan las migraciones 080, 094 y 107, y hay dos 129. Con sólo `supabase/` no se reproduce producción.
2. **Secretos TOTP en claro.** `company_users.twofa_secret` es legible por cualquier miembro de la empresa vía PostgREST.
3. **`companies_update` sin control de rol** (022/027): cualquier miembro puede cambiar `active_modules` y `business_model`. Además, `companies_insert` lo puede hacer un admin de cualquier empresa.
4. **`auth_is_hr_reader` sin filtro de empresa.**
5. **Grants de RPC no blindados.** `scripts/check-rpc-grants.ts` no corre en CI; un DROP + CREATE reabre `EXECUTE` a PUBLIC.
6. **Las alertas por email nunca se envían.** 10 tipos de notificación tienen `email: true`, pero `notify()` sólo escribe en la bandeja.
7. **Webhook de Pay-Pros sin eventos.** El saldo de Pay-Pros no se puede dar por roto desde el código; hay que revisar `notifications` y los logs.
8. **Orion REST** se sigue llamando aunque sus endpoints no existen. También quedan endpoints sin caller: `/api/integrations/coinsbuy/*`, `/unipayment/transactions`, `/fairpay/transactions`, `/send-email` y `/superadmin/withdrawal-analytics`.
9. **`env.ts` muerto y en conflicto con `crypto.ts`** sobre el formato de la master key.
10. **Truncamientos sin aviso.** `PENDING_MAX` (500) en la cola de retiros; Coinsbuy `MAX_PAGES = 20` (2.000 transferencias); PostgREST corta en 1.000 filas.
11. **`handleRecalcHistory`** reescribe el histórico con `prevDebt = 0`, sin verificar cierre y sin auditoría. Los guards anti-pisón existen sólo en el tab Equipos.
12. **Cierre devengado contra caja** en el modelo `company`; el checklist lo avisa pero no lo corrige. Se suma el `coalesce(reserve_pct, 0)` de §3.1.
13. **Duplicados que quedan:**
    - dos parsers de fecha de MT5;
    - dos técnicas de escape de la barra;
    - dos definiciones de «Cent»;
    - `round2` local en `reports/company-report.ts:37`;
    - umbrales 3/4 de prop firm escritos a mano;
    - dominio `@vexprofx.com` fijo en el código.
14. **El asistente casi nunca muestra score de pendientes.** Ningún cron escribe `withdrawal_reviews`; sólo la escribe el POST de decisión.
15. **Borrar una cuenta del pool no restaura** el `balance_liquidez` de la cuenta vieja (sin verificar).
16. **Legado:**
    - tablas `broker_balance`, `financial_status`, `preoperative_expenses`;
    - columnas `payment_proof_*`;
    - `coinsbuy-deposits.ts` y `unipayment.ts` de la raíz de `api-integrations`;
    - 4 tablas de backup;
    - `ARCHITECTURE.md` y `CI_WORKFLOW.md` desactualizados.

---

## 6. Números

| Métrica | Valor |
|---|---|
| Líneas en `src` (`.ts`/`.tsx`) | 186.798 |
| Endpoints (`route.ts`) | 147 |
| Pantallas (`page.tsx`) | 52; 39 dentro de `(dashboard)` |
| Migraciones | 129 archivos `migration-*.sql` más `schema.sql` |
| Tablas | 77 con DDL + 18 sin DDL (+ 4 backups) |
| Tests | 166 archivos, **2.617 tests** pasando (Vitest 4.1.8). RRHH y comisiones: 344. Además hay 8 specs e2e de Playwright |
| Módulos registrados | 22 en `MODULE_DEFS` |
| Roles | 6 |
| Crons | 22 entradas sobre 12 rutas |

**Endpoints por área:**

| Área | Cantidad |
|---|---|
| `admin/*` | ~67 |
| `superadmin/*` | 28 (liquidity 9, companies 9, users 3, probes 4, tokens, analytics, egress-ip) |
| `cron` | 12 |
| `auth` | 10 |
| `integrations` | 11 |
| `reports` | 4 |
| `partner/v1` | 2 |
| `risk` | 2 |
| `assistant` | 2 |
| `send-email` | 2 |
| `webhooks`, `notifications`, `user`, `health`, `bootstrap`, `balances` | 1 cada uno |

**Líneas por zona:**

| Zona | Líneas |
|---|---|
| `app/api` | 25.426 |
| `components` | 18.052 |
| `lib/api-integrations` | 11.488 |
| `rrhh` (pantalla) | 7.870 |
| `lib/risk` | 6.017 |
| `upload` | 5.982 |
| `risk` (pantalla) | 5.586 |
| `lib/reports` | 5.400 |
| `lib/crm-sync` | 5.389 |
| `balances` | 5.109 |
| `comisiones` | 4.727 |
| `finanzas` | 4.402 |
| `lib/hr` | 4.330 |
| `lib/payment-orders` | 3.550 |
| `superadmin` | 3.003 |
| `ordenes-pago` | 2.783 |
| `lib/assistant` | 2.243 |
| `lib/hedge-fund` | 2.222 |
| `lib/withdrawal-risk` | 2.215 |
| `movimientos` | 2.193 |
| `socios` | 1.489 |
| `lib/mt5-sync` | 1.437 |
