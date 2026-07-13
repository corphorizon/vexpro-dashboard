import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatNumber } from '@/lib/utils';

/** jspdf-autotable adds `lastAutoTable` to the doc but doesn't ship types for it. */
interface AutoTableDoc extends jsPDF {
  lastAutoTable?: { finalY?: number };
}

/** Get the Y position after the last autoTable, with a fallback. */
function getLastTableY(doc: jsPDF, fallback: number, gap = 8): number {
  return (doc as AutoTableDoc).lastAutoTable?.finalY
    ? (doc as AutoTableDoc).lastAutoTable!.finalY! + gap
    : fallback;
}

/** Format number for PDF — uses shared formatNumber from utils */
const fmt = formatNumber;
const money = (n: number) => `$${fmt(n)}`;

// ═══════════════════════════════════════════════════════════════════════════════
// Sistema de diseño compartido para PDFs — paleta del dashboard (globals.css)
//   primary #1E3A5F · accent #3B82F6 · positive #10B981 · negative #EF4444
// Da a todos los informes el mismo look que la app (navy + azul, tarjetas KPI
// blancas con acento lateral, encabezado con brandmark y stripe de acento).
// ═══════════════════════════════════════════════════════════════════════════════
type RGB = [number, number, number];
const C = {
  primary: [30, 58, 95] as RGB, // #1E3A5F
  accent: [59, 130, 246] as RGB, // #3B82F6
  ink: [15, 23, 42] as RGB, // #0F172A
  muted: [100, 116, 139] as RGB, // #64748B
  border: [226, 232, 240] as RGB, // #E2E8F0
  surface: [248, 250, 252] as RGB, // #F8FAFC
  positive: [5, 150, 105] as RGB, // #059669 (emerald-600, legible en papel)
  negative: [220, 38, 38] as RGB, // #DC2626
  warning: [217, 119, 6] as RGB, // #D97706
  white: [255, 255, 255] as RGB,
};

/** Encabezado con banda navy, brandmark y stripe de acento. Devuelve la Y libre. */
function pdfHeader(
  doc: jsPDF,
  opts: { title: string; company: string; right?: string[] },
): number {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(...C.primary);
  doc.rect(0, 0, w, 30, 'F');
  doc.setFillColor(...C.accent);
  doc.rect(0, 30, w, 1.4, 'F');

  // Brandmark: cuadro redondeado de acento con las iniciales de la empresa.
  const initials = opts.company
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .join('')
    .slice(0, 2)
    .toUpperCase();
  doc.setFillColor(...C.accent);
  doc.roundedRect(w - 14 - 13, 7, 13, 13, 2.5, 2.5, 'F');
  doc.setTextColor(...C.white);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(initials, w - 14 - 6.5, 15.6, { align: 'center' });

  doc.setTextColor(...C.white);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(opts.title, 14, 14);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(opts.company, 14, 22);

  if (opts.right?.length) {
    doc.setFontSize(8.5);
    opts.right.forEach((line, i) => {
      doc.text(line, w - 14 - 16, 12 + i * 5, { align: 'right' });
    });
  }
  return 40;
}

/** Título de sección: cuadrito de acento + label + regla fina. Devuelve Y libre. */
function pdfSection(doc: jsPDF, label: string, y: number, margin = 14): number {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(...C.accent);
  doc.roundedRect(margin, y - 3.2, 2.6, 4.2, 0.6, 0.6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...C.ink);
  doc.text(label, margin + 5, y);
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.3);
  doc.line(margin, y + 2.5, w - margin, y + 2.5);
  return y + 8;
}

interface KpiCard {
  label: string;
  value: string;
  tone?: 'ink' | 'positive' | 'negative' | 'accent' | 'primary';
}

/** Fila de tarjetas KPI: blancas, borde, barra de acento a la izquierda. */
function pdfCards(doc: jsPDF, y: number, cards: KpiCard[], margin = 14, h = 20): number {
  const w = doc.internal.pageSize.getWidth();
  const gap = 4;
  const cardW = (w - margin * 2 - gap * (cards.length - 1)) / cards.length;
  const toneColor = (t?: KpiCard['tone']): RGB =>
    t === 'positive' ? C.positive
      : t === 'negative' ? C.negative
      : t === 'accent' ? C.accent
      : t === 'primary' ? C.primary
      : C.ink;

  cards.forEach((c, i) => {
    const x = margin + i * (cardW + gap);
    doc.setFillColor(...C.white);
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, y, cardW, h, 2, 2, 'FD');
    // barra de acento lateral
    doc.setFillColor(...(c.tone && c.tone !== 'ink' ? toneColor(c.tone) : C.accent));
    doc.rect(x + 1, y + 2.4, 1.4, h - 4.8, 'F');
    // label
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(...C.muted);
    doc.text(c.label.toUpperCase(), x + 5, y + 7);
    // value
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(h >= 20 ? 12 : 10.5);
    doc.setTextColor(...toneColor(c.tone));
    doc.text(c.value, x + 5, y + h - 5.5);
  });
  return y + h + 6;
}

