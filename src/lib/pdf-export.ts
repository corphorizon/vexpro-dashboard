import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatNumber } from '@/lib/utils';
import { BRAND_RGB, type RGB } from '@/lib/brand';

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
// La paleta vive en src/lib/brand.ts (origen único). Antes estos hex estaban
// duplicados acá y en globals.css, email-template.ts y reports/pdf.ts.
const C = BRAND_RGB;

/** Encabezado con banda navy, brandmark y stripe de acento. Devuelve la Y libre. */
// ─────────────────────────────────────────────────────────────────────────────
// Logo de la empresa para el encabezado.
//
// El bucket `company-logos` es público, así que alcanza con un fetch. Se
// convierte a data URL porque jsPDF no acepta una URL remota en addImage.
//
// Devuelve null ante cualquier problema (404, CORS, SVG) — el encabezado cae
// a las iniciales y el PDF se genera igual. Un logo roto nunca puede impedir
// que salga un documento.
//
// jsPDF NO digiere SVG: si el logo de la empresa es .svg se descarta y se
// usan las iniciales.
// ─────────────────────────────────────────────────────────────────────────────
export async function loadLogoDataUrl(url?: string | null): Promise<string | null> {
  if (!url) return null;
  if (/\.svg($|\?)/i.test(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(blob.type)) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function pdfHeader(
  doc: jsPDF,
  opts: { title: string; company: string; right?: string[]; logoDataUrl?: string | null },
): number {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(...C.primary);
  doc.rect(0, 0, w, 30, 'F');
  doc.setFillColor(...C.accent);
  doc.rect(0, 30, w, 1.4, 'F');

  // Marca de la empresa, arriba a la derecha. Con logo se dibuja CONTENIDO en
  // una caja de 30x16 respetando la proporción — fijar ancho y alto deforma
  // cualquier logo que no tenga esa relación exacta (fue el bug de los
  // reportes). Sin logo, se cae a las iniciales en un cuadrito de acento.
  const boxW = 30;
  const boxH = 16;
  const boxX = w - 14 - boxW;
  const boxY = 7;

  let logoPainted = false;
  if (opts.logoDataUrl) {
    try {
      const props = doc.getImageProperties(opts.logoDataUrl);
      if (props?.width && props?.height) {
        const scale = Math.min(boxW / props.width, boxH / props.height);
        const lw = props.width * scale;
        const lh = props.height * scale;
        doc.addImage(
          opts.logoDataUrl,
          (props.fileType || 'PNG').toUpperCase(),
          boxX + boxW - lw, // pegado al margen derecho
          boxY + (boxH - lh) / 2,
          lw,
          lh,
          undefined,
          'FAST',
        );
        logoPainted = true;
      }
    } catch {
      logoPainted = false;
    }
  }

  if (!logoPainted) {
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
  }

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
  /** URL del logo de la empresa. Opcional: sin él, el encabezado usa iniciales. */
  companyLogoUrl?: string | null;
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

export async function generateCommissionPDF(data: PdfCommissionData) {
  const doc = new jsPDF('landscape', 'mm', 'a4');

  const logoDataUrl = await loadLogoDataUrl(data.companyLogoUrl);
  let y = pdfHeader(doc, {
    logoDataUrl,
    title: 'Informe de Comisiones',
    company: data.companyName,
    right: [data.periodLabel, `Generado: ${new Date().toLocaleDateString()}`],
  });

  // ─── HEAD Info ───
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...C.ink);
  doc.text(data.headName, 14, y);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...C.muted);
  doc.text(`${data.headRole}  |  ${data.headEmail}`, 14, y + 5);
  y += 11;

  // ─── KPIs ───
  y = pdfCards(doc, y, [
    { label: 'ND Total del Equipo', value: money(data.teamTotalND), tone: 'primary' },
    { label: 'Salario Base (auto)', value: money(data.autoSalary), tone: 'ink' },
    { label: 'Comision Propia', value: money(data.headOwnCalc?.commission ?? 0), tone: 'accent' },
    { label: 'Total + Salario', value: money(data.teamSummary.totalWithSalary), tone: 'positive' },
  ]);

  // ─── HEAD Own Commission Table ───
  if (data.headOwnCalc) {
    y = pdfSection(doc, 'Comision Propia del HEAD', y + 2);
    autoTable(doc, {
      startY: y,
      head: [['ND Mes Actual', 'Acumulado', 'Division', '%', 'Comision', 'Pago Real', 'Acc -> Sig.']],
      body: [[
        money(data.headOwnCalc.netDepositCurrent),
        money(data.headOwnCalc.accumulatedIn),
        money(data.headOwnCalc.division),
        `${data.headOwnCalc.commissionPct}%`,
        money(data.headOwnCalc.commission),
        money(data.headOwnCalc.realPayment),
        money(data.headOwnCalc.accumulatedOut),
      ]],
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2.5 },
      headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
      margin: { left: 14, right: 14 },
    });
    y = getLastTableY(doc, y + 20);
  } else {
    y += 4;
  }

  // ─── BDM Table ───
  y = pdfSection(doc, `Miembros del Equipo (${data.bdms.length})`, y);
  autoTable(doc, {
    startY: y,
    head: [['Nombre', 'Email', '% Propio', '% Diff', 'ND Mes', 'Division', 'Comision', 'Pago Real', 'Acc -> Sig.', 'Sueldo']],
    body: data.bdms.map(b => [
      b.name,
      b.email,
      `${b.pct}%`,
      `${b.diffPct}%`,
      money(b.nd),
      money(b.division),
      money(b.commission),
      money(b.realPayment),
      money(b.accOut),
      money(b.salary),
    ]),
    theme: 'striped',
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold', fontSize: 7 },
    alternateRowStyles: { fillColor: C.surface },
    margin: { left: 14, right: 14 },
  });

  // ─── Totals Summary ───
  y = getLastTableY(doc, y + 20);
  y = pdfSection(doc, 'Resumen de Pagos', y);

  const summaryRows: string[][] = [
    ['Comision propia del HEAD', money(data.teamSummary.headOwnPayment)],
    ['Diferencial de BDMs', money(data.teamSummary.diffTotal)],
    ['Total comisiones', money(data.teamSummary.totalPayment)],
    ['Salario base', money(data.autoSalary)],
  ];
  if (data.teamSummary.prevDebt < 0) {
    summaryRows.push(['Subtotal antes de deuda', money(data.teamSummary.rawTotalWithSalary)]);
    summaryRows.push(['Deuda mes anterior', money(data.teamSummary.prevDebt)]);
  }
  summaryRows.push(['TOTAL A PAGAR', money(data.teamSummary.totalWithSalary)]);
  const totalRowIndex = summaryRows.length - 1;

  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Monto']],
    body: summaryRows,
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    bodyStyles: { textColor: C.ink },
    didParseCell: (hookData) => {
      if (hookData.section === 'body' && hookData.row.index === totalRowIndex) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.fillColor = [234, 241, 250];
        hookData.cell.styles.textColor = C.primary;
      }
      // Resaltar fila de deuda en ámbar
      if (hookData.section === 'body' && data.teamSummary.prevDebt < 0 && hookData.row.index === totalRowIndex - 1) {
        hookData.cell.styles.textColor = C.warning;
      }
    },
    columnStyles: { 0: { cellWidth: 80 }, 1: { halign: 'right' } },
    margin: { left: 14, right: 14 },
  });

  pdfFooter(doc);
  const fileName = `Comisiones_${data.headName.replace(/\s/g, '_')}_${data.periodLabel.replace(/\s/g, '_')}.pdf`;
  doc.save(fileName);
}

