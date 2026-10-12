'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /risk/retiros/[id] — ficha de un retiro.
//
// El orden de la pantalla es el de la pregunta que hay que contestar:
//   1. qué se está pidiendo (monto, método, antigüedad),
//   2. quién lo pide (perfil, registro, país),
//   3. de dónde salió ese dinero y qué hizo con él (los dos historiales),
//   4. qué dice el modelo y POR QUÉ (cada factor con su peso),
//   5. lo que se ve pero no puntúa, dicho con todas las letras,
//   6. la decisión, que es humana.
//
// La separación 4/5 es deliberada. KYC, la deuda de comisiones y la dirección
// compartida son las tres señales que cualquiera esperaría que pesaran, y las
// tres se midieron y NO predicen (la compartida hasta rechaza menos: son
// exchanges, no colusión). Ocultarlas haría que alguien las volviera a
// "descubrir" cada seis meses; mostrarlas marcadas como no-puntúan cierra esa
// discusión con el dato a la vista.
//
// El historial se pinta entero, pero sólo lo ANTERIOR a la solicitud entró al
// score — eso va marcado fila por fila, porque juzgar con datos que aún no
// existían es la forma más fácil de engañarse.
//
// ── «LIBRO MAYOR» (2026-10-12) ──────────────────────────────────────────────
// Sólo presentación; score, permisos y el POST de la decisión no cambiaron.
//   · Cabecera con el monto grande (<Money>, null → «—», ya no $0.00) y el
//     badge de banda desde risk-kinds.ts.
//   · Los factores del score son una lista con SEVERIDAD (StatusBadge: empuja
//     a rechazar = bad, a aprobar = ok, neutro) y un resumen arriba.
//   · La línea de tiempo de `withdrawal_review_events` va con el punto del
//     color de la decisión (escalar = pend, aprobar = ok, rechazar = bad), la
//     misma receta que Órdenes de pago.
//   · UN solo primario (spec §5.1), elegido por lo que el ROL puede hacer y
//     nunca por el score (queue-view.ts → primaryDecision).
//   · El riesgo de cuentas, sus señales y la toxicidad usan los mismos kinds
//     (antes tres ternarios `bg-negative/10 …` inline, y `?` en gris para «sin
//     comprobar» acá pero en ámbar en prop firm: ahora es `pend` en los dos).
//   · Historiales con FinTable; el estado lleva color desde status_norm.
//
// DESCARTADO:
//   · Mover la decisión arriba de todo: el orden 1-6 es el argumento de la
//     pantalla (decidir después de haber visto). Queda en un panel propio al
//     final, con el historial de decisiones al lado.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, ShieldAlert, Minus, CheckCircle2, XCircle, ArrowUpCircle, RefreshCw } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { StatusBadge, STATUS_BADGE_CLASSES, type StatusKind } from '@/components/ui/status-badge';
import { Notice } from '@/components/ui/notice';
import { Field, Textarea } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToasts } from '@/components/ui/toast';
import { ActionButton, actionButtonClass, type ActionVariant } from '@/components/ui/action-button';
import { WalletAddress } from '@/components/risk/wallet-address';
import {
  bandKind,
  checkKind,
  decisionKind,
  depositStatusKind,
  factorKind,
  levelKind,
  withdrawalStatusKind,
} from '@/components/risk/risk-kinds';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { roleCanApproveWithdrawal, roleCanTriageWithdrawal } from '@/lib/roles';
import { useData } from '@/lib/data-context';
import { cn } from '@/lib/utils';
import { MONEY_LOCALE, formatMoney } from '@/lib/money';
import { formatDate, formatDateTime } from '@/lib/dates';
import {
  loadDetail,
  saveDecision,
  type WithdrawalDetail,
  type CalibrationInfo,
  type Decision,
} from '@/lib/withdrawal-risk/api';
import type { AccountsOverview } from '@/lib/risk/account-review-read';
import { displayCurrency, factorTally, primaryDecision, type DetailDecision } from '../queue-view';

/** Rechazar y escalar exigen motivo (el servidor también lo exige). */
const NEEDS_NOTE: Decision[] = ['reject', 'escalate'];

const countFmt = new Intl.NumberFormat(MONEY_LOCALE, { maximumFractionDigits: 0 });
const lotsFmt = new Intl.NumberFormat(MONEY_LOCALE, { maximumFractionDigits: 2 });

type DepositHist = WithdrawalDetail['depositHistory'][number];
type WithdrawalHist = WithdrawalDetail['withdrawalHistory'][number];

