'use client';

// ─────────────────────────────────────────────────────────────────────────────
// OnchainBreakdown — "cuánto hay en cada moneda", debajo del total.
//
// Kevin: "que al entrar muestre cuánto hay en cada moneda". No va escondido en
// un tooltip: el total de una wallet on-chain es la suma de cosas distintas
// (USDT en varias cadenas + el gas de cada una) y un número solo no deja
// verificar nada.
//
// SALE DEL SNAPSHOT, NO DE LA CADENA. El desglose es el que el cron guardó en
// `channel_balances.meta` esa noche: abrir /balances no dispara ninguna consulta
// a la blockchain, y el detalle que se ve es exactamente el que explica el
// número asentado en el libro (mismo precio de gas incluido).
//
// Los activos en CERO no se muestran. Una wallet con $0,0014 en BEP20 y 0 en
// ERC20 llenaría la tarjeta de ruido; lo que importa es dónde está la plata.
// El total sigue siendo la suma de TODO, con ceros incluidos.
// ─────────────────────────────────────────────────────────────────────────────

import { useI18n } from '@/lib/i18n';
import { formatCurrency } from '@/lib/utils';
import { ONCHAIN_NETWORK_LABELS, isOnchainNetwork } from '@/lib/cash-locations';
import type { OnchainSnapshotMeta } from '@/lib/types';

/** Debajo de esto un saldo es polvo de gas y no vale una línea. */
const DUST = 0.005;

interface Props {
  meta: OnchainSnapshotMeta;
  /** Parte de la ubicación que le toca a esta unidad (reparto por unidades). */
  share?: number;
}

function networkLabel(network: string): string {
  return isOnchainNetwork(network) ? ONCHAIN_NETWORK_LABELS[network] : network;
}

/** Cantidad de token: hasta 6 decimales, sin ceros de relleno inútiles. */
function formatAmount(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(amount);
}

export function OnchainBreakdown({ meta, share = 1 }: Props) {
  const { t, locale } = useI18n();
  const networks = Array.isArray(meta.networks) ? meta.networks : [];
  if (networks.length === 0) return null;

  // USDT primero y agregado: es un solo activo aunque viva en tres cadenas.
  const usdtTotal = networks.reduce((s, n) => s + (Number(n.usdt) || 0), 0);
  const usdtByNetwork = networks.filter((n) => (Number(n.usdt) || 0) > DUST);

  // Los nativos se agrupan por símbolo: cada cadena tiene el suyo, pero si
  // algún día hubiera dos wallets en la misma red no habría que sumarlas a ojo.
  const nativeBySymbol = new Map<string, { amount: number; valueUsd: number; priceUsd: number | null }>();
  for (const n of networks) {
    const native = n.native;
    if (!native || !(Number(native.amount) > 0)) continue;
    const prev = nativeBySymbol.get(native.symbol);
    nativeBySymbol.set(native.symbol, {
      amount: (prev?.amount ?? 0) + Number(native.amount),
      valueUsd: (prev?.valueUsd ?? 0) + (Number(native.valueUsd) || 0),
      priceUsd: native.priceUsd ?? prev?.priceUsd ?? null,
    });
  }

  const rows: React.ReactNode[] = [];

  if (usdtTotal > DUST) {
    rows.push(
      <div key="usdt" className="flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground">
          USDT
          {/* Sub-desglose solo cuando el token vive en más de una cadena: con
              una sola red repetiría el mismo número dos veces. */}
          {usdtByNetwork.length > 1 && (
            <span className="ml-1 text-[11px]">
              (
              {usdtByNetwork
                .map((n) => `${networkLabel(n.network)} ${formatAmount(Number(n.usdt) * share, locale)}`)
                .join(' · ')}
              )
            </span>
          )}
        </span>
        <span className="tabular-nums">{formatAmount(usdtTotal * share, locale)}</span>
      </div>,
    );
  }

  for (const [symbol, native] of nativeBySymbol) {
    rows.push(
      <div key={symbol} className="flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground">
          {symbol}
          {native.priceUsd !== null && (
            <span className="ml-1 text-[11px]">
              {t('onchain.atPrice', { price: formatCurrency(native.priceUsd) })}
            </span>
          )}
        </span>
        <span className="tabular-nums">
          {formatAmount(native.amount * share, locale)}
          <span className="ml-2 text-muted-foreground">
            ≈ {formatCurrency(native.valueUsd * share)}
          </span>
        </span>
      </div>,
    );
  }

  if (rows.length === 0) return null;

  const readAt = meta.readAt ? new Date(meta.readAt) : null;

  return (
    <div className="mt-2 pl-6 space-y-0.5 text-xs">
      {rows}
      {readAt && (
        <p
          className="text-[11px] text-muted-foreground pt-0.5"
          title={meta.priceAt ? t('onchain.priceAt', { at: meta.priceAt }) : undefined}
        >
          {t('onchain.readAt', { at: readAt.toLocaleString(locale === 'en' ? 'en-US' : 'es-AR') })}
        </p>
      )}
    </div>
  );
}
