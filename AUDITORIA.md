# Auditoría técnica integral — financial-dashboard (smart-dashboard)

**Fecha:** 2026-07-12 · **Alcance:** código completo (frontend Next.js 16 + backend API + Supabase/RLS) · **Método:** reconocimiento + 5 auditores paralelos (seguridad, bugs/lógica, links/rutas, calidad, performance) + verificación adversarial de cada hallazgo crítico/alto contra el código real y contra la base de datos de producción.

> Modo solo lectura: esta auditoría **no modificó ningún archivo ni dato**. Los fixes se harán después, con aprobación explícita, uno por commit.

---

## 1. Resumen ejecutivo

La aplicación está en **buen estado estructural**. La arquitectura de autorización es sólida y consistente (los 74 endpoints validan auth antes de tocar datos; el "viewing-as" de superadmin siempre re-verifica; el service key nunca llega al browser; el bypass de 2FA de dev es a prueba de producción). La lógica financiera pesada (comisiones, net deposit, broker) ya está extraída a módulos puros y testeados. **No sobrevivió ningún hallazgo CRÍTICO** tras la verificación adversarial — el más grave reportado (RLS deshabilitado en tablas de auth) resultó **falso positivo**: ya está corregido en la DB de producción.

**Nivel de riesgo general: MODERADO-BAJO.**

**Los 3 problemas más urgentes:**
1. **BUG-01 (ALTO):** `/balances` calcula el "Monto a Distribuir" y el "Balance Disponible" con una fórmula distinta a `/socios` — muestra un número inflado (sin reserva, sin inversiones, sin restar egresos). Cifras contradictorias del mismo mes entre dos pantallas; el balance disponible corporativo es incorrecto.
2. **SEC-01 (ALTO):** IDOR de escritura cross-tenant en `/api/admin/commission-entries` — falta el scope por `company_id`. Un admin podría sobrescribir resultados de comisiones de otra empresa (requiere conocer 3 UUIDs ajenos).
3. **BUG-02 (ALTO):** la distribución a socios multiplica y suma montos en float sin `round2` — drift de centavos en la plata que realmente se reparte.

---

## 2. Tabla de hallazgos (por severidad)

### 🟠 ALTO

---

**BUG-01 — Fórmula de "Monto a Distribuir" / "Balance Disponible" divergente entre /balances y /socios** ✅ **RESUELTO (2026-07-12, commit 88d3163)** — extraída fórmula canónica única a `src/lib/distribution.ts` (10 tests); la usan /socios, /balances y /finanzas. Decisión de Kevin: investmentProfits SÍ entra en la base distribuible.
`src/lib/data-context.tsx:467-526` (computeSaldoChain, consumido por /balances) vs `src/app/(dashboard)/socios/page.tsx:86-169` (periodChain, el reparto real). *Verificado adversarialmente: CONFIRMADO.*

Evidencia — ambas producen un card idéntico "Monto a Distribuir" para el mismo período, con fórmulas independientes:
```ts
// data-context.tsx:493,500  (lo que ve /balances)
const ingresosNetos = (oi.broker_pnl + oi.other) + propFirmNet;  // sin investmentProfits
let totalDistribuir = ingresosNetos;                              // sin reserva, sin restar egresos
// socios/page.tsx:97,151-153  (lo que realmente se reparte)
const pIncome = (broker_pnl + other) + propFirmNetIncome + investmentProfits;
const distributable = available - (available * pReservePct);      // reserva ~10%
```
La definición canónica (`glossary.ts:28`: *"Monto a Distribuir = Saldo disponible × (1 − %Reserva)"*) solo la cumple `/socios`. Divergen en 4 ejes: reserva, investmentProfits, resta de egresos y modelo de mes negativo (drenaje de acumulado vs. reserva-ahorro + carryDebt).

