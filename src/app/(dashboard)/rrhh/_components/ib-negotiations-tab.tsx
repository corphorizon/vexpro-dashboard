'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, Plus, X, Handshake, Lock } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { formatNumber, cn } from '@/lib/utils';
import { Panel } from '@/components/ui/panel';
import { KpiStrip } from '@/components/ui/kpi-strip';
import { Notice } from '@/components/ui/notice';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS, moneyText } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { useToasts } from '@/components/ui/toast';
import { ActionButton } from '@/components/ui/action-button';
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
import { ROW_ACTION_CLASS, SearchField, TOGGLE_CLASS } from './hr-ui';
import { sumKnown } from './hr-view';

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
//
// ── «Libro mayor» (2026-10-12) — sólo presentación ────────────────────────
// Totales → KpiStrip; lista → FinTable (el tipo de trato es un badge neutro:
// no es un estado); el detalle de una fila abierta pasa a su propio Panel
// debajo de la tabla (FinTable no tiene filas de detalle y en tarjeta móvil
// no tendrían lugar); alta con Field/Input/Select/Textarea; cobertura → Notice
// `pend`/`info`; avisos al toast flotante. El total «Net de la red» sumaba
// `p.network?.net ?? 0`: una red que no se pudo resolver entraba como cero
// sin decirlo. Ahora suma lo conocido y el sub cuenta los que faltan (y si
// faltan todos, «—»). Medición (sin comentarios): antes 2 clases de paleta
// cruda, 2 `text-[11px]`, 83 tokens legados y 1 `?? 0`; después 0 / 0 / 0 / 0.
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

/**
 * `null` NO se dibuja como 0: dice "sin dato". Es la diferencia entre "no operó
 * sintéticos" y "ese mes no está espejado", y confundirlas es el modo de fallo
 * que esta pantalla existe para evitar.
 */
function NoData() {
  const { t } = useI18n();
  return <span className="text-[12px] text-text-3">{t('hr.prodNoData')}</span>;
}

function Maybe({ v, money }: { v: number | null; money?: boolean }) {
  if (v === null) return <NoData />;
  return money ? <Money value={v} /> : <span className={NUM_CLASS}>{formatNumber(v)}</span>;
}

/** Tipo de trato + % + «cerrada». El tipo no es un estado: gris. */
function DealBadges({ pkg }: { pkg: IbNegotiationPackage }) {
  const { t } = useI18n();
  const neg = pkg.negotiation;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusBadge kind="neutral" label={t(DEAL_LABEL_KEY[neg.deal_type])} />
      {neg.pct != null && <span className={cn(NUM_CLASS, 'text-[12px] text-text-2')}>{toNumber(neg.pct)}%</span>}
      {neg.status === 'closed' && (
        <span className="inline-flex items-center gap-0.5 text-[12px] text-text-3">
          <Lock aria-hidden className="size-3" /> {t('hr.ibNegStatusClosed')}
        </span>
      )}
    </span>
  );
}
const dealBadges = (pkg: IbNegotiationPackage) => <DealBadges pkg={pkg} />;

