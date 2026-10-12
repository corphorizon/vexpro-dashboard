'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { Plus, Trash2, Mail, RotateCw, Users } from 'lucide-react';
import { BUILT_IN_ROLES, BUILT_IN_ROLE_LABELS } from '@/lib/roles';
import { ROLE_DEFAULT_MODULES } from '@/lib/auth-context';
import { blockedModules } from '@/lib/business-model';
import { ALL_MODULES } from '../companies/_form';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Field, Input, Select } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionButton } from '@/components/payment-orders/action-button';
import {
  USERS_LIST_LIMIT,
  companySummary,
  formatCount,
  membershipCoverage,
  plural,
  twofaKind,
} from '@/components/superadmin/superadmin-model';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin/users — cross-tenant user management
//
// Lists every company_users row across the platform with the company name
// joined in. The superadmin can:
//   · Filter by company
//   · Invite a new user to any company (sends a magic link)
//   · Change a user's role (admin/auditor/hr/socio/soporte/invitado)
//   · Remove the membership
//
// Auth user records in auth.users are NOT deleted here — only the membership,
// because the same person may belong to multiple tenants.
//
// «Libro mayor» (2026-10-12):
//   · El fallo que no da error: con un error al cambiar de filtro, la tabla
//     del filtro ANTERIOR seguía debajo del aviso. Ahora con error no hay
//     tabla. Y el endpoint corta en 500 filas sin flag: si la suma de
//     user_count del filtro supera lo que llegó (o se llega al tope), un
//     Notice y el pie lo dicen con números (membershipCoverage).
//   · <table> a mano → FinTable (tarjetas < 720 px: empresa y 2FA bajo el
//     nombre, el rol editable sigue a mano). Badges de paleta cruda →
//     StatusBadge; botones rojo/azul crudos → ActionButton danger/ghost.
//   · El «Volver al panel» se fue: la barra lateral del panel ya lleva.
//   · Endpoints, payloads, confirmaciones y el fetch plano (ver load) iguales.
// ─────────────────────────────────────────────────────────────────────────────

interface UserRow {
  id: string;
  user_id: string;
  company_id: string;
  email: string;
  name: string;
  role: string;
  allowed_modules: string[] | null;
  twofa_enabled: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
  companies: { name: string; slug: string; status: string } | null;
}

interface CompanyOpt {
  id: string;
  name: string;
  slug: string;
  status: string;
  active_modules: string[] | null;
  business_model: string | null;
  /** Membresías de la entidad (GET /api/superadmin/companies). Sirve para contar el recorte. */
  user_count?: number | null;
}

// Los roles salen del registro único (src/lib/roles.ts). Era la sexta copia
// literal de la misma lista en el repo.
const ROLES: readonly string[] = BUILT_IN_ROLES;

/**
 * Rol por defecto de una invitación nueva: el MÍNIMO del catálogo. Antes
 * arrancaba en `admin` con todos los módulos tildados, así que un enter
 * distraído creaba un administrador con acceso total —órdenes de pago, RRHH y
 * el registro de actividad incluidos— en la empresa que estuviera seleccionada.
 */
const DEFAULT_INVITE_ROLE = 'invitado';

/** Módulos que la empresa destino realmente muestra (contratados − modelo). */
function eligibleModulesFor(company: CompanyOpt | undefined): string[] {
  if (!company) return [];
  const active = new Set(company.active_modules ?? []);
  const blocked = new Set(blockedModules(company.business_model));
  return ALL_MODULES.map((m) => m.key).filter((k) => active.has(k) && !blocked.has(k));
}