- **Impacto:** el "Balance Actual Disponible" de `/balances` (`balances/page.tsx:198`, `netDeposit − egresos − montoDistribuir`) queda inflado/incorrecto, y el card "Monto a Distribuir" contradice al de `/socios` para el mismo mes. Es el número que guía cuánto efectivo hay libre → riesgo de decisiones de distribución sobre una base equivocada. **Matiz honesto: a los socios NO se les paga mal** (el reparto usa la fórmula correcta); el defecto está solo en lo que muestra `/balances`.
- **Solución:** extraer UNA función canónica de saldo/distribución (con reserva + investmentProfits + egresos + modelo de deuda) a un módulo compartido con tests — exactamente como se hizo con `computeDerivedNetDeposit` — e importarla en ambas páginas. **Esfuerzo: M.**

---

**SEC-01 — IDOR / escritura cross-tenant en commission-entries (falta scope por company_id)** ✅ **RESUELTO (2026-07-12, commit 83d8366)** — `.eq('company_id', ...)` agregado al SELECT y al UPDATE.
`src/app/api/admin/commission-entries/route.ts:46-52` (SELECT) y `:70-73` (UPDATE). *Verificado adversarialmente: CONFIRMADO.*

```ts
const company_id = auth.companyId;                 // ✅ el valor escrito es correcto
const { data: existing } = await admin
  .from('commercial_monthly_results').select('id')
  .eq('profile_id', entry.profile_id)
  .eq('period_id', period_id)
  .eq('head_id', entryHeadId).maybeSingle();        // ❌ sin .eq('company_id', ...)
await admin.from('commercial_monthly_results')
  .update(row).eq('id', existing.id);               // ❌ toca la fila por id sin re-check de tenant
```
Usa `createAdminClient()` (bypass RLS). El `UNIQUE(profile_id, period_id)` es global (`schema.sql:309`), así que el SELECT resuelve la fila de otra empresa sin barrera.

- **Impacto:** un admin de la empresa A que conozca `profile_id`/`period_id`/`head_id` de la empresa B puede sobrescribir sus cifras de comisiones **y reasignar la fila a A** (`row.company_id = A`). La única protección residual es no conocer esos UUIDs (seguridad por oscuridad, no control de acceso). Broken access control sobre datos financieros en un SaaS multi-tenant.
- **Solución:** añadir `.eq('company_id', company_id)` al SELECT de existencia y al UPDATE — idéntico al patrón ya usado en `admin/negotiations/route.ts:79-80,93`. **Esfuerzo: S.**

---

**BUG-02 — Distribución a socios calculada en float sin round2** ✅ **RESUELTO (2026-07-12, commit 42e9680)** — `round2` canónico exportado desde utils.ts, aplicado a cada monto y al total.
`src/app/(dashboard)/socios/page.tsx:221-229, 240`. *Reportado por el auditor de lógica; consistente con la evidencia del código.*

```ts
const amount = totalToDistribute * pct;                          // sin round2
const totalDistributed = effectiveDistributions
  .reduce((sum, d) => sum + d.amount, 0);                        // acumula error float
```
A diferencia de `commission-calculator.ts` (que redondea con `round2` en cada paso), la distribución a socios opera en float crudo. La validación de porcentajes usa tolerancia `> 0.001` (`socios:250`), señal de que ya conviven con drift.

- **Impacto:** con varios socios y períodos consolidados, la suma repartida puede diferir del "Monto a Distribuir" por centavos → descuadres de reconciliación en **plata que sale a socios**.
- **Solución:** aplicar `round2` al derivar cada `amount` y al total. **Esfuerzo: S.**

---

### 🟡 MEDIO

---

**SEC-02 — Drift entre migraciones y DB: el hardening de RLS de tablas de auth no está en un archivo de migración** ✅ **RESUELTO (2026-07-12)** — migración 047 (aplicada + versionada) captura ENABLE RLS + REVOKE de anon en las 3 tablas.
`supabase/migration-014-*.sql:41`, `migration-015-*.sql:53,74`. *Reclasificado desde el falso positivo SEC "RLS deshabilitado".*

