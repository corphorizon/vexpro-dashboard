'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Key, Check, Loader2, Eye, EyeOff, Wifi, WifiOff, AlertTriangle, Copy } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

// ─────────────────────────────────────────────────────────────────────────────
// ApiCredentialsPanel — external API credentials for a tenant.
//
// Moved here from /configuraciones so it can be embedded in two places:
//   · /superadmin/companies/[id] — companyId prop is required. The superadmin
//     targets that specific tenant.
//   · (Never embedded in the tenant UI after the refactor — superadmin-only.)
//
// Storage convention (enforced server-side in src/lib/api-integrations/credentials.ts):
//   · coinsbuy    → encrypted_secret = JSON({ client_id, client_secret })
//                   wallet_id lives in companies.default_wallet_id (not here)
//   · unipayment  → encrypted_secret = JSON({ client_id, client_secret })
//   · fairpay     → encrypted_secret = raw api_key
//   · sendgrid    → encrypted_secret = raw api_key, extras: from_email/from_name
//   · orion_crm   → encrypted_secret = raw api_key, extras: base_url
//   · paypros     → encrypted_secret = JSON({ merchant_id, api_key, sign_key })
//                   extras: base_url + webhook_token (el token lo genera el
//                   servidor una sola vez; la URL del webhook llega armada
//                   en el GET como `webhook_url`)
//   · mt5_sql     → encrypted_secret = JSON({ engine, host, port, database,
//                   user, password }); extras: { engine, host, port, database }
//                   (sin user/password — el host se muestra truncado)
//   · orion_mongo → encrypted_secret = la connection string mongodb:// ENTERA
//                   extras: { database, host_hint }
//
// When `companyId` is passed, requests append `?company_id=<id>` so the API
// route knows which tenant to operate on (see /api/admin/api-credentials).
// ─────────────────────────────────────────────────────────────────────────────

type Provider =
  | 'sendgrid'
  | 'coinsbuy'
  | 'unipayment'
  | 'fairpay'
  | 'fairpay_banking'
  | 'orion_crm'
  | 'paypros'
  | 'mt5_sql'
  | 'orion_mongo';

/** URL de producción de Pay-Pros (prefill del campo Base URL). */
const PAYPROS_DEFAULT_BASE_URL = 'https://master-api.pay-pros.com/';

interface ApiCredential {
  provider: Provider;
  last_four: string | null;
  extra_config: Record<string, unknown> | null;
  is_configured: boolean;
  updated_at: string;
  /** Solo paypros: URL completa a registrar en Pay-Pros (la arma el GET). */
  webhook_url?: string | null;
}

// What each provider's form looks like. Rather than a generic
// secret+extras pair we model the real shape per provider so users see the
// correct labels (Client ID vs API Key) and we can build the payload the
// resolver expects in credentials.ts.
type FormKind =
  | { kind: 'compound' }   // coinsbuy, unipayment → client_id + client_secret (secret = JSON of both)
  | { kind: 'apiKey' }     // fairpay → raw api_key
  | { kind: 'keyExtras' }  // sendgrid, orion_crm → api_key + extra_config fields
  | { kind: 'paypros' }    // paypros → merchant_id + api_key + sign_key (secret = JSON) + base_url
  | { kind: 'mt5sql' }     // mt5_sql → engine + host + port + database + user + password (secret = JSON)
  | { kind: 'mongo' };     // orion_mongo → connection string (secret) + database

interface ProviderMeta {
  label: string;
  description: string;
  form: FormKind;
  /** Extra-config fields shown below the secret field (for keyExtras kind). */
  extraFields?: Array<{ key: string; label: string; placeholder?: string }>;
  /** Coinsbuy: also edits companies.default_wallet_id. */
  editsCompanyWallet?: boolean;
  /** Health-check button enabled. */
  supportsPing?: boolean;
  /**
   * FairPay / UniPayment: muestran el campo "Comisión del proveedor (%)"
   * que se persiste en extra_config.fee_pct. Estos proveedores no exponen
   * su comisión por API, así que el % se configura acá por tenant.
   */
  supportsFeePct?: boolean;
  /**
   * Bases de datos del broker (mt5_sql / orion_mongo): ruta del sondeo del
   * superadmin que valida el acceso Y verifica que el usuario sea de solo
   * lectura. Distinto de `supportsPing` (health-check de las pasarelas):
   * devuelve un diagnóstico completo, no un booleano.
   */
  dbProbePath?: string;
}

