# Auditoría integral — Finanzas + RRHH
**2026-08-06 · 6 agentes Opus 5 (núcleo financiero, pantallas, integraciones/datos, RRHH, comisiones, benchmark de producto) · consolidado y deduplicado**

Todo lo listado fue verificado contra el código real (archivo:línea) y, donde aplica, contra la base de producción con consultas de solo lectura.

---

## A · INCIDENTES — arreglar antes que nada

### A1 · El libro por canal no va a escribirse esta noche, y cuando escriba va a meter un ajuste falso de ~$37.000
- El `upsert` de `channel-ledger-sync.ts:154` usa `onConflict` contra un índice único **parcial** — Postgres lo rechaza (42P10, probado con EXPLAIN contra producción). El camino del cron **nunca corrió**: los 176 asientos existentes son del backfill manual. El cron devuelve 200 igual; nadie se entera.
- Hoy 15:42 se fijó la wallet **1705 "Egresos Vex"** y el snapshot del día fue **sobreescrito** (la fila es mutable): el cierre del 05/08 quedó registrado como 585.569 cuando el real era **547.171,82**. Si solo se arregla el índice, el primer asiento real asienta un "Ajuste de conciliación" de ~+$37.000 sin movimiento que lo respalde.
- Fix conjunto: índice único total (o RPC con `WHERE source='api'`), snapshot inmutable intradía, corrección de la fila del 06/08, cota de sanidad sobre `actualClose` (si la API devuelve menos wallets que las fijadas → abortar, no asumir 0), y que el cron falle con 500 + Sentry cuando el libro trae error.
- Estructural: fijar/desfijar una wallet mueve el agregado sin movimiento (falta `pinned_from`), y las transferencias entre dos wallets fijadas generan línea `internal` + ajuste que se cancelan (líneas ficticias). El caso 30/07: internal $174.835 + ajuste +$169.999.

### A2 · El modelo de permisos del servidor no es el que creemos
- `ADMIN_ROLES = ['admin','auditor','hr']` es el **único** control de casi toda `/api/admin/*`. Consecuencias verificadas:
  - **`hr` escribe TODO lo financiero** (egresos, órdenes de pago incl. transiciones, libro, credenciales API). La exclusión de HR es solo de UI.
  - **`auditor` escribe TODO RRHH** (borrar perfiles con su histórico de comisiones incluido).
  - **Escalada**: `hr` puede auto-otorgarse todos los módulos vía `/api/admin/update-company-user` (no valida quién pide) y crear usuarios.
- **RLS de salarios**: `employees_select` y `commercial_profiles_select` no filtran por rol; el data-context los carga al inicio para **todos**. Un `invitado` ve sueldos, motivos de despido y contratos por Network tab.
- `/api/admin/data` (23 operaciones): el spread `{ company_id, ...body.movement }` permite **escribir en otro tenant** (el body pisa el company_id); ninguna operación valida rol ni audita; `period_reserve_all` reescribe la reserva de TODOS los períodos (incluidos cerrados) sin validar rango.
- `ib_rebate_configs`: RLS permite UPDATE a cualquier miembro; el gate del tab es solo UI.
- `payment-orders`: sin gate de módulo server-side; `beneficiary_id` se acepta sin verificar empresa (único IDOR del módulo). `crypto_memo` no está en el trigger de inmutabilidad.
- **PII real en el bundle**: `src/lib/hr-data.ts` lleva ~33 nombres + emails personales reales al cliente.

### A3 · Comisiones: errores que pagan mal hoy
1. **ND=0 destruye el acumulado**: mes sin depósitos → paga $0 y borra la deuda arrastrada (debería pagar % sobre el acumulado y arrastrar). "No cargado" y "cero real" son indistinguibles.
2. **Los tiers pisan el % negociado también hacia abajo** (7% pactado → cobra 5% de tabla, en silencio).
3. **Diferencial del head puede ser negativo**: la función que clampa existe y tiene test, pero **no se usa** (el test protege código muerto).
4. **Guardar desde Equipos ≠ guardar desde Individual** sobre la misma fila: pisa valores distintos y **borra la deuda arrastrada** del BDM (`bonus: 0`).
5. **PDF/CSV desde el estado vivo**: reimprimir marzo con los % de hoy da otro número; el PDF individual ignora la deuda (papel dice $5.000, se pagan $3.000).
6. `handleRecalcHistory` reescribe TODO el histórico con el % de hoy, deuda en 0, sin period-lock ni auditoría.
7. Sin estados (draft→approved→paid), sin conciliación contra egresos, sin guard de período cerrado en `commission_entries`, `bonus` (=deuda) editable desde RRHH como si fuera un bono.