/** Pie de página con numeración y marca. */
function pdfFooter(doc: jsPDF, brand = 'Smart Dashboard') {
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    doc.line(14, h - 10, w - 14, h - 10);
    doc.setFontSize(7);
    doc.setTextColor(...C.muted);
    doc.setFont('helvetica', 'normal');
    doc.text(`Documento generado automaticamente — ${brand}`, 14, h - 5.5);
    if (pages > 1) {
      doc.text(`Pagina ${i} de ${pages}`, w - 14, h - 5.5, { align: 'right' });
    }
  }
}

interface PdfCommissionData {
  companyName: string;
  headName: string;
  headRole: string;
  headEmail: string;
  periodLabel: string;
  teamTotalND: number;
  autoSalary: number;
  salaryTierLabel: string;
  headOwnCalc: {
    netDepositCurrent: number;
    accumulatedIn: number;
    division: number;
    commissionPct: number;
    commission: number;
    realPayment: number;
    accumulatedOut: number;
  } | null;
  headDiff: { totalDifferential: number; totalRealPayment: number };
  teamSummary: { headOwnPayment: number; diffTotal: number; totalPayment: number; totalWithSalary: number; rawTotalWithSalary: number; prevDebt: number; debtOut: number };
  bdms: {
    name: string;
    email: string;
    pct: number;
    diffPct: number;
    nd: number;
    division: number;
    commission: number;
    realPayment: number;
    accOut: number;
    salary: number;
  }[];
}

export function generateCommissionPDF(data: PdfCommissionData) {
  const doc = new jsPDF('landscape', 'mm', 'a4');
  const pageWidth = doc.internal.pageSize.getWidth();

  // ─── Header ───
  doc.setFillColor(30, 41, 59); // slate-800
  doc.rect(0, 0, pageWidth, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('Informe de Comisiones', 14, 14);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(data.companyName, 14, 22);
  doc.text(data.periodLabel, pageWidth - 14, 14, { align: 'right' });
  doc.text(`Generado: ${new Date().toLocaleDateString()}`, pageWidth - 14, 22, { align: 'right' });

  // ─── HEAD Info ───
  doc.setTextColor(30, 41, 59);
  let y = 36;

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text(`${data.headName}`, 14, y);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text(`${data.headRole}  |  ${data.headEmail}`, 14, y + 5);

  // ─── Summary cards ───
  y += 14;
  const cardW = 62;
  const cardGap = 6;
  const cards = [
    { label: 'ND Total del Equipo', value: `$${fmt(data.teamTotalND)}` },
    { label: 'Salario Base (auto)', value: `$${fmt(data.autoSalary)}` },
    { label: 'Comision Propia', value: `$${fmt(data.headOwnCalc?.commission ?? 0)}` },
    { label: 'Total + Salario', value: `$${fmt(data.teamSummary.totalWithSalary)}` },
  ];

  cards.forEach((card, i) => {
    const x = 14 + i * (cardW + cardGap);
    doc.setFillColor(248, 250, 252); // slate-50
    doc.roundedRect(x, y, cardW, 18, 2, 2, 'F');
    doc.setDrawColor(226, 232, 240); // slate-200
    doc.roundedRect(x, y, cardW, 18, 2, 2, 'S');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.setFont('helvetica', 'normal');
    doc.text(card.label, x + 4, y + 6);
    doc.setFontSize(12);
    doc.setTextColor(30, 41, 59);
    doc.setFont('helvetica', 'bold');
    doc.text(card.value, x + 4, y + 14);
  });

  // ─── HEAD Own Commission Table ───
  y += 26;
  doc.setFontSize(11);
  doc.setTextColor(30, 41, 59);
  doc.setFont('helvetica', 'bold');
  doc.text('Comision Propia del HEAD', 14, y);
  y += 2;

  if (data.headOwnCalc) {
    autoTable(doc, {
      startY: y,
      head: [['ND Mes Actual', 'Acumulado', 'Division', '%', 'Comision', 'Pago Real', 'Acc → Sig.']],
      body: [[
        `$${fmt(data.headOwnCalc.netDepositCurrent)}`,
        `$${fmt(data.headOwnCalc.accumulatedIn)}`,
        `$${fmt(data.headOwnCalc.division)}`,
        `${data.headOwnCalc.commissionPct}%`,
        `$${fmt(data.headOwnCalc.commission)}`,
        `$${fmt(data.headOwnCalc.realPayment)}`,
        `$${fmt(data.headOwnCalc.accumulatedOut)}`,
      ]],
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2.5 },
      headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
      margin: { left: 14, right: 14 },
    });
  }

  // ─── BDM Table ───
  y = getLastTableY(doc, y + 20);
  doc.setFontSize(11);
  doc.setTextColor(30, 41, 59);
  doc.setFont('helvetica', 'bold');
  doc.text(`Miembros del Equipo (${data.bdms.length})`, 14, y);
  y += 2;

  autoTable(doc, {
    startY: y,
    head: [['Nombre', 'Email', '% Propio', '% Diff', 'ND Mes', 'Division', 'Comision', 'Pago Real', 'Acc → Sig.', 'Sueldo']],
    body: data.bdms.map(b => [
      b.name,
      b.email,
      `${b.pct}%`,
      `${b.diffPct}%`,
      `$${fmt(b.nd)}`,
      `$${fmt(b.division)}`,
      `$${fmt(b.commission)}`,
      `$${fmt(b.realPayment)}`,
      `$${fmt(b.accOut)}`,
      `$${fmt(b.salary)}`,
    ]),
    theme: 'striped',
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold', fontSize: 7 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { left: 14, right: 14 },
  });

  // ─── Totals Summary ───
  y = getLastTableY(doc, y + 20);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('Resumen de Pagos', 14, y);
  y += 2;

  const summaryRows: string[][] = [
    ['Comision propia del HEAD', `$${fmt(data.teamSummary.headOwnPayment)}`],
    ['Diferencial de BDMs', `$${fmt(data.teamSummary.diffTotal)}`],
    ['Total comisiones', `$${fmt(data.teamSummary.totalPayment)}`],
    ['Salario base', `$${fmt(data.autoSalary)}`],
  ];
  if (data.teamSummary.prevDebt < 0) {
    summaryRows.push(['Subtotal antes de deuda', `$${fmt(data.teamSummary.rawTotalWithSalary)}`]);
    summaryRows.push(['Deuda mes anterior', `$${fmt(data.teamSummary.prevDebt)}`]);
  }
  summaryRows.push(['TOTAL A PAGAR', `$${fmt(data.teamSummary.totalWithSalary)}`]);
  const totalRowIndex = summaryRows.length - 1;

  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Monto']],
    body: summaryRows,
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold' },
    bodyStyles: { textColor: [30, 41, 59] },
    didParseCell: (hookData) => {
      if (hookData.section === 'body' && hookData.row.index === totalRowIndex) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.fillColor = [234, 245, 255];
      }
      // Highlight debt row in amber
      if (hookData.section === 'body' && data.teamSummary.prevDebt < 0 && hookData.row.index === totalRowIndex - 1) {
        hookData.cell.styles.textColor = [180, 83, 9]; // amber-700
      }
    },
    columnStyles: { 0: { cellWidth: 80 }, 1: { halign: 'right' } },
    margin: { left: 14, right: 14 },
  });

  // ─── Footer ───
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    const pageH = doc.internal.pageSize.getHeight();
    doc.setFontSize(7);
    doc.setTextColor(160, 174, 192);
    doc.text(`Pagina ${i} de ${pageCount}`, pageWidth / 2, pageH - 6, { align: 'center' });
    doc.text('Documento generado automaticamente — Smart Dashboard', pageWidth / 2, pageH - 3, { align: 'center' });
  }

  // Save
  const fileName = `Comisiones_${data.headName.replace(/\s/g, '_')}_${data.periodLabel.replace(/\s/g, '_')}.pdf`;
  doc.save(fileName);
}

