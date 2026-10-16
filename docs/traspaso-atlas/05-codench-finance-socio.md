# Informe: Codench Finance (CorredorManuel/contabilidad)

**En síntesis:** el modelo de datos es más amplio que lo que está construido. Tiene 46 tablas. Las partes realmente terminadas son el dashboard, la facturación (PDF, link público, email con recordatorios), el control de nómina, la conciliación por saldo, cripto FIFO y el TRM. Varias reglas que el README declara se contradicen en el código:
- **Borrados físicos:** los movimientos confirmados, las facturas y la nómina se borran de verdad, no se reversan.
- **Reverso con impacto doble:** reversar un movimiento cambia el resultado en el doble del monto en vez de dejarlo en cero.
- **Permisos sin aplicar:** la tabla de permisos se carga pero el código nunca la consulta.
- **Importación de Excel desde la web:** no mapea nada, manda cada fila a revisión.
- **Presupuestos:** solo existe crear; no hay lectura, comparación ni pantalla.

Rutas relativas a `repo/`. El clon tiene un solo commit (`6fb2d07`, 2026-10-03), así que no se puede ver historia. No ejecuté nada.

---

## 1. Inventario

### 1.1 Tablas

El README:7 dice «43 tablas», pero el número no coincide con el código:
- `app/models.py` define **46 tablas**.
- La migración inicial `e5d6be4702e7` crea 42.
- Tres migraciones posteriores agregan las otras 4: `invoice_profiles` (f6a4c9d1e210), `invoice_public_links` (e82c1a79d421), `email_templates` e `invoice_email_reminders` (a19c4f6e8d20).
- Contando `alembic_version`, son 47.

En total hay 11 migraciones. Todas las tablas usan UUID `BINARY(16)`, dinero `Numeric(24,8)` y cantidades cripto `Numeric(36,18)` (models.py:15-46).