El auditor de seguridad reportó como ALTO que `password_reset_tokens`, `twofa_reset_codes` y `twofa_attempts` tienen RLS deshabilitado (leyendo los `.sql`). **Verifiqué contra producción y es falso positivo**: las 3 tablas tienen hoy `rls = true`, 0 policies (deny-all) y sin grants a `anon`/`authenticated`. El fix ya se aplicó (Fase 1, vía MCP). **El hallazgo real es el drift:** esas migraciones committeadas todavía dicen `DISABLE ROW LEVEL SECURITY`.

- **Impacto:** si alguien reconstruye la DB desde los archivos de migración (entorno nuevo, staging, disaster recovery), la vulnerabilidad **regresa** (RLS off en tablas que guardan códigos de reset de 2FA y el rate-limiting antibruteforce).
- **Solución:** añadir una migración `migration-047` que capture el `ENABLE ROW LEVEL SECURITY` + `REVOKE ... FROM anon, authenticated` de las 3 tablas, para que las migraciones reflejen el estado real. **Esfuerzo: S.**

---

**SEC-03 — Fuga de `error.message` crudo de Postgres/Supabase al cliente** ✅ **RESUELTO (2026-07-12, commit d781767)** — 62 rutas convertidas al helper `apiError` (loguea real server-side, devuelve genérico); reconciliado con `sanitizeDbError` vía `friendlyDbMessage` compartido. 0 leaks restantes.
~24 rutas, muestra: `admin/channel-balances/route.ts:97`, `admin/ib-rebates/route.ts:26`, `superadmin/companies/[id]/users/route.ts:109,213`, `[id]/logo/route.ts:186,216,282`.
```ts
return NextResponse.json({ success: false, error: error.message }, { status: 500 });
```
- **Impacto:** devuelve nombres de columnas, constraints y hints de RLS de PostgREST al frontend → divulgación de estructura interna de la DB. Concentrado en rutas admin/superadmin (mitiga), pero varias son alcanzables por admin de tenant.
- **Solución:** loggear el detalle server-side (Sentry) y devolver un mensaje genérico + código estable al cliente. **Esfuerzo: M.**

---

**SEC-04 — Dependencias con vulnerabilidades HIGH (transitivas)** ✅ **RESUELTO (2026-07-12, commit bf50595)** — `npm audit fix`: undici→6.27.0, form-data→4.0.6. 0 HIGH restantes (quedan 4 moderate que exigen `--force`/breaking).
`npm audit --omit=dev`: `undici` (HTTP header injection vía Set-Cookie, response queue poisoning, WS DoS) y `form-data` (CRLF injection). 14 vulnerabilidades en prod (2 high, 11 moderate, 1 low). *Confirmado ejecutando npm audit.*
- **Impacto:** transitivas (Next/Supabase/http libs). Explotabilidad directa **baja** en este app (las llamadas salientes van a APIs propias/de confianza), pero son advisories HIGH vigentes.
- **Solución:** `npm audit fix`; revisar `npm ls undici form-data`. Actualizar `exceljs` resuelve además el `uuid` moderate. **Esfuerzo: S.**

---

**PERF-01 — ExcelJS (~1MB) entra estático al bundle cliente de /risk/retiros-propfirm** ✅ **RESUELTO (2026-07-12, commit 309f5d0)** — exceljs + jszip pasados a `import type` + `await import()`; exceljs quedó en un chunk async (~912K) fuera del initial load.
`src/lib/risk/parser.ts:1` (`import ExcelJS from 'exceljs'`) importado por la página `'use client'` en `retiros-propfirm/page.tsx:11`. *Verificado adversarialmente: CONFIRMADO* (sin `server-only`, sin externalización en next.config; único importador es la página client).
- **Impacto:** ExcelJS se descarga en el bundle inicial de esa página aunque solo se use al subir un archivo. Irónicamente la misma página SÍ hace lazy de jspdf (`await import('jspdf')`, `:337`).
- **Solución:** `const ExcelJS = (await import('exceljs')).default` dentro de `parseTradeReport`, disparado solo al procesar el archivo. **Esfuerzo: S.**

---

