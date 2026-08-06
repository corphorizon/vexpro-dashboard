'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Alta y edición de un asiento manual del libro por canal.
//
// La validación es la MISMA función que corre el endpoint (validateEntry en
// channel-ledger.ts): si el formulario validara por su cuenta, el usuario
// podría ver "guardado" en pantalla y un 400 en la red, o al revés.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { validateEntry, type LedgerEntry } from '@/lib/channel-ledger';

interface Props {
  open: boolean;
  channelKey: string;
  /** null → alta. */
  entry: LedgerEntry | null;
  onClose: () => void;
  onSaved: () => void;
}

const INPUT =
  // text-base en móvil: por debajo de 16px iOS hace zoom forzado al enfocar.
  'h-9 w-full rounded-lg border border-border bg-card px-3 text-base sm:text-sm';

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function LedgerEntryDialog({ open, channelKey, entry, onClose, onSaved }: Props) {
  const { t } = useI18n();

  const [entryDate, setEntryDate] = useState(todayISO);
  const [kind, setKind] = useState<'in' | 'out'>('in');
  const [concept, setConcept] = useState('');
  const [category, setCategory] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset al abrir: sin esto, abrir "nuevo" después de editar arrastraría
  // los valores del asiento anterior.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setEntryDate(entry?.entry_date ?? todayISO());
    setKind(entry?.kind === 'out' ? 'out' : 'in');
    setConcept(entry?.concept ?? '');
    setCategory(entry?.category ?? '');
    setReference(entry?.reference ?? '');
    setAmount(entry ? String(entry.amount) : '');
    setNotes(entry?.notes ?? '');
  }, [open, entry]);

  if (!open) return null;

  const isOpening = entry?.kind === 'opening';

  const handleSave = async () => {
    const payload = {
      channel_key: channelKey,
      entry_date: entryDate,
      kind: isOpening ? ('opening' as const) : kind,
      concept: concept.trim(),
      category: category.trim() || null,
      reference: reference.trim() || null,
      amount: Number(amount),
      notes: notes.trim() || null,
    };

    const invalid = validateEntry(payload);
    if (invalid) { setError(invalid); return; }

    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/admin/channel-ledger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry ? { action: 'update', id: entry.id, ...payload } : { action: 'create', ...payload }),
      });
      const json = await res.json();
      if (json.success) onSaved();
      else setError(json.error ?? 'No se pudo guardar el asiento');
    } catch {
      setError('No se pudo guardar el asiento');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={entry ? t('ledger.editEntry') : t('ledger.newEntry')}
        className="w-full max-w-lg rounded-xl border border-border bg-card shadow-[var(--elevation-3)]"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="font-semibold">{entry ? t('ledger.editEntry') : t('ledger.newEntry')}</h2>
          <Button variant="ghost" size="icon" aria-label="Cerrar" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('ledger.date')}</span>
              <input type="date" className={INPUT} value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
            </label>

            {/* El saldo inicial no es un movimiento: cambiarlo a egreso dejaría
                al canal sin punto de partida. */}
            {!isOpening && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t('ledger.movementType')}</span>
                <select className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as 'in' | 'out')}>
                  <option value="in">{t('ledger.inflow')}</option>
                  <option value="out">{t('ledger.outflow')}</option>
                </select>
              </label>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('ledger.concept')}</span>
            <input className={INPUT} value={concept} onChange={(e) => setConcept(e.target.value)} />
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('ledger.amount')}</span>
              <input
                type="number" min="0" step="0.01" inputMode="decimal"
                className={INPUT} value={amount} onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('ledger.category')}</span>
              <input className={INPUT} value={category} onChange={(e) => setCategory(e.target.value)} />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('ledger.reference')}</span>
            <input className={INPUT} value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('ledger.notes')}</span>
            <textarea
              rows={2}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>

          {error && <p className="text-sm text-negative">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={saving} onClick={handleSave}>Guardar</Button>
        </div>
      </div>
    </div>
  );
}
