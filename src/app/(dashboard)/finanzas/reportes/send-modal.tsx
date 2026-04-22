'use client';

// ─────────────────────────────────────────────────────────────────────────────
// SendReportModal
//
// Admin-only modal opened from the "Enviar Reporte" button on
// /finanzas/reportes. Collects:
//   · Period (current date-range from the page OR a named cadence).
//   · Recipients (checkboxes over the company's report users + a free-form
//     external email input).
//   · Sections (pre-filled with the saved config, editable as a one-off).
//
// Submits to POST /api/reports/send. Does not persist overrides — the saved
// config only changes via the ReportsConfigPanel.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Send, X } from 'lucide-react';

export type Cadence = 'current' | 'daily' | 'weekly' | 'monthly';

interface Sections {
  deposits_withdrawals: boolean;
  balances_by_channel: boolean;
  crm_users: boolean;
  broker_pnl: boolean;
  prop_trading: boolean;
}

interface Recipient {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  currentRange: { from: string; to: string };
}

const SECTION_LABELS: Record<keyof Sections, string> = {
  deposits_withdrawals: 'Depósitos y Retiros',
  balances_by_channel: 'Balances por Canal',
  crm_users: 'Usuarios CRM',
  broker_pnl: 'Broker P&L',
  prop_trading: 'Prop Trading Firm',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function previousDayRange(): { from: string; to: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  const iso = d.toISOString().slice(0, 10);
  return { from: iso, to: iso };
}
function previousWeekRange(): { from: string; to: string } {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
function previousMonthRange(): { from: string; to: string } {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastDay = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-01`,
    to: `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(lastDay)}`,
  };
}

export function SendReportModal({ open, onClose, currentRange }: Props) {
  const [candidates, setCandidates] = useState<Recipient[]>([]);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [externalEmail, setExternalEmail] = useState('');
  const [externalEmails, setExternalEmails] = useState<string[]>([]);
  const [cadence, setCadence] = useState<Cadence>('current');
  const [sections, setSections] = useState<Sections>({
    deposits_withdrawals: true,
    balances_by_channel: true,
    crm_users: true,
    broker_pnl: true,
    prop_trading: true,
  });
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  // Load recipients + stored sections when modal opens.
  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setLoading(true);
    (async () => {
      try {
        const [rRes, cRes] = await Promise.all([
          fetch('/api/reports/recipients'),
          fetch('/api/reports/config'),
        ]);
        const rJson = (await rRes.json()) as {
          success: boolean;
          recipients?: Recipient[];
        };
        const cJson = (await cRes.json()) as {
          success: boolean;
          config?: { sections: Sections };
        };
        if (rJson.success && rJson.recipients) {
          setCandidates(rJson.recipients);
          // Default: everyone with Finanzas access pre-checked. Admin can
          // uncheck anyone they don't want to receive this particular send.
          setSelectedEmails(new Set(rJson.recipients.map((r) => r.email)));
        }
        if (cJson.success && cJson.config) setSections(cJson.config.sections);
      } catch {
        setStatus({ kind: 'err', msg: 'Error cargando destinatarios' });
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  if (!open) return null;

  const resolvedRange = (() => {
    if (cadence === 'current') return currentRange;
    if (cadence === 'daily') return previousDayRange();
    if (cadence === 'weekly') return previousWeekRange();
    return previousMonthRange();
  })();

  const allEmails = [...selectedEmails, ...externalEmails];

  function toggleSelected(email: string) {
    const next = new Set(selectedEmails);
    if (next.has(email)) next.delete(email);
    else next.add(email);
    setSelectedEmails(next);
  }

  function addExternal() {
    const v = externalEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(v)) {
      setStatus({ kind: 'err', msg: 'Email inválido' });
      return;
    }
    if (externalEmails.includes(v) || selectedEmails.has(v)) {
      setStatus({ kind: 'err', msg: 'Email ya agregado' });
      return;
    }
    setExternalEmails([...externalEmails, v]);
    setExternalEmail('');
    setStatus(null);
  }

  function removeExternal(email: string) {
    setExternalEmails(externalEmails.filter((e) => e !== email));
  }

  async function submit() {
    if (allEmails.length === 0) {
      setStatus({ kind: 'err', msg: 'Selecciona al menos un destinatario' });
      return;
    }
    setSubmitting(true);
    setStatus(null);
    try {
      const body = {
        from: resolvedRange.from,
        to: resolvedRange.to,
        recipients: allEmails,
        sections,
        cadence: cadence === 'current' ? 'daily' : cadence,
      };
      const res = await fetch('/api/reports/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        success: boolean;
        sent?: number;
        failed?: number;
        error?: string;
      };
      if (!json.success) throw new Error(json.error ?? 'Error');
      setStatus({
        kind: 'ok',
        msg: `Reporte enviado a ${json.sent ?? 0} destinatarios${
          json.failed ? `, ${json.failed} fallos` : ''
        }`,
      });
    } catch (e) {
      setStatus({ kind: 'err', msg: e instanceof Error ? e.message : 'Error' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-background">
          <h2 className="text-lg font-semibold">Enviar Reporte</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Period */}
          <section>
            <h3 className="text-sm font-medium mb-2">Período</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              {(
                [
                  { k: 'current', label: 'Rango actual' },
                  { k: 'daily', label: 'Diario (ayer)' },
                  { k: 'weekly', label: 'Semanal' },
                  { k: 'monthly', label: 'Mensual' },
                ] as Array<{ k: Cadence; label: string }>
              ).map(({ k, label }) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setCadence(k)}
                  className={`px-3 py-2 rounded-md border transition-colors ${
                    cadence === k
                      ? 'bg-[var(--color-primary)] text-white border-transparent'
                      : 'border-border hover:bg-muted'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Desde <strong>{resolvedRange.from}</strong> hasta{' '}
              <strong>{resolvedRange.to}</strong>
            </p>
          </section>

          {/* Sections */}
          <section>
            <h3 className="text-sm font-medium mb-2">Secciones a incluir</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(Object.keys(SECTION_LABELS) as (keyof Sections)[]).map((k) => (
                <label
                  key={k}
                  className="flex items-center gap-2 text-sm p-2 rounded-md border border-border cursor-pointer hover:bg-muted/40"
                >
                  <input
                    type="checkbox"
                    checked={sections[k]}
                    onChange={(e) => setSections({ ...sections, [k]: e.target.checked })}
                  />
                  <span>{SECTION_LABELS[k]}</span>
                </label>
              ))}
            </div>
          </section>

          {/* Recipients */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">Destinatarios</h3>
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() =>
                    setSelectedEmails(new Set(candidates.map((c) => c.email)))
                  }
                  className="underline text-muted-foreground hover:text-foreground"
                >
                  Seleccionar todos
                </button>
                <span className="text-muted-foreground">·</span>
                <button
                  type="button"
                  onClick={() => setSelectedEmails(new Set())}
                  className="underline text-muted-foreground hover:text-foreground"
                >
                  Ninguno
                </button>
              </div>
            </div>
            {loading ? (
              <p className="text-sm text-muted-foreground">Cargando…</p>
            ) : candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No hay usuarios con acceso a Reportes en esta empresa.
              </p>
            ) : (
              <div className="max-h-48 overflow-y-auto rounded-md border border-border divide-y divide-border">
                {candidates.map((r) => (
                  <label
                    key={r.id}
                    className="flex items-center gap-2 text-sm p-2 cursor-pointer hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      checked={selectedEmails.has(r.email)}
                      onChange={() => toggleSelected(r.email)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{r.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{r.email}</div>
                    </div>
                    <span className="text-xs text-muted-foreground uppercase">{r.role}</span>
                  </label>
                ))}
              </div>
            )}

            <div className="mt-3 space-y-2">
              <p className="text-xs text-muted-foreground">Agregar email externo</p>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={externalEmail}
                  onChange={(e) => setExternalEmail(e.target.value)}
                  placeholder="email@dominio.com"
                  className="flex-1 px-2 py-1.5 rounded-md border border-border bg-background text-sm"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addExternal();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={addExternal}
                  className="px-3 py-1.5 rounded-md border border-border text-sm hover:bg-muted"
                >
                  Agregar
                </button>
              </div>
              {externalEmails.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {externalEmails.map((e) => (
                    <span
                      key={e}
                      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted"
                    >
                      {e}
                      <button
                        type="button"
                        onClick={() => removeExternal(e)}
                        className="hover:text-red-600"
                        aria-label={`Quitar ${e}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 p-5 border-t border-border sticky bottom-0 bg-background">
          {status ? (
            <span
              className={`text-xs ${
                status.kind === 'ok' ? 'text-emerald-600' : 'text-red-600'
              }`}
            >
              {status.msg}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {allEmails.length} destinatario(s) seleccionados
            </span>
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted"
            >
              Cancelar
            </button>
            <button
              onClick={submit}
              disabled={submitting || allEmails.length === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm hover:opacity-90 disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              {submitting ? 'Enviando…' : 'Enviar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
