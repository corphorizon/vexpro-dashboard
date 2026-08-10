'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Selector de ubicación previo al alta de un asiento desde el libro de una
// unidad de negocio.
//
// Una unidad no tiene libro propio: sus asientos viven en el libro de alguna
// de sus ubicaciones. Cuando hay más de una candidata hay que preguntar, y
// preguntar CON EL SALDO a la vista — "Balance Horizon" y "Balance Exura" se
// distinguen por el nombre, pero dos wallets parecidas se distinguen por lo
// que tienen adentro.
//
// Solo se listan ubicaciones de carga manual: el libro de las pasarelas lo
// escribe el cron y un asiento a mano lo descuadraría contra el proveedor.
// ─────────────────────────────────────────────────────────────────────────────

import { X, Wallet } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface PickableLocation {
  key: string;
  label: string;
  balance: number;
}

interface Props {
  open: boolean;
  locations: PickableLocation[];
  onPick: (channelKey: string) => void;
  onClose: () => void;
}

export function LedgerLocationPicker({ open, locations, onPick, onClose }: Props) {
  const { t } = useI18n();

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('unitLedger.pickLocationTitle')}
        className="w-full max-w-md rounded-xl border border-border bg-card shadow-[var(--elevation-3)]"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="font-semibold">{t('unitLedger.pickLocationTitle')}</h2>
          <Button variant="ghost" size="icon" aria-label={t('common.close')} onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="px-5 py-4">
          <p className="text-base sm:text-sm text-muted-foreground">
            {t('unitLedger.pickLocationHint')}
          </p>

          {/* max-h + scroll: una unidad con muchas ubicaciones no puede empujar
              los bordes del diálogo fuera de la pantalla. */}
          <div className="mt-4 max-h-[50vh] overflow-y-auto flex flex-col gap-2">
            {locations.map((loc) => (
              <button
                key={loc.key}
                type="button"
                onClick={() => onPick(loc.key)}
                className="flex items-center justify-between gap-3 min-h-11 w-full px-3 py-2 rounded-lg border border-border text-left text-base sm:text-sm hover:bg-muted/60 transition-colors"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Wallet className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden />
                  <span className="truncate">{loc.label}</span>
                </span>
                <span className="font-semibold tabular-nums shrink-0">
                  {formatCurrency(loc.balance)}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end border-t border-border px-5 py-4">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
        </div>
      </div>
    </div>
  );
}
