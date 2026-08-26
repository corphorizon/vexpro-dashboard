'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Aprobar o rechazar un retiro desde la cola, sin abrir la ficha.
//
// ── POR QUÉ PIDE MOTIVO Y NO DECIDE DE UN CLIC ─────────────────────────────
// Porque la decisión queda en un historial append-only que después alguien va a
// leer para entender qué pasó. Una fila que dice "rechazado" y nada más obliga
// a reconstruir el razonamiento desde cero, normalmente cuando ya nadie se
// acuerda.
//
// El motivo es OBLIGATORIO al rechazar y opcional al aprobar. No es simetría
// perdida: rechazar le niega el dinero a alguien y es lo que se reclama, se
// escala y se audita. Pedirlo también al aprobar convertiría el caso normal
// —la enorme mayoría— en un trámite, y un campo obligatorio que estorba se
// termina rellenando con "ok".
//
// ── LO QUE ESTE DIÁLOGO NO HACE ────────────────────────────────────────────
// No ejecuta el retiro. El dashboard es solo-lectura sobre el CRM: acá se
// registra la decisión y la acción efectiva se sigue haciendo en el CRM. El
// aviso va DENTRO del diálogo, en el momento de decidir, y no en un tooltip:
// es justo acá donde alguien puede creer que ya está hecho.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

export type QuickDecision = 'approve' | 'reject';

export interface QuickDecisionTarget {
  externalId: string;
  who: string;
  amount: string;
  decision: QuickDecision;
}

export function QuickDecisionDialog({
  target,
  labels,
  onConfirm,
  onClose,
}: {
  target: QuickDecisionTarget;
  labels: {
    approveTitle: string;
    rejectTitle: string;
    reason: string;
    reasonRequired: string;
    reasonOptional: string;
    notExecuted: string;
    confirmApprove: string;
    confirmReject: string;
    cancel: string;
  };
  onConfirm: (decision: QuickDecision, notes: string) => Promise<void>;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const rechazo = target.decision === 'reject';
  const faltaMotivo = rechazo && notes.trim().length === 0;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    areaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
      if (e.key === 'Tab' && cardRef.current) {
        const f = cardRef.current.querySelectorAll<HTMLElement>(
          'button, textarea, [href], input, select, [tabindex]:not([tabindex="-1"])',
        );
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
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
  }, [onClose, busy]);

  const confirmar = async () => {
    if (faltaMotivo || busy) return;
    setBusy(true);
    try {
      await onConfirm(target.decision, notes.trim());
      onClose();
    } finally {
      // Si falló, el diálogo queda abierto con lo escrito: perder el motivo
      // por un error de red obligaría a redactarlo de nuevo.
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={rechazo ? labels.rejectTitle : labels.approveTitle}
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg"
      >
        <h2 className="text-base font-semibold">
          {rechazo ? labels.rejectTitle : labels.approveTitle}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {target.who} · <span className="font-medium">{target.amount}</span>
        </p>

        <label className="mt-4 block text-sm">
          <span className="mb-1 block font-medium">
            {labels.reason}{' '}
            <span className="font-normal text-muted-foreground">
              {rechazo ? labels.reasonRequired : labels.reasonOptional}
            </span>
          </span>
          <textarea
            ref={areaRef}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            // `text-base` en móvil: por debajo de 16px iOS hace zoom forzado.
            className="w-full resize-y rounded-lg border border-border bg-card p-2 text-base sm:text-sm"
          />
        </label>

        <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
          {labels.notExecuted}
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button
            size="sm"
            variant={rechazo ? 'destructive' : 'primary'}
            loading={busy}
            disabled={faltaMotivo}
            onClick={() => void confirmar()}
          >
            {rechazo ? labels.confirmReject : labels.confirmApprove}
          </Button>
        </div>
      </div>
    </div>
  );
}
