// ─────────────────────────────────────────────────────────────────────────────
// Report PDF generator (client-side).
//
// Uses jsPDF + jspdf-autotable to build a real multi-page PDF with:
//   · Cover page (company logo or name, title, period, generation date)
//   · One section per module, each with a branded header bar in the company's
//     primary colour, KPI strip, and data tables with alternating row colours
//   · Footer on every page: "<company> · Smart Dashboard · página N/M · Documento confidencial"
//
// The caller only talks to `downloadReportPDF(params)`; the rendering happens
// locally in the browser (no server round-trip, no print dialog like the
// legacy HTML-based export).
// ─────────────────────────────────────────────────────────────────────────────

import type { ReportData, ReportBucket, ReportDepositRow, ReportWithdrawalRow } from './data';
import type { ReportCadence } from './email-template';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface ReportSectionToggles {
  deposits_withdrawals: boolean;
  balances_by_channel: boolean;
  crm_users: boolean;
  broker_pnl: boolean;
  prop_trading: boolean;
}

export interface DownloadReportPdfParams {
  data: ReportData;
  cadence: ReportCadence;
  companyName: string;
  /** Optional company logo — must be a data URL (png/jpeg) to embed cleanly.
   *  External URLs aren't fetched here; the caller is expected to pre-convert. */
  companyLogoDataUrl?: string | null;
  /** Hex colour (`#rrggbb` / `#rgb`) — defaults to #1E3A5F if missing or bad. */
  primaryColor?: string | null;
  sections?: ReportSectionToggles;
  /** When omitted, derived from company/range. */
  fileName?: string;
}

