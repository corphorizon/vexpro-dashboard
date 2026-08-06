'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from './button';
import { useI18n } from '@/lib/i18n';

// ─────────────────────────────────────────────────────────────────────────────
// FixedForwardDialog — alcance de la edición de un EGRESO FIJO.
//
// Kevin (2026-08-06): editar un fijo debe cambiar "de ese mes en adelante".
// Como eso toca meses que el usuario no está mirando, nunca se hace en
// silencio: al guardar un fijo se le pregunta el alcance.
//
// Tres salidas, no dos — por eso no reusa ConfirmDialog (que es binario):
//   · "Este mes y los siguientes" (primaria, la que Kevin pidió por defecto),
//   · "Solo este mes",
//   · Cancelar / ESC / click fuera → cierra sin propagar (el mes actual ya
//     quedó guardado por el flujo normal; cerrar equivale a "solo este mes").
//
// Los meses ANTERIORES nunca se tocan; el texto del diálogo lo dice explícito
// porque es la garantía que le importa a quien ya reportó esas cifras.
// ─────────────────────────────────────────────────────────────────────────────

interface FixedForwardDialogProps {
  concept: string;
  /** Devuelve una promesa: el diálogo muestra spinner hasta que resuelve. */
  onChoose: (apply: 'this' | 'forward') => void | Promise<void>;
  onClose: () => void;
}

export function FixedForwardDialog({ concept, onChoose, onClose }: FixedForwardDialogProps) {
  const { t } = useI18n();
  const cardRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<'this' | 'forward' | null>(null);

  // ESC cierra + focus trap + devolver el foco al abridor. Mismo contrato que
  // ConfirmDialog para que ambos diálogos se sientan igual.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && cardRef.current) {
        const focusables = cardRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  const choose = async (apply: 'this' | 'forward') => {
    const result = onChoose(apply);
    if (result instanceof Promise) {
      setBusy(apply);
      try {
        await result;
      } finally {
        setBusy(null);
      }
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={busy ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="fixed-forward-title"
    >
      <div
        ref={cardRef}
        className="bg-card rounded-xl shadow-[var(--elevation-3)] p-6 max-w-md mx-4 w-full vex-pop-in"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="fixed-forward-title" className="text-lg font-semibold mb-2">
          {t('expenses.forwardTitle')}
        </h3>
        <p className="text-sm text-muted-foreground mb-2">
          {t('expenses.forwardQuestion', { concept })}
        </p>
        <p className="text-xs text-muted-foreground mb-6">{t('expenses.forwardHint')}</p>
        <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
          <Button onClick={onClose} variant="ghost" disabled={busy !== null}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void choose('this')}
            disabled={busy !== null}
            loading={busy === 'this'}
          >
            {t('expenses.forwardOnlyThis')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void choose('forward')}
            disabled={busy !== null}
            loading={busy === 'forward'}
            autoFocus
          >
            {t('expenses.forwardOnward')}
          </Button>
        </div>
      </div>
    </div>
  );
}
