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
//
// When `companyId` is passed, requests append `?company_id=<id>` so the API
// route knows which tenant to operate on (see /api/admin/api-credentials).
// ─────────────────────────────────────────────────────────────────────────────

type Provider = 'sendgrid' | 'coinsbuy' | 'unipayment' | 'fairpay' | 'fairpay_banking' | 'orion_crm' | 'paypros';

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
  | { kind: 'paypros' };   // paypros → merchant_id + api_key + sign_key (secret = JSON) + base_url

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
};

// Rendering order — Orion CRM last so it groups with the business/data
// section, separate from the three payment processors above.
const PROVIDER_ORDER: Provider[] = [
  'sendgrid',
  'coinsbuy',
  'unipayment',
  'fairpay',
  'fairpay_banking',
  'paypros',
  'orion_crm',
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

  const qs = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';

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
              <span className="font-medium">{k}:</span> {String(v ?? '')}
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
