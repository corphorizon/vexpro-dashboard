'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useData } from '@/lib/data-context';
import { useAuth, canEdit, canDelete } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { formatCurrency } from '@/lib/utils';
import {
  activateExpenseTemplate,
  deactivateExpenseTemplate,
  deleteExpenseTemplate,
} from '@/lib/supabase/mutations';
import { ChevronDown, ChevronUp, Repeat, Power, Trash2 } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Fixed Expense Templates Panel
//
// Collapsible panel inside the Egresos section of the upload page.
// Lets the user activate/deactivate/delete recurring expense templates.
// Templates marked active auto-load when a new period has no expenses yet.
// ─────────────────────────────────────────────────────────────────────────────

export function FixedExpenseTemplatesPanel() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { expenseTemplates, refresh } = useData();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const userCanEdit = canEdit(user);
  const userCanDelete = canDelete(user);

  const handleToggle = async (id: string, currentlyActive: boolean) => {
    setBusy(id);
    setErrMsg(null);
    try {
      if (currentlyActive) {
        await deactivateExpenseTemplate(id);
      } else {
        await activateExpenseTemplate(id);
      }
      await refresh();
      toast.success(currentlyActive ? 'Plantilla desactivada' : 'Plantilla activada');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error';
      setErrMsg(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar plantilla? Esta acción no se puede deshacer.')) return;
    setBusy(id);
    setErrMsg(null);
    try {
      await deleteExpenseTemplate(id);
      await refresh();
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
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-left p-2 -mx-2 rounded hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Repeat className="w-4 h-4 text-violet-500" />
          <span className="text-sm font-semibold">{t('expenses.fixedTemplates')}</span>
          <span className="text-xs text-muted-foreground">
            ({expenseTemplates.length})
          </span>
        </div>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {open && (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground mb-3">
            {t('expenses.fixedTemplatesHint')}
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
              <table className="w-full text-sm min-w-[420px]">
                <thead>
                  <tr className="border-b border-border text-xs">
                    <th className="text-left py-2 px-2 text-muted-foreground font-medium">Concepto</th>
                    <th className="text-right py-2 px-2 text-muted-foreground font-medium">Monto</th>
                    <th className="text-center py-2 px-2 text-muted-foreground font-medium">Estado</th>
                    <th className="text-center py-2 px-2 text-muted-foreground font-medium">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {expenseTemplates.map((tpl) => (
                    <tr key={tpl.id} className="border-b border-border/50">
                      <td className="py-2 px-2 font-medium">{tpl.concept}</td>
                      <td className="py-2 px-2 text-right">{formatCurrency(tpl.amount)}</td>
                      <td className="py-2 px-2 text-center">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                            tpl.active
                              ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                              : 'bg-gray-100 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-800'
                          }`}
                        >
                          {tpl.active ? 'Activa' : 'Inactiva'}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-center">
                        <div className="flex justify-center gap-1">
                          {userCanEdit && (
                            <button
                              onClick={() => handleToggle(tpl.id, tpl.active)}
                              disabled={busy === tpl.id}
                              className="p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded disabled:opacity-50"
                              title={tpl.active ? 'Desactivar' : 'Activar'}
                              aria-label={tpl.active ? 'Desactivar' : 'Activar'}
                            >
                              <Power className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {userCanDelete && (
                            <button
                              onClick={() => handleDelete(tpl.id)}
                              disabled={busy === tpl.id}
                              className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded disabled:opacity-50"
                              title="Eliminar"
                              aria-label="Eliminar"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
