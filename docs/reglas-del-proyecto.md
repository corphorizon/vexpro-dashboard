# Cómo se trabaja en Smart Dashboard

> Consolidado el **2026-08-27** a partir de un estudio completo del código, las
> migraciones y el historial. Es el mapa que hay que leer **antes** de tocar
> algo, para no romper lo que ya funciona.
>
> Lo que hace especial a este repo es que **el porqué está escrito en el código**,
> con la medición que lo justifica. Este documento no reemplaza esos comentarios:
> es el índice que dice dónde mirar y qué no tocar.

---

## 0. Antes de tocar nada

1. `git pull` — el repo se mueve rápido (90 commits en una semana de agosto).
2. Leer la **cabecera del archivo** que vas a tocar. Casi siempre explica por qué
   está así, con fechas, nombres y números medidos.
3. Buscar si hay un **test** que fije el comportamiento. Si lo hay, el
   comportamiento es intencional aunque parezca raro.
4. `AGENTS.md`: este NO es el Next.js que conocés. Next 16 tiene breaking
   changes — leer `node_modules/next/dist/docs/` antes de escribir código de
   framework.

### El número de una migración se elige AL MERGEAR, no al empezar

Ya chocó **tres veces**: dos ramas trabajando en paralelo eligen el mismo número
y quedan dos archivos distintos con el mismo prefijo. La última vez terminó con
`105` y `106` duplicados —Liquidez contra PayPros y CRM— y ambos aplicados.

No rompe datos, porque cada archivo se corre a mano. Rompe otra cosa: el número
deja de decir qué corrió primero, que es para lo único que sirve.

- Antes de mergear: `git fetch` y `ls supabase/migration-*.sql | tail -3`.
- Si el número ya está tomado, **renumerar y avisarlo en el commit**.
- Las migraciones renumeradas llevan en su primera línea la fecha REAL de
  aplicación, porque el número ya no la cuenta.

---

## 1. La doctrina

### 1.1 El modo de falla número uno

> *"Listas duplicadas que se desincronizan en silencio son el modo de falla
> número uno de este repo."*
> — `src/lib/modules.ts:144`, repetido literal en `business-model.ts:10`

De ahí sale el patrón de **registro único**: `roles.ts`, `modules.ts`,
`business-model.ts`, `channel-configs.ts`, `notifications/catalog.ts`,
`credentials.ts`. Cada uno lleva un comentario enumerando las copias que
existían antes y qué se rompió cuando divergieron.

**Regla:** si tu feature introduce un módulo, rol, proveedor o categoría,
agregalo a la lista canónica. **Nunca** crees una segunda lista.

### 1.2 El enemigo real: el fallo que no da error

Casi todos los bugs graves de este proyecto **no lanzaron ninguna excepción**.
Devolvieron un número plausible y equivocado:

| Qué pasó | Síntoma | Dónde |
|---|---|---|
| `Timestamp >= UNIX_TIMESTAMP()` | 68 M de filas "con cara de dato bueno" | `mt5-sync/pnl.ts:4-19` |
| Escape de barra insuficiente en un `LIKE` | PropFirm **desaparece** del informe | `pnl.ts:54-58` |
| Falta `Action IN (0,1)` | un depósito entra como ganancia (425 M en `Action=2`) | `pnl.ts:28-33` |
| Cuentas de prueba sin filtrar | el PNL del día se infla de 6.198 a 12.836 | `crm-sync/account-scope.ts:8-18` |
| Cursor sin desempate | una página se salta filas | `partner/v1/trading-activity/route.ts:144-152` |
| Tiers como techo en vez de piso | 7% pactado cobrando 5%, en silencio | `commission-calculator.ts:260-271` |
| `.or()` con `.limit()` compartido | recorte silencioso al pasar de ~495 filas | `withdrawal-risk/query.ts:349-353` |

**Corolario operativo, escrito 4 veces en el código:** *una exclusión silenciosa
es indistinguible de un cruce roto*. Hay que **contar lo excluido y avisar**.
Y: *un recorte silencioso es indistinguible de "no hay más"* → todo límite de
filas necesita un flag `truncated` que llegue hasta la UI.

### 1.3 `null` y `0` no son lo mismo

