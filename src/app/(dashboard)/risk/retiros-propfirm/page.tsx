'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /risk/retiros-propfirm — la cola automática de prop firm + la revisión
// manual de un informe de MetaQuotes (subida de .xlsx).
//
// ── «LIBRO MAYOR» (2026-10-12) ──────────────────────────────────────────────
// Sólo presentación. NO cambiaron: el análisis (`analyzeReport`), las reglas
// por programa (`risk/programs.ts`), el veredicto según los límites, el
// guardado en /api/risk/revisions ni los dos PDF (el del análisis y el del
// historial: mismas tablas, mismos colores RGB, mismos textos).
//   · Medido antes: 58 clases de paleta cruda (`text-green-500`,
//     `bg-red-100 dark:bg-red-900/30`, `text-emerald-600`…), 18 variantes
//     `dark:` de color y 14 `text-[10px]/[11px]` — una pantalla con su propio
//     sistema de color. Después: 0 / 0 / 0 (ver el reporte de la tanda).
//   · Color = significado (spec §2.1): el tipo BUY/SELL ya no es verde/rojo
//     (es un lado, no una ganancia) y va en el metadato; el profit sí lleva
//     tono `sign`. Una regla omitida es gris, no un ícono de alerta.
//   · Tablas (historial, incumplimientos, operaciones) con FinTable 36 px;
//     las acciones de fila al hover. La operación con incumplimientos ya no
//     se tiñe de rojo entera: la columna de banderas dice cuáles (badge `bad`).
//   · Un solo primario: «Volver a analizar» (aplica la configuración). El
//     «Descargar PDF» era un botón rojo sólido — un segundo primario y, en
//     rojo, una alarma — y pasa a secundario.
//   · El veredicto aprobado va en una franja `pos`; el rechazado en <Notice
//     bad>. (Notice no tiene variante ok a propósito; acá el resultado ES la
//     noticia y se muestra igual de visible en los dos sentidos.)
//
// DESCARTADO: mover el análisis manual a otra pantalla — la cola y la
// revisión suelta se usan juntas (la cola manda a revisar una cuenta).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { StatusBadge, type StatusKind } from '@/components/ui/status-badge';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { Field, Select, CONTROL_CLASS } from '@/components/ui/field';
import { ActionButton, ROW_ACTION_CLASS } from '@/components/payment-orders/action-button';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { cn, formatCurrency, formatPercentValue } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { parseTradeReport, type ParseResult } from '@/lib/risk/parser';
import { analyzeReport } from '@/lib/risk/rules';
import { DEFAULT_RULE_CONFIG, DEFAULT_APPROVAL_LIMITS, type RuleConfig, type AnalysisResult, type Trade, type ApprovalLimits, type ApprovalMode, type RuleResult } from '@/lib/risk/types';
import { computeDurationDistribution } from '@/lib/risk/duration-distribution';
import { PROGRAM_RULES, rulesForProgram } from '@/lib/risk/programs';
import { PropfirmQueuePanel, type QueueRow } from '@/components/risk/propfirm-queue-panel';
import { DurationDistributionTable } from '@/components/risk/duration-distribution-table';
import { apiFetch } from '@/lib/api-fetch';
import {
  Upload,
  Settings,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CheckCircle,
  FileSearch,
  Eye,
  EyeOff,
  Loader2,
  FileSpreadsheet,
  Shield,
  FileText,
} from 'lucide-react';

// ─── Helpers ───