// ═══════════════════════════════════════════════════════════
// Individual BDM PDF
// ═══════════════════════════════════════════════════════════

interface PdfIndividualData {
  companyName: string;
  periodLabel: string;
  name: string;
  email: string;
  role: string;
  headName: string;
  pct: number;
  nd: number;
  accumulatedIn: number;
  division: number;
  commission: number;
  realPayment: number;
  accumulatedOut: number;
  salary: number;
  total: number;
}

export function generateIndividualPDF(data: PdfIndividualData) {
  const doc = new jsPDF('portrait', 'mm', 'a4');
  const pageWidth = doc.internal.pageSize.getWidth();

  // ─── Header ───
  doc.setFillColor(30, 41, 59);
  doc.rect(0, 0, pageWidth, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('Informe Individual de Comisiones', 14, 14);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(data.companyName, 14, 22);
  doc.text(data.periodLabel, pageWidth - 14, 14, { align: 'right' });
  doc.text(`Generado: ${new Date().toLocaleDateString()}`, pageWidth - 14, 22, { align: 'right' });

  // ─── Profile Info ───
  let y = 38;
  doc.setTextColor(30, 41, 59);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(data.name, 14, y);
  y += 6;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text(`${data.role}  |  ${data.email}  |  HEAD: ${data.headName}`, 14, y);

  // ─── Summary cards ───
  y += 12;
  const cardW = 55;
  const cardGap = 6;
  const cards = [
    { label: 'ND Mes Actual', value: `$${fmt(data.nd)}` },
    { label: 'Comision', value: `$${fmt(data.commission)}` },
    { label: 'Salario', value: `$${fmt(data.salary)}` },
  ];

  cards.forEach((card, i) => {
    const x = 14 + i * (cardW + cardGap);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(x, y, cardW, 20, 2, 2, 'F');
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(x, y, cardW, 20, 2, 2, 'S');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.setFont('helvetica', 'normal');
    doc.text(card.label, x + 4, y + 7);
    doc.setFontSize(13);
    doc.setTextColor(30, 41, 59);
    doc.setFont('helvetica', 'bold');
    doc.text(card.value, x + 4, y + 16);
  });

  // ─── Calculation detail table ───
  y += 30;
  doc.setFontSize(12);
  doc.setTextColor(30, 41, 59);
  doc.setFont('helvetica', 'bold');
  doc.text('Detalle del Calculo', 14, y);
  y += 3;

  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Valor']],
    body: [
      ['Porcentaje de comision', `${data.pct}%`],
      ['ND Mes Actual', `$${fmt(data.nd)}`],
      ['Acumulado del mes anterior', `$${fmt(data.accumulatedIn)}`],
      ['Division (ND / 2)', `$${fmt(data.division)}`],
      ['Comision ((Division + Acumulado) x %)', `$${fmt(data.commission)}`],
      ['Pago Real', `$${fmt(data.realPayment)}`],
      ['Acumulado → Siguiente mes', `$${fmt(data.accumulatedOut)}`],
    ],
    theme: 'striped',
    styles: { fontSize: 9.5, cellPadding: 4 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: { 0: { cellWidth: 100 }, 1: { halign: 'right', fontStyle: 'bold' } },
    margin: { left: 14, right: 14 },
  });

  // ─── Total box ───
  y = getLastTableY(doc, y + 60, 10);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Resumen de Pago', 14, y);
  y += 3;

  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Monto']],
    body: [
      ['Comision (Pago Real)', `$${fmt(data.realPayment)}`],
      ['Salario', `$${fmt(data.salary)}`],
      ['TOTAL A PAGAR', `$${fmt(data.total)}`],
    ],
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 4 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold' },
    bodyStyles: { textColor: [30, 41, 59] },
    didParseCell: (hookData) => {
      if (hookData.section === 'body' && hookData.row.index === 2) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.fillColor = [234, 245, 255];
      }
    },
    columnStyles: { 0: { cellWidth: 100 }, 1: { halign: 'right' } },
    margin: { left: 14, right: 14 },
  });

  // ─── Footer ───
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFontSize(7);
  doc.setTextColor(160, 174, 192);
  doc.text('Documento generado automaticamente — Smart Dashboard', pageWidth / 2, pageH - 4, { align: 'center' });

  // Save
  const fileName = `Comision_${data.name.replace(/\s/g, '_')}_${data.periodLabel.replace(/\s/g, '_')}.pdf`;
  doc.save(fileName);
}

