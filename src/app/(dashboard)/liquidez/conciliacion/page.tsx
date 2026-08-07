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
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Scale, Split, Check, Plus, AlertTriangle } from 'lucide-react';
import { useAuth, canAdd } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { formatCurrency } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useToasts } from '@/components/ui/toast';

interface Account { id: string; mt_number: string; label: string | null; is_active: boolean }
interface Pending {
  id: string; date: string; mt_account: string | null;
  deposit: number; withdrawal: number; notes: string | null; needs_split: boolean;
}
interface SplitPart { account_id: string; deposit: string; withdrawal: string }

const INPUT = 'h-9 w-full rounded-lg border border-border bg-card px-3 text-base sm:text-sm';

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

  const splitTotals = (mov: Pending) => {
    const dep = parts.reduce((s, p) => s + (Number(p.deposit) || 0), 0);
    const wit = parts.reduce((s, p) => s + (Number(p.withdrawal) || 0), 0);
    return { dep, wit, ok: Math.abs(dep - mov.deposit) < 0.01 && Math.abs(wit - mov.withdrawal) < 0.01 };
  };

  const confirmSplit = async (mov: Pending) => {
    const { ok } = splitTotals(mov);
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
    if (done) { setSplitting(null); setParts([]); }
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

  return (
    <div className="space-y-6">
      {ToastHost}

      <PageHeader
        title={t('reconcile.title')}
        subtitle={t('reconcile.subtitle')}
        icon={Scale}
        actions={
          <Link href="/liquidez" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-4 h-4" /> {t('reconcile.backToLiquidity')}
          </Link>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label={t('reconcile.statNoAccount')} value={String(totals.sinCuenta)} tone={totals.sinCuenta ? 'warning' : 'positive'} />
        <StatCard label={t('reconcile.statToSplit')} value={String(totals.aDividir)} tone={totals.aDividir ? 'warning' : 'positive'} />
        <StatCard label={t('reconcile.statPendingAmount')} value={formatCurrency(totals.monto)} />
      </div>

      {/* Alta rápida de cuenta: si un movimiento pertenece a una cuenta que no
          está en el catálogo, se puede crear sin salir de acá. */}
      {canWrite && (
        <Card className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('reconcile.addAccountLabel')}</span>
              <input
                className={INPUT}
                value={newAccount}
                placeholder={t('reconcile.accountNumberPlaceholder')}
                onChange={(e) => setNewAccount(e.target.value)}
              />
            </label>
            <Button variant="secondary" size="sm" onClick={createAccount} disabled={!newAccount.trim()}>
              <Plus className="w-4 h-4" /> {t('common.add')}
            </Button>
            <span className="text-xs text-muted-foreground ml-auto">
              {t('reconcile.accountsInCatalog', { count: String(accounts.length) })}
            </span>
          </div>
        </Card>
      )}

      {loading && <Card className="p-8 text-center text-muted-foreground">…</Card>}

      {!loading && pending.length === 0 && (
        <EmptyState
          icon={Check}
          title={t('reconcile.allDoneTitle')}
          description={t('reconcile.allDoneDesc')}
        />
      )}

      {!loading && pending.map((mov) => {
        const isSplitting = splitting === mov.id;
        const st = isSplitting ? splitTotals(mov) : null;
        return (
          <Card key={mov.id} className="p-4 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium tabular-nums">{mov.date}</span>
                  {mov.deposit > 0 && (
                    <span className="text-positive tabular-nums">+{formatCurrency(mov.deposit)}</span>
                  )}
                  {mov.withdrawal > 0 && (
                    <span className="text-negative tabular-nums">−{formatCurrency(mov.withdrawal)}</span>
                  )}
                  {mov.needs_split && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-warning/10 text-amber-700 dark:text-amber-300 border border-warning/30">
                      <AlertTriangle className="w-3 h-3" /> {t('reconcile.multipleAccounts')}
                    </span>
                  )}
                </div>
                {mov.mt_account && (
                  <p className="text-xs text-muted-foreground mt-1 break-all">
                    {t('reconcile.originalAccounts', { accounts: mov.mt_account })}
                  </p>
                )}
                {mov.notes && <p className="text-xs text-muted-foreground mt-0.5">{mov.notes}</p>}
              </div>

              {canWrite && !isSplitting && (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className={`${INPUT} w-48`}
                    value={choice[mov.id] ?? ''}
                    onChange={(e) => setChoice((c) => ({ ...c, [mov.id]: e.target.value }))}
                  >
                    <option value="">{t('reconcile.chooseAccount')}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.mt_number}{a.label ? ` · ${a.label}` : ''}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" variant="primary" loading={busyId === mov.id} onClick={() => assign(mov)}>
                    <Check className="w-4 h-4" /> {t('reconcile.assign')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => beginSplit(mov)}>
                    <Split className="w-4 h-4" /> {t('reconcile.split')}
                  </Button>
                </div>
              )}
            </div>

            {isSplitting && (
              <div className="border-t border-border pt-3 space-y-2">
                {parts.map((part, i) => (
                  <div key={i} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <select
                      className={INPUT}
                      value={part.account_id}
                      onChange={(e) => setParts((ps) => ps.map((p, j) => j === i ? { ...p, account_id: e.target.value } : p))}
                    >
                      <option value="">{t('reconcile.accountOption')}</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.mt_number}</option>
                      ))}
                    </select>
                    <input
                      type="number" step="0.01" min="0" inputMode="decimal"
                      className={INPUT} placeholder={t('reconcile.deposit')} value={part.deposit}
                      onChange={(e) => setParts((ps) => ps.map((p, j) => j === i ? { ...p, deposit: e.target.value } : p))}
                    />
                    <input
                      type="number" step="0.01" min="0" inputMode="decimal"
                      className={INPUT} placeholder={t('reconcile.withdrawal')} value={part.withdrawal}
                      onChange={(e) => setParts((ps) => ps.map((p, j) => j === i ? { ...p, withdrawal: e.target.value } : p))}
                    />
                  </div>
                ))}

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <Button size="sm" variant="ghost" onClick={() => setParts((ps) => [...ps, { account_id: '', deposit: '', withdrawal: '' }])}>
                    <Plus className="w-4 h-4" /> {t('reconcile.anotherAccount')}
                  </Button>
                  {/* El descuadre se avisa mientras se escribe, no recién al
                      guardar: es lo único que impide partir mal. */}
                  <span className={`text-xs tabular-nums ${st?.ok ? 'text-positive' : 'text-negative'}`}>
                    {t('reconcile.partsSummary', {
                      dep: formatCurrency(st?.dep ?? 0),
                      wit: formatCurrency(st?.wit ?? 0),
                      origDep: formatCurrency(mov.deposit),
                      origWit: formatCurrency(mov.withdrawal),
                    })}
                  </span>
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => { setSplitting(null); setParts([]); }}>
                      {t('common.cancel')}
                    </Button>
                    <Button
                      size="sm" variant="primary"
                      loading={busyId === mov.id}
                      disabled={!st?.ok}
                      onClick={() => confirmSplit(mov)}
                    >
                      {t('reconcile.split')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