export function IbNegotiationsTab() {
  const { t } = useI18n();
  const [month, setMonth] = useState(defaultMonth);
  const [data, setData] = useState<IbNegotiationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { toast, ToastHost } = useToasts();

  const flash = (type: 'success' | 'error', msg: string) => {
    if (type === 'success') toast.success(msg);
    else toast.error(msg);
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
  // La red de un IB puede no resolverse (`network` null ≠ 0): se suma lo que
  // se sabe y se CUENTA lo que falta (antes `p.network?.net ?? 0`, que sumaba
  // «no sabemos» como cero sin decirlo).
  const totals = useMemo(() => {
    const act = (data?.packages ?? []).filter((p) => p.negotiation.status === 'active');
    const networkNet = sumKnown(act, (p) => p.network?.net);
    return {
      count: act.length,
      commission: act.reduce((s, p) => s + p.production.commission, 0),
      lots: act.reduce((s, p) => s + p.production.lots, 0),
      networkNet: networkNet.sum,
      networkMissing: networkNet.missing,
    };
  }, [data]);

  const columns: FinColumn<IbNegotiationPackage>[] = [
    {
      key: 'ib',
      header: t('hr.ibNegIb'),
      cell: (pkg) => (
        <span className="inline-flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={() => toggle(pkg.negotiation.id)}
            className={TOGGLE_CLASS}
            aria-label={ibDisplayName(pkg)}
            aria-expanded={expanded.has(pkg.negotiation.id)}
          >
            {expanded.has(pkg.negotiation.id)
              ? <ChevronDown aria-hidden className="size-3.5" />
              : <ChevronRight aria-hidden className="size-3.5" />}
          </button>
          <span className={cn('truncate', pkg.negotiation.status === 'closed' && 'text-text-3')}>{ibDisplayName(pkg)}</span>
        </span>
      ),
      meta: (pkg) => pkg.negotiation.ib_username ?? '—',
      mobileMeta: (pkg) => dealBadges(pkg),
    },
    { key: 'deal', header: t('hr.ibNegDeal'), hideSm: true, cell: dealBadges },
    // Los dos net deposit van SEPARADOS: sumarlos escondería que el IB
    // personalmente retira más de lo que deposita.
    {
      key: 'ownNet',
      header: t('hr.ibNegOwnNet'),
      kind: 'money',
      hideSm: true,
      money: { tone: 'sign' },
      value: (pkg) => (pkg.network ? pkg.network.ownNet : null),
      subtotal: false,
    },
    {
      key: 'networkNet',
      header: t('hr.ibNegNetworkNet'),
      kind: 'money',
      money: { tone: 'sign' },
      value: (pkg) => (pkg.network ? pkg.network.net : null),
      subtotal: false,
    },
    {
      key: 'size',
      header: t('hr.ibNegNetworkSize'),
      align: 'right',
      hideSm: true,
      cell: (pkg) =>
        pkg.network
          ? <span className={NUM_CLASS}>{formatNumber(pkg.network.size).replace(/\.00$/, '')}</span>
          : <NoData />,
    },
    {
      key: 'lots',
      header: t('hr.prodLots'),
      align: 'right',
      hideSm: true,
      cell: (pkg) => <span className={NUM_CLASS}>{formatNumber(pkg.production.lots)}</span>,
    },
    { key: 'paid', header: t('hr.ibNegPaid'), kind: 'money', value: (pkg) => pkg.production.commission, subtotal: false },
    {
      key: 'pnl',
      header: t('hr.prodPnl'),
      kind: 'money',
      hideSm: true,
      money: { tone: 'sign' },
      value: (pkg) => pkg.production.pnl,
      subtotal: false,
    },
  ];

  const openPackages = (data?.packages ?? []).filter((pkg) => expanded.has(pkg.negotiation.id));

  return (
    <div className="space-y-4">
      {ToastHost}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-2">
          <label className="text-[12.5px] font-medium text-text-2" htmlFor="ibneg-month">{t('hr.warningMonth')}</label>
          {/* Ancho en el contenedor: `cn` no fusiona con el `w-full` del control. */}
          <div className="w-44">
            <Input id="ibneg-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
        </div>
        <ActionButton variant="primary" onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}>
          <Plus aria-hidden className="size-[15px]" strokeWidth={1.75} /> {t('hr.ibNegNew')}
        </ActionButton>
      </div>

      {coverageMsg && <Notice kind={coverageMsg.tone === 'warn' ? 'pend' : 'info'} title={coverageMsg.text} />}

      {showForm && (
        <NewNegotiationForm
          onCancel={() => setShowForm(false)}
          onSaved={async (msg) => { setShowForm(false); flash('success', msg); await load(); }}
          onError={(msg) => flash('error', msg)}
        />
      )}

      {loadError ? (
        <Notice kind="bad" title={t('hr.warningError')} />
      ) : loading ? (
        <p className="text-[13px] text-text-3">{t('common.loading')}</p>
      ) : !data ? null : data.packages.length === 0 ? (
        <Panel>
          <div className="py-6 text-center">
            <Handshake aria-hidden className="mx-auto mb-2 size-8 text-text-3" strokeWidth={1.5} />
            <p className="text-[13px] text-text-3">{t('hr.ibNegEmpty')}</p>
          </div>
        </Panel>
      ) : (
        <>
          <KpiStrip
            items={[
              { key: 'active', label: t('hr.ibNegActive'), value: totals.count, format: 'count' },
              {
                key: 'lots',
                label: t('hr.prodLots'),
                value: totals.lots,
                format: 'count',
                sub: Number.isInteger(totals.lots) ? undefined : formatNumber(totals.lots),
              },
              { key: 'paid', label: t('hr.ibNegPaid'), value: totals.commission, hero: true },
              {
                key: 'networkNet',
                label: t('hr.ibNegNetworkNet'),
                value: totals.networkNet,
                tone: 'sign',
                missingBadge: { kind: 'stale', label: t('hr.prodNoData') },
                sub:
                  totals.networkMissing > 0
                    ? t('hrv.networkMissing', { n: String(totals.networkMissing) })
                    : undefined,
              },
            ]}
          />

          <Panel title={t('hr.ibNegotiationsTab')} hint={data.month?.slice(0, 7)} flush>
            <p className="border-b border-border px-4 py-2.5 text-[12.5px] leading-5 text-text-3">{t('hr.ibNegHint')}</p>
            <FinTable
              columns={columns}
              rows={data.packages}
              rowKey={(pkg) => pkg.negotiation.id}
              caption={t('hr.ibNegotiationsTab')}
              rowActions={(pkg) =>
                pkg.negotiation.status === 'closed' ? null : (
                  <ActionButton variant="ghost" onClick={() => close(pkg.negotiation.id)}>
                    {t('hr.ibNegClose')}
                  </ActionButton>
                )
              }
            />
          </Panel>

          {/* El detalle de cada fila abierta. Antes era una fila extra dentro
              de la tabla; FinTable no tiene filas de detalle (y en tarjeta
              móvil no tendrían dónde ir), así que va en su propio Panel. */}
          {openPackages.map((pkg) => (
            <Panel
              key={pkg.negotiation.id}
              title={ibDisplayName(pkg)}
              hint={pkg.negotiation.ib_username ?? undefined}
              actions={
                <button
                  type="button"
                  onClick={() => toggle(pkg.negotiation.id)}
                  className={ROW_ACTION_CLASS}
                  aria-label={t('common.close')}
                >
                  <X aria-hidden className="size-4" />
                </button>
              }
            >
              <NegotiationDetail pkg={pkg} month={month} />
            </Panel>
          ))}
        </>
      )}
    </div>
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

  const memberColumns: FinColumn<IbNetworkMember>[] = [
    {
      key: 'user',
      header: t('hr.ibNegUsername'),
      cell: (m) => m.username ?? m.email ?? m.user_external_id,
      meta: (m) => m.country ?? undefined,
    },
    { key: 'level', header: t('hr.ibNegLevel'), kind: 'number', hideSm: true, value: (m) => m.depth },
    { key: 'deposits', header: t('hr.ibNegDeposits'), kind: 'money', hideSm: true, value: (m) => toNumber(m.deposits), subtotal: false },
    { key: 'withdrawals', header: t('hr.ibNegWithdrawals'), kind: 'money', hideSm: true, value: (m) => toNumber(m.withdrawals), subtotal: false },
    { key: 'net', header: t('hr.ibNegNet'), kind: 'money', money: { tone: 'sign' }, value: (m) => toNumber(m.net), subtotal: false },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* ── Perfil completo del IB ─────────────────────────────────────── */}
        <section className="space-y-1.5">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3">{t('hr.ibNegProfile')}</h3>
          {prof ? (
            <dl className="space-y-1 text-[12.5px]">
              <DetailItem label={t('common.email')} value={prof.email} />
              <DetailItem label={t('hr.ibNegUsername')} value={prof.username} />
              <DetailItem label={t('hr.ibNegPhone')} value={[prof.phone_country_code, prof.phone_raw].filter(Boolean).join(' ') || null} />
              <DetailItem label={t('hr.ibNegCountry')} value={prof.country} />
              <DetailItem label={t('hr.ibNegKyc')} value={prof.kyc_status} />
              <DetailItem label={t('hr.ibNegRank')} value={prof.rank} />
              <DetailItem label={t('hr.ibNegStatus')} value={prof.status} />
              <DetailItem label={t('hr.ibNegRegistered')} value={prof.register_date ? String(prof.register_date).slice(0, 10) : null} />
              <DetailItem label={t('hr.ibNegSponsor')} value={prof.sponsor_username ?? prof.sponsor_email} />
              <DetailItem label={t('hr.ibNegProgram')} value={prof.ib_program_name} />
            </dl>
          ) : (
            // El IB dejó de estar en el espejo del CRM. La negociación sigue
            // existiendo (por eso no hay FK): se dice, no se oculta.
            <p className="text-[12.5px] text-text-3">{t('hr.ibNegProfileGone')}</p>
          )}
        </section>

        {/* ── El trato ───────────────────────────────────────────────────── */}
        <section className="space-y-1.5">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3">{t('hr.ibNegDeal')}</h3>
          <dl className="space-y-1 text-[12.5px]">
            <DetailItem label={t('hr.ibNegDealType')} value={t(DEAL_LABEL_KEY[neg.deal_type])} />
            <DetailItem label={t('hr.ibNegPct')} value={neg.pct == null ? null : `${toNumber(neg.pct)}%`} />
            <DetailItem
              label={t('hr.ibNegTarget')}
              value={neg.target_amount == null ? null : moneyText(toNumber(neg.target_amount))}
            />
            <DetailItem label={t('hr.ibNegFrom')} value={neg.starts_on} />
            <DetailItem label={t('hr.ibNegTo')} value={neg.ends_on} />
            <DetailItem label={t('hr.ibNegTerms')} value={neg.terms} />
            <DetailItem label={t('hr.ibNegNotes')} value={neg.notes} />
            <DetailItem label={t('hr.ibNegCreatedBy')} value={neg.created_by_name} />
          </dl>
        </section>

        {/* ── Producción del mes ─────────────────────────────────────────── */}
        <section className="space-y-1.5">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3">{t('hr.ibNegProduction')}</h3>
          <dl className="space-y-1 text-[12.5px]">
            <DetailItem label={t('hr.prodLots')} value={formatNumber(p.lots)} />
            <DetailItem label={t('hr.ibNegPaid')} value={moneyText(p.commission)} />
            <DetailItem label={t('hr.prodRewards')} value={formatNumber(p.rewards).replace(/\.00$/, '')} />
            <DetailItem label={t('hr.prodPnl')} value={moneyText(p.pnl)} />
            <div className="flex gap-2">
              <dt className="min-w-[92px] text-text-3">{t('hr.prodForex')}</dt>
              <dd><Maybe v={p.forexLots} /></dd>
            </div>
            <div className="flex gap-2">
              <dt className="min-w-[92px] text-text-3">{t('hr.prodSynthetic')}</dt>
              <dd><Maybe v={p.syntheticLots} /></dd>
            </div>
          </dl>
          <p className="pt-1 text-[12px] text-text-3">{t('hr.ibNegPnlHint')}</p>
        </section>
      </div>

      {/* ── La red que movió plata este mes ──────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3">{t('hr.ibNegNetwork')}</h3>
          {pkg.network && (
            <span className="text-[12px] text-text-3">
              {t('hr.ibNegNetworkSummary')
                .replace('{size}', String(pkg.network.size))
                .replace('{depth}', String(pkg.network.depth))
                .replace('{movers}', String(pkg.network.movers))}
            </span>
          )}
        </div>
        {membersError ? (
          <Notice kind="bad" title={t('hr.warningError')} />
        ) : loadingMembers ? (
          <p className="text-[12.5px] text-text-3">{t('common.loading')}</p>
        ) : !members || members.length === 0 ? (
          <p className="text-[12.5px] text-text-3">{t('hr.ibNegNetworkEmpty')}</p>
        ) : (
          <div className="overflow-hidden rounded-ui-md border border-border">
            <FinTable
              columns={memberColumns}
              rows={members}
              rowKey={(m) => m.user_external_id}
              caption={t('hr.ibNegNetwork')}
            />
            <p className="border-t border-border px-4 py-2 text-[12px] text-text-3">{t('hr.ibNegNetworkTopHint')}</p>
          </div>
        )}
      </section>
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2">
      <dt className="min-w-[92px] shrink-0 text-text-3">{label}</dt>
      <dd className="break-all text-foreground">{value || <span className="text-text-3">—</span>}</dd>
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
    <Panel
      title={t('hr.ibNegNew')}
      hint={t('hr.ibNegSearchHint')}
      actions={
        <button type="button" onClick={onCancel} className={ROW_ACTION_CLASS} aria-label={t('common.cancel')}>
          <X aria-hidden className="size-4" />
        </button>
      }
      footer={
        picked ? (
          <span className="flex flex-wrap items-center gap-2">
            <ActionButton variant="primary" onClick={save} loading={saving}>
              {t('common.save')}
            </ActionButton>
            <ActionButton variant="ghost" onClick={onCancel}>
              {t('common.cancel')}
            </ActionButton>
          </span>
        ) : undefined
      }
    >
      {!picked ? (
        <div className="space-y-2">
          <SearchField value={q} onChange={setQ} placeholder={t('hr.ibNegSearchPlaceholder')} className="max-w-none" />
          {searching && <p className="text-[12.5px] text-text-3">{t('common.loading')}</p>}
          {results.length > 0 && (
            <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-ui-md border border-border">
              {results.map((r) => (
                <li key={r.user_external_id}>
                  <button
                    type="button"
                    onClick={() => setPicked(r)}
                    className="w-full px-3 py-2 text-left text-[13px] hover:bg-row-hover"
                  >
                    <span className="font-medium text-foreground">{r.username ?? r.email}</span>
                    <span className="ml-2 text-[12px] text-text-3">{r.email}</span>
                    {r.country && <span className="ml-2 text-[12px] text-text-3">· {r.country}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-ui-md border border-border bg-surface-2 px-3 py-2">
            <div className="min-w-0 text-[13px]">
              <p className="font-medium text-foreground">
                {[picked.first_name, picked.last_name].filter(Boolean).join(' ') || picked.username}
              </p>
              <p className="truncate text-[12px] text-text-3">{picked.username} · {picked.email}</p>
            </div>
            <ActionButton variant="ghost" onClick={() => setPicked(null)}>
              {t('common.cancel')}
            </ActionButton>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('hr.ibNegDealType')}>
              <Select value={dealType} onChange={(e) => setDealType(e.target.value as IbDealType)}>
                {IB_DEAL_TYPES.map((d) => (
                  <option key={d} value={d}>{t(DEAL_LABEL_KEY[d])}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('hr.ibNegPct')}>
              <Input
                type="number" min="0" max="100" step="0.01"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                className="text-right tabular-nums"
              />
            </Field>
            <Field label={t('hr.ibNegTarget')}>
              <Input
                type="number" min="0" step="0.01"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="text-right tabular-nums"
              />
            </Field>
            <Field label={t('hr.ibNegFrom')}>
              <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
            </Field>
          </div>

          <Field label={t('hr.ibNegTerms')}>
            <Textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={2}
              placeholder={t('hr.ibNegTermsPlaceholder')}
            />
          </Field>

          <Field label={t('hr.ibNegNotes')}>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </Field>
        </div>
      )}
    </Panel>
  );
}
