'use client';

import { useState, useMemo, useEffect, useCallback, type RefObject } from 'react';
import * as Sentry from '@sentry/nextjs';
import { apiFetch } from '@/lib/api-fetch';
import { logAction } from '@/lib/audit-log';
import { useI18n } from '@/lib/i18n';
import { parseAmount, findInvalidAmount } from '@/lib/upload-calculations';
import {
  computeIncomeTotals,
  computeIncomePending,
  groupByClient,
  type IncomeLine,
  type IncomeLineInput,
} from '@/lib/income-lines';

// Estado de los inputs del detalle de ingresos: strings, porque el usuario
// puede estar escribiendo "12." y eso no es un número todavía.
export interface IncomeLineForm { concept: string; client: string; amount: string; received: string; pending: string }
export const EMPTY_INCOME_LINE: IncomeLineForm = { concept: '', client: '', amount: '', received: '', pending: '' };

export interface UseIncomeLinesOptions {
  /** El detalle sólo se carga cuando la pestaña de ingresos está a la vista. */
  active: boolean;
  company: { id: string } | null;
  user: { id: string; name: string } | null;
  /** Período cerrado (migración 061): el trigger de la DB rechaza toda escritura. */
  periodIsClosed: boolean;
  userCanAdd: boolean;
  userCanEdit: boolean;
  userCanDelete: boolean;
  /**
   * Ref al período seleccionado. Se lee `.current` (y no el state) por la
   * misma razón que el resto de la página: evita cierres obsoletos sin
   * recrear los callbacks en cada cambio de período.
   */
  periodIdRef: RefObject<string>;
  showSuccess: (msg: string) => void;
  showError: (msg: string) => void;
  askConfirmation: (message: string, onConfirm: () => void) => void;
  refreshSections: (
    sections: Array<'depositos' | 'retiros' | 'egresos' | 'ingresos' | 'liquidez' | 'inversiones'>,
  ) => Promise<boolean>;
  withRowTimeout: <T>(p: Promise<T>, label: string, ms?: number) => Promise<T>;
  /**
   * El servidor materializa operating_income.other con lo cobrado; el padre lo
   * refleja con su setter Raw para no marcar 'ingresos' sucio y disparar el
   * autosave de los otros campos.
   */
  onReceivedSynced: (received: number) => void;
}

export interface UseIncomeLinesResult {
  incomeLines: IncomeLine[];
  incomeTotals: ReturnType<typeof computeIncomeTotals>;
  incomeByClient: ReturnType<typeof groupByClient>;
  savingIncomeLines: boolean;
  newIncomeLine: IncomeLineForm;
  setNewIncomeLine: React.Dispatch<React.SetStateAction<IncomeLineForm>>;
  editingIncomeLineId: string | null;
  setEditingIncomeLineId: React.Dispatch<React.SetStateAction<string | null>>;
  editIncomeLine: IncomeLineForm;
  setEditIncomeLine: React.Dispatch<React.SetStateAction<IncomeLineForm>>;
  addIncomeLine: () => void;
  startEditIncomeLine: (line: IncomeLine) => void;
  saveEditIncomeLine: () => void;
  markIncomeCollected: (id: string) => void;
  deleteIncomeLine: (id: string) => void;
}

