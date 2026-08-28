// ─────────────────────────────────────────────────────────────────────────────
// Registro ÚNICO de los slices del arranque + quién puede leer cada uno.
//
// ── El problema que esto resuelve ───────────────────────────────────────────
// El boot del dashboard son 20 consultas navegador→PostgREST. Cada una pasa
// por RLS, y RLS hace DOS cosas a la vez: filtra por empresa y —desde la
// migración 064— tapa las cuatro tablas de RRHH a quien no es admin/hr. Un
// usuario `soporte` recibe hoy employees / commercial_profiles /
// commercial_monthly_results VACÍOS, y eso es correcto: son sueldos, motivos
// de despido y contratos.
//
// La ruta /api/bootstrap responde esas mismas 20 tablas en UNA respuesta, con
// el admin client (service role). **El service role no pasa por RLS.** Sin
// este archivo, la ruta le mandaría la nómina entera a cualquiera que sepa
// hacer un fetch. El gate tiene que reproducirse acá, explícito.
//
// ── La decisión, en una línea ──────────────────────────────────────────────
// Los slices de RRHH se leen si —y sólo si— se cumplen las DOS condiciones:
//   1. ROL: espejo de `auth_is_hr_reader()` (migración 064) → admin, hr, o
//      superadmin de plataforma. Es lo que la DB aplica hoy.
//   2. (retirado 2026-08-28 por paridad con RLS: el módulo no influye)
//      (src/lib/modules.ts). §4.1 del manual: leer lo decide el módulo.
//
// Es un AND, no un OR, y por eso NUNCA es más permisivo que RLS hoy. Dónde SÍ
// es más estricto: un admin de una empresa que no tiene 'hr' en
// `active_modules` deja de recibir esos slices en el arranque. No se pierde
// nada visible —la empresa no tiene pantalla de RRHH— y la respuesta lo dice
// por nombre en `gated`, así que no es un recorte silencioso (§1.2).
//
// ── Lo que NO se gatea, y por qué ──────────────────────────────────────────
// Los otros 17 slices hoy los lee CUALQUIER miembro de la empresa: sus
// políticas RLS son `company_id in auth_company_ids()`, sin condición de rol
// ni de módulo. Agregarles un gate por módulo acá sería una decisión de
// producto nueva —vaciaría pantallas que hoy funcionan, en silencio, para
// roles como `socio`— y está fuera del alcance de este cambio de performance.
// La ruta reproduce el gate que existe; no inventa uno.
// ─────────────────────────────────────────────────────────────────────────────

import { type ModuleAccessContext } from '@/lib/modules';
import { HR_ROLES } from '@/lib/roles';

/**
 * Los 20 slices que arma el arranque, con el nombre EXACTO con el que viajan
 * en la respuesta y lo consume `data-context`. El orden es el del boot:
 * primero los 5 que antes eran Stage 1, después los 15 de Stage 2.
 */
export const BOOTSTRAP_SLICES = [
  // Stage 1 histórico
  'company',
  'periods',
  'employees',
  'commercialProfiles',
  'monthlyResults',
  // Stage 2 histórico
  'deposits',
  'withdrawals',
  'expenses',
  'expenseTemplates',
  'expenseTemplateHidden',
  'preoperativeExpenses',
  'operatingIncome',
  'brokerBalance',
  'financialStatus',
  'partners',
  'partnerDistributions',
  'propFirmSales',
  'p2pTransfers',
  'liquidityMovements',
  'investments',
] as const;

export type BootstrapSliceKey = (typeof BOOTSTRAP_SLICES)[number];

/**
 * Slices tapados por la migración 064 (política RESTRICTIVA `*_hr_role_gate`).
 * `commercial_negotiations` también lo está pero no entra al arranque.
 */
export const HR_GATED_SLICES = [
  'employees',
  'commercialProfiles',
  'monthlyResults',
] as const satisfies readonly BootstrapSliceKey[];

/**
 * Sin `company` y `periods` el dashboard no puede pintar NADA: si fallan, la
 * respuesta entera es un fallo (el cliente cae al camino de fallback) en vez
 * de un `partial` que dejaría al usuario con una pantalla vacía y verde.
 */
export const CRITICAL_SLICES = ['company', 'periods'] as const satisfies readonly BootstrapSliceKey[];

/** Contexto de acceso del caller. Mismo shape que el registro de módulos. */
export type BootstrapAccessContext = ModuleAccessContext;

/**
 * Espejo EXACTO de `public.auth_is_hr_reader()` (migración 064): admin, hr, o
 * superadmin de plataforma. La lista de roles sale de HR_ROLES en roles.ts —
 * no se reescribe acá para que agregar un rol de RRHH no exija acordarse de
 * este archivo.
 */
export function esLectorDeRrhh(ctx: BootstrapAccessContext): boolean {
  if (ctx.isSuperadmin) return true;
  return (HR_ROLES as readonly string[]).includes(ctx.role ?? '');
}

/**
 * ¿Este caller puede recibir los slices de RRHH? SOLO por rol — paridad exacta
 * con la RLS de hoy (`auth_is_hr_reader()` no mira módulos). Kevin (2026-08-28)
 * eligió paridad sobre el AND rol+módulo: un admin de una empresa sin módulo
 * RRHH vuelve a recibir estos slices, igual que se los daba RLS en el camino
 * de 20 consultas. Si algún día RLS agrega el módulo, agregarlo acá también.
 */
export function puedeLeerSlicesRrhh(ctx: BootstrapAccessContext): boolean {
  return esLectorDeRrhh(ctx);
}

/**
 * Slices que este caller NO recibe. Vuelven como `[]` en la respuesta, pero
 * enumerados en `gated` para que un vacío por permisos jamás se confunda con
 * un vacío por "no hay datos" — la regla de §1.2.
 */
export function slicesVedados(ctx: BootstrapAccessContext): BootstrapSliceKey[] {
  return puedeLeerSlicesRrhh(ctx) ? [] : [...HR_GATED_SLICES];
}
