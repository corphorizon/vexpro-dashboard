// ─────────────────────────────────────────────────────────────────────────────
// Resolución del contexto del asistente — UNA sola vez por request.
//
// `verifyAdminAuth` devuelve quién es y de qué empresa, pero no los
// `allowed_modules` del usuario ni los `active_modules` / `business_model` de
// la empresa, y las herramientas los necesitan para decidir qué puede leer.
// Se leen acá, juntos, y se pasan al bucle: si cada herramienta los resolviera
// por su cuenta tendríamos seis lecturas por pregunta y —peor— seis lugares
// donde el criterio puede divergir.
//
// El superadmin llega con `role: 'admin'` e `isSuperadmin: true` (así lo
// resuelve api-auth). No tiene fila en `company_users`, así que
// `allowedModules` queda en null: `canAccessModule` ya lo hace pasar por el
// bypass, pero SIN saltarse el modelo de negocio.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import type { AuthInfo } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import type { AssistantContext } from './tools';

export interface ContextoResuelto {
  ctx: AssistantContext;
  companyName: string;
}

export async function resolverContexto(
  auth: AuthInfo,
  locale: 'es' | 'en',
): Promise<ContextoResuelto> {
  const db = createAdminClient();

  const [empresa, miembro] = await Promise.all([
    db
      .from('companies')
      .select('name, active_modules, business_model')
      .eq('id', auth.companyId)
      .maybeSingle<{ name: string | null; active_modules: string[] | null; business_model: unknown }>(),
    auth.isSuperadmin
      ? Promise.resolve({ data: null, error: null })
      : db
          .from('company_users')
          .select('allowed_modules, preferred_language')
          .eq('user_id', auth.userId)
          // El `.eq('company_id', …)` es obligatorio incluso acá: con el admin
          // client la RLS no filtra nada (§4.2).
          .eq('company_id', auth.companyId)
          .maybeSingle<{ allowed_modules: string[] | null; preferred_language: string | null }>(),
  ]);

  const preferido = miembro?.data?.preferred_language;
  const idioma: 'es' | 'en' = preferido === 'en' ? 'en' : preferido === 'es' ? 'es' : locale;

  return {
    companyName: empresa.data?.name ?? 'la empresa',
    ctx: {
      db,
      companyId: auth.companyId,
      role: auth.role,
      isSuperadmin: auth.isSuperadmin === true,
      allowedModules: Array.isArray(miembro?.data?.allowed_modules)
        ? miembro.data.allowed_modules
        : null,
      // `null` = no restringir a nivel tenant (empresas anteriores a la
      // feature). Un array VACÍO sí bloquea, igual que en el resto del repo.
      activeModules: Array.isArray(empresa.data?.active_modules)
        ? empresa.data.active_modules
        : null,
      businessModel: empresa.data?.business_model,
      locale: idioma,
    },
  };
}
