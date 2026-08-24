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
import { roleCanWriteFinance } from '@/lib/roles';
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
  const canAct = roleCanWriteFinance(user?.effective_role ?? '');
  const { company } = useData();
  const { toast, ToastHost } = useToasts();

  const [detail, setDetail] = useState<WithdrawalDetail | null>(null);
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
      setCalibration(res.calibration);
      setNotes(res.detail.review?.notes ?? '');
    } catch (err: unknown) {
      setDetail(null);
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

        {detail.review?.decision && (
          <p className="mt-2 text-sm text-muted-foreground">
            {t('wdReview.lastDecision', {
              decision: t(`wdReview.decision.${detail.review.decision}`),
              who: detail.review.decided_by_name ?? '—',
              when: formatDateTime(detail.review.decided_at),
            })}
          </p>
        )}

        <label className="mt-4 block text-sm font-medium" htmlFor="wd-notes">
          {t('wdReview.notesLabel')}
        </label>
        <textarea
          id="wd-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          disabled={!canAct}
          placeholder={t('wdReview.notesPlaceholder')}
          className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm disabled:opacity-60"
        />

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!canAct}
            title={canAct ? undefined : t('wdReview.noPermission')}
            onClick={() => setPending('approve')}
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {t('wdReview.decision.approve')}
          </Button>
          <Button
            variant="destructive"
            disabled={!canAct}
            title={canAct ? undefined : t('wdReview.noPermission')}
            onClick={() => setPending('reject')}
          >
            <XCircle className="h-4 w-4" aria-hidden />
            {t('wdReview.decision.reject')}
          </Button>
          <Button
            variant="secondary"
            disabled={!canAct}
            title={canAct ? undefined : t('wdReview.noPermission')}
            onClick={() => setPending('escalate')}
          >
            <ArrowUpCircle className="h-4 w-4" aria-hidden />
            {t('wdReview.decision.escalate')}
          </Button>
        </div>

        {/* El botón se muestra deshabilitado con el motivo en vez de
            desaparecer: que se vea que el control existe es parte del control. */}
        {!canAct && <p className="mt-2 text-xs text-muted-foreground">{t('wdReview.noPermission')}</p>}
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
