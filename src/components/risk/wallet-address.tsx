'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { shortWallet } from './risk-format';

// ─────────────────────────────────────────────────────────────────────────────
// WalletAddress — una wallet en mono 12 px, acortada, con botón de copiar
// («Libro mayor» §3: monoespaciada sólo para identificadores).
//
// POR QUÉ (2026-10-12): la cola de retiros no mostraba la wallet de destino,
// que es lo que soporte coteja contra el cliente («¿es la misma de siempre?»).
// Entera no entra en una fila de 36 px (una TRC20 son 34 caracteres); cortada
// a secas se pierde el dato. Se muestra «TQn9Y2…k3Xa», la dirección entera en
// el `title`, y el botón copia la COMPLETA.
//
// El clic del botón no propaga: la fila de la tabla es clicable (abre la
// ficha) y copiar no debería navegar.
//
// DESCARTADO: copiar con un `<input readonly>` + `select()` — navigator.
// clipboard está en todos los navegadores que soporta el dashboard; si falla
// (permiso denegado) el botón no finge éxito.
// ─────────────────────────────────────────────────────────────────────────────

export function WalletAddress({ address, className }: { address: string | null | undefined; className?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const full = (address ?? '').trim();
  if (!full) return <span className={cn('text-text-3', className)}>—</span>;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span className="truncate font-mono text-[12px] text-text-2" title={full}>
        {shortWallet(full)}
      </span>
      <button
        type="button"
        onClick={async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(full);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        }}
        aria-label={copied ? t('riskLm.walletCopied') : t('riskLm.walletCopy')}
        title={copied ? t('riskLm.walletCopied') : t('riskLm.walletCopy')}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-ui-sm text-text-3 hover:bg-surface-2 hover:text-foreground [@media(pointer:coarse)]:size-8"
      >
        {copied ? <Check aria-hidden className="size-3.5 text-pos" /> : <Copy aria-hidden className="size-3.5" />}
      </button>
    </span>
  );
}
