# Row Level Security — Policies del sistema multi-tenant

**Última actualización:** 2026-04-19 (migraciones 021 y 022)

Este documento resume las reglas de acceso a los datos en Supabase después de la
incorporación del rol `SUPERADMIN` (Horizon Consulting).

---

## Principios

1. **Los datos de cada empresa están aislados por `company_id`**. Ningún usuario
   de una empresa A puede leer ni escribir datos de la empresa B.
2. **El SUPERADMIN es cross-tenant**: puede leer/escribir en cualquier empresa.
   Vive en la tabla `platform_users`, no en `company_users`.
3. **La lógica de acceso está centralizada en funciones helper** (ver §2), de
   modo que las policies son uniformes y fáciles de auditar.

---

## 1. Tabla `platform_users`

Registros de superadmins. Un superadmin NO está en `company_users`.

| Policy | Verbo | Regla |
|---|---|---|
| `platform_users_select` | SELECT | `is_superadmin()` |
| `platform_users_insert` | INSERT | `is_superadmin()` |
| `platform_users_update` | UPDATE | `is_superadmin()` |
| `platform_users_delete` | DELETE | `is_superadmin()` |

**Efecto**: un usuario normal ve la tabla vacía, no puede insertar, actualizar,
ni borrar filas.

---

## 2. Funciones helper

| Función | Retorna | Uso en policies |
|---|---|---|
| `is_superadmin()` | boolean | Short-circuit para cualquier bypass |
| `auth_company_ids()` | setof uuid | Lista de company_ids visibles para el caller. **Si el caller es superadmin, retorna todas las companies.** |
| `auth_user_role(cid)` | text | Rol del caller en la empresa indicada |
| `auth_can_edit(cid)` | boolean | TRUE si rol admin/auditor en la company, o superadmin |
| `auth_can_manage(cid)` | boolean | TRUE si rol admin en la company, o superadmin |

---

## 3. Policies por tabla

Las siguientes tablas usan el patrón uniforme establecido en las migraciones
021/022. Cada una tiene 4 policies (SELECT/INSERT/UPDATE/DELETE).

### SELECT (lectura)
```sql
FOR SELECT USING (company_id IN (SELECT auth_company_ids()))
```
Retorna datos de empresas donde el caller tiene membership. El superadmin ve
todo porque `auth_company_ids()` se expande a todas las companies para él.

### INSERT (creación)
```sql
FOR INSERT WITH CHECK (auth_can_edit(company_id))
```
Solo roles admin/auditor de la empresa, o superadmin, pueden crear registros.
**Importante**: el `company_id` del registro debe estar declarado en el INSERT
y debe coincidir con una empresa donde el caller tenga permisos.

### UPDATE (modificación)
```sql
FOR UPDATE USING (auth_can_edit(company_id))
```
Idéntico a INSERT — solo admin/auditor de la company, o superadmin.

### DELETE (eliminación)
```sql
FOR DELETE USING (auth_can_manage(company_id))
```
Más restrictivo: solo admin de la company, o superadmin. Auditor NO puede
borrar.

### Tablas cubiertas por el patrón uniforme

Movimientos y negocio:
- `periods`, `deposits`, `withdrawals`, `prop_firm_sales`, `p2p_transfers`
- `expenses`, `preoperative_expenses`, `expense_templates`
- `operating_income`, `broker_balance`, `financial_status`
- `partners`, `partner_distributions`
- `liquidity_movements`, `investments`
- `channel_balances`, `pinned_coinsbuy_wallets`

HR y comisiones:
- `employees`, `commercial_profiles`, `commercial_monthly_results`
- `commercial_negotiations`

Configuración:
- `custom_roles`

---

## 4. Casos especiales

### `companies`

| Policy | Regla |
|---|---|
| SELECT | `id IN (SELECT auth_company_ids())` — superadmin ve todas |
| INSERT | `is_superadmin() OR (caller es admin existente en alguna empresa)` |
| UPDATE | `is_superadmin() OR id IN (auth_company_ids())` |
| DELETE | `is_superadmin() OR (caller es admin)` |

**Justificación**: un admin de una empresa puede crear/modificar su propia
empresa (ya soportado antes de multi-tenant). El superadmin puede gestionar
todas.

### `company_users`

| Policy | Regla |
|---|---|
| SELECT | `company_id IN (SELECT auth_company_ids())` |
| INSERT | `auth_can_manage(company_id)` (admin de la company o superadmin) |
| UPDATE | `auth_can_manage(company_id)` |
| DELETE | `auth_can_manage(company_id)` |