// ═══════════════════════════════════════════════════════════
// Individual BDM PDF
// ═══════════════════════════════════════════════════════════

interface PdfIndividualData {
  companyName: string;
  /** URL del logo de la empresa. Opcional: sin él, el encabezado usa iniciales. */
  companyLogoUrl?: string | null;
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

export async function generateIndividualPDF(data: PdfIndividualData) {
  const doc = new jsPDF('portrait', 'mm', 'a4');

  const logoDataUrl = await loadLogoDataUrl(data.companyLogoUrl);
  let y = pdfHeader(doc, {
    logoDataUrl,
    title: 'Informe Individual de Comisiones',
    company: data.companyName,
    right: [data.periodLabel, `Generado: ${new Date().toLocaleDateString()}`],
  });

  // ─── Profile Info ───
  doc.setTextColor(...C.ink);
  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.text(data.name, 14, y);
  y += 6;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...C.muted);
  doc.text(`${data.role}  |  ${data.email}  |  HEAD: ${data.headName}`, 14, y);
  y += 8;

  // ─── KPIs ───
  y = pdfCards(doc, y, [
    { label: 'ND Mes Actual', value: money(data.nd), tone: 'primary' },
    { label: 'Comision', value: money(data.commission), tone: 'accent' },
    { label: 'Salario', value: money(data.salary), tone: 'ink' },
  ]);

