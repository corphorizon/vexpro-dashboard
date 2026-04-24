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
