# Módulo Liquidez (superadmin) — Reporte de Fase 1: Diagnóstico

> Investigación previa a escribir código, hecha el **2026-08-28**.
> **No se creó ni modificó ningún archivo del proyecto.** Solo lectura y consultas.
>
> Hay **3 hallazgos que cambian el plan original** y hay que decidirlos antes de
> pasar a la Fase 2.

---

## 🚨 Bloqueante 1 — La tabla `liquidity_accounts` YA EXISTE

```
liquidity_accounts: 23 filas en producción (Vex Pro)
columnas: id, company_id, mt_number, label, is_active, created_at, updated_at
```

Pertenece al módulo **/liquidez → Conciliación**, que ya está en producción. La usan:

- `src/app/api/admin/liquidity-reconcile/route.ts`
- `supabase/migration-062-inversiones-liquidez-estructura.sql`

### Por qué importa

El `CREATE TABLE IF NOT EXISTS liquidity_accounts` del plan **se saltaría en
silencio** (la tabla ya existe) y después el módulo nuevo fallaría, porque las
columnas no coinciden:

| Plan nuevo | Tabla existente |
|---|---|
| `mt5_account` | `mt_number` |
| `user_email`, `mt5_group`, `balance`, `equity`, … | *(no existen)* |
| `status` | `is_active` |

Y si alguien intentara "arreglarlo" con un `ALTER TABLE`, **rompería la
conciliación existente** — que es exactamente lo que las reglas de aislamiento
buscan evitar.

### Propuesta

Renombrar las tablas nuevas:

- `liquidity_accounts` → **`platform_liquidity_accounts`**
- `liquidity_monthly_pnl` → **`platform_liquidity_monthly_pnl`**

El prefijo `platform_` refleja que es un módulo de plataforma (superadmin), y lo
distingue del módulo de liquidez de las empresas.

**Decisión pendiente:** ¿te sirve ese nombre, o preferís otro?

---

## 🚨 Bloqueante 2 — Las operaciones NO están en MongoDB

El plan asume que el PnL sale de MongoDB. **No es así.**

| Fuente | Qué contiene realmente |
|---|---|
| **MySQL (MT5)** | `mt5_deals` ← **las operaciones**, `mt5_users`, `mt5_accounts`, `mt5_positions` |
| **MongoDB (Orion)** | `users`, `wallets`, `wallettransfers`, `tradingaccounts`, `ibrewards`, `socialtradingaccounts`, `withdrawalpropfirms`, `userpropfirms`, `propfirm_audit_reports`, `ib_reward_daily` |

Mongo es el **CRM**: no tiene ninguna colección de deals, orders, trades ni
positions.

### Dónde sale el PnL

De **MySQL `mt5_deals`**, sumando `Profit + Storage (swap) + Commission`. Es
exactamente lo que ya hace `src/lib/mt5-sync/pnl.ts`, que además tiene resueltas
tres trampas conocidas de esa tabla:

- Filtrar por **`TimeMsc`** (indexada) y **contra fechas**, nunca por `Timestamp`
  (es FILETIME: comparado contra un epoch devuelve la tabla entera) ni `Time`
  (sin índice: 31 s por consulta).
- **`Entry IN (1,3)`** — la ganancia realizada vive en el deal de salida.
- **`Action IN (0,1)`** — sin este filtro, los depósitos (`Action = 2`) entran
  como si fueran ganancia. Medido: suman 425 millones.

### Consecuencia

El cálculo de PnL va contra **MySQL**. Mongo solo haría falta si se quiere el
email del CRM en lugar del de MT5 (ver duda 2 más abajo).

---

## 🚨 Bloqueante 3 — Las credenciales no están en variables de entorno

El plan propone leer `VEXPRO_MYSQL_URL` / `VEXPRO_MONGO_URL`. **No existen.**

Las credenciales viven **cifradas en Supabase**, en la tabla `api_credentials`,
una fila por (empresa, proveedor):

```
Vex Pro     mt5_sql       configurada: true
Vex Pro     orion_mongo   configurada: true
AP Markets  orion_mongo   configurada: true
```

### Y ya hay clientes construidos