**PERF-02 — Over-fetch global: se traen todas las tablas completas sin filtro de período**
`src/lib/data-context.tsx:283` — las queries de `queries.ts` aceptan un parámetro `periodIds?` (ej. `fetchDeposits(companyId, periodIds?)`) que **data-context nunca pasa**. Se descarga el historial completo de la empresa en cada arranque y en cada `refresh()`. Varias queries (`fetchDeposits/Withdrawals/Expenses/LiquidityMovements/Investments`) no tienen `.limit()`.
- **Impacto:** el payload crece linealmente con la antigüedad de la cuenta; con la DB en Londres y usuarios en Dubai/LatAm cada mes añade filas que viajan en cada carga. La infraestructura para filtrar ya existe, sin usar.
- **Solución:** pasar `periodIds` a las queries que lo soportan; cargar períodos históricos on-demand. Paginar/acotar por fecha las tablas de alto volumen (movimientos, liquidez). **Esfuerzo: M.**

---

**BUG-03 — Autosave solo persiste la sección visible; otras secciones "dirty" no se guardan**
`src/app/(dashboard)/upload/page.tsx:674-691` (efecto autosave) y `saveAll:1489-1524`.
El autosave dispara solo si `dirtySections.has(section)` (la pestaña actual) y `saveAll` persiste solo el `section` visible. Si el usuario edita Depósitos, cambia a Egresos y corre el debounce, Depósitos queda dirty en estado de React sin llegar a la DB hasta volver a esa pestaña o pulsar "Guardar Todo".
- **Impacto:** en navegación/refresh se pierden ediciones no visibles (solo las protege `beforeunload`). El candado `saveAllInFlightRef` está bien; el gap es el alcance por-sección.
- **Solución:** que autosave/`saveAll` iteren sobre TODAS las secciones dirty, no solo la visible. **Esfuerzo: M.**

---

**QA-01 — Lógica de dinero/riesgo sin cobertura de tests**
Sin tests: `src/lib/api-integrations/totals.ts` (`computeProviderTotals` — agrega dinero de CoinsBuy/UniPayment/FairPay), `src/lib/risk/rules.ts` (`analyzeReport`, 272 líneas, motor de reglas de riesgo), `src/lib/risk/duration-distribution.ts` (buckets — terreno de off-by-one), `src/lib/ib-rebates/alerts.ts` (umbrales de rebates a socios).
- **Impacto:** módulos que mueven/deciden plata sin red de seguridad; un refactor los rompe en silencio.
- **Solución:** ver §5 (los 5 tests priorizados). **Esfuerzo: M.**

---

**ARQ-01 — Formateo de moneda duplicado y disperso**
Existe `src/lib/utils.ts` (`formatCurrency`, `formatNumber`, `formatPercent`) pero hay 24 `.toLocaleString(` crudos + `fmt$`/`fmtPct`/`fmtDuration` redefinidos localmente en `risk/retiros-wallet/page.tsx:115`, `risk/retiros-propfirm/page.tsx:38-54`, `components/risk/duration-distribution-table.tsx:30,99`.
- **Impacto:** inconsistencia de decimales/locale entre pantallas; cambios de formato en N lugares.
- **Solución:** centralizar en `src/lib/utils.ts` (o `format.ts`) y reemplazar los `toLocaleString` inline. **Esfuerzo: S.**

---

**ARQ-02 — Tres estilos de fetching conviviendo; el helper `api-fetch.ts` no se usa**
34 archivos con `fetch()` directo, 13 con cliente Supabase directo, y los helpers `queries.ts`/`mutations.ts` (el patrón bueno). `src/lib/api-fetch.ts` existe pero **0 componentes lo usan**.
- **Impacto:** manejo de errores/timeouts/headers reimplementado ad-hoc en cada `fetch`.
- **Solución:** canalizar los `fetch` de API interna por `api-fetch.ts` (centralizar auth headers, error, timeout). **Esfuerzo: M.**

---

