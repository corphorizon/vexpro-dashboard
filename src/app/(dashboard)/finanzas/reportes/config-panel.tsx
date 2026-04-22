'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ReportsConfigPanel
//
// Admin-only collapsible panel that sits above the report on /finanzas/reportes.
// Lets admins pick which sections are included in the automated email reports
// (daily / weekly / monthly) and which cadences are active for their company.
//
// Saves via PUT /api/reports/config. Missing backend row → all on (handled
// server-side in loadReportConfig).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { ChevronDown, Save, Settings2 } from 'lucide-react';
import { Card } from '@/components/ui/card';

interface Sections {
  deposits_withdrawals: boolean;
  balances_by_channel: boolean;
  crm_users: boolean;
  broker_pnl: boolean;
  prop_trading: boolean;
}
interface Cadences {
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
}
interface CadenceDisabledUsers {
  daily: string[];
  weekly: string[];
  monthly: string[];
}
interface Recipient {
  id: string;
  email: string;
  name: string;
  role: string;
}
type CadenceKey = 'daily' | 'weekly' | 'monthly';

const SECTION_LABELS: Record<keyof Sections, string> = {
  deposits_withdrawals: 'Depósitos y Retiros',
  balances_by_channel: 'Balances por Canal',
  crm_users: 'Usuarios CRM',
  broker_pnl: 'Broker P&L',
  prop_trading: 'Prop Trading Firm',
};

const CADENCE_LABELS: Record<keyof Cadences, string> = {
  daily: 'Reporte diario',
  weekly: 'Reporte semanal',
  monthly: 'Reporte mensual',
};

export function ReportsConfigPanel() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [sections, setSections] = useState<Sections>({
    deposits_withdrawals: true,
    balances_by_channel: true,
    crm_users: true,
    broker_pnl: true,
    prop_trading: true,
  });
  const [cadences, setCadences] = useState<Cadences>({
    daily: true,
    weekly: true,
    monthly: true,
  });
  const [disabledUsers, setDisabledUsers] = useState<CadenceDisabledUsers>({
    daily: [],
    weekly: [],
    monthly: [],
  });
  const [candidates, setCandidates] = useState<Recipient[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfgRes, recRes] = await Promise.all([
          fetch('/api/reports/config'),
          fetch('/api/reports/recipients'),
        ]);
        const cfgJson = (await cfgRes.json()) as {
          success: boolean;
          config?: {
            sections: Sections;
            cadences: Cadences;
            cadenceDisabledUsers?: CadenceDisabledUsers;
          };
        };
        const recJson = (await recRes.json()) as {
          success: boolean;
          recipients?: Recipient[];
        };
        if (!cancelled && cfgJson.success && cfgJson.config) {
          setSections(cfgJson.config.sections);
          setCadences(cfgJson.config.cadences);
          if (cfgJson.config.cadenceDisabledUsers) {
            setDisabledUsers(cfgJson.config.cadenceDisabledUsers);
          }
        }
        if (!cancelled && recJson.success && recJson.recipients) {
          setCandidates(recJson.recipients);
        }
      } catch {
        /* fall back to defaults */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleUserForCadence(cadence: CadenceKey, userId: string, nowEnabled: boolean) {
    // `nowEnabled = true` means the checkbox is now ticked → REMOVE from
    // the disabled list. `false` means the opposite.
    setDisabledUsers((prev) => {
      const current = new Set(prev[cadence]);
      if (nowEnabled) current.delete(userId);
      else current.add(userId);
      return { ...prev, [cadence]: Array.from(current) };
    });
  }

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch('/api/reports/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sections,
          cadences,
          cadenceDisabledUsers: disabledUsers,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? 'Error');
      setStatus({ kind: 'ok', msg: 'Configuración guardada' });
    } catch (e) {
      setStatus({ kind: 'err', msg: e instanceof Error ? e.message : 'Error' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <Settings2 className="w-5 h-5 text-muted-foreground" />
          <span className="font-medium">Configuración de Reportes</span>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            · secciones y cadencias de los envíos automáticos
          </span>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="mt-4 pt-4 border-t border-border space-y-5">
          {loading ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : (
            <>
              <section>
                <h3 className="text-sm font-medium mb-2">Secciones incluidas en el email</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {(Object.keys(SECTION_LABELS) as (keyof Sections)[]).map((k) => (
                    <label
                      key={k}
                      className="flex items-center gap-2 text-sm p-2 rounded-md border border-border hover:bg-muted/40 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={sections[k]}
                        onChange={(e) =>
                          setSections({ ...sections, [k]: e.target.checked })
                        }
                      />
                      <span>{SECTION_LABELS[k]}</span>
                    </label>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="text-sm font-medium mb-2">Cadencias activas</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {(Object.keys(CADENCE_LABELS) as (keyof Cadences)[]).map((k) => (
                    <label
                      key={k}
                      className="flex items-center gap-2 text-sm p-2 rounded-md border border-border hover:bg-muted/40 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={cadences[k]}
                        onChange={(e) =>
                          setCadences({ ...cadences, [k]: e.target.checked })
                        }
                      />
                      <span>{CADENCE_LABELS[k]}</span>
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Apagar una cadencia detiene el envío automático para esa frecuencia. El
                  botón manual en esta página sigue funcionando.
                </p>
              </section>

              <section>
                <h3 className="text-sm font-medium mb-2">Destinatarios por cadencia</h3>
                <p className="text-xs text-muted-foreground mb-3">
                  Por defecto todos los usuarios con acceso a Finanzas reciben cada cadencia
                  activa. Desmarca para excluir a un usuario de una cadencia específica.
                </p>
                {candidates.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">
                    Aún no hay usuarios con acceso a Finanzas.
                  </p>
                ) : (
                  <div className="rounded-lg border border-border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-xs text-muted-foreground">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">Usuario</th>
                          {(Object.keys(CADENCE_LABELS) as CadenceKey[]).map((k) => (
                            <th
                              key={k}
                              className={`text-center px-3 py-2 font-medium ${
                                !cadences[k] ? 'opacity-50' : ''
                              }`}
                            >
                              {CADENCE_LABELS[k].replace('Reporte ', '')}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {candidates.map((u) => (
                          <tr key={u.id} className="border-t border-border">
                            <td className="px-3 py-2">
                              <div className="truncate max-w-[220px]">{u.name}</div>
                              <div className="text-xs text-muted-foreground truncate max-w-[220px]">
                                {u.email}
                              </div>
                            </td>
                            {(Object.keys(CADENCE_LABELS) as CadenceKey[]).map((k) => {
                              const enabled = !disabledUsers[k].includes(u.id);
                              return (
                                <td
                                  key={k}
                                  className={`text-center px-3 py-2 ${
                                    !cadences[k] ? 'opacity-50' : ''
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={enabled}
                                    disabled={!cadences[k]}
                                    onChange={(e) =>
                                      toggleUserForCadence(k, u.id, e.target.checked)
                                    }
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <div className="flex items-center gap-3">
                <button
                  onClick={save}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  {saving ? 'Guardando…' : 'Guardar'}
                </button>
                {status && (
                  <span
                    className={`text-xs ${
                      status.kind === 'ok' ? 'text-emerald-600' : 'text-red-600'
                    }`}
                  >
                    {status.msg}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