const PROVIDER_META: Record<Provider, ProviderMeta> = {
  sendgrid: {
    label: 'SendGrid',
    description:
      'Envío de reportes automáticos. El dominio del "from_email" debe estar verificado en la cuenta SendGrid.',
    form: { kind: 'keyExtras' },
    extraFields: [
      { key: 'from_email', label: 'From email', placeholder: 'dashboard@tuempresa.com' },
      { key: 'from_name', label: 'From name', placeholder: 'Tu Empresa' },
    ],
  },
  coinsbuy: {
    label: 'Coinsbuy',
    description: 'Procesador de pagos crypto.',
    form: { kind: 'compound' },
    editsCompanyWallet: true,
  },
  unipayment: {
    label: 'Unipayment',
    description: 'Procesador de pagos.',
    form: { kind: 'compound' },
    supportsFeePct: true,
  },
  fairpay: {
    label: 'Fairpay',
    description: 'Procesador de pagos.',
    form: { kind: 'apiKey' },
    supportsFeePct: true,
  },
  paypros: {
    label: 'Pay-Pros',
    description:
      'Pasarela de pagos. Necesita Merchant ID, API Key y Sign Key, y que la URL del webhook quede registrada del lado de Pay-Pros.',
    form: { kind: 'paypros' },
  },
  fairpay_banking: {
    label: 'FairPay Banking',
    description:
      'Portal banking.fairpay.online — sistema APARTE del portal de cobros: es donde vive el balance de la cuenta. API Key propia. Base URL solo si FairPay indica una distinta.',
    form: { kind: 'keyExtras' },
    extraFields: [
      { key: 'base_url', label: 'Base URL', placeholder: 'https://banking.fairpay.online' },
    ],
  },
  orion_crm: {
    label: 'Orion CRM',
    description: 'CRM del broker — usuarios registrados, Broker P&L, ventas Prop Firm.',
    form: { kind: 'keyExtras' },
    extraFields: [
      { key: 'base_url', label: 'Base URL', placeholder: 'https://api.orion-crm.example' },
    ],
    supportsPing: true,
  },
  mt5_sql: {
    label: 'MetaTrader 5 (SQL)',
    description:
      'Réplica SQL Export del Backup Server de MT5. Usuario de SOLO LECTURA.',
    form: { kind: 'mt5sql' },
    dbProbePath: '/api/superadmin/mt5-sql-probe',
  },
  orion_mongo: {
    label: 'Orion CRM (MongoDB)',
    description:
      'Base MongoDB del CRM. Usuario de SOLO LECTURA. La connection string completa queda cifrada.',
    form: { kind: 'mongo' },
    dbProbePath: '/api/superadmin/orion-mongo-probe',
  },
};

// Rendering order — el grupo "datos del negocio" (Orion CRM y las dos bases
// del broker) va al final, separado de las pasarelas de pago de arriba.
const PROVIDER_ORDER: Provider[] = [
  'sendgrid',
  'coinsbuy',
  'unipayment',
  'fairpay',
  'fairpay_banking',
  'paypros',
  'orion_crm',
  'mt5_sql',
  'orion_mongo',
];

interface Props {
  /** When set, requests operate on this tenant (superadmin flow). */
  companyId?: string;
}

// Ping result shape returned by providers that support the health check.
interface PingResult {
  connected: boolean;
  message: string;
  isMock: boolean;
  testedAt: string;
}

// Respuesta de los sondeos de base de datos (mt5-sql-probe / orion-mongo-probe).
// Los dos comparten `connected`, `readOnly` y `elapsedMs`; el resto es propio
// de cada motor y se pinta sólo si viene.
interface DbProbeResult {
  connected: boolean;
  error?: string | null;
  hint?: string | null;
  code?: string | null;
  elapsedMs?: number;
  readOnly?: { verdict: 'ok' | 'ESCRITURA DETECTADA'; detail: string };
  // MT5 SQL
  engine?: string;
  serverVersion?: string;
  database?: string;
  tables?: Array<{ name: string; isMt5: boolean }>;
  tableCountTotal?: number;
  dealsPartitioned?: boolean;
  samples?: {
    mt5_users: { count: number | null; lastRegistration: string | null } | null;
    deals: { table: string; count: number | null; lastTime: string | null } | null;
  };
  // Orion Mongo
  collections?: Array<{ name: string; isCrmLike: boolean; count: number | null }>;
  collectionCountTotal?: number;
  crmMatches?: string[];
  user?: string | null;
  testedAt: string;
}

const supabase = createClient();

