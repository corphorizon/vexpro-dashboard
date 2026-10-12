'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';

interface Tx {
  id: string;
  excluded?: boolean;
  excludedReason?: string;
  excludedByName?: string;
}

// Solo admin/socio pueden marcar/desmarcar. Si el rol no califica, el
// botón no se renderiza (la columna queda vacía para esos roles).
export function ExcludeToggleButton({
  tx,
  provider,
  onChange,
}: {
  tx: Tx;
  provider: string; // hoy: 'coinsbuy-deposits'
  onChange: () => void;
}) {
  const { t } = useI18n();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const role = user?.effective_role ?? user?.role ?? '';
  // Los superadmins (platform_users) operan en modo "viewing as" sobre
  // cualquier empresa — su `role` queda como 'superadmin' y no matchea
  // el chequeo admin/socio. Reconocemos también `is_superadmin` para que
  // puedan marcar/desmarcar exclusiones igual que un admin del tenant.
  const canManage = role === 'admin' || role === 'socio' || user?.is_superadmin === true;

  if (!canManage) return null;

  const handleExclude = async () => {
    const reason = window.prompt(
      'Razón para excluir esta transacción (ej: "fondeo para retiros", "swap interno"):',
    );
    if (!reason || reason.trim().length === 0) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/integrations/excluded-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          external_id: tx.id,
          reason: reason.trim(),
        }),
      });
      const data = await res.json();
      if (!data.success) {
        window.alert(data.error ?? 'No se pudo excluir');
        return;
      }
      onChange();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    const ok = window.confirm(
      `Quitar la exclusión de esta transacción?\n` +
        `Razón actual: "${tx.excludedReason ?? '(sin razón)'}"\n` +
        `Marcada por: ${tx.excludedByName ?? '?'}`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      // El DELETE necesita el id de la fila en excluded_transactions, pero
      // acá solo tenemos el external_id (tx.id). Hacemos GET para resolverlo.
      const listRes = await apiFetch('/api/integrations/excluded-transactions');
      const listData = await listRes.json();
      if (!listData.success) {
        window.alert('No se pudo cargar la lista de excluidas');
        return;
      }
      const found = (listData.excluded ?? []).find(
        (e: { provider: string; external_id: string; id: string }) =>
          e.provider === provider && e.external_id === tx.id,
      );
      if (!found) {
        window.alert('No se encontró el registro de exclusión');
        return;
      }
      const res = await apiFetch(`/api/integrations/excluded-transactions/${found.id}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!data.success) {
        window.alert(data.error ?? 'No se pudo restaurar');
        return;
      }
      onChange();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setBusy(false);
    }
  };

  // «Libro mayor» (2026-10-12): eran píldoras de 11 px en verde/ámbar crudos
  // con emoji. Ahora son botones ghost de fila (FinTable los muestra al hover
  // y siempre en táctil): la acción se lee por el texto, no por el color.
  const cls =
    'inline-flex h-7 items-center rounded-ui-md border border-border-strong bg-card px-2 text-[12.5px] font-medium text-text-2 hover:bg-surface-hover hover:text-foreground disabled:opacity-50';

  if (tx.excluded) {
    return (
      <button
        type="button"
        onClick={handleRestore}
        disabled={busy}
        className={cls}
        title={`Razón: ${tx.excludedReason ?? '?'}\nPor: ${tx.excludedByName ?? '?'}`}
      >
        {t('movements.ledger.restore')}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleExclude}
      disabled={busy}
      className={cls}
      title={t('movements.ledger.excludeTitle')}
    >
      {t('movements.ledger.exclude')}
    </button>
  );
}
