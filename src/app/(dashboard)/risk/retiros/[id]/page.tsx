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
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ShieldAlert,
  Info,
  TrendingDown,
  TrendingUp,
  Minus,
  CheckCircle2,
  XCircle,
  ArrowUpCircle,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToasts } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { roleCanApproveWithdrawal, roleCanTriageWithdrawal } from '@/lib/roles';
import { useData } from '@/lib/data-context';
import { cn, formatCurrency } from '@/lib/utils';
import { formatDate, formatDateTime } from '@/lib/dates';
import {
  loadDetail,
  saveDecision,
  type WithdrawalDetail,
  type CalibrationInfo,
  type Decision,
  type RiskBand,
} from '@/lib/withdrawal-risk/api';
import type { AccountsOverview } from '@/lib/risk/account-review-read';

const BAND_VARIANT: Record<RiskBand, 'success' | 'warning' | 'danger'> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};

/** Rechazar y escalar exigen motivo (el servidor también lo exige). */
const NEEDS_NOTE: Decision[] = ['reject', 'escalate'];

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

  useEffect(() => {
    if (!accessDenied) void load();
  }, [accessDenied, load]);

  const money = (n: number, currency?: string) =>
    formatCurrency(n, (currency === 'USDT' ? 'USD' : currency) || company?.currency || 'USD');

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
      <div className="space-y-6">
        <Skeleton className="h-12 w-64" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-6">
        {ToastHost}
        <EmptyState
          icon={ShieldAlert}
          title={t('wdReview.notFound')}
          description={t('wdReview.notFoundHint')}
          action={
            <Link href="/risk/retiros">
              <Button variant="secondary">{t('wdReview.backToQueue')}</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const w = detail.withdrawal;
  const f = detail.features;
  const s = detail.score;
  const currency = w.coin ?? undefined;

  return (
    <div className="space-y-6">
      {ToastHost}

      <Link
        href="/risk/retiros"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t('wdReview.backToQueue')}
      </Link>

      <PageHeader
        icon={ShieldAlert}
        title={w.username ?? t('wdReview.noUser')}
        subtitle={t('wdReview.detailSubtitle', {
          id: w.external_id,
          date: formatDateTime(w.requested_at),
        })}
        actions={
          <Badge variant={BAND_VARIANT[s.band]}>
            {t('wdReview.scoreBadge', { score: String(s.approvalScore), band: t(`wdReview.band.${s.band}`) })}
          </Badge>
        }
      />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-info/10 px-4 py-3 text-sm">
        <Info className="h-4 w-4 shrink-0 mt-0.5 text-info" aria-hidden />
        <p className="text-muted-foreground">{t('wdReview.disclaimer')}</p>
      </div>

      {/* ── 1. Qué se pide ───────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          emphasis
          label={t('wdReview.requestedAmount')}
          value={money(w.requested_amount ?? 0, currency)}
          hint={detail.paymentMethod}
        />
        <StatCard
          label={t('wdReview.depositedBefore')}
          value={money(f.depositedBefore)}
          hint={t('wdReview.movementsCount', { count: String(f.depositCountBefore) })}
        />
        <StatCard
          label={t('wdReview.netBefore')}
          tone={f.netBefore < 0 ? 'negative' : 'positive'}
          value={money(f.netBefore)}
          hint={t('wdReview.withdrawnBefore', { amount: money(f.withdrawnBefore) })}
        />
      </div>

      {/* ── 2. Quién lo pide ─────────────────────────────────────────────── */}
      <Card>
        <CardTitle>{t('wdReview.clientTitle')}</CardTitle>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('wdReview.email')} value={w.email ?? '—'} />
          <Field label={t('wdReview.country')} value={detail.user?.country ?? '—'} />
          <Field
            label={t('wdReview.registered')}
            value={
              detail.user?.register_date
                ? `${formatDate(detail.user.register_date)} · ${t('wdReview.ageDays', {
                    days: String(Math.floor(f.accountAgeDays ?? 0)),
                  })}`
                : '—'
            }
          />
          <Field label={t('wdReview.sponsor')} value={detail.user?.sponsor_username ?? '—'} />
          <Field
            label={t('wdReview.priorRejections')}
            value={String(f.rejectedCountBefore)}
            tone={f.rejectedCountBefore > 0 ? 'negative' : undefined}
          />
          <Field
            label={t('wdReview.ratio')}
            value={f.ratio === null ? t('wdReview.noDeposits') : `${f.ratio.toFixed(2)}×`}
          />
          <Field label={t('wdReview.status')} value={detail.user?.status ?? '—'} />
          <Field label={t('wdReview.rank')} value={detail.user?.rank ?? '—'} />
        </dl>
      </Card>

      {/* ── 4. Qué dice el modelo, factor por factor ─────────────────────── */}
      <Card>
        <CardTitle>{t('wdReview.scoreTitle')}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          {calibration
            ? t('wdReview.calibrationFooter', {
                window: calibration.window,
                n: String(calibration.n),
                base: (calibration.baseRejectionRate * 100).toFixed(2),
              })
            : ''}
        </p>
        <ul className="mt-4 space-y-3">
          {s.factors.map((factor) => (
            <li key={factor.code} className="flex items-start gap-3">
              <FactorIcon impact={factor.impact} />
              <div className="min-w-0">
                <p className="text-sm font-medium">{factor.label}</p>
                <p className="text-xs text-muted-foreground">{factor.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {/* ── Trading: contexto medido, no score ───────────────────────────── */}
      {detail.trading && (
        <Card>
          <CardTitle>{t('wdReview.tradingTitle')}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{t('wdReview.tradingHint')}</p>
          {detail.trading.noMt5Account ? (
            <p className="mt-3 text-sm">{t('wdReview.tradingNoAccount')}</p>
          ) : (
            <>
              <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <Field label={t('wdReview.tradingAccounts')} value={String(detail.trading.accounts)} />
                <Field
                  label={t('wdReview.tradingDeals')}
                  value={detail.trading.dealsCount.toLocaleString('es')}
                  tone={detail.trading.dealsCount === 0 ? 'negative' : undefined}
                />
                <Field
                  label={t('wdReview.tradingFirst')}
                  value={detail.trading.firstDealAt ? formatDate(detail.trading.firstDealAt) : '—'}
                />
                <Field
                  label={t('wdReview.tradingLast')}
                  value={detail.trading.lastDealAt ? formatDate(detail.trading.lastDealAt) : '—'}
                />
              </dl>
              {detail.trading.tradedBeforeRequest === false && detail.trading.dealsCount > 0 && (
                <p className="mt-3 text-sm text-warning">{t('wdReview.tradingAfterRequest')}</p>
              )}
              {detail.trading.demoAccounts > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('wdReview.tradingDemoExcluded', { count: String(detail.trading.demoAccounts) })}
                </p>
              )}
            </>
          )}
        </Card>
      )}

      {/* ── Diagnóstico operativo por cuenta ─────────────────────────────── */}
      {/* Señal APARTE del score, no una corrección de él: el score está
          calibrado sobre 9.785 retiros resueltos y estas señales todavía no se
          midieron contra ninguna decisión. Por eso van en su propia tarjeta y
          con su propio vocabulario. */}
      {accounts && accounts.accounts.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Operativa de las cuentas del cliente</CardTitle>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                accounts.risk === 'alto'
                  ? 'bg-negative/10 text-negative'
                  : accounts.risk === 'medio'
                    ? 'bg-warning/10 text-warning'
                    : 'bg-positive/10 text-positive'
              }`}
            >
              {accounts.risk === 'alto' ? 'RIESGO ALTO' : accounts.risk === 'medio' ? 'RIESGO MEDIO' : 'SIN SEÑALES'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Cómo opera cada cuenta de trading y social del cliente, con las mismas reglas que la
            revisión de prop firm. No son infracciones —una cuenta normal no tiene reglamento— sino
            señales para mirar. <strong>No afectan el score de arriba.</strong>
          </p>

          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            <span><strong>{accounts.accounts.length}</strong> cuenta(s)</span>
            <span><strong>{accounts.totalFlagged}</strong> señal(es) disparadas</span>
            {accounts.highRiskAccounts > 0 && (
              <span className="text-negative">
                <strong>{accounts.highRiskAccounts}</strong> cuenta(s) en riesgo alto
              </span>
            )}
            {accounts.tradedAfterRequestCount > 0 && (
              <span className="text-warning">
                <strong>{accounts.tradedAfterRequestCount}</strong> operó después de solicitar el retiro
              </span>
            )}
          </div>

          <div className="mt-4 space-y-3">
            {accounts.accounts.map((a) => (
              <div key={a.login} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium tabular-nums">{a.login}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {a.accountType === 'SOCIAL' ? 'social' : 'trading'}
                  </span>
                  {a.groupName && (
                    <span className="text-xs text-muted-foreground">{a.groupName}</span>
                  )}
                  <span
                    className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      a.risk === 'alto'
                        ? 'bg-negative/10 text-negative'
                        : a.risk === 'medio'
                          ? 'bg-warning/10 text-warning'
                          : 'bg-positive/10 text-positive'
                    }`}
                  >
                    {a.flagged} señal(es)
                  </span>
                </div>

                {/* La operativa: qué hace esta cuenta */}
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
                  <Field label="Operaciones" value={a.positions.toLocaleString('es')} />
                  <Field
                    label="Total de lotes"
                    value={a.lotsTotal === null ? '—' : a.lotsTotal.toLocaleString('es', { maximumFractionDigits: 2 })}
                  />
                  <Field
                    label="PnL neto"
                    value={a.netResult === null ? '—' : formatCurrency(a.netResult)}
                    tone={a.netResult !== null && a.netResult < 0 ? 'negative' : undefined}
                  />
                  <Field
                    label="Duración media"
                    value={a.avgDurationSec === null ? '—' : `${Math.round(a.avgDurationSec / 60)} min`}
                  />
                  <Field
                    label="Menos de 1 min"
                    value={a.positions > 0 ? `${((a.under1min / a.positions) * 100).toFixed(0)}%` : '—'}
                  />
                  <Field
                    label="Caída máxima"
                    value={a.maxDrawdown === null ? '—' : formatCurrency(a.maxDrawdown)}
                  />
                </dl>

                {/* ── Reparto por duración ────────────────────────────────
                    La lectura que separa «hace scalping» de «GANA con el
                    scalping», que son cosas distintas: el conteo dice cómo
                    opera y el dinero dice de dónde sale el resultado. Se
                    muestran las dos cifras juntas por eso. */}
                {a.durations.some((d) => d.count > 0) && (() => {
                  const maxCount = Math.max(...a.durations.map((d) => d.count), 1);
                  return (
                    <div className="mt-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Duración de las operaciones
                      </p>
                      <ul className="mt-1.5 space-y-1">
                        {a.durations.map((d) => (
                          <li key={d.label} className="text-sm">
                            <div className="flex items-baseline gap-2">
                              <span className="w-20 shrink-0 text-muted-foreground">{d.label}</span>
                              <span className="w-12 shrink-0 text-right tabular-nums">{d.count}</span>
                              <span
                                className={`w-24 shrink-0 text-right tabular-nums text-xs ${
                                  d.profit < 0 ? 'text-negative' : 'text-positive'
                                }`}
                              >
                                {formatCurrency(d.profit)}
                              </span>
                              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                                <span
                                  className="block h-full rounded-full bg-[var(--color-secondary)]"
                                  style={{ width: `${(d.count / maxCount) * 100}%` }}
                                />
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}

                {a.topSymbols.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Símbolos: {a.topSymbols.map((s) => `${s.symbol} (${s.positions})`).join(' · ')}
                  </p>
                )}

                {/* Operar después de pedir el retiro: lo más objetivo que hay */}
                {a.tradedAfterRequest === true && (
                  <p className="mt-2 text-sm text-warning">
                    Abrió operaciones DESPUÉS de solicitar el retiro
                    {a.lastTradeAt ? ` (última: ${formatDate(a.lastTradeAt)})` : ''}.
                  </p>
                )}

                {/* ── Señales de riesgo vs. perfil operativo ──────────────
                    Separadas porque miden cosas distintas. Las de riesgo son
                    las que discriminan (se disparan en el 10-23% de las
                    cuentas); las del perfil describen a un trader retail
                    normal — se disparan en el 73-94% y por eso no alarman. */}
                {a.signals.some((s) => s.countsForRisk) && (
                  <div className="mt-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Señales de riesgo
                    </p>
                    <ul className="mt-1 space-y-1 text-sm">
                      {a.signals.filter((s) => s.countsForRisk).map((s) => (
                        <li key={s.id} className="flex gap-2">
                          <span
                            className={
                              s.status === 'fail'
                                ? 'text-negative'
                                : s.status === 'unverifiable'
                                  ? 'text-muted-foreground'
                                  : 'text-positive'
                            }
                          >
                            {s.status === 'fail' ? '✕' : s.status === 'unverifiable' ? '?' : '✓'}
                          </span>
                          <span className="flex-1">
                            <span className={s.status === 'fail' ? 'font-medium' : ''}>{s.label}</span>
                            <span className="block text-xs text-muted-foreground">
                              {s.detail}
                              {s.whyNot ? ` — ${s.whyNot}` : ''}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {a.signals.some((s) => !s.countsForRisk) && (
                  <div className="mt-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Perfil operativo{' '}
                      <span className="font-normal normal-case">— describe cómo opera, no alarma</span>
                    </p>
                    <ul className="mt-1 space-y-1 text-sm">
                      {a.signals.filter((s) => !s.countsForRisk).map((s) => (
                        <li key={s.id} className="flex gap-2 text-muted-foreground">
                          <span>{s.status === 'fail' ? '•' : '·'}</span>
                          <span className="flex-1">
                            {s.label}
                            <span className="block text-xs">{s.detail}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Un recorte silencioso es indistinguible de "opera poco" */}
                {a.truncated && (
                  <p className="mt-2 text-xs text-warning">
                    Cuenta muy grande: se analizó una parte de su historial.
                  </p>
                )}
                {a.warnings.map((w) => (
                  <p key={w} className="mt-2 text-xs text-muted-foreground">{w}</p>
                ))}
              </div>
            ))}
          </div>

          {accounts.oldestComputedAt && (
            <p className="mt-3 text-xs text-muted-foreground">
              Diagnóstico calculado el {formatDate(accounts.oldestComputedAt)}. Se recalcula solo cada 30 minutos.
            </p>
          )}
        </Card>
      )}

      {/* ── 5. Lo que se ve y NO puntúa ──────────────────────────────────── */}
      <Card>
        <CardTitle>{t('wdReview.informativeTitle')}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('wdReview.informativeHint')}</p>
        <ul className="mt-4 space-y-3">
          {detail.informative.map((n) => (
            <li key={n.code} className="flex items-start gap-3">
              <Minus className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm">
                  <span className="font-medium">{n.label}:</span> {n.value}
                </p>
                <p className="text-xs text-muted-foreground">{n.note}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {/* ── 3. De dónde vino el dinero y qué hizo con él ─────────────────── */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 pt-4">
          <CardTitle>{t('wdReview.depositsTitle')}</CardTitle>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('wdReview.beforeRequestHint')}</p>
        </div>
        <DataTable
          zebra
          density="compact"
          data={detail.depositHistory}
          empty={<EmptyState compact title={t('wdReview.noDepositsTitle')} />}
          columns={[
            { header: t('wdReview.colDate'), accessor: (d) => formatDate(d.deposit_at) },
            {
              header: t('wdReview.colAmount'),
              align: 'right',
              accessor: (d) => (
                <span className="font-semibold tabular-nums">{money(d.amount_paid ?? 0)}</span>
              ),
            },
            { header: t('wdReview.colMethod'), accessor: (d) => d.paymentMethod },
            { header: t('wdReview.colStatus'), accessor: (d) => d.status_raw ?? '—' },
            {
              header: t('wdReview.colCounted'),
              accessor: (d) =>
                d.beforeRequest ? (
                  <Badge variant="neutral">{t('wdReview.counted')}</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">{t('wdReview.notCounted')}</span>
                ),
            },
          ]}
        />
      </Card>

      <Card className="p-0 overflow-hidden">
        <div className="px-4 pt-4">
          <CardTitle>{t('wdReview.withdrawalsTitle')}</CardTitle>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('wdReview.beforeRequestHint')}</p>
        </div>
        <DataTable
          zebra
          density="compact"
          data={detail.withdrawalHistory}
          empty={<EmptyState compact title={t('wdReview.noWithdrawalsTitle')} />}
          columns={[
            { header: t('wdReview.colDate'), accessor: (h) => formatDate(h.requested_at) },
            {
              header: t('wdReview.colAmount'),
              align: 'right',
              accessor: (h) => (
                <span className="font-semibold tabular-nums">{money(h.requested_amount ?? 0)}</span>
              ),
            },
            { header: t('wdReview.colMethod'), accessor: (h) => h.paymentMethod },
            { header: t('wdReview.colStatus'), accessor: (h) => h.status_raw ?? '—' },
            {
              header: t('wdReview.colCounted'),
              accessor: (h) =>
                h.beforeRequest ? (
                  <Badge variant="neutral">{t('wdReview.counted')}</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">{t('wdReview.notCounted')}</span>
                ),
            },
          ]}
        />
      </Card>

      {/* ── 6. La decisión ───────────────────────────────────────────────── */}
      <Card>
        <CardTitle>{t('wdReview.decisionTitle')}</CardTitle>

        {/* Historial completo, no sólo la última. Un caso normal son DOS
            hechos —soporte escala, el auditor aprueba— y el escalamiento es
            justamente la evidencia de que el control funcionó. */}
        {detail.events.length > 0 && (
          <ol className="mt-3 space-y-3 border-l border-border pl-4">
            {detail.events.map((e, idx) => (
              <li key={`${e.created_at}-${idx}`} className="relative">
                <span
                  className={cn(
                    'absolute -left-[21px] top-1.5 h-2 w-2 rounded-full',
                    idx === 0 ? 'bg-primary' : 'bg-border',
                  )}
                  aria-hidden
                />
                <p className="text-sm">
                  <span className="font-medium">{t(`wdReview.decision.${e.decision}`)}</span>
                  {' · '}
                  {e.actor_name ?? '—'}
                  {e.actor_role ? ` (${e.actor_role})` : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(e.created_at)}
                  {e.score !== null ? ` · ${t('wdReview.scoreThen', { score: String(e.score) })}` : ''}
                </p>
                {e.notes && <p className="mt-0.5 text-xs">{e.notes}</p>}
              </li>
            ))}
          </ol>
        )}

        <label className="mt-4 block text-sm font-medium" htmlFor="wd-notes">
          {t('wdReview.notesLabel')}
        </label>
        <textarea
          id="wd-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          disabled={!canTriage}
          placeholder={t('wdReview.notesPlaceholder')}
          className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm disabled:opacity-60"
        />

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!canApprove}
            title={canApprove ? undefined : t('wdReview.approveNeedsFinance')}
            onClick={() => setPending('approve')}
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {t('wdReview.decision.approve')}
          </Button>
          <Button
            variant="destructive"
            disabled={!canApprove}
            title={canApprove ? undefined : t('wdReview.approveNeedsFinance')}
            onClick={() => setPending('reject')}
          >
            <XCircle className="h-4 w-4" aria-hidden />
            {t('wdReview.decision.reject')}
          </Button>
          <Button
            variant="secondary"
            disabled={!canTriage}
            title={canTriage ? undefined : t('wdReview.noPermission')}
            onClick={() => setPending('escalate')}
          >
            <ArrowUpCircle className="h-4 w-4" aria-hidden />
            {t('wdReview.decision.escalate')}
          </Button>
        </div>

        {/* Los botones se muestran deshabilitados con el motivo en vez de
            desaparecer: que se vea que el control existe es parte del control.
            A soporte le decimos qué SÍ puede hacer, no sólo qué no. */}
        {!canApprove && canTriage && (
          <p className="mt-2 text-xs text-muted-foreground">{t('wdReview.triageOnly')}</p>
        )}
        {!canTriage && <p className="mt-2 text-xs text-muted-foreground">{t('wdReview.noPermission')}</p>}
      </Card>

      {pending && (
        <ConfirmDialog
          tone={pending === 'reject' ? 'danger' : 'default'}
          title={t(`wdReview.decision.${pending}`)}
          message={
            NEEDS_NOTE.includes(pending) && !notes.trim()
              ? t('wdReview.noteRequired')
              : t('wdReview.confirmMessage', {
                  decision: t(`wdReview.decision.${pending}`),
                  amount: money(w.requested_amount ?? 0, currency),
                  user: w.username ?? t('wdReview.noUser'),
                })
          }
          confirmLabel={t('wdReview.confirmLabel')}
          onConfirm={
            NEEDS_NOTE.includes(pending) && !notes.trim()
              ? () => setPending(null)
              : confirmDecision
          }
          onClose={() => {
            if (!busy) setPending(null);
          }}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'negative';
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 font-medium', tone === 'negative' && 'text-negative')}>{value}</dd>
    </div>
  );
}

function FactorIcon({ impact }: { impact: 'up' | 'down' | 'neutral' }) {
  if (impact === 'down') {
    return <TrendingDown className="h-4 w-4 shrink-0 mt-0.5 text-negative" aria-hidden />;
  }
  if (impact === 'up') {
    return <TrendingUp className="h-4 w-4 shrink-0 mt-0.5 text-positive" aria-hidden />;
  }
  return <Minus className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />;
}