// ═══════════════════════════════════════════════════════════════════════════════
// generatePnlPDF — Individual PnL commission report with lot commissions
// ═══════════════════════════════════════════════════════════════════════════════

interface PdfPnlData {
  companyName: string;
  periodLabel: string;
  name: string;
  email: string;
  role: string;
  headName: string;
  pct: number;
  pnl: number;
  accumulatedIn: number;
  division: number;
  commission: number;
  lotCommissions: number;
  realPayment: number;
  accumulatedOut: number;
  salary: number;
  total: number;
  /**
   * Modo de cálculo:
   *   - 'normal'  → reporte tradicional con División, Acumulado previo,
   *                 Acumulado→Siguiente (default).
   *   - 'special' → modo PnL Especial: commission = pnl × pct sin división
   *                 ni acumulado. El reporte oculta las 3 filas que no
   *                 aplican y cambia el label de la fórmula.
   */
  mode?: 'normal' | 'special';
}

export function generatePnlPDF(data: PdfPnlData) {
  const isSpecial = data.mode === 'special';
  const doc = new jsPDF('portrait', 'mm', 'a4');
  const pageWidth = doc.internal.pageSize.getWidth();

  // Header
  doc.setFillColor(30, 41, 59);
  doc.rect(0, 0, pageWidth, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(isSpecial ? 'Informe Individual de Comisiones - PnL Especial' : 'Informe Individual de Comisiones - PnL', 14, 14);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(data.companyName, 14, 22);
  doc.text(data.periodLabel, pageWidth - 14, 14, { align: 'right' });
  doc.text(`Generado: ${new Date().toLocaleDateString()}`, pageWidth - 14, 22, { align: 'right' });

  // Profile Info
  let y = 38;
  doc.setTextColor(30, 41, 59);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(data.name, 14, y);
  y += 6;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text(`${data.role}  |  ${data.email}  |  HEAD: ${data.headName}`, 14, y);

  // Summary cards
  y += 12;
  const cardW = 42;
  const cardGap = 4;
  const cards = [
    { label: 'PnL Mes Actual', value: `$${fmt(data.pnl)}` },
    { label: 'Comisión', value: `$${fmt(data.commission)}` },
    { label: 'Com. por Lotes', value: `$${fmt(data.lotCommissions)}` },
    { label: 'Pago Real', value: `$${fmt(data.realPayment)}` },
  ];
  cards.forEach((card, i) => {
    const x = 14 + i * (cardW + cardGap);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(x, y, cardW, 20, 2, 2, 'F');
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(x, y, cardW, 20, 2, 2, 'S');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.setFont('helvetica', 'normal');
    doc.text(card.label, x + 4, y + 7);
    doc.setFontSize(12);
    doc.setTextColor(30, 41, 59);
    doc.setFont('helvetica', 'bold');
    doc.text(card.value, x + 4, y + 16);
  });

  // Calculation detail
  y += 30;
  doc.setFontSize(12);
  doc.setTextColor(30, 41, 59);
  doc.setFont('helvetica', 'bold');
  doc.text('Detalle del Calculo', 14, y);
  y += 3;

  // Detalle del cálculo — en modo Especial se omiten las 3 filas que no
  // aplican (Acumulado previo, División, Acumulado siguiente) y se ajusta
  // el label de la comisión a la fórmula real del modo.
  const detailRows: string[][] = isSpecial
    ? [
        ['Porcentaje de comision', `${data.pct}%`],
        ['PnL Mes Actual', `$${fmt(data.pnl)}`],
        ['Comision (PnL x %)', `$${fmt(data.commission)}`],
        ['Comisiones ganadas por Lotes (descuento)', `-$${fmt(data.lotCommissions)}`],
        ['Pago Real (Comision - Com. Lotes)', `$${fmt(data.realPayment)}`],
      ]
    : [
        ['Porcentaje de comision', `${data.pct}%`],
        ['PnL Mes Actual', `$${fmt(data.pnl)}`],
        ['Acumulado del mes anterior', `$${fmt(data.accumulatedIn)}`],
        ['Division (PnL / 2)', `$${fmt(data.division)}`],
        ['Comision ((Division + Acumulado) x %)', `$${fmt(data.commission)}`],
        ['Comisiones ganadas por Lotes (descuento)', `-$${fmt(data.lotCommissions)}`],
        ['Pago Real (Comision - Com. Lotes)', `$${fmt(data.realPayment)}`],
        ['Acumulado -> Siguiente mes', `$${fmt(data.accumulatedOut)}`],
      ];

  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Valor']],
    body: detailRows,
    theme: 'striped',
    styles: { fontSize: 9.5, cellPadding: 4 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    didParseCell: (hookData) => {
      // Índices dependen del modo — en especial hay 3 filas menos.
      //   Normal : 0=pct 1=pnl 2=accIn 3=div 4=commission 5=lots 6=realPayment 7=accOut
      //   Special: 0=pct 1=pnl                 2=commission 3=lots 4=realPayment
      const lotsRowIdx = isSpecial ? 3 : 5;
      const realPaymentRowIdx = isSpecial ? 4 : 6;
      // Resaltar fila de descuento lotes en ámbar
      if (hookData.section === 'body' && hookData.row.index === lotsRowIdx) {
        hookData.cell.styles.textColor = [180, 83, 9];
      }
      // Resaltar Pago Real en verde/rojo
      if (hookData.section === 'body' && hookData.row.index === realPaymentRowIdx) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.textColor = data.realPayment >= 0 ? [0, 130, 0] : [180, 0, 0];
      }
    },
    columnStyles: { 0: { cellWidth: 110 }, 1: { halign: 'right', fontStyle: 'bold' } },
    margin: { left: 14, right: 14 },
  });

  // Resumen de pago
  y = getLastTableY(doc, y + 60, 10);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Resumen de Pago', 14, y);
  y += 3;

  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Monto']],
    body: [
      ['Comision bruta', `$${fmt(data.commission)}`],
      ['Comisiones por Lotes (descuento)', `-$${fmt(data.lotCommissions)}`],
      ['Pago Real (Comision - Lotes)', `$${fmt(data.realPayment)}`],
      ['Salario', `$${fmt(data.salary)}`],
      ['TOTAL A PAGAR', `$${fmt(data.total)}`],
    ],
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 4 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold' },
    didParseCell: (hookData) => {
      if (hookData.section === 'body' && hookData.row.index === 4) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.fillColor = [234, 245, 255];
      }
      if (hookData.section === 'body' && hookData.row.index === 1) {
        hookData.cell.styles.textColor = [180, 83, 9];
      }
    },
    columnStyles: { 0: { cellWidth: 110 }, 1: { halign: 'right' } },
    margin: { left: 14, right: 14 },
  });

  // Footer
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFontSize(7);
  doc.setTextColor(160, 174, 192);
  doc.text('Documento generado automaticamente — Smart Dashboard', pageWidth / 2, pageH - 4, { align: 'center' });

  const fileName = `${isSpecial ? 'ComisionPnLEspecial' : 'ComisionPnL'}_${data.name.replace(/\s/g, '_')}_${data.periodLabel.replace(/\s/g, '_')}.pdf`;
  doc.save(fileName);
}

