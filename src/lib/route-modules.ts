// ─────────────────────────────────────────────────────────────────────────────
// Ruta → módulo que la protege. Lo usa <ModuleRouteGuard> (layout del
// dashboard) para convertir un módulo apagado o prohibido en un 403 visible.
//
// Se sacó de module-route-guard.tsx (2026-10-12, Fase 4) a un archivo puro
// para poder testearlo: `module-groups.test.ts` verifica que cada entrada del
// menú resuelve acá al MISMO módulo con el que el menú la muestra. Al hacerlo
// apareció que `/finanzas/crm` no estaba en la tabla: la pantalla se escondía
// del menú sin `income`, pero la URL escrita a mano entraba igual (el mismo
// agujero que ya habían tenido el pool y el hedge fund). Se agregó.
//
// Descartado: derivar esta tabla del registro de navegación. Los prefijos de
// acá protegen también rutas que NO están en el menú (`/risk/<cualquiera>`,
// `/rrhh/perfil`); derivarla de las entradas del menú las dejaba sin guardián.
// ─────────────────────────────────────────────────────────────────────────────

// Pathname prefix → module key. Order matters: first match wins.
export const ROUTE_TO_MODULE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/resumen-general(\/|$)/, 'summary'],
  [/^\/movimientos(\/|$)/, 'movements'],
  [/^\/egresos(\/|$)/, 'expenses'],
  [/^\/ingresos(\/|$)/, 'income'],
  // ANTES que /liquidez aunque no se solapen (`/liquidez-pool` no matchea
  // `^\/liquidez(\/|$)`): el orden acá es contrato y dejarlos juntos evita que
  // alguien agregue mañana un `^\/liquidez` suelto y se coma el pool.
  // Faltaba: el pool era la única pantalla del dashboard sin guardián, así que
  // el bloqueo por modelo de negocio lo escondía del menú pero la URL escrita
  // a mano seguía entrando.
  [/^\/liquidez-pool(\/|$)/, 'liquidity_pool'],
  [/^\/liquidez(\/|$)/, 'liquidity'],
  [/^\/inversiones(\/|$)/, 'investments'],
  // Hedge Fund (migración 125). Va acá y no sólo en el menú por lo que enseñó
  // el pool: el bloqueo por modelo de negocio esconde el ítem del sidebar,
  // pero la URL escrita a mano entra igual si el guardián no la conoce.
  [/^\/hedge-fund(\/|$)/, 'hedge_fund'],
  [/^\/balances(\/|$)/, 'balances'],
  [/^\/socios(\/|$)/, 'partners'],
  [/^\/clientes(\/|$)/, 'clients'],
  [/^\/upload(\/|$)/, 'upload'],
  [/^\/periodos(\/|$)/, 'periods'],
  [/^\/rrhh(\/|$)/, 'hr'],
  [/^\/comisiones(\/|$)/, 'commissions'],
  [/^\/risk(\/|$)/, 'risk'],
  [/^\/usuarios(\/|$)/, 'users'],
  [/^\/logs(\/|$)/, 'logs'],
  [/^\/ordenes-pago(\/|$)/, 'payment_orders'],
  [/^\/asistente(\/|$)/, 'assistant'],
  [/^\/finanzas\/reportes(\/|$)/, 'reports'],
  [/^\/finanzas\/forecast(\/|$)/, 'reports'],
  [/^\/finanzas\/consolidado(\/|$)/, 'reports'],
  // Faltaba (2026-10-12): ver la cabecera.
  [/^\/finanzas\/crm(\/|$)/, 'income'],
  // /auditoria was removed — platform audit lives at
  //   /superadmin/companies/[id] (tab "Auditoría") and is superadmin-only.
];

// Routes that are always accessible — personal surfaces and the dashboard home.
export const ALWAYS_ALLOWED = /^\/(perfil|$)/;

export function resolveModule(pathname: string): string | null {
  for (const [re, mod] of ROUTE_TO_MODULE) {
    if (re.test(pathname)) return mod;
  }
  return null;
}
