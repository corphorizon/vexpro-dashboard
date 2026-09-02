'use client';

import { usePathname } from 'next/navigation';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';

// ─────────────────────────────────────────────────────────────────────────────
// ModuleRouteGuard
//
// Central gatekeeper that turns inactive / forbidden modules into a visible
// 403 surface at the layout level. Pages that already have their own guard
// can keep it — this component is a safety net for ones that don't.
//
// Mapping here is explicit (not auto-inferred) so we never accidentally lock
// users out of a route when a new page is added without a registered module.
// ─────────────────────────────────────────────────────────────────────────────

// Pathname prefix → module key. Order matters: first match wins.
const ROUTE_TO_MODULE: Array<[RegExp, string]> = [
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
  // /auditoria was removed — platform audit lives at
  //   /superadmin/companies/[id] (tab "Auditoría") and is superadmin-only.
];

// Routes that are always accessible — personal surfaces and the dashboard home.
const ALWAYS_ALLOWED = /^\/(perfil|$)/;

function resolveModule(pathname: string): string | null {
  for (const [re, mod] of ROUTE_TO_MODULE) {
    if (re.test(pathname)) return mod;
  }
  return null;
}

export function ModuleRouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const { company } = useData();

  // Personal routes + home pass through.
  if (ALWAYS_ALLOWED.test(pathname)) return <>{children}</>;

  const moduleKey = resolveModule(pathname);
  if (!moduleKey) return <>{children}</>; // unmapped route — let it render

  // Superadmin bypass is baked into hasModuleAccess. For normal users this
  // enforces both user.allowed_modules AND company.active_modules.
  if (hasModuleAccess(user, moduleKey, company?.active_modules, company?.business_model)) {
    return <>{children}</>;
  }

  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <div className="text-center space-y-2">
        <p className="text-4xl font-bold text-muted-foreground">403</p>
        <p className="text-sm text-muted-foreground">
          Este módulo está desactivado para tu empresa o no tienes permiso para acceder.
        </p>
      </div>
    </div>
  );
}
