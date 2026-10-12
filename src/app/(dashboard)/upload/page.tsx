'use client';

import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { Field, Input } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/utils';
import {
  PAGE_SIZE,
  PaginationControls,
  ClosedBadge,
  btnClass,
  INPUT_MOBILE,
  INPUT_NUM,
  ROW_BTN,
  ROW_BTN_DANGER,
  SUGGEST_ITEM,
  SUGGEST_LIST,
  TABLE,
  TD,
  TFOOT_TD,
  TH,
} from './_components/upload-ui';
import { DepositsPanel } from './_components/deposits-panel';
import { WithdrawalsPanel } from './_components/withdrawals-panel';
import { OperatingIncomePanel } from './_components/operating-income-panel';
import { MovementsLedger } from './_components/movements-ledger';
import { MovementFilters } from './_components/movement-filters';
import { SaveBar } from './_components/save-bar';
import { ExpenseReference } from '@/components/ui/expense-reference';
import { ExpenseAttachmentInput, type ExpenseAttachment } from '@/components/ui/expense-attachment-input';
import { ExpenseConcept } from '@/components/ui/expense-concept';
import { useData } from '@/lib/data-context';
import { useAuth, canAdd, canEdit, canDelete } from '@/lib/auth-context';
import { formatMoney } from '@/lib/money';
import { CHANNEL_LABELS, WITHDRAWAL_LABELS } from '@/lib/types';
import { ALL_DEPOSIT_CHANNELS } from '@/lib/deposit-channels';
import type { LiquidityMovement, Investment } from '@/lib/types';
import { Plus, Trash2, Edit2, Check, X, GripVertical, Upload } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// ─── Migración «Libro mayor» (2026-10-12) — SÓLO presentación ─────────────
// POR QUÉ: era la pantalla más grande del repo (3.913 líneas, 54 useState)
// y la de más color sin significado: 82 clases de paleta cruda, 23 `dark:` de
// color, 13 `text-[10px]/[11px]`, 125 tokens legados (`text-muted-foreground`,
// `text-positive`…), y el total de Depósitos en azul / Retiros en rojo.
// Medido con grep antes del cambio; después: 0 / 0 / 0 / 0 en código.
//
// QUÉ SE MOVIÓ (a `_components/`, piezas sin estado ni efectos que reciben
// callbacks con el MISMO código que tenía el JSX):
//   deposits-panel · withdrawals-panel (+ withdrawals-view.ts, el pie de
//   Retiros como función pura con test) · operating-income-panel ·
//   movements-ledger (Liquidez e Inversiones eran la misma tabla copiada) ·
//   movement-filters · save-bar · upload-ui (paginación, botones, badges).
// QUÉ NO SE MOVIÓ: TODO el estado, los efectos, la siembra de buffers y de la
// huella de egresos, `persistExpenses` / la cola `enqueueExpenseWrite`, el
// autosave, `saveAll` y los payloads (reglas §2.4 — los cuatro lugares por
// columna: este archivo sigue siendo el único que hidrata el estado).
// Y la pestaña Egresos se quedó acá, restilizada en el lugar: dnd-kit crea
// cada <tr> (`useSortable`), la fila en edición reemplaza todas sus celdas y
// el alta tiene dos autocompletados atados a refs de la página. Extraerla era
// pasar ~30 props por la pestaña con el guard de huella: el riesgo no pagaba
// las líneas que ahorraba.
//
// DESCARTADO: un aviso persistente del 409 de huella. Hoy el conflicto se
// marca en un ref (`expenseConflictPeriodRef`) y se informa con un toast; un
// <Notice> necesitaría un estado nuevo que se prenda y se apague en los mismos
// puntos que el ref, o sea tocar el manejo del guardado. Queda para un cambio
// propio.
import { logAction } from '@/lib/audit-log';
import { useI18n } from '@/lib/i18n';
import { useModuleAccess } from '@/lib/use-module-access';
import { useConfirm } from '@/lib/use-confirm';
import { FixedExpenseTemplatesPanel } from '@/components/fixed-expense-templates-panel';
import { useApiTotals } from '@/components/realtime-movements-banner';
import { useToasts } from '@/components/ui/toast';
import {
  isDerivedBrokerPeriod,
  computeDerivedBroker,
} from '@/lib/broker-logic';
import { useCrmMonthlyAuto } from '@/lib/use-crm-monthly-auto';
import { resolveAutoOrManual } from '@/lib/crm-auto-values';

/**
 * La única serie del espejo que este formulario consume: las comisiones IB.
 * Alimenta el SPLIT del broker derivado, no ningún total — ver el bloque de
 * `ibEffective` más abajo.
 */
const UPLOAD_CRM_AUTO_METRICS = ['ib_commissions'] as const;
import {
  parseAmount,
  findInvalidAmount,
  computeExpensePending,
} from '@/lib/upload-calculations';
import { useIncomeLines } from './_components/use-income-lines';
import { IncomeLinesSection } from './_components/income-lines-section';
import {
  upsertDeposits,
  upsertWithdrawals,
  upsertExpenses,
  updateExpenseOrder,
  upsertOperatingIncome,
  insertLiquidityMovement,
  updateLiquidityMovement,
  deleteLiquidityMovement as deleteLiqMutation,
  insertInvestment,
  updateInvestment,
  deleteInvestment as deleteInvMutation,
  upsertPropFirmSales,
  upsertP2PTransfers,
  applyFixedExpenseForward,
  ConflictoPeriodoError,
} from '@/lib/supabase/mutations';
import { huellaDeEgresosManuales, type HuellaEgresos } from '@/lib/expenses/huella-periodo';
import { FixedForwardDialog } from '@/components/ui/fixed-forward-dialog';
import { SELECTABLE_MOVEMENT_TYPES, inferMovementType } from '@/lib/investment-types';
import { formatDayMonth } from '@/lib/dates';
import { uploadSections, defaultUploadSection, features } from '@/lib/business-model';
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { apiFetch } from '@/lib/api-fetch';

type DataSection = 'depositos' | 'retiros' | 'egresos' | 'ingresos' | 'liquidez' | 'inversiones';

const SECTION_KEYS: Record<DataSection, string> = {
  depositos: 'upload.deposits',
  retiros: 'upload.withdrawals',
  egresos: 'upload.expenses',
  ingresos: 'upload.operatingIncome',
  liquidez: 'upload.liquidity',
  inversiones: 'upload.investments',
};

interface DepositRow { id: string; channel: string; amount: number; }
interface WithdrawalRow { id: string; category: string; amount: number; }
// expense_date (migration-056): 'YYYY-MM-DD' o null = sin fecha específica.
// payment_order_id: orden de pago que originó el egreso (null = manual). Tiene
// que viajar en el payload de guardado o el DELETE+INSERT de la RPC lo borra.
// payment_order_description: SOLO display (subtítulo bajo el concepto en la
// vista de lectura). Derivado en fetchExpenses desde la OP; no es columna de
// expenses y la RPC de guardado lo ignora aunque viaje en el payload.
interface ExpenseRow { id: string; concept: string; amount: number; paid: number; pending: number; is_fixed: boolean; category: string | null; expense_date: string | null; payment_order_id: string | null; payment_order_description?: string | null; reference: string | null; attachment_bucket: string | null; attachment_path: string | null; attachment_name: string | null; attachment_mime: string | null; attachment_size: number | null; attachment_uploaded_at: string | null; }

// ─── Sortable row wrapper (drag-and-drop reorder) ─────────────────────────
// Wraps each expense <tr> so it can be dragged via the leading handle
// column. We use @dnd-kit/sortable — the drag works by keyboard too
// (tab to the handle, space to pick up, arrow keys to move, space to
// drop), which keeps the feature accessible.
//
// Keep this component outside the main page so React doesn't recreate
// the hook instances on every parent render.
function SortableExpenseRow({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    // Keep the dragged row above its neighbours so the shadow reads right.
    zIndex: isDragging ? 10 : undefined,
    position: isDragging ? 'relative' : undefined,
  };

  return (
    <tr ref={setNodeRef} style={style} className={cn('hover:bg-row-hover', isDragging && 'bg-card shadow-2')}>
      <td
        className={cn(
          TD,
          'w-8 touch-none select-none text-text-3',
          disabled ? 'cursor-not-allowed opacity-30' : 'cursor-grab active:cursor-grabbing',
        )}
        {...(disabled ? {} : attributes)}
        {...(disabled ? {} : listeners)}
        aria-label={disabled ? 'Termina de editar para mover' : 'Arrastrar para reordenar'}
        title={disabled ? 'Termina de editar para mover' : 'Arrastrar para reordenar'}
      >
        <GripVertical aria-hidden className="size-4" />
      </td>
      {children}
    </tr>
  );
}
interface IncomeRow { prop_firm: number; broker_pnl: number; other: number; }

/**
 * Filas de la tabla de Depósitos, DERIVADAS del registro único
 * (`ALL_DEPOSIT_CHANNELS` en src/lib/deposit-channels.ts).
 *
 * ── POR QUÉ NO ES UNA LISTA A MANO (2026-08-31, auditoría de finanzas) ──────
 * Era una cuarta copia del par canal↔pantalla, y ya había divergido: le
 * faltaba `paypros`, habilitado en `deposits.channel` por la migración 105 y
 * presente en el registro desde entonces. La consecuencia no era solo cosmética.
 * Este estado es lo que se hidrata al abrir el período Y lo que se manda al
 * guardar, así que una fila `paypros` cargada por otra vía era INVISIBLE en la
 * pantalla y se BORRABA en el próximo guardado —la RPC reemplaza el período
 * entero desde el payload del cliente (§2.4 de docs/reglas-del-proyecto.md:
 * «cualquier columna nueva que no viaje en el payload se pierde en silencio»)—.
 * Derivándola, un canal nuevo aparece solo y deja de poder perderse.
 */
const INITIAL_DEPOSITS: DepositRow[] = ALL_DEPOSIT_CHANNELS.map((channel, i) => ({
  id: `d${i + 1}`,
  channel,
  amount: 0,
}));

const INITIAL_WITHDRAWALS: WithdrawalRow[] = [
  { id: 'w1', category: 'ib_commissions', amount: 0 },
  { id: 'w2', category: 'broker', amount: 0 },
  { id: 'w3', category: 'prop_firm', amount: 0 },
  { id: 'w4', category: 'other', amount: 0 },
];


const STORAGE_KEYS = {
};

const getPerPeriodKey = (section: string, periodId: string) => `fd_data_${section}_${periodId}`;

function loadFromStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    console.warn('Failed to save to localStorage:', key);
  }
}