`null` = "no se calculó / no lo sabemos". `0` = "es cero". Mezclarlos rompe en
silencio: un cliente con $4.000 se muestra en cero, y "no operó" se confunde con
"no lo sabemos". Ver `partner/v1/customers/route.ts:8-13`,
`migration-093:15-27`, `withdrawal-risk/features.ts` (un dato faltante **nunca**
es un indicio en contra del cliente).

---

## 2. Reglas que no se rompen — DINERO

> Esta es la sección más peligrosa del repo. Cada línea de acá es un bug que ya
> pagó mal.

### 2.1 Comisiones (`src/lib/commission-calculator.ts`)

| # | Regla | Si lo rompés |
|---|---|---|
| 1 | `realPayment = commission`, **sin clamp a 0** | Pagás de más: una comisión negativa **es** deuda del BDM |
| 2 | Con `ND = 0` → `accumulatedOut = accumulatedIn` | **Destruís el acumulado** (un BDM pierde $50.000 arrastrados por un mes sin depósitos) |
| 3 | `Math.max(tierPct, profilePct)` | El tier es **piso por volumen, nunca techo**. Romperlo = 7% pactado cobrando 5% |
| 4 | Tablas de tiers ordenadas **descendente** | El `for` corta en el primer match: desordenarlas da el tier equivocado |
| 5 | `calculatePnlSpecial` **aislada** de `calculateCommission` | Unificarlas contamina el cálculo normal |
| 6 | `bonus` **es deuda arrastrada**, no un bono | Exponerlo como editable borra deuda real |
| 7 | El diferencial del HEAD **nunca es negativo** | El head "paga" por el buen mes de su BDM |
| 8 | `extra_pct` solo aplica con diferencial natural **exactamente 0** | — |

**Un mismo número (lo que cobra una persona en un mes) tiene que salir del mismo
camino**, lo pida la tabla, el guardado o el PDF. Ese es el invariante que dejó
la auditoría A3.

### 2.2 Distribución a socios (`src/lib/distribution.ts`)

- **Es la única fuente.** Hubo dos implementaciones divergentes (BUG-01); el test
  `distribution-contract.test.ts` existe para que no vuelva a pasar:
  *"UNA SOLA VERDAD POR NÚMERO"*.
- La cadena es **secuencial**: hay que procesar **todos** los períodos en orden
  cronológico, o el arrastre de deuda/reserva diverge.
- Mes negativo: **la reserva NO se drena** (modelo "cuenta de ahorro").
- `investmentProfits` **sí** entra en la base distribuible (decisión de Kevin).
- Base **caja** de egresos solo en los modelos con `features().cashBasisExpenses`
  (hoy: `company`); en `broker` y `liquidity_provider` es devengado (aplicar caja
  donde no se carga `paid` **infla** la base). La pregunta se le hace al registro,
  no a un `=== 'company'` suelto.
- **`liquidity_provider` no participa de la cadena**: es un modelo informativo
  (pool de liquidez + inversiones) sin `partners` ni `payment_orders`, así que
  ninguna pantalla muestra un reparto suyo.
- Retiros de prop firm se **suman**, nunca `.set()`.
- El `amount` guardado en `partner_distributions` **nunca se lee**: se deriva
  siempre.

### 2.3 Cierre de período

Al cerrar se congelan los **INSUMOS**, no el resultado — porque la fórmula vive
solo en `distribution.ts` y duplicarla en SQL crearía dos copias que se separan.

> ⚠️ **Corolario que el repo no enuncia:** como se congelan insumos y no
> resultados, **cambiar `distribution.ts` recalcula retroactivamente todos los
> períodos cerrados**, incluida la plata ya distribuida. No hay protección
> contra eso. Tratá cualquier cambio de fórmula como una migración de datos.

### 2.4 La trampa de `replace_period_expenses`

La RPC **borra e inserta el período entero** desde el payload del cliente.
Cualquier columna nueva que no viaje en el payload **se pierde en silencio en el
próximo guardado**.

Agregar una columna a `expenses` obliga a tocar **cuatro** lugares a la vez:
1. `upload/page.tsx` (hidratar el estado)
2. `lib/supabase/mutations.ts` (armar el payload)
3. `api/admin/expenses/route.ts` (mapeo server-side)
4. La RPC, en una migración nueva

