'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Conciliación de liquidez — /liquidez/conciliacion
//
// De 35 movimientos, 19 no tenían ninguna cuenta MT y 8 traían varias juntas
// en un campo de texto ("141103, 142156, 141661, …"). La migración 062 creó el
// catálogo de cuentas y ató lo que se podía atar solo; el resto necesita que
// una persona diga a qué cuenta va cada peso, porque ese dato no existe en
// ningún registro.
//
// Esta pantalla es ese trabajo: lista lo pendiente y deja resolverlo de a uno.
// Mientras haya pendientes, un desglose por cuenta mostraría la mayor parte
// del dinero en un cajón de "sin asignar" — por eso primero se concilia.
//
// Dividir no puede crear ni perder plata: las partes tienen que sumar exacto
// el importe original. Se valida en la pantalla (para avisar mientras se
// escribe), en el endpoint y en la RPC.
//
// ── «LIBRO MAYOR» (2026-10-12) ─────────────────────────────────────────────
// Sólo presentación. Lo pendiente pasa de una tarjeta por movimiento a una
// FinTable (fecha, cuentas del texto original, importe, estado, atribuir). Al
// dividir, el cuadre es una tabla de DOS COLUMNAS COMPARADAS — original (A)
// contra suma de las partes (B) — con la diferencia en `neg` y un `Notice`
// que dice cuánto falta o sobra. Antes era una línea de texto verde/roja
// («Partes: … — original: …») que había que leer cifra por cifra.
// La comparación vive en `splitCheck` (liquidity-view.ts, con test).
//
// DESCARTADO: abrir la división en un modal. Mientras se divide hay que ver
// el texto original («141103, 142156…») que dice qué cuentas son: en un modal
// se tapaba. Va en un panel arriba de la lista.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Scale, Split, Check, Plus } from 'lucide-react';
import { useAuth, canAdd } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Field, Input, Select } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { useToasts } from '@/components/ui/toast';
import { ActionButton, actionButtonClass } from '@/components/payment-orders/action-button';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/money';
import { splitCheck, type SplitCheck } from '../liquidity-view';

interface Account { id: string; mt_number: string; label: string | null; is_active: boolean }
interface Pending {
  id: string; date: string; mt_account: string | null;
  deposit: number; withdrawal: number; notes: string | null; needs_split: boolean;
}
interface SplitPart { account_id: string; deposit: string; withdrawal: string }

/** Fila de la tabla de cuadre: original (A) vs partes (B). */
interface CompareRow { key: 'dep' | 'wit'; label: string; original: number; parts: number; diff: number }