**PERF-03 — recharts (~350KB) estático en /resumen-general**
`src/components/charts/monthly-chart.tsx:6` → importado estáticamente por `resumen-general/page.tsx:10`. Único consumidor de recharts.
- **Solución:** `dynamic(() => import('@/components/charts/monthly-chart'), { ssr:false })`. Ya está en `React.memo`. **Esfuerzo: S.**

---

**PERF-04 — Sin headers de cache en GET de integraciones/reportes**
0 `Cache-Control`/`s-maxage`/`revalidate` en `api/integrations/*` y `api/reports/*`. Cada carga re-golpea APIs externas (Coinsbuy/Unipayment) y re-computa reportes.
- **Solución:** `Cache-Control: s-maxage=60, stale-while-revalidate=300` en los GET idempotentes semi-estáticos. **Esfuerzo: S.**

---

**LNK-01 — Asset `/icon.png` no existe (PWA + middleware)**
`public/manifest.json:13,19` y `src/lib/supabase/middleware.ts:21` referencian `/icon.png`; en `public/` solo existe `icon.svg`.
- **Impacto:** el ícono de instalación PWA devuelve 404.
- **Solución:** agregar `public/icon.png` en los tamaños referenciados, o apuntar el manifest a `/icon.svg`. **Esfuerzo: S.**

---

**A11Y-01 — `lang="es"` hardcodeado pese a i18n es/en**
`src/app/layout.tsx:75`. Cuando el usuario elige inglés, lectores de pantalla siguen anunciando el contenido como español.
- **Solución:** derivar `lang` de la preferencia i18n. **Esfuerzo: S.**

---

### 🟢 BAJO

---

**BUG-04 — Docstring de `calculateCommission` contradice el código (foot-gun)**
`src/lib/commission-calculator.ts:30-38` (comentario) vs `:56-60` (código). El comentario dice `real_payment = MAX(0, commission)` y `accumulated_out = base si commission<0`; el código hace `realPayment = commission` (sin clamp) y `accumulatedOut = division` siempre. **El código es el correcto** (los tests lo fijan; es el modelo de arrastre de deuda del BDM). El riesgo es que un mantenedor "corrija" el código para cumplir el comentario y **rompa el arrastre de deuda** (pagaría de más).
- **Solución:** corregir el comentario para reflejar el código. **Esfuerzo: S.**

---

**LNK-02 — 6 endpoints API huérfanos (superficie olvidada)**
Sin caller in-app: `POST /api/send-email`, `GET /api/send-email/test`, `GET /api/integrations/coinsbuy/{deposits,payouts}`, `GET /api/integrations/unipayment/transactions`, `GET /api/integrations/fairpay/transactions`. El envío real usa `emailService.sendEmail()`; los datos de integración llegan por `lib/api-integrations/*` directo.
- **Impacto:** código muerto que amplía superficie de ataque (endpoints de datos financieros sin uso).
- **Solución:** eliminarlos si son legado, o confirmar su auth y documentarlos como debug. **Esfuerzo: S.**

---

**BUG-05 — Net deposit: misma fórmula, distinta provenance de inputs entre /movimientos y /balances**
`movimientos/page.tsx:262-267` (hook `coexist`, tiempo real, wallets pinneadas) vs `balances/page.tsx:188-193` (`apiMonthly[ymKey]`). La fórmula (`computeDerivedNetDeposit`) se unificó, pero los inputs vienen de fuentes distintas; si scopean/cachean distinto, el Net Deposit puede diferir entre pantallas.
- **Solución:** verificar que ambas fuentes derivan del mismo scope de wallets, o documentar la diferencia. **Esfuerzo: S.**

---

**QUAL-01 — Componentes de página gigantes**
`upload/page.tsx` (2901 líneas, ~48 useState), `comisiones/page.tsx` (2141), `rrhh/page.tsx` (2073). *Matiz: la lógica de dinero ya está extraída y testeada — lo que queda es JSX + estado de UI.*
- **Solución:** trocear `upload` por sección (`DepositsSection`, `ExpensesSection`, …) a `upload/_components/`. `comisiones` es opcional (su lógica ya está sana). **Esfuerzo: L.**