export default function UploadPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { periods, allDeposits, allWithdrawals, allExpenses, expenseTemplates, expenseTemplateHidden, allOperatingIncome, allPropFirmSales, allP2PTransfers, getLiquidityData, getInvestmentsData, company, refresh, refreshSections } = useData();
  // (No hay `isAdmin` acá a propósito: los gates de esta pantalla son
  // canAdd/canEdit/canDelete, que sí contemplan al superadmin en modo
  // "viendo como". `user.role === 'admin'` a mano lo dejaba afuera.)
  const userCanAdd = canAdd(user);
  const userCanEdit = canEdit(user);
  const userCanDelete = canDelete(user);

  const [selectedPeriod, setSelectedPeriod] = useState(periods[periods.length - 1]?.id || '');

  // ── Pestañas según el modelo de negocio ───────────────────────────────
  // El registro decide cuáles existen y en qué orden: para un broker devuelve
  // el mismo orden de siempre (su pantalla no se mueve) y para una consultora
  // arranca por Ingresos, sin Depósitos ni Retiros.
  const allowedSections = useMemo(
    () => uploadSections(company?.business_model) as DataSection[],
    [company?.business_model],
  );
  // `defaultUploadSection` puede devolver null (un modelo que no carga datos:
  // el proveedor de liquidez). Esa cadena vacía no se usa nunca —el módulo
  // `upload` está bloqueado para ese modelo y el guard devuelve 403 antes—,
  // pero se escribe explícita: antes la firma decía `: string` y devolvía
  // `undefined` sin que nada se quejara.
  const [section, setSection] = useState<DataSection>(
    () => (defaultUploadSection(company?.business_model) ?? '') as DataSection,
  );
  // Prop Firm y P&L del broker viven dentro de la pestaña Ingresos aunque
  // pertenezcan al negocio de broker: se apagan por feature, no por pestaña.
  const modelFeatures = features(company?.business_model);
  const showBrokerPnl = modelFeatures.brokerPnl;
  const showWithdrawals = modelFeatures.withdrawals;
  // `company` llega después del primer render (y cambia si un superadmin salta
  // de empresa): sin este reajuste la pestaña activa puede quedar apuntando a
  // una sección que el modelo no tiene y la pantalla se ve vacía.
  useEffect(() => {
    if (allowedSections.length === 0) return;
    if (!allowedSections.includes(section)) setSection(allowedSections[0]);
  }, [allowedSections, section]);

  // ── Dirty-state tracker for "Guardar Todo" sections ───────────────────
  // Egresos / Depósitos / Retiros / Ingresos keep unsaved changes in local
  // state until the user clicks "Guardar Todo". Users kept losing rows
  // because there was no visual signal that an action (add/edit/delete)
  // had not been persisted yet. This ref-based flag drives:
  //   · a banner shown next to the save button,
  //   · a guard that prevents the silent refresh sync-effect from wiping
  //     unsaved local state.
  // Dirty tracking — multi-section.
  //
  // Originally `dirtySection: DataSection | null` (one slot). That had a
  // CRITICAL bug Kevin reported on 2026-05-13: if `saveAll('egresos')`
  // failed mid-batch, the catch surfaced a toast but never cleared the
  // dirty flag. The sync effect at line ~360 — guarded by
  // `if (dirtySection) return` — then refused to re-hydrate ANY section
  // (deposits, withdrawals, ingresos) from the DataProvider, since they
  // all shared the same flag. A failed save in Egresos froze the entire
  // page until a hard reload.
  //
  // Now: a Set of dirty sections. Each section's sync is gated only by
  // its OWN dirty entry, so a failure in Egresos doesn't block Deposits
  // from refreshing on period change. And on save success we clear ONLY
  // the section that was saved — preserving any cross-section work-in-
  // progress the user may have started before clicking "Guardar todo".
  const [dirtySections, setDirtySectionsRaw] = useState<Set<DataSection>>(() => new Set());

  // Contador de PULSACIONES, no de secciones sucias.
  //
  // `dirtySections` está memoizado a propósito (si la sección ya está sucia
  // devuelve el MISMO Set), así que su identidad no cambia entre tecla y
  // tecla. El debounce del autosave dependía solo de él: se armaba con el
  // primer carácter y NUNCA se reiniciaba, así que a los 3 s guardaba lo
  // tipeado hasta ahí y el re-sync re-hidrataba el input con eso. Escribir
  // "12345" a ritmo humano dejaba "1" guardado — reportado por Kevin y
  // reproducido en e2e/upload-autosave.spec.ts.
  //
  // Este contador cambia en CADA edición, de ahí que el timer se reinicie de
  // verdad. Los ticks por sección permiten además saber si el usuario siguió
  // escribiendo mientras el guardado estaba en vuelo.
  const [editTick, setEditTick] = useState(0);
  const sectionTicksRef = useRef<Record<string, number>>({});

  const markDirty = useCallback((s: DataSection) => {
    sectionTicksRef.current[s] = (sectionTicksRef.current[s] ?? 0) + 1;
    setEditTick((n) => n + 1);
    setDirtySectionsRaw(prev => {
      if (prev.has(s)) return prev;
      const next = new Set(prev);
      next.add(s);
      return next;
    });
  }, []);
  const clearDirty = useCallback((s: DataSection) => {
    setDirtySectionsRaw(prev => {
      if (!prev.has(s)) return prev;
      const next = new Set(prev);
      next.delete(s);
      return next;
    });
  }, []);
  // Back-compat: most of the existing code only checks "is anything
  // dirty?" — keep a derived helper so we don't have to touch every site.
  const hasDirty = dirtySections.size > 0;

  // Auto-pick the latest period once `periods` loads asynchronously. On a
  // cold page hit the DataProvider is still fetching → `periods` is empty
  // → `selectedPeriod` gets initialized as ''. Without this effect the
  // <select> stays empty forever and the tables render blank, which the
  // user perceives as "loading never ends".
  useEffect(() => {
    if (!selectedPeriod && periods.length > 0) {
      setSelectedPeriod(periods[periods.length - 1].id);
    }
  }, [periods, selectedPeriod]);

  // --- Per-period data helpers (Supabase is source of truth) ---
  const loadDepositsForPeriod = useCallback((periodId: string): DepositRow[] => {
    const periodDeposits = allDeposits.filter(d => d.period_id === periodId);
    return INITIAL_DEPOSITS.map(init => {
      const match = periodDeposits.find(d => d.channel === init.channel);
      return { ...init, amount: match?.amount || 0 };
    });
  }, [allDeposits]);

  const loadWithdrawalsForPeriod = useCallback((periodId: string): WithdrawalRow[] => {
    // Aggregate rows are the ones without a description.
    const periodWithdrawals = allWithdrawals.filter(w => w.period_id === periodId && !w.description);
    return INITIAL_WITHDRAWALS.map(init => {
      const match = periodWithdrawals.find(w => w.category === init.category);
      return { ...init, amount: match?.amount || 0 };
    });
  }, [allWithdrawals]);

  // Extra manual withdrawal entries — rows with a description in DB.
  // Shown below the fixed 4 aggregates so users can register individual
  // manual withdrawals alongside what the APIs report.
  interface ExtraWithdrawalRow {
    id: string;
    category: 'ib_commissions' | 'broker' | 'prop_firm' | 'other';
    amount: number;
    description: string;
  }
  const loadWithdrawalExtrasForPeriod = useCallback((periodId: string): ExtraWithdrawalRow[] => {
    return allWithdrawals
      .filter(w => w.period_id === periodId && !!w.description)
      .map(w => ({ id: w.id, category: w.category, amount: w.amount, description: w.description || '' }));
  }, [allWithdrawals]);

  const loadExpensesForPeriod = useCallback((periodId: string): ExpenseRow[] => {
    const periodExpenses = allExpenses.filter(e => e.period_id === periodId);

    // If the period already has expenses saved, return them as-is
    if (periodExpenses.length > 0) {
      return periodExpenses.map(e => ({
        id: e.id,
        concept: e.concept,
        amount: e.amount,
        paid: e.paid,
        pending: e.pending,
        is_fixed: !!e.is_fixed,
        category: e.category ?? null,
        expense_date: e.expense_date ?? null,
        payment_order_id: e.payment_order_id ?? null,
        payment_order_description: e.payment_order_description ?? null,
        // migration-060 — la RPC re-inserta el período entero desde este
        // payload: si la referencia no viaja acá, se borra sola al guardar.
        reference: e.reference ?? null,
        // El adjunto tambien tiene que dar la vuelta completa. Un egreso que
        // heredo el comprobante de una orden de pago perderia el archivo al
        // primer guardado del mes si estos campos no viajaran de ida y vuelta.
        attachment_bucket: e.attachment_bucket ?? null,
        attachment_path: e.attachment_path ?? null,
        attachment_name: e.attachment_name ?? null,
        attachment_mime: e.attachment_mime ?? null,
        attachment_size: e.attachment_size ?? null,
        attachment_uploaded_at: e.attachment_uploaded_at ?? null,
      }));
    }

    // Otherwise, pre-load active fixed expense templates as starting rows.
    //
    // Kevin (2026-06-06): los gastos fijos al pasar al mes siguiente deben
    // CONSERVAR la categoría que tenían el mes anterior — antes se cargaban
    // con category=null y había que re-asignar manualmente cada mes.
    //
    // Estrategia sin migration: para cada template, buscar el expense más
    // reciente con el MISMO concept (en cualquier período anterior) y
    // heredar su category. Cadena natural: si en mayo asignaste
    // "Office Rent - Mexico" → "Operating Expense", junio la hereda
    // automáticamente; si en junio la cambias a "Rent", julio hereda esa.
    const conceptCategoryMap = new Map<string, string | null>();
    const sortedExpenses = [...allExpenses].sort((a, b) => {
      const pa = periods.find(p => p.id === a.period_id);
      const pb = periods.find(p => p.id === b.period_id);
      if (!pa || !pb) return 0;
      if (pa.year !== pb.year) return pb.year - pa.year;
      return pb.month - pa.month;
    });
    for (const e of sortedExpenses) {
      if (!conceptCategoryMap.has(e.concept)) {
        conceptCategoryMap.set(e.concept, e.category ?? null);
      }
    }

    // Vigencia + ocultamiento por mes (migration-050). El preview debe
    // coincidir con lo que la RPC materialize_fixed_expenses inserta:
    //   · effective_from: una plantilla creada en julio no aparece en meses
    //     anteriores (NULL = siempre, retro-compat).
    //   · hidden override: si la plantilla está oculta en ESTE período, no
    //     se muestra (aunque esté activa).
    const targetPeriod = periods.find(p => p.id === periodId);
    const hiddenTplIds = new Set(
      expenseTemplateHidden
        .filter(h => h.period_id === periodId)
        .map(h => h.template_id),
    );
    const applicableTemplates = expenseTemplates.filter(tpl => {
      if (!tpl.active) return false;
      if (hiddenTplIds.has(tpl.id)) return false;
      // effective_from: NULL = siempre. Si tiene fecha, el período destino
      // debe ser >= a ella.
      if (tpl.effective_from_year != null && targetPeriod) {
        const efY = tpl.effective_from_year;
        const efM = tpl.effective_from_month ?? 1;
        if (targetPeriod.year < efY) return false;
        if (targetPeriod.year === efY && targetPeriod.month < efM) return false;
      }
      return true;
    });
    return applicableTemplates.map((tpl, i) => ({
      id: `tpl-${tpl.id}-${i}`,
      concept: tpl.concept,
      amount: tpl.amount,
      paid: 0,
      pending: tpl.amount,
      is_fixed: true,
      category: conceptCategoryMap.get(tpl.concept) ?? null,
      // Las plantillas no tienen día: la fecha se pone a mano si hace falta.
      expense_date: null,
      reference: null,
      attachment_bucket: null,
      attachment_path: null,
      attachment_name: null,
      attachment_mime: null,
      attachment_size: null,
      attachment_uploaded_at: null,
      // Una plantilla fija no nace de una orden de pago.
      payment_order_id: null,
    }));
  }, [allExpenses, expenseTemplates, expenseTemplateHidden, periods]);

  const loadIncomeForPeriod = useCallback((periodId: string): IncomeRow => {
    const periodIncome = allOperatingIncome.find(oi => oi.period_id === periodId);
    return { prop_firm: periodIncome?.prop_firm || 0, broker_pnl: periodIncome?.broker_pnl || 0, other: periodIncome?.other || 0 };
  }, [allOperatingIncome]);

  // Data state (persisted to localStorage per period)
  const lastPeriodId = periods[periods.length - 1]?.id || '';
  const [deposits, setDepositsRaw] = useState<DepositRow[]>(() => loadDepositsForPeriod(lastPeriodId));
  const [withdrawals, setWithdrawalsRaw] = useState<WithdrawalRow[]>(() => loadWithdrawalsForPeriod(lastPeriodId));
  const [withdrawalExtras, setWithdrawalExtras] = useState<ExtraWithdrawalRow[]>(() => loadWithdrawalExtrasForPeriod(lastPeriodId));
  const [newExtraWithdrawal, setNewExtraWithdrawal] = useState<{ category: 'ib_commissions' | 'broker' | 'prop_firm' | 'other'; amount: string; description: string }>({
    category: 'broker',
    amount: '',
    description: '',
  });
  const [expenses, setExpensesRaw] = useState<ExpenseRow[]>(() => loadExpensesForPeriod(lastPeriodId));
  const [income, setIncomeRaw] = useState<IncomeRow>(() => loadIncomeForPeriod(lastPeriodId));
  const [propFirmAmount, setPropFirmAmount] = useState<number>(() => allPropFirmSales.find(p => p.period_id === lastPeriodId)?.amount || 0);
  const [p2pAmount, setP2PAmount] = useState<number>(() => allP2PTransfers.find(p => p.period_id === lastPeriodId)?.amount || 0);

  // ARCHITECTURE NOTE: We use a ref to track selectedPeriod in setDeposits/setWithdrawals/etc.
  // callbacks. This avoids stale closures without adding selectedPeriod to useCallback deps
  // (which would recreate callbacks on every period change and break ongoing edits).
  // The ref is kept in sync via useEffect below. If refactoring, ensure callbacks always
  // read selectedPeriodRef.current for the storage key, never the state variable directly.
  const selectedPeriodRef = useRef(selectedPeriod);
  useEffect(() => { selectedPeriodRef.current = selectedPeriod; }, [selectedPeriod]);

  // Período cerrado (migración 061): el trigger de la base rechaza TODA
  // escritura. Sin este flag, la pantalla dejaba editar normalmente y el
  // autosave chocaba contra el trigger cada 3 segundos en bucle infinito de
  // toasts genéricos (auditoría 2026-08-06, hallazgo prioritario).
  const selectedPeriodIsClosed = !!periods.find((p) => p.id === selectedPeriod)?.is_closed;
  const canManagePeriods = useModuleAccess('periods');

  // ── El número que el CRM ya tiene, al lado del campo que se teclea ───────
  // Ventas Prop Firm y Transferencias P2P se cargan a mano acá, y el CRM las
  // tiene calculadas al centavo (migración 100, /finanzas/crm). Se muestra
  // como PISTA, nunca como autocompletado: pisar lo que alguien escribió es
  // exactamente lo que este repo no hace. Medido: en 6 de los 9 meses
  // cerrados de Vex Pro el manual y el automático ya son idénticos, así que
  // la pista casi siempre confirma; los meses en que difiere son los que hay
  // que mirar.
  const [crmTotals, setCrmTotals] = useState<Array<{ year: number; month: number; metric: string; auto: number | null }>>([]);
  useEffect(() => {
    let alive = true;
    apiFetch('/api/admin/crm-monthly-totals')
      .then((r) => r.json())
      .then((j: { success?: boolean; rows?: Array<{ year: number; month: number; metric: string; auto: number | null }> }) => {
        if (alive && j?.success) setCrmTotals(j.rows ?? []);
      })
      // Que falle no puede romper la carga de datos: sin pista se sigue
      // cargando igual, que es como funcionó hasta hoy.
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const crmHint = (metric: string): number | null => {
    const p = periods.find((x) => x.id === selectedPeriod);
    if (!p) return null;
    const row = crmTotals.find((r) => r.metric === metric && r.year === p.year && r.month === p.month);
    // `undefined` (no hay fila) y `null` (no se pudo calcular) se tratan
    // igual acá: en los dos casos no hay pista que mostrar.
    return row?.auto ?? null;
  };

  // ── Huella del período: guard anti-pisón de egresos (2026-10-08) ─────
  // El guardado de egresos reemplaza el período entero con este buffer
  // (replace_period_expenses, reglas §2.4). El 2026-10-08 una pestaña vieja
  // de Horizon pisó así "Pago soporte hector" ($3,500) y "FX Expo Argentina"
  // ($2,500), creados minutos antes desde otra pestaña — sin error ni log.
  // Ahora cada siembra del buffer guarda también la HUELLA de las filas de
  // las que salió (lib/expenses/huella-periodo.ts); el guardado la manda como
  // `baseline` y el server responde 409 si el período ya no es ese.
  //   · Buffer y huella se siembran JUNTOS, de las mismas filas: una huella
  //     más nueva que el buffer abriría el agujero que esto cierra.
  //   · Tras un guardado exitoso la huella se re-sincroniza con la que
  //     devuelve el server (los guardados en cola parten de ella).
  //   · expensesBufferPeriodRef: de qué período son las filas en pantalla.
  //     Mientras hay guardados en vuelo el buffer no se re-siembra, así que
  //     tras cambiar de mes puede seguir mostrando el anterior un instante.
  //   · expenseConflictPeriodRef: período con un 409 vigente. Su buffer NO se
  //     re-siembra para no borrar lo que el usuario tecleó; sale recargando o
  //     cambiando de mes.
  const expenseBaselinesRef = useRef(new Map<string, HuellaEgresos>());
  const expensesBufferPeriodRef = useRef<string | null>(null);
  const expenseConflictPeriodRef = useRef<string | null>(null);

  // Reload data when the PERIOD changes. Intentionally depends only on
  // `selectedPeriod` (and `dirtySection`). Earlier this effect also listed
  // the `loadXForPeriod` callbacks + raw `allExpenses` etc. as deps — but
  // those references change on every silent refresh of the DataProvider.
  // That turned any background refresh into a surprise reset of local
  // state: the user adds an egreso row, a refresh fires for an unrelated
  // reason, this effect re-runs, and the unsaved row disappears.
  //
  // Now we re-sync local state only when the user explicitly switches
  // period (or when leaving a dirty section — the save handler resets
  // `dirtySection` to null, which triggers a clean re-sync from the new
  // DB state).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Per-section guard. A failed save in one tab doesn't block re-sync
    // in the others (see dirtySections rationale above). Each block also
    // independently re-syncs when the user switches period.
    if (!dirtySections.has('depositos')) {
      setDepositsRaw(loadDepositsForPeriod(selectedPeriod));
    }
    if (!dirtySections.has('retiros')) {
      setWithdrawalsRaw(loadWithdrawalsForPeriod(selectedPeriod));
      setWithdrawalExtras(loadWithdrawalExtrasForPeriod(selectedPeriod));
      // P2P transfer lives in the Retiros tab — share its dirty bucket.
      setP2PAmount(allP2PTransfers.find(p => p.period_id === selectedPeriod)?.amount || 0);
    }
    if (!dirtySections.has('egresos') && expenseConflictPeriodRef.current !== selectedPeriod) {
      // Siembra del buffer + su huella, de las MISMAS filas (ver arriba).
      // Cambiar de mes deja atrás cualquier conflicto del mes anterior: al
      // volver se re-siembra desde lo que haya y, si sigue viejo, el próximo
      // guardado vuelve a dar 409.
      expenseConflictPeriodRef.current = null;
      expenseBaselinesRef.current.set(
        selectedPeriod,
        huellaDeEgresosManuales(allExpenses.filter(e => e.period_id === selectedPeriod)),
      );
      expensesBufferPeriodRef.current = selectedPeriod;
      setExpensesRaw(loadExpensesForPeriod(selectedPeriod));
    }
    if (!dirtySections.has('ingresos')) {
      setIncomeRaw(loadIncomeForPeriod(selectedPeriod));
      // Prop Firm sales sit in the Ingresos tab — share its dirty bucket.
      setPropFirmAmount(allPropFirmSales.find(p => p.period_id === selectedPeriod)?.amount || 0);
    }
  }, [selectedPeriod, dirtySections]);

  // Wrapped setters — every user-driven mutation also flags the section as
  // dirty. The sync effect bypasses these wrappers and calls the Raw
  // setters directly, so the initial hydration doesn't flip the flag.
  const setDeposits = useCallback((updater: DepositRow[] | ((prev: DepositRow[]) => DepositRow[])) => {
    setDepositsRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
    markDirty('depositos');
  }, [markDirty]);
  const setWithdrawals = useCallback((updater: WithdrawalRow[] | ((prev: WithdrawalRow[]) => WithdrawalRow[])) => {
    setWithdrawalsRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
    markDirty('retiros');
  }, [markDirty]);
  const setExpenses = useCallback((updater: ExpenseRow[] | ((prev: ExpenseRow[]) => ExpenseRow[])) => {
    setExpensesRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
    markDirty('egresos');
  }, [markDirty]);
  const setIncome = useCallback((updater: IncomeRow | ((prev: IncomeRow) => IncomeRow)) => {
    setIncomeRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
    markDirty('ingresos');
  }, [markDirty]);

  // ── Broker derived-logic helpers ──
  // For April 2026+ the broker amount is no longer entered by hand: it's
  // computed from the Coinsbuy API withdrawals minus the other manual
  // categories, and the input is rendered read-only. Historical periods
  // keep their stored broker value exactly as it was — we NEVER write back
  // over it from this page.
  const currentPeriodObj = useMemo(
    () => periods.find((p) => p.id === selectedPeriod),
    [periods, selectedPeriod]
  );
  const brokerIsDerived = currentPeriodObj
    ? isDerivedBrokerPeriod(currentPeriodObj)
    : false;

  // Date bounds of the current period → feed the API totals hook.
  const { brokerApiFrom, brokerApiTo } = useMemo(() => {
    if (!brokerIsDerived || !currentPeriodObj) {
      return { brokerApiFrom: '', brokerApiTo: '' };
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    const y = currentPeriodObj.year;
    const m = currentPeriodObj.month;
    const lastDay = new Date(y, m, 0).getDate();
    return {
      brokerApiFrom: `${y}-${pad(m)}-01`,
      brokerApiTo: `${y}-${pad(m)}-${pad(lastDay)}`,
    };
  }, [brokerIsDerived, currentPeriodObj]);

  // Kevin (2026-06-06): pasamos default_wallet_id para que el cálculo
  // del "broker derivado" considere SOLO la wallet principal (en Vex Pro
  // = 1079 VexPro Main Wallet) y no incluya retiros de wallets ajenas
  // (Exura Prime, AP MARKETS, Savings) que también aparecen en
  // api_transactions del tenant. Sin este filtro el broker se inflaba.
  const brokerApiTotals = useApiTotals(
    brokerApiFrom,
    brokerApiTo,
    company?.default_wallet_id ?? '',
  );

  // ── Comisiones IB: el automático del espejo alimenta el SPLIT ──────────────
  // (2026-08-31, auditoría de finanzas, ítem 18)
  //
  // `computeDerivedBroker` reparte el retiro que reportó la API entre Broker, IB,
  // Prop Firm y Otros: Broker = API − IB − PropFirm − Otros. La categoría IB
  // está VACÍA desde abril, así que el resto —$125.000 a $180.000 por mes que la
  // API sí reporta como salida— se atribuía entero a «Broker». El total nunca
  // estuvo mal; la ETIQUETA sí, todos los meses, y es la que después se lee para
  // entender a dónde se fue la plata.
  //
  // Alimentarlo con el automático corrige el split SIN mover ningún total:
  //   · «Retiros Totales» de /movimientos = API + manual Broker. No toca esto.
  //   · El total del pie de ESTE formulario = Σ categorías + broker derivado.
  //     Como la fila de IB de abajo muestra el MISMO valor efectivo que se le
  //     resta acá, los dos movimientos se cancelan y el total queda idéntico.
  //     Si sólo se cambiara una de las dos puntas, el pie bajaría $180.000 sin
  //     que hubiera pasado nada — por eso van juntas.
  //
  // SÓLO EN PERÍODOS ABIERTOS. Un período cerrado congeló sus insumos y su
  // distribución ya se calculó con el split viejo; cambiarle la cara hoy haría
  // que el papel firmado y la pantalla no coincidan. En cerrados se sigue
  // usando el manual, tal cual estaba.
  const crmAuto = useCrmMonthlyAuto(
    currentPeriodObj ? [currentPeriodObj] : [],
    UPLOAD_CRM_AUTO_METRICS,
  );
  const ibEffective = useMemo(() => {
    const manual = withdrawals.find((w) => w.category === 'ib_commissions')?.amount || 0;
    if (!brokerIsDerived || selectedPeriodIsClosed) {
      return { value: manual, source: 'manual' as const };
    }
    return resolveAutoOrManual({
      derived: true,
      manual,
      auto: crmAuto.auto.ib_commissions ?? null,
    });
  }, [brokerIsDerived, selectedPeriodIsClosed, withdrawals, crmAuto.auto.ib_commissions]);

  // Live-computed broker. Re-runs as the user edits IB / Prop Firm / Otros.
  const derivedBrokerAmount = useMemo(() => {
    if (!brokerIsDerived) return 0;
    const pf = withdrawals.find((w) => w.category === 'prop_firm')?.amount || 0;
    const other = withdrawals.find((w) => w.category === 'other')?.amount || 0;
    return computeDerivedBroker({
      apiWithdrawalsTotal: brokerApiTotals.withdrawalsTotal,
      ibCommissions: ibEffective.value,
      propFirm: pf,
      other,
    });
  }, [brokerIsDerived, withdrawals, brokerApiTotals.withdrawalsTotal, ibEffective.value]);

  // Liquidez state (from Supabase)
  const [liquidityRows, setLiquidityRowsRaw] = useState<LiquidityMovement[]>(() => [...getLiquidityData()]);
  const setLiquidityRows = useCallback((updater: LiquidityMovement[] | ((prev: LiquidityMovement[]) => LiquidityMovement[])) => {
    setLiquidityRowsRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);

  const [liqDateFrom, setLiqDateFrom] = useState('');
  const [liqDateTo, setLiqDateTo] = useState('');
  const [liqPeriodFilter, setLiqPeriodFilter] = useState('todos');
  const [liqSortAsc, setLiqSortAsc] = useState(true);
  const [editingLiqId, setEditingLiqId] = useState<string | null>(null);
  const [editLiq, setEditLiq] = useState({ date: '', user_email: '', mt_account: '', deposit: '', withdrawal: '' });
  const [newLiq, setNewLiq] = useState({ date: '', user_email: '', mt_account: '', deposit: '', withdrawal: '' });

  // Inversiones state (from Supabase)
  const [investmentRows, setInvestmentRowsRaw] = useState<Investment[]>(() => [...getInvestmentsData()]);
  const setInvestmentRows = useCallback((updater: Investment[] | ((prev: Investment[]) => Investment[])) => {
    setInvestmentRowsRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);
  const [invDateFrom, setInvDateFrom] = useState('');
  const [invDateTo, setInvDateTo] = useState('');
  const [invPeriodFilter, setInvPeriodFilter] = useState('todos');
  const [invSortAsc, setInvSortAsc] = useState(true);
  const [editingInvId, setEditingInvId] = useState<string | null>(null);
  const [editInv, setEditInv] = useState({ date: '', concept: '', responsible: '', deposit: '', withdrawal: '', profit: '' });
  const [newInv, setNewInv] = useState({ date: '', concept: '', responsible: '', deposit: '', withdrawal: '', profit: '', movement_type: '' });

  // Stiven (2026-06-19): Bug "tabs vacíos en Carga de Datos".
  //
  // El useState lazy-init de `liquidityRows` / `investmentRows` solo corre en
  // el MOUNT. Si DataContext aún estaba cargando cuando esta página renderizó,
  // los arrays quedaban en [] para siempre — la tabla salía vacía aunque la
  // BD tuviera datos. Cualquier edit/save subsiguiente sí hacía
  // `setInvestmentRowsRaw([...getInvestmentsData()])`, así que la página
  // "se arreglaba sola" con una interacción — eso explica la intermitencia.
  //
  // Solución: sincronizar desde DataContext con un useEffect cuando llegue
  // data nueva, PERO solo si el usuario no está editando una fila (para no
  // pisarle el formulario en medio de una edición).
  const investmentsFromCtx = getInvestmentsData();
  useEffect(() => {
    if (editingInvId === null) {
      setInvestmentRowsRaw([...investmentsFromCtx]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [investmentsFromCtx.length, editingInvId]);

  const liquidityFromCtx = getLiquidityData();
  useEffect(() => {
    if (editingLiqId === null) {
      setLiquidityRowsRaw([...liquidityFromCtx]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liquidityFromCtx.length, editingLiqId]);

  // UI state — shared confirmation dialog for destructive deletes.
  const { confirm, Modal: ConfirmModal } = useConfirm();
  const [newExpense, setNewExpense] = useState({ concept: '', amount: '', paid: '', pending: '', is_fixed: false, category: '', expense_date: '', reference: '', attachment: null as ExpenseAttachment | null });
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [editExpense, setEditExpense] = useState({ concept: '', amount: '', paid: '', pending: '', is_fixed: false, category: '', expense_date: '', reference: '', attachment: null as ExpenseAttachment | null });

  // Egreso fijo recién editado, esperando que el usuario elija el alcance
  // ("solo este mes" / "este mes y los siguientes"). Ver FixedForwardDialog.
  // Se guarda el concepto VIEJO: es la clave con la que el backend encuentra la
  // plantilla y las filas de los meses futuros (los egresos no tienen template_id).
  const [forwardPending, setForwardPending] = useState<
    { oldConcept: string; concept: string; amount: number; category: string | null } | null
  >(null);
  const [savingAll, setSavingAll] = useState(false);

  // Per-module "saving" locks for Liquidez / Inversiones row handlers.
  // We used to fire-and-forget the mutation inside an IIFE with no local
  // state — a network hang left the UI frozen (form not clearing, row
  // stuck in edit mode) without any error surfaced to the user. Now every
  // mutation goes through `withRowTimeout` (10s hard cap) + a boolean
  // lock that disables the relevant buttons while in-flight.
  const [savingLiq, setSavingLiq] = useState(false);
  const [savingInv, setSavingInv] = useState(false);

  // Per-row saving locks for Depósitos / Retiros inline edits.
  // Kevin reported (2026-05-13) that updateDeposit/updateWithdrawal had no
  // visible feedback while the upsert was in flight — users assumed the
  // save hadn't happened and hard-refreshed mid-write. The Set keys are
  // the deposit-row / withdrawal-row IDs, so we can disable the input
  // for just the row being saved (the rest of the table stays editable).
  const [savingDepositIds, setSavingDepositIds] = useState<Set<string>>(() => new Set());
  const [savingWithdrawalIds, setSavingWithdrawalIds] = useState<Set<string>>(() => new Set());

  // beforeunload guard — warn the user before they close the tab / hit
  // back / hard-reload while there are unsaved edits in the local state.
  // The browser shows its own native prompt; we only need to set
  // `returnValue` on the event (modern browsers ignore the custom string
  // and show their own copy). The handler is detached when nothing is
  // dirty so the user can leave freely in the common case.
  useEffect(() => {
    if (!hasDirty && !savingAll) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Required for Chrome — must set returnValue to a truthy string.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasDirty, savingAll]);

  // ── Auto-save (debounced) ─────────────────────────────────────────────
  //
  // Kevin (2026-06-07): "sería bueno que cada vez que haga un cambio vaya
  // guardando así evitamos eso" — after losing the "Guardar Todo" race
  // twice in a row.
  //
  // Design:
  //   · Watch the dirty set + current section. When the current section
  //     is dirty, start a 3-second debounce timer.
  //   · Any further edit restarts the timer (debounce). So a user typing
  //     continuously triggers ONE save, not one-per-keystroke.
  //   · If a save is already in flight (`savingAll`), the timer is held
  //     off — the existing save will flush whatever's dirty when it
  //     finishes; if edits happened during it, this effect re-fires.
  //   · Cleanup on unmount or section change so we don't fire a save for
  //     a section that isn't visible.
  //
  // The "Guardar Todo" button stays — explicit save is still available
  // for users who want it. Autosave is additive: the button just becomes
  // the manual override.
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const AUTOSAVE_DEBOUNCE_MS = 3000;

  useEffect(() => {
    // BUG-03: autosave persiste las secciones batch con cambios sin guardar,
    // aunque el usuario haya cambiado de pestaña. saveAll guarda la unión de
    // secciones dirty (ver targets).
    //
    // Exclusiones:
    //   · egresos → persiste por-acción (persistExpenses); su dirty transitorio
    //     es un mutex, no un pendiente.
    //   · ingresos volvió al autosave (2026-08-09): se había excluido porque
    //     "autosalvar a los 3s interrumpía la escritura y re-hidrataba el valor
    //     a medio tipear" — ese era el bug del debounce que nunca se
    //     reiniciaba, ahora arreglado de raíz (ver editTick).
    //   · las secciones que el modelo de la empresa no tiene: nunca hay estado
    //     que persistir y guardarlas sobrescribiría con vacío.
    const AUTOSAVE_SECTIONS: DataSection[] = (['depositos', 'retiros', 'ingresos'] as DataSection[])
      .filter((s) => allowedSections.includes(s));
    if (selectedPeriodIsClosed) return; // mes cerrado: el trigger rechazaría cada intento
    if (!AUTOSAVE_SECTIONS.some((s) => dirtySections.has(s))) return;
    if (savingAll) return; // queue up: re-fires when savingAll flips false
    const t = setTimeout(() => {
      // saveAll handles the savingAll lock + error surfacing internally.
      // Fire-and-forget: any error becomes the same toast the manual
      // button produces, so the user sees identical feedback.
      void saveAll();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // saveAll NO va en deps — se recrea en cada render y anularía el debounce;
    // captura `section`/estado por closure. No dependemos de `section`: cambiar
    // de pestaña ya no cancela un guardado pendiente (ese era el bug).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtySections, savingAll, selectedPeriodIsClosed, editTick, allowedSections]);

  // ── End auto-save ─────────────────────────────────────────────────────

  // 25-second hard ceiling around each row-level mutation. The DB itself
  // is fast (~6 ms for a single INSERT), but in real-world conditions the
  // total wall-time can stretch when:
  //   · the user is on flaky wifi / mobile data,
  //   · the Supabase JS client transparently retries an auth-refreshed
  //     request (it gives up around ~20s),
  //   · the user has just woken the laptop and the WebSocket is rebuilding.
  // 10 s was too aggressive — it surfaced false-positive timeouts on
  // perfectly healthy writes. 25 s mirrors `SAVE_TIMEOUT_MS` used by the
  // saveAll path; if we hit even that, something is genuinely wrong and
  // we want the user to know rather than spin forever.
  const withRowTimeout = <T,>(p: Promise<T>, label: string, ms = 25_000): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(t('upload.opTimeout', { label, secs: String(ms / 1000) }))),
          ms,
        ),
      ),
    ]);

  // Expense concept autocomplete.
  //
  // Aislamiento (Kevin 2026-07-15): antes esto persistía las sugerencias en
  // un localStorage GLOBAL (`fd_expense_concepts`) sin scope de empresa, y
  // hacía merge+re-save de esa lista con `allExpenses`. Resultado: los
  // conceptos de una empresa se filtraban a otra (superadmin en viewing-as
  // veía conceptos de Vex Pro estando en AP Markets). Se elimina el
  // localStorage por completo: `allExpenses` YA viene scopeado por
  // company_id desde el DataProvider y contiene todos los conceptos jamás
  // guardados de la empresa — es la única fuente de verdad necesaria.
  // Las adiciones de sesión (concepto recién tecleado, antes del refresh)
  // viven solo en estado en memoria y se pierden al cambiar de empresa.
  const [sessionConcepts, setSessionConcepts] = useState<string[]>([]);
  const [showConceptDropdown, setShowConceptDropdown] = useState(false);
  const conceptInputRef = useRef<HTMLInputElement>(null);

  // Al cambiar de empresa, purgar las adiciones de sesión para que no se
  // arrastren conceptos de la empresa anterior.
  useEffect(() => {
    setSessionConcepts([]);
  }, [company?.id]);

  const conceptSuggestions = useMemo(() => {
    const fromExpenses = allExpenses.map(e => e.concept);
    return Array.from(new Set([...fromExpenses, ...sessionConcepts]))
      .filter(Boolean)
      .sort();
  }, [allExpenses, sessionConcepts]);

  const addConceptToHistory = (concept: string) => {
    if (!concept) return;
    setSessionConcepts(prev => (prev.includes(concept) ? prev : [...prev, concept]));
  };

  const filteredConcepts = useMemo(() => {
    if (!newExpense.concept) return conceptSuggestions;
    const q = newExpense.concept.toLowerCase();
    return conceptSuggestions.filter(c => c.toLowerCase().includes(q));
  }, [newExpense.concept, conceptSuggestions]);

  // Expense category autocomplete — mismo patrón (y mismo fix de
  // aislamiento) que los conceptos. Derivado puro de `allExpenses`
  // (scopeado por empresa) + adiciones de sesión en memoria. Sin
  // localStorage global que filtre categorías entre empresas.
  const [sessionCategories, setSessionCategories] = useState<string[]>([]);
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const [showEditCategoryDropdown, setShowEditCategoryDropdown] = useState(false);

  useEffect(() => {
    setSessionCategories([]);
  }, [company?.id]);

  const categorySuggestions = useMemo(() => {
    const fromExpenses = allExpenses
      .map(e => e.category)
      .filter((c): c is string => !!c && !!c.trim());
    return Array.from(new Set([...fromExpenses, ...sessionCategories]))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }, [allExpenses, sessionCategories]);

  const addCategoryToHistory = (cat: string) => {
    const trimmed = cat.trim();
    if (!trimmed) return;
    setSessionCategories(prev => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
  };

  const filteredCategoriesNew = useMemo(() => {
    if (!newExpense.category) return categorySuggestions;
    const q = newExpense.category.toLowerCase();
    return categorySuggestions.filter(c => c.toLowerCase().includes(q));
  }, [newExpense.category, categorySuggestions]);

  const filteredCategoriesEdit = useMemo(() => {
    if (!editExpense.category) return categorySuggestions;
    const q = editExpense.category.toLowerCase();
    return categorySuggestions.filter(c => c.toLowerCase().includes(q));
  }, [editExpense.category, categorySuggestions]);

  const periodLabel = periods.find(p => p.id === selectedPeriod)?.label || '';

  // Feedback via floating bottom-right toasts. Visible regardless of scroll
  // position — replaces the older inline div rendered below the <h1>, which
  // was invisible to users working deep in the Egresos / Liquidez tables.
  const { toast, ToastHost } = useToasts();
  const showSuccess = (msg: string) => toast.success(msg);
  const showError = (msg: string) => toast.error(msg);

  // Back-compat alias so existing call sites keep working. Every remaining
  // usage is a destructive delete — pass `tone: 'danger'` uniformly.
  const askConfirmation = (message: string, onConfirm: () => void) => {
    confirm(message, onConfirm, { tone: 'danger' });
  };

  // --- Period date range helper ---
  const getPeriodDateRange = (periodId: string): { from: string; to: string } | null => {
    const period = periods.find(p => p.id === periodId);
    if (!period) return null;
    const y = period.year;
    const m = period.month;
    const from = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { from, to };
  };

  // --- Filtered/sorted liquidity ---
  const filteredLiquidity = useMemo(() => {
    let rows = [...liquidityRows];

    // Period filter
    if (liqPeriodFilter !== 'todos') {
      const range = getPeriodDateRange(liqPeriodFilter);
      if (range) {
        rows = rows.filter(r => r.date >= range.from && r.date <= range.to);
      }
    }

    // Date range filter
    if (liqDateFrom) {
      rows = rows.filter(r => r.date >= liqDateFrom);
    }
    if (liqDateTo) {
      rows = rows.filter(r => r.date <= liqDateTo);
    }

    // Sort
    rows.sort((a, b) => liqSortAsc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));

    return rows;
  }, [liquidityRows, liqDateFrom, liqDateTo, liqPeriodFilter, liqSortAsc]);

  // --- Filtered/sorted investments ---
  const filteredInvestments = useMemo(() => {
    let rows = [...investmentRows];

    // Period filter
    if (invPeriodFilter !== 'todos') {
      const range = getPeriodDateRange(invPeriodFilter);
      if (range) {
        rows = rows.filter(r => r.date >= range.from && r.date <= range.to);
      }
    }

    // Date range filter
    if (invDateFrom) {
      rows = rows.filter(r => r.date >= invDateFrom);
    }
    if (invDateTo) {
      rows = rows.filter(r => r.date <= invDateTo);
    }

    // Sort
    rows.sort((a, b) => invSortAsc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));

    return rows;
  }, [investmentRows, invDateFrom, invDateTo, invPeriodFilter, invSortAsc]);

  // --- Pagination state (one per table; 25 items per page) ---
  const [expensesPage, setExpensesPage] = useState(0);
  const [liquidityPage, setLiquidityPage] = useState(0);
  const [investmentsPage, setInvestmentsPage] = useState(0);

  // Reset page when the underlying data changes so the user isn't stuck on
  // an empty page after filtering or switching periods.
  useEffect(() => { setExpensesPage(0); }, [selectedPeriod, expenses.length]);
  useEffect(() => { setLiquidityPage(0); }, [liqPeriodFilter, liqDateFrom, liqDateTo, filteredLiquidity.length]);
  useEffect(() => { setInvestmentsPage(0); }, [invPeriodFilter, invDateFrom, invDateTo, filteredInvestments.length]);

  const expensesTotalPages = Math.max(1, Math.ceil(expenses.length / PAGE_SIZE));
  const liquidityTotalPages = Math.max(1, Math.ceil(filteredLiquidity.length / PAGE_SIZE));
  const investmentsTotalPages = Math.max(1, Math.ceil(filteredInvestments.length / PAGE_SIZE));

  // Paged slices — totals/footers still reduce over the FULL data set.
  const pagedExpenses = useMemo(
    () => expenses.slice(expensesPage * PAGE_SIZE, (expensesPage + 1) * PAGE_SIZE),
    [expenses, expensesPage],
  );

  // ── Drag-and-drop reorder for expenses ─────────────────────────────────
  // Sensors: PointerSensor activates after 6px of movement so tiny
  // taps on the handle (e.g. on tablets) don't kidnap the row. Keyboard
  // support is wired for accessibility.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleExpenseDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      // Indices inside the currently-visible page slice.
      const oldPagedIndex = pagedExpenses.findIndex((e) => e.id === active.id);
      const newPagedIndex = pagedExpenses.findIndex((e) => e.id === over.id);
      if (oldPagedIndex < 0 || newPagedIndex < 0) return;

      // Translate to indices in the full list (rows on other pages stay
      // put). Reordering across pages requires first navigating to that
      // page — intentional: cross-page drag is a footgun.
      const startIdx = expensesPage * PAGE_SIZE;
      const oldIndex = startIdx + oldPagedIndex;
      const newIndex = startIdx + newPagedIndex;

      // Optimistic update — show the new order immediately.
      let reordered: ExpenseRow[] = [];
      setExpenses((prev) => {
        reordered = arrayMove(prev, oldIndex, newIndex);
        return reordered;
      });

      // Persist sort_order — lightweight N-parallel UPDATE.
      // Only rows with real UUID ids (already saved in DB) go through;
      // locally-created rows that haven't been saved yet are skipped.
      //
      // 2026-10-08: pasa por la cola de egresos con el guard de huella.
      // Reordenar sube updated_at (trigger), o sea mueve la huella: fuera de
      // la cola, el próximo guardado de esta misma pestaña daba un 409 falso.
      // Y ahora SÍ refresca: al vaciarse la cola el buffer se re-siembra
      // desde la base, y sin refresh volvería al orden viejo.
      const periodId = selectedPeriodRef.current;
      void enqueueExpenseWrite(periodId, async (baseline) => {
        try {
          const ids = reordered
            .map((e) => e.id)
            .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
          if (ids.length === 0) return;
          const { huella } = await updateExpenseOrder(ids, { periodId, baseline });
          if (huella) expenseBaselinesRef.current.set(periodId, huella);
          await withRowTimeout(refreshSections(['egresos']), t('upload.opReloadData')).catch(() => {
            console.warn('[expenses:reorder] refresh after reorder failed');
          });
        } catch (err) {
          if (err instanceof ConflictoPeriodoError) {
            handleExpenseConflict(periodId, err);
            return;
          }
          console.error('[expenses:reorder] failed to persist order:', err);
          showError(t('upload.reorderError', { error: (err as Error).message }));
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pagedExpenses, expensesPage],
  );
  const pagedLiquidity = useMemo(
    () => filteredLiquidity.slice(liquidityPage * PAGE_SIZE, (liquidityPage + 1) * PAGE_SIZE),
    [filteredLiquidity, liquidityPage],
  );
  const pagedInvestments = useMemo(
    () => filteredInvestments.slice(investmentsPage * PAGE_SIZE, (investmentsPage + 1) * PAGE_SIZE),
    [filteredInvestments, investmentsPage],
  );

  // --- Liquidity helpers ---
  const recalcLiquidityBalances = (rows: LiquidityMovement[]): LiquidityMovement[] => {
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    let balance = 0;
    return sorted.map(r => {
      balance += r.deposit - r.withdrawal;
      return { ...r, balance };
    });
  };

  const addLiquidityRow = () => {
    if (!userCanAdd || !company || !newLiq.date || !newLiq.user_email) return;
    if (savingLiq) return;
    const badLiq = findInvalidAmount(newLiq.deposit, newLiq.withdrawal);
    if (badLiq !== null) { showError(t('upload.invalidAmount', { value: badLiq })); return; }
    const dep = parseAmount(newLiq.deposit);
    const wth = parseAmount(newLiq.withdrawal);
    (async () => {
      setSavingLiq(true);
      try {
        await withRowTimeout(
          insertLiquidityMovement(company.id, {
            date: newLiq.date,
            user_email: newLiq.user_email || null,
            mt_account: newLiq.mt_account || null,
            deposit: dep,
            withdrawal: wth,
            balance: 0,
          }),
          t('upload.opSaveLiquidity'),
        );
        setNewLiq({ date: '', user_email: '', mt_account: '', deposit: '', withdrawal: '' });
        await withRowTimeout(refreshSections(['liquidez']), t('upload.opReloadData')).catch(() => {
          // Silent refresh failure shouldn't invalidate the successful save.
          console.warn('[liquidez] refresh after add failed');
        });
        setLiquidityRowsRaw([...getLiquidityData()]);
        showSuccess(t('upload.liquidityAdded'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingLiq(false);
      }
    })();
  };

  const startEditLiq = (row: LiquidityMovement) => {
    if (!userCanEdit) return;
    setEditingLiqId(row.id);
    setEditLiq({
      date: row.date,
      user_email: row.user_email || '',
      mt_account: row.mt_account || '',
      deposit: String(row.deposit),
      withdrawal: String(row.withdrawal),
    });
  };

  const saveEditLiq = () => {
    if (!editingLiqId) return;
    if (savingLiq) return;
    const badEditLiq = findInvalidAmount(editLiq.deposit, editLiq.withdrawal);
    if (badEditLiq !== null) { showError(t('upload.invalidAmount', { value: badEditLiq })); return; }
    const dep = parseAmount(editLiq.deposit);
    const wth = parseAmount(editLiq.withdrawal);
    (async () => {
      setSavingLiq(true);
      try {
        await withRowTimeout(
          updateLiquidityMovement(editingLiqId, {
            date: editLiq.date,
            user_email: editLiq.user_email || null,
            mt_account: editLiq.mt_account || null,
            deposit: dep,
            withdrawal: wth,
            balance: 0,
          }),
          t('upload.opUpdateLiquidity'),
        );
        setEditingLiqId(null);
        await withRowTimeout(refreshSections(['liquidez']), t('upload.opReloadData')).catch(() => {
          console.warn('[liquidez] refresh after edit failed');
        });
        setLiquidityRowsRaw([...getLiquidityData()]);
        showSuccess(t('upload.liquidityUpdated'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingLiq(false);
      }
    })();
  };

  const deleteLiqRow = (id: string) => {
    if (!userCanDelete) return;
    if (savingLiq) return;
    askConfirmation(t('upload.confirmDeleteLiquidity'), async () => {
      setSavingLiq(true);
      try {
        await withRowTimeout(deleteLiqMutation(id), t('upload.opDeleteLiquidity'));
        await withRowTimeout(refreshSections(['liquidez']), t('upload.opReloadData')).catch(() => {
          console.warn('[liquidez] refresh after delete failed');
        });
        setLiquidityRowsRaw([...getLiquidityData()]);
        showSuccess(t('upload.liquidityDeleted'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingLiq(false);
      }
    });
  };

  // --- Investment helpers ---
  const recalcInvestmentBalances = (rows: Investment[]): Investment[] => {
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    let balance = 0;
    return sorted.map(r => {
      balance += r.deposit - r.withdrawal + r.profit;
      return { ...r, balance };
    });
  };

  const addInvestmentRow = () => {
    if (!userCanAdd || !company || !newInv.date) return;
    if (savingInv) return;
    const badInv = findInvalidAmount(newInv.deposit, newInv.withdrawal, newInv.profit);
    if (badInv !== null) { showError(t('upload.invalidAmount', { value: badInv })); return; }
    const dep = parseAmount(newInv.deposit);
    const wth = parseAmount(newInv.withdrawal);
    const prf = parseAmount(newInv.profit);
    (async () => {
      setSavingInv(true);
      try {
        await withRowTimeout(
          insertInvestment(company.id, {
            date: newInv.date,
            concept: newInv.concept || null,
            responsible: newInv.responsible || null,
            deposit: dep,
            withdrawal: wth,
            profit: prf,
            balance: 0,
            // Si no se elige tipo, se infiere de los importes y el concepto —
            // la misma heurística del backfill (migración 062). Así ninguna
            // fila nueva nace sin clasificar.
            movement_type:
              newInv.movement_type ||
              inferMovementType({ deposit: dep, withdrawal: wth, profit: prf, concept: newInv.concept }),
          }),
          t('upload.opSaveInvestment'),
        );
        setNewInv({ date: '', concept: '', responsible: '', deposit: '', withdrawal: '', profit: '', movement_type: '' });
        await withRowTimeout(refreshSections(['inversiones']), t('upload.opReloadData')).catch(() => {
          console.warn('[inversiones] refresh after add failed');
        });
        setInvestmentRowsRaw([...getInvestmentsData()]);
        showSuccess(t('upload.investmentAdded'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingInv(false);
      }
    })();
  };

  const startEditInv = (row: Investment) => {
    if (!userCanEdit) return;
    setEditingInvId(row.id);
    setEditInv({
      date: row.date,
      concept: row.concept || '',
      responsible: row.responsible || '',
      deposit: String(row.deposit),
      withdrawal: String(row.withdrawal),
      profit: String(row.profit),
    });
  };

  const saveEditInv = () => {
    if (!editingInvId) return;
    if (savingInv) return;
    const badEditInv = findInvalidAmount(editInv.deposit, editInv.withdrawal, editInv.profit);
    if (badEditInv !== null) { showError(t('upload.invalidAmount', { value: badEditInv })); return; }
    const dep = parseAmount(editInv.deposit);
    const wth = parseAmount(editInv.withdrawal);
    const prf = parseAmount(editInv.profit);
    (async () => {
      setSavingInv(true);
      try {
        await withRowTimeout(
          updateInvestment(editingInvId, {
            date: editInv.date,
            concept: editInv.concept || null,
            responsible: editInv.responsible || null,
            deposit: dep,
            withdrawal: wth,
            profit: prf,
            balance: 0,
          }),
          t('upload.opUpdateInvestment'),
        );
        setEditingInvId(null);
        await withRowTimeout(refreshSections(['inversiones']), t('upload.opReloadData')).catch(() => {
          console.warn('[inversiones] refresh after edit failed');
        });
        setInvestmentRowsRaw([...getInvestmentsData()]);
        showSuccess(t('upload.investmentUpdated'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingInv(false);
      }
    })();
  };

  const deleteInvRow = (id: string) => {
    if (!userCanDelete) return;
    if (savingInv) return;
    askConfirmation(t('upload.confirmDeleteInvestment'), async () => {
      setSavingInv(true);
      try {
        await withRowTimeout(deleteInvMutation(id), t('upload.opDeleteInvestment'));
        await withRowTimeout(refreshSections(['inversiones']), t('upload.opReloadData')).catch(() => {
          console.warn('[inversiones] refresh after delete failed');
        });
        setInvestmentRowsRaw([...getInvestmentsData()]);
        showSuccess(t('upload.investmentDeleted'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingInv(false);
      }
    });
  };

  // Deposit handlers
  //
  // IMPORTANT: `upsertDeposits` is a delete-then-reinsert helper (see
  // `src/lib/supabase/mutations.ts`). If a second list of deposit rows is
  // ever added to this page (e.g. "depósitos adicionales"), the array passed
  // here MUST be the combined list — otherwise the rows not included get
  // wiped on save. Today only fixed channels exist so the array is complete.
  const updateDeposit = (id: string, amount: number) => {
    if (!userCanAdd || !company) return;
    // Mes cerrado: mismo criterio que el autosave. El trigger de la migración
    // 061 rechaza la escritura igual; sin este corte el usuario veía un error
    // crudo de la base. El botón además viene deshabilitado y el aviso fijo de
    // arriba explica por qué (no hace falta un toast nuevo).
    if (selectedPeriodIsClosed) return;
    if (savingDepositIds.has(id)) return; // already in flight for this row
    // Skip confirmation modal — the inline input onBlur/save is already a
    // deliberate action. Toast feedback + undo-via-re-edit is faster UX.
    //
    // Optimistic update: apply the change locally immediately, then upsert.
    // On failure, roll back to the pre-edit snapshot AND surface the toast,
    // so the user can see exactly what didn't persist instead of guessing.
    const previousDeposits = deposits;
    const updated = deposits.map(d => d.id === id ? { ...d, amount } : d);
    setDepositsRaw(updated);
    setSavingDepositIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    (async () => {
      Sentry.addBreadcrumb({
        category: 'upload.save',
        message: 'updateDeposit:start',
        data: { id, amount, periodId: selectedPeriodRef.current },
      });
      try {
        await withRowTimeout(
          upsertDeposits(company.id, selectedPeriodRef.current, updated),
          t('upload.opSaveDeposit'),
        );

        if (user) logAction(user.id, user.name, 'update', 'deposits', `Deposito ${CHANNEL_LABELS[deposits.find(d => d.id === id)?.channel || ''] || ''}: ${formatMoney(amount)}`);
        showSuccess(t('upload.depositRegistered'));

        // Await refresh so callers see fresh data. We do NOT show a
        // toast if refresh returns false: stale generations (a second
        // save firing while this one is still refreshing) are common
        // and benign — the local optimistic update already shows the
        // correct value, and the latest refresh will settle the
        // DataProvider. Only a true network failure / timeout matters,
        // and that surfaces through the regular catch below.
        // Con techo + catch propio: si el refresh cuelga o falla, el guardado
        // YA está en DB — rebotarlo al catch de afuera haría rollback de un
        // guardado exitoso, y sin techo el spinner queda en "Guardando…" eterno.
        await withRowTimeout(refreshSections(['depositos']), t('upload.opReloadData')).catch(() => {
          console.warn('[depositos] refresh after save failed');
        });
      } catch (err) {
        // Rollback the optimistic update so the cell reverts to what
        // was actually in DB before we touched it.
        setDepositsRaw(previousDeposits);
        Sentry.captureException(err, {
          tags: { area: 'upload.updateDeposit' },
          extra: { id, amount, periodId: selectedPeriodRef.current },
        });
        showError(t('upload.saveDepositError', { error: (err as Error).message }));
      } finally {
        setSavingDepositIds(prev => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    })();
  };

  // Withdrawal handlers
  const updateWithdrawal = (id: string, amount: number) => {
    if (!userCanAdd || !company) return;
    if (selectedPeriodIsClosed) return; // mes cerrado: mismo criterio que el autosave
    if (savingWithdrawalIds.has(id)) return;
    // Skip confirmation modal — the inline input commit (blur / enter) is
    // the deliberate action. Toast feedback gives the user a fast signal
    // without the extra click. Optimistic + rollback mirrors updateDeposit.
    const previousWithdrawals = withdrawals;
    const updated = withdrawals.map(w => w.id === id ? { ...w, amount } : w);
    setWithdrawalsRaw(updated);
    setSavingWithdrawalIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    (async () => {
      Sentry.addBreadcrumb({
        category: 'upload.save',
        message: 'updateWithdrawal:start',
        data: { id, amount, periodId: selectedPeriodRef.current },
      });
      try {
        // Combine fixed withdrawals with extras so upsert (delete+reinsert) doesn't wipe extras
        const combined = [
          ...updated.map(w => ({ category: w.category, amount: w.amount, description: null as string | null })),
          ...withdrawalExtras.map(w => ({ category: w.category, amount: w.amount, description: w.description || null })),
        ];
        await withRowTimeout(
          upsertWithdrawals(company.id, selectedPeriodRef.current, combined),
          t('upload.opSaveWithdrawal'),
        );

        if (user) logAction(user.id, user.name, 'update', 'withdrawals', `Retiro ${WITHDRAWAL_LABELS[withdrawals.find(w => w.id === id)?.category || ''] || ''}: ${formatMoney(amount)}`);
        showSuccess(t('upload.withdrawalRegistered'));

        // Same rationale as updateDeposit: skip false-positive toast on
        // stale refresh (common when user clicks Save on a second row
        // before the first refresh resolves). Real failures still
        // surface via catch.
        // Techo + catch propio: mismo porqué que updateDeposit.
        await withRowTimeout(refreshSections(['retiros']), t('upload.opReloadData')).catch(() => {
          console.warn('[retiros] refresh after save failed');
        });
      } catch (err) {
        setWithdrawalsRaw(previousWithdrawals);
        Sentry.captureException(err, {
          tags: { area: 'upload.updateWithdrawal' },
          extra: { id, amount, periodId: selectedPeriodRef.current },
        });
        showError(t('upload.saveWithdrawalError', { error: (err as Error).message }));
      } finally {
        setSavingWithdrawalIds(prev => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    })();
  };

  // Expense handlers — persistencia POR ACCIÓN (2026-07-12).
  //
  // Antes los egresos se acumulaban en estado local y dependían de "Guardar
  // Todo" (un batch grande que, si el request de red se estancaba, colgaba
  // 25s y fallaba entero — el bug que Kevin reportó repetidamente). Ahora
  // cada agregar/editar/borrar/fijar persiste al instante, igual que
  // depósitos y retiros: optimista en pantalla + upsert atómico resiliente
  // (timeout 12s + reintento en la capa de mutación) + rollback si falla. No
  // se pierde nada aunque el usuario cierre la pestaña.
  //
  // Se marca 'egresos' dirty MIENTRAS guarda para que el sync-effect no
  // rehidrate la tabla desde una lectura a medio-camino; al terminar se
  // limpia el dirty, disparando un re-sync limpio desde la DB (con ids
  // reales, reemplazando el id temporal optimista). Desde 2026-10-08 "al
  // terminar" es al vaciarse la cola de escrituras de egresos (ver abajo).
  const [savingExpenses, setSavingExpenses] = useState(false);

  // ── Cola de escrituras de egresos (2026-10-08) ─────────────────────────
  // Todo lo que esta pantalla escribe sobre los egresos del período (guardar,
  // reordenar, propagar un fijo, ocultar una plantilla) pasa por UNA cola en
  // serie. Por qué, con el guard de huella:
  //   · Cada escritura mueve la huella del período. Dos acciones seguidas
  //     (marcar pagados dos egresos en un segundo) salían en paralelo con el
  //     MISMO baseline: la segunda daba 409 por un cambio propio. En serie,
  //     cada una lee el baseline al salir, ya actualizado por la anterior.
  //   · El buffer NO se re-siembra hasta que la cola se vacía ('egresos'
  //     queda dirty mientras haya algo en vuelo). Si se re-sembrara a mitad
  //     de cola, una acción tomaría filas de esa siembra y saldría con el
  //     baseline de un guardado posterior que esas filas no conocen — el
  //     mismo pisón silencioso, ahora dentro de una sola pestaña.
  //   · El período se fija al ENCOLAR, no al salir: si el usuario cambia de
  //     mes con algo en cola, la escritura va al mes de las filas que lleva.
  // De paso desaparece una carrera que ya existía: dos reemplazos del período
  // en paralelo podían llegar al server en cualquier orden y el más viejo
  // pisaba al más nuevo.
  const expenseQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingExpenseWritesRef = useRef(0);

  /**
   * Encola una escritura de egresos del período `periodId`. `job` recibe el
   * baseline vigente AL MOMENTO DE SALIR. Devuelve null (y avisa) si el
   * buffer en pantalla no es de ese período: armar el payload con filas de
   * otro mes y mandarlo a este es exactamente lo que no puede pasar.
   */
  const enqueueExpenseWrite = (
    periodId: string,
    job: (baseline: HuellaEgresos) => Promise<void>,
  ): Promise<void> | null => {
    if (expensesBufferPeriodRef.current !== periodId) {
      showError(t('upload.expenseBufferOtherPeriod'));
      return null;
    }
    pendingExpenseWritesRef.current += 1;
    markDirty('egresos');
    setSavingExpenses(true);
    const run = async () => {
      try {
        // Siempre existe: la siembra fija buffer, período y huella juntos, y
        // el chequeo de arriba garantiza que el buffer es de este período.
        const baseline = expenseBaselinesRef.current.get(periodId);
        if (!baseline) {
          showError(t('upload.expenseBufferOtherPeriod'));
          return;
        }
        await job(baseline);
      } finally {
        pendingExpenseWritesRef.current -= 1;
        if (pendingExpenseWritesRef.current === 0) {
          setSavingExpenses(false);
          // Cola vacía → re-sync desde la base: ids reales y huella nueva,
          // sembrados juntos (salvo conflicto vigente, ver arriba).
          clearDirty('egresos');
        }
      }
    };
    const p = expenseQueueRef.current.then(run);
    // La cadena nunca queda rechazada: un job que falla no frena a los demás.
    expenseQueueRef.current = p.catch(() => {});
    return p;
  };

  /**
   * 409 del guard: el período cambió desde la siembra. NO se deshace lo
   * tecleado (el buffer queda como está, y no se re-siembra mientras dure el
   * conflicto) y NO se informa éxito: se muestra el mensaje del server, que
   * pide recargar.
   */
  const handleExpenseConflict = (periodId: string, err: ConflictoPeriodoError) => {
    expenseConflictPeriodRef.current = periodId;
    Sentry.captureMessage('upload.egresos: escritura bloqueada por huella del período', {
      level: 'warning',
      extra: {
        periodId,
        baseline: expenseBaselinesRef.current.get(periodId) ?? null,
        actual: err.actual,
      },
    });
    showError(err.message);
  };

  const persistExpenses = (
    nextList: ExpenseRow[],
    previousList: ExpenseRow[],
    opts: { toast: string; audit?: { action: 'create' | 'update' | 'delete'; details: string } },
  ): Promise<void> => {
    if (!company) return Promise.resolve();
    // Red de seguridad central de los egresos (alta, edición, marcar pagado,
    // borrar, fijo, import): con el mes cerrado el trigger rechaza la
    // escritura, así que se deshace el optimista y no se sale a la red. Los
    // botones ya vienen deshabilitados y el aviso fijo de "período cerrado"
    // explica el porqué en pantalla.
    if (selectedPeriodIsClosed) {
      setExpensesRaw(previousList);
      return Promise.resolve();
    }
    const companyId = company.id;
    const periodId = selectedPeriodRef.current;
    const queued = enqueueExpenseWrite(periodId, async (baseline) => {
      try {
        const { huella } = await withRowTimeout(
          upsertExpenses(companyId, periodId, nextList, baseline),
          t('upload.opSaveExpense'),
        );
        // Re-sincroniza el baseline sin refetch: lo que sigue en la cola sale
        // desde acá. null = el server guardó pero no pudo releer la huella;
        // queda la anterior y el re-sync al vaciarse la cola la corrige.
        if (huella) expenseBaselinesRef.current.set(periodId, huella);
        if (user && opts.audit) {
          logAction(user.id, user.name, opts.audit.action, 'expenses', opts.audit.details);
        }
        showSuccess(opts.toast);
        // Techo + catch propio: el upsert ya corrió; un refresh colgado dejaba
        // el botón en "Guardando…" para siempre (Kevin, 2026-08-10) porque el
        // finally nunca llegaba a resetear savingExpenses.
        await withRowTimeout(refreshSections(['egresos']), t('upload.opReloadData')).catch(() => {
          console.warn('[egresos] refresh after save failed');
        });
      } catch (err) {
        if (err instanceof ConflictoPeriodoError) {
          handleExpenseConflict(periodId, err);
          return;
        }
        setExpensesRaw(previousList); // rollback al estado previo (= lo que hay en DB)
        Sentry.captureException(err, {
          tags: { area: 'upload.persistExpenses' },
          extra: { periodId },
        });
        showError(t('upload.saveExpenseError', { error: (err as Error).message }));
      }
    });
    if (!queued) {
      setExpensesRaw(previousList);
      return Promise.resolve();
    }
    return queued;
  };

  // ── Import CSV/Excel de egresos (QW9) ──────────────────────────────────
  // El endpoint SOLO parsea y valida; las filas entran por el MISMO camino
  // que el alta manual (persistExpenses) — así respetan el trigger de período
  // cerrado, el sync de plantillas y el payload completo de columnas.
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    rows: Array<{ concept: string; category: string | null; expense_date: string | null; amount: number; paid: number; pending: number; reference: string | null }>;
    errors: Array<{ row: number; error: string }>;
    truncated?: boolean;
  } | null>(null);

  const handleImportFile = async (file: File) => {
    setImporting(true);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch('/api/admin/expenses/import', { method: 'POST', body: fd });
      const json = await res.json();
      if (json.success) setImportResult({ rows: json.rows ?? [], errors: json.errors ?? [], truncated: json.truncated });
      else showError(json.error ?? 'No se pudo leer el archivo');
    } catch {
      showError('No se pudo leer el archivo');
    } finally {
      setImporting(false);
    }
  };

  const confirmImport = () => {
    if (!importResult || importResult.rows.length === 0) return;
    const previous = expenses;
    const stamp = Date.now();
    const next: ExpenseRow[] = [
      ...expenses,
      ...importResult.rows.map((r, i) => ({
        id: `exp-import-${stamp}-${i}`,
        concept: r.concept,
        amount: r.amount,
        paid: r.paid,
        pending: r.pending,
        is_fixed: false,
        category: r.category,
        expense_date: r.expense_date,
        reference: r.reference,
        attachment_bucket: null,
        attachment_path: null,
        attachment_name: null,
        attachment_mime: null,
        attachment_size: null,
        attachment_uploaded_at: null,
        payment_order_id: null,
      })),
    ];
    setExpensesRaw(next);
    setImportOpen(false);
    setImportResult(null);
    void persistExpenses(next, previous, {
      toast: `${importResult.rows.length} egresos importados`,
      audit: { action: 'create', details: `Import de ${importResult.rows.length} egresos desde archivo` },
    });
  };

  const addExpense = () => {
    if (!userCanAdd || !company || !newExpense.concept || !newExpense.amount) return;
    if (selectedPeriodIsClosed) return; // mes cerrado: mismo criterio que el autosave
    const badExp = findInvalidAmount(newExpense.amount, newExpense.paid, newExpense.pending);
    if (badExp !== null) { showError(t('upload.invalidAmount', { value: badExp })); return; }
    const amt = parseAmount(newExpense.amount);
    const pd = parseAmount(newExpense.paid);
    const pn = computeExpensePending(newExpense.amount, newExpense.paid, newExpense.pending);
    const cat = newExpense.category.trim() || null;
    const previous = expenses;
    const next: ExpenseRow[] = [...expenses, {
      id: `exp-${Date.now()}`,
      concept: newExpense.concept,
      amount: amt,
      paid: pd,
      pending: pn,
      is_fixed: newExpense.is_fixed,
      category: cat,
      expense_date: newExpense.expense_date || null, // vacío = sin fecha
      reference: newExpense.reference.trim() || null,
      attachment_bucket: newExpense.attachment?.bucket ?? null,
      attachment_path: newExpense.attachment?.path ?? null,
      attachment_name: newExpense.attachment?.name ?? null,
      attachment_mime: newExpense.attachment?.mime ?? null,
      attachment_size: newExpense.attachment?.size ?? null,
      attachment_uploaded_at: newExpense.attachment?.uploaded_at ?? null,
      payment_order_id: null, // egreso cargado a mano: no viene de una OP
    }];
    setExpensesRaw(next); // optimista
    setNewExpense({ concept: '', amount: '', paid: '', pending: '', is_fixed: false, category: '', expense_date: '', reference: '', attachment: null });
    addConceptToHistory(newExpense.concept);
    if (cat) addCategoryToHistory(cat);
    void persistExpenses(next, previous, {
      toast: t('upload.expenseAdded'),
      audit: { action: 'create', details: `Egreso creado: ${newExpense.concept}, monto: ${formatMoney(amt)}` },
    });
  };

  const startEditExpense = (exp: ExpenseRow) => {
    if (!userCanEdit) return;
    setEditingExpenseId(exp.id);
    setEditExpense({ concept: exp.concept, amount: String(exp.amount), paid: String(exp.paid), pending: String(exp.pending), is_fixed: !!exp.is_fixed, category: exp.category ?? '', expense_date: exp.expense_date ?? '', reference: exp.reference ?? '',
      attachment: exp.attachment_path
        ? { bucket: exp.attachment_bucket ?? 'expense-attachments', path: exp.attachment_path,
            name: exp.attachment_name ?? 'comprobante', mime: exp.attachment_mime ?? '',
            size: exp.attachment_size ?? 0, uploaded_at: exp.attachment_uploaded_at ?? '' }
        : null });
  };

  const saveEditExpense = () => {
    if (!editingExpenseId) return;
    if (selectedPeriodIsClosed) return; // mes cerrado: mismo criterio que el autosave
    const badEditExp = findInvalidAmount(editExpense.amount, editExpense.paid, editExpense.pending);
    if (badEditExp !== null) { showError(t('upload.invalidAmount', { value: badEditExp })); return; }
    const amt = parseAmount(editExpense.amount);
    const pd = parseAmount(editExpense.paid);
    const pn = computeExpensePending(editExpense.amount, editExpense.paid, editExpense.pending);
    const cat = editExpense.category.trim() || null;
    const previous = expenses;
    const concept = editExpense.concept;
    const target = expenses.find(e => e.id === editingExpenseId);
    const next = expenses.map(e => e.id === editingExpenseId ? { ...e, concept, amount: amt, paid: pd, pending: pn, is_fixed: editExpense.is_fixed, category: cat, expense_date: editExpense.expense_date || null, reference: editExpense.reference.trim() || null,
      attachment_bucket: editExpense.attachment?.bucket ?? null,
      attachment_path: editExpense.attachment?.path ?? null,
      attachment_name: editExpense.attachment?.name ?? null,
      attachment_mime: editExpense.attachment?.mime ?? null,
      attachment_size: editExpense.attachment?.size ?? null,
      attachment_uploaded_at: editExpense.attachment?.uploaded_at ?? null } : e);
    setExpensesRaw(next); // optimista
    if (cat) addCategoryToHistory(cat);
    setEditingExpenseId(null);
    void (async () => {
      await persistExpenses(next, previous, {
        toast: t('upload.expenseUpdated'),
        audit: { action: 'update', details: `Egreso ${concept}: ${formatMoney(amt)}` },
      });
      // Egreso fijo: el mes actual ya se guardó; ahora se pregunta el alcance.
      // Solo si SIGUE siendo fijo tras la edición (destildar "fijo" es sacarlo
      // del esquema recurrente, no propagarlo hacia adelante).
      if (target?.is_fixed && editExpense.is_fixed) {
        setForwardPending({
          oldConcept: target.concept,
          concept,
          amount: amt,
          category: cat,
        });
      }
    })();
  };

  // Alcance elegido en el diálogo del egreso fijo.
  //   'this'    → nada más que hacer: el guardado del mes ya corrió.
  //   'forward' → plantilla + meses futuros ya materializados.
  const applyExpenseForward = async (apply: 'this' | 'forward') => {
    if (!forwardPending || apply === 'this') return;
    const pending = forwardPending;
    // 2026-10-08: por la cola de egresos. La propagación también actualiza la
    // fila de ESTE mes (sube su updated_at, o sea la huella del período):
    // fuera de la cola, el próximo guardado de esta pestaña daba un 409 falso.
    // Al vaciarse la cola el buffer y su huella se re-siembran juntos desde
    // lo que trae el refresh. La ruta no lleva guard propio: es un UPDATE de
    // una fila por concepto, no un reemplazo del período — no pisa filas que
    // esta pantalla no conozca.
    const periodId = selectedPeriodRef.current;
    await enqueueExpenseWrite(periodId, async () => {
      try {
        const { updatedPeriods } = await applyFixedExpenseForward({
          periodId,
          oldConcept: pending.oldConcept,
          concept: pending.concept,
          amount: pending.amount,
          category: pending.category,
          apply: 'forward',
        });
        showSuccess(
          updatedPeriods > 0
            ? t('expenses.forwardSuccess', { count: String(updatedPeriods) })
            : t('expenses.forwardSuccessNone'),
        );
        if (user) {
          logAction(user.id, user.name, 'update', 'expenses',
            `Egreso fijo "${pending.oldConcept}" propagado a ${updatedPeriods} mes(es) siguientes`);
        }
        // Techo + catch propio: la propagación ya corrió; un refresh caído no
        // debe reportarse como forwardError.
        await withRowTimeout(refreshSections(['egresos']), t('upload.opReloadData')).catch(() => {
          console.warn('[egresos] refresh after forward failed');
        });
      } catch (err) {
        showError(t('expenses.forwardError', { error: (err as Error).message }));
      }
    });
  };

  const toggleExpenseFixed = (id: string) => {
    if (!userCanEdit) return;
    if (selectedPeriodIsClosed) return; // mes cerrado: mismo criterio que el autosave
    const previous = expenses;
    const target = expenses.find(e => e.id === id);
    const next = expenses.map(e => e.id === id ? { ...e, is_fixed: !e.is_fixed } : e);
    setExpensesRaw(next); // optimista
    void persistExpenses(next, previous, {
      toast: t('upload.expenseUpdated'),
      audit: { action: 'update', details: `Egreso ${target?.concept ?? ''} marcado ${target?.is_fixed ? 'no fijo' : 'fijo'}` },
    });
  };

  // Marcar un egreso como pagado en un click: paid = amount, pending = 0.
  // Pedido de Kevin (2026-07-13) — sobre todo para los egresos fijos, sin
  // tener que abrir la edición. Persiste por-acción (ahora server-side, rápido).
  const markExpensePaid = (id: string) => {
    if (!userCanEdit) return;
    if (selectedPeriodIsClosed) return; // mes cerrado: mismo criterio que el autosave
    const target = expenses.find(e => e.id === id);
    if (!target || target.pending <= 0) return; // ya está pagado
    const previous = expenses;
    const next = expenses.map(e => e.id === id ? { ...e, paid: e.amount, pending: 0 } : e);
    setExpensesRaw(next); // optimista
    void persistExpenses(next, previous, {
      toast: t('upload.markedPaid', { concept: target.concept }),
      audit: { action: 'update', details: `Egreso marcado como pagado: ${target.concept} (${formatMoney(target.amount)})` },
    });
  };

  const deleteExpense = (id: string) => {
    if (!userCanDelete) return;
    // Se corta ANTES de abrir el diálogo de confirmación: pedir confirmación
    // de algo que la base va a rechazar es peor que no ofrecer la acción.
    if (selectedPeriodIsClosed) return;
    const exp = expenses.find(e => e.id === id);
    askConfirmation(t('expenses.deleteConfirm', { concept: exp?.concept ?? '' }), () => {
      const previous = expenses;
      const next = expenses.filter(e => e.id !== id);
      setExpensesRaw(next); // optimista
      void persistExpenses(next, previous, {
        toast: t('upload.expenseDeleted'),
        audit: { action: 'delete', details: `Egreso eliminado: ${exp?.concept ?? ''}` },
      });
    });
  };

  // Detalle de ingresos por concepto. El estado, la carga por período y la
  // persistencia viven en `useIncomeLines`; acá sólo se cablean las
  // dependencias de la página.
  const incomeLinesState = useIncomeLines(selectedPeriod, {
    active: section === 'ingresos',
    company,
    user,
    periodIsClosed: selectedPeriodIsClosed,
    userCanAdd,
    userCanEdit,
    userCanDelete,
    periodIdRef: selectedPeriodRef,
    showSuccess,
    showError,
    askConfirmation,
    refreshSections,
    withRowTimeout,
    // El servidor materializa operating_income.other con lo cobrado; se
    // refleja con el setter Raw para no marcar 'ingresos' sucio y disparar
    // el autosave de los otros campos.
    onReceivedSynced: (received) => setIncomeRaw(p => ({ ...p, other: received })),
  });
  const { incomeLines, incomeTotals } = incomeLinesState;

  // Income handler
  //
  // Saves three things in one click — they share a tab in the UI so users
  // expect "Guardar Ingresos" to persist everything visible:
  //   1. operating_income (broker_pnl, other) — the historical pair.
  //   2. prop_firm_sales — single roll-up amount per period; the Prop Firm
  //      "ventas" input was added 2026-05-01 so the net (sales − retiros)
  //      can flow into Total Ingresos without leaving the page.
  //   3. withdrawals — the Prop Firm "retiros" share state with the
  //      Retiros tab. We persist the FULL withdrawals payload (4 aggregates
  //      + extras) the same way `saveAll('retiros')` does so editing the
  //      prop_firm row from Ingresos doesn't wipe other categories or any
  //      manual extras the user already added.
  const saveIncome = () => {
    if (!userCanAdd || !company) return;
    // Mes cerrado: mismo criterio que los otros NUEVE handlers de esta pantalla
    // (autosave, egresos, liquidez, inversiones…). Era el ÚNICO sin guard
    // (auditoría 2026-08-31): el trigger de la migración 061 rechazaba la
    // escritura igual, pero el rechazo llegaba como una excepción de Postgres
    // que este handler mostraba CRUDA al usuario — ver el catch de abajo.
    if (selectedPeriodIsClosed) {
      showError(t('upload.periodClosedNoChanges', { period: periodLabel }));
      return;
    }
    (async () => {
      Sentry.addBreadcrumb({
        category: 'upload.save',
        message: 'saveIncome:start',
        data: { periodId: selectedPeriodRef.current },
      });
      try {
        const periodId = selectedPeriodRef.current;
        const combinedWithdrawals = [
          ...withdrawals.map(w => ({ category: w.category, amount: w.amount, description: null as string | null })),
          ...withdrawalExtras.map(w => ({ category: w.category, amount: w.amount, description: w.description || null })),
        ];
        await upsertOperatingIncome(company.id, periodId, income);
        // Prop firm y retiros los edita esta pestaña solo en el modelo broker;
        // en una consultora ni siquiera se muestran, así que no se escriben.
        if (showBrokerPnl) await upsertPropFirmSales(company.id, periodId, propFirmAmount);
        if (showWithdrawals) await upsertWithdrawals(company.id, periodId, combinedWithdrawals);

        if (user) {
          const propFirmWdr = withdrawals.find(w => w.category === 'prop_firm')?.amount || 0;
          const propFirmNet = propFirmAmount - propFirmWdr;
          logAction(
            user.id,
            user.name,
            'update',
            'income',
            `Ingresos operativos: Broker ${formatMoney(income.broker_pnl)}, Otros ${formatMoney(income.other)}, Prop Firm net ${formatMoney(propFirmNet)}`,
          );
        }
        showSuccess(t('upload.incomeSaved'));
        Sentry.addBreadcrumb({
          category: 'upload.save',
          message: 'saveIncome:success',
          data: { periodId },
        });
        // Refresh + THEN clear dirty for the saved sections only.
        // saveIncome persists `operating_income` + `prop_firm_sales` (own
        // dirty bucket: 'ingresos') AND `withdrawals` (which lives in
        // 'retiros'). Clear both so the sync effect can re-hydrate from
        // the fresh DataProvider state without stomping on any other
        // section the user may still be editing.
        //
        // Critical (Kevin 2026-06-06): only clear dirty when refresh
        // REALLY succeeded. If refresh returned false because of a true
        // failure (timeout, RLS, network), the DataProvider still holds
        // stale rows. Clearing dirty would let the sync effect
        // overwrite the user's just-saved local edit with the stale
        // DB read. Now stale-races return `true` from refresh (handled
        // in data-context.tsx), so `false` is reserved for real
        // failures — and in those we keep dirty marked so the next
        // save attempt re-pushes the data once the network recovers.
        // Techo: un refresh colgado se trata como fallo real (ok=false) —
        // dirty queda marcado y el próximo guardado re-empuja los datos.
        const ok = await withRowTimeout(refreshSections(['ingresos']), t('upload.opReloadData')).catch(() => false);
        if (ok) {
          clearDirty('ingresos');
          clearDirty('retiros');
        } else {
          showError(t('upload.incomeReloadWarning'));
        }
      } catch (err) {
        const message = (err as Error).message;
        Sentry.captureException(err, {
          tags: { area: 'upload.saveIncome' },
          extra: { periodId: selectedPeriodRef.current, companyId: company.id },
        });
        // `Error: ${message}` filtraba el texto CRUDO de Postgres a la pantalla
        // —nombres de tabla, de trigger, de constraint— que es justo lo que
        // §5.4 de docs/reglas-del-proyecto.md prohíbe («nunca error.message al
        // cliente»). El detalle va a Sentry, que ya lo capturó arriba; el
        // usuario recibe el mensaje estándar del repo, el mismo que usan las
        // otras diez rutas de guardado de esta pantalla.
        showError(t('upload.saveError', { error: t('upload.saveErrorGeneric') }));
        // dirty is intentionally NOT cleared on error — the user's
        // unsaved edits stay protected from the sync effect overwriting
        // them, so they can fix the network / validation issue and retry
        // without re-entering everything.
        void message; // el detalle vive en Sentry, no en la UI
      }
    })();
  };

  // Save All handler — saves all fields in the current section to Supabase.
  // Liquidez and Inversiones persist per-row so they're not in here (they
  // have Add/Edit/Save buttons right on each row).
  //
  // Bug fixed 2026-04-22: the previous version awaited `refresh()` BEFORE
  // flipping `savingAll` back to false. Since refresh() reloads the entire
  // data-context (periods + deposits + withdrawals + expenses + 14 more
  // tables with retries up to 60s), a slow refresh left the "Guardar todo"
  // button stuck in "Guardando..." state even though the real DB write had
  // already succeeded. Users assumed the save failed and retried, stacking
  // duplicate writes.
  //
  // New flow:
  //   1. Run the main save (upsertX) — this is the only thing we await.
  //   2. Show success + flip button state IMMEDIATELY.
  //   3. Kick off refresh() in the background — the UI can afford to show
  //      slightly stale numbers for a second while the context reloads.
  //   4. Hard 25s safety timeout around the main save so network death
  //      doesn't lock the button forever.
  // Candado re-entrante (fix 2026-06-20): el gate `if (savingAll)` del
  // autosave lee el STATE de React, que se actualiza async — si el timer del
  // autosave y el click en "Guardar Todo" caen en la misma ventana de render,
  // ambos veían savingAll=false y corrían DOS saveAll en paralelo (dos
  // reemplazos del período compitiendo). El ref es síncrono: el segundo
  // entrante sale inmediatamente.
  const saveAllInFlightRef = useRef(false);
  const saveAll = async () => {
    if (!userCanAdd || !company) return;
    if (saveAllInFlightRef.current) return;
    saveAllInFlightRef.current = true;
    setSavingAll(true);
    const companyId = company.id;
    const periodId = selectedPeriodRef.current;

    const SAVE_TIMEOUT_MS = 25_000;
    const timedSave = async (work: () => Promise<void>, label: string) => {
      await Promise.race([
        work(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(t('upload.saveTimeout', { label }))),
            SAVE_TIMEOUT_MS,
          ),
        ),
      ]);
    };

    // BUG-03: persistir TODAS las secciones con cambios sin guardar, no solo
    // la visible. Antes saveAll solo guardaba `section`, así que editar
    // Depósitos, cambiar a Egresos y dejar correr el autosave dejaba Depósitos
    // sin persistir hasta volver a esa pestaña — se perdía al recargar. Ahora
    // guarda la unión de las secciones dirty + la visible.
    // Egresos NO entra: persiste por-acción (persistExpenses) y usa 'egresos'
    // dirty como mutex del sync-effect — batchearlo acá crearía una carrera.
    // Las secciones ajenas al modelo de negocio tampoco entran: no hay pestaña
    // que las haya editado.
    const SAVE_HANDLED: DataSection[] = (['depositos', 'retiros', 'ingresos'] as DataSection[])
      .filter((s) => allowedSections.includes(s));
    const targets = SAVE_HANDLED.filter((s) => dirtySections.has(s) || s === section);

    // Foto de los contadores de edición ANTES de escribir: al terminar se
    // compara para saber qué secciones el usuario siguió editando mientras
    // tanto (esas no se pueden re-hidratar sin borrarle lo tipeado).
    const ticksAtSave: Record<string, number> = { ...sectionTicksRef.current };

    // Guarda UNA sección y devuelve su mensaje de éxito. Las mutaciones son
    // atómicas/idempotentes, así que el solapamiento entre secciones (p.ej.
    // 'ingresos' y 'retiros' ambas escriben withdrawals desde el mismo estado)
    // es inofensivo.
    const saveSectionWork = async (sec: DataSection): Promise<string> => {
      if (sec === 'depositos') {
        await upsertDeposits(companyId, periodId, deposits);
        await upsertPropFirmSales(companyId, periodId, propFirmAmount);
        if (user) logAction(user.id, user.name, 'update', 'deposits', `Todos los depositos guardados para ${periodLabel}`);
        const nonZero = deposits.filter(d => d.amount !== 0).length;
        return nonZero === 1 ? t('upload.depositsSavedOne') : t('upload.depositsSavedMany', { count: String(nonZero) });
      } else if (sec === 'retiros') {
        const combined = [
          ...withdrawals.map(w => ({ category: w.category, amount: w.amount, description: null as string | null })),
          ...withdrawalExtras.map(w => ({ category: w.category, amount: w.amount, description: w.description || null })),
        ];
        await upsertWithdrawals(companyId, periodId, combined);
        await upsertP2PTransfers(companyId, periodId, p2pAmount);
        if (user) logAction(user.id, user.name, 'update', 'withdrawals', `Todos los retiros guardados para ${periodLabel}`);
        const nonZero = withdrawals.filter(w => w.amount !== 0).length + withdrawalExtras.length;
        return nonZero === 1 ? t('upload.withdrawalsSavedOne') : t('upload.withdrawalsSavedMany', { count: String(nonZero) });
      } else {
        // ingresos — mismo payload que saveIncome: income + prop firm ventas
        // + withdrawals (la pestaña Ingresos también posee esos campos).
        const combinedWithdrawals = [
          ...withdrawals.map(w => ({ category: w.category, amount: w.amount, description: null as string | null })),
          ...withdrawalExtras.map(w => ({ category: w.category, amount: w.amount, description: w.description || null })),
        ];
        await upsertOperatingIncome(companyId, periodId, income);
        if (showBrokerPnl) await upsertPropFirmSales(companyId, periodId, propFirmAmount);
        if (showWithdrawals) await upsertWithdrawals(companyId, periodId, combinedWithdrawals);
        if (user) logAction(user.id, user.name, 'update', 'income', `Ingresos operativos guardados para ${periodLabel}`);
        return t('upload.incomeSavedOk');
      }
    };

    const saved: DataSection[] = [];
    const messages: string[] = [];
    let successMsg = t('upload.dataSaved');
    try {
      await timedSave(async () => {
        for (const sec of targets) {
          messages.push(await saveSectionWork(sec));
          saved.push(sec);
        }
      }, t('upload.opSaveAll'));
      successMsg = messages.length <= 1
        ? (messages[0] ?? successMsg)
        : t('upload.sectionsSaved', { count: String(saved.length) });

      // Main save succeeded. Show success + unlock the button NOW.
      showSuccess(successMsg);
      saveAllInFlightRef.current = false;
      setSavingAll(false);
      setLastSavedAt(new Date());
      Sentry.addBreadcrumb({
        category: 'upload.save',
        message: 'saveAll:success',
        data: { sections: saved, periodId },
      });

      // Refresh + THEN clear the dirty flag for the saved section.
      //
      // Bug fixed 2026-05-02: clearing dirty BEFORE refresh completed
      // raced with the sync effect. When dirty flipped to null, the
      // effect ran `setExpensesRaw(loadExpensesForPeriod(...))` which
      // read `allExpenses` from the DataProvider — still pre-save
      // because refresh is async and hadn't propagated yet. Local state
      // was overwritten with stale DB rows, dropping the just-saved
      // additions. The user saw "no quedaron guardados" even though the
      // upsert succeeded.
      //
      // Updated 2026-05-13: clearDirty is now scoped to the section
      // we just saved, so editing in a DIFFERENT section concurrently
      // is no longer wiped on refresh. Ingresos also clears 'retiros'
      // because that's what its payload upserts.
      //
      // Updated 2026-06-06 (regression fix): only clearDirty when the
      // refresh REALLY succeeded. Previously, on refresh failure we
      // still cleared dirty + showed a toast — but the sync effect
      // would then re-hydrate local state from the stale DataProvider,
      // wiping the user's just-saved row from view. The user's next
      // edit + save would then re-upsert with the (now-overwritten)
      // stale array and erase what was originally persisted. With this
      // guard, on a real refresh failure the dirty stays marked, the
      // banner stays up, and the next save attempt re-pushes the
      // current local view (which is correct).
      // B1: refresh selectivo — solo las tablas de las secciones guardadas
      // (2-3 queries c/u) en vez de recargar toda la empresa (~19 queries).
      // Techo: sin él, un refresh colgado dejaba savingAll=true para siempre
      // y bloqueaba el autosave entero. Timeout ⇒ ok=false (dirty se conserva).
      const ok = await withRowTimeout(
        refreshSections(saved as Array<'depositos' | 'retiros' | 'egresos' | 'ingresos' | 'liquidez' | 'inversiones'>),
        t('upload.opReloadData'),
      ).catch(() => false);
      if (ok) {
        for (const sec of saved) {
          // Limpiar dirty dispara el re-sync, que re-hidrata la sección desde
          // la base. Si el usuario siguió escribiendo mientras se guardaba,
          // eso le borraría lo tipeado: la sección queda sucia, el autosave
          // vuelve a disparar y lo persiste completo en la pasada siguiente.
          if (sectionTicksRef.current[sec] !== ticksAtSave[sec]) continue;
          clearDirty(sec);
          if (sec === 'ingresos' && sectionTicksRef.current['retiros'] === ticksAtSave['retiros']) {
            clearDirty('retiros');
          }
        }
      } else {
        showError(t('upload.savedReloadWarning'));
      }
    } catch (err) {
      const message = (err as Error).message;
      Sentry.captureException(err, {
        tags: { area: 'upload.saveAll', section },
        extra: { periodId, companyId, periodLabel },
      });
      showError(t('upload.saveError', { error: message }));
      saveAllInFlightRef.current = false;
      setSavingAll(false);
      // Excepción: si el rechazo es por PERÍODO CERRADO, mantener dirty solo
      // alimentaría el bucle de reintentos del autosave (el trigger va a
      // rechazar siempre). Se limpia y el sync re-hidrata la vista desde la
      // base — el estado real del mes cerrado.
      if (/per[ií]odo est[aá] cerrado/i.test(message)) {
        for (const sec of Array.from(dirtySections)) clearDirty(sec as DataSection);
        return;
      }
      // dirty is intentionally NOT cleared on error — the user's
      // in-progress edits stay protected so they can retry without
      // re-entering everything. The granular dirty Set means this no
      // longer blocks other sections from re-syncing.
    }
  };


  // Liquidity totals
  const liqTotalDeposits = filteredLiquidity.reduce((s, r) => s + r.deposit, 0);
  const liqTotalWithdrawals = filteredLiquidity.reduce((s, r) => s + r.withdrawal, 0);

  // Investment totals
  const invTotalDeposits = filteredInvestments.reduce((s, r) => s + r.deposit, 0);
  const invTotalWithdrawals = filteredInvestments.reduce((s, r) => s + r.withdrawal, 0);
  const invTotalProfit = filteredInvestments.reduce((s, r) => s + r.profit, 0);

  // Balance maps — computed on-the-fly. The stored `balance` column is
  // unreliable (insert passes 0; recalc* never runs). Use these everywhere
  // we need a per-row or cumulative balance.
  const liqBalanceMap = useMemo(() => {
    const map = new Map<string, number>();
    const sorted = [...liquidityRows].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    for (const r of sorted) {
      running += r.deposit - r.withdrawal;
      map.set(r.id, running);
    }
    return map;
  }, [liquidityRows]);
  const invBalanceMap = useMemo(() => {
    const map = new Map<string, number>();
    const sorted = [...investmentRows].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    for (const r of sorted) {
      running += r.deposit - r.withdrawal + r.profit;
      map.set(r.id, running);
    }
    return map;
  }, [investmentRows]);

  const liqCurrentBalance = useMemo(() => {
    if (filteredLiquidity.length === 0) return 0;
    const sortedFiltered = [...filteredLiquidity].sort((a, b) => a.date.localeCompare(b.date));
    return liqBalanceMap.get(sortedFiltered.at(-1)!.id) ?? 0;
  }, [filteredLiquidity, liqBalanceMap]);
  const invCurrentBalance = useMemo(() => {
    if (filteredInvestments.length === 0) return 0;
    const sortedFiltered = [...filteredInvestments].sort((a, b) => a.date.localeCompare(b.date));
    return invBalanceMap.get(sortedFiltered.at(-1)!.id) ?? 0;
  }, [filteredInvestments, invBalanceMap]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('upload.title')} subtitle={t('upload.subtitle')} />

      {/* Feedback lives in the floating ToastHost at bottom-right. Rendered
          at the end of this component so it sits above everything else. */}

      {/* Mes cerrado: aviso fijo. Los totales están congelados y el trigger
          de la base rechaza cualquier escritura; el autosave y el botón de
          guardar quedan apagados. */}
      {selectedPeriodIsClosed && (
        <Notice kind="info" title={t('upload.ledger.closedTitle', { period: periodLabel })}>
          {t('upload.ledger.closedBody')}
          {/* El remedio se ofrece sólo a quien puede aplicarlo. Con el modelo
              `liquidity_provider` (que sí carga inversiones pero no tiene el
              módulo Períodos) este enlace mandaba a un 403: un consejo que no
              se puede seguir es peor que ninguno. */}
          {canManagePeriods && (
            <>
              {' '}
              {t('upload.ledger.closedFixBefore')}{' '}
              <Link href="/periodos" className="font-medium text-foreground underline">
                {t('upload.ledger.periodsLink')}
              </Link>{' '}
              {t('upload.ledger.closedFixAfter')}
            </>
          )}
        </Notice>
      )}

      {/* Pestañas: el registro (`uploadSections`) decide cuáles y en qué orden. */}
      <div className="overflow-x-auto pb-0.5">
        <Segmented
          aria-label={t('upload.ledger.sectionsAria')}
          value={section}
          onChange={(s) => setSection(s)}
          options={allowedSections.map((s) => ({ value: s, label: t(SECTION_KEYS[s]) }))}
        />
      </div>

      {/* DEPOSITOS */}
      {section === 'depositos' && (
        <DepositsPanel
          rows={deposits}
          periodLabel={periodLabel}
          closed={selectedPeriodIsClosed}
          editable={userCanAdd}
          savingIds={savingDepositIds}
          onAmountChange={(id, raw) =>
            setDeposits(prev => prev.map(dd => dd.id === id ? { ...dd, amount: parseFloat(raw) || 0 } : dd))
          }
          onSaveRow={(id, amount) => updateDeposit(id, amount)}
          propFirm={{
            amount: propFirmAmount,
            crmHint: crmHint('propfirm_sales'),
            onChange: (raw) => setPropFirmAmount(parseFloat(raw) || 0),
          }}
        />
      )}

      {/* RETIROS */}
      {section === 'retiros' && (
        <WithdrawalsPanel
          rows={withdrawals}
          periodLabel={periodLabel}
          closed={selectedPeriodIsClosed}
          editable={userCanAdd}
          savingIds={savingWithdrawalIds}
          auto={{ brokerIsDerived, derivedBrokerAmount, ibEffective }}
          onAmountChange={(id, raw) =>
            setWithdrawals(prev => prev.map(ww => ww.id === id ? { ...ww, amount: parseFloat(raw) || 0 } : ww))
          }
          onSaveRow={(id, amount) => updateWithdrawal(id, amount)}
          p2p={{
            amount: p2pAmount,
            crmHint: crmHint('p2p_transfers'),
            onChange: (raw) => setP2PAmount(parseFloat(raw) || 0),
          }}
          extras={withdrawalExtras}
          newExtra={newExtraWithdrawal}
          setNewExtra={setNewExtraWithdrawal}
          onAddExtra={() => {
            const amt = parseFloat(newExtraWithdrawal.amount) || 0;
            if (!newExtraWithdrawal.description.trim() || amt <= 0) return;
            setWithdrawalExtras(prev => [...prev, {
              id: `extra-${Date.now()}`,
              category: newExtraWithdrawal.category,
              amount: amt,
              description: newExtraWithdrawal.description.trim(),
            }]);
            setNewExtraWithdrawal({ category: 'broker', amount: '', description: '' });
          }}
          onRemoveExtra={(id) => setWithdrawalExtras(prev => prev.filter(x => x.id !== id))}
        />
      )}

      {/* EGRESOS — se queda en este archivo: cada <tr> lo crea useSortable
          (dnd-kit), la fila en edición reemplaza todas sus celdas y el alta
          tiene dos autocompletados atados a refs y estado de la página.
          Extraerlo era mover ~30 props de la pestaña con el guard de huella;
          ver el reporte de la migración. Sólo cambió la presentación. */}
      {section === 'egresos' && (
        <Panel
          title={t('summary.operatingExpenses')}
          hint={periodLabel}
          flush
          actions={
            <>
              {selectedPeriodIsClosed && <ClosedBadge />}
              {userCanAdd && (
                <button
                  type="button"
                  onClick={() => { setImportOpen(true); setImportResult(null); }}
                  className={btnClass('secondary')}
                >
                  <Upload aria-hidden className="size-3.5" />
                  Importar Excel/CSV
                </button>
              )}
            </>
          }
          footer={
            expenses.length > PAGE_SIZE ? (
              <PaginationControls
                page={expensesPage}
                totalPages={expensesTotalPages}
                totalItems={expenses.length}
                onChange={setExpensesPage}
              />
            ) : undefined
          }
        >
          <div className="overflow-x-auto">
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleExpenseDragEnd}
          >
          <table className={cn(TABLE, 'min-w-[880px]')}>
            <caption className="sr-only">{t('summary.operatingExpenses')}</caption>
            <thead>
              <tr>
                <th className={cn(TH, 'w-8')} aria-label={t('upload.reorder')}></th>
                <th className={cn(TH, 'w-10 text-left')}>#</th>
                <th className={cn(TH, 'text-left')}>{t('upload.concept')}</th>
                <th className={cn(TH, 'text-left')}>{t('upload.category')}</th>
                {/* Fecha opcional (migration-056), DD/MM — el año lo da el
                    período. La tabla scrollea en móvil (overflow-x-auto). */}
                <th className={cn(TH, 'w-24 text-left')}>{t('expenses.date')}</th>
                <th className={cn(TH, 'text-left')}>Referencia</th>
                <th className={cn(TH, 'text-right')}>{t('common.amount')}</th>
                <th className={cn(TH, 'text-right')}>{t('expenses.paid')}</th>
                <th className={cn(TH, 'text-right')}>{t('expenses.pending')}</th>
                <th className={cn(TH, 'text-center')}>{t('common.status')}</th>
                {(userCanEdit || userCanDelete) && (
                  <th className={cn(TH, 'w-28 text-right')}>
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <SortableContext
              items={pagedExpenses.map((e) => e.id)}
              strategy={verticalListSortingStrategy}
            >
            <tbody>
              {expenses.length === 0 && (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-[13px] text-text-3">No hay egresos registrados. {userCanAdd && 'Agrega uno abajo.'}</td></tr>
              )}
              {pagedExpenses.map((exp, i) => (
                <SortableExpenseRow
                  key={exp.id}
                  id={exp.id}
                  disabled={!userCanEdit || editingExpenseId === exp.id}
                >
                  {editingExpenseId === exp.id ? (
                    <>
                      <td className={cn(TD, 'tabular-nums text-text-3')}>{expensesPage * PAGE_SIZE + i + 1}</td>
                      <td className={TD}>
                        <Input aria-label={t('upload.expenseConceptAria')} value={editExpense.concept} onChange={e => setEditExpense(p => ({ ...p, concept: e.target.value }))} className={INPUT_MOBILE} />
                        <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-[12px] text-text-3">
                          <input type="checkbox" aria-label={t('expenses.fixed')} checked={editExpense.is_fixed} onChange={e => setEditExpense(p => ({ ...p, is_fixed: e.target.checked }))} className="size-3.5" />
                          {t('expenses.fixed')} ({t('expenses.fixedHint')})
                        </label>
                      </td>
                      <td className={TD}>
                        <div className="relative">
                          <Input
                            aria-label={t('upload.category')}
                            value={editExpense.category}
                            onChange={e => { setEditExpense(p => ({ ...p, category: e.target.value })); setShowEditCategoryDropdown(true); }}
                            onFocus={() => setShowEditCategoryDropdown(true)}
                            onBlur={() => setTimeout(() => setShowEditCategoryDropdown(false), 200)}
                            placeholder={t('upload.category')}
                            className={INPUT_MOBILE}
                            autoComplete="off"
                          />
                          {showEditCategoryDropdown && filteredCategoriesEdit.length > 0 && (
                            <div className={cn(SUGGEST_LIST, 'z-30 max-h-40')}>
                              {filteredCategoriesEdit.map(c => (
                                <button
                                  key={c}
                                  type="button"
                                  onMouseDown={(e) => { e.preventDefault(); setEditExpense(p => ({ ...p, category: c })); setShowEditCategoryDropdown(false); }}
                                  className={SUGGEST_ITEM}
                                >
                                  {c}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className={TD}>
                        <Input
                          type="date"
                          aria-label={t('expenses.dateAria')}
                          value={editExpense.expense_date}
                          onChange={e => setEditExpense(p => ({ ...p, expense_date: e.target.value }))}
                          className={cn(INPUT_MOBILE, 'px-1.5')}
                        />
                      </td>
                      {/* Referencia del pago: hash, nº de operación o link. */}
                      <td className={TD}>
                        <Input
                          aria-label="Referencia del egreso"
                          placeholder="hash o link"
                          value={editExpense.reference}
                          onChange={e => setEditExpense(p => ({ ...p, reference: e.target.value }))}
                          className={INPUT_MOBILE}
                        />
                        {/* Un comprobante heredado de una orden de pago no se
                            reemplaza desde acá: la fuente es la orden. */}
                        <ExpenseAttachmentInput
                          className="mt-1"
                          value={editExpense.attachment}
                          readOnly={editExpense.attachment?.bucket === 'payment-proofs'}
                          onChange={a => setEditExpense(p => ({ ...p, attachment: a }))}
                        />
                      </td>
                      <td className={TD}><Input type="number" step="0.01" aria-label={t('upload.expenseAmountAria')} value={editExpense.amount} onChange={e => setEditExpense(p => ({ ...p, amount: e.target.value }))} className={INPUT_NUM} /></td>
                      <td className={TD}><Input type="number" step="0.01" aria-label={t('expenses.paid')} value={editExpense.paid} onChange={e => setEditExpense(p => ({ ...p, paid: e.target.value }))} className={INPUT_NUM} /></td>
                      <td className={TD}><Input type="number" step="0.01" aria-label={t('expenses.pending')} value={editExpense.pending} onChange={e => setEditExpense(p => ({ ...p, pending: e.target.value }))} className={INPUT_NUM} /></td>
                      <td className={TD}></td>
                      <td className={cn(TD, 'text-right')}>
                        <div className="inline-flex gap-1">
                          <button type="button" onClick={saveEditExpense} disabled={selectedPeriodIsClosed} className={ROW_BTN} aria-label={t('common.save')}><Check aria-hidden className="size-4" /></button>
                          <button type="button" onClick={() => setEditingExpenseId(null)} className={ROW_BTN} aria-label={t('common.cancel')}><X aria-hidden className="size-4" /></button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={cn(TD, 'tabular-nums text-text-3')}>{expensesPage * PAGE_SIZE + i + 1}</td>
                      {/* Solo en la vista de lectura: si el egreso salió de una
                          orden de pago, el número de OP linkea a su detalle.
                          Dentro del modo edición el concepto es un <input> y
                          no lleva link. */}
                      <td className={TD}>
                        <ExpenseConcept
                          concept={exp.concept}
                          paymentOrderId={exp.payment_order_id}
                          description={exp.payment_order_description}
                          suffix={exp.is_fixed ? (
                            <StatusBadge kind="neutral" label={t('expenses.fixedBadge')} />
                          ) : null}
                        />
                      </td>
                      <td className={TD}>
                        {exp.category ? (
                          <span className="text-text-2">{exp.category}</span>
                        ) : (
                          <span className="text-text-3">—</span>
                        )}
                      </td>
                      <td className={cn(TD, 'whitespace-nowrap tabular-nums text-text-3')}>
                        {exp.expense_date ? formatDayMonth(exp.expense_date) : '—'}
                      </td>
                      <td className={cn(TD, 'max-w-[160px]')}>
                        <ExpenseReference
                          expenseId={exp.id}
                          reference={exp.reference}
                          attachmentName={exp.attachment_name}
                          hasAttachment={!!exp.attachment_path}
                        />
                      </td>
                      <td className={cn(TD, 'text-right')}><Money value={exp.amount} className="font-medium" /></td>
                      <td className={cn(TD, 'text-right')}><Money value={exp.paid} /></td>
                      <td className={cn(TD, 'text-right')}><Money value={exp.pending} /></td>
                      <td className={cn(TD, 'text-center')}>
                        <StatusBadge
                          domain="expense"
                          status={exp.pending === 0 ? 'pagado' : 'pendiente'}
                          label={exp.pending === 0 ? t('upload.paidStatus') : t('upload.pendingStatus')}
                        />
                      </td>
                      {(userCanEdit || userCanDelete) && (
                        <td className={cn(TD, 'text-right')}>
                          <div className="inline-flex gap-1">
                            {userCanEdit && exp.pending > 0 && (
                              <button type="button" onClick={() => markExpensePaid(exp.id)} disabled={selectedPeriodIsClosed} className={ROW_BTN} title={t('upload.markPaid')} aria-label={t('upload.markPaidAria', { concept: exp.concept })}><Check aria-hidden className="size-3.5" /></button>
                            )}
                            {userCanEdit && (
                              <button type="button" onClick={() => startEditExpense(exp)} disabled={selectedPeriodIsClosed} className={ROW_BTN} title={t('common.edit')} aria-label={t('common.edit')}><Edit2 aria-hidden className="size-3.5" /></button>
                            )}
                            {userCanDelete && (
                              <button type="button" onClick={() => deleteExpense(exp.id)} disabled={selectedPeriodIsClosed} className={ROW_BTN_DANGER} title={t('common.delete')} aria-label={t('common.delete')}><Trash2 aria-hidden className="size-3.5" /></button>
                            )}
                          </div>
                        </td>
                      )}
                    </>
                  )}
                </SortableExpenseRow>
              ))}
            </tbody>
            </SortableContext>
            {expenses.length > 0 && (
              <tfoot>
                <tr>
                  <td className={TFOOT_TD} colSpan={6}>{t('common.total')}</td>
                  <td className={cn(TFOOT_TD, 'text-right')}><Money value={expenses.reduce((s, e) => s + e.amount, 0)} /></td>
                  <td className={cn(TFOOT_TD, 'text-right')}><Money value={expenses.reduce((s, e) => s + e.paid, 0)} /></td>
                  <td className={cn(TFOOT_TD, 'text-right')}><Money value={expenses.reduce((s, e) => s + e.pending, 0)} /></td>
                  <td className={TFOOT_TD} colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
          </DndContext>
          </div>

          {/* Add expense form */}
          {userCanAdd && (
            <div className="border-t border-border p-4">
              <h3 className="mb-3 flex items-center gap-2 text-[13.5px] font-semibold text-foreground"><Plus aria-hidden className="size-4" /> {t('upload.addExpense')}</h3>
              <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-8">
                <Field label={t('upload.concept')} className="md:col-span-2">
                  <div className="relative">
                    <Input
                      ref={conceptInputRef}
                      value={newExpense.concept}
                      onChange={e => { setNewExpense(p => ({ ...p, concept: e.target.value })); setShowConceptDropdown(true); }}
                      onFocus={() => setShowConceptDropdown(true)}
                      onBlur={() => setTimeout(() => setShowConceptDropdown(false), 200)}
                      placeholder={t('upload.conceptPlaceholder')}
                      className={INPUT_MOBILE}
                      autoComplete="off"
                    />
                    {showConceptDropdown && filteredConcepts.length > 0 && (
                      <div className={cn(SUGGEST_LIST, 'z-20 max-h-48')}>
                        {filteredConcepts.map(c => (
                          <button
                            key={c}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); setNewExpense(p => ({ ...p, concept: c })); setShowConceptDropdown(false); }}
                            className={SUGGEST_ITEM}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </Field>
                <Field label={t('upload.category')} hint={newExpense.category && !filteredCategoriesNew.some(c => c.toLowerCase() === newExpense.category.toLowerCase()) ? t('upload.newCategoryHint') : undefined}>
                  <div className="relative">
                    <Input
                      value={newExpense.category}
                      onChange={e => { setNewExpense(p => ({ ...p, category: e.target.value })); setShowCategoryDropdown(true); }}
                      onFocus={() => setShowCategoryDropdown(true)}
                      onBlur={() => setTimeout(() => setShowCategoryDropdown(false), 200)}
                      placeholder={t('upload.category')}
                      className={INPUT_MOBILE}
                      autoComplete="off"
                    />
                    {showCategoryDropdown && filteredCategoriesNew.length > 0 && (
                      <div className={cn(SUGGEST_LIST, 'z-20 max-h-48')}>
                        {filteredCategoriesNew.map(c => (
                          <button
                            key={c}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); setNewExpense(p => ({ ...p, category: c })); setShowCategoryDropdown(false); }}
                            className={SUGGEST_ITEM}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </Field>
                {/* Fecha opcional del egreso — vacía = sin día específico. */}
                <Field label={t('expenses.date')}>
                  <Input
                    type="date"
                    aria-label={t('expenses.dateAria')}
                    title={t('expenses.dateHint')}
                    value={newExpense.expense_date}
                    onChange={e => setNewExpense(p => ({ ...p, expense_date: e.target.value }))}
                    className={INPUT_MOBILE}
                  />
                </Field>
                {/* Referencia del pago — opcional. Los egresos que nacen de una
                    orden la heredan sola; este campo es para los manuales. */}
                <Field label="Referencia">
                  <Input
                    aria-label="Referencia del egreso"
                    title="Hash de la transacción, nº de operación o link al comprobante"
                    value={newExpense.reference}
                    onChange={e => setNewExpense(p => ({ ...p, reference: e.target.value }))}
                    placeholder="Referencia"
                    className={INPUT_MOBILE}
                  />
                  <ExpenseAttachmentInput
                    className="mt-1"
                    value={newExpense.attachment}
                    onChange={a => setNewExpense(p => ({ ...p, attachment: a }))}
                  />
                </Field>
                <Field label={t('common.amount')}>
                  <Input
                    type="number" step="0.01"
                    value={newExpense.amount}
                    onChange={e => setNewExpense(p => ({ ...p, amount: e.target.value }))}
                    placeholder={t('upload.amountPlaceholder')}
                    className={INPUT_NUM}
                  />
                </Field>
                <Field label={t('expenses.paid')}>
                  <Input
                    type="number" step="0.01"
                    value={newExpense.paid}
                    onChange={e => setNewExpense(p => ({ ...p, paid: e.target.value }))}
                    placeholder={t('upload.paidPlaceholder')}
                    className={INPUT_NUM}
                  />
                </Field>
                <button
                  type="button"
                  onClick={addExpense}
                  disabled={!newExpense.concept || !newExpense.amount || savingExpenses || selectedPeriodIsClosed}
                  className={btnClass('secondary', 'md:mt-[22px]')}
                >
                  {savingExpenses ? t('common.saving') : t('common.add')}
                </button>
              </div>
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={newExpense.is_fixed}
                  onChange={e => setNewExpense(p => ({ ...p, is_fixed: e.target.checked }))}
                  className="size-4"
                />
                <span>
                  <strong className="font-semibold">{t('expenses.fixed')}</strong>
                  <span className="text-text-2"> — {t('expenses.fixedHint')}</span>
                </span>
              </label>
            </div>
          )}

          {/* Plantillas de Egresos Fijos — el ocultar/mostrar aplica al
              período seleccionado (migration-050). Tras un cambio recargamos
              egresos + plantillas + overrides para reflejar el nuevo estado.
              Solo re-sincroniza si la sección no está sucia (el sync effect
              respeta dirtySections). */}
          <div className="px-4 pb-4">
          <FixedExpenseTemplatesPanel
            selectedPeriodId={selectedPeriod}
            selectedPeriodLabel={periodLabel}
            // Ocultar/mostrar borra o inserta la fila fija de ESTE mes: por la
            // cola de egresos, para que al vaciarse el buffer y su huella se
            // re-siembren juntos. Antes solo refrescaba y el buffer seguía con
            // la fila oculta (el próximo guardado la resucitaba); con el
            // guard de huella, además, daba un 409 falso.
            onChanged={() => {
              void enqueueExpenseWrite(selectedPeriodRef.current, async () => {
                await withRowTimeout(refreshSections(['egresos']), t('upload.opReloadData')).catch(() => {
                  console.warn('[egresos] refresh after template change failed');
                });
              });
            }}
          />
          </div>
        </Panel>
      )}

      {/* INGRESOS OPERATIVOS */}
      {section === 'ingresos' && (() => {
        // Prop Firm fields share state with the Depósitos and Retiros tabs:
        //   · ventas → `propFirmAmount` (writes to prop_firm_sales table)
        //   · retiros → withdrawals row with category='prop_firm'
        // Editing here updates the same source — when the Orion CRM API goes
        // live the inputs become read-only / API-driven without changing the
        // schema, since `summary.propFirmNetIncome` already feeds resumen-
        // general and admin-home off the same fields.
        const propFirmWithdrawal =
          withdrawals.find(w => w.category === 'prop_firm')?.amount || 0;
        const propFirmNet = propFirmAmount - propFirmWithdrawal;
        // El Broker P&L salió de esta suma junto con su input: acá abajo se
        // muestra el total de lo que ESTA PANTALLA carga. El ingreso completo
        // —con el P&L automático del CRM— es el de /resumen-general, que sale
        // de la cadena canónica. Sumar acá un `broker_pnl` que ya nadie edita
        // mostraría un total que no coincide con ninguna otra pantalla.
        const totalIngresos = income.other + propFirmNet;
        // ── El Broker P&L YA NO SE TECLEA ────────────────────────────
        // Kevin, 2026-08-31: "dejalo automatizado, eliminemos lo
        // manual". El campo estaba acá y agosto 2026 de Vex Pro tenía
        // $671.000 escritos contra los $386.665,54 que da el cierre
        // diario del CRM: $284.334,46 de diferencia sobre un número que
        // entra a la base distribuible de los socios.
        // Ahora sale de `crm_daily_pnl` (ver src/lib/broker-pnl.ts) y se
        // muestra en /resumen-general diciendo de dónde salió.
        // El VALOR VIEJO NO SE BORRA de `operating_income.broker_pnl`:
        // es el que conservan los nueve períodos ya cerrados, que son
        // inmutables. Sacar el input es sacar la forma de PISARLO.
        return (
          <OperatingIncomePanel
            periodLabel={periodLabel}
            closed={selectedPeriodIsClosed}
            editable={userCanAdd}
            other={{
              editable: userCanAdd && incomeLines.length === 0,
              value: income.other,
              display: incomeLines.length > 0 ? incomeTotals.received : income.other,
              fromDetail: incomeLines.length > 0,
              onChange: (raw) => setIncome(p => ({ ...p, other: parseFloat(raw) || 0 })),
            }}
            propFirm={{
              show: showBrokerPnl,
              sales: propFirmAmount,
              withdrawal: propFirmWithdrawal,
              net: propFirmNet,
              onSalesChange: (raw) => {
                setPropFirmAmount(parseFloat(raw) || 0);
                markDirty('ingresos');
              },
              onWithdrawalChange: (raw) => {
                const v = parseFloat(raw) || 0;
                // setWithdrawals also marks 'retiros' dirty internally;
                // we override to 'ingresos' below so the unsaved-banner
                // shows in this tab where the user is actually working.
                setWithdrawals(prev => prev.map(w =>
                  w.category === 'prop_firm' ? { ...w, amount: v } : w,
                ));
                markDirty('ingresos');
              },
            }}
            total={totalIngresos}
            onSave={saveIncome}
          >
            <IncomeLinesSection
              income={incomeLinesState}
              userCanAdd={userCanAdd}
              userCanEdit={userCanEdit}
              userCanDelete={userCanDelete}
              periodIsClosed={selectedPeriodIsClosed}
            />
          </OperatingIncomePanel>
        );
      })()}

      {/* LIQUIDEZ */}
      {section === 'liquidez' && (
        <MovementsLedger
          title={t('upload.liquidity')}
          caption={t('upload.liquidity')}
          emptyText={t('upload.noLiquidity')}
          filters={
            <MovementFilters
              dateFrom={liqDateFrom}
              dateTo={liqDateTo}
              periodFilter={liqPeriodFilter}
              sortAsc={liqSortAsc}
              periods={periods}
              onDateFrom={setLiqDateFrom}
              onDateTo={setLiqDateTo}
              onPeriodFilter={setLiqPeriodFilter}
              onToggleSort={() => setLiqSortAsc(prev => !prev)}
              onClear={() => { setLiqDateFrom(''); setLiqDateTo(''); setLiqPeriodFilter('todos'); }}
            />
          }
          rows={pagedLiquidity}
          totalItems={filteredLiquidity.length}
          page={liquidityPage}
          totalPages={liquidityTotalPages}
          onPageChange={setLiquidityPage}
          fields={[
            { key: 'date', header: t('upload.date'), kind: 'date', read: (r: LiquidityMovement) => r.date },
            { key: 'user_email', header: t('upload.userEmail'), kind: 'text', read: (r: LiquidityMovement) => r.user_email },
            { key: 'mt_account', header: t('upload.mtAccount'), kind: 'text', read: (r: LiquidityMovement) => r.mt_account, hideSm: true },
            { key: 'deposit', header: t('upload.deposit'), kind: 'flow', read: (r: LiquidityMovement) => r.deposit },
            { key: 'withdrawal', header: t('upload.withdrawal'), kind: 'flow', read: (r: LiquidityMovement) => r.withdrawal },
          ]}
          balanceOf={(r) => liqBalanceMap.get(r.id) ?? 0}
          totals={{ deposit: liqTotalDeposits, withdrawal: liqTotalWithdrawals, balance: liqCurrentBalance }}
          canEdit={userCanEdit}
          canDelete={userCanDelete}
          canAdd={userCanAdd}
          editingId={editingLiqId}
          edit={editLiq}
          setEdit={setEditLiq}
          onStartEdit={startEditLiq}
          onSaveEdit={saveEditLiq}
          onCancelEdit={() => setEditingLiqId(null)}
          onDelete={deleteLiqRow}
          newFields={[
            { key: 'date', label: t('upload.date'), kind: 'date' },
            { key: 'user_email', label: t('upload.userEmail'), kind: 'text', placeholder: t('upload.emailPlaceholder') },
            { key: 'mt_account', label: t('upload.mtAccount'), kind: 'text', placeholder: t('upload.mtAccountPlaceholder') },
            { key: 'deposit', label: t('upload.deposit'), kind: 'number', placeholder: t('upload.depositPlaceholder') },
            { key: 'withdrawal', label: t('upload.withdrawal'), kind: 'number', placeholder: t('upload.withdrawalPlaceholder') },
          ]}
          newValue={newLiq}
          setNew={setNewLiq}
          onAdd={addLiquidityRow}
          addDisabled={!newLiq.date || !newLiq.user_email || savingLiq}
          saving={savingLiq}
        />
      )}

      {/* INVERSIONES */}
      {section === 'inversiones' && (
        <MovementsLedger
          title={t('upload.investments')}
          caption={t('upload.investments')}
          emptyText={t('upload.noInvestments')}
          filters={
            <MovementFilters
              dateFrom={invDateFrom}
              dateTo={invDateTo}
              periodFilter={invPeriodFilter}
              sortAsc={invSortAsc}
              periods={periods}
              onDateFrom={setInvDateFrom}
              onDateTo={setInvDateTo}
              onPeriodFilter={setInvPeriodFilter}
              onToggleSort={() => setInvSortAsc(prev => !prev)}
              onClear={() => { setInvDateFrom(''); setInvDateTo(''); setInvPeriodFilter('todos'); }}
            />
          }
          rows={pagedInvestments}
          totalItems={filteredInvestments.length}
          page={investmentsPage}
          totalPages={investmentsTotalPages}
          onPageChange={setInvestmentsPage}
          fields={[
            { key: 'date', header: t('upload.date'), kind: 'date', read: (r: Investment) => r.date },
            { key: 'concept', header: t('upload.concept'), kind: 'text', read: (r: Investment) => r.concept },
            { key: 'responsible', header: t('upload.responsible'), kind: 'text', read: (r: Investment) => r.responsible, hideSm: true },
            { key: 'deposit', header: t('upload.deposit'), kind: 'flow', read: (r: Investment) => r.deposit },
            { key: 'withdrawal', header: t('upload.withdrawal'), kind: 'flow', read: (r: Investment) => r.withdrawal },
            { key: 'profit', header: t('upload.profit'), kind: 'flow', read: (r: Investment) => r.profit },
          ]}
          balanceOf={(r) => invBalanceMap.get(r.id) ?? 0}
          totals={{ deposit: invTotalDeposits, withdrawal: invTotalWithdrawals, profit: invTotalProfit, balance: invCurrentBalance }}
          canEdit={userCanEdit}
          canDelete={userCanDelete}
          canAdd={userCanAdd}
          editingId={editingInvId}
          edit={editInv}
          setEdit={setEditInv}
          onStartEdit={startEditInv}
          onSaveEdit={saveEditInv}
          onCancelEdit={() => setEditingInvId(null)}
          onDelete={deleteInvRow}
          newFields={[
            { key: 'date', label: t('upload.date'), kind: 'date' },
            { key: 'concept', label: t('upload.concept'), kind: 'text', placeholder: t('upload.conceptPlaceholder') },
            { key: 'responsible', label: t('upload.responsible'), kind: 'text', placeholder: t('upload.responsiblePlaceholder') },
            // Tipo de movimiento (migración 062): separa devolución de
            // capital de cobro de ganancias, que antes iban revueltas en
            // la misma columna de retiros.
            {
              key: 'movement_type',
              label: 'Tipo',
              kind: 'select',
              ariaLabel: 'Tipo de movimiento',
              options: [
                { value: '', label: 'Tipo (automático)' },
                ...SELECTABLE_MOVEMENT_TYPES.map(mt => ({ value: mt.key, label: mt.labelEs, title: mt.description })),
              ],
            },
            { key: 'deposit', label: t('upload.deposit'), kind: 'number', placeholder: t('upload.depositPlaceholder') },
            { key: 'withdrawal', label: t('upload.withdrawal'), kind: 'number', placeholder: t('upload.withdrawalPlaceholder') },
            { key: 'profit', label: t('upload.profit'), kind: 'number', placeholder: t('upload.profitPlaceholder') },
          ]}
          newValue={newInv}
          setNew={setNewInv}
          onAdd={addInvestmentRow}
          addDisabled={!newInv.date || savingInv}
          saving={savingInv}
        />
      )}

      {/* DOCUMENTOS */}
      {/* La pestaña Documentos se quitó (auditoría 2026-08-06, QW10): "subía"
          archivos guardando SOLO EL NOMBRE en localStorage — el archivo nunca
          llegaba a ningún storage y daba falsa sensación de respaldo
          documental. Los comprobantes reales viven adjuntos a cada egreso y a
          cada orden de pago, en buckets privados. Si algún día se quiere una
          biblioteca de documentos del período, la infra es la de
          expense-attachments. */}

      {/* Bottom bar: Period selector + Save All */}
      <SaveBar
        periods={periods}
        selectedPeriod={selectedPeriod}
        onPeriodChange={(id) => setSelectedPeriod(id)}
        showSave={userCanAdd && section !== 'liquidez' && section !== 'inversiones'}
        savingAll={savingAll}
        dirty={dirtySections.has(section)}
        lastSavedAt={lastSavedAt}
        closed={selectedPeriodIsClosed}
        onSave={saveAll}
      />

      {ConfirmModal}

      {/* Alcance de la edición de un egreso fijo (ver FixedForwardDialog). */}
      {forwardPending && (
        <FixedForwardDialog
          concept={forwardPending.concept}
          onChoose={applyExpenseForward}
          onClose={() => setForwardPending(null)}
        />
      )}

      {/* Diálogo de import de egresos: elegir archivo → preview con errores
          por fila → confirmar. Las filas entran por persistExpenses, el mismo
          camino que el alta manual. */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Importar egresos"
            className="max-h-[85vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-ui-xl border border-border bg-card p-5 shadow-3"
          >
            <h2 className="text-[15px] font-semibold text-foreground">Importar egresos — {periodLabel}</h2>
            <p className="text-[13px] text-text-2">
              Excel (.xlsx) o CSV con encabezados en la primera fila. Columnas:{' '}
              <strong className="text-foreground">Concepto</strong> y <strong className="text-foreground">Monto</strong> obligatorias;
              Categoría, Fecha, Pagado, Pendiente y Referencia opcionales.
              Nada se guarda hasta que confirmes.
            </p>

            <input
              type="file"
              accept=".xlsx,.csv"
              aria-label="Archivo de egresos"
              disabled={importing}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportFile(f);
                e.target.value = '';
              }}
              className="block w-full text-[13px] text-text-2 file:mr-3 file:h-8 file:rounded-ui-md file:border file:border-solid file:border-border-strong file:bg-card file:px-3 file:text-[13px] file:font-medium file:text-foreground hover:file:bg-surface-2"
            />

            {importing && <p className="text-[13px] text-text-3">Leyendo archivo…</p>}

            {importResult && (
              <div className="space-y-3">
                <p className="text-[13px] text-foreground">
                  <strong className="tabular-nums">{importResult.rows.length}</strong>{' '}
                  {importResult.rows.length === 1 ? 'fila lista' : 'filas listas'} ·{' '}
                  <span className={importResult.errors.length ? 'font-medium text-neg' : 'text-text-3'}>
                    {importResult.errors.length} con error
                  </span>
                </p>

                {/* Recorte del archivo: se cuenta y se avisa (reglas §1.2). */}
                {importResult.truncated && (
                  <Notice kind="pend" title="El archivo superaba 500 filas y se recortó">
                    Sólo se leyeron las primeras 500 filas de datos. Partí el archivo para cargar el resto.
                  </Notice>
                )}

                {importResult.errors.length > 0 && (
                  <div className="max-h-36 space-y-1 overflow-y-auto rounded-ui-md border border-neg/35 bg-neg-bg p-3 text-[12px] text-foreground">
                    {importResult.errors.map((e) => (
                      <p key={e.row}><strong className="text-neg">Fila {e.row}:</strong> {e.error}</p>
                    ))}
                  </div>
                )}

                {importResult.rows.length > 0 && (
                  <div className="max-h-40 overflow-y-auto rounded-ui-md border border-border text-[12px]">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border-strong text-left text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3">
                          <th className="px-2 py-1.5">Concepto</th>
                          <th className="px-2 py-1.5 text-right">Monto</th>
                          <th className="px-2 py-1.5 text-right">Pagado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importResult.rows.slice(0, 8).map((r, i) => (
                          <tr key={i} className="border-b border-border last:border-0">
                            <td className="max-w-[220px] truncate px-2 py-1.5">{r.concept}</td>
                            <td className="px-2 py-1.5 text-right"><Money value={r.amount} /></td>
                            <td className="px-2 py-1.5 text-right"><Money value={r.paid} /></td>
                          </tr>
                        ))}
                        {importResult.rows.length > 8 && (
                          <tr><td colSpan={3} className="px-2 py-1.5 text-text-3">
                            … y {importResult.rows.length - 8} más
                          </td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => { setImportOpen(false); setImportResult(null); }}
                className={btnClass('secondary')}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmImport}
                disabled={!importResult || importResult.rows.length === 0 || savingExpenses}
                className={btnClass('primary')}
              >
                {savingExpenses ? 'Guardando…' : `Agregar ${importResult?.rows.length ?? 0} egresos`}
              </button>
            </div>
          </div>
        </div>
      )}

      {ToastHost}
    </div>
  );
}
