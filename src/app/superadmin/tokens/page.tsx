'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin/tokens — llaves de los aplicativos que consumen nuestra API.
//
// Smart Dashboard es el único que habla con el MySQL de MT5 y con el Mongo de
// Orion. Atlas y los demás leen por la API con un token. Acá se crean, se
// miran y se cortan.
//
// ── LO QUE ESTA PANTALLA TIENE QUE DEJAR CLARO ────────────────────────────
//  1. Que el token se ve UNA vez. Si el usuario cierra el aviso sin copiarlo,
//     no hay forma de recuperarlo — y es mejor así: si pudiéramos mostrarlo de
//     nuevo, es que lo tendríamos guardado.
//  2. A quién le está abriendo la puerta y a qué organización.
//  3. Si el token todavía se usa, antes de revocarlo. Cortar algo vivo un
//     viernes es peor que dejar algo muerto.
//
// «Libro mayor» (2026-10-12):
//   · El fallo que no da error: si la carga fallaba había un toast y debajo
//     «Todavía no hay tokens» — la lista vacía afirmaba algo que no se sabía.
//     Ahora con error hay un Notice con «Reintentar» y no hay lista. Y si la
//     lista de organizaciones fallaba (`.catch(() => null)`), el selector del
//     alta quedaba vacío sin explicación: ahora lo dice.
//   · «Copiar» decía «Copiado» aunque el portapapeles rechazara la escritura
//     (`void writeText`): con el secreto que se ve UNA vez, eso es perderlo.
//     Ahora espera la promesa y, si falla, pide copiarlo a mano.
//   · El secreto sigue viviendo sólo en memoria hasta «Ya lo copié»; ni el
//     alta ni la revocación cambiaron (mismos endpoints y payloads).
//   · Card/Button/Badge legados → Panel, ActionButton, StatusBadge; scopes con
//     Chip; tarjeta por token → FinTable (tarjetas < 720 px).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, Ban, Copy, Check, AlertTriangle, RotateCw } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Chip } from '@/components/ui/chip';
import { Field, Input, Select } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { ActionButton } from '@/components/ui/action-button';
import { formatCount, plural } from '@/components/superadmin/superadmin-model';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToasts } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/dates';
import { cn } from '@/lib/utils';

interface TokenRow {
  id: string;
  company_id: string;
  app_name: string;
  token_prefix: string;
  scopes: string[];
  is_active: boolean;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
  created_by_name: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  request_count: number;
  companies: { name: string } | null;
}

interface CompanyRow {
  id: string;
  name: string;
}

