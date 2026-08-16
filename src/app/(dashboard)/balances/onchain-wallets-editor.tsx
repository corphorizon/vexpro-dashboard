'use client';

// ─────────────────────────────────────────────────────────────────────────────
// OnchainWalletsEditor — las direcciones públicas de una ubicación.
//
// Vive en un solo archivo y lo usan las DOS pantallas donde se define una
// ubicación: el alta (channel-config-modal) y la edición en la tarjeta
// (channel-balances-card). Duplicar el formulario habría dejado dos listas de
// redes que se desincronizan en silencio — el modo de falla número uno de este
// repo.
//
// UNA FILA POR RED. La misma dirección 0x vale en BSC y en Ethereum con saldos
// distintos, así que se cargan como dos filas; la validación de duplicados es
// por el par (red, dirección), no por la dirección sola.
//
// La validación es la MISMA función que corre en el servidor
// (`validateOnchainWallets`): un solo lugar donde está escrito qué es una
// dirección válida, y el mismo mensaje de error de los dos lados.
// ─────────────────────────────────────────────────────────────────────────────

import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  ONCHAIN_NETWORKS,
  ONCHAIN_NETWORK_LABELS,
  isValidOnchainAddress,
  type OnchainNetwork,
  type OnchainWallet,
} from '@/lib/cash-locations';

const INPUT =
  'h-11 sm:h-9 px-3 text-base sm:text-sm rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30';

interface Props {
  value: OnchainWallet[];
  onChange: (wallets: OnchainWallet[]) => void;
  disabled?: boolean;
}

export function OnchainWalletsEditor({ value, onChange, disabled }: Props) {
  const { t } = useI18n();

  const update = (index: number, patch: Partial<OnchainWallet>) => {
    onChange(value.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  };

  const add = () => {
    // Se propone la primera red que todavía no esté cargada: lo habitual es
    // una wallet por red, y así el alta es un click en vez de un selector.
    const used = new Set(value.map((w) => w.network));
    const next = ONCHAIN_NETWORKS.find((n) => !used.has(n)) ?? ONCHAIN_NETWORKS[0];
    onChange([...value, { network: next, address: '' }]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">{t('onchain.title')}</p>
          <p className="text-[11px] text-muted-foreground">{t('onchain.hint')}</p>
        </div>
        <button
          type="button"
          onClick={add}
          disabled={disabled}
          className="inline-flex items-center gap-1 min-h-11 sm:min-h-9 px-3 text-xs rounded-lg border border-border bg-card hover:bg-muted disabled:opacity-50 shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('onchain.addAddress')}
        </button>
      </div>

      {value.map((wallet, index) => {
        // Un campo vacío todavía no es un error: recién se agregó la fila.
        const invalid =
          wallet.address.trim().length > 0 &&
          !isValidOnchainAddress(wallet.network, wallet.address);
        return (
          <div key={index} className="flex flex-col sm:flex-row gap-2">
            <select
              value={wallet.network}
              onChange={(e) => update(index, { network: e.target.value as OnchainNetwork })}
              disabled={disabled}
              className={`${INPUT} sm:w-56`}
              aria-label={t('onchain.network')}
            >
              {ONCHAIN_NETWORKS.map((n) => (
                <option key={n} value={n}>
                  {ONCHAIN_NETWORK_LABELS[n]}
                </option>
              ))}
            </select>
            <input
              value={wallet.address}
              onChange={(e) => update(index, { address: e.target.value })}
              disabled={disabled}
              placeholder={t('onchain.addressPlaceholder')}
              aria-label={t('onchain.address')}
              aria-invalid={invalid}
              className={`${INPUT} flex-1 min-w-0 font-mono text-xs ${
                invalid ? 'border-negative' : ''
              }`}
            />
            <button
              type="button"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              disabled={disabled}
              className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 flex items-center justify-center rounded-lg text-negative hover:bg-negative/10 disabled:opacity-50 shrink-0"
              title={t('onchain.removeAddress')}
              aria-label={t('onchain.removeAddress')}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        );
      })}

      {value.some((w) => w.address.trim() && !isValidOnchainAddress(w.network, w.address)) && (
        <p className="text-[11px] text-negative">{t('onchain.invalidAddress')}</p>
      )}
      {value.length > 0 && <p className="text-[11px] text-muted-foreground">{t('onchain.autoNote')}</p>}
    </div>
  );
}