Ya se perdieron así: `expense_date`, `payment_order_id`, y los adjuntos.

**Y la regla de fondo** (migración 079, tras perder $1.700 reales):
> *"La plata no puede depender de la corrección del navegador."*
> El filtro va **server-authoritative y simétrico** (DELETE **e** INSERT).

---

## 3. Reglas que no se rompen — MT5 y datos externos

| # | Regla | Por qué |
|---|---|---|
| G1 | **Cuenta no vinculada al CRM no entra a ninguna cifra** | 1.140 cuentas de prueba operan igual que un cliente; sin filtrar, el PNL se duplica |
| G2 | **Nunca escribir en la base del broker** | Usuario read-only + verificación de grants + sesión read-only + `multipleStatements:false` |
| G3 | **El dinero NUNCA se suma entre familias** | Las Cent están en centavos: sumar da 101 M contra 7,6 M reales. Los **conteos y lotes sí** se suman |
| G4 | Toda fecha de MT5 pasa por **`mt5DateUtc()`** | `new Date(texto)` depende de la zona del proceso: producción acertaba *de casualidad* |
| G5 | Filtrar `mt5_deals` por **`TimeMsc` contra fechas** | `Timestamp` es FILETIME (devuelve todo); `TimeMsc` contra número devuelve 0 filas |
| G6 | Agregar **solo columnas del índice** | Sumar `Volume` pasa de 345 ms a 13.221 ms (38×) |
| G7 | Excluir las demo de las cifras, **pero espejarlas marcadas** | Para poder auditar la exclusión |
| G8 | **Contar lo excluido y avisar** | Ver §1.2 |
| G10 | **Nunca consultar MT5 en vivo desde una pantalla** | Abrir el túnel cuesta ~3,5 s y sería una conexión al broker por visita |
| G11 | Los tests de SQL prueban el **texto** de la consulta | Un test contra la base pasaría igual el día que el escape se rompa: *cero filas y cero PropFirm se ven idénticos* |

**El escape de la barra invertida falló DOS veces** (la segunda después de estar
documentado). La solución de raíz es `ESCAPE '~'` — *"contar barras no es una
técnica"*. Ver `copy-detection.ts:57-74`.

### 3.1 El contrato con aplicativos externos (Atlas)

**Smart Dashboard es el único que habla con MT5.** Una puerta, una IP que
autorizar, una contraseña que rotar.

| MT5 **sí** manda | MT5 **NO** manda (siguen en Orion) |
|---|---|
| `accounts`, `tradeCount`, `firstTradeAt`, `lastTradeAt`, `balance`, `equity` | `totalDeposits`, `depositCount`, `lastDepositAt`, `totalWithdrawals`, `walletBalance` |

Depósitos y retiros son movimientos **de la plataforma**; MT5 solo ve las
transferencias internas billetera → cuenta. El riesgo que esto evita es
concreto: **dos números distintos en pantalla delante de un agente hablando con
el cliente**.

**Qué importe usar** (medido sobre 17.776 depósitos y 12.061 retiros):
- Depósitos → `amountPaid` (lo que llegó), no `depositValue` (lo declarado, y
  además **está corrupto**: máximo 1,4e16).
- Retiros → `requestedAmount` (lo que sale de la billetera). El desempate contra
  `wallettransfers` fue **2.978 a 0**.

**Aviso para cualquier detector nuevo:** el primer barrido ve todo el histórico
como si acabara de pasar. A Atlas le disparó **45 traspasos automáticos** con
7.054 depósitos viejos. **Anclar el valor inicial antes de encender el
detector.**

---

## 4. Reglas que no se rompen — PERMISOS

### 4.1 La regla central

> **Leer** lo decide el **MÓDULO** · **Escribir** lo sigue decidiendo el **ROL**

El caso real que lo motivó: *Sergio, socio de Vex Pro, entró el 2026-08-22 con
seis módulos marcados y no pudo leer ninguno.* La doctrina escrita era falsa y el
comentario lo admite en primera persona (`roles.ts:46-66`).