// ═══════════════════════════════════════════════════════════
// Distribución a Socios — mes individual
// ═══════════════════════════════════════════════════════════

export interface PdfPartnerPeriodData {
  companyName: string;
  periodLabel: string;
  ingresosNetos: number;
  egresosNetos: number;
  reservaMes: number;
  deudaEntrada: number;
  montoDistribuir: number;
  partners: { name: string; pct: number; amount: number }[];
}

export function generatePartnerPeriodPDF(data: PdfPartnerPeriodData) {
  const doc = new jsPDF('portrait', 'mm', 'a4');

  let y = pdfHeader(doc, {
    title: 'Distribucion a Socios',
    company: data.companyName,
    right: [data.periodLabel, `Generado: ${new Date().toLocaleDateString()}`],
  });

  // ─── KPIs ───
  y = pdfCards(doc, y, [
    { label: 'Ingresos Netos', value: money(data.ingresosNetos), tone: 'positive' },
    { label: 'Egresos', value: money(data.egresosNetos), tone: 'negative' },
    { label: 'Reserva del Mes', value: money(data.reservaMes), tone: 'ink' },
    { label: 'Monto a Distribuir', value: money(data.montoDistribuir), tone: 'accent' },
  ]);

  // ─── Cascada del cálculo (cómo se llega al monto a distribuir) ───
  y = pdfSection(doc, 'Como se calcula', y + 2);
  const cascada: [string, number, boolean?][] = [
    ['Ingresos netos operativos', data.ingresosNetos],
    ['(-) Egresos del mes', -data.egresosNetos],
  ];
  if (data.deudaEntrada > 0) cascada.push(['(-) Deuda arrastrada del mes anterior', -data.deudaEntrada, true]);
  cascada.push(['(-) Reserva financiera del mes', -data.reservaMes]);
  autoTable(doc, {
    startY: y,
    body: cascada.map(([k, v]) => [k, money(v)]),
    foot: [['Monto a distribuir', money(data.montoDistribuir)]],
    theme: 'plain',
    styles: { fontSize: 9.5, cellPadding: 2.6, textColor: C.ink },
    footStyles: { fontStyle: 'bold', fillColor: C.surface, textColor: C.primary, fontSize: 10.5 },
    columnStyles: { 0: { cellWidth: 130 }, 1: { halign: 'right', fontStyle: 'bold' } },
    margin: { left: 14, right: 14 },
    didParseCell: (h) => {
      if (h.section === 'foot' && h.column.index === 1) h.cell.styles.halign = 'right';
      if (h.section === 'body' && h.column.index === 1) {
        const raw = cascada[h.row.index];
        h.cell.styles.textColor = raw[2] ? C.warning : raw[1] < 0 ? C.negative : C.positive;
      }
    },
  });
  y = getLastTableY(doc, y + 30, 10);

  // ─── Reparto por socio ───
  y = pdfSection(doc, 'Reparto por Socio', y);
  autoTable(doc, {
    startY: y,
    head: [['Socio', 'Participacion', 'Monto a recibir']],
    body: data.partners.map((p) => [
      p.name,
      `${(p.pct * 100).toFixed(1)}%`,
      money(p.amount),
    ]),
    foot: [[
      'Total',
      '100%',
      money(data.partners.reduce((s, p) => s + p.amount, 0)),
    ]],
    theme: 'striped',
    styles: { fontSize: 10, cellPadding: 3.2 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    footStyles: { fillColor: [234, 241, 250], textColor: C.primary, fontStyle: 'bold' },
    columnStyles: { 1: { halign: 'center' }, 2: { halign: 'right', fontStyle: 'bold', textColor: C.ink } },
    margin: { left: 14, right: 14 },
    didParseCell: (h) => {
      if (h.section === 'foot' && h.column.index === 1) h.cell.styles.halign = 'center';
      if (h.section === 'foot' && h.column.index === 2) h.cell.styles.halign = 'right';
    },
  });

  pdfFooter(doc);
  doc.save(`Distribucion_Socios_${data.periodLabel.replace(/\s/g, '_')}.pdf`);
}

// ═══════════════════════════════════════════════════════════
// Historial de Distribuciones — todos los meses
// ═══════════════════════════════════════════════════════════

export interface PdfPartnerHistoryData {
  companyName: string;
  partnerNames: string[];
  rows: { periodLabel: string; amounts: number[]; total: number }[];
  partnerTotals: number[];
  grandTotal: number;
}

export function generatePartnerHistoryPDF(data: PdfPartnerHistoryData) {
  const doc = new jsPDF('landscape', 'mm', 'a4');

  let y = pdfHeader(doc, {
    title: 'Historial de Distribuciones',
    company: data.companyName,
    right: [`Generado: ${new Date().toLocaleDateString()}`],
  });

  // ─── KPIs resumen ───
  const topPartnerIdx = data.partnerTotals.reduce((best, v, i, a) => (v > a[best] ? i : best), 0);
  y = pdfCards(doc, y, [
    { label: 'Meses distribuidos', value: String(data.rows.length), tone: 'primary' },
    { label: 'Total repartido', value: money(data.grandTotal), tone: 'accent' },
    { label: 'Promedio mensual', value: money(data.rows.length ? data.grandTotal / data.rows.length : 0), tone: 'ink' },
    { label: `Mayor socio (${data.partnerNames[topPartnerIdx] ?? '—'})`, value: money(data.partnerTotals[topPartnerIdx] ?? 0), tone: 'positive' },
  ]);

  y = pdfSection(doc, 'Reparto mensual por socio', y + 2);
  autoTable(doc, {
    startY: y,
    head: [['Periodo', ...data.partnerNames, 'Total']],
    body: data.rows.map((r) => [
      r.periodLabel,
      ...r.amounts.map((a) => money(a)),
      money(r.total),
    ]),
    foot: [[
      'Total',
      ...data.partnerTotals.map((a) => money(a)),
      money(data.grandTotal),
    ]],
    theme: 'striped',
    styles: { fontSize: 9, cellPadding: 2.6 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    footStyles: { fillColor: [234, 241, 250], textColor: C.primary, fontStyle: 'bold' },
    columnStyles: {
      ...Object.fromEntries(data.partnerNames.map((_, i) => [i + 1, { halign: 'right' as const }])),
      [data.partnerNames.length + 1]: { halign: 'right' as const, fontStyle: 'bold' as const, textColor: C.ink },
    },
    margin: { left: 14, right: 14 },
    didParseCell: (h) => {
      if (h.section === 'foot' && h.column.index > 0) h.cell.styles.halign = 'right';
    },
  });

  pdfFooter(doc);
  doc.save('Historial_Distribuciones.pdf');
}

// ═══════════════════════════════════════════════════════════
// Informe de Cierre Mensual — resumen ejecutivo del mes
//   (ingresos, egresos, resultado, flujo de depósitos/retiros, distribución)
// ═══════════════════════════════════════════════════════════

export interface PdfMonthlyCloseData {
  companyName: string;
  periodLabel: string;
  // Resultado operativo
  brokerPnl: number;
  propFirmNet: number;
  investmentProfits: number;
  otherIncome: number;
  ingresosNetos: number;
  egresosTotal: number;
  egresosPagados: number;
  egresosPendientes: number;
  saldo: number;
  reservaMes: number;
  reservaAcumulada: number;
  deudaEntrada: number;
  montoDistribuir: number;
  // Flujo de caja de clientes
  depositsByChannel: { label: string; amount: number }[];
  depositsTotal: number;
  withdrawalsByCategory: { label: string; amount: number }[];
  withdrawalsTotal: number;
  netFlow: number;
  // Detalle
  topExpenses: { concept: string; amount: number }[];
  partners: { name: string; pct: number; amount: number }[];
}

export function generateMonthlyClosePDF(data: PdfMonthlyCloseData) {
  const doc = new jsPDF('portrait', 'mm', 'a4');

  let y = pdfHeader(doc, {
    title: 'Informe de Cierre Mensual',
    company: data.companyName,
    right: [data.periodLabel, `Generado: ${new Date().toLocaleDateString()}`],
  });

  // ─── KPIs principales ───
  y = pdfCards(doc, y, [
    { label: 'Ingresos Netos', value: money(data.ingresosNetos), tone: 'positive' },
    { label: 'Egresos', value: money(data.egresosTotal), tone: 'negative' },
    { label: 'Resultado del Mes', value: money(data.saldo), tone: data.saldo >= 0 ? 'positive' : 'negative' },
    { label: 'A Distribuir', value: money(data.montoDistribuir), tone: 'accent' },
  ]);

  // ─── Resultado operativo ───
  y = pdfSection(doc, 'Resultado Operativo', y + 2);
  const opRows: [string, number][] = [
    ['Broker P&L (Book B)', data.brokerPnl],
    ['Prop Firm (neto)', data.propFirmNet],
    ['Ganancias de inversiones', data.investmentProfits],
  ];
  if (data.otherIncome) opRows.push(['Otros ingresos', data.otherIncome]);
  autoTable(doc, {
    startY: y,
    body: opRows.map(([k, v]) => [k, money(v)]),
    foot: [
      ['Ingresos netos operativos', money(data.ingresosNetos)],
      ['Egresos del mes', money(-data.egresosTotal)],
      ['Resultado (saldo)', money(data.saldo)],
    ],
    theme: 'plain',
    styles: { fontSize: 9.5, cellPadding: 2.4, textColor: C.ink },
    footStyles: { fontStyle: 'bold', fillColor: C.surface, textColor: C.primary },
    columnStyles: { 0: { cellWidth: 130 }, 1: { halign: 'right', fontStyle: 'bold', textColor: C.positive } },
    margin: { left: 14, right: 14 },
    didParseCell: (h) => {
      if (h.section === 'foot' && h.column.index === 1) {
        h.cell.styles.halign = 'right';
        if (h.row.index === 1) h.cell.styles.textColor = C.negative;
        if (h.row.index === 2) h.cell.styles.textColor = data.saldo >= 0 ? C.positive : C.negative;
      }
    },
  });
  y = getLastTableY(doc, y + 40, 8);

  // ─── Flujo de depósitos y retiros (clientes) ───
  y = pdfSection(doc, 'Flujo de Depositos y Retiros de Clientes', y);
  const maxRows = Math.max(data.depositsByChannel.length, data.withdrawalsByCategory.length);
  const flowBody: string[][] = [];
  for (let i = 0; i < maxRows; i++) {
    const d = data.depositsByChannel[i];
    const w = data.withdrawalsByCategory[i];
    flowBody.push([
      d ? d.label : '', d ? money(d.amount) : '',
      w ? w.label : '', w ? money(w.amount) : '',
    ]);
  }
  autoTable(doc, {
    startY: y,
    head: [['Depositos por canal', 'Monto', 'Retiros por categoria', 'Monto']],
    body: flowBody,
    foot: [['Total depositos', money(data.depositsTotal), 'Total retiros', money(data.withdrawalsTotal)]],
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 2.6 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
    footStyles: { fillColor: C.surface, textColor: C.primary, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 52 }, 1: { halign: 'right', textColor: C.positive },
      2: { cellWidth: 52 }, 3: { halign: 'right', textColor: C.negative },
    },
    margin: { left: 14, right: 14 },
    didParseCell: (h) => {
      if (h.section === 'foot' && (h.column.index === 1 || h.column.index === 3)) h.cell.styles.halign = 'right';
    },
  });
  y = getLastTableY(doc, y + 30, 5);
  // Banda de flujo neto
  doc.setFillColor(...C.surface);
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.3);
  const wPage = doc.internal.pageSize.getWidth();
  doc.roundedRect(14, y, wPage - 28, 11, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(...C.ink);
  doc.text('Flujo neto de clientes (depositos - retiros)', 18, y + 7);
  doc.setTextColor(...(data.netFlow >= 0 ? C.positive : C.negative));
  doc.setFontSize(11);
  doc.text(money(data.netFlow), wPage - 18, y + 7.2, { align: 'right' });
  y += 17;

  // ─── Página 2: egresos + distribución ───
  doc.addPage();
  y = pdfHeader(doc, {
    title: 'Informe de Cierre Mensual',
    company: data.companyName,
    right: [data.periodLabel, `Generado: ${new Date().toLocaleDateString()}`],
  });

  y = pdfCards(doc, y, [
    { label: 'Egresos pagados', value: money(data.egresosPagados), tone: 'positive' },
    { label: 'Egresos pendientes', value: money(data.egresosPendientes), tone: data.egresosPendientes > 0 ? 'negative' : 'ink' },
    { label: 'Reserva del mes', value: money(data.reservaMes), tone: 'ink' },
    { label: 'Reserva acumulada', value: money(data.reservaAcumulada), tone: 'primary' },
  ], 14, 18);

  y = pdfSection(doc, 'Principales Egresos', y + 2);
  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Monto']],
    body: data.topExpenses.map((e) => [e.concept, money(e.amount)]),
    foot: [['Total egresos del mes', money(data.egresosTotal)]],
    theme: 'striped',
    styles: { fontSize: 9, cellPadding: 2.8 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    footStyles: { fillColor: [234, 241, 250], textColor: C.primary, fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 130 }, 1: { halign: 'right', fontStyle: 'bold', textColor: C.negative } },
    margin: { left: 14, right: 14 },
    didParseCell: (h) => {
      if (h.section === 'foot' && h.column.index === 1) h.cell.styles.halign = 'right';
    },
  });
  y = getLastTableY(doc, y + 40, 8);

  y = pdfSection(doc, 'Distribucion a Socios', y);
  if (data.deudaEntrada > 0) {
    doc.setFontSize(8);
    doc.setTextColor(...C.warning);
    doc.setFont('helvetica', 'normal');
    doc.text(`Deuda arrastrada del mes anterior descontada: ${money(data.deudaEntrada)}`, 14, y);
    y += 5;
  }
  autoTable(doc, {
    startY: y,
    head: [['Socio', 'Participacion', 'Monto a recibir']],
    body: data.partners.map((p) => [p.name, `${(p.pct * 100).toFixed(1)}%`, money(p.amount)]),
    foot: [['Total distribuido', '100%', money(data.montoDistribuir)]],
    theme: 'striped',
    styles: { fontSize: 10, cellPadding: 3.2 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    footStyles: { fillColor: [234, 241, 250], textColor: C.primary, fontStyle: 'bold' },
    columnStyles: { 1: { halign: 'center' }, 2: { halign: 'right', fontStyle: 'bold', textColor: C.ink } },
    margin: { left: 14, right: 14 },
    didParseCell: (h) => {
      if (h.section === 'foot' && h.column.index === 1) h.cell.styles.halign = 'center';
      if (h.section === 'foot' && h.column.index === 2) h.cell.styles.halign = 'right';
    },
  });

  pdfFooter(doc);
  doc.save(`Cierre_Mensual_${data.periodLabel.replace(/\s/g, '_')}.pdf`);
}