  // ─── Calculation detail table ───
  y = pdfSection(doc, 'Detalle del Calculo', y + 2);
  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Valor']],
    body: [
      ['Porcentaje de comision', `${data.pct}%`],
      ['ND Mes Actual', money(data.nd)],
      ['Acumulado del mes anterior', money(data.accumulatedIn)],
      ['Division (ND / 2)', money(data.division)],
      ['Comision ((Division + Acumulado) x %)', money(data.commission)],
      ['Pago Real', money(data.realPayment)],
      ['Acumulado -> Siguiente mes', money(data.accumulatedOut)],
    ],
    theme: 'striped',
    styles: { fontSize: 9.5, cellPadding: 4 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    columnStyles: { 0: { cellWidth: 100 }, 1: { halign: 'right', fontStyle: 'bold' } },
    margin: { left: 14, right: 14 },
  });

  // ─── Total box ───
  y = getLastTableY(doc, y + 60, 10);
  y = pdfSection(doc, 'Resumen de Pago', y);
  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Monto']],
    body: [
      ['Comision (Pago Real)', money(data.realPayment)],
      ['Salario', money(data.salary)],
      ['TOTAL A PAGAR', money(data.total)],
    ],
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 4 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    bodyStyles: { textColor: C.ink },
    didParseCell: (hookData) => {
      if (hookData.section === 'body' && hookData.row.index === 2) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.fillColor = [234, 241, 250];
        hookData.cell.styles.textColor = C.primary;
      }
    },
    columnStyles: { 0: { cellWidth: 100 }, 1: { halign: 'right' } },
    margin: { left: 14, right: 14 },
  });

  pdfFooter(doc);
  const fileName = `Comision_${data.name.replace(/\s/g, '_')}_${data.periodLabel.replace(/\s/g, '_')}.pdf`;
  doc.save(fileName);
}

// ═══════════════════════════════════════════════════════════════════════════════
// generatePnlPDF — Individual PnL commission report with lot commissions
// ═══════════════════════════════════════════════════════════════════════════════

interface PdfPnlData {
  companyName: string;
  /** URL del logo de la empresa. Opcional: sin él, el encabezado usa iniciales. */
  companyLogoUrl?: string | null;
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

export async function generatePnlPDF(data: PdfPnlData) {
  const isSpecial = data.mode === 'special';
  const doc = new jsPDF('portrait', 'mm', 'a4');

  const logoDataUrl = await loadLogoDataUrl(data.companyLogoUrl);
  let y = pdfHeader(doc, {
    logoDataUrl,
    title: isSpecial ? 'Comisiones Individual - PnL Especial' : 'Comisiones Individual - PnL',
    company: data.companyName,
    right: [data.periodLabel, `Generado: ${new Date().toLocaleDateString()}`],
  });

  // Profile Info
  doc.setTextColor(...C.ink);
  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.text(data.name, 14, y);
  y += 6;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...C.muted);
  doc.text(`${data.role}  |  ${data.email}  |  HEAD: ${data.headName}`, 14, y);
  y += 8;

  // KPIs
  y = pdfCards(doc, y, [
    { label: 'PnL Mes Actual', value: money(data.pnl), tone: 'primary' },
    { label: 'Comision', value: money(data.commission), tone: 'accent' },
    { label: 'Com. por Lotes', value: money(data.lotCommissions), tone: 'ink' },
    { label: 'Pago Real', value: money(data.realPayment), tone: data.realPayment >= 0 ? 'positive' : 'negative' },
  ], 14, 18);

  // Calculation detail
  y = pdfSection(doc, 'Detalle del Calculo', y + 2);