export function ApiCredentialsPanel({ companyId }: Props) {
  const [creds, setCreds] = useState<ApiCredential[]>([]);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Provider | null>(null);
  // Per-provider ping state. Only populated for providers in which
  // `supportsPing` is true and the user has clicked "Probar conexión".
  const [pingResults, setPingResults] = useState<Partial<Record<Provider, PingResult>>>({});
  const [pingBusy, setPingBusy] = useState<Provider | null>(null);

  // Sondeos de base de datos (MT5 SQL / Orion Mongo): resultado completo por
  // proveedor + cuál se está probando ahora.
  const [dbProbes, setDbProbes] = useState<Partial<Record<Provider, DbProbeResult>>>({});
  const [dbProbeBusy, setDbProbeBusy] = useState<Provider | null>(null);

  const qs = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';

  /**
   * Lanza el sondeo de la base. Siempre pasa company_id: estas rutas son de
   * superadmin y operan sobre un tenant explícito.
   */
  const handleDbProbe = async (provider: Provider, path: string) => {
    if (!companyId) return;
    setDbProbeBusy(provider);
    try {
      const res = await apiFetch(`${path}?company_id=${encodeURIComponent(companyId)}`);
      const data = (await res.json()) as Omit<DbProbeResult, 'testedAt'>;
      setDbProbes((prev) => ({
        ...prev,
        [provider]: { ...data, testedAt: new Date().toISOString() },
      }));
    } catch (err) {
      setDbProbes((prev) => ({
        ...prev,
        [provider]: {
          connected: false,
          error: err instanceof Error ? err.message : 'Error de red',
          testedAt: new Date().toISOString(),
        },
      }));
    } finally {
      setDbProbeBusy(null);
    }
  };

  const handlePing = async (provider: Provider) => {
    setPingBusy(provider);
    try {
      const res = await apiFetch(`/api/integrations/${provider.replace('_', '-')}/ping${qs}`);
      const data = (await res.json()) as Omit<PingResult, 'testedAt'>;
      setPingResults((prev) => ({
        ...prev,
        [provider]: { ...data, testedAt: new Date().toISOString() },
      }));
    } catch (err) {
      setPingResults((prev) => ({
        ...prev,
        [provider]: {
          connected: false,
          message: err instanceof Error ? err.message : 'Error de red',
          isMock: false,
          testedAt: new Date().toISOString(),
        },
      }));
    } finally {
      setPingBusy(null);
    }
  };

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Credentials list.
      const res = await apiFetch(`/api/admin/api-credentials${qs}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setCreds(data.credentials);

      // Company's default_wallet_id — needed for the Coinsbuy card. We
      // read directly via the Supabase client because the PATCH endpoint
      // is writable-only and RLS allows superadmin to SELECT companies.
      if (companyId) {
        const { data: companyRow, error: coErr } = await supabase
          .from('companies')
          .select('default_wallet_id')
          .eq('id', companyId)
          .maybeSingle();
        if (coErr) {
          // Non-fatal: the Coinsbuy card will just lack the wallet badge.
          console.warn('[api-credentials-panel] could not load wallet_id:', coErr.message);
          setWalletId(null);
        } else {
          setWalletId((companyRow?.default_wallet_id as string | null) ?? null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando credenciales');
    } finally {
      setLoading(false);
    }
  }, [qs, companyId]);

  useEffect(() => { reload(); }, [reload]);

  const getCred = (provider: Provider) => creds.find((c) => c.provider === provider);

  const handleDelete = async (provider: Provider) => {
    if (!confirm(`¿Eliminar las credenciales de ${PROVIDER_META[provider].label}?`)) return;
    try {
      const res = await apiFetch(`/api/admin/api-credentials${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', provider, company_id: companyId }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error');
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-3 rounded-lg bg-negative/10/30 border border-negative/30 text-red-700 text-sm">
          {error}
        </div>
      )}

      {PROVIDER_ORDER.map((provider) => {
        const meta = PROVIDER_META[provider];
        const cred = getCred(provider);
        const isEditing = editing === provider;
        const ping = pingResults[provider];
        const dbProbe = dbProbes[provider];

        return (
          <Card key={provider}>
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-950/50">
                  <Key className="w-5 h-5 text-indigo-500" />
                </div>
                <div>
                  <h3 className="font-semibold">{meta.label}</h3>
                  <p className="text-xs text-muted-foreground">{meta.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Live connection status — only rendered after the user has
                    pressed "Probar conexión" at least once (empty state =
                    no badge so we don't imply a test happened). */}
                {ping && (
                  <Badge variant={ping.connected ? 'success' : ping.isMock ? 'warning' : 'danger'}>
                    {ping.connected ? (
                      <><Wifi className="w-3 h-3" /> Conectada</>
                    ) : ping.isMock ? (
                      <><AlertTriangle className="w-3 h-3" /> Mock</>
                    ) : (
                      <><WifiOff className="w-3 h-3" /> Sin conectar</>
                    )}
                  </Badge>
                )}
                {/* Sondeo de base: verde si conecta con usuario de solo
                    lectura, ámbar si conecta pero puede escribir, rojo si no
                    conecta. */}
                {dbProbe && (
                  <Badge
                    variant={
                      !dbProbe.connected
                        ? 'danger'
                        : dbProbe.readOnly?.verdict === 'ok'
                          ? 'success'
                          : 'warning'
                    }
                  >
                    {!dbProbe.connected ? (
                      <><WifiOff className="w-3 h-3" /> Sin conectar</>
                    ) : dbProbe.readOnly?.verdict === 'ok' ? (
                      <><Wifi className="w-3 h-3" /> Solo lectura</>
                    ) : (
                      <><AlertTriangle className="w-3 h-3" /> Permite escritura</>
                    )}
                  </Badge>
                )}
                {cred?.is_configured && !isEditing && (
                  <Badge variant="success">
                    <Check className="w-3 h-3" /> Configurado
                  </Badge>
                )}
              </div>
            </div>

            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            ) : isEditing ? (
              <ApiCredentialForm
                provider={provider}
                meta={meta}
                existingExtras={cred?.extra_config || {}}
                currentWalletId={walletId}
                companyId={companyId}
                onSaved={() => { setEditing(null); reload(); }}
                onCancel={() => setEditing(null)}
              />
            ) : cred?.is_configured ? (
              <div className="space-y-3">
                <ConfiguredView
                  provider={provider}
                  meta={meta}
                  cred={cred}
                  walletId={walletId}
                />
                <p className="text-xs text-muted-foreground">
                  Última actualización: {new Date(cred.updated_at).toLocaleString('es-ES')}
                </p>
                {/* Ping result message (only for providers that support it) */}
                {meta.supportsPing && ping && (
                  <p
                    className={`text-xs ${
                      ping.connected
                        ? 'text-positive'
                        : ping.isMock
                          ? 'text-warning'
                          : 'text-negative'
                    }`}
                  >
                    {ping.message} · {new Date(ping.testedAt).toLocaleString('es-ES')}
                  </p>
                )}
                {/* Resultado del sondeo de base (MT5 SQL / Orion Mongo). */}
                {meta.dbProbePath && dbProbe && <DbProbeReport result={dbProbe} />}
                {meta.dbProbePath && <ReadOnlyNote />}
                <div className="flex gap-2 pt-2 flex-wrap">
                  <button
                    onClick={() => setEditing(provider)}
                    className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted"
                  >
                    Cambiar
                  </button>
                  {meta.supportsPing && (
                    <button
                      onClick={() => handlePing(provider)}
                      disabled={pingBusy === provider}
                      className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      {pingBusy === provider ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Probando…</>
                      ) : (
                        <><Wifi className="w-3.5 h-3.5" /> Probar conexión</>
                      )}
                    </button>
                  )}
                  {meta.dbProbePath && (
                    <button
                      onClick={() => handleDbProbe(provider, meta.dbProbePath!)}
                      disabled={dbProbeBusy === provider || !companyId}
                      title={!companyId ? 'Requiere el contexto de una empresa' : undefined}
                      className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      {dbProbeBusy === provider ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Probando…</>
                      ) : (
                        <><Wifi className="w-3.5 h-3.5" /> Probar conexión</>
                      )}
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(provider)}
                    className="px-3 py-1.5 rounded-lg border border-negative/30 text-red-600 text-sm hover:bg-red-50 dark:hover:bg-red-950/30"
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setEditing(provider)}
                  className="px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
                >
                  Configurar
                </button>
                {/* Sin credenciales no hay nada que sondear: la nota explica
                    qué se va a hacer con lo que se cargue. */}
                {meta.dbProbePath && (
                  <div className="w-full">
                    <ReadOnlyNote />
                  </div>
                )}
                {/* Even without credentials, Orion CRM can be probed — it
                    reports "mock mode" which is useful info for the admin. */}
                {meta.supportsPing && (
                  <button
                    onClick={() => handlePing(provider)}
                    disabled={pingBusy === provider}
                    className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    {pingBusy === provider ? (
                      <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Probando…</>
                    ) : (
                      <><Wifi className="w-3.5 h-3.5" /> Probar conexión</>
                    )}
                  </button>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ─── Bases de datos del broker ────────────────────────────────────────────────

/** Nota fija de las dos tarjetas de base de datos. */
function ReadOnlyNote() {
  return (
    <p className="text-xs text-muted-foreground">
      Los datos nunca salen del servidor: la conexión se abre desde el backend y el
      dashboard sólo LEE. El usuario que cargues debe ser de solo lectura; el botón
      &quot;Probar conexión&quot; lo verifica contra los permisos reales del motor.
    </p>
  );
}

/** Host truncado para mostrar: db.hosting.com → db.h…g.com */
function truncateHost(host: string): string {
  if (host.length <= 12) return host;
  return `${host.slice(0, 4)}…${host.slice(-6)}`;
}

/**
 * Resultado del sondeo. Verde = conecta y el usuario es de solo lectura.
 * Ámbar = conecta pero puede escribir. Rojo = no conecta (con el error de red
 * legible y, si huele a firewall, las IPs a autorizar).
 */
function DbProbeReport({ result }: { result: DbProbeResult }) {
  const tone = !result.connected
    ? 'border-negative/30 bg-negative/5 text-negative'
    : result.readOnly?.verdict === 'ok'
      ? 'border-positive/30 bg-positive/5 text-positive'
      : 'border-warning/30 bg-warning/5 text-warning';

  return (
    <div className={`rounded-lg border p-3 text-xs space-y-1.5 ${tone}`}>
      {!result.connected ? (
        <>
          <p className="font-medium">No se pudo conectar.</p>
          <p className="text-foreground/80 break-words">{result.error}</p>
          {result.hint && <p className="text-foreground/80">Pista: {result.hint}</p>}
        </>
      ) : (
        <>
          <p className="font-medium">
            Conexión OK
            {result.engine ? ` · ${result.engine}` : ''}
            {result.serverVersion ? ` ${result.serverVersion}` : ''}
            {result.database ? ` · base ${result.database}` : ''}
          </p>

          {/* MT5 SQL */}
          {result.tables && (
            <div className="text-foreground/80 space-y-1">
              <p>
                {result.tableCountTotal} tablas ({result.tables.filter((t) => t.isMt5).length} mt5_*
                entre las {result.tables.length} listadas)
                {result.dealsPartitioned ? ' · deals particionados por año' : ''}
              </p>
              <p className="font-mono break-words">
                {result.tables.map((t) => (t.isMt5 ? `▸${t.name}` : t.name)).join('  ')}
              </p>
              {result.samples?.mt5_users && (
                <p>
                  mt5_users: {result.samples.mt5_users.count ?? '?'} filas · último registro{' '}
                  {result.samples.mt5_users.lastRegistration ?? '—'}
                </p>
              )}
              {result.samples?.deals && (
                <p>
                  {result.samples.deals.table}: {result.samples.deals.count ?? '?'} filas · última
                  operación {result.samples.deals.lastTime ?? '—'}
                </p>
              )}
            </div>
          )}

          {/* Orion Mongo */}
          {result.collections && (
            <div className="text-foreground/80 space-y-1">
              <p>
                {result.collectionCountTotal} colecciones
                {result.user ? ` · usuario ${result.user}` : ''}
                {result.crmMatches && result.crmMatches.length > 0
                  ? ` · típicas de CRM: ${result.crmMatches.join(', ')}`
                  : ''}
              </p>
              <p className="font-mono break-words">
                {result.collections
                  .map((c) => `${c.isCrmLike ? '▸' : ''}${c.name}${c.count != null ? `(${c.count})` : ''}`)
                  .join('  ')}
              </p>
            </div>
          )}

          {result.readOnly && (
            <p className="text-foreground/80">
              <span className="font-medium">Solo lectura: {result.readOnly.verdict}.</span>{' '}
              {result.readOnly.detail}
              {result.readOnly.verdict !== 'ok' && ' Pedí un usuario de solo lectura.'}
            </p>
          )}
        </>
      )}
      <p className="text-foreground/60">
        {result.elapsedMs != null ? `${result.elapsedMs} ms · ` : ''}
        {new Date(result.testedAt).toLocaleString('es-ES')}
      </p>
    </div>
  );
}

// ─── Configured view ──────────────────────────────────────────────────────────
//
// Per-provider display of what's stored. We don't show the secret itself; we
// show the last 4 chars of what was typed, plus any relevant extra-config or
// per-tenant data (like Coinsbuy's wallet_id).

function ConfiguredView({
  provider,
  meta,
  cred,
  walletId,
}: {
  provider: Provider;
  meta: ProviderMeta;
  cred: ApiCredential;
  walletId: string | null;
}) {
  const secretLabel = (() => {
    switch (meta.form.kind) {
      case 'compound': return 'Client Secret';
      case 'paypros': return 'API Key';
      case 'mt5sql': return 'Contraseña';
      case 'mongo': return 'Connection string (host)';
      case 'apiKey':
      case 'keyExtras':
        return provider === 'sendgrid' || provider === 'orion_crm' || provider === 'fairpay'
          ? 'API key'
          : 'Key';
    }
  })();

  // El webhook_token ya viaja dentro de webhook_url; listarlo otra vez en el
  // volcado genérico de extra_config sólo agrega ruido.
  const extraEntries = Object.entries(cred.extra_config ?? {}).filter(
    ([k]) => !(provider === 'paypros' && k === 'webhook_token'),
  );

  return (
    <>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{secretLabel}:</span>
        <code className="px-2 py-0.5 rounded bg-muted font-mono">••••••••{cred.last_four}</code>
      </div>

      {/* Pay-Pros: la URL que hay que darle a Pay-Pros para las notificaciones
          entrantes. El token la hace única por empresa. */}
      {provider === 'paypros' && cred.webhook_url && (
        <WebhookUrlBlock url={cred.webhook_url} />
      )}

      {/* Coinsbuy: show wallet_id read from companies.default_wallet_id. */}
      {meta.editsCompanyWallet && walletId && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Wallet ID:</span>
          <code className="px-2 py-0.5 rounded bg-muted font-mono">{walletId}</code>
        </div>
      )}

      {/* Generic extra_config (sendgrid from_email/from_name, orion_crm base_url). */}
      {extraEntries.length > 0 && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {extraEntries.map(([k, v]) => (
            <div key={k}>
              {/* host / host_hint son la puerta de la base del broker: se
                  muestran truncados aunque estén guardados enteros. */}
              <span className="font-medium">{k}:</span>{' '}
              {k === 'host' || k === 'host_hint' ? truncateHost(String(v ?? '')) : String(v ?? '')}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Webhook URL (Pay-Pros) ───────────────────────────────────────────────────
//
// Pay-Pros no manda el merchant en el cuerpo de la notificación, así que la
// empresa se identifica por el token que va en la URL. Esta es LA url que
// Kevin tiene que registrar en el panel de Pay-Pros.

function WebhookUrlBlock({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard bloqueado (contexto no seguro): la URL igual está visible
      // y se puede seleccionar a mano.
    }
  };

  return (
    <div className="space-y-1">
      <span className="text-sm text-muted-foreground">Webhook URL:</span>
      <div className="flex items-start gap-2">
        <code className="flex-1 px-2 py-1 rounded bg-muted font-mono text-xs break-all">
          {url}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          className="px-2 py-1 rounded-lg border border-border text-xs hover:bg-muted inline-flex items-center gap-1.5 shrink-0"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copiada' : 'Copiar'}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Esta es la URL que hay que registrar en Pay-Pros para recibir las notificaciones
        de pago. Es única por empresa: no la compartas entre tenants ni la cambies sin
        actualizarla también del lado de Pay-Pros.
      </p>
    </div>
  );
}

// ─── Form ─────────────────────────────────────────────────────────────────────
//
// Picks the layout based on meta.form.kind. All paths ultimately POST to
// /api/admin/api-credentials with action:'upsert'. Coinsbuy additionally
// PATCHes /api/superadmin/companies/:id to update default_wallet_id.

function ApiCredentialForm({
  provider,
  meta,
  existingExtras,
  currentWalletId,
  companyId,
  onSaved,
  onCancel,
}: {
  provider: Provider;
  meta: ProviderMeta;
  existingExtras: Record<string, unknown>;
  currentWalletId: string | null;
  companyId?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  // Local form state — keep separate fields so each provider has its own
  // shape. Unused fields stay empty strings; the handleSubmit only reads
  // the ones that apply.
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [apiKey, setApiKey] = useState('');
  // Pay-Pros: tres secretos + base_url (extra_config, prefilled con prod).
  const [merchantId, setMerchantId] = useState('');
  const [signKey, setSignKey] = useState('');
  const [payprosBaseUrl, setPayprosBaseUrl] = useState<string>(() =>
    typeof existingExtras.base_url === 'string' && existingExtras.base_url.trim() !== ''
      ? existingExtras.base_url
      : PAYPROS_DEFAULT_BASE_URL,
  );
  // MT5 SQL: engine/host/port/database vienen de extra_config (no son
  // secretos) y se prellenan; usuario y contraseña NUNCA se prellenan.
  const [mt5Engine, setMt5Engine] = useState<'mysql' | 'postgres'>(() =>
    existingExtras.engine === 'postgres' ? 'postgres' : 'mysql',
  );
  const [mt5Host, setMt5Host] = useState(() => String(existingExtras.host ?? ''));
  const [mt5Port, setMt5Port] = useState(() =>
    existingExtras.port != null
      ? String(existingExtras.port)
      : existingExtras.engine === 'postgres'
        ? '5432'
        : '3306',
  );
  const [mt5Database, setMt5Database] = useState(() => String(existingExtras.database ?? ''));
  const [mt5User, setMt5User] = useState('');
  const [mt5Password, setMt5Password] = useState('');
  // Orion Mongo: la URI entera es el secreto; la base sí es visible.
  const [mongoUri, setMongoUri] = useState('');
  const [mongoDatabase, setMongoDatabase] = useState(() => String(existingExtras.database ?? ''));
  const [walletInput, setWalletInput] = useState(currentWalletId ?? '');
  // Comisión del proveedor (%) — solo fairpay/unipayment (supportsFeePct).
  // Se guarda en extra_config.fee_pct; vacío = sin comisión configurada.
  const [feePct, setFeePct] = useState<string>(() =>
    existingExtras.fee_pct != null ? String(existingExtras.fee_pct) : '',
  );
  const [showSecret, setShowSecret] = useState(false);
  const [extras, setExtras] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of meta.extraFields ?? []) init[f.key] = String(existingExtras[f.key] ?? '');
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Per-kind validation + secret payload construction.
    let secret: string;
    let extra_config: Record<string, unknown> | null = null;

    if (meta.form.kind === 'compound') {
      if (!clientId.trim() || clientSecret.length < 8) {
        setError('Ingresá Client ID y un Client Secret de al menos 8 caracteres.');
        return;
      }
      secret = JSON.stringify({
        client_id: clientId.trim(),
        client_secret: clientSecret,
      });
    } else if (meta.form.kind === 'paypros') {
      const base = payprosBaseUrl.trim();
      if (!merchantId.trim() || !apiKey.trim() || !signKey.trim()) {
        setError('Ingresá Merchant ID, API Key y Sign Key.');
        return;
      }
      if (!base.startsWith('https://') || !base.endsWith('/')) {
        setError('La Base URL debe empezar con https:// y terminar en /.');
        return;
      }
      // Los tres secretos viajan como un único JSON cifrado (mismo patrón
      // que coinsbuy). webhook_token lo genera/conserva el servidor.
      secret = JSON.stringify({
        merchant_id: merchantId.trim(),
        api_key: apiKey.trim(),
        sign_key: signKey.trim(),
      });
      extra_config = { ...existingExtras, base_url: base };
    } else if (meta.form.kind === 'mt5sql') {
      // Mismas reglas que valida el servidor (mt5-sql/validate.ts). Acá sólo
      // para dar el error sin viaje de red; el servidor vuelve a validar.
      const host = mt5Host.trim();
      const port = Number(mt5Port.trim());
      if (!host) { setError('Ingresá el host de la base.'); return; }
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
        setError('El host va sin esquema (sin http:// ni mysql://). Ej: db.hosting.com');
        return;
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        setError('El puerto debe ser un entero entre 1 y 65535.');
        return;
      }
      if (!mt5Database.trim() || !mt5User.trim() || !mt5Password) {
        setError('Ingresá base de datos, usuario y contraseña.');
        return;
      }
      secret = JSON.stringify({
        engine: mt5Engine,
        host,
        port,
        database: mt5Database.trim(),
        user: mt5User.trim(),
        password: mt5Password,
      });
      // engine/host/port/database los reescribe el servidor en extra_config
      // a partir del secreto: una sola fuente de verdad.
      extra_config = null;
    } else if (meta.form.kind === 'mongo') {
      const uri = mongoUri.trim();
      if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
        setError('La connection string debe empezar con mongodb:// o mongodb+srv://');
        return;
      }
      secret = uri;
      // host_hint lo calcula el servidor a partir de la URI.
      extra_config = mongoDatabase.trim() ? { database: mongoDatabase.trim() } : {};
    } else if (meta.form.kind === 'apiKey') {
      if (apiKey.length < 8) {
        setError('La API key debe tener al menos 8 caracteres.');
        return;
      }
      secret = apiKey;
    } else {
      // keyExtras
      if (apiKey.length < 8) {
        setError('La API key debe tener al menos 8 caracteres.');
        return;
      }
      secret = apiKey;
      extra_config = extras;
    }

    // Comisión del proveedor (%) — merge sobre extra_config existente para
    // no pisar otras keys (base_url, etc.). Vacío = quitar fee_pct.
    if (meta.supportsFeePct) {
      const merged: Record<string, unknown> = { ...existingExtras, ...(extra_config ?? {}) };
      const trimmedFee = feePct.trim();
      if (trimmedFee === '') {
        delete merged.fee_pct;
      } else {
        const n = Number(trimmedFee);
        if (!Number.isFinite(n) || n < 0 || n > 30) {
          setError('La comisión del proveedor debe ser un número entre 0 y 30 (%).');
          return;
        }
        merged.fee_pct = n;
      }
      extra_config = Object.keys(merged).length > 0 ? merged : null;
    }

    setSaving(true);
    try {
      const qs = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';

      // Step 1 — upsert the credential.
      const res = await apiFetch(`/api/admin/api-credentials${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          provider,
          secret,
          extra_config,
          company_id: companyId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      // Step 2 — Coinsbuy only: push wallet_id to companies.default_wallet_id
      // (separate endpoint because the wallet_id is a tenant-level setting,
      // not a credential field). We run this after the credential save so a
      // failure here doesn't leave the credential in a half-written state.
      if (meta.editsCompanyWallet && companyId) {
        const trimmed = walletInput.trim();
        // Only PATCH if the value actually changed (avoid a useless audit
        // entry on every save).
        if (trimmed !== (currentWalletId ?? '')) {
          const r2 = await apiFetch(`/api/superadmin/companies/${companyId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              default_wallet_id: trimmed === '' ? null : trimmed,
            }),
          });
          const d2 = await r2.json();
          if (!r2.ok || !d2.success) throw new Error(d2.error || `HTTP ${r2.status}`);
        }
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 mt-2 p-4 rounded-lg bg-muted/30 border border-border">
      {/* Compound: client_id + client_secret */}
      {meta.form.kind === 'compound' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1.5">Client ID</label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Pega aquí el Client ID."
              required
              autoComplete="off"
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Client Secret</label>
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Pega aquí el Client Secret. Se guardará encriptado."
                required
                autoComplete="new-password"
                className="w-full pr-11 px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                aria-label={showSecret ? 'Ocultar' : 'Mostrar'}
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Por seguridad el secret no se muestra después de guardar. Si lo cambiás, pegalo completo.
            </p>
          </div>
          {meta.editsCompanyWallet && (
            <div>
              <label className="block text-sm font-medium mb-1.5">Wallet ID</label>
              <input
                type="text"
                value={walletInput}
                onChange={(e) => setWalletInput(e.target.value)}
                placeholder="Ej: 1079"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono"
              />
              <p className="text-xs text-muted-foreground mt-1">
                ID de la wallet predeterminada. Se guarda a nivel empresa y es la que se
                pre-selecciona en /movimientos.
              </p>
            </div>
          )}
        </>
      )}

      {/* Pay-Pros: merchant_id + api_key + sign_key (un solo secreto JSON) + base_url */}
      {meta.form.kind === 'paypros' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1.5">Merchant ID</label>
            <input
              type="text"
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
              placeholder="Pega aquí el Merchant ID de Pay-Pros."
              required
              autoComplete="off"
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">API Key</label>
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Pega aquí la API Key. Se guardará encriptada."
                required
                autoComplete="new-password"
                className="w-full pr-11 px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                aria-label={showSecret ? 'Ocultar' : 'Mostrar'}
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Sign Key</label>
            <input
              type={showSecret ? 'text' : 'password'}
              value={signKey}
              onChange={(e) => setSignKey(e.target.value)}
              placeholder="Pega aquí la Sign Key. Se guardará encriptada."
              required
              autoComplete="new-password"
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm font-mono"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Por seguridad ni la API Key ni la Sign Key se muestran después de guardar.
              Si cambiás una, pegá las tres completas.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Base URL</label>
            <input
              type="text"
              value={payprosBaseUrl}
              onChange={(e) => setPayprosBaseUrl(e.target.value)}
              placeholder={PAYPROS_DEFAULT_BASE_URL}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm font-mono"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Producción por defecto. Cambiala solo para apuntar al entorno de pruebas de
              Pay-Pros. Debe empezar con https:// y terminar en /.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Al guardar se genera la Webhook URL de esta empresa (aparece en la tarjeta y hay
            que registrarla en Pay-Pros). No cambia en guardados posteriores.
          </p>
        </>
      )}

      {/* MT5 SQL: engine + host + puerto + base + usuario + contraseña.
          Los seis viajan como un único JSON cifrado. */}
      {meta.form.kind === 'mt5sql' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1.5">Motor</label>
            <select
              value={mt5Engine}
              onChange={(e) => {
                const next = e.target.value as 'mysql' | 'postgres';
                setMt5Engine(next);
                // Puerto por defecto del motor, salvo que ya lo hayan tocado.
                if (mt5Port === '' || mt5Port === '3306' || mt5Port === '5432') {
                  setMt5Port(next === 'postgres' ? '5432' : '3306');
                }
              }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm"
            >
              <option value="mysql">MySQL / MariaDB</option>
              <option value="postgres">PostgreSQL</option>
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              El SQL Export de MT5 también admite MSSQL y Oracle, pero todavía no los
              leemos: si el hosting sólo ofrece uno de esos, avisanos.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1.5">Host</label>
              <input
                type="text"
                value={mt5Host}
                onChange={(e) => setMt5Host(e.target.value)}
                placeholder="db.hosting-del-broker.com"
                required
                autoComplete="off"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Puerto</label>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={mt5Port}
                onChange={(e) => setMt5Port(e.target.value)}
                required
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm font-mono"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Base de datos</label>
            <input
              type="text"
              value={mt5Database}
              onChange={(e) => setMt5Database(e.target.value)}
              placeholder="mt5"
              required
              autoComplete="off"
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Usuario</label>
            <input
              type="text"
              value={mt5User}
              onChange={(e) => setMt5User(e.target.value)}
              placeholder="usuario de SOLO LECTURA"
              required
              autoComplete="off"
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Contraseña</label>
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={mt5Password}
                onChange={(e) => setMt5Password(e.target.value)}
                placeholder="Se guardará encriptada."
                required
                autoComplete="new-password"
                className="w-full pr-11 px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                aria-label={showSecret ? 'Ocultar' : 'Mostrar'}
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Host, puerto y base se muestran después de guardar; usuario y contraseña no.
              Si cambiás algo, completá los seis campos.
            </p>
          </div>
        </>
      )}

      {/* Orion Mongo: la connection string entera es el secreto. */}
      {meta.form.kind === 'mongo' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1.5">Connection string</label>
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={mongoUri}
                onChange={(e) => setMongoUri(e.target.value)}
                placeholder="mongodb+srv://usuario:clave@cluster.mongodb.net/orion"
                required
                autoComplete="new-password"
                className="w-full pr-11 px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                aria-label={showSecret ? 'Ocultar' : 'Mostrar'}
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Lleva el usuario y la contraseña adentro: se cifra entera y no vuelve a
              mostrarse. Del lado del panel sólo queda visible el host.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Base de datos (opcional)</label>
            <input
              type="text"
              value={mongoDatabase}
              onChange={(e) => setMongoDatabase(e.target.value)}
              placeholder="orion"
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm font-mono"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Si la connection string ya trae la base en el path, dejalo vacío.
            </p>
          </div>
        </>
      )}

      {/* apiKey only (fairpay) */}
      {meta.form.kind === 'apiKey' && (
        <div>
          <label className="block text-sm font-medium mb-1.5">API Key</label>
          <div className="relative">
            <input
              type={showSecret ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Pega aquí la API Key. Se guardará encriptada."
              required
              autoComplete="new-password"
              className="w-full pr-11 px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono"
            />
            <button
              type="button"
              onClick={() => setShowSecret((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
              aria-label={showSecret ? 'Ocultar' : 'Mostrar'}
            >
              {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Por seguridad la llave no se muestra después de guardar. Si la cambiás, pegala completa.
          </p>
        </div>
      )}

      {/* keyExtras (sendgrid, orion_crm) — original UX */}
      {meta.form.kind === 'keyExtras' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1.5">API Key / Secret</label>
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Pega aquí la llave. Se guardará encriptada."
                required
                autoComplete="new-password"
                className="w-full pr-11 px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                aria-label={showSecret ? 'Ocultar' : 'Mostrar'}
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Por seguridad la llave no se muestra después de guardar. Si la cambiás, pegala completa.
            </p>
          </div>

          {meta.extraFields?.map((f) => (
            <div key={f.key}>
              <label className="block text-sm font-medium mb-1.5">{f.label}</label>
              <input
                type="text"
                value={extras[f.key] ?? ''}
                onChange={(e) => setExtras((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              />
            </div>
          ))}
        </>
      )}

      {/* Comisión del proveedor (%) — solo fairpay/unipayment. Persistida en
          extra_config.fee_pct (merge sin pisar otras keys). */}
      {meta.supportsFeePct && (
        <div>
          <label className="block text-sm font-medium mb-1.5">Comisión del proveedor (%)</label>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={30}
            step={0.01}
            value={feePct}
            onChange={(e) => setFeePct(e.target.value)}
            placeholder="Ej: 9"
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Se descuenta de cada depósito para calcular el neto. FairPay/UniPayment no
            exponen este dato por API. Vacío = sin comisión configurada.
          </p>
        </div>
      )}

      {error && (
        <div className="p-2 rounded-lg bg-negative/10/30 border border-negative/30 text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Guardar
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