---

**Otros BAJO:** LNK-03 (`docs.unipayment.io` muerto, solo comentario, `api-integrations/unipayment.ts:4`, esfuerzo XS) · LNK-04 (faltan `not-found.tsx`/`error.tsx` de marca; solo hay `global-error.tsx`, esfuerzo S) · QUAL-02 (`socks-proxy-agent` sin usar en package.json, esfuerzo XS) · BUG-06 (`dates.ts:41` `formatDate` usa hora local, no UTC → posible off-by-one de día en husos negativos, esfuerzo S) · PERF-05 (tablas editables sin memo de fila → re-render por tecla en tablas >100 filas, esfuerzo M) · TS-01 (non-null assertions frágiles en `movimientos/page.tsx:270-273`, `sidebar.tsx:252`, esfuerzo S) · UX-01 (`egresos/page.tsx` guarda sin spinner, solo botón deshabilitado, esfuerzo S) · B2-bugs (`computeExpensePending`: pendiente explícito de 0 se trata como vacío — documentado como intencional, esfuerzo XS).

---

## 3. Mejoras de lógica y arquitectura (las de mayor impacto)

1. **Unificar la fórmula de saldo/distribución (BUG-01).** Es la misma clase de deuda que ya se resolvió para el net deposit: una regla de dinero reimplementada en dos lugares que divergen. Extraer `computeDistributableAmount()` a `src/lib` con tests y consumirla desde `/balances`, `/socios` y `/finanzas/consolidado`. *Trade-off:* hay que decidir de forma explícita si `investmentProfits` entra en la base distribuible (hoy socios sí, balances no) — es una decisión de negocio, no solo técnica.

2. **Un único cliente de datos.** Hoy conviven `fetch` directo, cliente Supabase directo y los helpers `queries/mutations`. Canalizar todo por `api-fetch.ts` + los helpers centraliza auth, timeout y manejo de error (que hoy se reimplementan). *Trade-off:* toca muchos archivos; hacerlo incremental por módulo.

3. **Fetching por período en vez de "cargar toda la empresa".** El `data-context` carga ~19 tablas completas al arranque. Pasar `periodIds` (infra ya existente) y cargar histórico on-demand corta el payload que crece con el tiempo — la palanca de performance más grande junto con la región de la DB (que Kevin decidió mantener en Londres por la geografía Dubai↔LatAm). *Trade-off:* cambiar de período pasa a disparar un fetch; mitigable con cache local.

4. **Redondeo de dinero consistente (`round2`) en toda ruta que reparta o sume montos.** Comisiones ya lo hace; distribución a socios no (BUG-02). Establecer la convención "todo monto que se muestra o se paga pasa por `round2`" y aplicarla. *Trade-off:* mínimo.

5. **Blindar la lógica de riesgo/integraciones con tests (QA-01).** `risk/rules.ts` y `api-integrations/totals.ts` son puros, complejos y mueven plata — máximo valor por esfuerzo. *Trade-off:* ninguno real; es deuda pura.

6. **Lazy-load de librerías pesadas de export (ExcelJS/recharts).** Patrón ya usado para jspdf; extenderlo. *Trade-off:* mínimo, mecánico.

7. **Separar UI de tamaño (QUAL-01) — opcional y de menor prioridad.** Los componentes gigantes ya no esconden lógica de negocio; trocearlos mejora mantenibilidad pero es refactor cosmético de riesgo medio. Hacerlo solo cuando haya que tocar esas pantallas.

---

## 4. Plan de acción priorizado (impacto ÷ esfuerzo)

**Hoy (alto impacto, bajo esfuerzo):**
- SEC-01 — scope `company_id` en commission-entries (S). *Cierra un IDOR de escritura financiera.*
- BUG-02 — `round2` en distribución a socios (S). *Plata real.*
- SEC-02 — migración que capture el hardening de RLS ya aplicado (S). *Evita regresión en rebuild.*
- PERF-01 + PERF-03 — lazy de ExcelJS y recharts (S). *Bundle.*
- SEC-04 — `npm audit fix` (S).