export default function LiquidityReconcilePage() {
  const { user } = useAuth();
  const accessDenied = !useModuleAccess('liquidity');
  const canWrite = canAdd(user);
  const { toast, ToastHost } = useToasts();
  const { t } = useI18n();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Cuenta elegida para atribución simple, por movimiento. */
  const [choice, setChoice] = useState<Record<string, string>>({});
  /** Movimiento que se está dividiendo, con sus partes. */
  const [splitting, setSplitting] = useState<string | null>(null);
  const [parts, setParts] = useState<SplitPart[]>([]);
  const [newAccount, setNewAccount] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/liquidity-reconcile');
      const json = await res.json();
      if (json.success) {
        setAccounts(json.accounts ?? []);
        setPending(json.pending ?? []);
      } else {
        toast.error(json.error ?? t('reconcile.loadError'));
      }
    } catch {
      toast.error(t('reconcile.loadError'));
    } finally {
      setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => {
    const sinCuenta = pending.filter((p) => !p.needs_split);
    const aDividir = pending.filter((p) => p.needs_split);
    const monto = pending.reduce((s, p) => s + p.deposit - p.withdrawal, 0);
    return { sinCuenta: sinCuenta.length, aDividir: aDividir.length, monto };
  }, [pending]);

  const post = async (payload: Record<string, unknown>, okMsg: string) => {
    const res = await apiFetch('/api/admin/liquidity-reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (json.success) {
      toast.success(okMsg);
      await load();
      return true;
    }
    toast.error(json.error ?? t('reconcile.saveError'));
    return false;
  };

  const assign = async (mov: Pending) => {
    const account_id = choice[mov.id];
    if (!account_id) { toast.error(t('reconcile.chooseAccountError')); return; }
    setBusyId(mov.id);
    await post({ action: 'assign', id: mov.id, account_id }, t('reconcile.assigned'));
    setBusyId(null);
  };

  // Al abrir la división se precargan las cuentas que venían en el texto
  // original — es el dato que ya tenemos; lo que falta es el importe de cada una.
  const beginSplit = (mov: Pending) => {
    const nums = (mov.mt_account ?? '').split(',').map((n) => n.trim()).filter(Boolean);
    const unique = [...new Set(nums)];
    const preset = unique
      .map((n) => accounts.find((a) => a.mt_number === n))
      .filter((a): a is Account => !!a)
      .map((a) => ({ account_id: a.id, deposit: '', withdrawal: '' }));
    setParts(preset.length >= 2 ? preset : [
      { account_id: '', deposit: '', withdrawal: '' },
      { account_id: '', deposit: '', withdrawal: '' },
    ]);
    setSplitting(mov.id);
  };

  const cancelSplit = () => { setSplitting(null); setParts([]); };

  const confirmSplit = async (mov: Pending) => {
    const { ok } = splitCheck(parts, mov);
    if (!ok) { toast.error(t('reconcile.sumMismatch')); return; }
    if (parts.some((p) => !p.account_id)) { toast.error(t('reconcile.missingAccount')); return; }
    setBusyId(mov.id);
    const done = await post({
      action: 'split',
      id: mov.id,
      parts: parts.map((p) => ({
        account_id: p.account_id,
        deposit: Number(p.deposit) || 0,
        withdrawal: Number(p.withdrawal) || 0,
      })),
    }, t('reconcile.splitDone'));
    if (done) cancelSplit();
    setBusyId(null);
  };

  const createAccount = async () => {
    const num = newAccount.trim();
    if (!num) return;
    const res = await apiFetch('/api/admin/liquidity-reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_account', mt_number: num }),
    });
    const json = await res.json();
    if (json.success) { setNewAccount(''); toast.success(t('reconcile.accountAdded', { number: num })); await load(); }
    else toast.error(json.error ?? t('reconcile.accountCreateError'));
  };

  if (accessDenied) {
    return <EmptyState icon={Scale} title={t('reconcile.accessDeniedTitle')} description={t('reconcile.accessDeniedDesc')} />;
  }

  const splittingMov = splitting ? pending.find((p) => p.id === splitting) ?? null : null;

  const kpis: KpiItem[] = [
    {
      key: 'amount',
      label: t('reconcile.statPendingAmount'),
      value: loading ? null : totals.monto,
      hero: true,
      sub: loading ? undefined : t('reconcile.lm.pendingCount', { count: String(pending.length) }),
      missingBadge: loading ? { kind: 'stale', label: t('common.loading') } : false,
    },
    {
      key: 'noAccount',
      label: t('reconcile.statNoAccount'),
      value: loading ? null : totals.sinCuenta,
      format: 'count',
      missingBadge: false,
    },
    {
      key: 'toSplit',
      label: t('reconcile.statToSplit'),
      value: loading ? null : totals.aDividir,
      format: 'count',
      missingBadge: false,
    },
    {
      key: 'catalog',
      label: t('reconcile.lm.catalog'),
      value: loading ? null : accounts.length,
      format: 'count',
      missingBadge: false,
    },
  ];

  const accountOptions = accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {a.mt_number}{a.label ? ` · ${a.label}` : ''}
    </option>
  ));

  const pendingColumns: FinColumn<Pending>[] = [
    {
      key: 'date',
      header: t('reconcile.lm.colDate'),
      cell: (m) => <span className={NUM_CLASS}>{m.date}</span>,
      meta: (m) => m.notes ?? undefined,
      mobileMeta: (m) => <PendingBadge mov={m} t={t} />,
    },
    {
      key: 'original',
      header: t('reconcile.lm.colOriginal'),
      // El texto crudo del registro: es lo único que dice a qué cuentas iba.
      cell: (m) => (m.mt_account
        ? <span className={cn(NUM_CLASS, 'block max-w-[240px] truncate text-text-2')} title={m.mt_account}>{m.mt_account}</span>
        : <span className="text-text-3">—</span>),
      hideSm: true,
    },
    {
      key: 'amount',
      header: t('reconcile.lm.colAmount'),
      kind: 'money',
      value: (m) => m.deposit - m.withdrawal,
      money: { signed: true, tone: 'neutral' },
    },
    {
      key: 'status',
      header: t('reconcile.lm.colStatus'),
      cell: (m) => <PendingBadge mov={m} t={t} />,
      hideSm: true,
    },
    ...(canWrite
      ? [{
          key: 'attribute',
          header: t('reconcile.lm.colAttribute'),
          cardSide: 'left' as const,
          cell: (m: Pending) => (
            <div className="flex flex-wrap items-center gap-2 py-1.5 max-[720px]:mt-2">
              <Select
                aria-label={t('reconcile.lm.accountFor', { date: m.date })}
                className="h-8 w-48 [@media(pointer:coarse)]:h-10"
                value={choice[m.id] ?? ''}
                onChange={(e) => setChoice((c) => ({ ...c, [m.id]: e.target.value }))}
                disabled={splitting === m.id}
              >
                <option value="">{t('reconcile.chooseAccount')}</option>
                {accountOptions}
              </Select>
              <ActionButton loading={busyId === m.id && splitting !== m.id} onClick={() => assign(m)} disabled={splitting === m.id}>
                <Check aria-hidden className="size-4" /> {t('reconcile.assign')}
              </ActionButton>
              <ActionButton variant="ghost" onClick={() => beginSplit(m)} disabled={splitting === m.id}>
                <Split aria-hidden className="size-4" /> {t('reconcile.split')}
              </ActionButton>
            </div>
          ),
        } satisfies FinColumn<Pending>]
      : []),
  ];

  return (
    <div className="space-y-4">
      {ToastHost}

      <PageHeader
        title={t('reconcile.title')}
        subtitle={t('reconcile.subtitle')}
        icon={Scale}
        actions={
          <Link href="/liquidez" className={actionButtonClass('ghost')}>
            <ArrowLeft aria-hidden className="size-4" /> {t('reconcile.backToLiquidity')}
          </Link>
        }
      />

      <KpiStrip items={kpis} />

      {splittingMov && (
        <SplitPanel
          mov={splittingMov}
          parts={parts}
          setParts={setParts}
          accounts={accounts}
          busy={busyId === splittingMov.id}
          onCancel={cancelSplit}
          onConfirm={() => confirmSplit(splittingMov)}
          t={t}
        />
      )}

      {loading ? (
        <Skeleton className="h-60" />
      ) : pending.length === 0 ? (
        <EmptyState
          icon={Check}
          title={t('reconcile.allDoneTitle')}
          description={t('reconcile.allDoneDesc')}
        />
      ) : (
        <Panel title={t('reconcile.lm.pendingTitle')} hint={t('reconcile.lm.pendingHint')} flush>
          <FinTable
            caption={t('reconcile.lm.pendingTitle')}
            columns={pendingColumns}
            rows={pending}
            rowKey={(m) => m.id}
            selectedKey={splitting}
            footer={{
              label: t('reconcile.lm.pendingTotal', { count: String(pending.length) }),
              values: { amount: totals.monto },
            }}
          />
        </Panel>
      )}

      {/* Alta rápida de cuenta: si un movimiento pertenece a una cuenta que no
          está en el catálogo, se puede crear sin salir de acá. */}
      {canWrite && (
        <Panel title={t('reconcile.addAccountLabel')} hint={t('reconcile.accountsInCatalog', { count: String(accounts.length) })}>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => { e.preventDefault(); void createAccount(); }}
          >
            <Field label={t('reconcile.lm.accountNumber')} className="w-full sm:w-56">
              <Input
                value={newAccount}
                inputMode="numeric"
                placeholder={t('reconcile.accountNumberPlaceholder')}
                onChange={(e) => setNewAccount(e.target.value)}
              />
            </Field>
            <ActionButton type="submit" disabled={!newAccount.trim()}>
              <Plus aria-hidden className="size-4" /> {t('common.add')}
            </ActionButton>
          </form>
        </Panel>
      )}
    </div>
  );
}