**Justificación**: solo el admin de la empresa (o superadmin) puede alterar
memberships.

### `audit_logs`

| Policy | Regla |
|---|---|
| SELECT | `is_superadmin()` OR admin/auditor de la company OR entrada global (`company_id IS NULL`) |
| INSERT | `auth.uid() IS NOT NULL` (cualquier autenticado — los logs se escriben desde todos los módulos) |

**Justificación**: auditoría debe ser transparente para quien tenga derecho a
revisar; el superadmin ve todas las auditorías.

### Tablas con acceso restricto al service role (no RLS)

Las siguientes tablas solo son accesibles desde el backend vía `SUPABASE_SERVICE_ROLE_KEY`:

- `api_credentials` — credenciales cifradas
- `api_transactions` — cache persistido de movimientos de API
- `api_balance_snapshots` — snapshots diarios de balance por canal
- `api_sync_log` — bitácora de sincronizaciones

Estas tablas NO tienen policies de RLS habilitadas para `authenticated`; el
cliente frontend nunca las toca directamente.

---

## 5. Testing anti cross-tenant

El protocolo obligatorio de verificación (parte de la Fase 6 del rollout)
ejecuta estos checks antes de dar por bueno cualquier cambio de RLS:

1. **Dos empresas, dos usuarios**: crear Test Co + user de test.
   - El user de VexPro **no** ve ningún registro de Test Co (todas las tablas).
   - El user de Test Co **no** ve ningún registro de VexPro (todas las tablas).

2. **Superadmin sí ve todo**: el superadmin puede leer y escribir en ambas
   empresas.

3. **Protección a nivel de URL**: `/superadmin/*` devuelve 403 para usuarios
   normales; RLS no es la única capa — el middleware HTTP también valida.

4. **Integridad de VexPro FX**: tras cualquier migración, los conteos de
   registros por tabla de VexPro deben coincidir con el snapshot previo
   (`scripts/verify-vexpro-integrity.ts`).

---

## 6. Diagrama conceptual

```
┌──────────────────────┐          ┌──────────────────────┐
│   platform_users     │          │      companies       │
│  (superadmins)       │          │  (tenants)           │
│  - id                │          │  - id                │
│  - user_id  (auth)   │          │  - name, slug        │
│  - name, email       │          │  - colors, logo      │
│  - role='superadmin' │          │  - active_modules    │
└──────────────────────┘          └──────────┬───────────┘
          ▲                                  │
          │ is_superadmin()                  │
          │                                  │
          │                                  ▼
          │                       ┌──────────────────────┐
          │                       │   company_users      │
          │                       │  - user_id (auth)    │
          │                       │  - company_id        │
          │                       │  - role              │
          │                       └──────────────────────┘
          │                                  │
          │                                  │ auth_company_ids()
          │                                  │
          ▼                                  ▼
┌───────────────────────────────────────────────────────┐
│          Business data tables (RLS-scoped)            │
│   deposits · withdrawals · expenses · partners · ...  │
│                                                       │
│   SELECT: company_id IN (SELECT auth_company_ids())   │
│   INSERT: auth_can_edit(company_id)                   │
│   UPDATE: auth_can_edit(company_id)                   │
│   DELETE: auth_can_manage(company_id)                 │
└───────────────────────────────────────────────────────┘
```

---

## 7. Checklist al agregar una tabla nueva

Cuando una nueva tabla de datos de negocio se incorpore al schema:

1. Agregar columna `company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE`.
2. Crear índice `CREATE INDEX idx_<tabla>_company_id ON <tabla>(company_id)`.
3. Habilitar RLS: `ALTER TABLE <tabla> ENABLE ROW LEVEL SECURITY`.
4. Crear las 4 policies con el patrón uniforme:
   ```sql
   CREATE POLICY <tabla>_select ON <tabla>
     FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
   CREATE POLICY <tabla>_insert ON <tabla>
     FOR INSERT WITH CHECK (auth_can_edit(company_id));
   CREATE POLICY <tabla>_update ON <tabla>
     FOR UPDATE USING (auth_can_edit(company_id));
   CREATE POLICY <tabla>_delete ON <tabla>
     FOR DELETE USING (auth_can_manage(company_id));
   ```
5. Actualizar este documento agregando la tabla a §3.

---
