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
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, KeyRound, Plus, Ban, Copy, Check, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
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
  const [toRevoke, setToRevoke] = useState<TokenRow | null>(null);

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
      const c = await cRes.json().catch(() => null);
      setCompanies(Array.isArray(c?.companies) ? c.companies : Array.isArray(c) ? c : []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al cargar');
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

  return (
    <div className="space-y-6">
      {ToastHost}

      <Link
        href="/superadmin"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Volver
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <KeyRound className="h-6 w-6" aria-hidden />
            Tokens de aplicativos
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Smart Dashboard es el único que se conecta al MySQL de MetaTrader y al Mongo del CRM.
            Los demás aplicativos leen por la API con uno de estos tokens.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          Crear token
        </Button>
      </div>

      {/* ── El secreto: se ve una vez ─────────────────────────────────────── */}
      {secret && (
        <Card className="border-warning">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1">
              <CardTitle>Copialo ahora: no se puede volver a ver</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                No lo guardamos —sólo guardamos su huella—, así que si se pierde hay que revocarlo y
                crear otro. Tratalo como una contraseña: no lo pegues en un chat de grupo.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm">
                  {secret}
                </code>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(secret);
                    setCopied(true);
                  }}
                >
                  {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                  {copied ? 'Copiado' : 'Copiar'}
                </Button>
                <Button variant="ghost" onClick={() => setSecret(null)}>
                  Ya lo copié
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* ── Alta ──────────────────────────────────────────────────────────── */}
      {creating && (
        <Card>
          <CardTitle>Nuevo token</CardTitle>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium">Organización</span>
              <select
                value={form.company_id}
                onChange={(e) => setForm({ ...form, company_id: e.target.value })}
                className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
              >
                <option value="">Elegí una…</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-muted-foreground">
                El token sólo podrá leer datos de esta organización, aunque pida otra.
              </span>
            </label>

            <label className="block text-sm">
              <span className="font-medium">Aplicativo</span>
              <input
                value={form.app_name}
                onChange={(e) => setForm({ ...form, app_name: e.target.value })}
                placeholder="atlas, assistant, task-system…"
                className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Sirve para saber a quién cortarle el acceso si hace falta.
              </span>
            </label>
          </div>

          <fieldset className="mt-4">
            <legend className="text-sm font-medium">Permisos</legend>
            <p className="mb-2 text-xs text-muted-foreground">
              Un token sin permisos no puede leer nada.
            </p>
            <div className="flex flex-wrap gap-2">
              {scopes.map((s) => {
                const on = form.scopes.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setForm({
                        ...form,
                        scopes: on ? form.scopes.filter((x) => x !== s) : [...form.scopes, s],
                      })
                    }
                    className={cn(
                      'rounded-md border px-3 py-1.5 font-mono text-xs transition-colors',
                      on ? 'border-primary bg-primary text-white' : 'border-border hover:bg-muted',
                    )}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-4 flex gap-2">
            <Button variant="primary" loading={busy} onClick={crear}>
              Crear
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      {/* ── Listado ───────────────────────────────────────────────────────── */}
      {loading ? (
        <Skeleton className="h-64" />
      ) : tokens.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="Todavía no hay tokens"
          description="Cuando un aplicativo necesite leer datos del bróker, creale uno acá en vez de darle acceso directo a la base."
        />
      ) : (
        <div className="space-y-3">
          {tokens.map((t) => (
            <Card key={t.id} className={cn(!t.is_active && 'opacity-60')}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{t.app_name}</span>
                    <Badge variant={t.is_active ? 'success' : 'neutral'}>
                      {t.is_active ? 'Activo' : 'Revocado'}
                    </Badge>
                    <span className="text-sm text-muted-foreground">{t.companies?.name ?? '—'}</span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{t.token_prefix}…</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <span key={s} className="rounded border border-border px-1.5 py-0.5 font-mono text-xs">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>

                {t.is_active && (
                  <Button variant="destructive" size="sm" onClick={() => setToRevoke(t)}>
                    <Ban className="h-4 w-4" aria-hidden />
                    Revocar
                  </Button>
                )}
              </div>

              <dl className="mt-4 grid gap-3 border-t border-border pt-3 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Creado</dt>
                  <dd>{formatDateTime(t.created_at)}</dd>
                  {t.created_by_name && <dd className="text-muted-foreground">{t.created_by_name}</dd>}
                </div>
                <div>
                  <dt className="text-muted-foreground">Último uso</dt>
                  {/* Antes de cortar algo, saber si está vivo. */}
                  <dd className={cn(!t.last_used_at && 'text-muted-foreground')}>
                    {t.last_used_at ? formatDateTime(t.last_used_at) : 'Nunca se usó'}
                  </dd>
                  {t.last_used_ip && <dd className="text-muted-foreground">{t.last_used_ip}</dd>}
                </div>
                <div>
                  <dt className="text-muted-foreground">Llamadas</dt>
                  <dd className="tabular-nums">{t.request_count.toLocaleString('es')}</dd>
                </div>
                {!t.is_active && (
                  <div>
                    <dt className="text-muted-foreground">Revocado</dt>
                    <dd>{formatDateTime(t.revoked_at)}</dd>
                    {t.revoked_reason && <dd className="text-muted-foreground">{t.revoked_reason}</dd>}
                  </div>
                )}
              </dl>
            </Card>
          ))}
        </div>
      )}

      {toRevoke && (
        <ConfirmDialog
          tone="danger"
          title={`Revocar el token de ${toRevoke.app_name}`}
          message={
            toRevoke.last_used_at
              ? `Este token se usó por última vez el ${formatDateTime(toRevoke.last_used_at)} y lleva ${toRevoke.request_count.toLocaleString('es')} llamadas. Si lo cortás, ese aplicativo deja de leer AHORA. No se puede reactivar: habría que crear otro.`
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