type T = (k: string, p?: Record<string, string>) => string;

function PendingBadge({ mov, t }: { mov: Pending; t: T }) {
  // Las dos situaciones piden una acción: `pend`.
  return mov.needs_split
    ? <StatusBadge kind="pend" label={t('reconcile.multipleAccounts')} />
    : <StatusBadge kind="pend" label={t('reconcile.lm.noAccount')} />;
}

function SplitPanel({
  mov, parts, setParts, accounts, busy, onCancel, onConfirm, t,
}: {
  mov: Pending;
  parts: SplitPart[];
  setParts: React.Dispatch<React.SetStateAction<SplitPart[]>>;
  accounts: Account[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  t: T;
}) {
  const st: SplitCheck = splitCheck(parts, mov);
  const rows: CompareRow[] = [
    { key: 'dep', label: t('reconcile.deposit'), original: mov.deposit, parts: st.dep, diff: st.diffDep },
    { key: 'wit', label: t('reconcile.withdrawal'), original: mov.withdrawal, parts: st.wit, diff: st.diffWit },
  ];
  const cols: FinColumn<CompareRow>[] = [
    { key: 'label', header: t('reconcile.lm.colConcept'), cell: (r) => r.label },
    { key: 'original', header: t('reconcile.lm.colOriginalA'), kind: 'money', value: (r) => r.original, subtotal: false },
    { key: 'parts', header: t('reconcile.lm.colPartsB'), kind: 'money', value: (r) => r.parts, subtotal: false },
    {
      key: 'diff',
      header: t('reconcile.lm.colDiff'),
      kind: 'money',
      value: (r) => r.diff,
      // La diferencia es la noticia: si no es cero va en `neg`, sea por falta
      // o por sobra. En cero, gris.
      cell: (r) => (
        <Money value={r.diff} signed tone={Math.abs(r.diff) >= 0.01 ? 'neg' : 'neutral'} className="font-medium" />
      ),
      subtotal: false,
    },
  ];
  const update = (i: number, patch: Partial<SplitPart>) =>
    setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const mismatchTitle = [
    Math.abs(st.diffDep) >= 0.01 ? diffText(t('reconcile.deposit'), st.diffDep, t) : null,
    Math.abs(st.diffWit) >= 0.01 ? diffText(t('reconcile.withdrawal'), st.diffWit, t) : null,
  ].filter(Boolean).join(' · ');

  return (
    <Panel
      title={t('reconcile.lm.splitTitle', { date: mov.date })}
      hint={mov.mt_account ? t('reconcile.originalAccounts', { accounts: mov.mt_account }) : undefined}
    >
      <div className="space-y-3">
        {parts.map((part, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field label={t('reconcile.lm.partAccount', { n: String(i + 1) })}>
              <Select value={part.account_id} onChange={(e) => update(i, { account_id: e.target.value })}>
                <option value="">{t('reconcile.accountOption')}</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.mt_number}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('reconcile.deposit')}>
              <Input
                type="number" step="0.01" min="0" inputMode="decimal"
                className="text-right tabular-nums"
                value={part.deposit}
                onChange={(e) => update(i, { deposit: e.target.value })}
              />
            </Field>
            <Field label={t('reconcile.withdrawal')}>
              <Input
                type="number" step="0.01" min="0" inputMode="decimal"
                className="text-right tabular-nums"
                value={part.withdrawal}
                onChange={(e) => update(i, { withdrawal: e.target.value })}
              />
            </Field>
          </div>
        ))}

        <ActionButton variant="ghost" onClick={() => setParts((ps) => [...ps, { account_id: '', deposit: '', withdrawal: '' }])}>
          <Plus aria-hidden className="size-4" /> {t('reconcile.anotherAccount')}
        </ActionButton>

        {/* El cuadre se ve mientras se escribe, no recién al guardar: es lo
            único que impide partir mal. */}
        <div className="overflow-hidden rounded-ui-md border border-border">
          <FinTable
            caption={t('reconcile.lm.compareCaption')}
            columns={cols}
            rows={rows}
            rowKey={(r) => r.key}
          />
        </div>

        {st.ok ? (
          <p className="flex items-center gap-1.5 text-[12.5px] text-pos">
            <Check aria-hidden className="size-3.5" /> {t('reconcile.lm.balanced')}
          </p>
        ) : (
          <Notice kind="pend" title={t('reconcile.lm.notBalanced')}>
            {mismatchTitle}
          </Notice>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <ActionButton onClick={onCancel}>{t('common.cancel')}</ActionButton>
          <ActionButton variant="primary" loading={busy} disabled={!st.ok} onClick={onConfirm}>
            <Split aria-hidden className="size-4" /> {t('reconcile.split')}
          </ActionButton>
        </div>
      </div>
    </Panel>
  );
}

/** «Ingreso: faltan $400.00» / «Salida: sobran $5.00». */
function diffText(label: string, diff: number, t: T): string {
  const amount = formatMoney(Math.abs(diff));
  return diff < 0
    ? t('reconcile.lm.missing', { label, amount })
    : t('reconcile.lm.extra', { label, amount });
}