const CHANNEL_LABEL: Record<string, string> = {
  coinsbuy: 'Coinsbuy',
  fairpay: 'FairPay',
  unipayment: 'UniPayment',
  other: 'Otros',
};
const CATEGORY_LABEL: Record<string, string> = {
  ib_commissions: 'Comisiones IB',
  broker: 'Broker',
  prop_firm: 'Prop Firm',
  other: 'Otros',
  p2p: 'P2P Transfer',
  coinsbuy_api: 'Coinsbuy (API)',
};
const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtDateEs(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS_ES[m - 1]} ${y}`;
}

function hexToRgb(hex: string | null | undefined): [number, number, number] {
  const fallback: [number, number, number] = [30, 58, 95]; // #1E3A5F
  if (!hex) return fallback;
  const s = hex.trim();
  let h = s.startsWith('#') ? s.slice(1) : s;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return fallback;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function titleForCadence(cadence: ReportCadence): string {
  if (cadence === 'daily') return 'Reporte Financiero Diario';
  if (cadence === 'weekly') return 'Reporte Financiero Semanal';
  return 'Reporte Financiero Mensual';
}

function pctVariation(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function fmtPct(pct: number | null): string {
  if (pct === null || !isFinite(pct)) return '—';
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

// ─── Main ─────────────────────────────────────────────────────────────────

export function downloadReportPDF(params: DownloadReportPdfParams): void {
  const {
    data,
    cadence,
    companyName,
    companyLogoDataUrl,
    primaryColor,
    sections = {
      deposits_withdrawals: true,
      balances_by_channel: true,
      crm_users: true,
      broker_pnl: true,
      prop_trading: true,
    },
  } = params;

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const MARGIN_X = 40;
  const primary = hexToRgb(primaryColor);

  // ─── Cover page ───
  drawCoverPage(doc, {
    companyName,
    companyLogoDataUrl,
    title: titleForCadence(cadence),
    range: data.range,
    primary,
  });

  // ─── Sections ───
  let cursorY = pageHeight + 1; // force new page for first section

  const addSectionHeader = (label: string) => {
    // If we're about to overflow or this is the first section (cursorY > page),
    // start a new page. Leave ~40pt above to not cramp.
    if (cursorY > pageHeight - 120) {
      doc.addPage();
      cursorY = 60;
    }
    // Coloured bar with white label
    doc.setFillColor(primary[0], primary[1], primary[2]);
    doc.roundedRect(MARGIN_X, cursorY, pageWidth - MARGIN_X * 2, 28, 4, 4, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text(label, MARGIN_X + 12, cursorY + 18);
    cursorY += 40;
  };

  const addSubHeader = (label: string) => {
    doc.setTextColor(51, 65, 85); // slate-700
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text(label, MARGIN_X, cursorY);
    cursorY += 14;
  };

  const addKpiRow = (kpis: Array<{ label: string; value: string; tone?: 'ok' | 'bad' | 'neutral' }>) => {
    const boxW = (pageWidth - MARGIN_X * 2 - 12 * (kpis.length - 1)) / kpis.length;
    const boxH = 54;
    kpis.forEach((k, i) => {
      const x = MARGIN_X + i * (boxW + 12);
      doc.setFillColor(248, 250, 252); // slate-50
      doc.setDrawColor(226, 232, 240); // slate-200
      doc.roundedRect(x, cursorY, boxW, boxH, 4, 4, 'FD');
      doc.setTextColor(100, 116, 139); // slate-500
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.text(k.label.toUpperCase(), x + 10, cursorY + 16);
      if (k.tone === 'ok') doc.setTextColor(16, 185, 129); // emerald-500
      else if (k.tone === 'bad') doc.setTextColor(239, 68, 68); // red-500
      else doc.setTextColor(15, 23, 42); // slate-900
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text(k.value, x + 10, cursorY + 38);
    });
    cursorY += boxH + 18;
  };

  const renderAutoTable = (
    head: string[][],
    body: (string | number)[][],
    foot?: string[][],
  ) => {
    autoTable(doc, {
      startY: cursorY,
      margin: { left: MARGIN_X, right: MARGIN_X },
      head,
      body,
      foot,
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 5, textColor: [51, 65, 85] },
      headStyles: { fillColor: primary, textColor: [255, 255, 255], fontStyle: 'bold', halign: 'left' },
      bodyStyles: { lineColor: [226, 232, 240] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      footStyles: { fillColor: [241, 245, 249], textColor: [30, 41, 59], fontStyle: 'bold' },
      didDrawPage: () => {
        // Draw footer on every page that the table paints onto — the main
        // loop below also draws on final pages, but it's idempotent.
      },
    });
    // autotable updates the Y position via the singleton on the doc.
    const newY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY;
    cursorY = (newY ?? cursorY) + 18;
  };

  // ─── Section: Depósitos y Retiros ───
  if (sections.deposits_withdrawals) {
    addSectionHeader('Depósitos y Retiros');
    const d = data.deposits_withdrawals;
    const monthVsPrev = pctVariation(d.month.net_deposit, d.prev_month.net_deposit);
    addKpiRow([
      {
        label: 'Net Deposit del rango',
        value: fmtCurrency(d.range.net_deposit),
        tone: d.range.net_deposit >= 0 ? 'ok' : 'bad',
      },
      {
        label: 'Net Deposit del mes',
        value: fmtCurrency(d.month.net_deposit),
        tone: d.month.net_deposit >= 0 ? 'ok' : 'bad',
      },
      {
        label: 'Variación vs mes ant.',
        value: fmtPct(monthVsPrev),
        tone: monthVsPrev === null ? 'neutral' : monthVsPrev >= 0 ? 'ok' : 'bad',
      },
    ]);

    addSubHeader('Depósitos por canal');
    renderBucket(renderAutoTable, d.range.deposits, 'deposits', d.range.total_deposits);

    addSubHeader('Retiros por categoría');
    renderBucket(renderAutoTable, d.range.withdrawals, 'withdrawals', d.range.total_withdrawals);
  }

  // ─── Section: Balances por Canal ───
  if (sections.balances_by_channel) {
    addSectionHeader('Balances por Canal');
    const b = data.balances_by_channel;
    if (b.channels.length === 0) {
      doc.setTextColor(100, 116, 139);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'italic');
      doc.text('No hay canales visibles configurados.', MARGIN_X, cursorY);
      cursorY += 24;
    } else {
      renderAutoTable(
        [['Canal', 'Tipo', 'Balance']],
        b.channels.map((c) => [
          c.label,
          c.type === 'auto' ? 'Automático' : c.type === 'api' ? 'API' : 'Manual',
          fmtCurrency(c.amount),
        ]),
        [['Total Consolidado', '', fmtCurrency(b.total)]],
      );
    }
  }

  // ─── Section: Usuarios CRM ───
  if (sections.crm_users && (data.crm_users.connected || data.crm_users.isMock)) {
    addSectionHeader('Usuarios CRM');
    addKpiRow([
      { label: 'Nuevos en el rango', value: data.crm_users.new_users_in_range.toLocaleString('es') },
      { label: 'Nuevos este mes', value: data.crm_users.new_users_this_month.toLocaleString('es') },
      { label: 'Total en plataforma', value: data.crm_users.total_users.toLocaleString('es') },
    ]);
  }

  // ─── Section: Broker P&L ───
  if (sections.broker_pnl && (data.broker_pnl.connected || data.broker_pnl.isMock)) {
    addSectionHeader('Broker P&L');
    const p = data.broker_pnl;
    const monthVsPrev = pctVariation(p.pnl_month, p.pnl_prev_month);
    addKpiRow([
      { label: 'P&L del rango', value: fmtCurrency(p.pnl_range), tone: p.pnl_range >= 0 ? 'ok' : 'bad' },
      { label: 'P&L del mes', value: fmtCurrency(p.pnl_month), tone: p.pnl_month >= 0 ? 'ok' : 'bad' },
      {
        label: 'Variación vs mes ant.',
        value: fmtPct(monthVsPrev),
        tone: monthVsPrev === null ? 'neutral' : monthVsPrev >= 0 ? 'ok' : 'bad',
      },
    ]);
  }

  // ─── Section: Prop Trading ───
  if (sections.prop_trading && (data.prop_trading.connected || data.prop_trading.isMock)) {
    addSectionHeader('Prop Trading Firm');
    const p = data.prop_trading;
    addKpiRow([
      { label: 'Ventas del rango', value: fmtCurrency(p.total_sales_range) },
      { label: 'Retiros Prop Firm', value: fmtCurrency(p.prop_withdrawals_range) },
      { label: 'P&L del rango', value: fmtCurrency(p.pnl_range), tone: p.pnl_range >= 0 ? 'ok' : 'bad' },
    ]);

    if (p.products.length > 0) {
      addSubHeader('Productos vendidos');
      renderAutoTable(
        [['Producto', 'Cantidad', 'Monto']],
        p.products.map((prod) => [prod.name, String(prod.quantity), fmtCurrency(prod.amount)]),
        [['Total', '', fmtCurrency(p.total_sales_range)]],
      );
    }
  }

  // ─── Footer on every page ───
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    drawFooter(doc, { pageNum: i, totalPages, companyName, primary });
  }

  // ─── Download ───
  const fileName =
    params.fileName ??
    `reporte_${companyName.replace(/\s+/g, '_')}_${data.range.from}_${data.range.to}.pdf`;
  doc.save(fileName);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function renderBucket(
  renderAutoTable: (head: string[][], body: (string | number)[][], foot?: string[][]) => void,
  rows: ReportDepositRow[] | ReportWithdrawalRow[],
  kind: 'deposits' | 'withdrawals',
  total: number,
): void {
  if (rows.length === 0) {
    renderAutoTable(
      [[kind === 'deposits' ? 'Canal' : 'Categoría', '#', 'Monto']],
      [['Sin datos en el período', '', '']],
    );
    return;
  }
  const sorted = [...rows].sort((a, b) => b.amount - a.amount);
  const body = sorted.map((r) => {
    if (kind === 'deposits') {
      const row = r as ReportDepositRow;
      return [CHANNEL_LABEL[row.channel] ?? row.channel, String(row.count), fmtCurrency(row.amount)];
    }
    const row = r as ReportWithdrawalRow;
    return [CATEGORY_LABEL[row.category] ?? row.category, String(row.count), fmtCurrency(row.amount)];
  });
  renderAutoTable(
    [[kind === 'deposits' ? 'Canal' : 'Categoría', '#', 'Monto']],
    body,
    [['Total', '', fmtCurrency(total)]],
  );
}

interface CoverParams {
  companyName: string;
  companyLogoDataUrl?: string | null;
  title: string;
  range: { from: string; to: string };
  primary: [number, number, number];
}

function drawCoverPage(doc: jsPDF, p: CoverParams): void {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const centerX = pageWidth / 2;

  // Thin top accent bar.
  doc.setFillColor(p.primary[0], p.primary[1], p.primary[2]);
  doc.rect(0, 0, pageWidth, 10, 'F');

  // Company logo or name — centred vertically in top third.
  const logoTop = 130;
  if (p.companyLogoDataUrl) {
    try {
      // jsPDF wants the image to be reasonably sized; 140x80 works well for logos.
      doc.addImage(p.companyLogoDataUrl, 'PNG', centerX - 70, logoTop, 140, 80, undefined, 'FAST');
    } catch {
      // fallthrough to text
      doc.setTextColor(p.primary[0], p.primary[1], p.primary[2]);
      doc.setFontSize(28);
      doc.setFont('helvetica', 'bold');
      doc.text(p.companyName, centerX, logoTop + 40, { align: 'center' });
    }
  } else {
    doc.setTextColor(p.primary[0], p.primary[1], p.primary[2]);
    doc.setFontSize(28);
    doc.setFont('helvetica', 'bold');
    doc.text(p.companyName, centerX, logoTop + 40, { align: 'center' });
  }

  // Title.
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text(p.title, centerX, logoTop + 160, { align: 'center' });

  // Divider.
  doc.setDrawColor(p.primary[0], p.primary[1], p.primary[2]);
  doc.setLineWidth(2);
  doc.line(centerX - 80, logoTop + 180, centerX + 80, logoTop + 180);

  // Period.
  doc.setTextColor(71, 85, 105);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `Período: ${fmtDateEs(p.range.from)} — ${fmtDateEs(p.range.to)}`,
    centerX,
    logoTop + 210,
    { align: 'center' },
  );

  // Generated on.
  doc.setTextColor(100, 116, 139);
  doc.setFontSize(10);
  const now = new Date();
  doc.text(
    `Generado: ${now.toLocaleDateString('es')} ${now.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`,
    centerX,
    logoTop + 232,
    { align: 'center' },
  );

  // Footer note on cover.
  doc.setTextColor(148, 163, 184);
  doc.setFontSize(9);
  doc.text('Smart Dashboard', centerX, pageHeight - 40, { align: 'center' });
  doc.text('Documento confidencial', centerX, pageHeight - 26, { align: 'center' });
}

interface FooterParams {
  pageNum: number;
  totalPages: number;
  companyName: string;
  primary: [number, number, number];
}

function drawFooter(doc: jsPDF, p: FooterParams): void {
  // Cover page already has its own footer; skip it.
  if (p.pageNum === 1) return;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const MARGIN_X = 40;

  // Divider line.
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.5);
  doc.line(MARGIN_X, pageHeight - 40, pageWidth - MARGIN_X, pageHeight - 40);

  doc.setTextColor(100, 116, 139);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text(`${p.companyName} · Smart Dashboard`, MARGIN_X, pageHeight - 26);
  doc.text('Documento confidencial', pageWidth / 2, pageHeight - 26, { align: 'center' });
  doc.text(`Página ${p.pageNum} de ${p.totalPages}`, pageWidth - MARGIN_X, pageHeight - 26, {
    align: 'right',
  });
}

// Keep the ReportBucket import marked as used (consumed in the closure below
// via ReportDepositRow/ReportWithdrawalRow types that come from the same module).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _KeepBucketImport = ReportBucket;
