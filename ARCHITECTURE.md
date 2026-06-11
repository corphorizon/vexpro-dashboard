# Arquitectura — Smart Dashboard (VexPro / white-label)

> Documento vivo. Generado en Fase 2 del saneamiento técnico (2026-06-11).
> Objetivo: que cualquier ingeniero nuevo (o Claude en una sesión fría) entienda
> el sistema sin leer 2.800 líneas de un componente. Si algo acá ya no es cierto,
> corregilo en el mismo PR que lo cambió.

## 1. Qué es

Dashboard financiero multi-tenant (SaaS white-label) para brokers / prop firms.
Cada empresa (VexPro, AP Markets, Exura, VONIX…) ve solo sus datos. Un
**superadmin** puede "ver como" otra empresa vía `?company_id=`.

Maneja: depósitos/retiros por canal, egresos, liquidez, inversiones, comisiones
de la fuerza comercial (BDM/HEAD), balances consolidados, reportes
diario/semanal/mensual, e integraciones con APIs de pago (Coinsbuy, FairPay,
UniPayment) + Orion CRM.

## 2. Stack

| Capa            | Tecnología                                              |
|-----------------|---------------------------------------------------------|
| Framework       | Next.js 16 (App Router) — **ojo: ver `AGENTS.md`**, esta versión tiene breaking changes vs. lo conocido |
| Lenguaje        | TypeScript + React                                      |
| Estilos         | Tailwind + variables CSS de tema (claro/oscuro)         |
| Backend/DB      | Supabase (Postgres + Auth + Storage + RLS)              |
| Deploy          | Vercel (auto-deploy en push a `main`)                   |
| Errores         | Sentry                                                  |
| Tests           | Vitest (`src/**/*.test.ts`, entorno node)               |
| i18n            | Custom (`src/lib/i18n.tsx`) — ES/EN                     |

> **Next.js 16:** antes de escribir código de framework, leé la guía relevante en
> `node_modules/next/dist/docs/`. No asumas APIs de versiones anteriores.

## 3. Multi-tenancy y seguridad (lo más importante)

- **`company_id` SIEMPRE sale del token de auth**, nunca del input del usuario,
  salvo el caso superadmin "viewing-as" (`?company_id=`), que está gateado por
  `is_superadmin()`.
- **RLS activo** en todas las tablas de negocio + funciones helper
  `SECURITY DEFINER`: `auth_can_edit`, `is_superadmin`, `auth_company_ids`.
  El `search_path` de estas funciones está endurecido (Fase 1).
- Las rutas `/api/admin/*` usan el **admin client** (service role) y validan
  permisos en código; las rutas `/api/superadmin/*` exigen `is_superadmin`.
- **Lección Fase 1:** una tabla con RLS deshabilitado + grant a `anon` =
  account-takeover. Toda tabla nueva nace con RLS y sin grants a `anon`.

## 4. Mapa de rutas (`src/app/(dashboard)/`)

| Ruta              | Qué hace |
|-------------------|----------|
| `upload`          | Carga manual de datos del período (depósitos, retiros, egresos, liquidez, inversiones). El archivo más grande del repo. |
| `comisiones`      | Cálculo y guardado de comisiones BDM/HEAD. Lógica de plata → ver §6. |
| `movimientos`     | Vista de movimientos (manual + API en coexistencia). |
| `balances`        | Balances por canal + Net Deposit consolidado. |
| `finanzas`, `egresos`, `liquidez`, `inversiones`, `resumen-general` | Vistas financieras derivadas. |
| `socios`          | Distribución entre socios (depende del Net Deposit — sensible). |
| `periodos`        | ABM de períodos mensuales. |
| `rrhh`, `perfil`, `usuarios`, `risk` | Soporte / administración. |

API: `src/app/api/` — `admin/*` (gestión interna), `superadmin/*` (cross-tenant),
`integrations/*` (Coinsbuy/FairPay/UniPayment/Orion), `cron/*` (snapshots y
reportes programados), `auth/*` (login, 2FA, reset).

## 5. Integraciones de pago — patrón de COEXISTENCIA

Regla central (no romper): **las transacciones de API y las entradas manuales
SE SUMAN, no se reemplazan.** Un período puede tener ambas. Hook:
`src/lib/use-api-coexistence.ts`.

Las APIs (Coinsbuy/FairPay/UniPayment) se scopean a las **wallets pinneadas**
(`pinned_coinsbuy_wallets`). Net Deposit y reportes cuentan SOLO esas wallets,
no todas.

## 6. Lógica financiera canónica (fuente de verdad única)

> Esta sección existe porque hubo un bug (2026-06-07) donde `/balances` y
> `/movimientos` calculaban el Net Deposit distinto y divergían en la
> distribución a socios. La regla ahora vive en UN solo lugar, con tests.

### Net Deposit — `src/lib/broker-logic.ts`

`computeDerivedNetDeposit()` es la **única** función que calcula Net Deposit en
la era derived-broker (Abr 2026+). La importan `/movimientos`, `/balances` y los
reportes — no pueden divergir.

