# Sesión 2026-04-23 (lado Stiven) — PnL Especial mode + Ver perfil icon upgrade

**Para:** Kevin (y tu Claude Code)
**De:** Stiven + IA pair-programming
**Base:** `main` después de mi commit `88b22c8` (handoff 2026-04-22)
**Estado:** pusheado a `main`, deploy en Vercel. HEAD actual: `530554c`.
**Commit:** 1 — `530554c` (`git show --stat 530554c`)

---

## TL;DR

Dos cambios que cayeron en el mismo commit porque tocan los mismos archivos
(`rrhh/page.tsx`, `i18n.tsx`) y separarlos sin `git add -p` hubiera
distorsionado la historia:

1. **Modo "PnL Especial"** — una flag nueva por perfil
   (`commercial_profiles.pnl_special_mode`, migration 038 ya aplicada)
   que habilita una fórmula alternativa de comisión:
   `commission = pnl × pnl_pct` (sin dividir entre 2, sin acumulado
   previo ni siguiente). La resta de Com. Lotes sí aplica igual que en
   PnL normal. Los perfiles con esta flag activa aparecen en una
   sección **separada** del tab Individual de `/comisiones`, con badge
   violeta "Especial", y NO aparecen en la sección PnL normal (evita
   doble conteo).

2. **Icono "Ver perfil"** (`UserRound`) — reemplaza el `ChevronRight`
   en el sub-tab Fuerza Comercial y se agrega como **primera acción**
   en cada fila del sub-tab Empleados. Para comerciales lleva a
   `/rrhh/perfil?id=…`; para administrativos abre el `EmployeeForm`
   (no tenemos página de perfil para employees todavía).

---

## ⚠️ Importante — cambios que pueden afectar tu código

### 1. `CommercialProfile.pnl_special_mode?: boolean`

Campo nuevo opcional. Cuando es `true` Y el perfil tiene `pnl_pct`
configurado, el perfil usa la fórmula Especial. Cuando el form guarda
con `pnl_pct` vacío, el flag se fuerza a `false` automáticamente para
evitar estados inconsistentes.

- `ALLOWED_FIELDS` del endpoint `/api/admin/commercial-profiles`
  incluye `'pnl_special_mode'`.
- `CommercialProfileInput` en `mutations.ts` también.
- Seeds de `hr-data.ts` no necesitaron cambio (el campo es opcional).

### 2. `calculatePnlSpecial()` en `commission-calculator.ts`

Función nueva **independiente** de `calculateCommission`. Contrato:

```ts
export interface PnlSpecialCalcResult {
  profileId: string;
  pnl: number;            // lo que se tipea en el input
  commissionPct: number;
  commission: number;     // pnl × pct
  lotCommissions: number;
  realPayment: number;    // commission − lotCommissions
  accumulatedOut: number; // SIEMPRE 0
  salary: number;         // fixed_salary si aplica; sin tiers
}

export function calculatePnlSpecial(
  pnl: number,
  pnlPct: number,
  lotCommissions: number,
  salary: number = 0,
): Omit<PnlSpecialCalcResult, 'profileId'>
```

**Cero líneas tocadas** en `calculateCommission`, `calculateGroupSummary`,
`getAccumulatedIn`, `applyTotalEarnedDebt`, `calculateSalaryFromND`,
`calculateHeadSalaryFromND`, `calculateBdmPctFromND`, `SALARY_TIERS`,
`HEAD_SALARY_TIERS`, `BDM_PCT_TIERS`.

### 3. `handleSaveBdm` firma nueva

En `/comisiones/page.tsx`:

```ts
// Antes
const handleSaveBdm = (profileId: string, isNd: boolean) => ...

// Ahora
const handleSaveBdm = (profileId: string, mode: 'nd' | 'pnl' | 'pnlSpecial') => ...
```

Los 2 callers existentes se actualizaron (`true` → `'nd'`, `false` → `'pnl'`).
Si agregás un caller nuevo, asegurate de pasar el modo.

La rama `'pnlSpecial'` persiste `division=0`, `accumulated_out=0`,
`net_deposit_accumulated=0` pero mantiene la convención de columnas:
- `net_deposit_current` → el PnL ingresado
- `pnl_current` → las Com. Lotes
- `commissions_earned` → `pnl × pct`
- `real_payment` → `commissions_earned − pnl_current`

Esto deja las queries downstream funcionando sin cambios estructurales.

### 4. Split de `pnlBdms` en `/comisiones`

Antes: `pnlBdms = allBdms.filter((p) => p.pnl_pct != null)`

Ahora:
```ts
const pnlBdms        = allBdms.filter((p) => p.pnl_pct != null && !p.pnl_special_mode);
const pnlSpecialBdms = allBdms.filter((p) => p.pnl_pct != null && !!p.pnl_special_mode);
```

Un perfil con ambas condiciones aparece sólo en `pnlSpecialBdms` — **no
se duplica** en la sección normal. Si tocás la lógica de agrupación,
mantené esta exclusividad.

### 5. `handleRecalcHistory` — admin-only recalc de histórico

Dentro de la sección PnL Especial, un botón violeta visible sólo
cuando `user?.effective_role === 'admin'` reescribe todos los
`commercial_monthly_results` existentes de perfiles en modo Especial
usando la nueva fórmula. Preserva los valores originales de PnL
(`net_deposit_current`) y Com. Lotes (`pnl_current`) de cada periodo;
reescribe `commissions_earned`, `real_payment`, `total_earned`,
`bonus`, `division=0`, `accumulated_out=0`,
`net_deposit_accumulated=0`.