**Esta semana:**
- BUG-01 — fórmula canónica de distribución compartida + tests (M). *El hallazgo #1.*
- QA-01 — tests de `totals.ts`, `risk/rules.ts`, `duration-distribution.ts`, `ib-rebates/alerts.ts` (M).
- BUG-03 — autosave de todas las secciones dirty (M).
- SEC-03 — dejar de filtrar `error.message` crudo (M).
- LNK-01 (icon.png), A11Y-01 (lang dinámico), BUG-04 (docstring), LNK-03 (S/XS).

**Este mes:**
- PERF-02 — fetching por período (M/L).
- ARQ-01 + ARQ-02 — unificar formateo y cliente de datos (S+M).
- PERF-04 — cache headers en GETs (S).
- LNK-02 — limpiar/documentar endpoints huérfanos (S).
- PERF-05 — memo de fila en tablas editables (M).
- QUAL-01 — trocear `upload/page.tsx` (L), solo si hay que tocarlo.

---

## 5. Los 5 tests de mayor valor a agregar (en orden)

1. **`api-integrations/totals.ts` → `computeProviderTotals` / `acceptedTransactions`** — agrega dinero real de 3 proveedores y define qué transacciones cuentan. Puro. Máximo valor/esfuerzo.
2. **`risk/rules.ts` → `analyzeReport`** — motor de reglas de riesgo (272 líneas, alta complejidad, cero cobertura).
3. **`risk/duration-distribution.ts` → `computeDurationDistribution`** — buckets de duración = clásico off-by-one en los límites.
4. **`ib-rebates/alerts.ts` → `computeAlert`** — umbrales de rebates a socios (dinero).
5. **Ampliar `commission-calculator`/nuevo `distribution.test.ts`** — fijar la fórmula canónica de distribución (BUG-01) con los casos de reserva, investmentProfits y mes negativo, para que no vuelva a divergir.

---

## 6. Lo que está bien (no tocar)

- **Autorización:** los 74 endpoints validan auth; `admin/*` → `verifyAdminAuth`, `superadmin/*` → `verifySuperadminAuth`, sin excepciones. "Viewing-as" siempre re-verifica superadmin. IDOR en rutas `[id]` (`ib-rebates`, `risk/revisions`, `excluded-transactions`) tienen guard cross-tenant explícito.
- **Secretos:** sin secretos en git ni en el historial, sin hardcodeos, `.env.local` no trackeado, `NEXT_PUBLIC_*` solo expone lo público. Service key nunca llega al browser.
- **Bypass 2FA de dev:** a prueba de producción (doble guarda `NODE_ENV` + hostname localhost).
- **RLS de tablas `api_*` y auth:** habilitado y correcto en producción (verificado en DB). Funciones SECURITY DEFINER nuevas con `search_path` fijo, check `auth_can_edit` y `REVOKE` de anon.
- **Guardado financiero:** los reemplazos por período son atómicos vía RPC (cierra el bug histórico de "período vacío tras timeout"); candado anti-doble-submit resuelto con ref síncrono.
- **Núcleo financiero:** `commission-calculator.ts` y `broker-logic.ts` — tiers sin gaps, clamps correctos, `round2` consistente, `computeDerivedNetDeposit` como fuente única. Bien testeado.
- **Fetching paralelizado** (`Promise.all`), sin N+1 de red. Headers de seguridad completos (CSP sin `unsafe-eval` en prod). TypeScript limpio (6 `any`, 0 `@ts-ignore`). `deletePartner` no deja distribuciones huérfanas.

---

### Anexo — hallazgos refutados en verificación adversarial
- **"RLS deshabilitado en `password_reset_tokens`/`twofa_reset_codes`/`twofa_attempts`" (reportado ALTO/CRÍTICO) → REFUTADO.** Verificado contra la DB de producción: RLS habilitado, 0 policies (deny-all), sin grants a anon/authenticated. Ya corregido. Queda solo el drift documental (SEC-02).