| Cliente | Archivo |
|---|---|
| `withMt5Connection(companyId, fn)` | `src/lib/api-integrations/mt5-sql/client.ts` |
| `withOrionMongo(companyId, fn)` | `src/lib/api-integrations/orion-mongo/client.ts` |

No son envoltorios triviales: resuelven las credenciales cifradas por empresa,
salen por **IP fija** a través de un proxy SOCKS5 (el hosting del broker filtra
por IP), fuerzan **solo-lectura en tres capas**, aplican timeouts cortos y
**redactan las contraseñas** de los mensajes de error.

### Propuesta

**Reutilizar los clientes existentes** en vez de crear `src/lib/external-db/*`.
Crear una segunda conexión duplicaría toda esa lógica — y el propio repo declara
que *"listas duplicadas que se desincronizan en silencio son el modo de falla
número uno"*.

El módulo nuevo solo los **importa**; no los toca.

---

## ✅ Lo que ya está resuelto

| Ítem | Estado |
|---|---|
| `mysql2` ^3.23.4 · `mongodb` ^7.5.0 | ✅ instaladas — **no hace falta `npm install`** |
| `verifySuperadminAuth()` | ✅ existe en `src/lib/api-auth.ts:400` (no recibe parámetros) |
| Company **Horizon** | ✅ `f5c0a533-fca0-4b1e-8f42-c42f8f24d524` |
| Company **Horizon Global** | ✅ `bf5cb9ea-b5c0-40b6-b3c7-60ad852f3114` |
| Company **Vex Pro** | ✅ `71715987-5479-52c4-a990-c414fb3a9b36` |
| `liquidity_monthly_pnl` | ✅ no existe — se puede crear (con el nombre nuevo) |

### Columnas disponibles en MySQL (ya usadas por el proyecto)

| Tabla | Columnas |
|---|---|
| `mt5_users` | `Login`, `Email`, `Group`, `Balance`, `Registration` |
| `mt5_accounts` | `Equity`, `Balance`, `Margin`, `MarginFree`, `MarginLevel`, `Profit` |
| `mt5_deals` | `Login`, `TimeMsc`, `Entry`, `Action`, `Profit`, `Storage`, `Commission` |

Cubre todo lo que pide el módulo: número de cuenta, email, grupo, balance,
equity y fecha de creación.

---

## ⚠️ Problema práctico con "trabajo solo en local"

El hosting del broker **filtra por IP**. Probado el 2026-08-24: el MySQL de
Vex Pro acepta la IP de Kevin y las dos del proxy Fixie
(`3.224.144.155`, `3.223.196.67`), pero **no las de Vercel**, que son dinámicas.

En producción la conexión se tuneliza por SOCKS5; en local va directa.

👉 **Si tu IP no está autorizada, desde local no vas a poder consultar MySQL** y
el módulo se verá vacío o con error de conexión. Conviene confirmarlo antes de
invertir en la UI.

---

## ❓ Dos dudas del spec

1. **`connection_date`** — ¿es la fecha en que se agrega la cuenta al módulo, o
   la fecha de creación de la cuenta en MT5 (`mt5_users.Registration`)?
   El PnL se calcula desde ahí, así que cambia el resultado.

2. **`user_email`** — ¿el de MT5 (`mt5_users.Email`) o el del CRM (Orion
   `users`)? Si alcanza con el de MT5, **Mongo no hace falta para nada** en este
   módulo.

---

## Estado de aislamiento

- ✅ **No se creó ni modificó ningún archivo** del proyecto (salvo este
  documento).
- ✅ **No se ejecutó ningún SQL.**
- ✅ **No se instaló ninguna librería.**
- ✅ `npx tsc --noEmit` sin cambios respecto del estado previo.
- ✅ **No se hizo commit ni push.**

---

## Próximo paso

Esperando decisión sobre:

1. Nombre de las tablas nuevas (`platform_liquidity_*` u otro)
2. Confirmación de que el PnL sale de **MySQL**, no de Mongo
3. Confirmación de **reutilizar** `withMt5Connection` / `withOrionMongo` en vez
   de crear conexiones nuevas
4. Las dos dudas del spec (`connection_date` y `user_email`)

Con eso se puede armar la Fase 2 (el SQL de las tablas).