  // Detalle del cálculo — en modo Especial se omiten las 3 filas que no
  // aplican (Acumulado previo, División, Acumulado siguiente) y se ajusta
  // el label de la comisión a la fórmula real del modo.
  const detailRows: string[][] = isSpecial
    ? [
        ['Porcentaje de comision', `${data.pct}%`],
        ['PnL Mes Actual', money(data.pnl)],
        ['Comision (PnL x %)', money(data.commission)],
        ['Comisiones ganadas por Lotes (descuento)', `-${money(data.lotCommissions)}`],
        ['Pago Real (Comision - Com. Lotes)', money(data.realPayment)],
      ]
    : [
        ['Porcentaje de comision', `${data.pct}%`],
        ['PnL Mes Actual', money(data.pnl)],
        ['Acumulado del mes anterior', money(data.accumulatedIn)],
        ['Division (PnL / 2)', money(data.division)],
        ['Comision ((Division + Acumulado) x %)', money(data.commission)],
        ['Comisiones ganadas por Lotes (descuento)', `-${money(data.lotCommissions)}`],
        ['Pago Real (Comision - Com. Lotes)', money(data.realPayment)],
        ['Acumulado -> Siguiente mes', money(data.accumulatedOut)],
      ];

  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Valor']],
    body: detailRows,
    theme: 'striped',
    styles: { fontSize: 9.5, cellPadding: 4 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    didParseCell: (hookData) => {
      // Índices dependen del modo — en especial hay 3 filas menos.
      //   Normal : 0=pct 1=pnl 2=accIn 3=div 4=commission 5=lots 6=realPayment 7=accOut
      //   Special: 0=pct 1=pnl                 2=commission 3=lots 4=realPayment
      const lotsRowIdx = isSpecial ? 3 : 5;
      const realPaymentRowIdx = isSpecial ? 4 : 6;
      // Resaltar fila de descuento lotes en ámbar
      if (hookData.section === 'body' && hookData.row.index === lotsRowIdx) {
        hookData.cell.styles.textColor = C.warning;
      }
      // Resaltar Pago Real en verde/rojo
      if (hookData.section === 'body' && hookData.row.index === realPaymentRowIdx) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.textColor = data.realPayment >= 0 ? C.positive : C.negative;
      }
    },
    columnStyles: { 0: { cellWidth: 110 }, 1: { halign: 'right', fontStyle: 'bold' } },
    margin: { left: 14, right: 14 },
  });

  // Resumen de pago
  y = getLastTableY(doc, y + 60, 10);
  y = pdfSection(doc, 'Resumen de Pago', y);
  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Monto']],
    body: [
      ['Comision bruta', money(data.commission)],
      ['Comisiones por Lotes (descuento)', `-${money(data.lotCommissions)}`],
      ['Pago Real (Comision - Lotes)', money(data.realPayment)],
      ['Salario', money(data.salary)],
      ['TOTAL A PAGAR', money(data.total)],
    ],
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 4 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    bodyStyles: { textColor: C.ink },
    didParseCell: (hookData) => {
      if (hookData.section === 'body' && hookData.row.index === 4) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.fillColor = [234, 241, 250];
        hookData.cell.styles.textColor = C.primary;
      }
      if (hookData.section === 'body' && hookData.row.index === 1) {
        hookData.cell.styles.textColor = C.warning;
      }
    },
    columnStyles: { 0: { cellWidth: 110 }, 1: { halign: 'right' } },
    margin: { left: 14, right: 14 },
  });

  pdfFooter(doc);
  const fileName = `${isSpecial ? 'ComisionPnLEspecial' : 'ComisionPnL'}_${data.name.replace(/\s/g, '_')}_${data.periodLabel.replace(/\s/g, '_')}.pdf`;
  doc.save(fileName);
}

// ═══════════════════════════════════════════════════════════
// Distribución a Socios — mes individual
// ═══════════════════════════════════════════════════════════

export interface PdfPartnerPeriodData {
  companyName: string;
  /** URL del logo de la empresa. Opcional: sin él, el encabezado usa iniciales. */
  companyLogoUrl?: string | null;
  periodLabel: string;
  ingresosNetos: number;
  egresosNetos: number;
  reservaMes: number;
  deudaEntrada: number;
  montoDistribuir: number;
  partners: { name: string; pct: number; amount: number }[];
}

