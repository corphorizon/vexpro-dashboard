'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ChevronDown, ChevronRight, Info, AlertTriangle, Plus, Search, X, Handshake, Lock,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { formatCurrency, formatNumber, cn } from '@/lib/utils';
import {
  IB_DEAL_TYPES,
  toNumber,
  ibDisplayName,
  type IbDealType,
  type IbNegotiationPackage,
  type IbNegotiationsResponse,
  type IbNetworkMember,
  type IbProfile,
} from '@/lib/hr/ib-negotiations';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña «Negociaciones IB».
//
// Kevin, 2026-08-27: «me gustaría crear en esa sección algo para también tener
// negociaciones de IB por aparte, normalmente son negociaciones de PNL o Net
// Deposit, necesitaría tener la info completa de ellos, el net deposit de ellos
// y su red, el PNL, la cantidad de lotes que se les pagaron y cuánto se les
// pagó».
//
// ── ES UNA PESTAÑA APARTE Y NO UNA VISTA DE «Negociaciones» ───────────────
// La pestaña «Negociaciones» que ya existe es de PERFILES COMERCIALES (BDM,
// heads): otra tabla, otra API, otra gente. Un IB es un cliente del CRM que
// refiere; sólo 114 de los 1.793 sponsors distintos del CRM son perfiles
// comerciales. Mezclarlas en una sola lista obligaría a mirar el tipo de fila
// para saber de qué se está hablando. Kevin además las pidió «por aparte».
//
// ── DOS NET DEPOSIT, NO UNO ───────────────────────────────────────────────
// «el net deposit de ellos y su red» son dos números y se muestran separados.
// Sumarlos escondería el caso real más común: el IB personalmente retira más de
// lo que deposita (medido en agosto 2026: luka.angeles propio −15.899,33 con
// una red de +223.166,70).
//
// ── LA COMISIÓN NO SE ROLLA POR LA RED ────────────────────────────────────
// Los premios que cobra un IB ya son por las operaciones de TODA su estructura.
// Sumarle los de sus sub-IB contaría dos veces la misma operación. Por eso las
// columnas de lotes / comisión / PNL son del IB y no llevan una versión "de la
// red": la red sólo aporta el net deposit y su tamaño.
//
// ── «SIN DATO» ESTÁ ESCRITO, NO DIBUJADO COMO CERO ────────────────────────
// El desglose forex/sintéticos sale de una colección que el bróker purga a los
// quince días: sólo hay espejo desde el 2026-08-13 y los meses anteriores NUNCA
// lo van a tener. En esas celdas dice "sin dato" y arriba hay un aviso con los
// días cubiertos, igual que en la pestaña de producción IB.
// ─────────────────────────────────────────────────────────────────────────────

function defaultMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const DEAL_LABEL_KEY: Record<IbDealType, string> = {
  pnl: 'hr.ibNegDealPnl',
  net_deposit: 'hr.ibNegDealNetDeposit',
};

/** Verde/rojo por el signo — un net deposit negativo es plata que se fue. */
function moneyClass(v: number): string {
  if (v > 0) return 'text-positive';
  if (v < 0) return 'text-negative';
  return 'text-muted-foreground';
}