export default function TokensPage() {
  const { toast, ToastHost } = useToasts();
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({ company_id: '', app_name: '', scopes: [] as string[] });
  /** El secreto recién creado. Vive sólo en memoria y sólo hasta que se cierre. */
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [toRevoke, setToRevoke] = useState<TokenRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [companiesError, setCompaniesError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, cRes] = await Promise.all([
        apiFetch('/api/superadmin/partner-tokens'),
        apiFetch('/api/superadmin/companies'),
      ]);
      const t = await tRes.json();
      if (!tRes.ok || t?.success === false) throw new Error(t?.error ?? 'No se pudieron cargar los tokens');
      setTokens(t.tokens ?? []);
      setScopes(t.scopes ?? []);
      setLoadError(null);
      const c = await cRes.json().catch(() => null);
      const list = Array.isArray(c?.companies) ? c.companies : Array.isArray(c) ? c : null;
      setCompanies(list ?? []);
      setCompaniesError(
        cRes.ok && list ? null : (c?.error as string | undefined) ?? `HTTP ${cRes.status}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al cargar';
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function crear() {
    setBusy(true);
    try {
      const res = await apiFetch('/api/superadmin/partner-tokens', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || data?.success === false) throw new Error(data?.error ?? 'No se pudo crear');
      setSecret(data.secret);
      setCopied(false);
      setCopyFailed(false);
      setCreating(false);
      setForm({ company_id: '', app_name: '', scopes: [] });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al crear');
    } finally {
      setBusy(false);
    }
  }

  async function revocar() {
    if (!toRevoke) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/superadmin/partner-tokens', {
        method: 'PATCH',
        body: JSON.stringify({ id: toRevoke.id, reason: 'Revocado desde el panel' }),
      });
      const data = await res.json();
      if (!res.ok || data?.success === false) throw new Error(data?.error ?? 'No se pudo revocar');
      toast.success(`Acceso de "${toRevoke.app_name}" cortado.`);
      setToRevoke(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al revocar');
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      // Antes: `void writeText(...)` y «Copiado» igual. Si el portapapeles
      // está bloqueado, el usuario cerraba el aviso creyendo que lo tenía.
      setCopied(false);
      setCopyFailed(true);
    }
  }

  const columns: FinColumn<TokenRow>[] = [
    {
      key: 'app',
      header: 'Aplicativo',
      cell: (t) => (
        <div className={cn('min-w-0 py-1.5 max-[720px]:py-0', !t.is_active && 'text-text-2')}>
          <div className="truncate font-medium">{t.app_name}</div>
          <div className="truncate font-mono text-[12px] text-text-3">{t.token_prefix}…</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {t.scopes.length === 0 ? (
              <span className="text-[12px] text-text-3">sin permisos</span>
            ) : (
              t.scopes.map((s) => (
                <span key={s} className="rounded-ui-sm border border-border-strong px-1.5 font-mono text-[12px] leading-5 text-text-2">
                  {s}
                </span>
              ))
            )}
          </div>
          <div className="mt-1 hidden flex-wrap items-center gap-1.5 text-[12px] text-text-3 max-[720px]:flex">
            <StatusBadge kind={t.is_active ? 'ok' : 'neutral'} label={t.is_active ? 'Activo' : 'Revocado'} />
            <span>{t.companies?.name ?? '—'}</span>
            <span>· {t.last_used_at ? `usado ${formatDateTime(t.last_used_at)}` : 'nunca se usó'}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'company',
      header: 'Organización',
      hideSm: true,
      cell: (t) => <span className="text-text-2">{t.companies?.name ?? '—'}</span>,
    },
    {
      key: 'status',
      header: 'Estado',
      hideSm: true,
      cell: (t) => (
        <div className="py-1.5">
          <StatusBadge kind={t.is_active ? 'ok' : 'neutral'} label={t.is_active ? 'Activo' : 'Revocado'} />
          {!t.is_active && (
            <div className="mt-0.5 text-[12px] leading-[1.3] text-text-3">
              {formatDateTime(t.revoked_at)}
              {t.revoked_reason ? ` · ${t.revoked_reason}` : ''}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'used',
      header: 'Último uso',
      hideSm: true,
      // Antes de cortar algo, saber si está vivo.
      cell: (t) => (
        <div className="py-1.5">
          <div className={cn('whitespace-nowrap', t.last_used_at ? 'text-foreground' : 'text-text-3')}>
            {t.last_used_at ? formatDateTime(t.last_used_at) : 'Nunca se usó'}
          </div>
          {t.last_used_ip && <div className="font-mono text-[12px] text-text-3">{t.last_used_ip}</div>}
        </div>
      ),
    },
    {
      key: 'calls',
      header: 'Llamadas',
      kind: 'number',
      value: (t) => t.request_count,
    },
    {
      key: 'created',
      header: 'Creado',
      hideSm: true,
      cell: (t) => (
        <div className="py-1.5">
          <div className="whitespace-nowrap">{formatDateTime(t.created_at)}</div>
          {t.created_by_name && <div className="text-[12px] text-text-3">{t.created_by_name}</div>}
        </div>
      ),
    },
  ];

  const activeCount = tokens.filter((t) => t.is_active).length;

  return (
    <div className="space-y-4">
      {ToastHost}

      <PageHeader
        icon={KeyRound}
        title="Tokens de aplicativos"
        subtitle="Smart Dashboard es el único que se conecta al MySQL de MetaTrader y al Mongo del CRM. Los demás aplicativos leen por la API con uno de estos tokens."
        actions={
          <ActionButton variant="primary" onClick={() => setCreating(true)} disabled={creating}>
            <Plus aria-hidden className="size-4" />
            Crear token
          </ActionButton>
        }
      />

      {/* ── El secreto: se ve una vez ─────────────────────────────────────── */}
      {secret && (
        <section
          role="alert"
          className="rounded-ui-lg border border-pend/35 bg-pend-bg p-4 text-foreground shadow-1"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-pend" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-semibold">Copialo ahora: no se puede volver a ver</h2>
              <p className="mt-1 text-[13px] text-text-2">
                No lo guardamos —sólo guardamos su huella—, así que si se pierde hay que revocarlo y
                crear otro. Tratalo como una contraseña: no lo pegues en un chat de grupo.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-ui-md border border-border-strong bg-card px-3 py-2 font-mono text-[13px]">
                  {secret}
                </code>
                <ActionButton variant="secondary" onClick={() => void copySecret()}>
                  {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                  {copied ? 'Copiado' : 'Copiar'}
                </ActionButton>
                <ActionButton variant="ghost" onClick={() => setSecret(null)}>
                  Ya lo copié
                </ActionButton>
              </div>
              {copyFailed && (
                <p className="mt-2 text-[12px] font-medium text-neg">
                  No se pudo copiar automáticamente: seleccioná el texto y copialo a mano antes de cerrar.
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── Alta ──────────────────────────────────────────────────────────── */}
      {creating && (
        <Panel title="Nuevo token" hint="El secreto se muestra una sola vez al crearlo.">
          {companiesError && (
            <Notice kind="bad" title="No se pudo cargar la lista de organizaciones" className="mb-4">
              {companiesError}. Sin la lista no se puede elegir a quién abrirle la puerta.
            </Notice>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Organización" hint="El token sólo podrá leer datos de esta organización, aunque pida otra.">
              <Select value={form.company_id} onChange={(e) => setForm({ ...form, company_id: e.target.value })}>
                <option value="">Elegí una…</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Aplicativo" hint="Sirve para saber a quién cortarle el acceso si hace falta.">
              <Input
                value={form.app_name}
                onChange={(e) => setForm({ ...form, app_name: e.target.value })}
                placeholder="atlas, assistant, task-system…"
              />
            </Field>
          </div>

          <fieldset className="mt-4">
            <legend className="text-[12.5px] font-medium text-text-2">Permisos</legend>
            <p className="mb-2 text-[12px] text-text-3">Un token sin permisos no puede leer nada.</p>
            <div className="flex flex-wrap gap-2">
              {scopes.map((s) => {
                const on = form.scopes.includes(s);
                return (
                  <Chip
                    key={s}
                    active={on}
                    className="font-mono"
                    onClick={() =>
                      setForm({
                        ...form,
                        scopes: on ? form.scopes.filter((x) => x !== s) : [...form.scopes, s],
                      })
                    }
                  >
                    {s}
                  </Chip>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-4 flex gap-2">
            <ActionButton variant="primary" loading={busy} onClick={crear}>
              Crear
            </ActionButton>
            <ActionButton variant="ghost" onClick={() => setCreating(false)}>
              Cancelar
            </ActionButton>
          </div>
        </Panel>
      )}

      {/* ── Listado ───────────────────────────────────────────────────────── */}
      {loadError && (
        <Notice
          kind="bad"
          title="No se pudo cargar la lista de tokens"
          action={
            <ActionButton variant="secondary" onClick={() => void load()}>
              <RotateCw aria-hidden className="size-4" /> Reintentar
            </ActionButton>
          }
        >
          {loadError}. Esto no quiere decir que no haya tokens: no se pudo leer.
        </Notice>
      )}

      {loading ? (
        <Skeleton className="h-64" />
      ) : loadError ? null : (
        <Panel
          title="Tokens emitidos"
          hint={`${formatCount(activeCount)} ${plural(activeCount, 'activo', 'activos')} de ${formatCount(tokens.length)}`}
          flush
        >
          <FinTable<TokenRow>
            caption="Tokens de aplicativos"
            columns={columns}
            rows={tokens}
            rowKey={(t) => t.id}
            empty={
              <EmptyState
                icon={KeyRound}
                title="Todavía no hay tokens"
                description="Cuando un aplicativo necesite leer datos del bróker, creale uno acá en vez de darle acceso directo a la base."
              />
            }
            rowActions={(t) =>
              t.is_active ? (
                <ActionButton variant="danger" onClick={() => setToRevoke(t)}>
                  <Ban className="size-4" aria-hidden />
                  <span className="max-sm:sr-only">Revocar</span>
                </ActionButton>
              ) : null
            }
          />
        </Panel>
      )}

      {toRevoke && (
        <ConfirmDialog
          tone="danger"
          title={`Revocar el token de ${toRevoke.app_name}`}
          message={
            toRevoke.last_used_at
              ? `Este token se usó por última vez el ${formatDateTime(toRevoke.last_used_at)} y lleva ${formatCount(toRevoke.request_count)} llamadas. Si lo cortás, ese aplicativo deja de leer AHORA. No se puede reactivar: habría que crear otro.`
              : `Este token nunca se usó, así que cortarlo no debería romper nada. No se puede reactivar: habría que crear otro.`
          }
          confirmLabel="Cortar el acceso"
          onConfirm={revocar}
          onClose={() => {
            if (!busy) setToRevoke(null);
          }}
        />
      )}
    </div>
  );
}