function fmtDuration(mins: number): string {
  if (isNaN(mins)) return '—';
  if (mins < 60) return `${mins.toFixed(1)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

function fmtDate(d: Date): string {
  return d.toLocaleString('es-ES', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Estado de una regla del análisis manual → color (skipped = no aplica: gris). */
const RULE_KIND: Record<RuleResult['status'], StatusKind> = {
  pass: 'ok',
  fail: 'bad',
  skipped: 'neutral',
};
const RULE_LABEL: Record<RuleResult['status'], string> = {
  pass: 'Cumple',
  fail: 'Falla',
  skipped: 'Omitida',
};


// ─── History persistence (Supabase via /api/risk/revisions) ───
// Cada HistoryRecord se guarda en la tabla `risk_revisions` (jsonb), scopeado
// por company_id. Antes vivía en localStorage con la key
// 'risk_propfirm_history' — se quitó porque (1) se perdía al cerrar sesión,
// (2) no era cross-user dentro de la empresa y (3) no era multi-dispositivo.

interface HistoryRecord {
  id: string;
  savedAt: string; // ISO datetime
  fileName: string;
  traderName: string;
  accountNumber: string;
  broker: string;
  period: string;
  totalNetProfit: number;
  totalTrades: number;
  verdict: 'approved' | 'rejected' | 'review' | null;
  verdictMsg: string;
  rulesSummary: { ruleName: string; displayName: string; violations: number; status: string }[];
  // Guardamos el resultado completo serializado para poder restaurarlo
  resultSnapshot: string; // JSON.stringify(AnalysisResult) sin los trades completos
}

const MAX_HISTORY = 50;

// ─── Page ───

const PAGE_SIZE = 50;

export default function RetirosPropFirmPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  // La empresa da nombre y logo al PDF en inglés que se le manda al cliente
  // (mismo camino que /balances con generateChannelBalancesPDF).
  const { company } = useData();
  const hasRiskAccess = useModuleAccess('risk');
  const router = useRouter();

  // Module access guard — redirect users without the 'risk' module.
  // The redirect happens in the effect; while it runs we render null.
  useEffect(() => {
    if (user === null) return; // still loading
    if (!hasRiskAccess) {
      router.replace('/');
    }
  }, [user, hasRiskAccess, router]);

  const accessDenied = user !== null && !hasRiskAccess;

  // State
  const [config, setConfig] = useState<RuleConfig>(structuredClone(DEFAULT_RULE_CONFIG));
  // Programa cuyo reglamento se está aplicando. Ver `aplicarPrograma`.
  const [programa, setPrograma] = useState<string>('');
  // La cola automática: llega la solicitud y ya viene revisada. La subida
  // manual de abajo sigue existiendo para analizar una cuenta suelta.
  const [cola, setCola] = useState<{ pending: QueueRow[]; resolved: QueueRow[]; disclaimer: string } | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // History state — vacío al montar; se llena con el fetch del useEffect
  // siguiente (y cuando cambia la empresa activa para superadmins en
  // viewing-as).
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);

  // Table state
  const [ruleFilter, setRuleFilter] = useState<string>('all');
  const [violPage, setViolPage] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [opsPage, setOpsPage] = useState(0);

  // Approval limits
  const [approvalLimits, setApprovalLimits] = useState<ApprovalLimits>(structuredClone(DEFAULT_APPROVAL_LIMITS));

  // Drag & drop
  const [dragOver, setDragOver] = useState(false);

  // ─── Fetch del historial al montar / al cambiar empresa activa ───
  // Replicamos las dependencias del módulo /usuarios: cuando un superadmin
  // cambia de empresa "viewing-as", el provider de auth refetchea su lista,
  // pero esta página vive su propio history → se suscribe directamente al
  // user (cambia de identidad) + access flag. El listener de
  // active-company adicional lo da el helper withActiveCompany al armar
  // la URL del fetch (no necesitamos suscribirnos acá).
  useEffect(() => {
    if (user === null) return;       // auth aún cargando
    if (!hasRiskAccess) return;      // sin permisos → no cargar
    let cancelled = false;
    (async () => {
      try {
        // La cola automática se pide en paralelo: es de otra fuente y un fallo
        // suyo no puede dejar sin historial a la pantalla.
        apiFetch('/api/admin/propfirm-queue')
          .then((r) => r.json())
          .then((b) => { if (b?.success) setCola({ pending: b.pending ?? [], resolved: b.resolved ?? [], disclaimer: b.disclaimer ?? '' }); })
          .catch(() => { /* la pantalla funciona sin la cola */ });

        const res = await apiFetch('/api/risk/revisions');
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data.success && Array.isArray(data.revisions)) {
          // Cada row: { id, payload, created_at }. Reconstruimos el array
          // de HistoryRecord con el id REAL de BD (sobrescribe el id local
          // generado en su día con Date.now+random) para que el delete
          // pegue contra el endpoint correcto.
          const records: HistoryRecord[] = data.revisions.map(
            (r: { id: string; payload: HistoryRecord }) => ({
              ...r.payload,
              id: r.id,
            }),
          );
          setHistory(records);
        } else {
          console.warn('[risk/revisions] load failed:', data?.error);
        }
      } catch (err) {
        console.error('[risk/revisions] fetch error:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [user, hasRiskAccess]);

  // ─── Save analysis to history (Supabase) ───

  const saveToHistory = useCallback((
    analysis: AnalysisResult,
    file: string,
    verdictResult: { approved: boolean; msg: string } | null,
  ) => {
    const record: HistoryRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      savedAt: new Date().toISOString(),
      fileName: file,
      traderName: analysis.metadata.traderName,
      accountNumber: analysis.metadata.accountNumber,
      broker: analysis.metadata.broker,
      period: analysis.metadata.period,
      totalNetProfit: analysis.metadata.totalNetProfit,
      totalTrades: analysis.trades.length,
      verdict: verdictResult === null ? null : verdictResult.approved ? 'approved' : 'rejected',
      verdictMsg: verdictResult?.msg ?? '',
      rulesSummary: analysis.ruleResults.map(r => ({
        ruleName: r.ruleName,
        displayName: r.displayName,
        violations: r.violations.length,
        status: r.status,
      })),
      resultSnapshot: JSON.stringify({
        metadata: analysis.metadata,
        ruleResults: analysis.ruleResults.map(r => ({
          ...r,
          violations: r.violations.slice(0, 200).map(v => ({
            ...v,
            // Incluir datos del trade para poder restaurar y mostrar en PDF
            tradeData: analysis.trades[v.tradeIndex] ? {
              position: analysis.trades[v.tradeIndex].position,
              symbol: analysis.trades[v.tradeIndex].symbol,
              type: analysis.trades[v.tradeIndex].type,
              volume: analysis.trades[v.tradeIndex].volume,
              profit: analysis.trades[v.tradeIndex].profit,
              durationMinutes: analysis.trades[v.tradeIndex].durationMinutes,
              openTime: analysis.trades[v.tradeIndex].openTime,
            } : null,
          })),
        })),
        // Guardamos el array completo de trades (con fechas serializadas)
        // para que la Distribución por Duración pueda calcularse al vuelo
        // cuando se cargue el informe del Historial. Sin esto, la tabla
        // del PDF histórico sería parcial (solo trades con violación).
        // Snapshots viejos sin este campo siguen funcionando: el código
        // tiene un fallback que reconstruye desde violations.
        trades: analysis.trades.map((t) => ({
          ...t,
          openTime: t.openTime instanceof Date ? t.openTime.toISOString() : t.openTime,
          closeTime: t.closeTime instanceof Date ? t.closeTime.toISOString() : t.closeTime,
        })),
      }),
    };

    // Optimistic UI: agregamos al state local enseguida para que el usuario
    // lo vea sin esperar el round-trip. Si el POST falla, queda solo en
    // memoria y el próximo fetch lo "limpia" — no bloqueamos UX por error
    // de red.
    setHistory((prev) => [record, ...prev].slice(0, MAX_HISTORY));

    (async () => {
      try {
        const res = await apiFetch('/api/risk/revisions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: record }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          console.error('[risk/revisions] save failed:', data?.error);
          return;
        }
        // Reconciliamos: reemplazamos el record local (id local) por el de
        // BD (id real) para que un delete posterior pegue contra el
        // endpoint correcto. Identificamos por savedAt+fileName, que es
        // único en la práctica (mismo segundo + mismo archivo).
        const saved = data.revision as { id: string; payload: HistoryRecord; created_at: string };
        setHistory((prev) =>
          prev.map((r) =>
            r.savedAt === record.savedAt && r.fileName === record.fileName
              ? { ...saved.payload, id: saved.id }
              : r,
          ),
        );
      } catch (err) {
        console.error('[risk/revisions] save error:', err);
      }
    })();
  }, []);

  // ─── Restore an analysis from history ───

  const restoreFromHistory = useCallback((rec: HistoryRecord) => {
    try {
      const snapshot = JSON.parse(rec.resultSnapshot);

      // Path 1: snapshots nuevos guardan el array `trades` completo con
      // fechas serializadas como ISO strings. Lo preferimos cuando existe
      // porque permite que la Distribución por Duración cubra TODOS los
      // trades, no solo los que violaron alguna regla.
      let trades: Trade[];
      if (Array.isArray(snapshot.trades) && snapshot.trades.length > 0) {
        trades = snapshot.trades.map((t: Omit<Trade, 'openTime' | 'closeTime'> & { openTime: string; closeTime: string }) => ({
          ...t,
          openTime: new Date(t.openTime),
          closeTime: new Date(t.closeTime),
        }));
      } else {
        // Path 2 (fallback): snapshots viejos solo tienen tradeData dentro de
        // violations. Reconstruimos lo que podemos — es un set parcial pero
        // suficiente para no romper el restore.
        const tradesMap = new Map<number, Trade>();
        for (const rr of snapshot.ruleResults) {
          for (const v of rr.violations ?? []) {
            if (v.tradeData && !tradesMap.has(v.tradeIndex)) {
              tradesMap.set(v.tradeIndex, {
                index: v.tradeIndex,
                position: v.tradeData.position,
                symbol: v.tradeData.symbol,
                type: v.tradeData.type,
                volume: v.tradeData.volume,
                profit: v.tradeData.profit,
                durationMinutes: v.tradeData.durationMinutes,
                openTime: new Date(v.tradeData.openTime),
                closeTime: new Date(v.tradeData.openTime), // aproximado
                openPrice: 0,
                closePrice: 0,
                sl: null,
                tp: null,
                commission: 0,
                swap: 0,
              } as Trade);
            }
          }
        }
        trades = Array.from(tradesMap.values());
      }

      const restored: AnalysisResult = {
        trades,
        metadata: snapshot.metadata,
        ruleResults: snapshot.ruleResults,
      };
      setResult(restored);
      setFileName(rec.fileName);
      setShowHistory(false);
      setViolPage(0);
      setOpsPage(0);
      setRuleFilter('all');
      setShowAll(false);
    } catch (err) {
      console.error('Error restaurando desde historial:', err);
    }
  }, []);

  // ─── Generate PDF from a history record ───

  const downloadPDFFromHistory = useCallback(async (rec: HistoryRecord) => {
    setHistoryLoading(rec.id);
    try {
      const snapshot = JSON.parse(rec.resultSnapshot);
      const { jsPDF } = await import('jspdf');
      const { default: autoTable } = await import('jspdf-autotable');

      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const meta = snapshot.metadata;
      const v = rec.verdict === 'approved'
        ? { status: 'pass' as const, msg: rec.verdictMsg }
        : rec.verdict === 'rejected'
          ? { status: 'fail' as const, msg: rec.verdictMsg }
          : null;

      // Header
      doc.setFontSize(16);
      doc.setFont('helvetica', 'bold');
      doc.text('Informe de Revisión PropFirm', 14, 16);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text(`Trader: ${meta.traderName}`, 14, 23);
      doc.text(`Cuenta: ${meta.accountNumber}`, 14, 28);
      doc.text(`Broker: ${meta.broker}`, 14, 33);
      doc.text(`Período: ${meta.period}`, 14, 38);
      doc.text(`Total Net Profit: ${formatCurrency(meta.totalNetProfit)}`, 14, 43);
      doc.text(`Total Operaciones: ${rec.totalTrades}`, 14, 48);
      doc.text(`Revisado: ${formatDate(rec.savedAt)}`, 14, 53);
      doc.text(`Archivo: ${rec.fileName}`, 14, 58);

      // Verdict
      if (v) {
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(v.status === 'pass' ? 0 : 180, v.status === 'pass' ? 120 : 0, 0);
        doc.text(v.status === 'pass' ? `✓ APROBADO — ${v.msg}` : `✗ RECHAZADO — ${v.msg}`, 14, 67);
        doc.setTextColor(0, 0, 0);
      }

      // Rules summary
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text('Resumen de Reglas', 14, 78);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ruleRows = snapshot.ruleResults.filter((r: any) => r.isActive).map((r: any) => [
        r.displayName,
        r.status === 'pass' ? '✓ OK' : '✗ FALLA',
        `${r.violations.length} (${r.violationPct?.toFixed(1) ?? 0}%)`,
        Object.entries(r.computedParams ?? {}).map(([k, val]) => `${k}: ${val}`).join(' | '),
      ]);
      autoTable(doc, {
        startY: 81,
        head: [['Regla', 'Estado', 'Incumplimientos', 'Parámetros']],
        body: ruleRows,
        theme: 'grid',
        headStyles: { fillColor: [30, 30, 30], textColor: 255, fontSize: 8 },
        bodyStyles: { fontSize: 8 },
      });

      // Violations table
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const afterRules = ((doc as any).lastAutoTable?.finalY ?? 132) + 8;
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text('Operaciones con Incumplimientos', 14, afterRules);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allViolations: any[] = [];
      const seen = new Set<number>();
      for (const rr of snapshot.ruleResults) {
        for (const v of rr.violations ?? []) {
          if (!seen.has(v.tradeIndex)) {
            seen.add(v.tradeIndex);
            allViolations.push({ ...v, ruleName: rr.displayName });
          }
        }
      }
      autoTable(doc, {
        startY: afterRules + 3,
        head: [['Position', 'Symbol', 'Tipo', 'Volume', 'Profit', 'Duración', 'Regla Violada', 'Detalle']],
        body: allViolations.map(v => [
          v.tradeData?.position ?? '—',
          v.tradeData?.symbol ?? '—',
          v.tradeData?.type?.toUpperCase() ?? '—',
          v.tradeData?.volume ?? '—',
          formatCurrency(v.tradeData?.profit ?? 0),
          fmtDuration(v.tradeData?.durationMinutes ?? 0),
          v.ruleName ?? '—',
          v.detail ?? '—',
        ]),
        theme: 'striped',
        headStyles: { fillColor: [30, 30, 30], textColor: 255, fontSize: 7 },
        bodyStyles: { fontSize: 7, fillColor: [255, 235, 235], textColor: [150, 0, 0] },
      });

      // Distribución por Duración para el PDF histórico. La calculamos al
      // vuelo desde los trades disponibles. Path preferido: snapshot nuevo
      // con `trades` en raíz. Fallback: reconstruir desde violations
      // (snapshots viejos) — la tabla quedará parcial pero mejor algo que
      // nada. En el PDF histórico siempre incluimos la tabla (no hay
      // checkbox) porque es una acción puntual del usuario.
      const snap = snapshot as {
        metadata?: unknown;
        ruleResults?: { violations?: { tradeIndex: number; tradeData?: Partial<Trade> & { openTime?: string | Date } }[] }[];
        trades?: (Omit<Trade, 'openTime' | 'closeTime'> & { openTime: string; closeTime: string })[];
      };
      let tradesForDist: Trade[] = [];
      if (Array.isArray(snap.trades) && snap.trades.length > 0) {
        tradesForDist = snap.trades.map((t) => ({
          ...t,
          openTime: new Date(t.openTime),
          closeTime: new Date(t.closeTime),
        })) as Trade[];
      } else {
        const seenIdx = new Set<number>();
        for (const rr of snap.ruleResults ?? []) {
          for (const v of rr.violations ?? []) {
            if (seenIdx.has(v.tradeIndex)) continue;
            seenIdx.add(v.tradeIndex);
            if (!v.tradeData) continue;
            const td = v.tradeData;
            tradesForDist.push({
              index: v.tradeIndex,
              position: td.position ?? 0,
              symbol: td.symbol ?? '',
              type: td.type ?? 'buy',
              volume: td.volume ?? 0,
              openPrice: 0,
              closePrice: 0,
              sl: null,
              tp: null,
              openTime: td.openTime ? new Date(td.openTime as unknown as string) : new Date(0),
              closeTime: new Date(0),
              commission: 0,
              swap: 0,
              profit: td.profit ?? 0,
              durationMinutes: td.durationMinutes ?? 0,
            });
          }
        }
      }

      if (tradesForDist.length > 0) {
        const dist = computeDurationDistribution(tradesForDist);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const afterTradesHist = ((doc as any).lastAutoTable?.finalY ?? 200) + 8;
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.text('Distribución por Duración', 14, afterTradesHist);

        const distRowsHist = dist.buckets.map((b) => [
          b.label,
          String(b.count),
          b.profitTotal.toFixed(2),
        ]);
        distRowsHist.push(['Total:', String(dist.totalCount), dist.totalProfit.toFixed(2)]);

        autoTable(doc, {
          startY: afterTradesHist + 3,
          head: [['Rango de duración', 'Cantidad de trades', 'Profit total']],
          body: distRowsHist,
          theme: 'grid',
          headStyles: { fillColor: [22, 101, 52], textColor: 255, fontSize: 9 },
          bodyStyles: { fontSize: 8 },
          columnStyles: {
            0: { halign: 'center' },
            1: { halign: 'center' },
            2: { halign: 'center', fontStyle: 'bold' },
          },
          didParseCell: (data) => {
            if (data.row.index === distRowsHist.length - 1 && data.section === 'body') {
              data.cell.styles.fillColor = [22, 101, 52];
              data.cell.styles.textColor = 255;
              data.cell.styles.fontStyle = 'bold';
            }
            if (data.column.index === 2 && data.section === 'body' && data.row.index < distRowsHist.length - 1) {
              const val = parseFloat(String(data.cell.raw));
              if (val > 0) data.cell.styles.textColor = [0, 130, 0];
              else if (val < 0) data.cell.styles.textColor = [180, 0, 0];
            }
          },
        });
      }

      const fileNamePdf = `RevisionPropFirm_${meta.accountNumber}_${meta.period?.replace(/[^a-zA-Z0-9]/g, '_') ?? 'periodo'}.pdf`;
      doc.save(fileNamePdf);
    } catch (err) {
      console.error('Error generando PDF desde historial:', err);
    } finally {
      setHistoryLoading(null);
    }
  }, []);

  // ─── File handling ───

  const processFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setFileName(file.name);
    setViolPage(0);
    setOpsPage(0);
    setRuleFilter('all');
    setShowAll(false);

    try {
      const buffer = await file.arrayBuffer();
      const parsed: ParseResult = await parseTradeReport(buffer);
      const analysis = analyzeReport(parsed, config);
      setResult(analysis);
      // Guardar en historial automáticamente
      saveToHistory(analysis, file.name, null); // verdict se actualiza después con approvalStatus
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al procesar el archivo');
    } finally {
      setLoading(false);
    }
  }, [config, saveToHistory]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && /\.xlsx?$/i.test(file.name)) {
      processFile(file);
    } else {
      setError('Solo se aceptan archivos .xlsx o .xls');
    }
  }, [processFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = '';
  }, [processFile]);

  // ─── Re-analyze with new config ───

  const reAnalyze = useCallback(() => {
    if (!result) return;
    // Re-parse isn't needed, we have trades + metadata
    const reResult = analyzeReport(
      { trades: result.trades, metadata: result.metadata },
      config,
    );
    setResult(reResult);
    saveToHistory(reResult, fileName ?? '', null);
    setViolPage(0);
    setRuleFilter('all');
  }, [result, config, saveToHistory, fileName]);

  // ─── Computed data ───

  // Distribución de trades por rangos de duración. Se recalcula cuando
  // cambia `result`, así que cubre tanto subir un Excel nuevo como cargar
  // un informe del Historial. Es información puramente visual: no afecta
  // el verdict ni el cálculo de reglas.
  const durationDistribution = useMemo(() => {
    if (!result) return null;
    return computeDurationDistribution(result.trades);
  }, [result]);

  // Cuando se descarga el PDF de un análisis nuevo, controla si incluir la
  // tabla de distribución por duración. Default `true`. No persiste — cada
  // descarga el usuario decide. (En el PDF del Historial no hay checkbox:
  // se incluye siempre porque es una acción puntual.)
  const [includeDurationInPDF, setIncludeDurationInPDF] = useState(true);

  const violatedTradeIndices = useMemo(() => {
    if (!result) return new Set<number>();
    const set = new Set<number>();
    for (const rr of result.ruleResults) {
      if (!rr.isActive) continue;
      for (const v of rr.violations) set.add(v.tradeIndex);
    }
    return set;
  }, [result]);

  // Map: tradeIndex → list of rule names that flagged it
  const tradeRuleMap = useMemo(() => {
    if (!result) return new Map<number, string[]>();
    const map = new Map<number, string[]>();
    for (const rr of result.ruleResults) {
      if (!rr.isActive) continue;
      for (const v of rr.violations) {
        const list = map.get(v.tradeIndex) || [];
        list.push(rr.displayName);
        map.set(v.tradeIndex, list);
      }
    }
    return map;
  }, [result]);

  // Filtered violations for table
  const filteredViolations = useMemo(() => {
    if (!result) return [];
    if (ruleFilter === 'all') {
      const seen = new Set<number>();
      const list: { trade: Trade | undefined; tradeIndex: number; rules: string[]; details: string[] }[] = [];
      for (const rr of result.ruleResults) {
        if (!rr.isActive) continue;
        for (const v of rr.violations) {
          if (!seen.has(v.tradeIndex)) {
            seen.add(v.tradeIndex);
            list.push({
              trade: result.trades[v.tradeIndex],
              tradeIndex: v.tradeIndex,
              rules: tradeRuleMap.get(v.tradeIndex) || [],
              details: [],
            });
          }
          // Add detail — usar tradeIndex directamente, no l.trade.index
          const item = list.find(l => l.tradeIndex === v.tradeIndex);
          if (item) item.details.push(`${rr.displayName}: ${v.detail}`);
        }
      }
      return list;
    }
    const rr = result.ruleResults.find(r => r.ruleName === ruleFilter);
    if (!rr) return [];
    return rr.violations.map(v => ({
      trade: result.trades[v.tradeIndex],
      tradeIndex: v.tradeIndex,
      rules: [rr.displayName],
      details: [v.detail],
    }));
  }, [result, ruleFilter, tradeRuleMap]);

  const violPageCount = Math.max(1, Math.ceil(filteredViolations.length / PAGE_SIZE));
  const violPageItems = filteredViolations.slice(violPage * PAGE_SIZE, (violPage + 1) * PAGE_SIZE);

  // Operations table
  const opsData = useMemo(() => {
    if (!result) return [];
    return showAll ? result.trades : result.trades.filter(t => violatedTradeIndices.has(t.index));
  }, [result, showAll, violatedTradeIndices]);

  const opsPageCount = Math.max(1, Math.ceil(opsData.length / PAGE_SIZE));
  const opsPageItems = opsData.slice(opsPage * PAGE_SIZE, (opsPage + 1) * PAGE_SIZE);

  // ─── Verdict ───

  const verdict = useMemo(() => {
    if (!result) return null;
    const active = result.ruleResults.filter(r => r.isActive);
    const totalViolations = active.reduce((s, r) => s + r.violations.length, 0);

    // Mode: none — original behavior (fail if any violation)
    if (approvalLimits.mode === 'none') {
      const failed = active.filter(r => r.status === 'fail');
      if (failed.length === 0) return { status: 'pass' as const, msg: t('risk.verdictPass') };
      return {
        status: 'fail' as const,
        msg: `${t('risk.verdictFail')} (${failed.length}/${active.length} ${t('risk.rules')})`,
      };
    }

    // Mode: global — pass if total <= globalMax
    if (approvalLimits.mode === 'global') {
      const max = approvalLimits.globalMax;
      if (totalViolations <= max) {
        return {
          status: 'pass' as const,
          msg: `${t('risk.approved')} — ${totalViolations} ${t('risk.violationsOf')} ${max} ${t('risk.allowed')}`,
        };
      }
      return {
        status: 'fail' as const,
        msg: `${t('risk.rejected')} — ${totalViolations} ${t('risk.violationsExceed')} ${max} ${t('risk.allowed')}`,
      };
    }

    // Mode: per-rule — pass only if ALL rules are within their individual limit
    const perRule = approvalLimits.perRule;
    const failedRules: { name: string; found: number; max: number }[] = [];
    for (const rr of active) {
      const ruleKey = rr.ruleName as keyof typeof perRule;
      const max = perRule[ruleKey] ?? 0;
      if (rr.violations.length > max) {
        failedRules.push({ name: rr.displayName, found: rr.violations.length, max });
      }
    }

    if (failedRules.length === 0) {
      return {
        status: 'pass' as const,
        msg: `${t('risk.approved')} — ${t('risk.allRulesWithinLimits')}`,
      };
    }

    const first = failedRules[0];
    const extra = failedRules.length > 1 ? ` (+${failedRules.length - 1})` : '';
    return {
      status: 'fail' as const,
      msg: `${t('risk.rejected')} — ${first.name} ${t('risk.exceedsLimit')} (${first.found} ${t('risk.found')}, ${t('risk.max')} ${first.max})${extra}`,
    };
  }, [result, approvalLimits, t]);

  // ─── Download PDF ───

  const downloadPDF = useCallback(async () => {
    if (!result) return;
    // Dynamic import for code-splitting; both libs expose CJS+ESM variants.
    const { jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');

    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const meta = result.metadata;
    const v = verdict;

    // Header
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('Informe de Revisión PropFirm', 14, 16);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Trader: ${meta.traderName}`, 14, 23);
    doc.text(`Cuenta: ${meta.accountNumber}`, 14, 28);
    doc.text(`Broker: ${meta.broker}`, 14, 33);
    doc.text(`Período: ${meta.period}`, 14, 38);
    doc.text(`Total Net Profit: ${formatCurrency(meta.totalNetProfit)}`, 14, 43);
    doc.text(`Total Operaciones: ${result.trades.length}`, 14, 48);
    doc.text(`Generado: ${formatDate(new Date())}`, 14, 53);

    // Verdict
    const verdictText = v ? (v.status === 'pass' ? `✓ APROBADO — ${v.msg}` : `✗ RECHAZADO — ${v.msg}`) : '';
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(v?.status === 'pass' ? 0 : 180, v?.status === 'pass' ? 120 : 0, 0);
    doc.text(verdictText, 14, 62);
    doc.setTextColor(0, 0, 0);

    // Rules summary
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('Resumen de Reglas', 14, 72);
    const ruleRows = result.ruleResults.filter(r => r.isActive).map(r => [
      r.displayName,
      r.status === 'pass' ? '✓ OK' : '✗ FALLA',
      `${r.violations.length} (${r.violationPct.toFixed(1)}%)`,
      Object.entries(r.computedParams).map(([k, val]) => `${k}: ${val}`).join(' | '),
    ]);
    autoTable(doc, {
      startY: 75,
      head: [['Regla', 'Estado', 'Incumplimientos', 'Parámetros']],
      body: ruleRows,
      theme: 'grid',
      headStyles: { fillColor: [30, 30, 30], textColor: 255, fontSize: 8 },
      bodyStyles: { fontSize: 8 },
      columnStyles: { 1: { fontStyle: 'bold' } },
      didParseCell: (data) => {
        if (data.column.index === 1 && data.section === 'body') {
          const raw = typeof data.cell.raw === 'string' ? data.cell.raw : '';
          data.cell.styles.textColor = raw.startsWith('✓') ? [0, 150, 0] : [180, 0, 0];
        }
      },
    });

    // All trades table
    // autoTable augments the doc with `lastAutoTable` but it's not in the public types.
    const afterRules = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text(`Todas las Operaciones (${result.trades.length})`, 14, afterRules);

    const tradeRows = result.trades.map(trade => {
      const rules = tradeRuleMap.get(trade.index) || [];
      const isViolation = violatedTradeIndices.has(trade.index);
      return {
        data: [
          trade.position.toString(),
          trade.symbol,
          trade.type.toUpperCase(),
          trade.volume.toString(),
          formatCurrency(trade.profit),
          fmtDuration(trade.durationMinutes),
          fmtDate(trade.openTime),
          isViolation ? rules.join(', ') : '✓ OK',
        ],
        isViolation,
      };
    });

    autoTable(doc, {
      startY: afterRules + 3,
      head: [['Position', 'Symbol', 'Tipo', 'Volume', 'Profit', 'Duración', 'Apertura', 'Reglas Violadas']],
      body: tradeRows.map(r => r.data),
      theme: 'striped',
      headStyles: { fillColor: [30, 30, 30], textColor: 255, fontSize: 7 },
      bodyStyles: { fontSize: 7 },
      didParseCell: (data) => {
        if (data.section === 'body') {
          const row = tradeRows[data.row.index];
          if (row?.isViolation) {
            data.cell.styles.fillColor = [255, 235, 235];
            data.cell.styles.textColor = [150, 0, 0];
          }
          if (data.column.index === 7 && !row?.isViolation) {
            data.cell.styles.textColor = [0, 130, 0];
          }
        }
      },
    });

    // Distribución por Duración (opcional, controlada por checkbox)
    if (includeDurationInPDF && durationDistribution) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const afterTrades = ((doc as any).lastAutoTable?.finalY ?? 200) + 8;
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text('Distribución por Duración', 14, afterTrades);

      const distRows = durationDistribution.buckets.map((b) => [
        b.label,
        String(b.count),
        b.profitTotal.toFixed(2),
      ]);
      // Fila Total al final
      distRows.push([
        'Total:',
        String(durationDistribution.totalCount),
        durationDistribution.totalProfit.toFixed(2),
      ]);

      autoTable(doc, {
        startY: afterTrades + 3,
        head: [['Rango de duración', 'Cantidad de trades', 'Profit total']],
        body: distRows,
        theme: 'grid',
        headStyles: { fillColor: [22, 101, 52], textColor: 255, fontSize: 9 }, // emerald-700
        bodyStyles: { fontSize: 8 },
        columnStyles: {
          0: { halign: 'center' },
          1: { halign: 'center' },
          2: { halign: 'center', fontStyle: 'bold' },
        },
        didParseCell: (data) => {
          // Última fila = Total → estilo verde igual al header
          if (data.row.index === distRows.length - 1 && data.section === 'body') {
            data.cell.styles.fillColor = [22, 101, 52];
            data.cell.styles.textColor = 255;
            data.cell.styles.fontStyle = 'bold';
          }
          // Profit con color (excepto fila Total que ya es blanca)
          if (data.column.index === 2 && data.section === 'body' && data.row.index < distRows.length - 1) {
            const val = parseFloat(String(data.cell.raw));
            if (val > 0) data.cell.styles.textColor = [0, 130, 0];
            else if (val < 0) data.cell.styles.textColor = [180, 0, 0];
          }
        },
      });
    }

    const fileName = `RevisionPropFirm_${meta.accountNumber}_${meta.period.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    doc.save(fileName);
  }, [result, verdict, tradeRuleMap, violatedTradeIndices, includeDurationInPDF, durationDistribution]);

  // ─── Render ───

  // Module access guard — render nothing while the effect redirects.
  // ── EL REGLAMENTO VIENE DEL REGISTRO, NO DE ESTA PANTALLA ────────────────
  // Estos cinco números eran los de Vex Instant y Elite, fijos, y no se
  // guardaban en ningún lado: al recargar volvían al valor por defecto. Eso
  // los convertía en una SEGUNDA definición de las mismas reglas, que ya no
  // coincidía con la revisión automática.
  //
  // Y no coincidir tiene consecuencias concretas: a un X12 le marcaba
  // infracciones de grid y de martingala, que ese programa PERMITE — o sea,
  // infracciones que el cliente compró el derecho a no tener. A un Vex2Pro le
  // exigía 5 minutos por operación cuando su reglamento pide 2.
  //
  // Ahora se elige el programa y los parámetros salen de `risk/programs.ts`,
  // que es el mismo origen que usa la revisión automática. Una sola
  // definición: si el reglamento cambia, cambia en los dos lados a la vez.
  function aplicarPrograma(nombre: string) {
    setPrograma(nombre);
    if (!nombre) { setConfig(structuredClone(DEFAULT_RULE_CONFIG)); return; }
    const reglas = rulesForProgram(nombre);
    if (!reglas) return;
    const p = (id: string) => reglas.rules.find(r => r.id === id);
    const dur = p('min_duration'), cons = p('lot_consistency'), conc = p('profit_concentration');
    const grid = p('grid'), mart = p('martingale');
    // `enabled: false` cuando el programa NO tiene la regla. No es que la
    // cumpla: es que no le aplica, y evaluarla inventaría una infracción.
    setConfig({
      consistencia: { enabled: !!cons, factorMin: cons?.params?.factorMin ?? 0.25, factorMax: cons?.params?.factorMax ?? 2 },
      profitPct:    { enabled: !!conc, pct: conc?.params?.maxPct ?? 30 },
      tiempoMin:    { enabled: !!dur,  minutos: dur?.params?.minutos ?? 5 },
      grid:         { enabled: !!grid, minGrid: grid?.params?.minSimultaneas ?? 3 },
      martingala:   { enabled: !!mart, gapMaximo: mart?.params?.gapMaximo ?? 5 },
    });
  }

  if (accessDenied) return null;

  const activeRules = result ? result.ruleResults.filter((r) => r.isActive && r.violations.length > 0) : [];

  const historyCols: FinColumn<HistoryRecord>[] = [
    {
      key: 'savedAt',
      header: 'Fecha',
      cell: (rec) => <span className={cn(NUM_CLASS, 'text-[12.5px] text-text-2')}>{fmtDate(new Date(rec.savedAt))}</span>,
      hideSm: true,
    },
    {
      key: 'trader',
      header: 'Trader',
      cell: (rec) => rec.traderName || '—',
      meta: (rec) => `${rec.accountNumber || '—'} · ${rec.period || '—'}`,
      mobileMeta: (rec) => <VerdictBadge verdict={rec.verdict} />,
    },
    {
      key: 'trades',
      header: 'Operaciones',
      kind: 'number',
      hideSm: true,
      value: (rec) => rec.totalTrades,
    },
    {
      key: 'profit',
      header: 'Net Profit',
      kind: 'money',
      value: (rec) => rec.totalNetProfit,
      money: { tone: 'sign' },
    },
    {
      key: 'verdict',
      header: 'Veredicto',
      hideSm: true,
      cell: (rec) => <VerdictBadge verdict={rec.verdict} />,
    },
    {
      key: 'rules',
      header: 'Reglas',
      hideSm: true,
      cell: (rec) => (
        <div className="flex flex-wrap gap-1 py-1.5">
          {rec.rulesSummary.map((r) => (
            <StatusBadge
              key={r.ruleName}
              kind={r.status === 'pass' ? 'ok' : r.status === 'fail' ? 'bad' : 'neutral'}
              label={`${r.displayName}: ${r.violations}`}
            />
          ))}
        </div>
      ),
    },
  ];

  const violationCols: FinColumn<ViolationItem>[] = [
    {
      key: 'position',
      header: 'Position',
      cell: (item) => <span className="font-mono text-[12px]">{item.trade?.position ?? '—'}</span>,
      meta: (item) => (item.trade ? `${item.trade.symbol} · ${item.trade.type.toUpperCase()}` : '—'),
      mobileMeta: (item) => (
        <>
          {item.rules.map((r, ri) => (
            <StatusBadge key={ri} kind="bad" label={r} />
          ))}
        </>
      ),
    },
    {
      key: 'volume',
      header: 'Volume',
      kind: 'number',
      hideSm: true,
      value: (item) => item.trade?.volume ?? null,
      cell: (item) => <span className={NUM_CLASS}>{item.trade?.volume ?? '—'}</span>,
    },
    {
      key: 'profit',
      header: 'Profit',
      kind: 'money',
      value: (item) => item.trade?.profit ?? null,
      money: { tone: 'sign' },
    },
    {
      key: 'duration',
      header: t('risk.duration'),
      align: 'right',
      hideSm: true,
      cell: (item) => (
        <span className={cn(NUM_CLASS, 'text-text-2')}>
          {item.trade ? fmtDuration(item.trade.durationMinutes) : '—'}
        </span>
      ),
    },
    {
      key: 'rules',
      header: t('risk.rulesViolated'),
      hideSm: true,
      cell: (item) => (
        <div className="py-1.5">
          <div className="flex flex-wrap gap-1">
            {item.rules.map((r, ri) => (
              <StatusBadge key={ri} kind="bad" label={r} />
            ))}
          </div>
          {item.details.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[12px] text-text-3 hover:text-foreground">{t('risk.details')}</summary>
              <div className="mt-1 space-y-0.5">
                {item.details.map((d, di) => (
                  <p key={di} className="text-[12px] text-text-2">
                    {d}
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      ),
    },
  ];

  const opsCols: FinColumn<Trade>[] = [
    {
      key: 'position',
      header: 'Position',
      cell: (trade) => <span className="font-mono text-[12px]">{trade.position}</span>,
      meta: (trade) => `#${trade.index + 1} · ${trade.symbol} · ${trade.type.toUpperCase()}`,
      mobileMeta: (trade) => <TradeFlags rules={tradeRuleMap.get(trade.index) ?? []} />,
    },
    {
      key: 'volume',
      header: 'Volume',
      kind: 'number',
      hideSm: true,
      value: (trade) => trade.volume,
      cell: (trade) => <span className={NUM_CLASS}>{trade.volume}</span>,
    },
    {
      key: 'open',
      header: t('risk.openTime'),
      hideSm: true,
      cell: (trade) => <span className={cn(NUM_CLASS, 'text-[12.5px] text-text-2')}>{fmtDate(trade.openTime)}</span>,
    },
    {
      key: 'close',
      header: t('risk.closeTime'),
      hideSm: true,
      cell: (trade) => <span className={cn(NUM_CLASS, 'text-[12.5px] text-text-2')}>{fmtDate(trade.closeTime)}</span>,
    },
    {
      key: 'openPrice',
      header: t('risk.openPrice'),
      align: 'right',
      hideSm: true,
      cell: (trade) => <span className={NUM_CLASS}>{trade.openPrice}</span>,
    },
    {
      key: 'closePrice',
      header: t('risk.closePrice'),
      align: 'right',
      hideSm: true,
      cell: (trade) => <span className={NUM_CLASS}>{trade.closePrice}</span>,
    },
    {
      key: 'commission',
      header: 'Commission',
      kind: 'money',
      hideSm: true,
      value: (trade) => trade.commission,
      cell: (trade) => <Money value={trade.commission} className="text-text-2" />,
    },
    {
      key: 'swap',
      header: 'Swap',
      kind: 'money',
      hideSm: true,
      value: (trade) => trade.swap,
      cell: (trade) => <Money value={trade.swap} className="text-text-2" />,
    },
    {
      key: 'profit',
      header: 'Profit',
      kind: 'money',
      value: (trade) => trade.profit,
      money: { tone: 'sign' },
    },
    {
      key: 'duration',
      header: t('risk.duration'),
      align: 'right',
      hideSm: true,
      cell: (trade) => <span className={cn(NUM_CLASS, 'text-text-2')}>{fmtDuration(trade.durationMinutes)}</span>,
    },
    {
      key: 'flags',
      header: t('risk.flags'),
      hideSm: true,
      cell: (trade) => <TradeFlags rules={tradeRuleMap.get(trade.index) ?? []} />,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('risk.title')}
        subtitle={t('risk.subtitle')}
        icon={FileSearch}
        actions={
          <ActionButton aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>
            <FileSearch className="size-4" aria-hidden />
            Historial
            <span className={cn(NUM_CLASS, 'text-text-3')}>{history.length}</span>
          </ActionButton>
        }
      />

      {/* ── La cola automática ────────────────────────────────────────────
          Va ARRIBA de todo lo demás: es lo que hay que mirar cuando se entra.
          La subida manual queda abajo, para analizar una cuenta suelta que no
          tiene un retiro pendiente. */}
      {cola && (
        <PropfirmQueuePanel
          pending={cola.pending}
          resolved={cola.resolved}
          disclaimer={cola.disclaimer}
          company={{ name: company?.name ?? 'Dashboard', logoUrl: company?.logo_url ?? null }}
        />
      )}

      {/* Rule Config Panel */}
      <section className="rounded-ui-lg border border-border bg-card shadow-1">
        <button
          type="button"
          onClick={() => setConfigOpen((prev) => !prev)}
          aria-expanded={configOpen}
          className="flex min-h-12 w-full items-center justify-between px-4 py-3 text-left hover:bg-row-hover"
        >
          <span className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.005em] text-foreground">
            <Settings className="size-4 text-text-3" aria-hidden />
            {t('risk.configRules')}
          </span>
          <ChevronDown className={cn('size-4 text-text-3 transition-transform', configOpen && 'rotate-180')} aria-hidden />
        </button>

        {configOpen && (
          <div className="border-t border-border px-4 py-4">
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <Field label="Programa" className="min-w-[220px]">
                <Select value={programa} onChange={(e) => aplicarPrograma(e.target.value)}>
                  <option value="">Manual (valores de abajo)</option>
                  {PROGRAM_RULES.map((p) => (
                    <option key={p.label} value={p.orionNames[0]}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="flex-1 text-[12.5px] text-text-3">
                {programa
                  ? 'Los parámetros salen del reglamento del programa, el mismo que usa la revisión automática. Una regla apagada no es que se cumpla: es que ese programa no la tiene.'
                  : 'Sin programa elegido se usan los valores de abajo, que son los de Vex Instant y Elite. Para otro programa, elegilo arriba: aplicarle estos daría infracciones que no le corresponden.'}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {/* R1: Consistencia */}
              <ConfigCard
                title={t('risk.r1Name')}
                enabled={config.consistencia.enabled}
                onToggle={(v) => setConfig((c) => ({ ...c, consistencia: { ...c.consistencia, enabled: v } }))}
              >
                <ConfigInput label={t('risk.r1FactorMin')} value={config.consistencia.factorMin}
                  onChange={(v) => setConfig((c) => ({ ...c, consistencia: { ...c.consistencia, factorMin: v } }))} step={0.05} />
                <ConfigInput label={t('risk.r1FactorMax')} value={config.consistencia.factorMax}
                  onChange={(v) => setConfig((c) => ({ ...c, consistencia: { ...c.consistencia, factorMax: v } }))} step={0.1} />
              </ConfigCard>

              {/* R2: Profit % */}
              <ConfigCard
                title={t('risk.r2Name')}
                enabled={config.profitPct.enabled}
                onToggle={(v) => setConfig((c) => ({ ...c, profitPct: { ...c.profitPct, enabled: v } }))}
              >
                <ConfigInput label={t('risk.r2Pct')} value={config.profitPct.pct}
                  onChange={(v) => setConfig((c) => ({ ...c, profitPct: { ...c.profitPct, pct: v } }))} step={5} suffix="%" />
              </ConfigCard>

              {/* R3: Tiempo Min */}
              <ConfigCard
                title={t('risk.r3Name')}
                enabled={config.tiempoMin.enabled}
                onToggle={(v) => setConfig((c) => ({ ...c, tiempoMin: { ...c.tiempoMin, enabled: v } }))}
              >
                <ConfigInput label={t('risk.r3Minutes')} value={config.tiempoMin.minutos}
                  onChange={(v) => setConfig((c) => ({ ...c, tiempoMin: { ...c.tiempoMin, minutos: v } }))} step={1} suffix="min" />
              </ConfigCard>

              {/* R4: Grid */}
              <ConfigCard
                title={t('risk.r4Name')}
                enabled={config.grid.enabled}
                onToggle={(v) => setConfig((c) => ({ ...c, grid: { ...c.grid, enabled: v } }))}
              >
                <ConfigInput label={t('risk.r4MinGrid')} value={config.grid.minGrid}
                  onChange={(v) => setConfig((c) => ({ ...c, grid: { ...c.grid, minGrid: Math.max(2, Math.round(v)) } }))} step={1} />
              </ConfigCard>

              {/* R5: Martingala */}
              <ConfigCard
                title={t('risk.r5Name')}
                enabled={config.martingala.enabled}
                onToggle={(v) => setConfig((c) => ({ ...c, martingala: { ...c.martingala, enabled: v } }))}
              >
                <ConfigInput label={t('risk.r5Gap')} value={config.martingala.gapMaximo}
                  onChange={(v) => setConfig((c) => ({ ...c, martingala: { ...c.martingala, gapMaximo: v } }))} step={1} suffix="min" />
              </ConfigCard>
            </div>

            {/* Approval Limits */}
            <div className="mt-5 border-t border-border pt-4">
              <div className="mb-3 flex items-center gap-2">
                <Shield className="size-4 text-text-3" aria-hidden />
                <h3 className="text-[13.5px] font-semibold text-foreground">{t('risk.approvalLimits')}</h3>
              </div>

              <Segmented<ApprovalMode>
                aria-label={t('risk.approvalLimits')}
                value={approvalLimits.mode}
                onChange={(mode) => setApprovalLimits((prev) => ({ ...prev, mode }))}
                options={[
                  { value: 'none', label: t('risk.modeNone') },
                  { value: 'global', label: t('risk.modeGlobal') },
                  { value: 'per-rule', label: t('risk.modePerRule') },
                ]}
                className="mb-4"
              />

              {/* Global limit input */}
              {approvalLimits.mode === 'global' && (
                <div className="flex items-center gap-3">
                  <span className="text-[12.5px] text-text-2">{t('risk.globalMaxLabel')}</span>
                  <input
                    type="number"
                    min={0}
                    aria-label={t('risk.globalMaxLabel')}
                    value={approvalLimits.globalMax}
                    onChange={(e) => setApprovalLimits((prev) => ({ ...prev, globalMax: Math.max(0, parseInt(e.target.value) || 0) }))}
                    className={cn(CONTROL_CLASS, 'h-8 w-20 border-control-border text-center tabular-nums')}
                  />
                </div>
              )}

              {/* Per-rule limit inputs */}
              {approvalLimits.mode === 'per-rule' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {([
                    { key: 'consistencia' as const, label: t('risk.r1Name') },
                    { key: 'profitPct' as const, label: t('risk.r2Name') },
                    { key: 'tiempoMin' as const, label: t('risk.r3Name') },
                    { key: 'grid' as const, label: t('risk.r4Name') },
                    { key: 'martingala' as const, label: t('risk.r5Name') },
                  ]).map(({ key, label }) => (
                    <div key={key} className="flex items-center justify-between gap-2 rounded-ui-md border border-border px-3 py-2">
                      <span className="truncate text-[12.5px] text-text-2">{label}</span>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min={0}
                          aria-label={label}
                          value={approvalLimits.perRule[key]}
                          onChange={(e) => setApprovalLimits((prev) => ({
                            ...prev,
                            perRule: { ...prev.perRule, [key]: Math.max(0, parseInt(e.target.value) || 0) },
                          }))}
                          className={cn(CONTROL_CLASS, 'h-8 w-16 border-control-border text-center tabular-nums')}
                        />
                        <span className="text-[12px] text-text-3">{t('risk.maxShort')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {result && (
              <div className="mt-4 flex justify-end">
                {/* El único primario de la pantalla: aplica la configuración. */}
                <ActionButton variant="primary" onClick={reAnalyze}>
                  {t('risk.reanalyze')}
                </ActionButton>
              </div>
            )}
          </div>
        )}
      </section>

      {/* History Panel */}
      {showHistory && (
        <Panel
          title="Historial de revisiones"
          hint={`${history.length} registros`}
          flush
          actions={
            history.length > 0 ? (
              <ActionButton
                variant="danger"
                onClick={async () => {
                  if (!confirm('¿Eliminar todo el historial?')) return;
                  // Optimistic UI: vaciamos local, luego borramos en BD en
                  // paralelo. Si una falla, el próximo fetch reconcilia.
                  const idsToDelete = history.map((r) => r.id);
                  setHistory([]);
                  try {
                    await Promise.all(
                      idsToDelete.map((id) =>
                        apiFetch(`/api/risk/revisions/${id}`, {
                          method: 'DELETE',
                        }).catch(() => null),
                      ),
                    );
                  } catch (err) {
                    console.error('[risk/revisions] clear all error:', err);
                  }
                }}
              >
                Limpiar historial
              </ActionButton>
            ) : null
          }
        >
          <FinTable<HistoryRecord>
            caption="Historial de revisiones"
            columns={historyCols}
            rows={history}
            rowKey={(rec) => rec.id}
            maxHeight="60vh"
            empty="No hay revisiones guardadas aún"
            rowActions={(rec) => (
              <>
                <button
                  type="button"
                  onClick={() => restoreFromHistory(rec)}
                  className={ROW_ACTION_CLASS}
                  aria-label="Ver análisis"
                  title="Ver análisis"
                >
                  <Eye className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => downloadPDFFromHistory(rec)}
                  disabled={historyLoading === rec.id}
                  className={ROW_ACTION_CLASS}
                  aria-label="Descargar PDF"
                  title="Descargar PDF"
                >
                  {historyLoading === rec.id ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <FileText className="size-4" aria-hidden />
                  )}
                </button>
              </>
            )}
          />
        </Panel>
      )}

      {/* Upload Zone */}
      {!result && !loading && (
        <div
          role="button"
          tabIndex={0}
          aria-label={t('risk.uploadTitle')}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-ui-lg border-2 border-dashed p-12 transition-colors',
            dragOver ? 'border-brand-ink bg-brand-tint' : 'border-border-strong hover:border-control-border',
          )}
        >
          <Upload className="size-10 text-text-3" aria-hidden />
          <p className="text-[13.5px] font-medium text-foreground">{t('risk.uploadTitle')}</p>
          <p className="text-[12.5px] text-text-3">{t('risk.uploadHint')}</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={handleFileInput}
          />
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-16" role="status">
          <Loader2 className="size-8 animate-spin text-brand-ink" aria-hidden />
          <p className="text-[13px] text-text-2">{t('risk.analyzing')}</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <Notice kind="bad" title={error} />
      )}

      {/* Results */}
      {result && (
        <>
          {/* File info + New upload button */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 text-[13px] text-text-2">
              <FileSpreadsheet className="size-4 text-text-3" aria-hidden />
              {fileName}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-[12.5px] text-text-2">
                <input
                  type="checkbox"
                  checked={includeDurationInPDF}
                  onChange={(e) => setIncludeDurationInPDF(e.target.checked)}
                  className="size-3.5 rounded border-control-border accent-brand-ink"
                />
                Incluir tabla de duración
              </label>
              <ActionButton onClick={downloadPDF}>
                <FileText className="size-4" aria-hidden />
                Descargar PDF
              </ActionButton>
              <ActionButton
                variant="ghost"
                onClick={() => { setResult(null); setError(null); setFileName(null); }}
              >
                {t('risk.newUpload')}
              </ActionButton>
            </div>
          </div>

          {/* Metadatos del informe */}
          <Panel>
            <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
              <MetaField label={t('risk.metaTrader')} value={result.metadata.traderName || '—'} />
              <MetaField label={t('risk.metaAccount')} value={result.metadata.accountNumber || '—'} mono />
              <MetaField label={t('risk.metaBroker')} value={result.metadata.broker || '—'} />
              <MetaField label={t('risk.metaPeriod')} value={result.metadata.period || '—'} />
              <div className="min-w-0">
                <dt className="text-[12px] font-medium text-text-3">{t('risk.metaProfit')}</dt>
                <dd className="mt-0.5 text-[13px] font-semibold">
                  <Money value={result.metadata.totalNetProfit} tone="sign" />
                </dd>
              </div>
              <MetaField label={t('risk.metaTrades')} value={String(result.trades.length)} num />
            </dl>
          </Panel>

          {/* Rule Summary Cards */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-5">
            {result.ruleResults.map((rr) => (
              <section key={rr.ruleName} className="rounded-ui-lg border border-border bg-card p-4 shadow-1">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h3 className="text-[13px] font-semibold text-foreground">{rr.displayName}</h3>
                  <StatusBadge kind={RULE_KIND[rr.status]} label={RULE_LABEL[rr.status]} />
                </div>
                {rr.isActive ? (
                  <>
                    <p className={cn(NUM_CLASS, 'text-[22px] font-semibold leading-[30px] text-foreground')}>
                      {rr.violations.length}
                    </p>
                    <p className="text-[12px] text-text-3">
                      {t('risk.violations')} ({formatPercentValue(rr.violationPct)})
                    </p>
                    {Object.entries(rr.computedParams).length > 0 && (
                      <div className="mt-2 space-y-0.5">
                        {Object.entries(rr.computedParams).map(([k, v]) => (
                          <p key={k} className="truncate text-[12px] text-text-3">
                            {k}: {v}
                          </p>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-[12.5px] italic text-text-3">{t('risk.skipped')}</p>
                )}
              </section>
            ))}
          </div>

          {/* Verdict Banner — el resultado según los LÍMITES elegidos arriba. */}
          {verdict &&
            (verdict.status === 'pass' ? (
              <div
                role="status"
                className="flex items-start gap-2.5 rounded-ui-md border border-pos/35 bg-pos-bg px-3.5 py-2.5 text-[13px] leading-5 text-foreground"
              >
                <CheckCircle className="mt-0.5 size-4 shrink-0 text-pos" aria-hidden />
                <div className="min-w-0">
                  <p className="font-semibold">{t('risk.approved')}</p>
                  <p className="text-text-2">{verdict.msg}</p>
                </div>
              </div>
            ) : (
              <Notice kind="bad" title={t('risk.rejected')}>
                {verdict.msg}
              </Notice>
            ))}

          {/* Distribución por Duración — siempre visible cuando hay un
              `result` cargado (analisis nuevo o restaurado del Historial).
              Click en cualquier fila con count>0 abre modal con los trades
              del rango. Calculada al vuelo desde `result.trades`. */}
          {durationDistribution && (
            <Panel title="Distribución por duración" hint="Tocá un rango para ver sus operaciones." flush>
              <DurationDistributionTable
                buckets={durationDistribution.buckets}
                totalCount={durationDistribution.totalCount}
                totalProfit={durationDistribution.totalProfit}
              />
            </Panel>
          )}

          {/* Violations Table */}
          {filteredViolations.length > 0 && (
            <Panel
              title={`${t('risk.violationsTitle')} (${filteredViolations.length})`}
              flush
              actions={
                <Select
                  aria-label={t('risk.allRules')}
                  value={ruleFilter}
                  onChange={(e) => { setRuleFilter(e.target.value); setViolPage(0); }}
                  className="h-8 w-auto min-w-[180px]"
                >
                  <option value="all">{t('risk.allRules')}</option>
                  {activeRules.map((rr) => (
                    <option key={rr.ruleName} value={rr.ruleName}>
                      {rr.displayName} ({rr.violations.length})
                    </option>
                  ))}
                </Select>
              }
            >
              <FinTable<ViolationItem>
                caption={t('risk.violationsTitle')}
                columns={violationCols}
                rows={violPageItems}
                rowKey={(item) => String(item.tradeIndex)}
              />
              <SimplePager
                page={violPage}
                pageCount={violPageCount}
                label={t('risk.page')}
                onPage={setViolPage}
              />
            </Panel>
          )}

          {/* Restored-from-history notice */}
          {result.trades.length === 0 && (
            <Notice kind="pend" title="Análisis restaurado del historial">
              Las operaciones individuales no están disponibles — subí el archivo original para verlas.
            </Notice>
          )}

          {/* Full Operations Table */}
          <Panel
            title={`${t('risk.operationsTitle')} (${opsData.length})`}
            flush
            actions={
              <ActionButton variant="ghost" onClick={() => { setShowAll((prev) => !prev); setOpsPage(0); }}>
                {showAll ? <Eye className="size-4" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}
                {showAll ? t('risk.showAll') : t('risk.showViolationsOnly')}
              </ActionButton>
            }
          >
            <FinTable<Trade>
              caption={t('risk.operationsTitle')}
              columns={opsCols}
              rows={opsPageItems}
              rowKey={(trade) => String(trade.index)}
            />
            <SimplePager page={opsPage} pageCount={opsPageCount} label={t('risk.page')} onPage={setOpsPage} />
          </Panel>
        </>
      )}
    </div>
  );
}

// ─── Piezas de presentación ───

type ViolationItem = { trade: Trade | undefined; tradeIndex: number; rules: string[]; details: string[] };

function VerdictBadge({ verdict }: { verdict: HistoryRecord['verdict'] }) {
  if (verdict === 'approved') return <StatusBadge kind="ok" label="Aprobado" />;
  if (verdict === 'rejected') return <StatusBadge kind="bad" label="Rechazado" />;
  if (verdict === 'review') return <StatusBadge kind="pend" label="En revisión" />;
  return <span className="text-[12.5px] text-text-3">—</span>;
}

/** Reglas que marcó una operación: badge `bad` con el conteo, o «OK». */
function TradeFlags({ rules }: { rules: string[] }) {
  if (rules.length === 0) return <StatusBadge kind="ok" label="OK" />;
  return <StatusBadge kind="bad" label={rules.length === 1 ? rules[0] : `${rules.length} reglas`} title={rules.join(', ')} />;
}

function SimplePager({
  page,
  pageCount,
  label,
  onPage,
}: {
  page: number;
  pageCount: number;
  label: string;
  onPage: (updater: (p: number) => number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
      <p className={cn(NUM_CLASS, 'text-[12.5px] text-text-3')}>
        {label} {page + 1} / {pageCount}
      </p>
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => onPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
          className={ROW_ACTION_CLASS}
          aria-label="Página anterior"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => onPage((p) => Math.min(pageCount - 1, p + 1))}
          disabled={page >= pageCount - 1}
          className={ROW_ACTION_CLASS}
          aria-label="Página siguiente"
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ─── Config Sub-Components ───

function ConfigCard({ title, enabled, onToggle, children }: {
  title: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('space-y-2 rounded-ui-md border border-border p-3', !enabled && 'opacity-60')}>
      <div className="flex items-center justify-between">
        <h4 className="text-[12.5px] font-semibold text-foreground">{title}</h4>
        <label className="relative inline-flex cursor-pointer items-center">
          <input type="checkbox" aria-label={title} checked={enabled} onChange={(e) => onToggle(e.target.checked)} className="peer sr-only" />
          <div className="h-4 w-8 rounded-full bg-surface-sunk shadow-[inset_0_0_0_1px_var(--border-strong)] after:absolute after:left-[2px] after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-card after:shadow-1 after:transition-all after:content-[''] peer-checked:bg-primary peer-checked:after:translate-x-4 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2" />
        </label>
      </div>
      {enabled && children}
    </div>
  );
}

function ConfigInput({ label, value, onChange, step = 1, suffix }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-text-2">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          step={step}
          className={cn(CONTROL_CLASS, 'h-8 w-16 border-control-border text-right tabular-nums')}
        />
        {suffix && <span className="text-[12px] text-text-3">{suffix}</span>}
      </div>
    </div>
  );
}

function MetaField({ label, value, mono, num }: { label: string; value: string; mono?: boolean; num?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium text-text-3">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 truncate text-[13px] font-semibold text-foreground',
          mono && 'font-mono text-[12px]',
          num && NUM_CLASS,
        )}
      >
        {value}
      </dd>
    </div>
  );
}