export function IbNegotiationsTab() {
  const { t } = useI18n();
  const [month, setMonth] = useState(defaultMonth);
  const [data, setData] = useState<IbNegotiationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const flash = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await apiFetch(`/api/admin/ib-negotiations?month=${month}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'load failed');
      setData(json as IbNegotiationsResponse);
    } catch {
      setLoadError(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const close = async (id: string) => {
    try {
      const res = await apiFetch('/api/admin/ib-negotiations', {
        method: 'POST',
        body: JSON.stringify({ action: 'close', id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'error');
      flash('success', t('hr.ibNegClosed'));
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : t('hr.warningError'));
    }
  };

  const cov = data?.symbolCoverage;
  const coverageMsg = !cov
    ? null
    : cov.days === 0
      ? { tone: 'warn' as const, text: t('hr.prodCoverageNone') }
      : cov.days < cov.daysInMonth
        ? {
            tone: 'warn' as const,
            text: t('hr.prodCoveragePartial')
              .replace('{days}', String(cov.days))
              .replace('{total}', String(cov.daysInMonth))
              .replace('{from}', cov.from ?? '')
              .replace('{to}', cov.to ?? ''),
          }
        : { tone: 'info' as const, text: t('hr.prodCoverageFull') };

  // Totales de lo negociado: es la pregunta que sigue a "¿cuánto le pagamos a
  // los IB con los que tenemos trato?" y no se puede sacar mirando la tabla.
  const totals = useMemo(() => {
    const act = (data?.packages ?? []).filter((p) => p.negotiation.status === 'active');
    return {
      count: act.length,
      commission: act.reduce((s, p) => s + p.production.commission, 0),
      lots: act.reduce((s, p) => s + p.production.lots, 0),
      networkNet: act.reduce((s, p) => s + (p.network?.net ?? 0), 0),
    };
  }, [data]);

  return (
    <div className="space-y-6">
      {toast && (
        <div className={cn('px-4 py-3 rounded-lg text-sm', toast.type === 'success'
          ? 'bg-positive/10 text-positive border border-positive/30'
          : 'bg-negative/10 text-negative border border-negative/30')}>
          {toast.msg}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground" htmlFor="ibneg-month">{t('hr.warningMonth')}</label>
          <input
            id="ibneg-month"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-border bg-card text-base sm:text-sm"
          />
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
        >
          <Plus className="w-4 h-4" /> {t('hr.ibNegNew')}
        </button>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/5 p-3">
        <Info className="w-4 h-4 text-info mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground">{t('hr.ibNegHint')}</p>
      </div>

      {coverageMsg && (
        <div className={cn(
          'flex items-start gap-2 rounded-lg border p-3',
          coverageMsg.tone === 'warn' ? 'border-warning/30 bg-warning/5' : 'border-border',
        )}>
          {coverageMsg.tone === 'warn'
            ? <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
            : <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />}
          <p className="text-xs text-muted-foreground">{coverageMsg.text}</p>
        </div>
      )}

      {showForm && (
        <NewNegotiationForm
          onCancel={() => setShowForm(false)}
          onSaved={async (msg) => { setShowForm(false); flash('success', msg); await load(); }}
          onError={(msg) => flash('error', msg)}
        />
      )}

      {loadError ? (
        <p className="text-sm text-negative">{t('hr.warningError')}</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : !data ? null : data.packages.length === 0 ? (
        <div className="rounded-lg border border-border p-8 text-center">
          <Handshake className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">{t('hr.ibNegEmpty')}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Total label={t('hr.ibNegActive')} value={formatNumber(totals.count).replace(/\.00$/, '')} />
            <Total label={t('hr.prodLots')} value={formatNumber(totals.lots)} />
            <Total label={t('hr.ibNegPaid')} value={formatCurrency(totals.commission)} />
            <Total
              label={t('hr.ibNegNetworkNet')}
              value={formatCurrency(totals.networkNet)}
              tone={moneyClass(totals.networkNet)}
            />
          </div>

          <div className="rounded-lg border border-border overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <table className="w-full text-sm min-w-[1000px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('hr.ibNegIb')}</th>
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('hr.ibNegDeal')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.ibNegOwnNet')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.ibNegNetworkNet')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.ibNegNetworkSize')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.prodLots')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.ibNegPaid')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium hidden md:table-cell">{t('hr.prodPnl')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.packages.map((pkg) => (
                  <NegotiationRows
                    key={pkg.negotiation.id}
                    pkg={pkg}
                    month={month}
                    open={expanded.has(pkg.negotiation.id)}
                    onToggle={() => toggle(pkg.negotiation.id)}
                    onClose={() => close(pkg.negotiation.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Total({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-sm text-muted-foreground mb-1">{label}</p>
      <p className={cn('text-xl font-bold', tone)}>{value}</p>
    </div>
  );
}

/**
 * `null` NO se dibuja como 0: dice "sin dato". Es la diferencia entre "no operó
 * sintéticos" y "ese mes no está espejado", y confundirlas es el modo de fallo
 * que esta pantalla existe para evitar.
 */
function Maybe({ v, money }: { v: number | null; money?: boolean }) {
  const { t } = useI18n();
  if (v === null) return <span className="text-muted-foreground/60 italic text-xs">{t('hr.prodNoData')}</span>;
  return <>{money ? formatCurrency(v) : formatNumber(v)}</>;
}

function NegotiationRows({ pkg, month, open, onToggle, onClose }: {
  pkg: IbNegotiationPackage;
  month: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const neg = pkg.negotiation;
  const p = pkg.production;
  const net = pkg.network;
  const cerrada = neg.status === 'closed';

  return (
    <>
      <tr className={cn('border-b border-border/50 hover:bg-muted/50', cerrada && 'opacity-60')}>
        <td className="py-2 px-3">
          <div className="flex items-center gap-1.5">
            <button onClick={onToggle} className="text-muted-foreground hover:text-foreground" aria-label={ibDisplayName(pkg)}>
              {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            <div>
              <p className="font-medium">{ibDisplayName(pkg)}</p>
              <p className="text-xs text-muted-foreground">{neg.ib_username ?? '-'}</p>
            </div>
          </div>
        </td>
        <td className="py-2 px-3">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-muted">
            {t(DEAL_LABEL_KEY[neg.deal_type])}
          </span>
          {neg.pct != null && (
            <span className="ml-1.5 text-xs text-muted-foreground">{toNumber(neg.pct)}%</span>
          )}
          {cerrada && (
            <span className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-muted-foreground">
              <Lock className="w-3 h-3" /> {t('hr.ibNegStatusClosed')}
            </span>
          )}
        </td>
        {/* Los dos net deposit van SEPARADOS: sumarlos escondería que el IB
            personalmente retira más de lo que deposita. */}
        <td className={cn('py-2 px-3 text-right', net ? moneyClass(net.ownNet) : '')}>
          {net ? formatCurrency(net.ownNet) : <Maybe v={null} />}
        </td>
        <td className={cn('py-2 px-3 text-right font-medium', net ? moneyClass(net.net) : '')}>
          {net ? formatCurrency(net.net) : <Maybe v={null} />}
        </td>
        <td className="py-2 px-3 text-right text-muted-foreground">
          {net ? formatNumber(net.size).replace(/\.00$/, '') : <Maybe v={null} />}
        </td>
        <td className="py-2 px-3 text-right">{formatNumber(p.lots)}</td>
        <td className="py-2 px-3 text-right font-medium">{formatCurrency(p.commission)}</td>
        <td className={cn('py-2 px-3 text-right hidden md:table-cell', moneyClass(p.pnl))}>{formatCurrency(p.pnl)}</td>
        <td className="py-2 px-3 text-right">
          {!cerrada && (
            <button
              onClick={onClose}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-muted text-muted-foreground"
            >
              {t('hr.ibNegClose')}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/50 bg-muted/20">
          <td colSpan={9} className="py-4 px-3">
            <NegotiationDetail pkg={pkg} month={month} />
          </td>
        </tr>
      )}
    </>
  );
}

function NegotiationDetail({ pkg, month }: { pkg: IbNegotiationPackage; month: string }) {
  const { t } = useI18n();
  const neg = pkg.negotiation;
  const prof = pkg.profile;
  const p = pkg.production;
  const [members, setMembers] = useState<IbNetworkMember[] | null>(null);
  const [membersError, setMembersError] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);

  const loadMembers = useCallback(async () => {
    if (!neg.ib_username) return;
    setLoadingMembers(true);
    setMembersError(false);
    try {
      const res = await apiFetch(
        `/api/admin/ib-negotiations?network=${encodeURIComponent(neg.ib_username)}&month=${month}`,
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'error');
      setMembers(json.members as IbNetworkMember[]);
    } catch {
      setMembersError(true);
    } finally {
      setLoadingMembers(false);
    }
  }, [neg.ib_username, month]);

  // La red se pide recién al abrir el detalle: recorrerla es lo caro (hasta
  // 17.000 personas y 17 niveles para un IB grande) y nadie abre las quince
  // filas de la lista a la vez.
  useEffect(() => { loadMembers(); }, [loadMembers]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* ── Perfil completo del IB ─────────────────────────────────────── */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('hr.ibNegProfile')}</h4>
          {prof ? (
            <dl className="text-xs space-y-1">
              <Field label={t('common.email')} value={prof.email} />
              <Field label={t('hr.ibNegUsername')} value={prof.username} />
              <Field label={t('hr.ibNegPhone')} value={[prof.phone_country_code, prof.phone_raw].filter(Boolean).join(' ') || null} />
              <Field label={t('hr.ibNegCountry')} value={prof.country} />
              <Field label={t('hr.ibNegKyc')} value={prof.kyc_status} />
              <Field label={t('hr.ibNegRank')} value={prof.rank} />
              <Field label={t('hr.ibNegStatus')} value={prof.status} />
              <Field label={t('hr.ibNegRegistered')} value={prof.register_date ? String(prof.register_date).slice(0, 10) : null} />
              <Field label={t('hr.ibNegSponsor')} value={prof.sponsor_username ?? prof.sponsor_email} />
              <Field label={t('hr.ibNegProgram')} value={prof.ib_program_name} />
            </dl>
          ) : (
            // El IB dejó de estar en el espejo del CRM. La negociación sigue
            // existiendo (por eso no hay FK): se dice, no se oculta.
            <p className="text-xs text-muted-foreground italic">{t('hr.ibNegProfileGone')}</p>
          )}
        </div>

        {/* ── El trato ───────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('hr.ibNegDeal')}</h4>
          <dl className="text-xs space-y-1">
            <Field label={t('hr.ibNegDealType')} value={t(DEAL_LABEL_KEY[neg.deal_type])} />
            <Field label={t('hr.ibNegPct')} value={neg.pct == null ? null : `${toNumber(neg.pct)}%`} />
            <Field label={t('hr.ibNegTarget')} value={neg.target_amount == null ? null : formatCurrency(toNumber(neg.target_amount))} />
            <Field label={t('hr.ibNegFrom')} value={neg.starts_on} />
            <Field label={t('hr.ibNegTo')} value={neg.ends_on} />
            <Field label={t('hr.ibNegTerms')} value={neg.terms} />
            <Field label={t('hr.ibNegNotes')} value={neg.notes} />
            <Field label={t('hr.ibNegCreatedBy')} value={neg.created_by_name} />
          </dl>
        </div>

        {/* ── Producción del mes ─────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('hr.ibNegProduction')}</h4>
          <dl className="text-xs space-y-1">
            <Field label={t('hr.prodLots')} value={formatNumber(p.lots)} />
            <Field label={t('hr.ibNegPaid')} value={formatCurrency(p.commission)} />
            <Field label={t('hr.prodRewards')} value={formatNumber(p.rewards).replace(/\.00$/, '')} />
            <Field label={t('hr.prodPnl')} value={formatCurrency(p.pnl)} />
            <div className="flex gap-2">
              <dt className="text-muted-foreground min-w-[92px]">{t('hr.prodForex')}</dt>
              <dd><Maybe v={p.forexLots} /></dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground min-w-[92px]">{t('hr.prodSynthetic')}</dt>
              <dd><Maybe v={p.syntheticLots} /></dd>
            </div>
          </dl>
          <p className="text-[11px] text-muted-foreground pt-1">{t('hr.ibNegPnlHint')}</p>
        </div>
      </div>

      {/* ── La red que movió plata este mes ──────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('hr.ibNegNetwork')}</h4>
          {pkg.network && (
            <span className="text-xs text-muted-foreground">
              {t('hr.ibNegNetworkSummary')
                .replace('{size}', String(pkg.network.size))
                .replace('{depth}', String(pkg.network.depth))
                .replace('{movers}', String(pkg.network.movers))}
            </span>
          )}
        </div>
        {membersError ? (
          <p className="text-xs text-negative">{t('hr.warningError')}</p>
        ) : loadingMembers ? (
          <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
        ) : !members || members.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('hr.ibNegNetworkEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[560px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-1.5 px-2 text-muted-foreground font-medium">{t('hr.ibNegUsername')}</th>
                  <th className="text-left py-1.5 px-2 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.ibNegCountry')}</th>
                  <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">{t('hr.ibNegLevel')}</th>
                  <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">{t('hr.ibNegDeposits')}</th>
                  <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">{t('hr.ibNegWithdrawals')}</th>
                  <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">{t('hr.ibNegNet')}</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.user_external_id} className="border-b border-border/40">
                    <td className="py-1.5 px-2">{m.username ?? m.email ?? m.user_external_id}</td>
                    <td className="py-1.5 px-2 text-muted-foreground hidden sm:table-cell">{m.country ?? '-'}</td>
                    <td className="py-1.5 px-2 text-right text-muted-foreground">{m.depth}</td>
                    <td className="py-1.5 px-2 text-right">{formatCurrency(toNumber(m.deposits))}</td>
                    <td className="py-1.5 px-2 text-right">{formatCurrency(toNumber(m.withdrawals))}</td>
                    <td className={cn('py-1.5 px-2 text-right font-medium', moneyClass(toNumber(m.net)))}>
                      {formatCurrency(toNumber(m.net))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-muted-foreground mt-2">{t('hr.ibNegNetworkTopHint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground min-w-[92px] shrink-0">{label}</dt>
      <dd className="break-all">{value || <span className="text-muted-foreground/60">-</span>}</dd>
    </div>
  );
}

/**
 * Alta: primero se BUSCA al IB contra el espejo del CRM y recién después se
 * completa el trato. No hay campo de texto libre para el IB a propósito: una
 * negociación cargada contra un email tipeado a mano no cruza con nada y la
 * fila aparecería para siempre sin números.
 */
function NewNegotiationForm({ onCancel, onSaved, onError }: {
  onCancel: () => void;
  onSaved: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<IbProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<IbProfile | null>(null);
  const [dealType, setDealType] = useState<IbDealType>('pnl');
  const [pct, setPct] = useState('');
  const [target, setTarget] = useState('');
  const [terms, setTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [saving, setSaving] = useState(false);

  // Se busca con un respiro de 300 ms: tipear "ana.garcia" son diez pulsaciones
  // y diez ilike sobre 21.196 filas no le sirven a nadie.
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 3) { setResults([]); return; }
    let cancelled = false;
    const id = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiFetch(`/api/admin/ib-negotiations?q=${encodeURIComponent(needle)}`);
        const json = await res.json();
        if (!cancelled && res.ok) setResults((json.results ?? []) as IbProfile[]);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(id); };
  }, [q]);

  const save = async () => {
    if (!picked) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/admin/ib-negotiations', {
        method: 'POST',
        body: JSON.stringify({
          action: 'create',
          user_external_id: picked.user_external_id,
          deal_type: dealType,
          pct: pct.trim() || null,
          target_amount: target.trim() || null,
          terms: terms.trim() || null,
          notes: notes.trim() || null,
          starts_on: startsOn || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'error');
      await onSaved(t('hr.ibNegCreated'));
    } catch (err) {
      onError(err instanceof Error ? err.message : t('hr.warningError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t('hr.ibNegNew')}</h3>
          <p className="text-xs text-muted-foreground mt-1">{t('hr.ibNegSearchHint')}</p>
        </div>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground" aria-label={t('common.cancel')}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {!picked ? (
        <div className="space-y-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('hr.ibNegSearchPlaceholder')}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm"
            />
          </div>
          {searching && <p className="text-xs text-muted-foreground">{t('common.loading')}</p>}
          {results.length > 0 && (
            <ul className="rounded-lg border border-border divide-y divide-border max-h-64 overflow-y-auto">
              {results.map((r) => (
                <li key={r.user_external_id}>
                  <button
                    onClick={() => setPicked(r)}
                    className="w-full text-left px-3 py-2 hover:bg-muted text-sm"
                  >
                    <span className="font-medium">{r.username ?? r.email}</span>
                    <span className="text-xs text-muted-foreground ml-2">{r.email}</span>
                    {r.country && <span className="text-xs text-muted-foreground ml-2">· {r.country}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <div className="text-sm">
              <p className="font-medium">{[picked.first_name, picked.last_name].filter(Boolean).join(' ') || picked.username}</p>
              <p className="text-xs text-muted-foreground">{picked.username} · {picked.email}</p>
            </div>
            <button onClick={() => setPicked(null)} className="text-xs text-muted-foreground hover:text-foreground">
              {t('common.cancel')}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-muted-foreground space-y-1">
              <span>{t('hr.ibNegDealType')}</span>
              <select
                value={dealType}
                onChange={(e) => setDealType(e.target.value as IbDealType)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm text-foreground"
              >
                {IB_DEAL_TYPES.map((d) => (
                  <option key={d} value={d}>{t(DEAL_LABEL_KEY[d])}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-foreground space-y-1">
              <span>{t('hr.ibNegPct')}</span>
              <input
                type="number" min="0" max="100" step="0.01"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm text-foreground"
              />
            </label>
            <label className="text-xs text-muted-foreground space-y-1">
              <span>{t('hr.ibNegTarget')}</span>
              <input
                type="number" min="0" step="0.01"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm text-foreground"
              />
            </label>
            <label className="text-xs text-muted-foreground space-y-1">
              <span>{t('hr.ibNegFrom')}</span>
              <input
                type="date"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm text-foreground"
              />
            </label>
          </div>

          <label className="text-xs text-muted-foreground space-y-1 block">
            <span>{t('hr.ibNegTerms')}</span>
            <textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={2}
              placeholder={t('hr.ibNegTermsPlaceholder')}
              className="w-full px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm text-foreground"
            />
          </label>

          <label className="text-xs text-muted-foreground space-y-1 block">
            <span>{t('hr.ibNegNotes')}</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm text-foreground"
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {t('common.save')}
            </button>
            <button onClick={onCancel} className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