**Las tres puertas que no se abren** (`api-auth.ts:163-171`):
1. `requireAdmin` gana siempre (ciclo de vida de usuarios).
2. Sin `modules:` declarados **no se relaja** el rol.
3. Sin `request` (sin método) **no se relaja**: ante la duda, lo estricto.

### 4.2 Multi-tenant

- `company_id` **siempre** del token, nunca del input. Excepción: superadmin con
  `?company_id=` **en el query string** (nunca en el body).
- Con el admin client (service role) **RLS no aplica** → `.eq('company_id', …)`
  explícito en **toda** query.
- El spread del body va **antes** del `company_id`, nunca después (un body con
  `company_id` ajeno escribía cross-tenant).
- En el cliente: `apiFetch()`, nunca `fetch` pelado — *llamar a fetch directo
  rompe el "ver como"*.

### 4.3 Segregación de funciones (revisión de retiros)

> *"Soporte triajea y escala, el auditor aprueba. Quien atiende al cliente que
> reclama su retiro no debería ser quien libera el dinero."*

Y la regla de oro del módulo, declarada en **cinco capas independientes**:
**el dashboard NO ejecuta el retiro en el CRM. Nunca.** La respuesta lleva
`executedInCrm: false` como campo tipado.

**El score nunca decide.** Es orientación para mirar primero lo que más lo
merece. Aprobar o rechazar lo firma una persona.

---

## 5. Cómo se construye una feature acá

1. **Registro único primero** — si introducís módulo/rol/proveedor, va a la lista
   canónica. Nunca una segunda lista.
2. **Migración** `supabase/migration-NNN-descripcion.sql`, idempotente, con
   cabecera que explique el porqué. Tabla nueva → `enable row level security` +
   policy SELECT por `auth_company_ids()`; sin policies de escritura si escribe
   el cron. RPC nueva → `revoke all ... from public, anon`.
3. **Ruta** — `verifyAdminAuth(request, { roles: <DOMINIO>, modules: ['<key>'] })`
   + `if (auth instanceof NextResponse) return auth;`
4. **Errores** — `apiError('contexto', err, { status })`. Nunca `error.message`
   al cliente. Secretos redactados antes de salir.
5. **Auditoría** — `serverAuditLog()` en las escrituras sensibles.
6. **Cliente** — `apiFetch()` y `useModuleAccess('<key>')`.
7. **i18n** — la clave nueva va en **`en` y `es`**.
8. **Test** — extraé la decisión a una función pura y testeala, con **la mitad de
   los casos negativos**, e iterando sobre el registro único (así agregar un rol
   rompe el test en vez de pasar desapercibido).
9. **Comentario de cabecera** con el porqué, la medición y **lo que descartaste**.
   Y el mismo texto, ampliado, como mensaje de commit.

### 5.1 Patrón de cron

```ts
export const maxDuration = 300;           // según lo medido
const expected = process.env.CRON_SECRET;
if (!expected) return 500;                // fail-closed: sin secreto NO pasa
if (auth !== `Bearer ${expected}`) return 401;
```
La frecuencia se justifica con una medición, no con una corazonada. Y cada tarea
va en su **propio `try/catch`**: si la base del broker no responde, lo demás
sigue.

### 5.2 Estilo de comentarios

El estándar del repo, en orden de importancia:
1. **La anécdota concreta**, con fecha, nombre y cifra. No "esto podría fallar",
   sino "el 2026-08-22 le pasó esto a Sergio".
2. **La medición** que justifica la decisión (ms, filas, dólares, %).
3. **Lo que se descartó y por qué.**
4. **La confesión**: si un comentario viejo era falso, se corrige *en el mismo
   lugar* diciendo que era falso — no se borra.

---

## 6. Histórico vs. en vivo (dónde está el riesgo)

| Zona | Fuente | Riesgo |
|---|---|---|
| Distribución (`/socios`, `/balances`, consolidado, forecast) | cadena canónica + snapshot | Bajo — bien resuelto |
| Comisiones · tab **Historial** y CSVs de historial/individual | **guardado** | Bajo |
| Comisiones · tabs **Equipos** e **Individual**, y **todos los PDF** | **en vivo** | **Alto** |