// ── Detalle de ingresos por concepto ───────────────────────────────────
//
// Espejo de la tabla de egresos: misma alta inline, misma edición por fila,
// mismo borrado. Persiste POR ACCIÓN igual que persistExpenses, pero el POST
// manda SIEMPRE el período completo — la RPC borra e inserta en una sola
// transacción y deja operating_income.other en la suma de lo COBRADO.
//
// NO usa dirtySections: 'ingresos' es el bucket de broker P&L / otros / prop
// firm, y marcarlo dirty acá haría que al limpiarlo el sync-effect pise
// ediciones sin guardar de esos campos. El detalle vive en su propio estado
// y se re-lee del servidor después de cada guardado.
export function useIncomeLines(
  periodId: string,
  opts: UseIncomeLinesOptions,
): UseIncomeLinesResult {
  const { t } = useI18n();
  const {
    active,
    company,
    user,
    periodIsClosed,
    userCanAdd,
    userCanEdit,
    userCanDelete,
    periodIdRef,
    showSuccess,
    showError,
    askConfirmation,
    refreshSections,
    withRowTimeout,
    onReceivedSynced,
  } = opts;

  const [incomeLines, setIncomeLines] = useState<IncomeLine[]>([]);
  /**
   * Período al que pertenece `incomeLines`. Vacío = no hay una carga
   * confirmada (nunca se cargó, o la carga falló).
   *
   * POR QUÉ EXISTE (auditoría 2026-08, A2): el POST manda SIEMPRE el período
   * completo y la RPC borra e inserta. Si el estado quedó con las líneas del
   * mes anterior —porque la carga del mes nuevo falló y devolvió null— la
   * siguiente acción del usuario escribía la facturación de marzo dentro de
   * abril, y de paso borraba la de abril. Sin este centinela el bug es
   * invisible: la pantalla muestra líneas plausibles del mes equivocado.
   */
  const [incomeLinesPeriodId, setIncomeLinesPeriodId] = useState<string>('');
  const [savingIncomeLines, setSavingIncomeLines] = useState(false);
  const [newIncomeLine, setNewIncomeLine] = useState<IncomeLineForm>(EMPTY_INCOME_LINE);
  const [editingIncomeLineId, setEditingIncomeLineId] = useState<string | null>(null);
  const [editIncomeLine, setEditIncomeLine] = useState<IncomeLineForm>(EMPTY_INCOME_LINE);

  const loadIncomeLines = useCallback(async (id: string): Promise<IncomeLine[] | null> => {
    if (!id) return [];
    try {
      const res = await apiFetch(`/api/admin/income-lines?period_id=${encodeURIComponent(id)}`);
      const json = await res.json();
      return json.success ? ((json.lines ?? []) as IncomeLine[]) : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // Vaciar ANTES de pedir: mientras la respuesta viaja, la pantalla no
    // puede seguir mostrando el detalle del mes anterior como si fuera el de
    // este. Si además la carga falla, quedarse con las líneas viejas es lo
    // que permitía escribirlas en el mes equivocado.
    setIncomeLines([]);
    setIncomeLinesPeriodId('');
    void (async () => {
      const lines = await loadIncomeLines(periodId);
      // `cancelled` evita que una respuesta lenta del período anterior pise
      // el detalle del período que el usuario ya tiene en pantalla.
      if (cancelled) return;
      if (lines) {
        setIncomeLines(lines);
        setIncomeLinesPeriodId(periodId);
      } else {
        // Un fallo mudo dejaba la tabla vacía y al usuario creyendo que el mes
        // no tiene ingresos cargados.
        showError(t('income.loadError'));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, periodId, loadIncomeLines]);

  const incomeTotals = useMemo(() => computeIncomeTotals(incomeLines), [incomeLines]);
  const incomeByClient = useMemo(() => groupByClient(incomeLines), [incomeLines]);

  const persistIncomeLines = async (
    nextList: IncomeLine[],
    previousList: IncomeLine[],
    persistOpts: { toast: string; audit?: { action: 'create' | 'update' | 'delete'; details: string } },
  ) => {
    // Cada corte tiene que DECIR por qué. Kevin (2026-08-09) reportó que al
    // confirmar una fila "no pasaba nada": un `return` mudo acá deja al
    // usuario sin forma de diagnosticar nada, y encima con la fila ya
    // cambiada en pantalla por el update optimista.
    if (!company) {
      setIncomeLines(previousList);
      showError(t('income.noCompany'));
      return;
    }
    if (periodIsClosed) {
      setIncomeLines(previousList); // el trigger de la DB lo rechazaría igual
      showError(t('income.periodClosed'));
      return;
    }
    const targetPeriodId = periodIdRef.current;
    if (!targetPeriodId) {
      setIncomeLines(previousList);
      showError(t('income.noPeriod'));
      return;
    }
    // El estado en pantalla tiene que ser el del período al que vamos a
    // escribir. Si no coincide (cambio de mes con la carga a medias, o carga
    // fallida), el POST reemplazaría el detalle de ESE mes con el del otro:
    // facturación duplicada acá y borrada allá. Se corta antes de escribir.
    if (incomeLinesPeriodId !== targetPeriodId) {
      setIncomeLines(previousList);
      showError(t('income.periodMismatch'));
      return;
    }
    setSavingIncomeLines(true);
    try {
      const payload: IncomeLineInput[] = nextList.map((l, i) => ({
        concept: l.concept,
        client: l.client,
        amount: l.amount,
        received: l.received,
        pending: l.pending,
        category: l.category,
        reference: l.reference,
        income_date: l.income_date,
        sort_order: i,
      }));
      const res = await withRowTimeout(
        apiFetch('/api/admin/income-lines', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ period_id: targetPeriodId, lines: payload }),
        }),
        t('upload.opSaveExpense'),
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Error');
      // El servidor materializa operating_income.other con lo cobrado; se
      // refleja con el setter Raw para no marcar 'ingresos' sucio y disparar
      // el autosave de los otros campos.
      onReceivedSynced(Number(json.received) || 0);
      if (user && persistOpts.audit) {
        logAction(user.id, user.name, persistOpts.audit.action, 'income', persistOpts.audit.details);
      }
      showSuccess(persistOpts.toast);
      // Techo + catch propio en los dos pasos post-guardado: el POST ya
      // corrió; si rebotaran al catch de afuera harían rollback de un
      // guardado exitoso, y colgados dejaban savingIncomeLines en true eterno.
      await withRowTimeout(refreshSections(['ingresos']), t('upload.opReloadData')).catch(() => {
        console.warn('[ingresos] refresh after save failed');
      });
      const fresh = await withRowTimeout(loadIncomeLines(targetPeriodId), t('upload.opReloadData'))
        .catch(() => null); // ids reales en vez de los optimistas
      if (fresh) {
        setIncomeLines(fresh);
        setIncomeLinesPeriodId(targetPeriodId);
      }
    } catch (err) {
      setIncomeLines(previousList); // rollback a lo que hay en DB
      Sentry.captureException(err, {
        tags: { area: 'upload.persistIncomeLines' },
        extra: { periodId: targetPeriodId },
      });
      showError(t('income.saveError', { error: (err as Error).message }));
    } finally {
      setSavingIncomeLines(false);
    }
  };

  /** Valida los tres montos de una línea. Devuelve true si puede guardarse. */
  const incomeAmountsAreValid = (form: IncomeLineForm): boolean => {
    const bad = findInvalidAmount(form.amount, form.received, form.pending);
    if (bad !== null) { showError(t('upload.invalidAmount', { value: bad })); return false; }
    if (parseAmount(form.received) > parseAmount(form.amount) + 0.01) {
      showError(t('income.receivedOverAmount'));
      return false;
    }
    return true;
  };

  const addIncomeLine = () => {
    if (!userCanAdd) return; // sin permiso el botón ni se dibuja
    if (!company) { showError(t('income.noCompany')); return; }
    if (!newIncomeLine.concept.trim() || !newIncomeLine.amount) {
      showError(t('income.conceptRequired'));
      return;
    }
    if (!incomeAmountsAreValid(newIncomeLine)) return;
    const amt = parseAmount(newIncomeLine.amount);
    const rec = parseAmount(newIncomeLine.received);
    const pnd = computeIncomePending(newIncomeLine.amount, newIncomeLine.received, newIncomeLine.pending);
    const previous = incomeLines;
    const next: IncomeLine[] = [...incomeLines, {
      id: `inc-${Date.now()}`,
      company_id: company.id,
      period_id: periodIdRef.current,
      concept: newIncomeLine.concept,
      client: newIncomeLine.client.trim() || null,
      amount: amt,
      received: rec,
      pending: pnd,
      category: null,
      reference: null,
      income_date: null,
      sort_order: incomeLines.length,
      created_at: '',
      updated_at: '',
    }];
    setIncomeLines(next); // optimista
    setNewIncomeLine(EMPTY_INCOME_LINE);
    void persistIncomeLines(next, previous, {
      toast: t('income.lineAdded'),
      audit: { action: 'create', details: `Ingreso creado: ${newIncomeLine.concept}, monto: $${amt.toLocaleString()}` },
    });
  };

  const startEditIncomeLine = (line: IncomeLine) => {
    if (!userCanEdit) return;
    setEditingIncomeLineId(line.id);
    setEditIncomeLine({
      concept: line.concept,
      client: line.client ?? '',
      amount: String(line.amount),
      received: String(line.received),
      pending: String(line.pending),
    });
  };

  const saveEditIncomeLine = () => {
    if (!editingIncomeLineId) { showError(t('income.notEditing')); return; }
    if (!incomeAmountsAreValid(editIncomeLine)) return;
    const amt = parseAmount(editIncomeLine.amount);
    const rec = parseAmount(editIncomeLine.received);
    const pnd = computeIncomePending(editIncomeLine.amount, editIncomeLine.received, editIncomeLine.pending);
    const concept = editIncomeLine.concept;
    const previous = incomeLines;
    const next = incomeLines.map(l => l.id === editingIncomeLineId
      ? { ...l, concept, client: editIncomeLine.client.trim() || null, amount: amt, received: rec, pending: pnd }
      : l);
    setIncomeLines(next); // optimista
    setEditingIncomeLineId(null);
    void persistIncomeLines(next, previous, {
      toast: t('income.lineUpdated'),
      audit: { action: 'update', details: `Ingreso ${concept}: $${amt.toLocaleString()}` },
    });
  };

  const markIncomeCollected = (id: string) => {
    if (!userCanEdit) return;
    const target = incomeLines.find(l => l.id === id);
    if (!target || target.pending <= 0) return;
    const previous = incomeLines;
    const next = incomeLines.map(l => l.id === id ? { ...l, received: l.amount, pending: 0 } : l);
    setIncomeLines(next); // optimista
    void persistIncomeLines(next, previous, {
      toast: t('income.lineUpdated'),
      audit: { action: 'update', details: `Ingreso marcado como cobrado: ${target.concept} ($${target.amount.toLocaleString()})` },
    });
  };

  const deleteIncomeLine = (id: string) => {
    if (!userCanDelete) return;
    const line = incomeLines.find(l => l.id === id);
    askConfirmation(t('income.deleteConfirm', { concept: line?.concept ?? '' }), () => {
      const previous = incomeLines;
      const next = incomeLines.filter(l => l.id !== id);
      setIncomeLines(next); // optimista
      void persistIncomeLines(next, previous, {
        toast: t('income.lineDeleted'),
        audit: { action: 'delete', details: `Ingreso eliminado: ${line?.concept ?? ''}` },
      });
    });
  };

  return {
    incomeLines,
    incomeTotals,
    incomeByClient,
    savingIncomeLines,
    newIncomeLine,
    setNewIncomeLine,
    editingIncomeLineId,
    setEditingIncomeLineId,
    editIncomeLine,
    setEditIncomeLine,
    addIncomeLine,
    startEditIncomeLine,
    saveEditIncomeLine,
    markIncomeCollected,
    deleteIncomeLine,
  };
}
