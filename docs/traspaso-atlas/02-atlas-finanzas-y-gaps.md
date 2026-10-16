# Atlas: inventario del módulo Finanzas y gaps frente a Smart Dashboard (secciones A y D)

**Origen:** revisión de solo lectura de `/Users/kevinshark/dev/horizon-dashboard` en el commit `09449edf`, hecha el 2026-10-16. No modifiqué nada y no consulté ninguna base. Las rutas son relativas al repo.

---

## A) Módulo Finanzas

### A.1 Tamaño

| Concepto | Cantidad |
|---|---|
| Endpoints `route.ts` de contabilidad (`src/app/api/finances/**` + `src/app/api/admin/finance-permissions/**`) | 35 (33 + 2) |
| Endpoints de facturación (`src/app/api/invoicing/**`) | 25 |
| Crons | 2: `finance-recurring` (`30 3 * * *`, 359 líneas) e `invoicing-recurring` (`15 4 * * *`, 382 líneas) |
| Páginas `page.tsx` en `src/app/dashboard/finances` | 11 (6 de contabilidad y 5 de facturación) + `src/app/admin/finances/page.tsx` (800 líneas) |
| Líneas sin tests (rutas, páginas, componentes y libs de finanzas) | ~25.200, de las cuales ~4.400 son de UI de facturación |
| Libs puras en `src/lib/finance/` | 12 archivos fuente y 9 de tests |
| Modelos Prisma de contabilidad | 11 (lista en A.2) |
| Claves i18n `finances.*` en `es.json` | 838 |
| Tests | 13 archivos, 3.151 líneas, unos 319 casos (detalle en A.6) |
| Historia | El primer commit es del 2026-04-14. Las "tandas" 1→3f se mergearon el 2026-08-06 (#238–#248). Hubo un endurecimiento de RLS y autorización el 2026-08-13/18 (#290, #291, #329, #332, #334). |

### A.2 Modelos Prisma de contabilidad (`prisma/schema.prisma`)

Los 11 modelos tienen `orgId` y figuran en `docs/atlas-rls-strict.sql`, que es la lista de tablas con RLS estricto.

| Modelo (línea) | Campos clave / notas |
|---|---|
| `FinancePermission` (1184) | 6 flags booleanos (ver/editar/borrar para contabilidad y para facturación). Única por `[orgId, userId]`. |
| `FinanceCategory` (1210) | `type` es texto libre: `INGRESO`, `EGRESO` o `TRANSFER`; además `color`, `active` y `order`. |
| `FinancialAccount` (1236) | Es la "unidad de negocio": `currency` (USD por defecto) e `initialBalance Decimal(14,2)`. **No tiene tipo de canal** (banco, cripto o pasarela), ni proveedor, ni saldo externo. |
| `Transaction` (1258) | `amount` es siempre positivo y el signo lo da la categoría. Tiene `attachmentUrl`/`attachmentName` (**un solo adjunto**), `transferGroupId`/`transferDirection`, `importBatchId` y `recurringId` (sin clave foránea, a propósito), y `approvalStatus`/`approvedById`/`approvedAt`/`rejectedReason`. Relación 1-1 con `FinancialClose` y 1-N con `InvoicePayment`. |
| `FinanceImportRule` (1391) | Patrón de texto → categoría, con `priority`. |
| `FinanceImport` (1413) | Lote importado: `fileName`, `rowCount`, `importedCount`. |
| `FinanceRecurring` (1443) | `frequency` (WEEKLY, MONTHLY o YEARLY), `anchorDay`/`anchorMonth`, `nextRunAt`, `endDate` y `active`. |
| `FinanceBudget` (1492) | Única por `[categoryId, period, currency]`. |
| `SocietyConfig` (1515) | `reservePercent Decimal(5,2)` (10 por defecto) por año. **`year Int @unique` es global y no por organización** (migración `20260413165657_finance_categories_and_society`, línea 110). Ver el hecho 4 de A.8. |
| `Shareholder` (1533) | `percentage Decimal(5,2)` y `active`. No guarda historial de porcentajes. |
| `FinancialClose` (1556) | `period`, `totalAmount` y `transactionId` (único). Única por `[orgId, period]`. **No congela el reparto por accionista, ni porcentajes, ni saldos.** |

El umbral de aprobación está en `AppSettings.expenseApprovalThreshold Decimal?` (línea 957). La facturación tiene sus propios modelos: `Client`, `Invoice`, `InvoiceItem`, `InvoicePayment`, `InvoiceActivity`, `InvoiceTemplate`, `PaymentMethod`, `InvoiceSavedItem` e `InvoiceSettings`.

### A.3 Pantallas

| Ruta | Archivo (líneas) | Qué hace |
|---|---|---|
| `/dashboard/finances` | `page.tsx` + `components/finances/KpiDashboard.tsx` (698) | Resumen con los KPIs del dueño. Si el usuario solo tiene facturación, lo redirige a `/invoicing`. |
| `/balances` | `balances/page.tsx` (1.068) | Saldos por moneda y desglose por categoría. Exporta CSV y PDF. Permite alta rápida de movimiento y de categoría. |
| `/transactions` | `transactions/page.tsx` (1.899) | Listado de movimientos con chips de pendientes, búsqueda por importe, acciones en lote, historial, transferencias (`TransferModal`), importación CSV (`CsvImportWizard`, 1.210) y recurrentes (`RecurringManager`, 624). |
| `/accounts` | `accounts/page.tsx` (289) | Alta y edición de unidades de negocio, con saldo actual. |
| `/reports` | `reports/page.tsx` + `DistributionCharts`, `SocietyReportTab`, `BudgetModal` | Gráficos por categoría y mes, presupuestos, estado de resultados en PDF (jsPDF en el cliente, `src/lib/finance/report-pdf.ts`). |
| `/society` | `society/page.tsx` (228) + `ShareholderDistribution.tsx` (626) + `SocietyResultsTable.tsx` | Resultado mensual con reserva, reparto entre accionistas y botón de cierre de período. |
| `/invoicing/**` | 5 páginas (~4.400 líneas de UI) | Facturas, clientes, pagos, ajustes y recurrentes. |
| `/admin/finances` | `src/app/admin/finances/page.tsx` (800) | Otorgar `FinancePermission` por usuario y administrar categorías. |

El selector de moneda (`CurrencyTabs.tsx`, 56 líneas) es una pestaña por moneda. Las monedas soportadas son solo USD, AED y EUR (`src/lib/finance-constants.ts`). No hay tipo de cambio ni consolidación entre monedas.

### A.4 Endpoints (35)

Todos pasan por `requireOrgModule(ctx,"FINANCES")` salvo el cron. La columna "Permiso" es el flag de `getFinanceAccess` que se exige.

| Endpoint | Métodos | Permiso | Qué hace / modelos |
|---|---|---|---|
| `finances/access` | GET | módulo | Devuelve los flags efectivos del usuario. |
| `finances/accounts`, `accounts/[id]` | GET, POST / PATCH, DELETE | view / edit / delete | `FinancialAccount` con saldo actual (misma fórmula que Balances). |
| `finances/balances` | GET | viewAccounting | Saldos por moneda: apertura + neto. Los totales salen agregados de la base; el detalle se corta en `DETAIL_ROW_CAP` (línea 207). |
| `finances/budgets` | GET, POST | view / edit | `FinanceBudget`. |
| `finances/categories`, `[id]` | GET, POST / PATCH, DELETE | view / edit / delete | `FinanceCategory`. |
| `finances/export` | GET | viewAccounting | CSV del libro. Ventana de 12 meses por defecto y tope `CSV_ROW_CAP` (línea 82). Si recorta, lo avisa en la última línea. Los pendientes salen rotulados. |
| `finances/export-pdf` | GET | viewAccounting | PDF de balance hecho en el servidor (jsPDF + autotable), por moneda. |
| `finances/import` | GET, POST | view / edit | Importación CSV (detalle en A.5). Usa `isOrgFinanceAdmin` para la auto-aprobación. |
| `finances/import/check` | POST | edit | Revisión previa de duplicados (solo informativa). |
| `finances/import/[id]` | DELETE | delete | Deshace un lote y conserva las filas que ya no se pueden tocar. |
| `finances/import/rules`, `[id]` | GET, POST / PATCH, DELETE | view / edit | `FinanceImportRule`. |
| `finances/kpis` | GET | viewAccounting (+ viewInvoicing para la antigüedad de cobros) | KPIs (detalle en A.5). |
| `finances/recurring`, `[id]` | GET, POST / PATCH, DELETE | view / edit | `FinanceRecurring`. |
| `finances/reports` | GET | viewAccounting | Agregados por categoría, mes y día, más reales contra presupuesto, por moneda. |
| `finances/shareholders`, `[id]` | GET, POST / PATCH, DELETE | view / edit / delete | `Shareholder`. |
| `finances/society` | GET | viewAccounting | Resultado mensual por moneda y año. |
| `finances/society/config` | GET, PATCH | view / edit | `SocietyConfig` (porcentaje de reserva por año). |
| `finances/society/close` | POST | editAccounting | Cierre de período (detalle en A.5). |
| `finances/society/closes` | GET | viewAccounting | Lista de cierres. |
| `finances/transactions` | GET, POST | view / edit | Listado y alta. Revisa períodos cerrados y aprobación. |
| `finances/transactions/[id]` | PATCH, DELETE | edit / delete | Revisa la fecha vieja y la nueva contra períodos cerrados. Guarda el antes y el después en `AuditLog.metadata.changes`. |
| `transactions/[id]/approve`, `/reject` | POST | editAccounting | Aprobación con control dual (quien carga no aprueba). |
| `transactions/[id]/history` | GET | viewAccounting | Historial leído desde `AuditLog`. |
| `transactions/bulk` | POST | edit / delete | Acciones en lote (detalle en A.5). |
| `transactions/suggest` | GET | viewAccounting | Autocompletado de concepto y descripción. |
| `finances/transfers`, `transfers/[groupId]` | POST / DELETE | edit / delete | Transferencia como dos filas atómicas. |
| `admin/finance-permissions`, `[userId]` | GET, POST / PATCH, DELETE | ORG_ADMIN+ | `FinancePermission`. |
| `cron/finance-recurring` | GET | `authorizeCron` | Genera los recurrentes que vencen (detalle en A.5). |

### A.5 Reglas de negocio verificadas

**Signo del importe.** El importe se guarda siempre positivo y el signo lo da `category.type`.

**Saldo.**
- La fórmula es: `saldo = initialBalance + Σ ingresos − Σ no-ingresos + Σ transferencias con signo`.
- Está en un único lugar, `src/lib/finance/balances-calc.ts` (encabezado y `accountCurrentBalance`, línea 127).
- El saldo de apertura de un período incluye toda la historia anterior a ese período.

**Multi-moneda.**
- Todos los totales se calculan por moneda y nunca se mezclan; no hay tipo de cambio. Aplica a balances, KPIs, reportes y sociedad.
- El cierre se hace solo con movimientos de la moneda de la cuenta elegida.

**Transferencias** (`src/lib/finance/transfers.ts`, líneas 35 y 53).
- Una transferencia son dos filas con la categoría de sistema `TRANSFER` y dirección `OUT`/`IN`.
- Quedan fuera de ingresos, egresos, sociedad y presupuestos, pero cuentan en los saldos.
- Están exentas de aprobación.

**Aprobación de egresos** (`src/lib/finance/approvals.ts`).
- Qué cuenta: `approvalCountsWhere` (línea 59) solo suma movimientos con estado `null` o `APPROVED`. PENDING y REJECTED quedan visibles pero no suman en ningún total.
- Cuándo hace falta aprobar: `requiresApproval` (línea 121) aplica a un EGRESO que no sea transferencia, cuando hay umbral configurado y el importe es mayor o igual al umbral.
- Auto-aprobación: con `initialApprovalStatus` (línea 149), un ORG_ADMIN+ que crea el egreso lo deja aprobado a su propio nombre.
- Control dual: nadie aprueba lo que cargó él mismo, ni siquiera un admin (`transactions/[id]/approve/route.ts:81`, devuelve 409).
- Cron, CSV y cierre:
  - Lo que genera el cron entra PENDING sin auto-aprobación.
  - El CSV pasa por la misma regla.
  - El asiento de cierre nace con estado `null`.
- Avisos a aprobadores: `approvals-server.ts`, con un máximo de 20 notificaciones.

**Períodos cerrados** (`src/lib/finance/closed-periods.ts`).
- Formatos válidos: `YYYY`, `YYYY-MM` o `YYYY-Qn` (línea 22). Los rangos se calculan en UTC (línea 45).
- Los cierres viejos con texto libre no bloquean nada.
- El control (`closed-periods-guard.ts:42`) devuelve 409 `PERIOD_CLOSED` en alta, edición, borrado, transferencias, aprobación, rechazo e importación (en la importación se rechaza el lote entero).

**Cierre y reparto a socios** (`src/lib/finance/society-calc.ts` + `society/close/route.ts`).
- Resultado mensual: `computeMonthlyResult` (línea 32) calcula el bruto como ingresos − egresos. La reserva es `bruto × reservePercent / 100` solo si el bruto es positivo; si no, es 0. El neto es bruto − reserva. Se redondea a 2 decimales.
- Neto del período: `sumPeriodNet` (línea 55) suma los netos mes a mes, no el neto de los totales del período.
- Reparto entre socios: `distributeShares` (línea 137) trabaja en centavos enteros con el método del resto mayor; los empates se resuelven por el id más chico. Solo cuadra exacto si los porcentajes suman 100 ± 0,01 (`percentagesSumTo100`, línea 108).
- Validaciones del cierre:
  - Exige que los porcentajes de socios activos sumen 100 % si hay socios (`close/route.ts:154`, 409 `SHAREHOLDER_PERCENT_MISMATCH`).
  - El servidor recalcula el importe y lo compara con el del cliente con tolerancia de 0,01 (`:197`, 409 `CLOSE_AMOUNT_MISMATCH`).
- Qué escribe el cierre:
  - Si el neto es positivo, crea un EGRESO por ese importe en la categoría "Distribución de utilidades", que se crea si no existe (`:216`). Si no, crea un asiento de 0.
  - Crea la fila en `FinancialClose` y la entrada de auditoría, todo en una transacción.
  - Un doble envío se resuelve con la unicidad de la base (P2002 → 400, `:316`).
- Lo que el cierre **no** guarda:
  - **No queda congelado** el reparto por socio, ni la reserva acumulada, ni deuda arrastrada.
  - Un período con pérdida se cierra sin arrastrar nada al siguiente.

**Acciones en lote** (`src/lib/finance/bulk-guards.ts`).
- Máximo 100 ids por lote (línea 21). Acciones: recategorizar, mover de cuenta y borrar.
- Cada fila pasa los mismos controles que la operación individual (`evaluateBulkRow`, línea 112). Las que no pasan se saltean con un motivo:
  - no encontrada,
  - en período cerrado,
  - pata de transferencia,
  - aprobada y bloqueada,
  - categoría de otro tipo,
  - otra moneda,
  - vinculada a una factura.

**Importación de CSV** (`src/lib/finance/csv-import.ts` + `import/route.ts`).
- Límites: 2 MB (línea 36) y 2.000 filas (línea 38).
- Lectura del archivo:
  - El separador `,` o `;` se detecta solo y se quita el BOM.
  - Detecta formato decimal europeo o estadounidense, y fecha DMY, MDY o YMD.
  - Admite una columna de importe con signo o columnas separadas de débito y crédito.
- Reglas de auto-categorización por coincidencia de texto, ordenadas por prioridad y luego por patrón más largo.
- Duplicados: se detectan por día UTC, importe y concepto normalizado, y se recalculan en el servidor.
- El archivo se procesa en el navegador; el servidor vuelve a validar todo.
- Se puede deshacer por lote.
- **Solo CSV: no hay librería para Excel (xlsx) en `package.json`.**

**Recurrentes** (`src/lib/finance/recurring-calc.ts` + cron).
- El día ancla se ajusta al largo del mes.
- No hay recuperación de atrasos: si se perdieron varias ocurrencias, solo se genera la más reciente vencida.
- Se saltean cuentas o categorías inactivas y períodos cerrados.
- Las plantillas se desactivan solas al pasar su `endDate`.

**KPIs** (`src/lib/finance/kpis-calc.ts`).
- Gasto mensual promedio de los últimos 3 meses, meses de caja restantes (crítico por debajo de 3, alerta por debajo de 6) y variación contra el mes anterior.
- Top 5 de categorías de gasto y tendencia de 13 meses.
- Antigüedad de facturas por cobrar, días promedio de cobro (ventana de 90 días) y los 5 clientes que más deben.

**Facturación ↔ contabilidad.** `src/lib/invoice-finance.ts` crea el ingreso contable cuando se confirma el pago de una factura, dentro de la misma transacción. Si no puede asentarlo (por ejemplo, falta la cuenta), devuelve el motivo en lugar de fallar en silencio.

**Auditoría.** Toda escritura llama a `logAudit` siguiendo la convención de no guardar importes en la metadata. La excepción es el PATCH de transacciones, que guarda el antes y el después.

### A.6 Permisos y tests

**Permisos.**
- `src/lib/finance-access.ts`: un ORG_ADMIN+ de la organización (o el super admin) tiene acceso total.
- El resto necesita una fila en `FinancePermission`. La lista de flags está en un solo lugar: `src/lib/finance-permission-flags.ts`.
- Desde la tanda A5, las pantallas de contabilidad exigen `canViewAccounting`; el permiso de facturación ya no abre el libro.

**Tests.**

| Archivo | Casos |
|---|---|
| `src/lib/finance/csv-import.test.ts` | 95 |
| `src/lib/finance/recurring-calc.test.ts` | 38 |
| `src/lib/finance/society-calc.test.ts` | 30 |
| `src/lib/finance/kpis-calc.test.ts` | 29 |
| `src/lib/finance/balances-calc.test.ts` | 26 |
| `src/lib/finance/bulk-guards.test.ts` | 25 |
| `src/lib/finance/approvals.test.ts` | 23 |
| `src/lib/finance/closed-periods.test.ts` | 11 |
| `src/lib/finance/search-amount.test.ts` | 9 |
| `src/lib/finance-access.test.ts` | 8 |
| `tests/routes/finances/finance-gates.test.ts` | 12 |
| `tests/routes/finances/approvals-guards.test.ts` | 6 |
| `tests/components/finances.test.tsx` | 7 |

No hay tests de ruta para el cierre, la importación, las transferencias ni el cron.

### A.7 Madurez

| Área | Estado |
|---|---|
| Libro, saldos, transferencias, multi-moneda, aprobación con control dual, períodos cerrados, lote, CSV, recurrentes, KPIs, cálculo de sociedad | **Maduro**: lógica pura con tests, varias rondas de auditoría y comentarios con el porqué. |
| Cierre de período | **Maduro pero mínimo**: un solo importe y bloqueo de edición; sin foto congelada, sin reparto guardado por socio y sin arrastre. |
| Adjuntos | **Básico**: una sola URL por movimiento. |
| Accionistas | **Básico**: porcentaje actual, sin historial. |
| `SocietyConfig` | **Defecto multi-organización** (`year @unique` global). |
| Facturación | Completa (Stripe, enlace público de pago, recordatorios, recurrentes). No la revisé en detalle. |

### A.8 Hechos que conviene tener presentes

1. **Atlas hoy depende de Smart Dashboard como proveedor de datos.**
   - Orion puede leer de Mongo o de la API de partners de Smart Dashboard (`ORION_SOURCE`, `OrionSyncState.lastPartnerSince`).
   - La capa de MT5 se lee de Smart Dashboard (`cron/trading-sync`, `admin/integrations/mt5`).
   - Si se apaga Smart Dashboard, esas fuentes se cortan.
2. **El motor de comisiones del call center es una librería sin uso.**
   - `src/lib/callcenter/comisiones/` (esquema versionado, cálculo en centavos y contrato) tiene 1.324 líneas con tests.
   - Ninguna ruta ni pantalla lo importa, y no hay tabla en Prisma.
   - `contrato.ts` lo describe como el contrato que consume Smart Dashboard para nómina.
3. **Comisiones de IB.** Según `src/lib/support/broker-portal.ts:27`, Atlas no tiene comisiones de IB: viven en Smart Dashboard. El espejo de Orion sí trae totales por cliente (`OrionCustomer.ibRewards*Usd`, `ibProgram*`, `ibAncestorIds`), pero sin historial.
4. **`SocietyConfig.year` es único a nivel global.** Si dos organizaciones configuran el mismo año, la segunda debería fallar con P2002. Lo deduzco del schema y la migración; no verifiqué si ese índice sigue existiendo en producción.

---

## D) Gaps frente a Smart Dashboard

| Necesidad | Estado | Qué hay hoy |
|---|---|---|
| Balances por canal de pago (cripto, bancos, pasarelas) | **Parcial** | `FinancialAccount` sirve como cuenta y moneda, con saldo calculado. No tiene tipo de canal, proveedor, saldo externo ni conciliación contra la API del proveedor. |
| Fotos diarias de saldos | **No existe** | Los saldos se calculan al vuelo desde `Transaction`; no hay modelo ni cron de fotos diarias. |
| Períodos mensuales con cierre y foto congelada | **Parcial** | Hay cierre `YYYY`/`YYYY-MM`/`YYYY-Qn` que bloquea ediciones y guarda solo `totalAmount`. No congela saldos, desglose ni reparto. |
| Cadena de distribución a socios con reserva y deuda arrastrada | **Parcial** | Hay reserva mensual por porcentaje anual (solo sobre bruto positivo) y reparto exacto por porcentaje. No hay cadena de varios niveles, ni deuda o pérdida arrastrada, ni reparto guardado por socio, ni historial de porcentajes. |
| Órdenes de pago con aprobación y adjuntos | **Parcial** | Hay aprobación con control dual y umbral sobre egresos, y un adjunto por movimiento. No existe la entidad "orden de pago" (beneficiario, estado de pago, varios adjuntos). |
| Comisiones de RRHH por net deposit con estructura de IBs | **Parcial / no existe** | El motor del call center (ventas/FTD, versionado) es una librería sin rutas, UI ni tabla, y **no usa net deposit**. HR tiene `SalaryRecord` sin vínculo con finanzas. Existen `IntroducingBroker` (contacto colgado de un BDM) y el árbol de rangos comerciales, y Orion trae `ibAncestorIds` y totales de comisiones de IB. No se calcula ni paga ninguna comisión. |
| Revisión de retiros con score | **No existe** | Solo hay datos de contexto en Orion (`totalWithdrawals`, `enabledWithdrawals`, `kycStatus`). No hay cola, score ni flujo de revisión; `riskScore` y `withdrawalReview` no aparecen en ningún archivo. |
| Exposición MT5 | **No existe** | `TradingActivity`/`TradingMtAccount` traen equity, balance y profit por cuenta y familia, leídos de Smart Dashboard. No hay posiciones abiertas, símbolos, volumen ni exposición neta; no hay referencias a exposure. |
| Hedge fund | **No existe** | Solo el campo `OrionCustomer.ibRewardsHedgeUsd` y textos de UI en la ficha de Orion. |
| Carga de datos por Excel | **Parcial** | Solo CSV para movimientos (asistente completo con reglas, duplicados y deshacer). No hay xlsx en las dependencias. La importación de HR crea expedientes desde usuarios existentes, no desde archivo. |
| API para partners con tokens | **Parcial (precedente)** | `ExpoIngestKey` es una clave hasheada por organización para ingesta entrante. No hay una API de lectura para partners ni tokens con alcance sobre datos financieros. Atlas hoy es cliente de la API de partners de Smart Dashboard, no servidor. |
| Sincronización con CRM Orion/MongoDB y MT5 | **Existe (vía Smart Dashboard)** | Crons `orion-sync` y `trading-sync`. El detalle de qué tablas toca está en el informe del subagente de Orion/MT5. |

No verifiqué: el estado real de los índices y las políticas RLS en producción, ni el comportamiento en ejecución de ningún endpoint. No corrí builds ni tests.