export default function SuperadminUsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [companies, setCompanies] = useState<CompanyOpt[]>([]);
  const [filterCompany, setFilterCompany] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      // fetch PLANO a propósito: apiFetch le pega `?company_id=` del
      // viewing-as guardado en localStorage, y el endpoint filtra por él. Con
      // un viewing-as abierto, "Todas las entidades" mostraba UNA sola y
      // mentía. Acá el scope lo decide el selector, punto.
      const qs = filterCompany === 'all' ? '' : `?company_id=${encodeURIComponent(filterCompany)}`;
      const [uRes, cRes] = await Promise.all([
        fetch(`/api/superadmin/users${qs}`),
        fetch('/api/superadmin/companies'),
      ]);
      const uJson = await uRes.json();
      const cJson = await cRes.json();
      if (!uJson.success) throw new Error(uJson.error || 'Error cargando usuarios');
      if (!cJson.success) throw new Error(cJson.error || 'Error cargando entidades');
      setUsers(uJson.users);
      setCompanies(cJson.companies);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }, [filterCompany]);

  useEffect(() => {
    load();
  }, [load]);

  const updateUser = async (id: string, patch: Partial<Pick<UserRow, 'role' | 'name' | 'allowed_modules'>>) => {
    try {
      const res = await apiFetch(`/api/superadmin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        alert(json.error || 'Error actualizando');
        return;
      }
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error de red');
    }
  };

  const [resendingId, setResendingId] = useState<string | null>(null);

  const resendInvite = async (id: string, email: string) => {
    if (!confirm(`Reenviar invitación a ${email}?`)) return;
    setResendingId(id);
    try {
      const res = await apiFetch(`/api/superadmin/users/${id}/resend-invite`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.success) {
        alert(json.error || 'Error reenviando invitación');
        return;
      }
      alert(`Invitación reenviada a ${email}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setResendingId(null);
    }
  };

  const deleteUser = async (id: string, email: string) => {
    if (!confirm(`Eliminar la membresía de ${email}?`)) return;
    try {
      const res = await apiFetch(`/api/superadmin/users/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || !json.success) {
        alert(json.error || 'Error eliminando');
        return;
      }
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error de red');
    }
  };

  // Cobertura de la lista: la suma de user_count del filtro (misma tabla,
  // company_users) dice cuántas membresías hay; el endpoint corta en 500.
  const expected =
    filterCompany === 'all'
      ? companySummary(companies)?.users ?? null
      : companies.find((c) => c.id === filterCompany)?.user_count ?? null;
  const coverage = users ? membershipCoverage(users.length, expected) : null;
  const filterName =
    filterCompany === 'all' ? 'todas las entidades' : companies.find((c) => c.id === filterCompany)?.name ?? 'la entidad';

  const twofaBadge = (u: UserRow) => (
    <StatusBadge kind={twofaKind(u.twofa_enabled)} label={u.twofa_enabled ? '2FA activo' : '2FA sin configurar'} />
  );

  const columns: FinColumn<UserRow>[] = [
    {
      key: 'user',
      header: 'Usuario',
      cell: (u) => (
        <div className="min-w-0 py-1.5 max-[720px]:py-0">
          <div className="truncate font-medium text-foreground">{u.name}</div>
          <div className="truncate text-[12px] leading-[1.3] text-text-3">{u.email}</div>
          <div className="mt-1 hidden flex-wrap items-center gap-1.5 text-[12px] text-text-3 max-[720px]:flex">
            <span>{u.companies?.name ?? '—'}</span>
            {u.companies?.status === 'inactive' && <StatusBadge kind="neutral" label="Entidad inactiva" />}
            {twofaBadge(u)}
          </div>
        </div>
      ),
    },
    {
      key: 'company',
      header: 'Empresa',
      hideSm: true,
      cell: (u) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="text-text-2">{u.companies?.name ?? '—'}</span>
          {u.companies?.status === 'inactive' && <StatusBadge kind="neutral" label="inactiva" />}
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Rol',
      cardSide: 'left',
      cell: (u) => (
        <Select
          aria-label={`Rol de ${u.email}`}
          value={u.role}
          onChange={(e) => updateUser(u.id, { role: e.target.value })}
          className="max-w-[180px]"
        >
          {BUILT_IN_ROLES.map((r) => (
            <option key={r} value={r}>
              {BUILT_IN_ROLE_LABELS[r]}
            </option>
          ))}
          {/* Allow the current value even if it's a custom role */}
          {!ROLES.includes(u.role) && <option value={u.role}>{u.role} (custom)</option>}
        </Select>
      ),
    },
    { key: 'twofa', header: '2FA', hideSm: true, cell: twofaBadge },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Usuarios"
        subtitle="Membresías de todas las entidades: rol, invitación y acceso."
        actions={
          <>
            <Select
              aria-label="Filtrar por entidad"
              value={filterCompany}
              onChange={(e) => setFilterCompany(e.target.value)}
              className="w-auto min-w-[200px]"
            >
              <option value="all">Todas las entidades</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <ActionButton variant="primary" onClick={() => setInviteOpen(true)}>
              <Plus aria-hidden className="size-4" /> Invitar usuario
            </ActionButton>
          </>
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
          {error}. No se muestra la lista anterior: podría ser de otro filtro.
        </Notice>
      )}

      {!error && coverage?.truncated && users && (
        <Notice kind="pend" title="La lista está recortada">
          {coverage.total !== null
            ? `Se muestran ${formatCount(users.length)} de ${formatCount(coverage.total)} membresías de ${filterName}.`
            : `Se muestran ${formatCount(users.length)} membresías: es el máximo que devuelve el servidor, puede haber más.`}{' '}
          Filtrá por entidad para ver el resto.
        </Notice>
      )}

      {!error && users === null && <Skeleton className="h-48" />}

      {!error && users !== null && (
        <Panel
          title={filterCompany === 'all' ? 'Todas las membresías' : `Membresías de ${filterName}`}
          hint={`${formatCount(users.length)} ${plural(users.length, 'usuario', 'usuarios')}`}
          flush
          footer={
            coverage?.truncated
              ? coverage.total !== null
                ? `Mostrando ${formatCount(users.length)} de ${formatCount(coverage.total)}.`
                : `Mostrando ${formatCount(users.length)} (tope del servidor: ${formatCount(USERS_LIST_LIMIT)}).`
              : undefined
          }
        >
          <FinTable<UserRow>
            caption="Usuarios de la plataforma"
            columns={columns}
            rows={users}
            rowKey={(u) => u.id}
            empty={
              <EmptyState compact icon={Users} title="Sin usuarios" description="No hay usuarios para el filtro actual." />
            }
            rowActions={(u) => (
              <>
                {/* Reenviar invitación: solo si el usuario aún no ha
                    activado su cuenta (must_change_password=true). */}
                {u.must_change_password && (
                  <ActionButton
                    variant="ghost"
                    onClick={() => resendInvite(u.id, u.email)}
                    loading={resendingId === u.id}
                    title="Reenviar invitación (el usuario aún no creó contraseña)"
                  >
                    {resendingId !== u.id && <Mail aria-hidden className="size-4" />}
                    <span className="max-sm:sr-only">Reenviar</span>
                  </ActionButton>
                )}
                <ActionButton variant="danger" onClick={() => deleteUser(u.id, u.email)}>
                  <Trash2 aria-hidden className="size-4" />
                  <span className="max-sm:sr-only">Quitar</span>
                </ActionButton>
              </>
            )}
          />
        </Panel>
      )}

      {inviteOpen && (
        <InviteModal
          companies={companies}
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            setInviteOpen(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function InviteModal({
  companies,
  onClose,
  onInvited,
}: {
  companies: CompanyOpt[];
  onClose: () => void;
  onInvited: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(DEFAULT_INVITE_ROLE);
  const [companyId, setCompanyId] = useState<string>(companies[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedCompany = companies.find((c) => c.id === companyId);
  // Solo los módulos que la empresa destino tiene contratados Y que su modelo
  // de negocio no esconde. Antes se ofrecía el catálogo COMPLETO, así que se
  // podían asignar pantallas que en esa empresa ni existen.
  const eligible = useMemo(
    () => eligibleModulesFor(selectedCompany),
    [selectedCompany],
  );
  const eligibleModules = ALL_MODULES.filter((m) => eligible.includes(m.key));

  const defaultsFor = useCallback(
    (nextRole: string, company: CompanyOpt | undefined) => {
      const elegibles = new Set(eligibleModulesFor(company));
      return (ROLE_DEFAULT_MODULES[nextRole] ?? ['summary']).filter((m) => elegibles.has(m));
    },
    [],
  );

  const [allowed, setAllowed] = useState<string[]>(() =>
    defaultsFor(DEFAULT_INVITE_ROLE, companies[0]),
  );

  // Cambiar de empresa RESETEA rol y módulos: quedarse con lo tildado para
  // otra entidad era la forma silenciosa de asignar módulos que la nueva no
  // tiene (y de arrastrar un rol elegido para otro contexto).
  const onCompanyChange = (nextId: string) => {
    setCompanyId(nextId);
    setRole(DEFAULT_INVITE_ROLE);
    setAllowed(defaultsFor(DEFAULT_INVITE_ROLE, companies.find((c) => c.id === nextId)));
  };

  const onRoleChange = (nextRole: string) => {
    setRole(nextRole);
    setAllowed(defaultsFor(nextRole, selectedCompany));
  };

  const toggle = (k: string) =>
    setAllowed((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/superadmin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, role, company_id: companyId, allowed_modules: allowed }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onInvited();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-ui-xl border border-border bg-card text-foreground shadow-3"
      >
        <div className="border-b border-border px-5 py-3">
          <h3 id="invite-title" className="text-[15px] font-semibold">Invitar usuario</h3>
          <p className="text-[12.5px] text-text-3">Recibe un email para crear su contraseña.</p>
        </div>

        <div className="space-y-4 overflow-y-auto p-5">
          {err && (
            <Notice kind="bad" title="No se pudo enviar la invitación">
              {err}
            </Notice>
          )}
          {companies.length === 0 && (
            <Notice kind="pend" title="No hay entidades para elegir">
              La lista de entidades no cargó o está vacía: sin entidad no se puede invitar.
            </Notice>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Nombre" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email" required>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Empresa" required>
              <Select value={companyId} onChange={(e) => onCompanyChange(e.target.value)}>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Rol">
              <Select value={role} onChange={(e) => onRoleChange(e.target.value)}>
                {BUILT_IN_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {BUILT_IN_ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div>
            <p className="mb-1.5 text-[12.5px] font-medium text-text-2">Módulos permitidos</p>
            {eligibleModules.length === 0 ? (
              <Notice kind="info" title="Sin módulos disponibles">
                La empresa seleccionada no tiene módulos disponibles.
              </Notice>
            ) : (
              <div className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-ui-md border border-border p-2 min-[420px]:grid-cols-2 sm:grid-cols-3">
                {eligibleModules.map((m) => (
                  <label
                    key={m.key}
                    className="flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-ui-sm px-1 text-[13px] hover:bg-surface-2 pointer-coarse:min-h-11"
                  >
                    <input
                      type="checkbox"
                      checked={allowed.includes(m.key)}
                      onChange={() => toggle(m.key)}
                      className="size-4 shrink-0 accent-brand-ink"
                    />
                    <span>{m.label}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1 text-[12px] text-text-3">
              Defaults según el rol, acotados a los módulos activos de la empresa.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <ActionButton variant="secondary" onClick={onClose}>
            Cancelar
          </ActionButton>
          <ActionButton type="submit" variant="primary" loading={submitting} disabled={!companyId}>
            Enviar invitación
          </ActionButton>
        </div>
      </form>
    </div>
  );
}
