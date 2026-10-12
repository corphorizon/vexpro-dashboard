'use client';

import { useMemo, useState } from 'react';
import { provisionalPeriodLabel } from '@/lib/pdf-provisional';
import {
  Users, Download, Plus, Pencil, Trash2, X, Check, ChevronDown, FileText, FileBarChart,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { Notice } from '@/components/ui/notice';
import { NUM_CLASS } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Field, Input } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/info-tip';
import { GLOSSARY } from '@/lib/glossary';
import { WITHDRAWAL_LABELS } from '@/lib/types';
import { PeriodSelector } from '@/components/period-selector';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { useAuth, canEdit } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { cn, round2 } from '@/lib/utils';
import { formatMoney, MONEY_LOCALE } from '@/lib/money';
import {
  anyAutoSeriesLoading,
  computeCheckedChain,
  incompleteNotice,
  pendingValueLabel,
} from '@/lib/distribution-inputs';
import { seriesState, sumChain } from '@/lib/chain-view';
import { downloadCSV } from '@/lib/csv-export';
import { useI18n } from '@/lib/i18n';
import { useConfirm } from '@/lib/use-confirm';
import { useAutoClearMessage } from '@/lib/use-auto-clear-message';
import {
  createPartner,
  updatePartner,
  deletePartner,
  updatePeriodReservePct,
  updateAllPeriodsReservePct,
} from '@/lib/supabase/mutations';
import { apiFetch } from '@/lib/api-fetch';
import { monthRange } from '@/lib/api-integrations/totals';
import type { ProviderDataset } from '@/lib/api-integrations/types';
import { allPeriodsUseDerivedBroker } from '@/lib/broker-logic';
import { depositChannelLabel } from '@/lib/deposit-channels';
import { withdrawalChannelLabel } from '@/lib/withdrawal-channels';
import { CRM_MONTHLY_OUTSIDE_RESULT_METRICS } from '@/lib/crm-monthly';
import {
  buildClientFlow,
  buildCrmInfoRows,
  longPeriodLabel,
  type ClientFlow,
} from '@/lib/monthly-close-pdf-data';
import { features } from '@/lib/business-model';
import { cardsFromLines, UNASSIGNED_CLIENT_KEY } from '@/lib/clients';
import { buildBilling } from '@/lib/reports/company-report';
import type { IncomeLine } from '@/lib/income-lines';
import type { PdfMonthlyCloseBilling } from '@/lib/pdf-export';
import {
  partnerHistory,
  partnerShareTable,
  type HistoryRow,
  type PartnerShareTableRow,
} from './partner-rows';

// ─────────────────────────────────────────────────────────────────────────────
// /socios — «Libro mayor» (2026-10-12, T3).
//
// Orden: cabecera → KPIs → avisos (cadena del CRM, deriva de meses cerrados,
// % que no suman 100) → reparto → historial.
//
// QUÉ CAMBIÓ Y POR QUÉ
//   · KPIs desde `sumChain` (chain-view.ts). Antes las tarjetas leían
//     `currentChain?.x ?? 0`, y `currentChain` es null en CONSOLIDADO: con
//     cualquier rango de meses la pantalla decía «Ingresos $0.00 · Monto a
//     distribuir $0.00» — el número plausible y falso (reglas §1.2/§1.3).
//     Ahora consolidado suma los meses y es «—» si alguno no es definitivo.
//   · Banner de la cadena: `Notice stale` mientras la serie del CRM viaja,
//     `bad` si falló (el informe queda incompleto). Antes `info`/`warning` a
//     mano, y en consolidado no había banner.
//   · Reparto: UNA tabla (socio, participación con barra proporcional, monto,
//     pie con el % real y el total), como `pdfPartnerTable` del cierre, con
//     los montos de `partnerShareRows` (partner-rows.ts). Se fue la tarjeta
//     de barras aparte y los seis hex de `COLORS` (color sin significado).
//     En consolidado con un mes pendiente los montos son «—» (antes sumaban
//     el fallback de ese mes).
//   · Historial: `FinTable` densa; un mes pendiente o ausente es «—» y el
//     pie dice cuántos meses suma («Total (5 de 6 meses)»).
//   · Formularios con `Field`/`Input` (label atado, borde 3:1).
//
// LO QUE NO CAMBIÓ: la fórmula (cadena canónica), el CSV, los tres PDF y sus
// insumos, y el bloqueo de «PDF mes» / «Cierre mensual» / PDF del historial
// mientras las series del CRM cargan (`seriesLoading`, incidente 2026-10-05).
// ─────────────────────────────────────────────────────────────────────────────

/** Botón secundario (spec §5.1). */
const BTN =
  'inline-flex h-8 items-center gap-1.5 rounded-ui-md border border-border-strong bg-card px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card [@media(pointer:coarse)]:h-10';
/** Botón primario: uno por pantalla («Agregar socio»; «Guardar» en los modales). */
const PRIMARY_BTN =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-ui-md border border-primary bg-primary px-3 text-[13px] font-medium text-brand-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:h-10';
/** Acción de fila (editar / borrar). */
const ROW_BTN =
  'inline-flex size-8 items-center justify-center rounded-ui-md text-text-2 hover:bg-surface-hover hover:text-foreground [@media(pointer:coarse)]:size-10';