**Por qué importa:** `ND = 0` es indistinguible de "no cargado" (el default del
input es 0). Si los datos no cargaron y alguien guarda, **se escribe 0 y se pisa
lo que había**. Es el incidente de agosto 2026.

**Mitigación existente** (solo en el tab Equipos): bloqueo si el total del equipo
no coincide con el grupo padre → confirmación **con nombres** si algún miembro
tiene ND guardado y quedaría en 0 → confirmación estándar si ya había datos.

---

## 7. Hallazgos abiertos

> Detectados en el estudio del 2026-08-27. **No están arreglados.** Se listan
> para que nadie los descubra de nuevo desde cero.

### Riesgo alto
1. **Objetos de esquema sin migración en el repo.** No existe ningún `.sql` que
   cree `mt5_pnl_snapshots`, `mt5_margin_risk_snapshots`, `mt5_trading_behavior`,
   `mt5_pnl_daily`, `crm_wallet_sources`, ni la columna
   `mt5_account_activity.equity`. Tampoco `commercial_monthly_results.head_id`
   (reportado como A5), que el código usa como clave — y `schema.sql` tiene un
   `UNIQUE(profile_id, period_id)` que **prohibiría** el modelo actual.
   → **Un entorno nuevo levantado solo con `supabase/` no reproduce producción.**
   Faltan además los archivos `migration-080` y `migration-094`.
2. **Los PDF de PnL y PnL Especial ignoran la deuda arrastrada.** La tabla sí la
   aplica; el papel dice otro número. Es el mismo bug A3 #5 que se arregló solo
   para el PDF de ND.
3. **`handleRecalcHistory`** puede reescribir todo el histórico con el % de hoy,
   con `prevDebt = 0`, **sin verificar período cerrado y sin auditoría**.

### Riesgo medio
4. **`API_CREDENTIALS_MASTER_KEY` tiene dos validaciones incompatibles**:
   `crypto.ts` la decodifica como base64/32 bytes; `env.ts` la valida como 64
   chars hex. Confirmar cuál usa producción **antes** de tocar credenciales.
5. **`scripts/check-rpc-grants.ts` no está colgado del CI**, pese a que las
   migraciones 077/078 lo señalan como *"la defensa real"* contra que un
   `DROP FUNCTION` reabra una RPC.
6. **`PENDING_MAX` (500) no tiene flag de truncado** — la única de las tres
   listas de la cola de retiros sin aviso, contra el invariante que el propio
   archivo declara tres veces.
7. **Snapshot: devengado vs caja.** `close_period` congela `total_expenses` como
   `sum(amount)` (devengado), pero en `business_model='company'` la cadena usa
   `paid` (caja). Cerrar un período le cambiaría los egresos a ese tenant. Sin
   verificar si hay algún tenant `company` con períodos cerrados.
8. **Guards anti-pisón solo en el tab Equipos.** El guardado Individual y el
   por-fila no tienen ninguna confirmación.

### Menor / documentación
9. Comentarios desactualizados: `mt5-sql-probe` dice que el proxy "aún no está
   cableado" (ya lo está); `risk-query.ts:184` dice que la exposición cuenta
   todas las cuentas (filtra por CRM desde el 2026-08-26); `withdrawal-review`
   describe roles que ya cambiaron; la cabecera de `score.ts` lista 3 señales
   amortiguadas y el código amortigua 4.
10. `ARCHITECTURE.md` (julio) no menciona MT5, prop firm, exposición ni Atlas, y
    dice "76 tests" cuando hoy son 831. `docs/CI_WORKFLOW.md` está obsoleto.
11. Dos parsers de fecha MT5 conviviendo (`mt5DateUtc` y `mt5DateToIso`), y dos
    técnicas de escape de barra (`pnl.ts` con 8 barras, `copy-detection.ts` con
    `ESCAPE '~'`).
12. `pnlSpecialSummary` usa un `Math.round` inline en vez de `round2` — la única
    copia del redondeo en el repo.

---

### 3.2 El Pool de Liquidez (`liquidity_pool`)