export default function RetiroDetallePage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const hasRiskAccess = useModuleAccess('risk');
  // Dos permisos distintos, no uno: soporte triajea y escala, el auditor
  // aprueba. Un botón que el servidor va a rechazar con 403 no se dibuja
  // habilitado.
  const role = user?.effective_role ?? '';
  const canApprove = roleCanApproveWithdrawal(role);
  const canTriage = roleCanTriageWithdrawal(role);
  const { company } = useData();
  const { toast, ToastHost } = useToasts();

  const [detail, setDetail] = useState<WithdrawalDetail | null>(null);
  // Señal APARTE del score: el diagnóstico operativo de las cuentas del
  // cliente. Nunca modifica `detail.score` — se muestra al lado.
  const [accounts, setAccounts] = useState<AccountsOverview | null>(null);
  const [calibration, setCalibration] = useState<CalibrationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  /** El botón que pide el diagnóstico de cuentas en el momento. */
  const [analizando, setAnalizando] = useState(false);

  useEffect(() => {
    if (user === null) return;
    if (!hasRiskAccess) router.replace('/');
  }, [user, hasRiskAccess, router]);
  const accessDenied = user !== null && !hasRiskAccess;

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await loadDetail(decodeURIComponent(id));
      setDetail(res.detail);
      setAccounts(res.accounts ?? null);
      setCalibration(res.calibration);
      setNotes(res.detail.review?.notes ?? '');
    } catch (err: unknown) {
      setDetail(null);
      setAccounts(null);
      toast.error(err instanceof Error ? err.message : t('wdReview.loadError'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Pedir el diagnóstico AHORA ──────────────────────────────────────────
  // El cron rota ~1.000 cuentas y no llega: medido el 2026-08-31, cada corrida
  // alcanza entre 7 y 80 contra un techo de 200. Un cliente nuevo esperaba
  // hasta hora y media, o sea que para un retiro pendiente el diagnóstico
  // llegaba DESPUÉS de la decisión.
  //
  // Acá se paga la espera una vez, a propósito y a la vista.
  const analizarCuentas = useCallback(async () => {
    if (!id || analizando) return;
    setAnalizando(true);
    try {
      const res = await apiFetch(
        `/api/admin/withdrawal-review/${encodeURIComponent(decodeURIComponent(id))}/analizar-cuentas`,
        { method: 'POST', timeoutMs: 120_000 },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      if (json.reviewed === 0) {
        toast.error(
          json.candidates === 0
            ? 'El cliente no tiene cuentas de trading reales para analizar.'
            : 'No se pudo analizar ninguna cuenta. Probá de nuevo en un momento.',
        );
      } else {
        toast.success(`${json.reviewed} cuenta(s) analizadas.`);
      }
      // Se recarga la ficha entera: el diagnóstico llega por el mismo endpoint
      // que el resto, y así no hay dos caminos para el mismo dato.
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo analizar');
    } finally {
      setAnalizando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, analizando, load]);

  useEffect(() => {
    if (!accessDenied) void load();
  }, [accessDenied, load]);

  const tally = useMemo(() => (detail ? factorTally(detail.score.factors) : null), [detail]);

  async function confirmDecision() {
    if (!pending || !detail) return;
    setBusy(true);
    try {
      const res = await saveDecision(detail.withdrawal.external_id, {
        decision: pending,
        notes: notes.trim() || null,
      });
      toast.success(res.message);
      setPending(null);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('wdReview.saveError'));
    } finally {
      setBusy(false);
    }
  }

  if (accessDenied) return null;

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-72" />
        <Skeleton className="h-[92px]" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-4">
        {ToastHost}
        <EmptyState
          icon={ShieldAlert}
          title={t('wdReview.notFound')}
          description={t('wdReview.notFoundHint')}
          action={
            <Link href="/risk/retiros" className={actionButtonClass('secondary')}>
              {t('wdReview.backToQueue')}
            </Link>
          }
        />
      </div>
    );
  }

  const w = detail.withdrawal;
  const f = detail.features;
  const s = detail.score;
  const companyCurrency = company?.currency || 'USD';
  const currency = displayCurrency(w.coin, companyCurrency);
  const moneyText = (n: number | null | undefined, cur = companyCurrency) =>
    typeof n === 'number' && Number.isFinite(n) ? formatMoney(n, { currency: cur }) : '—';

  // ── Botones de decisión: un solo primario, elegido por el rol ──────────
  const primary = primaryDecision(canApprove, canTriage);
  const variantFor = (d: DetailDecision, fallback: ActionVariant): ActionVariant =>
    d === primary ? 'primary' : fallback;

  const kpis: KpiItem[] = [
    {
      key: 'deposited',
      label: t('wdReview.depositedBefore'),
      value: f.depositedBefore,
      format: 'money',
      currency: companyCurrency,
      sub: t('wdReview.movementsCount', { count: String(f.depositCountBefore) }),
    },
    {
      key: 'net',
      label: t('wdReview.netBefore'),
      value: f.netBefore,
      format: 'money',
      currency: companyCurrency,
      // El signo ES la noticia: negativo = ya sacó más de lo que puso.
      tone: 'sign',
      sub: t('wdReview.withdrawnBefore', { amount: moneyText(f.withdrawnBefore) }),
    },
    {
      key: 'rejections',
      label: t('wdReview.priorRejections'),
      value: f.rejectedCountBefore,
      format: 'count',
      sub: t('riskLm.priorRejectionsHint'),
    },
  ];

  const depositCols: FinColumn<DepositHist>[] = [
    {
      key: 'date',
      header: t('wdReview.colDate'),
      cell: (d) => <span className={NUM_CLASS}>{d.deposit_at ? formatDate(d.deposit_at) : '—'}</span>,
      meta: (d) => d.paymentMethod,
      mobileMeta: (d) => <CountedBadge counted={d.beforeRequest} />,
    },
    {
      key: 'amount',
      header: t('wdReview.colAmount'),
      kind: 'money',
      value: (d) => d.amount_paid,
      money: { currency: companyCurrency },
    },
    {
      key: 'status',
      header: t('wdReview.colStatus'),
      hideSm: true,
      cell: (d) => <StatusBadge kind={depositStatusKind(d.status_norm)} label={d.status_raw ?? d.status_norm} />,
    },
    {
      key: 'counted',
      header: t('wdReview.colCounted'),
      hideSm: true,
      cell: (d) => <CountedBadge counted={d.beforeRequest} />,
    },
  ];

  const withdrawalCols: FinColumn<WithdrawalHist>[] = [
    {
      key: 'date',
      header: t('wdReview.colDate'),
      cell: (h) => <span className={NUM_CLASS}>{h.requested_at ? formatDate(h.requested_at) : '—'}</span>,
      meta: (h) => h.paymentMethod,
      mobileMeta: (h) => <CountedBadge counted={h.beforeRequest} />,
    },
    {
      key: 'amount',
      header: t('wdReview.colAmount'),
      kind: 'money',
      value: (h) => h.requested_amount,
      money: { currency: companyCurrency },
    },
    {
      key: 'status',
      header: t('wdReview.colStatus'),
      hideSm: true,
      cell: (h) => (
        <StatusBadge kind={withdrawalStatusKind(h.status_norm)} label={h.status_raw ?? h.status_norm} />
      ),
    },
    {
      key: 'counted',
      header: t('wdReview.colCounted'),
      hideSm: true,
      cell: (h) => <CountedBadge counted={h.beforeRequest} />,
    },
  ];

  const needsNote = pending !== null && NEEDS_NOTE.includes(pending) && !notes.trim();

  return (
    <div className="space-y-4">
      {ToastHost}

      <Link
        href="/risk/retiros"
        className="inline-flex items-center gap-1.5 text-[13px] text-text-2 hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t('wdReview.backToQueue')}
      </Link>

      {/* ── 1. Qué se pide: la cabecera ─────────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="truncate text-[20px] font-[650] leading-7 tracking-[-0.015em] text-foreground sm:text-[22px]">
              {w.username ?? t('wdReview.noUser')}
            </h1>
            <StatusBadge
              kind={bandKind(s.band)}
              label={t('wdReview.scoreBadge', { score: String(s.approvalScore), band: t(`wdReview.band.${s.band}`) })}
            />
            {detail.review?.decision && (
              <StatusBadge
                kind={decisionKind(detail.review.decision)}
                label={t(`wdReview.decision.${detail.review.decision}`)}
              />
            )}
          </div>
          <p className="mt-0.5 text-[13.5px] text-text-2">
            {t('wdReview.detailSubtitle', { id: w.external_id, date: formatDateTime(w.requested_at) })}
          </p>
          <Money
            value={w.requested_amount}
            currency={currency}
            nullLabel={t('ui.noData')}
            className="mt-2 block text-[24px] font-semibold leading-[30px] tracking-[-0.02em] text-foreground sm:text-[26px]"
          />
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-text-2">
            <span>{detail.paymentMethod || '—'}</span>
            {w.network && <span className="text-text-3">{w.network}</span>}
            <WalletAddress address={w.target_address} />
            <StatusBadge kind={withdrawalStatusKind(w.status_norm)} label={w.status_raw ?? w.status_norm} />
          </div>
        </div>
      </div>

      <Notice kind="info" title={t('riskLm.disclaimerTitle')}>
        {t('wdReview.disclaimer')}
      </Notice>

      <KpiStrip items={kpis} />

      {/* ── 2. Quién lo pide ─────────────────────────────────────────────── */}
      <Panel title={t('wdReview.clientTitle')}>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ReadField label={t('wdReview.email')} value={w.email ?? '—'} />
          <ReadField label={t('wdReview.country')} value={detail.user?.country ?? '—'} />
          <ReadField
            label={t('wdReview.registered')}
            value={
              detail.user?.register_date
                ? f.accountAgeDays !== null
                  ? `${formatDate(detail.user.register_date)} · ${t('wdReview.ageDays', {
                      days: String(Math.floor(f.accountAgeDays)),
                    })}`
                  : formatDate(detail.user.register_date)
                : '—'
            }
          />
          <ReadField label={t('wdReview.sponsor')} value={detail.user?.sponsor_username ?? '—'} />
          <ReadField
            label={t('wdReview.priorRejections')}
            value={String(f.rejectedCountBefore)}
            tone={f.rejectedCountBefore > 0 ? 'bad' : undefined}
          />
          <ReadField
            label={t('wdReview.ratio')}
            value={f.ratio === null ? t('wdReview.noDeposits') : `${f.ratio.toFixed(2)}×`}
          />
          <ReadField label={t('wdReview.status')} value={detail.user?.status ?? '—'} />
          <ReadField label={t('wdReview.rank')} value={detail.user?.rank ?? '—'} />
        </dl>
      </Panel>

      {/* ── 4. Qué dice el modelo, señal por señal, con su severidad ─────── */}
      <Panel
        title={t('wdReview.scoreTitle')}
        hint={
          tally
            ? t('riskLm.factorTally', {
                down: String(tally.down),
                up: String(tally.up),
                neutral: String(tally.neutral),
              })
            : undefined
        }
        footer={
          calibration
            ? t('wdReview.calibrationFooter', {
                window: calibration.window,
                n: String(calibration.n),
                base: (calibration.baseRejectionRate * 100).toFixed(2),
              })
            : undefined
        }
        flush
      >
        <ul className="divide-y divide-border">
          {s.factors.map((factor) => (
            <li key={factor.code} className="flex items-start gap-3 px-4 py-3">
              <StatusBadge
                kind={factorKind(factor.impact)}
                label={t(`riskLm.impact.${factor.impact}`)}
                className="mt-px w-[104px] shrink-0 justify-start"
              />
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">{factor.label}</p>
                <p className="text-[12.5px] text-text-2">{factor.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      {/* ── Trading: contexto medido, no score ───────────────────────────── */}
      {detail.trading && (
        <Panel title={t('wdReview.tradingTitle')} hint={t('wdReview.tradingHint')}>
          {detail.trading.noMt5Account ? (
            <p className="text-[13px] text-foreground">{t('wdReview.tradingNoAccount')}</p>
          ) : (
            <>
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <ReadField label={t('wdReview.tradingAccounts')} value={countFmt.format(detail.trading.accounts)} num />
                <ReadField
                  label={t('wdReview.tradingDeals')}
                  value={countFmt.format(detail.trading.dealsCount)}
                  tone={detail.trading.dealsCount === 0 ? 'bad' : undefined}
                  num
                />
                <ReadField
                  label={t('wdReview.tradingFirst')}
                  value={detail.trading.firstDealAt ? formatDate(detail.trading.firstDealAt) : '—'}
                />
                <ReadField
                  label={t('wdReview.tradingLast')}
                  value={detail.trading.lastDealAt ? formatDate(detail.trading.lastDealAt) : '—'}
                />
              </dl>
              {detail.trading.tradedBeforeRequest === false && detail.trading.dealsCount > 0 && (
                <p className="mt-3 text-[13px] font-medium text-pend">{t('wdReview.tradingAfterRequest')}</p>
              )}
              {detail.trading.demoAccounts > 0 && (
                <p className="mt-2 text-[12.5px] text-text-3">
                  {t('wdReview.tradingDemoExcluded', { count: String(detail.trading.demoAccounts) })}
                </p>
              )}
            </>
          )}
        </Panel>
      )}

      {/* ── Diagnóstico operativo por cuenta ─────────────────────────────── */}
      {/* Señal APARTE del score, no una corrección de él: el score está
          calibrado sobre 9.785 retiros resueltos y estas señales todavía no se
          midieron contra ninguna decisión. Por eso van en su propio panel y
          con su propio vocabulario. */}
      {/* El panel se dibuja SIEMPRE que el server mandó el diagnóstico, tenga
          o no cuentas. Antes sólo aparecía si ya estaba calculado, así que su
          ausencia se leía como «este cliente no tiene nada raro» cuando en
          realidad era «todavía no se miró». Son cosas distintas. */}
      {accounts && (
        <Panel
          title="Operativa de las cuentas del cliente"
          hint="Señales para mirar con las reglas de prop firm. No son infracciones y no afectan el score de arriba."
          actions={
            <>
              {accounts.accounts.length > 0 && (
                <StatusBadge
                  kind={levelKind(accounts.risk)}
                  label={accounts.risk === 'alto' ? 'Riesgo alto' : accounts.risk === 'medio' ? 'Riesgo medio' : 'Sin señales'}
                />
              )}
              <ActionButton onClick={() => void analizarCuentas()} disabled={analizando}>
                <RefreshCw className={cn('size-4', analizando && 'animate-spin')} aria-hidden />
                {analizando
                  ? 'Analizando…'
                  : accounts.accounts.length > 0
                    ? 'Volver a analizar'
                    : 'Analizar ahora'}
              </ActionButton>
            </>
          }
          footer={
            accounts.oldestComputedAt
              ? `Diagnóstico calculado el ${formatDate(accounts.oldestComputedAt)}. Se recalcula solo cada 30 minutos.`
              : undefined
          }
        >
          {/* Sin diagnóstico todavía: se dice por qué y qué hacer, en vez de
              mostrar un panel vacío. */}
          {accounts.accounts.length === 0 ? (
            <p className="text-[13px] text-text-2">
              Todavía no se analizaron las cuentas de este cliente. <strong>Analizar ahora</strong> lo calcula en el
              momento — tarda unos segundos porque consulta MT5 directo.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-text-2">
                <span>
                  <strong className={cn(NUM_CLASS, 'text-foreground')}>{accounts.accounts.length}</strong> cuenta(s)
                </span>
                <span>
                  <strong className={cn(NUM_CLASS, 'text-foreground')}>{accounts.totalFlagged}</strong> señal(es)
                  disparadas
                </span>
                {accounts.highRiskAccounts > 0 && (
                  <span className="text-neg">
                    <strong className={NUM_CLASS}>{accounts.highRiskAccounts}</strong> cuenta(s) en riesgo alto
                  </span>
                )}
                {accounts.tradedAfterRequestCount > 0 && (
                  <span className="text-pend">
                    <strong className={NUM_CLASS}>{accounts.tradedAfterRequestCount}</strong> operó después de solicitar
                    el retiro
                  </span>
                )}
              </div>

              <div className="mt-3 space-y-3">
                {accounts.accounts.map((a) => (
                  <section key={a.login} className="rounded-ui-md border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn(NUM_CLASS, 'font-mono text-[12px] font-medium text-foreground')}>
                        {a.login}
                      </span>
                      <span className="rounded-ui-sm border border-border-strong px-1.5 text-[11.5px] font-semibold uppercase text-text-2">
                        {a.accountType === 'SOCIAL' ? 'social' : 'trading'}
                      </span>
                      {a.groupName && <span className="text-[12px] text-text-3">{a.groupName}</span>}
                      <StatusBadge kind={levelKind(a.risk)} label={`${a.flagged} señal(es)`} className="ml-auto" />
                    </div>

                    {/* La operativa: qué hace esta cuenta */}
                    <dl className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                      <ReadField label="Operaciones" value={countFmt.format(a.positions)} num />
                      <ReadField
                        label="Total de lotes"
                        value={a.lotsTotal === null ? '—' : lotsFmt.format(a.lotsTotal)}
                        num
                      />
                      <ReadField
                        label="PnL neto"
                        value={a.netResult === null ? '—' : formatMoney(a.netResult)}
                        tone={a.netResult !== null && a.netResult < 0 ? 'bad' : undefined}
                        num
                      />
                      <ReadField
                        label="Duración media"
                        value={a.avgDurationSec === null ? '—' : `${Math.round(a.avgDurationSec / 60)} min`}
                        num
                      />
                      <ReadField
                        label="Menos de 1 min"
                        value={a.positions > 0 ? `${((a.under1min / a.positions) * 100).toFixed(0)}%` : '—'}
                        num
                      />
                      <ReadField
                        label="Caída máxima"
                        value={a.maxDrawdown === null ? '—' : formatMoney(a.maxDrawdown)}
                        num
                      />
                    </dl>

                    {/* ── Reparto por duración ────────────────────────────
                        La lectura que separa «hace scalping» de «GANA con el
                        scalping», que son cosas distintas: el conteo dice cómo
                        opera y el dinero dice de dónde sale el resultado. Se
                        muestran las dos cifras juntas por eso. */}
                    {a.durations.some((d) => d.count > 0) && (
                      <DurationBars durations={a.durations} />
                    )}

                    {a.topSymbols.length > 0 && (
                      <p className="mt-2 text-[12.5px] text-text-3">
                        Símbolos: {a.topSymbols.map((x) => `${x.symbol} (${x.positions})`).join(' · ')}
                      </p>
                    )}

                    {/* Operar después de pedir el retiro: lo más objetivo que hay */}
                    {a.tradedAfterRequest === true && (
                      <p className="mt-2 text-[13px] font-medium text-pend">
                        Abrió operaciones DESPUÉS de solicitar el retiro
                        {a.lastTradeAt ? ` (última: ${formatDate(a.lastTradeAt)})` : ''}.
                      </p>
                    )}

                    {/* ── Señales de riesgo vs. perfil operativo ──────────────
                        Separadas porque miden cosas distintas. Las de riesgo son
                        las que discriminan (se disparan en el 10-23% de las
                        cuentas); las del perfil describen a un trader retail
                        normal — se disparan en el 73-94% y por eso no alarman. */}
                    {a.signals.some((x) => x.countsForRisk) && (
                      <SignalList
                        title="Señales de riesgo"
                        items={a.signals
                          .filter((x) => x.countsForRisk)
                          .map((x) => ({
                            key: x.id,
                            kind: checkKind(x.status),
                            badge: t(`riskLm.signal.${x.status}`),
                            label: x.label,
                            detail: x.whyNot ? `${x.detail} — ${x.whyNot}` : x.detail,
                          }))}
                      />
                    )}

                    {a.signals.some((x) => !x.countsForRisk) && (
                      <div className="mt-3">
                        <p className="text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3">
                          Perfil operativo{' '}
                          <span className="font-normal normal-case tracking-normal">— describe cómo opera, no alarma</span>
                        </p>
                        <ul className="mt-1 space-y-1 text-[13px] text-text-2">
                          {a.signals
                            .filter((x) => !x.countsForRisk)
                            .map((x) => (
                              <li key={x.id} className="flex gap-2">
                                <span aria-hidden>{x.status === 'fail' ? '•' : '·'}</span>
                                <span className="flex-1">
                                  {x.label}
                                  <span className="block text-[12px] text-text-3">{x.detail}</span>
                                </span>
                              </li>
                            ))}
                        </ul>
                      </div>
                    )}

                    {/* ── Toxicidad hacia el BRÓKER ─────────────────────────
                        Eje aparte del de arriba, y va al final a propósito: lo de
                        arriba dice cómo opera el cliente, esto dice cuánto le
                        cuesta la operativa a la casa. Son casi opuestos — una
                        cuenta con martingala es pésima para el cliente y buen
                        negocio para nosotros. Mezclarlos daría un número que no
                        significa nada. */}
                    {(a.toxicLevel || a.origen || a.ejecucion) && (
                      <div className="mt-4 border-t border-border pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3">
                            Costo para el bróker
                          </p>
                          {a.toxicLevel && (
                            <StatusBadge
                              kind={levelKind(a.toxicLevel)}
                              label={
                                a.toxicLevel === 'alto' ? 'Tóxica' : a.toxicLevel === 'medio' ? 'Revisar' : 'Sin indicios'
                              }
                            />
                          )}
                        </div>

                        {/* De dónde salieron las órdenes */}
                        {a.origen && a.origen.aperturas.length > 0 && (
                          <p className="mt-2 text-[12.5px] text-text-2">
                            <span className="font-medium text-foreground">Origen:</span>{' '}
                            {a.origen.aperturas.map((m) => `${m.label} ${m.pct}%`).join(' · ')}
                          </p>
                        )}
                        {a.origen && a.origen.cierres.length > 0 && (
                          <p className="mt-1 text-[12.5px] text-text-2">
                            <span className="font-medium text-foreground">Cierres:</span>{' '}
                            {a.origen.cierres.map((m) => `${m.label} ${m.pct}%`).join(' · ')}
                          </p>
                        )}

                        {/* El bot vive en el comentario: ExpertID viene en 0. */}
                        {a.origen && a.origen.bots.length > 0 && (
                          <p className="mt-1 text-[12.5px] text-text-2">
                            <span className="font-medium text-foreground">Robots detectados:</span>{' '}
                            {a.origen.bots.map((b) => `${b.name} (${b.count})`).join(' · ')}
                            {a.origen.botDisfrazado && (
                              <span className="ml-1 font-medium text-pend">
                                — el motivo dice manual pero opera un robot
                              </span>
                            )}
                          </p>
                        )}

                        {a.ejecucion && a.ejecucion.comparables > 0 && (
                          <p className="mt-1 text-[12.5px] text-text-2">
                            <span className="font-medium text-foreground">Ejecución:</span>{' '}
                            {a.ejecucion.enMercado} al precio de mercado ·{' '}
                            <span className={a.ejecucion.aFavor > 0 ? 'font-medium text-pend' : ''}>
                              {a.ejecucion.aFavor} a favor del cliente
                            </span>{' '}
                            · {a.ejecucion.enContra} en contra
                            {a.ejecucion.spreadMedio !== null && ` · spread medio ${a.ejecucion.spreadMedio}`}
                          </p>
                        )}

                        {/* `null` es «no se pudo comprobar», que NO es
                            «limpio»: va en `pend`, nunca en verde. */}
                        {a.toxicSignals.length > 0 && (
                          <SignalList
                            items={a.toxicSignals.map((x) => {
                              const st = x.hit === true ? 'fail' : x.hit === null ? 'unverifiable' : 'pass';
                              return {
                                key: x.key,
                                kind: checkKind(st),
                                badge: t(`riskLm.toxic.${st}`),
                                label: x.label,
                                detail: x.detail,
                              };
                            })}
                          />
                        )}
                      </div>
                    )}

                    {/* Un recorte silencioso es indistinguible de "opera poco" */}
                    {a.truncated && (
                      <p className="mt-2 text-[12.5px] font-medium text-pend">
                        Cuenta muy grande: se analizó una parte de su historial.
                      </p>
                    )}
                    {a.warnings.map((warning) => (
                      <p key={warning} className="mt-2 text-[12.5px] text-text-3">
                        {warning}
                      </p>
                    ))}
                  </section>
                ))}
              </div>
            </>
          )}
        </Panel>
      )}

      {/* ── 5. Lo que se ve y NO puntúa ──────────────────────────────────── */}
      <Panel title={t('wdReview.informativeTitle')} hint={t('wdReview.informativeHint')} flush>
        <ul className="divide-y divide-border">
          {detail.informative.map((n) => (
            <li key={n.code} className="flex items-start gap-3 px-4 py-3">
              <Minus className="mt-0.5 size-4 shrink-0 text-text-3" aria-hidden />
              <div className="min-w-0">
                <p className="text-[13px] text-foreground">
                  <span className="font-medium">{n.label}:</span> {n.value}
                </p>
                <p className="text-[12.5px] text-text-3">{n.note}</p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      {/* ── 3. De dónde vino el dinero y qué hizo con él ─────────────────── */}
      <div className="grid grid-cols-1 gap-4 min-[1100px]:grid-cols-2">
        <Panel title={t('wdReview.depositsTitle')} hint={t('wdReview.beforeRequestHint')} flush>
          <FinTable<DepositHist>
            caption={t('wdReview.depositsTitle')}
            columns={depositCols}
            rows={detail.depositHistory}
            rowKey={(d) => d.external_id}
            empty={t('wdReview.noDepositsTitle')}
            maxHeight={420}
          />
        </Panel>
        <Panel title={t('wdReview.withdrawalsTitle')} hint={t('wdReview.beforeRequestHint')} flush>
          <FinTable<WithdrawalHist>
            caption={t('wdReview.withdrawalsTitle')}
            columns={withdrawalCols}
            rows={detail.withdrawalHistory}
            rowKey={(h) => h.external_id}
            empty={t('wdReview.noWithdrawalsTitle')}
            maxHeight={420}
          />
        </Panel>
      </div>

      {/* ── 6. La decisión ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <Panel title={t('wdReview.decisionTitle')} className="lg:col-span-2">
          <Field label={t('wdReview.notesLabel')} hint={t('riskLm.notesHint')}>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              disabled={!canTriage}
              placeholder={t('wdReview.notesPlaceholder')}
              className="resize-y"
            />
          </Field>

          <div className="mt-4 flex flex-wrap gap-2">
            <ActionButton
              variant={canApprove ? variantFor('approve', 'secondary') : 'secondary'}
              disabled={!canApprove}
              title={canApprove ? undefined : t('wdReview.approveNeedsFinance')}
              onClick={() => setPending('approve')}
            >
              <CheckCircle2 className="size-4" aria-hidden />
              {t('wdReview.decision.approve')}
            </ActionButton>
            <ActionButton
              variant="danger"
              disabled={!canApprove}
              title={canApprove ? undefined : t('wdReview.approveNeedsFinance')}
              onClick={() => setPending('reject')}
            >
              <XCircle className="size-4" aria-hidden />
              {t('wdReview.decision.reject')}
            </ActionButton>
            <ActionButton
              variant={canTriage ? variantFor('escalate', 'secondary') : 'secondary'}
              disabled={!canTriage}
              title={canTriage ? undefined : t('wdReview.noPermission')}
              onClick={() => setPending('escalate')}
            >
              <ArrowUpCircle className="size-4" aria-hidden />
              {t('wdReview.decision.escalate')}
            </ActionButton>
          </div>

          {/* Los botones se muestran deshabilitados con el motivo en vez de
              desaparecer: que se vea que el control existe es parte del control.
              A soporte le decimos qué SÍ puede hacer, no sólo qué no. */}
          {!canApprove && canTriage && <p className="mt-2 text-[12.5px] text-text-3">{t('wdReview.triageOnly')}</p>}
          {!canTriage && <p className="mt-2 text-[12.5px] text-text-3">{t('wdReview.noPermission')}</p>}
        </Panel>

        {/* Historial completo, no sólo la última. Un caso normal son DOS
            hechos —soporte escala, el auditor aprueba— y el escalamiento es
            justamente la evidencia de que el control funcionó. */}
        <Panel title={t('riskLm.timelineTitle')} hint={t('riskLm.timelineHint')}>
          {detail.events.length === 0 ? (
            <p className="text-[13px] text-text-3">{t('riskLm.timelineEmpty')}</p>
          ) : (
            <ol>
              {detail.events.map((e, idx) => {
                const kind = decisionKind(e.decision);
                return (
                  <li
                    key={`${e.created_at}-${idx}`}
                    className="relative pb-4 pl-7 last:pb-0"
                    data-decision={e.decision}
                  >
                    {/* Punto con halo: el par texto/fondo del badge del mismo
                        kind — sin una segunda tabla de colores. */}
                    <span
                      aria-hidden
                      className={cn(
                        'absolute left-0 top-0.5 inline-flex size-4 items-center justify-center rounded-full',
                        STATUS_BADGE_CLASSES[kind],
                      )}
                    >
                      <span className="size-1.5 rounded-full bg-current" />
                    </span>
                    {idx < detail.events.length - 1 && (
                      <span aria-hidden className="absolute bottom-0 left-[7.5px] top-5 w-px bg-border" />
                    )}
                    <p className={cn('text-[13px] font-medium leading-5', kind === 'bad' ? 'text-neg' : 'text-foreground')}>
                      {t(`wdReview.decision.${e.decision}`)}
                      <span className="font-normal text-text-2">
                        {' · '}
                        {e.actor_name ?? '—'}
                        {e.actor_role ? ` (${e.actor_role})` : ''}
                      </span>
                    </p>
                    <p className={cn(NUM_CLASS, 'text-[12px] text-text-3')}>
                      {formatDateTime(e.created_at)}
                      {e.score !== null ? ` · ${t('wdReview.scoreThen', { score: String(e.score) })}` : ''}
                    </p>
                    {e.notes && <p className="mt-0.5 break-words text-[12.5px] text-text-2">{e.notes}</p>}
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>
      </div>

      {pending && (
        <ConfirmDialog
          tone={pending === 'reject' ? 'danger' : 'default'}
          title={t(`wdReview.decision.${pending}`)}
          message={
            needsNote
              ? t('wdReview.noteRequired')
              : t('wdReview.confirmMessage', {
                  decision: t(`wdReview.decision.${pending}`),
                  amount: moneyText(w.requested_amount, currency),
                  user: w.username ?? t('wdReview.noUser'),
                })
          }
          confirmLabel={t('wdReview.confirmLabel')}
          onConfirm={needsNote ? () => setPending(null) : confirmDecision}
          onClose={() => {
            if (!busy) setPending(null);
          }}
        />
      )}
    </div>
  );
}

// ── Piezas de presentación ──────────────────────────────────────────────────

function ReadField({
  label,
  value,
  tone,
  num,
}: {
  label: string;
  value: string;
  tone?: 'bad';
  num?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium text-text-3">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 truncate text-[13px] font-medium',
          tone === 'bad' ? 'text-neg' : 'text-foreground',
          num && NUM_CLASS,
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** «Puntuó» (entró al score: anterior a la solicitud) o «Posterior». */
function CountedBadge({ counted }: { counted: boolean }) {
  const { t } = useI18n();
  return counted ? (
    <StatusBadge kind="neutral" label={t('wdReview.counted')} />
  ) : (
    <span className="text-[12px] text-text-3">{t('wdReview.notCounted')}</span>
  );
}

interface SignalItem {
  key: string;
  kind: StatusKind;
  badge: string;
  label: string;
  detail: string;
}

/** Lista de señales con severidad: badge a la izquierda, texto y detalle. */
function SignalList({ title, items }: { title?: string; items: SignalItem[] }) {
  return (
    <div className="mt-3">
      {title && <p className="text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3">{title}</p>}
      <ul className="mt-1 space-y-1.5">
        {items.map((x) => (
          <li key={x.key} className="flex items-start gap-2.5">
            <StatusBadge kind={x.kind} label={x.badge} className="mt-px w-[112px] shrink-0 justify-start" />
            <span className="min-w-0 flex-1 text-[13px]">
              <span className={x.kind === 'bad' ? 'font-medium text-foreground' : 'text-text-2'}>{x.label}</span>
              <span className="block text-[12px] text-text-3">{x.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Reparto por duración: conteo + resultado + barra de participación (pista
 * `surface-sunk`, relleno `brand-ink` al 75 %, spec §5.3). Antes la barra era
 * `--color-secondary` (un color de marca sin significado) y el resultado se
 * pintaba verde en TODO lo no negativo, incluido el cero.
 */
function DurationBars({ durations }: { durations: { label: string; count: number; profit: number }[] }) {
  const maxCount = Math.max(...durations.map((d) => d.count), 1);
  return (
    <div className="mt-3">
      <p className="text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3">Duración de las operaciones</p>
      <ul className="mt-1.5 space-y-1">
        {durations.map((d) => (
          <li key={d.label} className="flex items-baseline gap-2 text-[13px]">
            <span className="w-20 shrink-0 text-text-2">{d.label}</span>
            <span className={cn(NUM_CLASS, 'w-12 shrink-0 text-right')}>{countFmt.format(d.count)}</span>
            <Money value={d.profit} tone="sign" className="w-28 shrink-0 text-right text-[12.5px]" />
            <span className="h-1.5 flex-1 self-center overflow-hidden rounded-full bg-surface-sunk">
              <span
                className="block h-full rounded-full bg-brand-ink/75"
                style={{ width: `${(d.count / maxCount) * 100}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
