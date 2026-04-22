'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Key, Check, Loader2, Eye, EyeOff, Wifi, WifiOff, AlertTriangle } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// ApiCredentialsPanel — external API credentials for a tenant.
//
// Moved here from /configuraciones so it can be embedded in two places:
//   · /superadmin/companies/[id] — companyId prop is required. The superadmin
//     targets that specific tenant.
//   · (Never embedded in the tenant UI after the refactor — superadmin-only.)
//
// When `companyId` is passed, requests append `?company_id=<id>` so the API
// route knows which tenant to operate on (see /api/admin/api-credentials).
// ─────────────────────────────────────────────────────────────────────────────

// SendGrid is exposed again so tenants can brand the sender domain of
// their automated reports (e.g. `dashboard@vexprofx.com`). When a tenant
// has no sendgrid row, emailService falls back to the env defaults.
interface ApiCredential {
  provider: 'sendgrid' | 'coinsbuy' | 'unipayment' | 'fairpay' | 'orion_crm';
  last_four: string | null;
  extra_config: Record<string, unknown> | null;
  is_configured: boolean;
  updated_at: string;
}

interface ProviderMeta {
  label: string;
  description: string;
  extraFields: Array<{ key: string; label: string; placeholder?: string }>;
  /** When true, the card shows a "Probar conexión" button that pings the
   *  provider's health endpoint. Only enabled for providers whose
   *  /api/integrations/<provider>/ping route exists. */
  supportsPing?: boolean;
}

const PROVIDER_META: Record<ApiCredential['provider'], ProviderMeta> = {
  sendgrid: {
    label: 'SendGrid',
    description:
      'Envío de reportes automáticos. El dominio del "from_email" debe estar verificado en la cuenta SendGrid.',
    extraFields: [
      { key: 'from_email', label: 'From email', placeholder: 'dashboard@tuempresa.com' },
      { key: 'from_name', label: 'From name', placeholder: 'Tu Empresa' },
    ],
  },
  coinsbuy: {
    label: 'Coinsbuy',
    description: 'Procesador de pagos crypto.',
    extraFields: [
      { key: 'merchant_id', label: 'Merchant ID' },
      { key: 'webhook_url', label: 'Webhook URL' },
    ],
  },
  unipayment: {
    label: 'Unipayment',
    description: 'Procesador de pagos.',
    extraFields: [
      { key: 'app_id', label: 'App ID' },
      { key: 'webhook_url', label: 'Webhook URL' },
    ],
  },
  fairpay: {
    label: 'Fairpay',
    description: 'Procesador de pagos.',
    extraFields: [
      { key: 'merchant_id', label: 'Merchant ID' },
      { key: 'webhook_url', label: 'Webhook URL' },
    ],
  },
  orion_crm: {
    label: 'Orion CRM',
    description: 'CRM del broker — usuarios registrados, Broker P&L, ventas Prop Firm.',
    extraFields: [
      { key: 'base_url', label: 'Base URL', placeholder: 'https://api.orion-crm.example' },
    ],
    supportsPing: true,
  },
};

// Rendering order — Orion CRM last so it groups with the business/data
// section, separate from the three payment processors above.
const PROVIDER_ORDER: ApiCredential['provider'][] = [
  'sendgrid',
  'coinsbuy',
  'unipayment',
  'fairpay',
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

export function ApiCredentialsPanel({ companyId }: Props) {
  const [creds, setCreds] = useState<ApiCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiCredential['provider'] | null>(null);
  // Per-provider ping state. Only populated for providers in which
  // `supportsPing` is true and the user has clicked "Probar conexión".
  const [pingResults, setPingResults] = useState<Partial<Record<ApiCredential['provider'], PingResult>>>({});
  const [pingBusy, setPingBusy] = useState<ApiCredential['provider'] | null>(null);

  const handlePing = async (provider: ApiCredential['provider']) => {
    setPingBusy(provider);
    try {
      const res = await fetch(`/api/integrations/${provider.replace('_', '-')}/ping${qs}`);
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

  const qs = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/api-credentials${qs}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setCreds(data.credentials);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando credenciales');
    } finally {
      setLoading(false);
    }
  }, [qs]);

  useEffect(() => { reload(); }, [reload]);

  const getCred = (provider: ApiCredential['provider']) =>
    creds.find((c) => c.provider === provider);

  const handleDelete = async (provider: ApiCredential['provider']) => {
    if (!confirm(`¿Eliminar las credenciales de ${PROVIDER_META[provider].label}?`)) return;
    try {
      const res = await fetch(`/api/admin/api-credentials${qs}`, {
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
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 text-sm">
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
                existingExtras={cred?.extra_config || {}}
                companyId={companyId}
                onSaved={() => { setEditing(null); reload(); }}
                onCancel={() => setEditing(null)}
              />
            ) : cred?.is_configured ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">API key:</span>
                  <code className="px-2 py-0.5 rounded bg-muted font-mono">••••••••{cred.last_four}</code>
                </div>
                {cred.extra_config && Object.keys(cred.extra_config).length > 0 && (
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {Object.entries(cred.extra_config).map(([k, v]) => (
                      <div key={k}>
                        <span className="font-medium">{k}:</span> {String(v ?? '')}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Última actualización: {new Date(cred.updated_at).toLocaleString('es-ES')}
                </p>
                {/* Ping result message (only for providers that support it) */}
                {meta.supportsPing && ping && (
                  <p
                    className={`text-xs ${
                      ping.connected
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : ping.isMock
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-red-600 dark:text-red-400'
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
                    className="px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-800 text-red-600 text-sm hover:bg-red-50 dark:hover:bg-red-950/30"
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

function ApiCredentialForm({
  provider,
  existingExtras,
  companyId,
  onSaved,
  onCancel,
}: {
  provider: ApiCredential['provider'];
  existingExtras: Record<string, unknown>;
  companyId?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const meta = PROVIDER_META[provider];
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [extras, setExtras] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of meta.extraFields) init[f.key] = String(existingExtras[f.key] ?? '');
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (secret.length < 8) {
      setError('La llave debe tener al menos 8 caracteres.');
      return;
    }
    setSaving(true);
    try {
      const qs = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';
      const res = await fetch(`/api/admin/api-credentials${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          provider,
          secret,
          extra_config: extras,
          company_id: companyId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 mt-2 p-4 rounded-lg bg-muted/30 border border-border">
      <div>
        <label className="block text-sm font-medium mb-1.5">API Key / Secret</label>
        <div className="relative">
          <input
            type={showSecret ? 'text' : 'password'}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
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
          Por seguridad la llave no se muestra después de guardar. Si la cambias, pégala completa.
        </p>
      </div>

      {meta.extraFields.map((f) => (
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

      {error && (
        <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 text-sm">
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