```
Depósitos totales = API (cb+fp+up, scoped a wallets pinneadas) + manual (/upload)
Retiros totales   = API withdrawals (Coinsbuy payouts) + manual "broker"
Net Deposit       = depósitos − retiros
IB / Prop Firm / Otros manuales = INFORMATIVOS (NO se suman a retiros)
```

**Broker derivado (Abr 2026+):** el retiro "broker" ya no se carga a mano; se
deriva de la API. Períodos ≤ Mar 2026 mantienen su valor manual histórico
(`isDerivedBrokerPeriod()` decide cuál usar). Las filas históricas en DB nunca
se reescriben.

### Comisiones — `src/lib/commission-calculator.ts`

Núcleo testeado que paga a la fuerza comercial:
- `calculateCommission`: PnL normal → división = ND/2, comisión = (división + acumulado) × pct, arrastra acumulado al mes siguiente.
- Tiers de salario (BDM/HEAD) y % (BDM) — sin gaps ni solapamientos.
- `calculateHeadDifferential`: el HEAD cobra el diferencial (head_pct − bdm_pct) sobre la división de cada BDM.
- `calculatePnlSpecial`: modo aislado, sin dividir entre 2, NUNCA acumula.
- `applyTotalEarnedDebt`: arrastra deuda de grupo vía el campo `bonus` del HEAD.

### Helpers de carga — `src/lib/upload-calculations.ts`

`parseAmount` (parseo robusto de inputs) y `computeExpensePending`
(pendiente = explícito || monto − pagado). Extraídos de `/upload` y testeados.

> **Cualquier cambio en una fórmula de plata va acompañado de un test.** Estos
> módulos tienen cobertura justamente para que un refactor no cambie ni un centavo.

## 7. Estado y contextos (React)

- `data-context.tsx` — carga y cachea los datos de la empresa activa (`loadAllData`).
- `auth-context.tsx` — sesión, permisos (`canAdd/canEdit/canDelete`).
- `period-context.tsx` — período seleccionado.
- `theme-context.tsx` / `i18n.tsx` — tema e idioma.

## 8. Base de datos

Postgres en Supabase. ~45 migraciones en `supabase/*.sql` (orden por número).
Tablas clave: `periods`, `deposits`, `withdrawals`, `expenses`,
`liquidity_movements`, `investments`, `commercial_profiles`,
`commercial_monthly_results`, `api_transactions`, `pinned_coinsbuy_wallets`.

**Notas operativas:**
- Las queries grandes (`api_transactions`) llevan `.limit(10000)` defensivo y
  están scopeadas por `company_id` + rango de fecha. El mes pico real (VexPro
  May-2026) fue ~2.600 filas → ~3.8x de headroom. No es paginación real; si
  alguna empresa se acerca a 10K en una ventana, hay que paginar de verdad.
- Tablas `*_backup_*` / `*_purge_*` son respaldos manuales de operaciones
  puntuales — NO se dropean sin confirmar que el rollback ya fue validado.

## 9. Accesibilidad — estado y deuda (audit 2026-06-11)

Heurística sobre 83 componentes `.tsx`:

| Check | Estado |
|-------|--------|
| `<img>` sin `alt` | ✅ 0 |
| `lang` en `<html>` | ✅ presente (`es` — hardcodeado; ver deuda) |
| Uso de `aria-*` / `role` | ✅ 148 ocurrencias, 33 componentes con `aria-label` |
| `<input>` sin `id`/`aria-label` programático | ✅ **resuelto** (2026-06-11) — se agregó `aria-label` a ~73 controles |

**Deuda priorizada:**
1. ~~Inputs sin etiqueta programática~~ — ✅ **hecho**. Se agregó `aria-label`
   (reusando la key i18n del placeholder/label) a inputs/selects/textarea de
   `rrhh`, `rrhh/perfil`, `upload`, `comisiones` y `risk`. Los checkbox/file ya
   envueltos en `<label>` (asociación implícita) se dejaron intactos.
2. **`lang="es"` hardcodeado** — la app es ES/EN; el `lang` debería seguir al
   idioma activo de i18n para pronunciación correcta del lector de pantalla.
3. Verificar contraste de color en estados de tema oscuro (no auditado acá).

## 10. Tests

`npx vitest run` — 76 tests (Jun-2026). Cubren la lógica de plata
(`broker-logic`, `commission-calculator`, `upload-calculations`) + auth/env.
Convención: lógica pura en `src/lib/*.ts`, su test al lado en `*.test.ts`.
Los componentes (JSX) no tienen tests de render hoy — la estrategia es
**extraer la lógica pura y testear eso**, no testear el árbol de React.

## 11. Deuda técnica conocida (al cierre de Fase 2)

- `upload/page.tsx` (~2.850 l.) y `comisiones/page.tsx` (~1.920 l.) siguen
  siendo componentes grandes. La **lógica de cálculo ya está extraída y testeada**;
  lo que queda es JSX/view-model. Partirlos en sub-componentes es refactor
  cosmético de riesgo medio — hacerlo con QA manual de ambas pantallas.
- Accesibilidad de formularios (§9).
- Paginación real de `api_transactions` cuando el volumen lo amerite (§8).
