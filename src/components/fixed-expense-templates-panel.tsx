'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useData } from '@/lib/data-context';
import { useAuth, canEdit, canDelete } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { formatCurrency } from '@/lib/utils';
import {
  deleteExpenseTemplate,
  hideExpenseTemplateForPeriod,
  unhideExpenseTemplateForPeriod,
} from '@/lib/supabase/mutations';
import { ChevronDown, ChevronUp, Repeat, Eye, EyeOff, Trash2 } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Fixed Expense Templates Panel — PERIOD-AWARE (migration-050)
//
// Panel colapsable dentro de la sección Egresos de /upload. Gestiona las
// plantillas de egresos recurrentes con temporalidad:
//
//   · Agregar: una plantilla se crea al guardar un egreso marcado como "Fijo",
//     con vigencia = mes en que se guardó (no se materializa hacia atrás).
//   · Ocultar: es POR MES. El botón oculta/muestra la plantilla en el período
//     seleccionado sin afectar los demás meses. Esconder en julio deja junio y
//     agosto intactos.
//   · Eliminar: quita la plantilla por completo (todos los meses).
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS_ES = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
];

interface Props {
  /** Período actualmente seleccionado en /upload — sobre el que actúa
   *  "ocultar/mostrar este mes". */
  selectedPeriodId: string;
  /** Etiqueta del período (ej. "Jul 26") para los textos del botón. */
  selectedPeriodLabel: string;
  /** Callback tras un cambio para que /upload recargue egresos + plantillas. */
  onChanged?: () => void;
}

export function FixedExpenseTemplatesPanel({
  selectedPeriodId,
  selectedPeriodLabel,
  onChanged,
}: Props) {
  const { t } = useI18n();
  const { user } = useAuth();
  const { expenseTemplates, expenseTemplateHidden } = useData();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const userCanEdit = canEdit(user);
  const userCanDelete = canDelete(user);

  // Plantillas ocultas en el período seleccionado.
  const hiddenHere = new Set(
    expenseTemplateHidden
      .filter((h) => h.period_id === selectedPeriodId)
      .map((h) => h.template_id),
  );

  const handleToggleHidden = async (id: string, currentlyHidden: boolean) => {
    if (!selectedPeriodId) {
      toast.error('Selecciona un período primero');
      return;
    }
    setBusy(id);
    setErrMsg(null);
    try {
      if (currentlyHidden) {
        await unhideExpenseTemplateForPeriod(id, selectedPeriodId);
      } else {
        await hideExpenseTemplateForPeriod(id, selectedPeriodId);
      }
      onChanged?.();
      toast.success(
        currentlyHidden
          ? `Mostrada en ${selectedPeriodLabel}`
          : `Oculta en ${selectedPeriodLabel}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error';
      setErrMsg(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar plantilla para TODOS los meses? Esta acción no se puede deshacer.')) return;
    setBusy(id);
    setErrMsg(null);
    try {
      await deleteExpenseTemplate(id);
      onChanged?.();
      toast.success('Plantilla eliminada');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error';
      setErrMsg(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-6 pt-4 border-t border-border">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-left p-2 -mx-2 rounded hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Repeat className="w-4 h-4 text-violet-500" />
          <span className="text-sm font-semibold">{t('expenses.fixedTemplates')}</span>
          <span className="text-xs text-muted-foreground">({expenseTemplates.length})</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {open && (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground mb-3">
            Ocultar/mostrar aplica solo a <strong>{selectedPeriodLabel || 'este mes'}</strong>.
            Eliminar quita la plantilla de todos los meses.
          </p>

          {errMsg && (
            <div className="p-2 mb-2 rounded bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs">
              {errMsg}
            </div>
          )}

          {expenseTemplates.length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-4 text-center">
              No hay plantillas. Marca un egreso como &quot;Fijo&quot; al guardarlo para crear una.
            </p>
          ) : (
            <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
              <table className="w-full text-sm min-w-[440px]">
                <thead>
                  <tr className="border-b border-border text-xs">
                    <th className="text-left py-2 px-2 text-muted-foreground font-medium">Concepto</th>
                    <th className="text-right py-2 px-2 text-muted-foreground font-medium">Monto</th>
                    <th className="text-center py-2 px-2 text-muted-foreground font-medium">
                      En {selectedPeriodLabel || 'el mes'}
                    </th>
                    <th className="text-center py-2 px-2 text-muted-foreground font-medium">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {expenseTemplates.map((tpl) => {
                    const isHidden = hiddenHere.has(tpl.id);
                    const effLabel =
                      tpl.effective_from_year != null
                        ? `desde ${MONTHS_ES[(tpl.effective_from_month ?? 1) - 1]} ${String(tpl.effective_from_year).slice(2)}`
                        : null;
                    return (
                      <tr key={tpl.id} className="border-b border-border/50">
                        <td className="py-2 px-2 font-medium">
                          {tpl.concept}
                          {effLabel && (
                            <span className="block text-[10px] text-muted-foreground font-normal">
                              {effLabel}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right">{formatCurrency(tpl.amount)}</td>
                        <td className="py-2 px-2 text-center">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                              isHidden
                                ? 'bg-gray-100 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-800'
                                : 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                            }`}
                          >
                            {isHidden ? 'Oculta' : 'Visible'}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-center">
                          <div className="flex justify-center gap-1">
                            {userCanEdit && (
                              <button
                                onClick={() => handleToggleHidden(tpl.id, isHidden)}
                                disabled={busy === tpl.id || !selectedPeriodId}
                                className="p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded disabled:opacity-50"
                                title={isHidden ? `Mostrar en ${selectedPeriodLabel}` : `Ocultar en ${selectedPeriodLabel}`}
                                aria-label={isHidden ? 'Mostrar este mes' : 'Ocultar este mes'}
                              >
                                {isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                            )}
                            {userCanDelete && (
                              <button
                                onClick={() => handleDelete(tpl.id)}
                                disabled={busy === tpl.id}
                                className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded disabled:opacity-50"
                                title="Eliminar (todos los meses)"
                                aria-label="Eliminar"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