**Decisión de diseño explícita**: el recalc NO reprocesa la cascada
de deudas entre meses (`prevDebt` se fuerza a 0). Reprocesar deudas
históricas sería un cambio grande y el usuario no lo pidió. Si llega
a pedirse, es otro ticket.

### 6. `generatePnlPDF()` con `mode?: 'normal' | 'special'`

En `src/lib/pdf-export.ts`. Default `'normal'` mantiene el
comportamiento anterior. En `'special'`:

- Título del header: "Informe Individual de Comisiones - **PnL Especial**"
- Tabla "Detalle del Cálculo" omite 3 filas (Acumulado previo, División,
  Acumulado → Siguiente) y usa el label **"Comision (PnL x %)"**
- Los índices de `didParseCell` para colorear los rows de Lotes/Pago
  Real se recalculan para la tabla más corta (índices 3 y 4 en
  especial vs 5 y 6 en normal)
- Filename: `ComisionPnLEspecial_<nombre>_<periodo>.pdf`

Las summary cards de arriba y la sección "Resumen de Pago" se dejaron
sin cambios (aplican a ambos modos).

### 7. UI cosmética en `/rrhh`

- `UserRound` reemplaza `ChevronRight` en los 2 lugares de la sub-tab
  Fuerza Comercial (BDM bajo leader + Independent BDMs).
- Nuevo botón "Ver perfil" como primera acción de cada fila en
  Empleados. Orden final: **Ver perfil · Despedir/Reincorporar ·
  Editar · Eliminar**.
- `ChevronRight` retirado del import de lucide-react (no tenía otros
  callers).

---

## Archivos nuevos

```
supabase/migration-038-add-pnl-special-mode.sql
```

## Archivos modificados

```
src/lib/types.ts                                ← +pnl_special_mode?
src/lib/supabase/mutations.ts                   ← +pnl_special_mode? en Input
src/app/api/admin/commercial-profiles/route.ts  ← +pnl_special_mode en ALLOWED_FIELDS
src/lib/commission-calculator.ts                ← +calculatePnlSpecial (additive)
src/lib/pdf-export.ts                           ← mode flag en generatePnlPDF
src/lib/i18n.tsx                                ← ~14 keys EN/ES (hr.viewProfile, hr.pnlSpecialMode+Hint, comm.sectionPnLSpecial+Hint, comm.specialBadge, comm.recalcHistory*)
src/app/(dashboard)/rrhh/page.tsx               ← UserRound + checkbox PnL Especial
src/app/(dashboard)/comisiones/page.tsx         ← split pnlBdms, pnlSpecialCalcs, handleSaveBdm signature, PnL Especial section + recalc button + history badge
```

---

## Verificación

- `npx tsc --noEmit` → clean
- `npm run build` → clean, 58/58 páginas
- QA manual contra prod DB:
  - Activé el checkbox "Modo PnL Especial" en un perfil con pct 35% → desapareció de PnL normal, apareció en PnL Especial con badge violeta
  - PnL 10,000 + lotes 0 → commission $3,500 (sin división), real payment $3,500
  - PnL 10,000 + lotes 1,000 → real payment $2,500
  - Guardé individual → DB con `accumulated_out=0`, `division=0` ✅
  - Siguiente mes sin input para ese perfil → NO muestra acumulado pendiente (no arrastra) ✅
  - PDF Especial descargado: tabla con 5 filas (sin División/Acumulado/Siguiente), header "PnL Especial", filename `ComisionPnLEspecial_...pdf` ✅
  - Desactivé la flag → volvió a la sección PnL normal, ya no aparece en Especial
  - Botón "Recalcular histórico" solo visible con rol admin ✅

---

## Pendientes / tech debt que dejo

1. **Ver perfil para administrativos** — hoy abre el `EmployeeForm`; si
   quieren una página dedicada `/rrhh/perfil-employee?id=…` es otro
   ticket.

2. **Recalc histórico NO reprocesa cascada de deudas** — si un perfil
   en modo Especial tenía deuda arrastrada de meses anteriores, el
   botón no la recomputa hacia adelante. Decisión consciente; si se
   quiere cascadear deudas al recalcular, hay que diseñarlo con
   cuidado (qué mes es el "pivot", cómo se reconcilian salarios
   pagados, etc.).

3. **Tab Teams no refleja PnL Especial** — la sección Teams se queda
   con su lógica ND original; perfiles que comisionan sólo por PnL
   Especial (sin ND) no aparecen en Teams. Mismo comportamiento que
   tenía la sección PnL normal antes, intencional.

4. **`terminated_by` sigue NULL** desde FireModal (mencionado en mi
   handoff anterior del 22) — no cambió nada en este ticket pero el
   item sigue vivo.

---

## Salud del proyecto

| Check | Estado |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npm run build` | ✅ clean (58/58) |
| RLS + multi-tenant | ✅ sin cambios (ya respetado por infra anterior) |
| Lógica de comisiones normal | ✅ intacta — `calculateCommission` y amigos no se tocaron |
| i18n | ✅ EN + ES cubiertas |

---

**`git show 530554c --stat`** para ver el diff completo, o el commit
message tiene un recap detallado.

— Stiven