Módulo nuevo (agosto 2026). Vive en la organización **Exura Liquidez** y desde
ahí se administran las demás: la empresa cuyas cuentas se miran se elige con un
selector, y hoy sólo Vex Pro tiene credenciales de MT5. **No confundirlo con
`liquidity`**, que es la conciliación que usa Vex Pro y es otra cosa.

| # | Regla | Por qué |
|---|---|---|
| L1 | El **«Equity a Liquidez»** no lo recalcula el refresh, nunca | Lo fija el análisis de duplicados al dar de alta. Recalcularlo restaría la misma transferencia en cada corrida y **el pool encogería solo hasta cero** |
| L2 | La fecha de conexión es el **arranque del día en UTC** | Anclarla a mediodía se comía media jornada: la 136773 daba -2.662,49 contra los -3.437,67 del MT5 Manager |
| L3 | En el PnL, `Entry IN (1,3)` va **sólo en el conteo**, no en los importes | La comisión se cobra en la apertura Y en el cierre. Filtrando por salida se perdía la mitad: -136,30 de 272,90 en la 137983 |
| L4 | Todo `NOT EXISTS` sobre `mt5_deals` **ata el `Login`** | `PositionID` NO es único entre cuentas: las operaciones de balance llevan `PositionID = 0` y ese cero lo comparten miles de logins. Además es lo que hace que use el índice: 1.090.454 filas → 244 |
| L5 | Contar posiciones abiertas exige **`Action IN (0,1)`** | Un depósito es `Action=2`, `Entry=0`, `PositionID=0`: tiene la forma exacta de «una entrada que nunca cerró» |
| L6 | El alta **crea la cuenta primero** y calcula el histórico después | Juntos, un cuelgue perdía las dos cosas. Separados, el peor caso es una cuenta sin histórico — visible y arreglable con Refrescar |
| L7 | El equity de una conexión **de hoy** no se reconstruye | Es el equity actual, que además es *mejor*: ya trae el flotante que un cálculo retroactivo no puede saber |

**La trampa que más costó:** el `PositionID = 0`. Dos consultas distintas daban
resultados distintos y las **dos** estaban mal — una encontraba el cierre de
otra cuenta, la otra contaba un depósito como posición abierta. El control que
lo destrabó fue mirar un instante donde se sabía la respuesta: el ticket
3342152, abierto 14:26:02 y cerrado 14:28:09.

**Timeouts:** `mysql2` no tiene el `query_timeout` de `pg`. Sin un corte del
lado del cliente, una consulta trabada no resuelve nunca y Vercel mata la
función — se vio como `504` **exactamente** en 120 s y en 300 s. El corte está
en `mt5-sql/client.ts`; un 504 justo en el límite es firma de cuelgue, no de
trabajo lento.

**El proxy falla intermitentemente bajo concurrencia** (medido: 3 conexiones en
paralelo, 1 falló con `Proxy connection timed out`). Empeora con el tráfico, y
los cron se pisan en `:15` y `:45`.

---

## 8. Referencias rápidas

| Necesito… | Está en |
|---|---|
| La fórmula de comisiones | `src/lib/commission-calculator.ts` |
| La fórmula de distribución | `src/lib/distribution.ts` (+ `distribution-inputs.ts`, `distribution-snapshot.ts`) |
| Permisos y roles | `src/lib/roles.ts` · `src/lib/api-auth.ts` · `src/lib/modules.ts` |
| Conectarme a MT5 | `src/lib/api-integrations/mt5-sql/client.ts` |
| Conectarme a Orion (Mongo) | `src/lib/api-integrations/orion-mongo/client.ts` |
| Credenciales cifradas | `src/lib/api-integrations/credentials.ts` · `src/lib/crypto.ts` |
| El score de retiros | `src/lib/withdrawal-risk/score.ts` (y `features.ts` para las señales) |
| Reglas de prop firm por programa | `src/lib/risk/programs.ts` |
| El Pool de Liquidez | `src/components/liquidity/` (pantalla) · `src/lib/liquidity/` (cálculo) · §3.2 |
| Dónde está prendido el Pool | `supabase/donde-vive-liquidity-pool.sql` |
| El contrato con Atlas | `src/app/api/partner/v1/*/route.ts` (cabeceras) |
| Qué avisa el sistema | `src/lib/notifications/catalog.ts` |