### A4 · Guardados falsos y períodos cerrados
- **`rrhh/perfil` → "Agregar resultado mensual" no persiste nada**: toast verde, F5, desapareció.
- **`/upload` contra un mes cerrado**: sin banner ni bloqueo visual; el autosave (3s) choca con el trigger → error genérico ("Error al procesar la solicitud", P0001 no mapeado en `friendlyDbMessage`) → **bucle infinito de toasts**. Con Oct25–Jun26 recién bloqueados, es pisable hoy.
- **Reabrir un período no obliga a reabrir los posteriores** (la cadena es secuencial — hueco de cascada).
- El **snapshot de cierre es write-only**: nadie lo lee; la cadena sigue recalculando de las tablas vivas. Y el trigger no cubre `investments` (date-keyed), `reserve_pct`, `p2p_transfers`, `partner_distributions` → el pasado cerrado aún puede cambiar sin que nada lo detecte.

### A5 · Migraciones no versionadas
Faltan en el repo: **057, 058, 061** (¡la del cierre!), el archivo 062 es solo comentarios, y no hay migración para `onboarding_checklist`, `ib_rebate_*`, `commercial_monthly_results.head_id` (el código la usa dentro de un try/catch con `console.warn` — el reasignado de equipo puede fallar en silencio). Ningún entorno nuevo es reproducible. Extraer el DDL de producción y commitearlo.

---

## B · Alta prioridad (después de A)

**Núcleo financiero**
- `withdrawals` sin UNIQUE (company, period, category) → con 2 filas prop_firm, **tres pantallas dan tres montos a distribuir distintos** (`.find()` vs `Map.set()` vs `.reduce()`). Fix: UNIQUE + helper único de agregación.
- Leer el snapshot cuando `is_closed` + banner si el recálculo difiere.
- Gráfico de /resumen-general usa la fórmula de retiros **descartada como bug en junio** (resta prop_firm de más).
- /movimientos y /balances alimentan la "fórmula única" con universos API distintos (wallet seleccionada vs pinneadas).
- "Balance Disponible" resta egresos **devengados**, no pagados — no es caja.
- Ganancia de inversión sin período para su mes se **descarta en silencio** de la distribución (hoy no activo; alertar).
- Validación en `/upload`: `parseAmount` convierte basura a $0 y acepta negativos — el módulo que alimenta todo es el que menos valida.
- % de socios que no suman 100 → el resto se evapora sin error.
- Last-write-wins sin versión en las RPC de reemplazo (dos admins se pisan en silencio, agravado por autosave).

**Integraciones**
- Sync Coinsbuy alcanza ~8 días reales (techo 2.000 transfers, sin filtro server-side) pero se marca `fresh`; correcciones del proveedor >8 días nunca llegan. Marcar `partial` + paginar de verdad.
- Ventana ciega 23:55→00:00 cae entera en el ajuste, para siempre.
- `internal: !txid` es heurística nunca recalculada (payout pendiente de broadcast queda "interno" para siempre).
- Re-corrida del libro no borra líneas que dejaron de aplicar (huérfanas) → reemplazar upsert por delete+insert del día.
- `getLastSyncStatus` lee la última fila global sin filtrar empresa.
- Sin rate limiting en `/api/admin/*`; `api-credentials` no audita rotaciones.

**Pantallas / consistencia**
- Fila TOTAL de /egresos corrida una columna (9 cols vs colSpan 8). Cards vs TOTAL discrepan al buscar.
- CSV de /logs exporta máx 200 sin avisar; errores mudos.
- /inversiones importa los helpers de tipo y no los usa: la tabla sigue mostrando la columna mezclada.
- Períodos: `window.prompt` para el motivo; período cerrado del mes en curso queda sin acciones ("En curso").
- Egreso de una OP pagada puede caer al período abierto con fecha de un mes cerrado (visualmente incoherente).
- Presets de trimestre hardcodeados (Q4 2025…); 9 copias de nombres de mes; 4 variantes de toLocaleDate; fechas crudas (YYYY-MM-DD) en libro/conciliación/logs.
- i18n: logs, conciliación, reportes, consolidado, ib-rebates-tab, onboarding-tab con **cero `t()`**; los toasts y CSV son lo que sistemáticamente queda sin traducir. Regla de lint contra literales JSX.
- Permisos en UI: roles de lectura ven Aprobar/Pagar/Nueva orden y cobran 403 al final.
- `LedgerEntryDialog` sin ESC/focus-trap; `DataTable` con key por índice.

