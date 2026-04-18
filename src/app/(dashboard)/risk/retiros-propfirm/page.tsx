'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { useI18n } from '@/lib/i18n';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { parseTradeReport, type ParseResult } from '@/lib/risk/parser';
import { analyzeReport } from '@/lib/risk/rules';
import { DEFAULT_RULE_CONFIG, DEFAULT_APPROVAL_LIMITS, type RuleConfig, type AnalysisResult, type Trade, type ApprovalLimits, type ApprovalMode } from '@/lib/risk/types';
import {
  Upload,
  Settings,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CheckCircle,
  XCircle,
  AlertTriangle,
  FileSearch,
  Filter,
  Eye,
  EyeOff,
  Loader2,
  FileSpreadsheet,
  Shield,
  FileText,
} from 'lucide-react';

// ─── Helpers ───

function fmt$(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

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

// ─── History persistence (localStorage) ───

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

const HISTORY_KEY = 'risk_propfirm_history';
const MAX_HISTORY = 50;

// ─── Page ───

const PAGE_SIZE = 50;

export default function RetirosPropFirmPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const router = useRouter();

  // Module access guard — redirect users without the 'risk' module.
  // The redirect happens in the effect; while it runs we render null.
  useEffect(() => {
    if (user === null) return; // still loading
    if (!hasModuleAccess(user, 'risk')) {
      router.replace('/');
    }
  }, [user, router]);

  const accessDenied = user !== null && !hasModuleAccess(user, 'risk');

  // State
  const [config, setConfig] = useState<RuleConfig>(structuredClone(DEFAULT_RULE_CONFIG));
  const [configOpen, setConfigOpen] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // History state (lazy-init from localStorage)
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryRecord[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw ? (JSON.parse(raw) as HistoryRecord[]) : [];
    } catch {
      return [];
    }
  });
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

  // ─── Save analysis to history (localStorage) ───

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
      }),
    };

    setHistory((prev) => {
      const next = [record, ...prev].slice(0, MAX_HISTORY);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // ─── Restore an analysis from history ───

  const restoreFromHistory = useCallback((rec: HistoryRecord) => {
    try {
      const snapshot = JSON.parse(rec.resultSnapshot);

      // Reconstruir trades desde los datos guardados en violations
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

      const restored: AnalysisResult = {
        trades: Array.from(tradesMap.values()),
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
      doc.text(`Total Net Profit: ${fmt$(meta.totalNetProfit)}`, 14, 43);
      doc.text(`Total Operaciones: ${rec.totalTrades}`, 14, 48);
      doc.text(`Revisado: ${new Date(rec.savedAt).toLocaleDateString('es-ES')}`, 14, 53);
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
          fmt$(v.tradeData?.profit ?? 0),
          fmtDuration(v.tradeData?.durationMinutes ?? 0),
          v.ruleName ?? '—',
          v.detail ?? '—',
        ]),
        theme: 'striped',
        headStyles: { fillColor: [30, 30, 30], textColor: 255, fontSize: 7 },
        bodyStyles: { fontSize: 7, fillColor: [255, 235, 235], textColor: [150, 0, 0] },
      });

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
      const parsed: ParseResult = parseTradeReport(buffer);
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

  // ─── Rule status icon ───

  const ruleStatusIcon = (status: string) => {
    switch (status) {
      case 'pass': return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'fail': return <XCircle className="w-5 h-5 text-red-500" />;
      default: return <AlertTriangle className="w-5 h-5 text-muted-foreground" />;
    }
  };

  const ruleStatusColor = (status: string) => {
    switch (status) {
      case 'pass': return 'border-green-500/30 bg-green-500/5';
      case 'fail': return 'border-red-500/30 bg-red-500/5';
      default: return 'border-border bg-muted/30';
    }
  };

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
    doc.text(`Total Net Profit: ${fmt$(meta.totalNetProfit)}`, 14, 43);
    doc.text(`Total Operaciones: ${result.trades.length}`, 14, 48);
    doc.text(`Generado: ${new Date().toLocaleDateString('es-ES')}`, 14, 53);

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
          fmt$(trade.profit),
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

    const fileName = `RevisionPropFirm_${meta.accountNumber}_${meta.period.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    doc.save(fileName);
  }, [result, verdict, tradeRuleMap, violatedTradeIndices]);

  // ─── Render ───

  // Module access guard — render nothing while the effect redirects.
  if (accessDenied) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            {t('risk.breadcrumb')}
          </p>
          <h1 className="text-2xl font-bold text-foreground">{t('risk.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('risk.subtitle')}</p>
        </div>
        <button
          onClick={() => setShowHistory(!showHistory)}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors flex-shrink-0',
            showHistory
              ? 'bg-[var(--color-primary)] text-white border-transparent'
              : 'border-border hover:bg-muted',
          )}
        >
          <FileSearch className="w-4 h-4" />
          Historial ({history.length})
        </button>
      </div>

      {/* Rule Config Panel */}
      <Card className="p-0 overflow-hidden">
        <button
          onClick={() => setConfigOpen(prev => !prev)}
          className="w-full flex items-center justify-between px-5 py-3 text-sm font-medium text-foreground hover:bg-muted/50 transition-colors"
        >
          <span className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            {t('risk.configRules')}
          </span>
          <ChevronDown className={cn('w-4 h-4 transition-transform', configOpen && 'rotate-180')} />
        </button>

        {configOpen && (
          <div className="border-t border-border px-5 py-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* R1: Consistencia */}
              <ConfigCard
                title={t('risk.r1Name')}
                enabled={config.consistencia.enabled}
                onToggle={(v) => setConfig(c => ({ ...c, consistencia: { ...c.consistencia, enabled: v } }))}
              >
                <ConfigInput label={t('risk.r1FactorMin')} value={config.consistencia.factorMin}
                  onChange={(v) => setConfig(c => ({ ...c, consistencia: { ...c.consistencia, factorMin: v } }))} step={0.05} />
                <ConfigInput label={t('risk.r1FactorMax')} value={config.consistencia.factorMax}
                  onChange={(v) => setConfig(c => ({ ...c, consistencia: { ...c.consistencia, factorMax: v } }))} step={0.1} />
              </ConfigCard>

              {/* R2: Profit % */}
              <ConfigCard
                title={t('risk.r2Name')}
                enabled={config.profitPct.enabled}
                onToggle={(v) => setConfig(c => ({ ...c, profitPct: { ...c.profitPct, enabled: v } }))}
              >
                <ConfigInput label={t('risk.r2Pct')} value={config.profitPct.pct}
                  onChange={(v) => setConfig(c => ({ ...c, profitPct: { ...c.profitPct, pct: v } }))} step={5} suffix="%" />
              </ConfigCard>

              {/* R3: Tiempo Min */}
              <ConfigCard
                title={t('risk.r3Name')}
                enabled={config.tiempoMin.enabled}
                onToggle={(v) => setConfig(c => ({ ...c, tiempoMin: { ...c.tiempoMin, enabled: v } }))}
              >
                <ConfigInput label={t('risk.r3Minutes')} value={config.tiempoMin.minutos}
                  onChange={(v) => setConfig(c => ({ ...c, tiempoMin: { ...c.tiempoMin, minutos: v } }))} step={1} suffix="min" />
              </ConfigCard>

              {/* R4: Grid */}
              <ConfigCard
                title={t('risk.r4Name')}
                enabled={config.grid.enabled}
                onToggle={(v) => setConfig(c => ({ ...c, grid: { ...c.grid, enabled: v } }))}
              >
                <ConfigInput label={t('risk.r4MinGrid')} value={config.grid.minGrid}
                  onChange={(v) => setConfig(c => ({ ...c, grid: { ...c.grid, minGrid: Math.max(2, Math.round(v)) } }))} step={1} />
              </ConfigCard>

              {/* R5: Martingala */}
              <ConfigCard
                title={t('risk.r5Name')}
                enabled={config.martingala.enabled}
                onToggle={(v) => setConfig(c => ({ ...c, martingala: { ...c.martingala, enabled: v } }))}
              >
                <ConfigInput label={t('risk.r5Gap')} value={config.martingala.gapMaximo}
                  onChange={(v) => setConfig(c => ({ ...c, martingala: { ...c.martingala, gapMaximo: v } }))} step={1} suffix="min" />
              </ConfigCard>
            </div>

            {/* Approval Limits */}
            <div className="mt-5 border-t border-border pt-4">
              <div className="flex items-center gap-2 mb-3">
                <Shield className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">{t('risk.approvalLimits')}</h3>
              </div>

              {/* Mode selector */}
              <div className="flex items-center gap-2 mb-4">
                {(['none', 'global', 'per-rule'] as ApprovalMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setApprovalLimits(prev => ({ ...prev, mode }))}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border',
                      approvalLimits.mode === mode
                        ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                        : 'bg-background text-muted-foreground border-border hover:bg-muted'
                    )}
                  >
                    {mode === 'none' && t('risk.modeNone')}
                    {mode === 'global' && t('risk.modeGlobal')}
                    {mode === 'per-rule' && t('risk.modePerRule')}
                  </button>
                ))}
              </div>

              {/* Global limit input */}
              {approvalLimits.mode === 'global' && (
                <div className="flex items-center gap-3 pl-1">
                  <span className="text-xs text-muted-foreground">{t('risk.globalMaxLabel')}</span>
                  <input
                    type="number"
                    min={0}
                    value={approvalLimits.globalMax}
                    onChange={(e) => setApprovalLimits(prev => ({ ...prev, globalMax: Math.max(0, parseInt(e.target.value) || 0) }))}
                    className="w-20 text-center text-xs bg-background border border-border rounded px-2 py-1"
                  />
                </div>
              )}

              {/* Per-rule limit inputs */}
              {approvalLimits.mode === 'per-rule' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {([
                    { key: 'consistencia' as const, label: t('risk.r1Name') },
                    { key: 'profitPct' as const, label: t('risk.r2Name') },
                    { key: 'tiempoMin' as const, label: t('risk.r3Name') },
                    { key: 'grid' as const, label: t('risk.r4Name') },
                    { key: 'martingala' as const, label: t('risk.r5Name') },
                  ]).map(({ key, label }) => (
                    <div key={key} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                      <span className="text-xs text-muted-foreground truncate">{label}</span>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min={0}
                          value={approvalLimits.perRule[key]}
                          onChange={(e) => setApprovalLimits(prev => ({
                            ...prev,
                            perRule: { ...prev.perRule, [key]: Math.max(0, parseInt(e.target.value) || 0) },
                          }))}
                          className="w-16 text-center text-xs bg-background border border-border rounded px-1.5 py-1"
                        />
                        <span className="text-[10px] text-muted-foreground">{t('risk.maxShort')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {result && (
              <div className="mt-4 flex justify-end">
                <button
                  onClick={reAnalyze}
                  className="px-4 py-2 bg-[var(--color-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  {t('risk.reanalyze')}
                </button>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* History Panel */}
      {showHistory && (
        <Card className="p-0 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h3 className="font-semibold flex items-center gap-2">
              <FileSearch className="w-4 h-4 text-[var(--color-primary)]" />
              Historial de Revisiones
              <span className="text-sm font-normal text-muted-foreground">({history.length} registros)</span>
            </h3>
            {history.length > 0 && (
              <button
                onClick={() => {
                  if (confirm('¿Eliminar todo el historial?')) {
                    setHistory([]);
                    localStorage.removeItem(HISTORY_KEY);
                  }
                }}
                className="text-xs text-red-500 hover:text-red-600 transition-colors"
              >
                Limpiar historial
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <p className="text-center text-muted-foreground py-8 text-sm">No hay revisiones guardadas aún</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-xs">
                    <th className="text-left px-4 py-3 font-medium">Fecha</th>
                    <th className="text-left px-3 py-3 font-medium">Trader</th>
                    <th className="text-left px-3 py-3 font-medium">Cuenta</th>
                    <th className="text-left px-3 py-3 font-medium">Período</th>
                    <th className="text-right px-3 py-3 font-medium">Operaciones</th>
                    <th className="text-right px-3 py-3 font-medium">Net Profit</th>
                    <th className="text-center px-3 py-3 font-medium">Veredicto</th>
                    <th className="text-left px-3 py-3 font-medium">Reglas</th>
                    <th className="text-center px-3 py-3 font-medium">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((rec) => (
                    <tr key={rec.id} className="border-b border-border/40 hover:bg-muted/20 text-xs">
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {new Date(rec.savedAt).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="px-3 py-3 font-medium">{rec.traderName || '—'}</td>
                      <td className="px-3 py-3 font-mono text-muted-foreground">{rec.accountNumber || '—'}</td>
                      <td className="px-3 py-3 text-muted-foreground">{rec.period || '—'}</td>
                      <td className="px-3 py-3 text-right">{rec.totalTrades}</td>
                      <td className={cn('px-3 py-3 text-right font-medium', rec.totalNetProfit >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                        {fmt$(rec.totalNetProfit)}
                      </td>
                      <td className="px-3 py-3 text-center">
                        {rec.verdict === 'approved' && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400">
                            <CheckCircle className="w-2.5 h-2.5" /> Aprobado
                          </span>
                        )}
                        {rec.verdict === 'rejected' && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-400">
                            <XCircle className="w-2.5 h-2.5" /> Rechazado
                          </span>
                        )}
                        {rec.verdict === null && (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex gap-1 flex-wrap">
                          {rec.rulesSummary.map((r) => (
                            <span key={r.ruleName} className={cn(
                              'px-1.5 py-0.5 rounded text-[9px] font-medium',
                              r.status === 'pass'
                                ? 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400'
                                : 'bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-400',
                            )}>
                              {r.displayName}: {r.violations}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => restoreFromHistory(rec)}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 hover:bg-blue-100 transition-colors"
                            title="Ver análisis"
                          >
                            <Eye className="w-3 h-3" />
                            Ver
                          </button>
                          <button
                            onClick={() => downloadPDFFromHistory(rec)}
                            disabled={historyLoading === rec.id}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 hover:bg-red-100 transition-colors disabled:opacity-50"
                            title="Descargar PDF"
                          >
                            {historyLoading === rec.id
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <FileText className="w-3 h-3" />}
                            PDF
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Upload Zone */}
      {!result && !loading && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            'border-2 border-dashed rounded-xl p-12 flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors',
            dragOver
              ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
              : 'border-border hover:border-muted-foreground/50'
          )}
        >
          <Upload className="w-10 h-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('risk.uploadTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('risk.uploadHint')}</p>
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
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--color-primary)]" />
          <p className="text-sm text-muted-foreground">{t('risk.analyzing')}</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <Card className="p-4 border-red-500/30 bg-red-500/5">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <XCircle className="w-5 h-5" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        </Card>
      )}

      {/* Results */}
      {result && (
        <>
          {/* File info + New upload button */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              <FileSpreadsheet className="w-4 h-4 inline mr-1" />
              {fileName}
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={downloadPDF}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
              >
                <FileText className="w-4 h-4" />
                Descargar PDF
              </button>
              <button
                onClick={() => { setResult(null); setError(null); setFileName(null); }}
                className="text-sm text-[var(--color-primary)] hover:underline"
              >
                {t('risk.newUpload')}
              </button>
            </div>
          </div>

          {/* Metadata Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetaCard label={t('risk.metaTrader')} value={result.metadata.traderName || '—'} />
            <MetaCard label={t('risk.metaAccount')} value={result.metadata.accountNumber || '—'} />
            <MetaCard label={t('risk.metaBroker')} value={result.metadata.broker || '—'} />
            <MetaCard label={t('risk.metaPeriod')} value={result.metadata.period || '—'} />
            <MetaCard label={t('risk.metaProfit')} value={fmt$(result.metadata.totalNetProfit)}
              valueClass={result.metadata.totalNetProfit >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'} />
            <MetaCard label={t('risk.metaTrades')} value={String(result.trades.length)} />
          </div>

          {/* Rule Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {result.ruleResults.map((rr) => (
              <Card key={rr.ruleName} className={cn('p-4 border', ruleStatusColor(rr.status))}>
                <div className="flex items-start justify-between mb-2">
                  <h3 className="text-sm font-semibold text-foreground">{rr.displayName}</h3>
                  {ruleStatusIcon(rr.status)}
                </div>
                {rr.isActive ? (
                  <>
                    <p className="text-2xl font-bold text-foreground">{rr.violations.length}</p>
                    <p className="text-xs text-muted-foreground">{t('risk.violations')} ({fmtPct(rr.violationPct)})</p>
                    {Object.entries(rr.computedParams).length > 0 && (
                      <div className="mt-2 space-y-0.5">
                        {Object.entries(rr.computedParams).map(([k, v]) => (
                          <p key={k} className="text-[10px] text-muted-foreground truncate">{k}: {v}</p>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground italic">{t('risk.skipped')}</p>
                )}
              </Card>
            ))}
          </div>

          {/* Verdict Banner */}
          {verdict && (
            <div className={cn(
              'rounded-xl p-4 flex items-center gap-3',
              verdict.status === 'pass'
                ? 'bg-green-500/10 border border-green-500/30'
                : 'bg-red-500/10 border border-red-500/30'
            )}>
              {verdict.status === 'pass'
                ? <CheckCircle className="w-6 h-6 text-green-500" />
                : <XCircle className="w-6 h-6 text-red-500" />}
              <div>
                <p className={cn('text-sm font-bold', verdict.status === 'pass' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>
                  {verdict.status === 'pass' ? t('risk.approved') : t('risk.rejected')}
                </p>
                <p className="text-xs text-muted-foreground">{verdict.msg}</p>
              </div>
            </div>
          )}

          {/* Violations Table */}
          {filteredViolations.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-orange-500" />
                  {t('risk.violationsTitle')} ({filteredViolations.length})
                </h2>
                <div className="flex items-center gap-2">
                  <Filter className="w-3.5 h-3.5 text-muted-foreground" />
                  <select
                    value={ruleFilter}
                    onChange={(e) => { setRuleFilter(e.target.value); setViolPage(0); }}
                    className="text-xs bg-background border border-border rounded px-2 py-1"
                  >
                    <option value="all">{t('risk.allRules')}</option>
                    {result.ruleResults.filter(r => r.isActive && r.violations.length > 0).map(rr => (
                      <option key={rr.ruleName} value={rr.ruleName}>{rr.displayName} ({rr.violations.length})</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Position</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Symbol</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Type</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Volume</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Profit</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t('risk.duration')}</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('risk.rulesViolated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {violPageItems.map((item, i) => (
                      <tr key={`${item.tradeIndex}-${i}`} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="px-3 py-2 font-mono">{item.trade?.position ?? '—'}</td>
                        <td className="px-3 py-2 font-medium">{item.trade?.symbol ?? '—'}</td>
                        <td className="px-3 py-2">
                          {item.trade ? (
                            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium uppercase',
                              item.trade.type === 'buy' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            )}>{item.trade.type}</span>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{item.trade?.volume ?? '—'}</td>
                        <td className={cn('px-3 py-2 text-right font-mono', (item.trade?.profit ?? 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>
                          {fmt$(item.trade?.profit ?? 0)}
                        </td>
                        <td className="px-3 py-2 text-right">{fmtDuration(item.trade?.durationMinutes ?? 0)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {item.rules.map((r, ri) => (
                              <span key={ri} className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-[10px] font-medium">
                                {r}
                              </span>
                            ))}
                          </div>
                          {item.details.length > 0 && (
                            <details className="mt-1">
                              <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
                                {t('risk.details')}
                              </summary>
                              <div className="mt-1 space-y-0.5">
                                {item.details.map((d, di) => (
                                  <p key={di} className="text-[10px] text-muted-foreground">{d}</p>
                                ))}
                              </div>
                            </details>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {violPageCount > 1 && (
                <div className="px-5 py-3 border-t border-border flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    {t('risk.page')} {violPage + 1} / {violPageCount}
                  </p>
                  <div className="flex gap-1">
                    <button onClick={() => setViolPage(p => Math.max(0, p - 1))} disabled={violPage === 0}
                      className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
                    <button onClick={() => setViolPage(p => Math.min(violPageCount - 1, p + 1))} disabled={violPage >= violPageCount - 1}
                      className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* Restored-from-history notice */}
          {result.trades.length === 0 && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 text-amber-700 text-sm">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>Este análisis fue restaurado del historial. Las operaciones individuales no están disponibles — sube el archivo original para verlas.</span>
            </div>
          )}

          {/* Full Operations Table */}
          <Card className="overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <FileSearch className="w-4 h-4" />
                {t('risk.operationsTitle')} ({opsData.length})
              </h2>
              <button
                onClick={() => { setShowAll(prev => !prev); setOpsPage(0); }}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {showAll ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                {showAll ? t('risk.showAll') : t('risk.showViolationsOnly')}
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">#</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Position</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Symbol</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Type</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Volume</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('risk.openTime')}</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('risk.closeTime')}</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t('risk.openPrice')}</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t('risk.closePrice')}</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Commission</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Swap</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Profit</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t('risk.duration')}</th>
                    <th className="px-3 py-2 text-center font-medium text-muted-foreground">{t('risk.flags')}</th>
                  </tr>
                </thead>
                <tbody>
                  {opsPageItems.map((trade) => {
                    const isViolated = violatedTradeIndices.has(trade.index);
                    const rules = tradeRuleMap.get(trade.index) || [];
                    return (
                      <tr key={trade.index} className={cn(
                        'border-b border-border/50',
                        isViolated ? 'bg-red-50/50 dark:bg-red-950/20' : 'hover:bg-muted/30'
                      )}>
                        <td className="px-3 py-2 text-muted-foreground">{trade.index + 1}</td>
                        <td className="px-3 py-2 font-mono">{trade.position}</td>
                        <td className="px-3 py-2 font-medium">{trade.symbol}</td>
                        <td className="px-3 py-2">
                          <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium uppercase',
                            trade.type === 'buy' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          )}>{trade.type}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{trade.volume}</td>
                        <td className="px-3 py-2 text-muted-foreground">{fmtDate(trade.openTime)}</td>
                        <td className="px-3 py-2 text-muted-foreground">{fmtDate(trade.closeTime)}</td>
                        <td className="px-3 py-2 text-right font-mono">{trade.openPrice}</td>
                        <td className="px-3 py-2 text-right font-mono">{trade.closePrice}</td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">{fmt$(trade.commission)}</td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">{fmt$(trade.swap)}</td>
                        <td className={cn('px-3 py-2 text-right font-mono', trade.profit >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>
                          {fmt$(trade.profit)}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{fmtDuration(trade.durationMinutes)}</td>
                        <td className="px-3 py-2 text-center">
                          {isViolated ? (
                            <div className="flex flex-wrap gap-0.5 justify-center">
                              {rules.map((r, i) => (
                                <span key={i} className="w-2 h-2 rounded-full bg-red-500" title={r} />
                              ))}
                            </div>
                          ) : (
                            <span className="text-green-500">✓</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {opsPageCount > 1 && (
              <div className="px-5 py-3 border-t border-border flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {t('risk.page')} {opsPage + 1} / {opsPageCount}
                </p>
                <div className="flex gap-1">
                  <button onClick={() => setOpsPage(p => Math.max(0, p - 1))} disabled={opsPage === 0}
                    className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
                  <button onClick={() => setOpsPage(p => Math.min(opsPageCount - 1, p + 1))} disabled={opsPage >= opsPageCount - 1}
                    className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}
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
    <div className={cn('rounded-lg border p-3 space-y-2 transition-colors', enabled ? 'border-border' : 'border-border/50 opacity-60')}>
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-foreground">{title}</h4>
        <label className="relative inline-flex items-center cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} className="sr-only peer" />
          <div className="w-8 h-4 bg-muted rounded-full peer peer-checked:bg-[var(--color-primary)] after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-4" />
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
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          step={step}
          className="w-16 text-right text-xs bg-background border border-border rounded px-1.5 py-1"
        />
        {suffix && <span className="text-[10px] text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

function MetaCard({ label, value, valueClass }: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <Card className="p-3">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={cn('text-sm font-semibold text-foreground mt-0.5 truncate', valueClass)}>{value}</p>
    </Card>
  );
}
