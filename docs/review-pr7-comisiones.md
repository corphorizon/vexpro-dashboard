# Code Review — PR #7: Net Deposit Commission Calculator

**Autor del PR:** Stiven (alejandrocastaeda27@gmail.com)  
**Revisado por:** Kevin + Claude Code  
**Fecha de revisión:** 2026-04-10  
**Branch:** `feature/commission-calculator` → mergeado a `main` via PR #7

---

## Parte 1: Lo que ya fue corregido (NO tocar estos archivos)

Estos cambios ya están en `develop` y `main`. No los modifiques — ya están resueltos.

### Commit `b84f388` — security(api): add auth middleware to all admin API routes

**Problema:** Todas las rutas bajo `/api/admin/` usaban `createAdminClient()` (service role key, bypass total de RLS) sin verificar quién hacía el request. Cualquier persona con la URL podía crear usuarios, borrar datos, o manipular comisiones de cualquier empresa.

**Solución aplicada:**

1. **Nuevo archivo `src/lib/api-auth.ts`** — middleware `verifyAdminAuth()` que:
   - Lee la cookie de sesión de Supabase
   - Verifica el JWT con `getUser()`
   - Busca el `company_users` del caller para obtener `company_id` y `role`
   - Rechaza con 401 si no está autenticado
   - Rechaza con 403 si no tiene rol `admin`, `auditor` o `hr`
   - Retorna `{ userId, companyId, role, name, email }` verificado

2. **Aplicado a las 6 rutas admin:**
   - `create-user/route.ts`
   - `delete-user/route.ts`
   - `reset-password/route.ts`
   - `update-auth-user/route.ts`
   - `commission-entries/route.ts` ← del PR #7
   - `commercial-profiles/route.ts` ← del PR #7

3. **`commercial-profiles/route.ts` — whitelist de campos:**
   - Antes: `.update(fields)` — el cliente podía sobreescribir cualquier columna
   - Ahora: `pickAllowed(body)` solo permite: `name`, `role`, `head_id`, `net_deposit_pct`, `extra_pct`, `status`, `email`, `phone`
   - Las operaciones de update/delete se limitan con `.eq('company_id', auth.companyId)`

4. **Todas las rutas ahora derivan `company_id` del JWT verificado**, no del body del request. El campo `company_id` del body se ignora silenciosamente.

**Archivos modificados (NO tocar):**
- `src/lib/api-auth.ts` (nuevo)
- `src/app/api/admin/create-user/route.ts`
- `src/app/api/admin/delete-user/route.ts`
- `src/app/api/admin/reset-password/route.ts`
- `src/app/api/admin/update-auth-user/route.ts`
- `src/app/api/admin/commission-entries/route.ts`
- `src/app/api/admin/commercial-profiles/route.ts`

### Commit `78bda43` — fix(rrhh): move hooks before early returns in perfil page

**Problema:** `rrhh/perfil/page.tsx` tenía 25 llamadas a `useState()` después de dos `return` condicionales. Esto viola las reglas de hooks de React — los hooks deben ejecutarse en el mismo orden en cada render. Puede causar crashes impredecibles.

**Solución aplicada:**
- Todos los `useState` movidos ANTES de los early returns
- Valores iniciales con optional chaining (`profile?.name ?? ''`)
- Los early returns ahora están después del bloque de hooks

**Archivo modificado (NO tocar):**
- `src/app/(dashboard)/rrhh/perfil/page.tsx`

---

## Parte 2: Lo que Stiven debe corregir

Estos son problemas en archivos que SOLO Stiven debe modificar. No hay conflicto porque Kevin/Claude no van a tocar estos archivos.

### Archivos a modificar:
- `src/app/(dashboard)/comisiones/page.tsx`
- `src/lib/commission-calculator.ts`
- `supabase/migration-002-commissions.sql`

---

### Fix 1: Imports no usados en `comisiones/page.tsx`

**Líneas 15 y 19** — dos imports que nunca se usan en el archivo:

```typescript
// BORRAR estas dos líneas:
import { calculateHeadDifferential } from '@/lib/commission-calculator';
// y en el type import:
HeadDifferentialResult  // borrar de la lista de tipos importados
```

**ESLint rule:** `@typescript-eslint/no-unused-vars`

---

### Fix 2: Reemplazar `any` con tipos correctos en `comisiones/page.tsx`

4 ocurrencias de `any` que deben ser tipadas:

- **Línea 116** — tipar el parámetro con el tipo correcto del evento o dato
- **Línea 129** — tipar el parámetro con el tipo correcto
- **Línea 176** — tipar el parámetro con el tipo correcto
- **Línea 702** — tipar el parámetro con el tipo correcto

**ESLint rule:** `@typescript-eslint/no-explicit-any`

Buscar cada `any` y reemplazar con el tipo concreto que corresponda (puede ser `CommercialProfile`, `CommercialMonthlyResult`, `string`, etc. según el contexto).

---

### Fix 3: Variable usada antes de ser declarada en `comisiones/page.tsx`

**Línea 137** — hay una referencia a una variable que se declara más abajo en el código. Reordenar las declaraciones para que la variable exista antes de ser usada.

**ESLint rule:** `Cannot access variable before it is declared`

---

### Fix 4: Dependencia faltante en useEffect en `comisiones/page.tsx`

**Línea 138** — el useEffect tiene un dependency array incompleto:

```typescript
// Actualmente:
useEffect(() => {
  // ... usa selectedPeriod internamente ...
}, [/* falta selectedPeriod */]);

// Corregir:
useEffect(() => {
  // ...
}, [selectedPeriod, /* ...otras dependencias existentes */]);
```

Si intencionalmente NO debe re-ejecutarse cuando `selectedPeriod` cambia, agregar un comentario `// eslint-disable-next-line react-hooks/exhaustive-deps` con una explicación de por qué.

**ESLint rule:** `react-hooks/exhaustive-deps`

---

### Fix 5: Variable no usada en `comisiones/page.tsx`

**Línea 694** — `filteredPeriodIds` se asigna pero nunca se lee.

```typescript
// BORRAR esta línea o usarla:
const filteredPeriodIds = ...;  // nunca se usa
```

**ESLint rule:** `@typescript-eslint/no-unused-vars`

---

### Fix 6: Redondeo en cálculos monetarios en `commission-calculator.ts`

Los cálculos de comisión usan aritmética de floats sin redondeo. JavaScript produce valores como `1234.560000000001` que se guardan así en la base de datos.

**Solución recomendada:** crear un helper de redondeo y aplicarlo antes de retornar valores:

```typescript
// Agregar al inicio del archivo:
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Aplicar en cada cálculo que produce un valor monetario:
// Antes:
const commission = base * (percentage / 100);
// Después:
const commission = round2(base * (percentage / 100));
```

Aplicar `round2()` a: `division`, `base`, `commission`, `real_payment`, `accumulated_out`, `salary`, `differential`.

---

### Fix 7: Reemplazar sentinel `-1` en `commission-entries/route.ts`

> **NOTA:** Este archivo ya fue modificado por Kevin para agregar auth. El fix del sentinel se puede hacer SIN conflicto porque el cambio es solo en la lógica interna del loop de entries, no en las líneas de auth que se agregaron al inicio.

El código usa `-1` como flag de "preservar el valor existente en la DB":

```typescript
// Problema: si un Net Deposit real es -1, se interpreta como flag
if (row.net_deposit_current === -1) row.net_deposit_current = current?.net_deposit_current ?? 0;
```

**Solución:** usar `null` o `undefined` como flag en vez de `-1`:

```typescript
// En el frontend (comisiones/page.tsx), enviar null en vez de -1:
net_deposit_current: preserveValue ? null : calculatedValue,

// En la API (commission-entries/route.ts), chequear null:
if (row.net_deposit_current === null) row.net_deposit_current = current?.net_deposit_current ?? 0;
```

Esto requiere cambiar tanto `comisiones/page.tsx` (donde se envía el -1) como la lógica interna del loop en `commission-entries/route.ts` (donde se chequea). Las líneas de auth al inicio del archivo NO se tocan.

---

### Fix 8: Precisión de NUMERIC en `migration-002-commissions.sql`

Las columnas usan `NUMERIC` sin precisión:

```sql
-- Actualmente:
ADD COLUMN IF NOT EXISTS division NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS base_amount NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS real_payment NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS accumulated_out NUMERIC DEFAULT 0;

-- Debería ser:
ADD COLUMN IF NOT EXISTS division NUMERIC(12,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS base_amount NUMERIC(12,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS real_payment NUMERIC(12,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS accumulated_out NUMERIC(12,2) DEFAULT 0;
```

**IMPORTANTE:** Como la migración ya fue aplicada en producción, para cambiar la precisión hay que crear una nueva migración (no modificar la existente):

```sql
-- migration-007-fix-numeric-precision.sql
ALTER TABLE commercial_monthly_results
  ALTER COLUMN division TYPE NUMERIC(12,2),
  ALTER COLUMN base_amount TYPE NUMERIC(12,2),
  ALTER COLUMN real_payment TYPE NUMERIC(12,2),
  ALTER COLUMN accumulated_out TYPE NUMERIC(12,2);

ALTER TABLE commercial_profiles
  ALTER COLUMN extra_pct TYPE NUMERIC(5,2);
```

---

### Fix 9: Renombrar migration-002 a migration-006

El archivo `migration-002-commissions.sql` se creó cronológicamente DESPUÉS de las migraciones 003, 004 y 005. Renombrarlo para mantener el orden:

```bash
git mv supabase/migration-002-commissions.sql supabase/migration-006-commissions.sql
```

Esto es solo un cambio cosmético de organización — la migración ya fue aplicada, el nombre del archivo no afecta la DB.

---

## Reglas para evitar conflictos

### Stiven PUEDE modificar:
- `src/app/(dashboard)/comisiones/page.tsx`
- `src/lib/commission-calculator.ts`
- `supabase/migration-002-commissions.sql` (renombrar)
- Crear nuevas migraciones (`migration-007-*.sql`)

### Stiven NO debe modificar (ya corregidos):
- `src/lib/api-auth.ts`
- `src/app/api/admin/*/route.ts` (las 6 rutas) — excepto la lógica interna del loop en `commission-entries` para el fix del sentinel -1
- `src/app/(dashboard)/rrhh/perfil/page.tsx`

### Si Stiven necesita agregar campos al whitelist de `commercial-profiles`:
Editar la constante `ALLOWED_FIELDS` en `src/app/api/admin/commercial-profiles/route.ts` — solo agregar campos a la lista, no cambiar la estructura.