| Dominio | Tabla | Propósito / campos clave | ¿Se usa? |
|---|---|---|---|
| Identidad | `organizations` | name, slug, base_currency=USD, fiscal_year_start_month | sí |
| | `users` | email, password_hash, language, totp_secret, two_factor_enabled, last_login_at | sí |
| | `roles` / `permissions` / `role_permissions` | 7 roles, 8 permisos (bootstrap.py:15-42) | los permisos **solo se cargan, nunca se consultan** |
| | `organization_memberships` | user↔org↔role, único (org, user) | sí |
| | `sessions` | token_hash, expires_at, revoked_at | sí |
| | `audit_events` | action, entity_type, entity_id, payload JSON | se escribe; **no hay endpoint ni pantalla para leerlo** |
| Catálogos | `currencies` | USD, COP, EUR | seed |
| | `exchange_rates` | (org, rate_date, from, to) único, rate `Numeric(24,10)`, source | sí |
| | `financial_categories` | type income/expense/**transfer**, parent_id, color | sí |
| | `contacts` / `contact_roles` | tax_id único por org; roles client/vendor/worker | sí |
| | `services`, `contracts` | precio, vigencia, frecuencia | **sin endpoints** |
| Núcleo | `financial_accounts` | type bank/cash/card/crypto, currency, opening_balance | sí |
| | `transactions` | recognition_date, payment_date, type, original_amount, original_currency, exchange_rate, base_amount, status, source, import_row_id, reversed_transaction_id | sí |
| | `transfers` / `transfer_legs` | pata out/in con amount, currency, rate, base | solo API, **sin pantalla** |
| | `reconciliations` | statement_balance, book_balance, difference, note, recorded_by, status | sí |
| | `reconciliation_items` | match transacción↔corte | solo se borra en `remove_transaction` |
| | `budgets` / `budget_lines` | año + (categoría, mes, monto) | solo POST |
| Facturación | `invoices` | external_id, issue/due, currency, subtotal, tax, adjustment, total, balance_due, status, issuer_snapshot, payment_instructions | sí |
| | `invoice_lines` | qty, unit_price, total, sort_order | sí |
| | `invoice_payments` | amount, currency, rate, base, transaction_id | sí |
| | `invoice_profiles` | prefijo, next_number, padding, default_due_days | sí |
| | `invoice_public_links` | token_hash, expires/revoked, view_count | sí |
| | `email_templates`, `email_deliveries`, `invoice_email_reminders` | plantillas por (org, key, idioma); evidencia de envío; dedupe (invoice, template, día) | sí |
| Nómina | `payroll_periods` (org, año, mes único), `payroll_payments` (worker, original, currency, rate, base, status, transaction_id único) | | sí |
| | `payroll_payment_items` | conceptos | **nunca se escriben**, solo se borran |
| Cripto | `crypto_assets`, `crypto_wallets`, `crypto_trades`, `crypto_lots`, `crypto_lot_consumptions`, `crypto_price_snapshots` | | sí |
| Import | `import_batches`, `import_rows` (raw_data / normalized_data JSON), `review_queue_items` | | sí |
| | `documents` | storage_key, sha256, entity polimórfica | solo upload |
| | `notification_rules`, `notifications` | | **sin uso** |

### 1.2 Endpoints

Hay 85 endpoints de negocio (83 en `routes.py`, 2 en `exports.py`) y 6 de sistema (`main.py`). Todos los de negocio llevan el prefijo `/api/v1`.

| Grupo | Rutas (verbo) | Qué hace |
|---|---|---|
| Auth | POST login, logout · GET me · POST 2fa/setup, 2fa/verify | JWT en cookie más fila en `sessions` |
| Usuarios (admin) | GET/POST /users · PUT /users/{id} · PATCH /users/{id}/status | |
| Dashboard | GET /dashboard/summary | KPIs, flujo, cartera, nómina, cripto, alertas (routes.py:397-837) |
| Cuentas / categorías / contactos | GET, POST, PUT /{id}, PATCH /{id}/status | |
| Movimientos | GET, POST · PUT /{id} · **DELETE /{id}** · PATCH /{id}/status · POST /{id}/reverse | |
| Transferencias | POST /transfers | |
| Conciliación | GET /reconciliations/summary · GET y POST /reconciliations | |
| Facturas | GET/PUT /invoice-profile · GET/POST /invoices · POST /invoices/generate · PUT /{id} · PUT /{id}/document · **DELETE /{id}** · PATCH /{id}/status · POST /{id}/payments · POST /{id}/duplicate · GET /{id}/document · GET /{id}/pdf · GET/POST /{id}/share · DELETE /{id}/share/{link} | |
| Factura pública | GET /public/invoices/{token} · GET /public/invoices/{token}/pdf | sin autenticación |
| Email | POST /invoices/{id}/email · GET /{id}/email-history · GET /email/config-status · CRUD /email-templates (el DELETE desactiva) · GET /email-deliveries · POST /email/reminders/run | |
| Nómina | GET, POST /payroll · PUT · DELETE · PATCH /{id}/status | |
| Cripto | CRUD /crypto/wallets · GET /crypto/positions · GET, POST /crypto/prices · POST /crypto/prices/refresh · GET, POST /crypto/trades · PUT /crypto/trades/{id} | |
| TRM | GET /exchange-rates/suggestion · POST /exchange-rates | |
| Presupuestos / reportes | POST /budgets · GET /reports/profit-loss · GET /reports/export · GET /exports/{resource} (11 recursos) | |
| Import / revisión / docs | POST /imports/spreadsheet · GET /review-queue · PATCH /review-queue/{id} · POST /documents | |
| Sistema | /, /health, /health/database, /openapi.json, /docs, /redoc | todos con autenticación salvo /health |

### 1.3 Pantallas (`apps/web`, Next 16.3.4, React 19.3)

| Ruta | Muestra | Acciones |
|---|---|---|
| /login | email, contraseña, campo OTP opcional | login |
| /dashboard | Resumen financiero; flujo de caja; facturas: estado, antigüedad, velocidad de cobro, «De lo emitido a lo cobrado»; concentración de ingresos; gastos por categoría; «Qué impulsó o redujo el resultado»; nómina; saldos; alertas accionables | filtros y drill-down a movimientos |
| /transactions | tabla con filtros por estado, cuenta, contacto, categoría, moneda, operativo y tipo de fecha | crear, editar, duplicar, cambiar estado, **borrar permanente**. **No hay botón de reversar.** |
| /accounts | saldos por cuenta y CRUD | |
| /reconciliations | corte por fecha, saldos observados, comparación, «Dónde revisar primero», historial del descuadre | registrar corte en lote |
| /invoices, /invoices/new, /invoices/[id], /invoices/[id]/edit | lista, builder de líneas, documento, share, email, PDF | duplicar; marcar pagada o parcial (crear ingreso o no) |
| /invoice-view/[token] | vista pública bilingüe con PDF | |
| /payroll | control mensual | marcar pagado (crear egreso o no), borrar |
| /crypto | posiciones y operaciones | comprar, vender, refrescar precios |
| /categories, /contacts, /users | CRUD | |
| /review-queue | filas con raw y normalized | resolver o descartar |
| /reports | Excel consolidado y detalle de movimientos | |
| /settings y subpáginas invoices, email-templates, email-deliveries | | Las tarjetas «Importar Excel», «Documentos» y «Seguridad» llevan a `#` y están deshabilitadas (settings/page.tsx). |

**No tienen pantalla:** transferencias, presupuestos, documentos, importación web, configuración de 2FA, carga de TRM, auditoría, servicios y contratos.

---

## 2. Reglas de negocio (con fuente)

### Reverso de movimientos confirmados y borrados
- **Lo que se declara:** «se reversan; no se borran» (README.md:51; product-scope.md:37).
- **Cómo funciona el reverso:** `POST /reverse` (routes.py:1052-1066) exige `status == "confirmed"` y no deja reversar movimientos de cripto. Crea una transacción copia con el tipo opuesto, `description="Reversal: …"` y `reversed_transaction_id`. El original pasa a `status="reversed"` y se desvincula de nómina (1063), pero **no de `invoice_payments`**.
- **Lo que de verdad pasa con los borrados:**
  - `DELETE /transactions/{id}` (1021-1028) es un borrado físico, salvo `source == "crypto"`.
  - `DELETE /invoices/{id}` (1841-1858) borra links, líneas, pagos y los movimientos `source="invoice"`.
  - `DELETE /payroll/{id}` (2045-2073) borra el egreso automático (`source="payroll"`) y conserva el manual (está documentado en data-model.md:77).
  - El PUT permite editar movimientos confirmados (1031-1039).

### Transferencias internas fuera del P&L
Hay **dos mecanismos que conviven**:
- **Por categoría:** las categorías `type="transfer"` se excluyen con `operating_transaction_condition` (accounting.py:11-21). Ese filtro se aplica en el dashboard (routes.py:418) y en el export del P&L (exports.py:384). Es lo que usa el legacy (import_legacy.py:270) y lo que prueba el test.
- **Por patas:** `POST /transfers` crea `transfers` más dos `transfer_legs` con `exchange_rate = amount/base_amount` (routes.py:1076-1077). No tiene campo de comisión, aunque scope:33 la pide. Las patas **solo cuentan en el saldo de conciliación** (185-201); el saldo del dashboard las ignora (634-657).

### COP: valor original, TRM y equivalente USD
- **Convención:** `exchange_rate` = COP por USD; `base_amount = original / rate` (schemas.py:84-88). El usuario puede mandar `base_amount` a mano y no se valida contra la tasa.
- **De dónde sale la TRM:** `fetch_official_trm` consulta datos.gov.co, dataset `32sa-8pi3` (Superfinanciera), por rango de vigencia, con `lru_cache(512)` en memoria (trm.py:13-64). **No se guarda** en `exchange_rates`. Si la API falla, usa la última tasa guardada con fecha menor o igual, invirtiendo el par si hace falta (routes.py:2376-2447).
- **El legacy** usa la tasa *mensual* de la hoja TASAS, fechada el día 1 (import_legacy.py:200-208, 262).
- **No hay recálculo:** el `base_amount` queda fijo al escribirse y no existe revaluación.
- **Las cuentas COP** se pasan a la moneda de la cuenta con `base × rate` (routes.py:143-157).

### Cripto FIFO (routes.py:2304-2338)
- **Compra:** crea un lote con `unit_cost = (qty·price + fee)/qty`; la comisión se capitaliza en el costo.
- **Venta:** toma los lotes con `remaining > 0` del activo, ordenados por `acquired_at`, con `FOR UPDATE`. Si la cantidad disponible no alcanza, devuelve 400. El ingreso por unidad es `(total − fee)/qty`. Por cada lote consumido guarda cantidad, costo, ingreso y profit en `crypto_lot_consumptions`, y el total va a `realized_profit_usd`.
- **Contrapartida de caja:** genera una transacción `investment_buy`/`investment_sell`, `source="crypto"`, sin categoría, y exige que la cuenta de caja sea **en USD** (2308).
- **El FIFO no separa por wallet** (2318 no filtra por wallet).
- **Ediciones:** las ventas no se pueden editar; las compras solo si el lote está intacto (2347-2351). No hay borrado ni depósitos o retiros.
- **Posiciones** (2205-2245): cantidad y costo salen de los lotes; el precio es el último snapshot de la organización o global; el no realizado es mercado − costo.
- **Precios:** CoinGecko con caché de 5 minutos por organización (2257-2278), o carga manual.
- El realizado **no entra al P&L**.

### Facturación
- **Numeración:** `prefix + zfill(next_number)`, con bloqueo del perfil y salto de números ya usados (1285-1309). La unicidad (org, external_id) se aplica en la migración b71f02e4c995.
- **Totales:** se redondean por línea a 0,01 HALF_UP, y total = subtotal + tax + adjustment > 0 (invoice_documents.py:27-40). Se congela `issuer_snapshot` al emitir (1493).
- **Pagos parciales:** el PATCH status (1874-1961) registra el pago, crea opcionalmente el ingreso (categoría «Invoice Mensual», si no «Client revenue», si no la crea) y recalcula `balance_due` y el estado. Una edición no puede dejar el total por debajo de lo ya pagado (1866, 1613).
- **`POST /payments`** (1964-1973) **no crea ni vincula movimiento**.
- **Facturas recurrentes: no existen.** Solo hay «duplicar»: crea un borrador con fecha de hoy y vencimiento a `default_due_days` (1503-1531).
- **Vista pública:** token `secrets.token_urlsafe(48)`; se guarda solo el SHA-256; vence en 1-365 días (30 por defecto); es revocable; crear uno revoca los anteriores; solo para facturas emitidas o pagadas; lleva headers no-store y noindex (1341-1391, 1552-1605).

### Nómina (2007-2172)
- Estados `pending` / `paid` / `cancelled`. Se crea siempre como pendiente, y el contacto debe tener rol `worker`.
- Al marcar pagada se elige crear el egreso o no.
- **Detección de duplicados:** antes de crear el egreso busca un gasto confirmado de igual moneda e igual monto original, con base ±0,01, contacto nulo o igual, dentro de ±7 días o del mes, que no esté ya vinculado a nómina ni a factura. Si lo encuentra devuelve 409 (1976-2004, 2121-2125).
- No deja cambiar el estado si ya tiene movimiento vinculado (2104).
- No es liquidación legal (scope:17).

### Presupuestos
Solo existe `POST /budgets`. Las líneas son `dict` libre (schemas.py:295) y no se valida la categoría (routes.py:2455-2460). No hay comparación real contra presupuesto ni pantalla, y no tiene las versiones ni las dimensiones que describe scope:39.

### Conciliación (1083-1263)
Compara el **saldo observado ingresado a mano** contra el **saldo en libros**. El saldo en libros es: apertura + movimientos confirmados con fecha de caja ≤ corte (signo positivo para income e investment_sell) ± patas de transferencia. Si |diferencia| ≤ 0,01 queda `balanced`, si no `open`. Es un upsert por (cuenta, fecha), con auditoría del valor anterior. No concilia movimiento contra movimiento (`reconciliation_items` no se usa) y no toca transacciones.

### Importación de Excel
- **Web** (2526-2543): cada fila de cada hoja se convierte en `import_row` y en un ítem de revisión con «Pending field mapping and validation». No mapea ni detecta duplicados. Resolver un ítem solo cambia su estado (2501-2523); no crea registros.
- **CLI `import_legacy`:** está escrito para *un* libro concreto (hojas TASAS, CONFIG, CLIENTES, NOMINA, TRANSACCIONES, FACTURAS…).
  - Duplicados por archivo: SHA-256 en `source_type` (120-127).
  - Duplicados de factura: clave (número, fecha, monto) (291-292).
  - Alias de contactos hardcodeados (30-41).
  - Corrección manual de una factura (43-46).
  - Las anomalías (fecha, cuenta, TRM o monto faltantes, estado desconocido) van a revisión; las hojas auxiliares quedan `ignored`, sin revisión (332-339).
- **`reconcile_legacy_import`** reabre filas y **marca como resueltos en masa** los ítems abiertos restantes (reconcile_legacy_import.py:261-263).

### Documentos
Solo upload a disco local, con SHA-256 y metadatos (2546-2551). No hay listado, descarga, permisos ni límite de tamaño.

### Reportes y exportes
- **P&L:** solo por **fecha de reconocimiento**, agrupado por **categoría**, y deja afuera los movimientos sin categoría (2463-2466).
- **Export consolidado:** resumen, P&L, movimientos, facturas, nómina y cripto (exports.py:366-405).
- **11 exports por recurso**; los de usuarios y emails son solo para admin (357).
- Hay protección contra inyección de fórmulas con `=`, `+`, `-`, `@` (43-45).

### Roles: quién ve qué (por código)
La autorización se decide **solo por `role_key`** (dependencies.py:60-65):
- `write_roles` = admin, finance.
- `management_roles` = admin, finance, management, **external_accountant**: dashboard, movimientos, facturas, **nómina**, cripto, exportes (routes.py:46-48).
- **operations y read_only** no figuran en ningún `require_roles`. Solo ven contactos y categorías y pueden subir documentos.
- **support** («aislado»): también lista **todos los contactos** (incluidos trabajadores) y categorías, y sube documentos (923, 873, 2547).
- La nómina no tiene permiso propio, y el dashboard trae `payroll_analysis` a management y al contador.

### 2FA y sesiones
- TOTP con ventana ±1, y solo si el usuario ya lo activó (219). **No es obligatorio** para admin ni finance (contradice scope:57).
- Las sesiones se revocan con logout, cambio de contraseña o desactivación del usuario (237, 373, 391). No hay listado de sesiones ni «cerrar las otras».
- El JWT HS256 se valida además contra el hash guardado en `sessions` (dependencies.py:44-46).

### Plantillas y entregas de email
- 6 plantillas por defecto (invoice_sent, due_soon, overdue × en/es) con `{{var}}`; los valores se escapan en HTML (email_service.py:20-67).
- La entrega es SMTP con su registro en `email_deliveries`.
- **Recordatorios:** un loop dentro del proceso API, en los días configurados (7, 3, 1, 0, −1, −3, −7). Usa un registro de dedupe por día, y **cada envío genera un link público nuevo** (main.py:19-27; routes.py:1758-1821).

---

## 3. Madurez y tests

Hay **20 tests en 12 archivos**, con unittest y sin CI:
- **11 unitarios:** TRM (2), conversión de conciliación (3), cálculo de base (2), totales y PDF de factura (2), render y SMTP de email (2).
- **9 de integración** contra la base que esté configurada (`SessionLocal`), envueltos en rollback: categorías (1), cripto end-to-end (1), dashboard (2), exportes (1), duplicar factura (2), nómina (1), usuarios (1).
- Uno depende de **datos reales**: la factura «5215» de BridgeMarkets (test_dashboard_regression.py:56-70).

| Implementado y probado | Implementado sin tests | Esqueleto o solo schema |
|---|---|---|
| Exclusión de transferencias en dashboard y P&L; FIFO con venta parcial y total; egreso de nómina con dedupe y borrado; duplicar factura; exportes; usuarios; parser de TRM | Reverso, transferencias por patas, pagos y estados de factura, links públicos, emails y recordatorios, conciliación (endpoint), importación, revisión, 2FA, aislamiento por organización (salvo un caso del dashboard) | Presupuestos, documentos, servicios y contratos, notificaciones, auditoría consultable, permisos atómicos, conceptos de nómina, conciliación por ítem |

---

## 4. Qué aporta y qué es redundante

**Candidatos (lo que un panel de broker típico no tiene):**
1. Movimiento multimoneda con original + TRM oficial colombiana + USD, sugerida por fecha y editable.
2. Conciliación por cortes: saldo observado contra libros, historial del descuadre y priorización de cuentas.
3. Facturación propia: numeración con perfil, snapshot del emisor, PDF bilingüe, link público tokenizado y revocable con conteo de vistas, plantillas de email y recordatorios con dedupe.
4. Control de nómina separado de la liquidación, con «crear egreso o solo marcar» y detección de un gasto ya cargado.
5. Tesorería cripto con lotes FIFO y caja vinculada.
6. Importación con preservación del raw por fila y cola de revisión.
7. Analítica de cobranza: aging en 5 tramos, días de pago (promedio y mediana), tasa de cobro, concentración de clientes, comparación contra el período anterior y granularidad día/semana/mes adaptativa.

**Redundante** con cualquier plataforma que ya tenga cuentas, movimientos y facturación: organizaciones y membresías, usuarios, roles y sesiones, contactos, cuentas, categorías, CRUD de movimientos, tabla de auditoría y exportes genéricos a Excel.

**Dato de contexto:** entre los clientes de Codench aparecen «Horizon VIP Consulting FZCO», «AP Markets», «BridgeMarkets LTD» y «Be Prime Group Ltd» (import_legacy.py:30-41).

---

## 5. Riesgos y errores de diseño

**Dinero y lógica:**
1. **El reverso tiene impacto doble.** La copia hereda `status="confirmed"` (routes.py:1057-1061) y el original sale de los totales como `reversed`. Un ingreso de 100 reversado deja −100 en el dashboard y en el saldo. En el P&L, que agrupa por categoría sin mirar el tipo (2465), el ingreso **sigue sumando 100**.
2. **TRM 1 por defecto en pagos de factura** (schemas.py:234; routes.py:1897; la UI también pone 1): un pago en COP sin TRM queda con USD = monto en COP. Lo mismo en `TransactionCreate` (schemas.py:81).
3. **El dashboard mezcla monedas:**
   - el saldo por cuenta suma USD a la apertura en moneda nativa e ignora las patas de transferencia (routes.py:652-657);
   - lo facturado y la cartera suman `total` y `balance_due` nativos, mientras lo cobrado va en USD, y la tasa de cobro combina ambos (478-486, 541, 552, 803).
4. **La factura queda «pagada» aunque se reverse o borre su movimiento:** `remove_transaction` solo anula el vínculo (136) y el reverso no toca `invoice_payments`. Además, `/payments` no genera movimiento.
5. **Redondeo:** `base_amount` no se cuantiza (queda a 8 decimales por el tipo de la columna) y los exportes pasan `Decimal` a `float` (exports.py:48-49).
6. **Cripto:** FIFO global entre wallets, empates de `acquired_at` sin orden definido, y el realizado fuera del P&L.
7. **La migración `f24c6d82a130:35-38` reescribió los cortes existentes** como `balanced` con diferencia 0.
8. **Estados distintos entre docs y código:** `partially_paid` contra `partial`; draft/voided/review_required contra pending/void/reversed. El filtro de la lista rechaza `review_required` (996), que el script legacy sí crea. `overdue` nunca se asigna solo.
9. **Las fechas usan `date.today()` del servidor (UTC)**, pero scope:7 fija America/Bogota.

**Seguridad:**
1. **`POST /auth/2fa/setup` desactiva el 2FA sin pedir OTP ni contraseña** (routes.py:252-257). Una sesión robada alcanza para quitarlo.
2. **Path traversal en `/documents`:** `entity_type` entra sin sanear en la ruta de disco (2548-2549). Cualquier usuario autenticado puede subir, incluido support, sin límite de tamaño y sin verificar de quién es `entity_id`.
3. **Referencias entre organizaciones:** no se valida a qué organización pertenecen `category_id`/`contact_id` al crear un movimiento (1015), `contact_id` en `POST /invoices` (1835), `contract_id` (1489) ni la categoría del presupuesto (2459).
4. **Permisos:** la tabla de permisos está muerta; nómina y dashboard quedan abiertos a management y al contador; support ve contactos y trabajadores (ver §2, roles).
5. **`get_current_user` toma la primera membresía activa** (`limit(1)`, dependencies.py:47-53), así que con varias organizaciones el resultado es ambiguo.
6. **Datos bancarios reales en el código:** números de cuenta y ruteo de EE. UU. y direcciones cripto hardcodeados como instrucciones de pago por defecto (routes.py:51-67).
7. **Archivos que pueden traer datos reales:** `tmp/pdfs/invoice-5215-1.png` y `output/pdf/` están commiteados. No los abrí.
8. **Login:** no hay rate limiting ni recuperación de contraseña.
9. **Errores 500 sin manejar:** `calculate_invoice_totals` lanza `ValueError` sin capturar (routes.py:1487, 1611). Los recordatorios corren dentro de cada réplica de la API y crean links nuevos en cada envío.
