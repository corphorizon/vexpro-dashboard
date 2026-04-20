'use client';

// /superadmin — Phase 3 stub.
//
// This is a placeholder landing page so the layout guard has something to
// render. Phase 4 will replace it with the real dashboard (entity list,
// metrics, CRUD buttons). For now, the superadmin can verify:
//   - They reach /superadmin after login
//   - A non-superadmin is bounced away
//   - The "Viewing as" flow works when they navigate into a company (still
//     WIP: entry buttons are built in Phase 4)

import { useAuth } from '@/lib/auth-context';

export default function SuperadminHome() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Panel superadmin</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Hola, {user?.name}. Estás en el panel de Horizon Consulting.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="text-base font-semibold mb-2">Estado</h2>
        <ul className="text-sm text-muted-foreground space-y-1">
          <li>✅ Autenticado como superadmin (rol resuelto desde <code>platform_users</code>).</li>
          <li>✅ Acceso cross-tenant habilitado vía RLS.</li>
          <li>⏳ Panel de gestión de entidades — se construye en la Fase 4.</li>
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        <p>
          Próximamente aquí verás el listado de entidades, métricas globales y
          botones para crear empresa / entrar a una entidad / gestionar usuarios.
        </p>
      </section>
    </div>
  );
}
