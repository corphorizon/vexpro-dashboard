'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Users, Settings2, UserPlus, RotateCw } from 'lucide-react';
import { formatDateRelative } from '@/lib/dates';
import { BUILT_IN_ROLE_LABELS } from '@/lib/roles';
import { ManageUserPanel } from './_manage-panel';
import { CreateUserModal } from './_create-modal';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionButton, actionButtonClass } from '@/components/payment-orders/action-button';
import {
  formatCount,
  formatLastLogin,
  initials,
  plural,
  twofaKind,
  userStatusKind,
} from '@/components/superadmin/superadmin-model';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin/companies/[id]/users
//
// Roster of a single tenant — fed by GET /api/superadmin/companies/:id/users.
// Each row opens the slide-over <ManageUserPanel /> where the superadmin can
// change role, status, module access, reset password, disable 2FA, and see
// the user's recent audit activity.
//
// «Libro mayor» (2026-10-12):
//   · El fallo que no da error: `users` arrancaba en `[]` y, si la carga
//     fallaba, debajo del error se dibujaba la tabla vacía con «Sin usuarios —
//     esta organización aún no tiene usuarios». Ahora con error NO hay tabla:
//     un Notice con el motivo y «Reintentar».
//   · ROLE_COLORS (seis colores crudos, uno por rol, sin significado) se fue:
//     el rol es un badge gris (spec §2.1). Estado y 2FA con StatusBadge —
//     2FA sin configurar es `pend` porque es obligatorio (migración 029).
//   · DataTable → FinTable (tarjetas < 720 px con estado y 2FA bajo el nombre).
// ─────────────────────────────────────────────────────────────────────────────

export interface CompanyUser {
  id: string;
  user_id: string;
  company_id: string;
  email: string;
  name: string;
  role: string;
  status: 'active' | 'inactive';
  allowed_modules: string[] | null;
  twofa_enabled: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Company {
  id: string;
  name: string;
  active_modules: string[];
}

// Etiquetas del registro único (src/lib/roles.ts) — era otra copia literal.
const ROLE_LABEL: Record<string, string> = BUILT_IN_ROLE_LABELS;

export default function CompanyUsersPage() {
  const params = useParams<{ id: string }>();
  const companyId = params?.id;

  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CompanyUser | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/superadmin/companies/${companyId}/users`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setUsers(json.users);
      setCompany(json.company);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando usuarios');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUpdated = (updated: CompanyUser) => {
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)));
    setSelected((curr) => (curr && curr.id === updated.id ? { ...curr, ...updated } : curr));
  };

  const statusBadge = (u: CompanyUser) => (
    <StatusBadge kind={userStatusKind(u.status)} label={u.status === 'active' ? 'Activo' : 'Inactivo'} />
  );
  const twofaBadge = (u: CompanyUser) => (
    <StatusBadge kind={twofaKind(u.twofa_enabled)} label={u.twofa_enabled ? '2FA activo' : '2FA sin configurar'} />
  );

  const columns: FinColumn<CompanyUser>[] = [
    {
      key: 'user',
      header: 'Usuario',
      cell: (u) => (
        <div className="flex min-w-0 items-center gap-3 py-1.5 max-[720px]:py-0">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[12px] font-semibold text-text-2"
          >
            {initials(u.name || u.email)}
          </span>
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{u.name || '(sin nombre)'}</div>
            <div className="truncate text-[12px] leading-[1.3] text-text-3">{u.email}</div>
            <div className="mt-1 hidden flex-wrap items-center gap-1.5 max-[720px]:flex">
              {statusBadge(u)}
              {twofaBadge(u)}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Rol',
      hideSm: true,
      cell: (u) => <StatusBadge kind="neutral" label={ROLE_LABEL[u.role] ?? u.role} />,
    },
    { key: 'status', header: 'Estado', hideSm: true, cell: statusBadge },
    { key: 'twofa', header: '2FA', hideSm: true, cell: twofaBadge },
    {
      key: 'last',
      header: 'Último acceso',
      hideSm: true,
      cell: (u) => (
        <span className="whitespace-nowrap text-text-2" suppressHydrationWarning>
          {formatLastLogin(u.last_login_at, now, formatDateRelative)}
        </span>
      ),
    },
  ];

  return (
    <div className="max-w-6xl space-y-4">
      <Link href={`/superadmin/companies/${companyId}`} className={actionButtonClass('ghost', '-ml-3')}>
        <ArrowLeft aria-hidden className="size-4" /> Volver a la entidad
      </Link>

      <PageHeader
        icon={Users}
        title={company?.name ? `Usuarios — ${company.name}` : 'Usuarios'}
        subtitle="Roles, accesos por módulo, seguridad y auditoría de cada usuario de la organización."
        actions={
          <ActionButton variant="primary" onClick={() => setCreateOpen(true)} disabled={!company}>
            <UserPlus aria-hidden className="size-4" />
            Agregar usuario
          </ActionButton>
        }
      />

      {error && (
        <Notice
          kind="bad"
          title="No se pudo cargar la lista de usuarios"
          action={
            <ActionButton variant="secondary" onClick={() => void load()}>
              <RotateCw aria-hidden className="size-4" /> Reintentar
            </ActionButton>
          }
        >
          {error}. No se muestra la tabla: una lista vacía acá diría que la organización no tiene usuarios.
        </Notice>
      )}

      {loading && !error && (
        <Panel title="Usuarios de la organización" flush>
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        </Panel>
      )}

      {!loading && !error && (
        <Panel
          title="Usuarios de la organización"
          hint={`${formatCount(users.length)} ${plural(users.length, 'usuario', 'usuarios')}`}
          flush
        >
          <FinTable<CompanyUser>
            caption="Usuarios de la organización"
            columns={columns}
            rows={users}
            rowKey={(u) => u.id}
            selectedKey={selected?.id ?? null}
            empty={
              <EmptyState
                compact
                icon={Users}
                title="Sin usuarios"
                description="Esta organización aún no tiene usuarios."
              />
            }
            rowActions={(u) => (
              <ActionButton variant="ghost" onClick={() => setSelected(u)}>
                <Settings2 aria-hidden className="size-4" />
                <span className="max-sm:sr-only">Gestionar</span>
              </ActionButton>
            )}
          />
        </Panel>
      )}

      {selected && company && (
        <ManageUserPanel
          user={selected}
          companyActiveModules={company.active_modules}
          onClose={() => setSelected(null)}
          onUpdated={handleUpdated}
        />
      )}

      {company && (
        <CreateUserModal
          companyId={company.id}
          companyActiveModules={company.active_modules}
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(u) => {
            // Prepend optimistically and re-load to capture server-side defaults.
            setUsers((prev) => [u, ...prev]);
            void load();
          }}
        />
      )}
    </div>
  );
}