const pctFmt = new Intl.NumberFormat(MONEY_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export default function SociosPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const isAdmin = canEdit(user);
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();
  const { periods, partners, partnerDistributions, getPeriodSummary, getDistributionInputs, getSnapshotDrifts, company, refresh, crmMonthlyTotals, autoSeriesStatus } = useData();

  // Esta pantalla no leía el modelo de negocio en ninguna línea, y el informe
  // de cierre que genera es el documento que reciben los socios: a una
  // consultora le imprimía "Broker P&L", "Prop Firm" y una sección entera de
  // "Flujo de Depósitos y Retiros de Clientes" con todo en $0,00. El registro
  // único decide qué preguntas tiene este negocio; acá solo se obedece.
  const model = features(company?.business_model);

  // ─── Partner management state ───
  const [showPartnerForm, setShowPartnerForm] = useState(false);
  const [editingPartner, setEditingPartner] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPercentage, setFormPercentage] = useState('');
  const [saving, setSaving] = useState(false);
  const [successMsg, showSuccessRaw] = useAutoClearMessage(3000);
  const [errorMsg, showErrorRaw] = useAutoClearMessage(5000);
  // `deleteConfirm` kept for legacy pattern compatibility in the two rows that
  // still reference it (they open the shared useConfirm modal via setter).
  const { confirm, Modal: ConfirmModal } = useConfirm();

  // ─── Reserve edit state ───
  const [showReserveEdit, setShowReserveEdit] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [reserveInput, setReserveInput] = useState('');

  // Get current period info
  const currentPeriod = mode === 'single' ? periods.find(p => p.id === selectedPeriodId) : null;
  const RESERVE_PCT = currentPeriod?.reserve_pct ?? 0.10;

  // ─── Distribución por período — FÓRMULA CANÓNICA COMPARTIDA (BUG-01) ───
  // Antes esta lógica vivía inline acá y una versión DIVERGENTE en
  // data-context.computeSaldoChain (/balances). Ahora ambas usan
  // computeDistributionChain (src/lib/distribution.ts, con tests). El
  // reparto real a socios (más abajo) sale de este chain.
  // FUENTE ÚNICA: los insumos salen de getDistributionInputs() del
  // data-context — el mismo constructor que usa computeSaldoChain y el
  // forecast, ya con el override de snapshot para períodos cerrados. Esta
  // pantalla tenía su propio constructor (vía getPeriodSummary), la segunda
  // copia que la auditoría 2026-08-06 marcó como riesgo de divergencia.
  //
  // computeCheckedChain (no la fórmula pelada): la misma cadena + la marca de
  // «serie del CRM que todavía no llegó». Incidente 2026-10-05 ~22:10: el
  // «PDF mes» de Vex Pro sep-2026 salió con Monto a distribuir $0 porque
  // Broker P&L y Prop Firm seguían en vuelo y la cadena cayó al manual 0.
  const periodChain = useMemo(
    () => computeCheckedChain(getDistributionInputs()),
    [getDistributionInputs],
  );

  // Ediciones retroactivas sobre meses cerrados: el número mostrado sale del
  // snapshot (estable), pero si las tablas vivas ya difieren conviene saberlo
  // — alguien tocó el pasado y hay que decidir si reabrir o revertir.
  const snapshotDrifts = useMemo(() => getSnapshotDrifts(), [getSnapshotDrifts]);

  // Get current period's chain data
  const currentChain = mode === 'single' ? periodChain.get(selectedPeriodId) : null;
  const reserveThisPeriod = currentChain?.reserveThisPeriod ?? 0;
  const accumulatedReserve = currentChain?.reserveAccumulated ?? 0;
  const carryDebt = currentChain?.deudaArrastradaEntrada ?? 0;
  const totalToDistribute = currentChain?.montoDistribuir ?? 0;

  // Ingresos / Egresos / Saldo a Favor: salen de la MISMA cadena que el
  // reparto, no de las tablas vivas (auditoría 2026-08, B2). Leerlos de
  // getPeriodSummary hacía que en un mes CERRADO las tarjetas mostraran los
  // números de hoy mientras la reserva, la deuda y el monto a distribuir de la
  // misma pantalla seguían mostrando los congelados.
  //
  // CONFESIÓN (2026-10-12): estos `?? 0` también pintaban los KPIs, y
  // `currentChain` es null en CONSOLIDADO → «$0.00» para cualquier rango. Los
  // KPIs ya salen de `sumChain` (más abajo, null = «—»); estos valores quedan
  // para los PDF (que cortan con `if (!currentChain) return`) y para los
  // textos de un período único con la cadena definitiva.
  const ingresosNetos = currentChain?.ingresosNetos ?? 0;
  const egresosNetos = currentChain?.egresosNetos ?? 0;
  const saldoAFavor = currentChain?.saldoAFavor ?? 0;

  // ─── Series del CRM que todavía no llegaron (incidente 2026-10-05) ───
  // `chainPending`: la reserva y el monto a distribuir de ESTE mes no son
  // definitivos (serie propia o arrastre de un mes anterior incompleto). Los
  // KPIs ya no leen esto (salen de `sumChain`, abajo); queda para el aviso de
  // % sin asignar. `seriesLoading` bloquea los PDF mientras las series viajan.
  const seriesLoading = anyAutoSeriesLoading(autoSeriesStatus);
  const chainPending = currentChain?.pendiente ?? false;
  const crmNotice = mode === 'single' ? incompleteNotice(currentChain) : null;
  const pdfDisabledTitle = 'Esperando datos del CRM…';
  // Historial: los meses `pendiente` NO suman a los totales (sumarlos con el
  // fallback 0 es el mismo número falso) y se dice cuántos quedaron afuera.
  const pendingHistoryLabels = periods
    .filter((p) => periodChain.get(p.id)?.pendiente)
    .map((p) => p.label ?? '');
  const pendingHistoryNote =
    pendingHistoryLabels.length > 0
      ? `Sin datos del CRM en ${pendingHistoryLabels.join(', ')}: ${
          pendingHistoryLabels.length === 1 ? 'ese mes no suma' : 'esos meses no suman'
        } a los totales.`
      : null;

  const distributions = mode === 'consolidated'
    ? (() => {
        const allDists = partnerDistributions.filter(d => selectedPeriodIds.includes(d.period_id));
        const byPartner = new Map<string, { id: string; period_id: string; partner_id: string; company_id: string; percentage: number; amount: number }>();
        for (const dist of allDists) {
          const existing = byPartner.get(dist.partner_id);
          if (existing) {
            existing.amount += dist.amount;
          } else {
            byPartner.set(dist.partner_id, { ...dist, id: `cons-${dist.partner_id}`, period_id: 'consolidated' });
          }
        }
        return Array.from(byPartner.values());
      })()
    : partnerDistributions.filter(d => d.period_id === selectedPeriodId);

  // Recalculate distribution amounts so the displayed number always reflects
  // the CURRENT `reserve_pct` and the CURRENT partner percentages, not the
  // stale `amount` column persisted by earlier sessions.
  //
  //  - Single period: amount = montoDistribuir(period) × partner.percentage
  //  - Consolidated:  amount = Σ over selected periods of
  //                              montoDistribuir(period_i) × partner.percentage
  //
  // This keeps historical consolidated months (Mar-2026 and older) coherent
  // with single-period views without rewriting the stored rows.
  //
  // Kevin (2026-06-06, screenshot Mayo): hay meses como Mayo donde
  // todavía NO se han guardado rows en partner_distributions (la primera
  // vez que se calcula la distribución). El código antiguo iteraba solo
  // sobre `distributions` (filtered de DB) → array vacío para esos meses
  // → la tabla mostraba 4 filas vía un fallback con amount "—". El total
  // daba $0.00 aunque el card "Monto a Distribuir" mostraba $4,580.71.
  //
  // Nueva lógica: siempre construir UNA fila por partner usando
  // partners[].percentage como fuente de verdad para el percentage de
  // hoy. Si hay row guardada, respetamos SU percentage (puede diferir
  // si se editó la distribución de un mes pasado). El amount se DERIVA
  // siempre de totalToDistribute × pct — nunca confiamos en el `amount`
  // persistido (queda stale al cambiar reserve_pct o partner.percentage).
  const effectiveDistributions = partners.map((p) => {
    const saved = distributions.find((d) => d.partner_id === p.id);
    const pct = saved?.percentage ?? p.percentage;
    // round2 en cada monto: es plata que se paga a socios. Sin redondear, el
    // producto float (totalToDistribute × pct) y su suma acumulan centavos de
    // drift → el total repartido no cuadra con el "Monto a Distribuir" (BUG-02).
    const amount = round2(
      mode === 'single'
        ? totalToDistribute > 0
          ? totalToDistribute * pct
          : 0
        : selectedPeriodIds.reduce((sum, pid) => {
            const md = periodChain.get(pid)?.montoDistribuir ?? 0;
            return sum + (md > 0 ? md * pct : 0);
          }, 0),
    );
    return {
      id: saved?.id ?? `derived-${p.id}`,
      partner_id: p.id,
      period_id: saved?.period_id ?? selectedPeriodId,
      company_id: p.company_id,
      percentage: pct,
      amount,
    };
  });

  const totalDistributed = round2(effectiveDistributions.reduce((sum, d) => sum + d.amount, 0));
  // Kevin (2026-06-06): el warning antiguo sumaba percentages de
  // `effectiveDistributions` (tabla partner_distributions atada al
  // período seleccionado). Si el período no tenía rows guardados (caso
  // común para meses recientes) el total daba 0 y el banner salía
  // diciendo "los porcentajes suman 0.0%" aunque la tabla Distribución
  // por Socio mostraba 100% claro. La UI siempre muestra
  // `partners[].percentage` — el warning debe leer la MISMA fuente.
  const totalPercentage = partners.reduce((sum, p) => sum + p.percentage, 0);
  const percentageMismatch =
    partners.length > 0 && Math.abs(totalPercentage - 1) > 0.001;

  // ─── Available percentage for new/edit partner ───
  const usedPercentage = partners.reduce((sum, p) => sum + p.percentage, 0);
  const availableForNew = 1 - usedPercentage;
  const availableForEdit = (partnerId: string) => {
    const other = partners.filter(p => p.id !== partnerId).reduce((sum, p) => sum + p.percentage, 0);
    return 1 - other;
  };

  // ─── Flash messages ───
  // Mutually exclusive: success clears any error and vice-versa, so the UI
  // never shows both panels at once.
  const showSuccess = (msg: string) => { showErrorRaw(''); showSuccessRaw(msg); };
  const showError = (msg: string) => { showSuccessRaw(''); showErrorRaw(msg); };

  // ─── Partner CRUD handlers ───
  const handleAddPartner = () => {
    setEditingPartner(null);
    setFormName('');
    setFormEmail('');
    setFormPercentage('');
    setShowPartnerForm(true);
  };

  const handleEditPartner = (id: string) => {
    const partner = partners.find(p => p.id === id);
    if (!partner) return;
    setEditingPartner(id);
    setFormName(partner.name);
    setFormEmail(partner.email || '');
    setFormPercentage((partner.percentage * 100).toFixed(1));
    setShowPartnerForm(true);
  };

  const handleSavePartner = async () => {
    const pct = parseFloat(formPercentage) / 100;
    if (!formName.trim()) return;
    if (isNaN(pct) || pct <= 0 || pct > 1) return;

    const maxPct = editingPartner ? availableForEdit(editingPartner) : availableForNew;
    if (pct > maxPct + 0.001) {
      showError(t('partners.maxPercentage', { available: (maxPct * 100).toFixed(1) }));
      return;
    }

    setSaving(true);
    try {
      if (editingPartner) {
        await updatePartner(editingPartner, {
          name: formName.trim(),
          email: formEmail.trim() || null,
          percentage: pct,
        });
        showSuccess(t('partners.updated'));
      } else {
        await createPartner(
          company?.id || '',
          formName.trim(),
          formEmail.trim() || null,
          pct,
        );
        showSuccess(t('partners.created'));
      }
      await refresh();
      setShowPartnerForm(false);
      setEditingPartner(null);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePartner = async (id: string) => {
    setSaving(true);
    try {
      await deletePartner(id);
      await refresh();
      showSuccess(t('partners.deleted'));
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Error');
    } finally {
      setSaving(false);
    }
  };

  // ─── Reserve handlers ───
  const handleOpenReserveEdit = () => {
    setReserveInput(((RESERVE_PCT) * 100).toFixed(1));
    setShowReserveEdit(true);
  };

  const handleSaveReserve = async (applyToAll: boolean) => {
    const pct = parseFloat(reserveInput) / 100;
    if (isNaN(pct) || pct < 0 || pct > 1) return;

    setSaving(true);
    try {
      if (applyToAll) {
        await updateAllPeriodsReservePct(company?.id || '', pct);
      } else if (currentPeriod) {
        await updatePeriodReservePct(currentPeriod.id, pct);
      }
      await refresh();
      showSuccess(t('partners.reserveUpdated'));
      setShowReserveEdit(false);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Error');
    } finally {
      setSaving(false);
    }
  };


  // ─── Exportes (cuerpos sin cambios; sólo se sacaron del JSX) ────────────
  const handleCsv = () => verify2FA(() => {
    const headers = ['Socio', 'Porcentaje', 'Monto'];
    const rows = effectiveDistributions.map(d => {
      const partner = partners.find(p => p.id === d.partner_id);
      return [partner?.name || '', `${(d.percentage * 100).toFixed(1)}%`, d.amount] as (string | number)[];
    });
    rows.push(['Total', '100%', totalDistributed]);
    downloadCSV('socios.csv', headers, rows);
  });

  const handlePdfMes = () => verify2FA(async () => {
    if (!currentPeriod || !currentChain) return;
    const { generatePartnerPeriodPDF } = await import('@/lib/pdf-export');
    // Mismo desglose y misma completitud que el Cierre mensual:
    // con una serie del CRM faltante el PDF imprime el aviso
    // arriba y «sin datos» en vez de ceros.
    await generatePartnerPeriodPDF({
      companyName: company?.name ?? '',
      companyLogoUrl: company?.logo_url ?? null,
      periodLabel: longPeriodLabel(currentPeriod),
      // El archivo conserva el nombre de siempre (label corto).
      fileLabel: currentPeriod.label ?? longPeriodLabel(currentPeriod),
      desglose: currentChain.desglose,
      ingresosNetos,
      egresosNetos,
      saldo: saldoAFavor,
      reservaMes: reserveThisPeriod,
      reservePct: currentPeriod.reserve_pct ?? 0.1,
      deudaEntrada: carryDebt,
      montoDistribuir: totalToDistribute,
      completeness: currentChain,
      // Mes abierto: el CRM todavía puede mover el número (pdf-provisional.ts).
      provisional: !currentPeriod.is_closed,
      partners: partners.map((p) => {
        const d = effectiveDistributions.find((dd) => dd.partner_id === p.id);
        return { name: p.name, pct: d?.percentage ?? p.percentage, amount: d?.amount ?? 0 };
      }),
    });
  });

  const handleCierreMensual = () => verify2FA(async () => {
    const sum = getPeriodSummary(selectedPeriodId);
    if (!sum || !currentPeriod) return;
    const pad = (n: number) => String(n).padStart(2, '0');
    const { from, to } = monthRange(`${currentPeriod.year}-${pad(currentPeriod.month)}`);

    // Flujo de clientes — MISMA fuente y filtros que /movimientos y
    // /balances: persisted-movements en modo 'pinned' (walletId
    // vacío). Los canales salen de los REGISTROS
    // (API_DEPOSIT_CHANNELS / API_WITHDRAWAL_CHANNELS) dentro de
    // `buildClientFlow`, no de una lista de slugs escrita acá: la
    // que había preguntaba por coinsbuy/fairpay/unipayment y dejaba
    // afuera Pay-Pros — 93.968,69 de depósitos y 10.302,17 de
    // retiros de Vex Pro en sep-2026 (Kevin, 2026-10-05).
    //
    // Solo para un broker: sin depósitos ni retiros de clientes,
    // esta llamada devolvería ceros y el PDF imprimiría una página
    // de "Depósitos por canal: $0,00" al socio de una consultora.
    let clientFlow: ClientFlow | null = null;
    if (model.movements) {
      let datasets: ProviderDataset[] = [];
      let hiddenChannels: string[] = [];
      let truncatedSlugs: string[] = [];
      let fetchFailed = false;
      const derived = allPeriodsUseDerivedBroker([currentPeriod]);
      if (derived) {
        try {
          const res = await apiFetch(`/api/integrations/persisted-movements?from=${from}&to=${to}`);
          const json = await res.json();
          if (!res.ok || json?.success === false) throw new Error('persisted-movements');
          datasets = json.datasets ?? [];
          hiddenChannels = json.hiddenChannels ?? [];
          truncatedSlugs = json.truncatedSlugs ?? [];
        } catch {
          // Sin conexión a movimientos: el informe sale con los
          // manuales y LO DICE (buildClientFlow agrega el aviso).
          fetchFailed = true;
        }
      }
      clientFlow = buildClientFlow({
        derived,
        datasets,
        hiddenChannels,
        truncatedSlugs,
        fetchFailed,
        manualDeposits: model.deposits ? sum.deposits : [],
        // WITHDRAWAL_LABELS, no un mapa propio (2026-08-31,
        // auditoría de finanzas): el mapa local tenía 'ib' y 'p2p'
        // —que no son categorías válidas— y le faltaba
        // `ib_commissions`, que salía impresa cruda en el PDF.
        manualWithdrawals: model.withdrawals ? sum.withdrawals : [],
        depositLabel: (ch) => depositChannelLabel(ch, t),
        withdrawalLabel: (ch) => withdrawalChannelLabel(ch, t),
        withdrawalCategoryLabel: (cat) => WITHDRAWAL_LABELS[cat] ?? cat,
      });
    }

    // Empresa de servicios: en lugar del flujo de clientes va la
    // facturación del mes. NO se calcula acá — sale de buildBilling
    // sobre las mismas líneas de ingreso que alimentan el reporte
    // de /finanzas/reportes y su CSV. Dos fórmulas distintas para
    // "cobrado" es exactamente lo que este repo no puede tener.
    let billing: PdfMonthlyCloseBilling | null = null;
    if (!model.movements) {
      let lines: IncomeLine[] = [];
      try {
        const res = await apiFetch('/api/admin/income-lines');
        const json = await res.json();
        lines = json?.success ? (json.lines ?? []) : [];
      } catch {
        // Sin facturación disponible: el informe sale con el
        // resultado y la distribución, sin el detalle por cliente.
      }
      const order = currentPeriod.year * 12 + currentPeriod.month;
      const label = currentPeriod.label ?? `${currentPeriod.year}-${pad(currentPeriod.month)}`;
      const b = buildBilling(
        cardsFromLines(
          lines
            .filter((l) => l.period_id === selectedPeriodId)
            .map((l) => ({ ...l, periodLabel: label, periodOrder: order })),
        ),
      );
      billing = {
        billed: b.billed,
        collected: b.collected,
        pending: b.pending,
        clients: b.clients.map((c) => ({
          name: c.key === UNASSIGNED_CLIENT_KEY ? 'Sin cliente' : c.name,
          billed: c.billed,
          collected: c.collected,
          pending: c.pending,
        })),
      };
    }

    // Datos del CRM (informativo): la serie ya está en memoria
    // (data-context la lee UNA vez para la cadena); acá solo se
    // filtra el mes y las métricas que NO suman al resultado.
    const crmInfo = buildCrmInfoRows(
      crmMonthlyTotals.rows,
      CRM_MONTHLY_OUTSIDE_RESULT_METRICS,
      currentPeriod.year,
      currentPeriod.month,
    );

    // Los cuatro sumandos de los ingresos salen de la MISMA cadena
    // que calcula `ingresosNetos` (currentChain.desglose). Antes
    // venían de las tablas manuales (operating_income.broker_pnl,
    // propFirmNetIncome), vacías desde ago-2026 porque esos
    // renglones pasaron a automático: el PDF imprimía Broker P&L y
    // Prop Firm en $0,00 con 263.469,99 de ingresos netos.
    //
    // 2026-10-05 ~22:10: los dos automáticos vienen `null` si su
    // serie del CRM no llegó; el PDF los imprime «sin datos» y pone
    // el aviso arriba (`completeness`). Sin cadena, no hay informe.
    if (!currentChain) return;
    const desglose = currentChain.desglose;

    const { generateMonthlyClosePDF } = await import('@/lib/pdf-export');
    await generateMonthlyClosePDF({
      companyName: company?.name ?? '',
      companyLogoUrl: company?.logo_url ?? null,
      periodLabel: longPeriodLabel(currentPeriod),
      billing,
      desglose,
      ingresosNetos,
      egresosNetos,
      saldo: saldoAFavor,
      reservaMes: reserveThisPeriod,
      reservePct: currentPeriod.reserve_pct ?? 0.1,
      reservaAcumulada: accumulatedReserve,
      deudaEntrada: carryDebt,
      montoDistribuir: totalToDistribute,
      expenses: sum.expenses.map((e) => ({
        concept: e.concept,
        amount: e.amount,
        paid: e.paid,
        pending: e.pending,
      })),
      egresosPagados: sum.totalExpensesPaid,
      egresosPendientes: sum.totalExpensesPending,
      cashBasisExpenses: model.cashBasisExpenses,
      clientFlow,
      crmInfo,
      crmInfoTruncated: crmInfo.length > 0 && crmMonthlyTotals.truncated,
      completeness: currentChain,
      // Mes abierto: el CRM todavía puede mover el número (pdf-provisional.ts).
      provisional: !currentPeriod.is_closed,
      partners: partners.map((p) => {
        const d = effectiveDistributions.find((dd) => dd.partner_id === p.id);
        return { name: p.name, pct: d?.percentage ?? p.percentage, amount: d?.amount ?? 0 };
      }),
    });
  });

  const handleHistoryPdf = () => verify2FA(async () => {
    const { generatePartnerHistoryPDF } = await import('@/lib/pdf-export');
    const rows = periods.map((period) => {
      const pChain = periodChain.get(period.id);
      // Mes con serie del CRM faltante: «sin datos», no cuenta.
      if (pChain?.pendiente) {
        return { periodLabel: provisionalPeriodLabel(period.label ?? '', period.is_closed), amounts: null, total: null };
      }
      const pDist = pChain?.montoDistribuir ?? 0;
      const dists = partnerDistributions.filter((d) => d.period_id === period.id);
      const amounts = partners.map((p) => {
        const saved = dists.find((d) => d.partner_id === p.id);
        const pct = saved?.percentage ?? p.percentage;
        return pDist > 0 ? round2(pDist * pct) : 0;
      });
      return { periodLabel: provisionalPeriodLabel(period.label ?? '', period.is_closed), amounts, total: round2(amounts.reduce((s, a) => s + a, 0)) };
    });
    const partnerTotals = partners.map((_, idx) =>
      round2(rows.reduce((s, r) => s + (r.amounts ? r.amounts[idx] : 0), 0)),
    );
    await generatePartnerHistoryPDF({
      companyName: company?.name ?? '',
      companyLogoUrl: company?.logo_url ?? null,
      partnerNames: partners.map((p) => p.name),
      rows,
      partnerTotals,
      grandTotal: round2(partnerTotals.reduce((s, a) => s + a, 0)),
      note: pendingHistoryNote,
    });
  });

  // ─── Vista «Libro mayor» ───────────────────────────────────────────────
  // KPIs: un período o la suma de los seleccionados, con la regla de la
  // cadena (null si no es definitivo). Ver chain-view.ts.
  const scopeIds = mode === 'consolidated' ? selectedPeriodIds : [selectedPeriodId];
  const kpis = sumChain(scopeIds.map((id) => periodChain.get(id)), autoSeriesStatus);
  const ownBadge = kpis.ownState ? { kind: kpis.ownState.badge, label: kpis.ownState.label } : undefined;
  const chainBadge = kpis.chainState ? { kind: kpis.chainState.badge, label: kpis.chainState.label } : undefined;
  // Banner de la cadena: en un período, el texto de siempre (incompleteNotice,
  // el mismo que imprime el PDF); en consolidado, qué meses no son definitivos.
  const chainNoticeState = mode === 'single' ? seriesState(currentChain, autoSeriesStatus) : kpis.chainState;
  const pendingInScope = periods
    .filter((p) => scopeIds.includes(p.id) && periodChain.get(p.id)?.pendiente)
    .map((p) => p.label ?? '');
  const chainNoticeTitle =
    mode === 'single'
      ? crmNotice
      : kpis.chainState
        ? t('partners.notice.rangeTitle', { label: kpis.chainState.label, months: pendingInScope.join(', ') })
        : null;
  const distribucionConocida = kpis.aDistribuir !== null;

  const shareTable = partnerShareTable(
    effectiveDistributions.map((d) => {
      const partner = partners.find((p) => p.id === d.partner_id);
      return { id: d.partner_id, name: partner?.name || '—', email: partner?.email ?? null, pct: d.percentage, amount: d.amount };
    }),
    distribucionConocida,
  );

  const history = partnerHistory({
    periods: periods.map((p) => ({ id: p.id, label: p.label ?? null })),
    partners,
    saved: partnerDistributions,
    chainOf: (id) => periodChain.get(id),
  });

  const desgloseSub = (() => {
    if (mode !== 'single' || !currentChain) return mode === 'consolidated' ? t('partners.kpi.months', { n: String(scopeIds.length) }) : undefined;
    const d = currentChain.desglose;
    // `null` = la serie del CRM no llegó: «sin datos», nunca $0.
    const parts = [
      `${t('summary.brokerPnl')} ${d.brokerPnl === null ? t('brokerPnl.noData') : formatMoney(d.brokerPnl)}`,
      d.other !== 0 ? `${t('summary.otherIncome')} ${formatMoney(d.other)}` : null,
      d.propFirmNetIncome === null
        ? `Prop Firm ${t('brokerPnl.noData')}`
        : d.propFirmNetIncome !== 0
          ? `Prop Firm ${formatMoney(d.propFirmNetIncome)}`
          : null,
      d.investmentProfits !== 0 ? `${t('partners.kpi.investments')} ${formatMoney(d.investmentProfits)}` : null,
    ];
    return parts.filter(Boolean).join(' + ');
  })();

  const reserveSub = (() => {
    if (mode !== 'single') return t('partners.kpi.months', { n: String(scopeIds.length) });
    if (kpis.reserva === null) return t('partners.kpi.dependsOnCrm');
    const base =
      reserveThisPeriod > 0
        ? t('partners.kpi.reservePct', { pct: pctFmt.format(RESERVE_PCT * 100) })
        : saldoAFavor <= 0
          ? t('partners.kpi.negativeMonth')
          : t('partners.kpi.coveringDebt');
    return `${base} · ${t('partners.kpi.accumulated', { amount: formatMoney(accumulatedReserve) })}`;
  })();

  const distributeSub = (() => {
    if (kpis.aDistribuir === null) return t('partners.kpi.whenCrmArrives');
    if (mode !== 'single') return t('partners.kpi.months', { n: String(scopeIds.length) });
    if (carryDebt > 0) return t('partners.kpi.debtFirst', { amount: formatMoney(carryDebt) });
    return totalToDistribute > 0
      ? t('partners.kpi.distributePct', { pct: pctFmt.format(100 - RESERVE_PCT * 100) })
      : t('partners.noDistribution');
  })();

  const kpiItems: KpiItem[] = [
    { key: 'income', label: t('partners.kpi.income'), value: kpis.ingresosNetos, missingBadge: ownBadge, sub: desgloseSub },
    { key: 'expenses', label: t('partners.kpi.expenses'), value: kpis.egresosNetos },
    {
      key: 'result',
      label: (
        <span className="inline-flex items-center gap-1">
          {t('partners.kpi.result')} <InfoTip text={GLOSSARY.netoOperativo} />
        </span>
      ),
      value: kpis.resultado,
      tone: 'sign',
      missingBadge: ownBadge,
      sub: t('partners.kpi.resultSub'),
    },
    {
      key: 'reserve',
      label: (
        <span className="inline-flex items-center gap-1">
          {t('partners.reserveThisPeriod')} <InfoTip text={GLOSSARY.reserve} />
        </span>
      ),
      value: kpis.reserva,
      missingBadge: chainBadge,
      sub: (
        <>
          {reserveSub}
          {isAdmin && mode === 'single' && (
            <button
              type="button"
              onClick={handleOpenReserveEdit}
              className="ml-1.5 font-medium text-brand-ink underline-offset-2 hover:underline"
            >
              {t('partners.editReserve')}
            </button>
          )}
        </>
      ),
    },
    {
      key: 'distribute',
      label: (
        <span className="inline-flex items-center gap-1">
          {t('partners.distributableAmount')} <InfoTip text={GLOSSARY.montoDistribuir} />
        </span>
      ),
      value: kpis.aDistribuir,
      hero: true,
      missingBadge: chainBadge,
      sub: distributeSub,
    },
  ];

  const shareColumns: FinColumn<PartnerShareTableRow>[] = [
    {
      key: 'name',
      header: t('partners.name'),
      cell: (r) => r.name,
      meta: (r) => r.email ?? null,
    },
    {
      key: 'share',
      header: t('partners.participation'),
      kind: 'number',
      width: '170px',
      cardSide: 'left',
      cell: (r) => (
        <span className="inline-flex items-center gap-2 min-[720px]:justify-end">
          <span aria-hidden className="block h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunk">
            <span className="block h-full rounded-full bg-brand-ink/75" style={{ width: `${r.barPct}%` }} />
          </span>
          <span className={cn(NUM_CLASS, 'w-12 text-right text-text-2')}>{pctFmt.format(r.sharePct)} %</span>
        </span>
      ),
    },
    {
      key: 'amount',
      header: t('partners.amount'),
      kind: 'money',
      value: (r) => r.amount,
      width: '170px',
    },
  ];

  const historyColumns: FinColumn<HistoryRow>[] = [
    {
      key: 'period',
      header: t('partners.period'),
      cell: (r) => r.label,
      meta: (r) =>
        r.pending || r.missing ? (
          <StatusBadge kind="stale" label={pendingValueLabel(periodChain.get(r.periodId), autoSeriesStatus) ?? t('ui.noData')} />
        ) : r.debtIn !== null && r.debtIn > 0 ? (
          t('partners.history.debtIn', { amount: formatMoney(-r.debtIn) })
        ) : null,
    },
    ...partners.map(
      (p): FinColumn<HistoryRow> => ({
        key: `p-${p.id}`,
        header: p.name,
        kind: 'money',
        value: (r) => r.amounts[p.id] ?? null,
        hideSm: true,
      }),
    ),
    {
      key: 'total',
      header: t('partners.history.total'),
      kind: 'money',
      value: (r) => r.total,
      money: { tone: 'auto' },
    },
  ];
  const historyFooterValues: Record<string, number> = { total: history.grandTotal };
  for (const p of partners) historyFooterValues[`p-${p.id}`] = history.partnerTotals[p.id];
  const historyCounted = history.rows.length - history.excluded.length;

  return (
    <div className="space-y-4">
      {Modal2FA}
      <PageHeader
        title={t('partners.title')}
        subtitle={t('partners.subtitle')}
        icon={Users}
        actions={
          <>
            <button type="button" onClick={handleCsv} className={BTN} title={t('common.csv')} aria-label={t('common.csv')}>
              <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t('common.csv')}</span>
            </button>
            {mode === 'single' && (
              <button
                type="button"
                onClick={handlePdfMes}
                disabled={seriesLoading}
                className={BTN}
                title={seriesLoading ? pdfDisabledTitle : 'Descargar PDF del mes'}
                aria-label={t('partners.pdfMonth')}
              >
                <FileText aria-hidden className="size-[15px]" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t('partners.pdfMonth')}</span>
              </button>
            )}
            {mode === 'single' && (
              <button
                type="button"
                onClick={handleCierreMensual}
                disabled={seriesLoading}
                className={BTN}
                title={seriesLoading ? pdfDisabledTitle : 'Descargar informe de cierre mensual'}
                aria-label={t('partners.monthlyClose')}
              >
                <FileBarChart aria-hidden className="size-[15px]" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t('partners.monthlyClose')}</span>
              </button>
            )}
            <PeriodSelector />
          </>
        }
      />

      {/* Mensajes de la última acción */}
      {successMsg && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-ui-md border border-pos/35 bg-pos-bg px-3.5 py-2.5 text-[13px] font-medium text-foreground"
        >
          <Check aria-hidden className="size-4 shrink-0 text-pos" strokeWidth={2} />
          {successMsg}
        </div>
      )}
      {errorMsg && <Notice kind="bad" title={errorMsg} />}

      <KpiStrip items={kpiItems} />

      {/* Serie del CRM faltante (incidente 2026-10-05): los totales que
          dependen de ella no se muestran como número. */}
      {chainNoticeState && chainNoticeTitle && (
        <Notice kind={chainNoticeState.notice} title={chainNoticeTitle}>
          {chainNoticeState.phase === 'loading' ? t('partners.notice.loadingBody') : t('partners.notice.failedBody')}
        </Notice>
      )}

      {/* Deriva snapshot-vs-vivo: alguien editó datos de un mes CERRADO. El
          número mostrado sigue siendo el congelado (estable), pero no debe
          pasar desapercibido: o se reabre el período con motivo, o se revierte. */}
      {snapshotDrifts.length > 0 && (
        <Notice
          kind="bad"
          title={t('partners.notice.driftTitle', {
            n: String(new Set(snapshotDrifts.map((d) => d.periodLabel)).size),
          })}
        >
          <ul className="mt-1 space-y-0.5 text-[12px]">
            {snapshotDrifts.slice(0, 6).map((d, i) => (
              <li key={i}>
                {d.periodLabel} · {d.field}:{' '}
                {t('partners.notice.driftLine', { frozen: formatMoney(d.frozen), live: formatMoney(d.live) })}
              </li>
            ))}
            {snapshotDrifts.length > 6 && (
              <li>{t('partners.notice.driftMore', { n: String(snapshotDrifts.length - 6) })}</li>
            )}
          </ul>
          <p className="mt-1 text-[12px]">{t('partners.notice.driftHow')}</p>
        </Notice>
      )}

      {/* % que no suman 100 — con el MONTO que queda sin dueño (auditoría
          2026-08-06, QW8): con 95 % asignado, el 5 % no va a nadie. */}
      {percentageMismatch && (
        <Notice kind="pend" title={t('partners.percentageWarning', { pct: (totalPercentage * 100).toFixed(1) })}>
          {totalPercentage < 1 && !chainPending && totalToDistribute > 0
            ? t('partners.notice.unassigned', { amount: formatMoney(round2(totalToDistribute * (1 - totalPercentage))) })
            : null}
        </Notice>
      )}

      {/* ─── Reparto ─── */}
      <Panel
        title={t('partners.distribution')}
        hint={mode === 'consolidated' ? t('partners.kpi.months', { n: String(scopeIds.length) }) : currentPeriod?.label ?? undefined}
        flush
        actions={
          isAdmin ? (
            <button type="button" onClick={handleAddPartner} className={PRIMARY_BTN}>
              <Plus aria-hidden className="size-[15px]" strokeWidth={1.75} />
              {t('partners.addPartner')}
            </button>
          ) : undefined
        }
      >
        <FinTable
          caption={t('partners.distribution')}
          columns={shareColumns}
          rows={shareTable.rows}
          rowKey={(r) => r.key}
          empty={t('partners.empty')}
          rowActions={
            isAdmin
              ? (r) => (
                  <>
                    <button
                      type="button"
                      onClick={() => handleEditPartner(r.partnerId)}
                      className={ROW_BTN}
                      title={t('partners.editPartner')}
                      aria-label={`${t('partners.editPartner')}: ${r.name}`}
                    >
                      <Pencil aria-hidden className="size-[15px]" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        confirm(
                          t('partners.deleteConfirm', { name: r.name }),
                          () => handleDeletePartner(r.partnerId),
                          { tone: 'danger', title: t('partners.deletePartner'), confirmLabel: t('partners.deletePartner') },
                        )
                      }
                      className={cn(ROW_BTN, 'hover:text-neg')}
                      title={t('partners.deletePartner')}
                      aria-label={`${t('partners.deletePartner')}: ${r.name}`}
                    >
                      <Trash2 aria-hidden className="size-[15px]" strokeWidth={1.75} />
                    </button>
                  </>
                )
              : undefined
          }
          footer={
            shareTable.rows.length > 0
              ? {
                  label: t('partners.shareTotal', { pct: pctFmt.format(shareTable.totalPct) }),
                  values: { amount: shareTable.total },
                }
              : undefined
          }
        />
      </Panel>

      {/* ─── Historial ─── */}
      <Panel
        title={t('partners.history')}
        hint={t('partners.history.hint', { n: String(history.rows.length) })}
        flush
        actions={
          <>
            <button
              type="button"
              onClick={() => setShowHistory(!showHistory)}
              aria-expanded={showHistory}
              aria-controls="partners-history"
              className={BTN}
            >
              <ChevronDown
                aria-hidden
                className={cn('size-[15px] transition-transform motion-reduce:transition-none', showHistory ? 'rotate-0' : '-rotate-90')}
                strokeWidth={1.75}
              />
              {showHistory ? t('partners.history.hide') : t('partners.history.show')}
            </button>
            <button
              type="button"
              onClick={handleHistoryPdf}
              disabled={seriesLoading}
              className={BTN}
              title={seriesLoading ? pdfDisabledTitle : 'Descargar historial en PDF'}
              aria-label={t('partners.history.pdf')}
            >
              <FileText aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="hidden sm:inline">PDF</span>
            </button>
          </>
        }
        footer={showHistory && pendingHistoryNote ? pendingHistoryNote : undefined}
      >
        <div id="partners-history">
          {showHistory && (
            <FinTable
              caption={t('partners.history')}
              columns={historyColumns}
              rows={history.rows}
              rowKey={(r) => r.periodId}
              selectedKey={mode === 'single' ? selectedPeriodId : null}
              footer={{
                label:
                  history.excluded.length > 0
                    ? t('partners.history.totalOf', { n: String(historyCounted), m: String(history.rows.length) })
                    : t('partners.history.total'),
                values: historyFooterValues,
              }}
            />
          )}
        </div>
      </Panel>

      {/* ─── Alta / edición de socio ─── */}
      {showPartnerForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="partner-form-title"
            className="w-full max-w-md rounded-ui-xl border border-border bg-card shadow-3"
          >
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
              <h2 id="partner-form-title" className="text-[15px] font-semibold text-foreground">
                {editingPartner ? t('partners.editPartner') : t('partners.addPartner')}
              </h2>
              <button
                type="button"
                onClick={() => setShowPartnerForm(false)}
                className={ROW_BTN}
                aria-label={t('partners.cancel')}
              >
                <X aria-hidden className="size-4" strokeWidth={1.75} />
              </button>
            </div>
            <form
              className="space-y-4 px-5 py-4"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSavePartner();
              }}
            >
              <Field label={t('partners.name')} required>
                <Input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={t('partners.form.namePlaceholder')}
                  autoFocus
                />
              </Field>
              <Field label={t('partners.email')}>
                <Input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="email@ejemplo.com"
                />
              </Field>
              <Field
                label={`${t('partners.percentage')} (%)`}
                required
                hint={t('partners.form.max', {
                  max: pctFmt.format((editingPartner ? availableForEdit(editingPartner) : availableForNew) * 100),
                })}
              >
                <Input
                  type="number"
                  inputMode="decimal"
                  value={formPercentage}
                  onChange={(e) => setFormPercentage(e.target.value)}
                  placeholder="25.0"
                  min="0.1"
                  max={((editingPartner ? availableForEdit(editingPartner) : availableForNew) * 100).toFixed(1)}
                  step="0.1"
                />
              </Field>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowPartnerForm(false)} className={BTN}>
                  {t('partners.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={saving || !formName.trim() || !formPercentage}
                  className={PRIMARY_BTN}
                >
                  {saving ? t('partners.saving') : t('partners.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {ConfirmModal}

      {/* ─── % de reserva ─── */}
      {showReserveEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reserve-form-title"
            className="w-full max-w-sm rounded-ui-xl border border-border bg-card shadow-3"
          >
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
              <h2 id="reserve-form-title" className="text-[15px] font-semibold text-foreground">
                {t('partners.reserveTitle')}
              </h2>
              <button
                type="button"
                onClick={() => setShowReserveEdit(false)}
                className={ROW_BTN}
                aria-label={t('partners.cancel')}
              >
                <X aria-hidden className="size-4" strokeWidth={1.75} />
              </button>
            </div>
            <div className="space-y-4 px-5 py-4">
              <Field
                label={t('partners.form.reservePct')}
                hint={t('partners.form.reserveCurrent', {
                  period: currentPeriod?.label ?? '',
                  pct: pctFmt.format(RESERVE_PCT * 100),
                })}
              >
                <Input
                  type="number"
                  inputMode="decimal"
                  value={reserveInput}
                  onChange={(e) => setReserveInput(e.target.value)}
                  min="0"
                  max="100"
                  step="0.5"
                />
              </Field>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => handleSaveReserve(false)}
                  disabled={saving}
                  className={cn(PRIMARY_BTN, 'w-full')}
                >
                  {saving ? t('partners.saving') : t('partners.reserveApplyThis')}
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveReserve(true)}
                  disabled={saving}
                  className={cn(BTN, 'w-full justify-center')}
                >
                  {saving ? t('partners.saving') : t('partners.reserveApplyAll')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowReserveEdit(false)}
                  className="inline-flex h-8 w-full items-center justify-center rounded-ui-md text-[13px] font-medium text-text-2 hover:bg-surface-hover hover:text-foreground"
                >
                  {t('partners.cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