export async function generatePartnerPeriodPDF(data: PdfPartnerPeriodData) {
  const doc = new jsPDF('portrait', 'mm', 'a4');

  const logoDataUrl = await loadLogoDataUrl(data.companyLogoUrl);
  let y = pdfHeader(doc, {
    logoDataUrl,
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
  /** URL del logo de la empresa. Opcional: sin él, el encabezado usa iniciales. */
  companyLogoUrl?: string | null;
  partnerNames: string[];
  rows: { periodLabel: string; amounts: number[]; total: number }[];
  partnerTotals: number[];
  grandTotal: number;
}

export async function generatePartnerHistoryPDF(data: PdfPartnerHistoryData) {
  const doc = new jsPDF('landscape', 'mm', 'a4');

  const logoDataUrl = await loadLogoDataUrl(data.companyLogoUrl);
  let y = pdfHeader(doc, {
    logoDataUrl,
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

/**
 * Facturación del mes de una empresa de servicios: reemplaza el flujo de
 * depósitos y retiros de clientes, que para una consultora es una página
 * entera de ceros. Sale de `buildBilling` (company-report.ts) — el mismo
 * objeto que ve en pantalla y en el CSV.
 */
export interface PdfMonthlyCloseBilling {
  billed: number;
  collected: number;
  pending: number;
  clients: Array<{ name: string; billed: number; collected: number; pending: number }>;
}

export interface PdfMonthlyCloseData {
  companyName: string;
  /** URL del logo de la empresa. Opcional: sin él, el encabezado usa iniciales. */
  companyLogoUrl?: string | null;
  periodLabel: string;
  /**
   * Facturación del mes. Presente = empresa de servicios: el informe cambia
   * "Resultado Operativo" (broker P&L, prop firm, inversiones) y "Flujo de
   * Depósitos y Retiros de Clientes" por facturación por cliente. Ausente =
   * broker, el informe de siempre, sin un solo cambio.
   */
  billing?: PdfMonthlyCloseBilling | null;
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

export async function generateMonthlyClosePDF(data: PdfMonthlyCloseData) {
  const doc = new jsPDF('portrait', 'mm', 'a4');

  const logoDataUrl = await loadLogoDataUrl(data.companyLogoUrl);
  let y = pdfHeader(doc, {
    logoDataUrl,
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
  const billing = data.billing ?? null;
  y = pdfSection(doc, 'Resultado Operativo', y + 2);
  const opRows: [string, number][] = billing
    ? [
        ['Facturado del mes', billing.billed],
        ['Cobrado', billing.collected],
        ['Por cobrar', billing.pending],
      ]
    : [
        ['Broker P&L (Book B)', data.brokerPnl],
        ['Prop Firm (neto)', data.propFirmNet],
        ['Ganancias de inversiones', data.investmentProfits],
      ];
  if (!billing && data.otherIncome) opRows.push(['Otros ingresos', data.otherIncome]);
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

  if (billing) {
    // ─── Facturación por cliente (empresa de servicios) ───
    y = pdfSection(doc, 'Facturacion por Cliente', y);
    autoTable(doc, {
      startY: y,
      head: [['Cliente', 'Facturado', 'Cobrado', 'Por cobrar']],
      body: billing.clients.map((c) => [
        c.name,
        money(c.billed),
        money(c.collected),
        money(c.pending),
      ]),
      foot: [['Total', money(billing.billed), money(billing.collected), money(billing.pending)]],
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 2.6 },
      headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
      footStyles: { fillColor: C.surface, textColor: C.primary, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 66 },
        1: { halign: 'right' },
        2: { halign: 'right', textColor: C.positive },
        3: { halign: 'right', textColor: C.negative },
      },
      margin: { left: 14, right: 14 },
      didParseCell: (h) => {
        if (h.section === 'foot' && h.column.index > 0) h.cell.styles.halign = 'right';
      },
    });
    y = getLastTableY(doc, y + 30, 5);
    // Banda de lo que falta cobrar: es lo que NO entra en el saldo a favor y
    // por lo tanto no se reparte este mes.
    doc.setFillColor(...C.surface);
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    const wBand = doc.internal.pageSize.getWidth();
    doc.roundedRect(14, y, wBand - 28, 11, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...C.ink);
    doc.text('Facturado sin cobrar (no se distribuye)', 18, y + 7);
    doc.setTextColor(...(billing.pending > 0 ? C.negative : C.positive));
    doc.setFontSize(11);
    doc.text(money(billing.pending), wBand - 18, y + 7.2, { align: 'right' });
    y += 17;
  } else {
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
  }

  // ─── Página 2: egresos + distribución ───
  doc.addPage();
  y = pdfHeader(doc, {
    logoDataUrl,
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

// ═══════════════════════════════════════════════════════════════════════════════
// Libro de balances por canal (migración 059)
//
// Dos documentos:
//   · generateChannelLedgerPDF   → el libro de UN canal, con saldo corrido.
//   · generateChannelBalancesPDF → el resumen de TODOS los canales a una fecha.
//
// Bilingües por llamada (no por idioma de UI), igual que las órdenes de pago:
// el PDF suele salir de la app para mandárselo a alguien que no la usa.
// jsPDF con fuentes estándar soporta tildes y ñ (WinAnsi) — verificado.
// ═══════════════════════════════════════════════════════════════════════════════

type LedgerLocale = 'es' | 'en';

const LEDGER_T = {
  es: {
    ledgerTitle: 'Libro del canal', balancesTitle: 'Balances por Canal',
    generated: 'Generado', period: 'Período', asOf: 'Al',
    opening: 'Saldo inicial', inflows: 'Ingresos', outflows: 'Retiros',
    internal: 'Transferencias internas', closing: 'Saldo final',
    date: 'Fecha', concept: 'Concepto', reference: 'Referencia',
    inflow: 'Ingreso', outflow: 'Egreso', balance: 'Saldo',
    detail: 'Detalle del libro', summary: 'Resumen del período',
    channel: 'Canal', type: 'Tipo', auto: 'Automático', manual: 'Manual',
    total: 'Total consolidado', channels: 'Canales',
    autoNote: 'Libro escrito automaticamente cada dia a las 00:00 UTC con los datos de la API del proveedor. El saldo de cierre coincide con el saldo real reportado por el proveedor.',
    internalNote: 'Las transferencias internas mueven el saldo del canal pero quedan fuera de Retiros Totales: son movimientos entre wallets propias, no retiros del negocio.',
  },
  en: {
    ledgerTitle: 'Channel ledger', balancesTitle: 'Balances by Channel',
    generated: 'Generated', period: 'Period', asOf: 'As of',
    opening: 'Opening balance', inflows: 'Inflows', outflows: 'Withdrawals',
    internal: 'Internal transfers', closing: 'Closing balance',
    date: 'Date', concept: 'Concept', reference: 'Reference',
    inflow: 'Inflow', outflow: 'Outflow', balance: 'Balance',
    detail: 'Ledger detail', summary: 'Period summary',
    channel: 'Channel', type: 'Type', auto: 'Automatic', manual: 'Manual',
    total: 'Total consolidated', channels: 'Channels',
    autoNote: 'Ledger written automatically every day at 00:00 UTC from the provider API. The closing balance matches the real balance reported by the provider.',
    internalNote: 'Internal transfers move the channel balance but stay out of Total Withdrawals: they are movements between your own wallets, not business withdrawals.',
  },
} as const;

export interface PdfLedgerRow {
  entry_date: string;
  concept: string;
  category: string | null;
  reference: string | null;
  kind: 'opening' | 'in' | 'out';
  amount: number;
  balance: number;
}

export interface PdfChannelLedgerData {
  company: { name: string; logoUrl?: string | null; colorPrimary?: string | null };
  channelLabel: string;
  isAuto: boolean;
  from: string;
  to: string;
  rows: PdfLedgerRow[];
  totals: {
    opening: number; inflows: number; outflows: number;
    internalTransfers: number; adjustments: number; closing: number;
  };
  locale?: LedgerLocale;
}

/** Nota al pie de una seccion, en gris chico. Devuelve la Y libre. */
function pdfNote(doc: jsPDF, text: string, y: number, margin = 14): number {
  const w = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.4);
  doc.setTextColor(...C.muted);
  const lines = doc.splitTextToSize(text, w - margin * 2);
  doc.text(lines, margin, y);
  return y + lines.length * 3.4 + 3;
}

export async function generateChannelLedgerPDF(data: PdfChannelLedgerData) {
  const L = LEDGER_T[data.locale ?? 'es'];
  const doc = new jsPDF('portrait', 'mm', 'a4');

  const logoDataUrl = await loadLogoDataUrl(data.company.logoUrl);
  let y = pdfHeader(doc, {
    logoDataUrl,
    title: L.ledgerTitle,
    company: data.company.name,
    right: [
      data.channelLabel,
      `${L.period}: ${data.from} - ${data.to}`,
      `${L.generated}: ${new Date().toLocaleDateString()}`,
    ],
  });

  // ─── Resumen del período ───
  y = pdfSection(doc, `${L.summary} - ${data.channelLabel}`, y);
  y = pdfCards(doc, y, [
    { label: L.opening, value: money(data.totals.opening) },
    { label: L.inflows, value: money(data.totals.inflows), tone: 'positive' },
    { label: L.outflows, value: money(data.totals.outflows), tone: 'negative' },
    { label: L.closing, value: money(data.totals.closing), tone: 'primary' },
  ]);

  if (data.totals.internalTransfers > 0) {
    y = pdfNote(doc, `${L.internal}: ${money(data.totals.internalTransfers)}. ${L.internalNote}`, y);
  }
  if (data.isAuto) {
    y = pdfNote(doc, L.autoNote, y);
  }

  // ─── Detalle ───
  y = pdfSection(doc, L.detail, y + 3);
  autoTable(doc, {
    startY: y,
    head: [[L.date, L.concept, L.reference, L.inflow, L.outflow, L.balance]],
    body: data.rows.map((r) => [
      r.entry_date,
      r.concept,
      // Las referencias suelen ser hashes o URLs largas: sin recortar,
      // autotable ensancha la columna y desarma el resto de la tabla.
      r.reference ? (r.reference.length > 28 ? `${r.reference.slice(0, 27)}...` : r.reference) : '-',
      r.kind !== 'out' ? money(r.amount) : '',
      r.kind === 'out' ? money(r.amount) : '',
      money(r.balance),
    ]),
    foot: [['', L.closing, '', '', '', money(data.totals.closing)]],
    theme: 'striped',
    styles: { fontSize: 8, cellPadding: 2.4 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    footStyles: { fillColor: [234, 241, 250], textColor: C.primary, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 20 },
      2: { cellWidth: 38 },
      3: { halign: 'right', textColor: C.positive },
      4: { halign: 'right', textColor: C.negative },
      5: { halign: 'right', fontStyle: 'bold' },
    },
    margin: { left: 14, right: 14 },
    // columnStyles.halign NO se aplica al foot de autotable: hay que forzarlo.
    didParseCell: (h) => {
      if (h.section === 'foot' && h.column.index === 5) h.cell.styles.halign = 'right';
    },
  });

  pdfFooter(doc);
  doc.save(`Libro_${data.channelLabel.replace(/\s+/g, '_')}_${data.from}_${data.to}.pdf`);
}

export interface PdfChannelBalancesData {
  company: { name: string; logoUrl?: string | null };
  asOf: string;
  channels: Array<{ label: string; isAuto: boolean; balance: number }>;
  total: number;
  locale?: LedgerLocale;
}

export async function generateChannelBalancesPDF(data: PdfChannelBalancesData) {
  const L = LEDGER_T[data.locale ?? 'es'];
  const doc = new jsPDF('portrait', 'mm', 'a4');

  const logoDataUrl = await loadLogoDataUrl(data.company.logoUrl);
  let y = pdfHeader(doc, {
    logoDataUrl,
    title: L.balancesTitle,
    company: data.company.name,
    right: [`${L.asOf} ${data.asOf}`, `${L.generated}: ${new Date().toLocaleDateString()}`],
  });

  y = pdfCards(doc, y, [
    { label: L.total, value: money(data.total), tone: 'primary' },
    { label: L.channels, value: String(data.channels.length), tone: 'accent' },
  ]);

  y = pdfSection(doc, L.balancesTitle, y + 2);
  autoTable(doc, {
    startY: y,
    head: [[L.channel, L.type, L.balance]],
    body: data.channels.map((c) => [c.label, c.isAuto ? L.auto : L.manual, money(c.balance)]),
    foot: [[L.total, '', money(data.total)]],
    theme: 'striped',
    styles: { fontSize: 9.5, cellPadding: 3 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    footStyles: { fillColor: [234, 241, 250], textColor: C.primary, fontStyle: 'bold' },
    columnStyles: { 1: { halign: 'center' }, 2: { halign: 'right', fontStyle: 'bold' } },
    margin: { left: 14, right: 14 },
    didParseCell: (h) => {
      if (h.section === 'foot' && h.column.index === 2) h.cell.styles.halign = 'right';
    },
  });

  pdfFooter(doc);
  doc.save(`Balances_por_Canal_${data.asOf}.pdf`);
}