**RRHH**
- Borrado en cascada de comisiones al borrar perfil (y la UI dice lo contrario); botón visible en Fuerza Comercial.
- `terminated_by` nunca se escribe; status editable esquiva el FireModal (baja sin motivo).
- `employees` sin termination_*/contract_url: administrativos sin baja formal ni contrato — solo DELETE físico.
- Cero `serverAuditLog` en TODO RRHH (alta, baja, sueldo, contrato).
- Contratos viejos quedan en el bucket para siempre; no se limpian al borrar perfil.
- Dos caminos de edición del perfil graban campos distintos (salary sin fixed_salary).
- `negotiations` no verifica que el profile sea de la empresa (hueco menor de tenant).
- Persona = 2 tablas sin relación → duplicados en la lista unificada.

---

## C · Mejoras de producto (del benchmark)

**Quick wins (días):** conectar o quitar "Documentos" de upload (hoy guarda nombres en localStorage — falsa sensación de respaldo); eliminar/flag `risk/retiros-wallet` (100% mock con alert()); notificaciones email de órdenes de pago (SendGrid ya está); aviso de doble carga API+manual; confirmación con delta en $ para reserve_pct masivo; import CSV/Excel en upload (exceljs ya está, patrón en ib-rebates); checklist de cierre de período (pendientes de conciliar, OPs sin pagar, egresos sin comprobante) antes de cerrar.

**Comisiones (semanas):** congelar insumos por fila (% aplicado, tier, snapshot) y generar PDF/CSV desde lo guardado; estados draft→calculated→approved→paid enlazado a orden de pago/egreso; effective-dating de % (hoy la negociación es prosa y el número vive suelto); renombrar `bonus`→`carried_debt` y sacarlo del form de RRHH; panel de conciliación comisiones vs egresos.

**Apuestas grandes (elegir 1 para el trimestre):**
1. **Portal externo para IBs y socios** (solo lectura de su propia fila: ND, comisión, deuda, tier, statement) — el gap #1 contra UpTrader/B2Broker y el único que convierte esto en argumento comercial de los brokers. Prerrequisito duro: arreglar A2 primero.
2. **Forecast de caja 13 semanas + presupuesto vs real** — el producto entero mira hacia atrás; los insumos (egresos fijos con vigencia, salarios, % socios) ya existen. Mejor impacto/esfuerzo.
3. **Multi-moneda / multi-entidad** — 4 marcas, jurisdicciones distintas, USD hardcodeado. Fase 0 barata ya: registrar `currency`+`fx_rate` sin cambiar cálculos.

**Dónde el producto ya gana al mercado:** la contabilidad interna del operador (distribución con reserva y deuda, libro por canal con cierre contra el proveedor, inmutabilidad de órdenes). Los back-offices comerciales son fuertes de cara al cliente y flojos hacia adentro — ese es el foso.

---

## D · Orden de ejecución propuesto

| Tanda | Contenido | Esfuerzo |
|---|---|---|
| **1 — hoy/mañana** | A1 completo (libro por canal, antes de que el cron re-corra) + A5 (commitear DDL) | horas |
| **2 — esta semana** | A2 (roles por ruta, RLS de salarios, /api/admin/data, escalada, PII) | 1-2 días |
| **3 — esta semana** | A3 fixes de cálculo (ND=0, tiers, diferencial, Equipos, PDF desde fila) + A4 (guardado falso, banner+autosave de período cerrado, P0001) | 2-3 días |
| **4 — próximas 2 semanas** | Bloque B priorizado (UNIQUE withdrawals, snapshot leído, validación upload, i18n, TOTAL egresos, CSV logs…) | continuo |
| **5 — trimestre** | Elegir apuesta (portal / forecast) + quick wins de producto | proyecto |
