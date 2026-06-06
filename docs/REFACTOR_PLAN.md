# Smart Dashboard — Plan de Refactor (Sprint 3+)

Este documento captura el roadmap de refactores estructurales identificados
en la auditoría del 2026-06-06. Los Sprints 1 y 2 ya están en producción
(bugs P0 + tests + CI + dynamic imports + wallet constraint). Sprint 3 son
cambios de mayor magnitud que requieren PRs dedicados con revisión cuidadosa.

## Estado actual

| Sprint | Estado | Highlight |
|---|---|---|
| 1 — Bugs P0 | ✅ DONE | companyId fix, reports fallback, roles whitelist, env validation |
| 2 — Foundation | ✅ DONE | Vitest + 26 tests, GitHub Actions CI, dynamic imports, wallet scope |
| 3 — Estructural | 🟡 IN PROGRESS | Este documento |

## Sprint 3 — Refactores estructurales

### Item A: Particionar DataProvider en hooks por dominio

**Problema:** `src/lib/data-context.tsx` carga 18 tablas en cold load por cada
navegación. Páginas como `/perfil` no usan ninguno. `fetchCommercialMonthlyResults`
tiene `.limit(10000)` y se carga aunque la página actual no muestre comisiones.

**Aproximación:**
1. Crear `src/lib/data/core-context.tsx` con SOLO `company`, `periods`, `expenseTemplates`,
   `partners` (todo lo que toda página potencialmente necesita).
2. Crear hooks dominio-específicos en `src/lib/data/`:
   - `useDepositsData()` (deposits, withdrawals, propFirmSales, p2pTransfers)
   - `useExpensesData()` (expenses, preoperativeExpenses)
   - `useIncomeData()` (operatingIncome, brokerBalance, financialStatus)
   - `useHRData()` (employees, commercialProfiles, monthlyResults)
   - `useLiquidityData()` (liquidityMovements, investments, partnerDistributions)
3. Cada hook usa SWR/TanStack Query con stale-while-revalidate para que el
   refresh post-mutación no detenga al usuario.
4. Migrar páginas una a una al nuevo patrón; eliminar referencias del DataProvider monolítico.
5. Cuando solo queden `core-context` users, deprecar `data-context.tsx`.

**Estimado:** 1-2 semanas. Migrar en este orden:
- /perfil, /usuarios (no usan nada de los hooks pesados — quick wins)
- /balances (lectura)
- /resumen-general (lectura)
- /movimientos
- /upload (último — el más complejo)

**Beneficio:** -70% datos cargados en navegación promedio. Cold load <500ms.

### Item B: Romper `upload/page.tsx` (2,765 líneas)

**Problema:** Página monolítica con 45 `useState`, 11 `useEffect`. Imposible
code-review, propenso a regresiones (de aquí vienen casi todos los bugs del
último mes). Compila lento — requiere `NODE_OPTIONS=--max-old-space-size=8192`.

**Aproximación:**
1. Extraer custom hooks en `src/app/(dashboard)/upload/_hooks/`:
   - `useDepositsForm(periodId, company)` — local state + handlers + savingDepositIds
   - `useWithdrawalsForm(periodId, company)` — idem
   - `useExpensesForm(periodId, company)` — idem
   - `useIncomeForm(periodId, company)`
   - `useLiquidityRows(filter)` — la lista paginada
   - `useInvestmentsRows(filter)`
   - `useDirtyTracking()` — el Set granular y beforeunload
2. Extraer sub-componentes en `src/app/(dashboard)/upload/_components/`:
   - `<DepositsTable />`, `<WithdrawalsTable />`, `<ExpensesTable />`, `<IncomeForm />`
   - `<LiquidityPanel />`, `<InvestmentsPanel />`, `<DocsPanel />`
   - `<SectionTabs />`, `<UnsavedBanner />`, `<SaveAllButton />`
3. `page.tsx` queda como orchestrator de ~200 líneas.

**Estimado:** 2-3 días + day de regression testing.

**Beneficio:** code-reviews humanos viables. Compile time -40%. Bugs aislados por sección.

### Item C: Migrar reads de /balances y /resumen-general a Server Components

**Problema:** Esas dos páginas son principalmente lectura. Hoy cargan
DataProvider en cliente, lo cual hidrata 18 tablas antes de renderizar.

**Aproximación:**
1. Convertir `page.tsx` a server component (Next 16 App Router).
2. Fetch directo desde el servidor con `createServerClient` (passing through cookies).
3. Pasar datos pre-renderizados como props. Mantener componente cliente
   solo para charts interactivos.

**Estimado:** 2 días.

**Beneficio:** First Contentful Paint <1s. Sin "Cargando…" inicial.

### Item D: Migrar writes a `/api/admin/*` (eliminar mutations en cliente)

**Problema:** Mix de patrones — algunos writes van por browser (Supabase JS),
otros por admin endpoint. El comentario "ya no usamos browser-side update
porque RLS no veía la escritura del superadmin viewing-as" aparece 4 veces
en `auth-context.tsx`. Cada parche de RLS introduce regresiones nuevas.

**Aproximación:**
1. Inventario de todos los writes en `src/lib/supabase/mutations.ts`.
2. Para cada uno, crear `/api/<tenant|admin>/<resource>/<verb>/route.ts`.
3. Cliente usa `fetch()` en lugar de `supabase.from().insert/update/delete`.
4. RLS-on-write se simplifica: client solo necesita SELECT permitido, el
   resto pasa por service-role en el server con verificación de auth + ownership.
5. Beneficio adicional: audit-log centralizado, rate-limit por endpoint.

**Estimado:** 1 semana.

**Beneficio:** Predictabilidad. Auditabilidad. Eliminación de regresiones por RLS.

## Quick wins ya aplicables (este PR)

Aplicables sin breaking change:
- Eliminar import muerto `fetchCompany` de `data-context.tsx`.
- Centralizar magic numbers de `data-context.tsx` en `src/lib/config.ts`.
- Cerrar `clipboard-write` en `Permissions-Policy`.

## Orden recomendado

1. PR S3-1: Quick wins + Item A migración inicial (/perfil + /usuarios).
2. PR S3-2: Item A completar (resto de páginas).
3. PR S3-3: Item B `upload/page.tsx` split.
4. PR S3-4: Item C Server components.
5. PR S3-5: Item D writes a admin endpoints.

Cada PR debe:
- Pasar tests existentes
- Agregar tests específicos para su scope
- Documentar cambios en changelog
- Tener feature flag si el riesgo es alto (ej. nuevo DataProvider behind `NEXT_PUBLIC_USE_PARTITIONED_DATA=true`)
