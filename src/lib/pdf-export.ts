import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatNumber } from '@/lib/utils';
import { BRAND_RGB, type RGB } from '@/lib/brand';
import {
  pdfMoney,
  pdfMoneyOrMissing,
  SIN_DATOS,
  generatedOnLabel,
  buildCloseWaterfall,
  buildCloseExpenses,
  incomeSourcesLabel,
  partnerShareRows,
  missingSeriesShort,
  type CloseCompleteness,
  type CloseDesglose,
  type CloseExpenseInput,
  type ClientFlow,
  type CrmInfoRow,
  type PartnerShareRow,
  type WaterfallResult,
} from '@/lib/monthly-close-pdf-data';

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
/** «$1,234.56» / «-$1,234.56» — ver `pdfMoney` (antes un negativo salía «$-…»). */
const money = pdfMoney;

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
  /** Subtexto chico bajo el valor (p. ej. «Broker + Prop Firm»). Opcional. */
  sub?: string;
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
    // value — con subtexto, el valor sube para dejarle la última línea.
    const hasSub = cards.some((k) => k.sub);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(h >= 20 ? 12 : 10.5);
    doc.setTextColor(...toneColor(c.tone));
    doc.text(c.value, x + 5, hasSub ? y + 14.5 : y + h - 5.5);
    if (c.sub) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.6);
      doc.setTextColor(...C.muted);
      const line = (doc.splitTextToSize(c.sub, cardW - 7) as string[])[0] ?? '';
      doc.text(line, x + 5, y + h - 4);
    }
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
    doc.text(`Documento generado automáticamente — ${brand}`, 14, h - 5.5);
    if (pages > 1) {
      doc.text(`Página ${i} de ${pages}`, w - 14, h - 5.5, { align: 'right' });
    }
  }
}

// ─── Piezas compartidas de los informes de distribución ───────────────────────
// «PDF mes» y «Cierre mensual» dibujan la MISMA cascada, el mismo aviso de
// serie faltante y la misma tabla de socios. Una sola implementación: si una
// de las dos dibujara distinto, el socio vería dos cuentas distintas del mismo
// mes (2026-10-05).

/**
 * Banda de aviso a todo el ancho (fondo ámbar suave, borde y texto en color de
 * atención). Para lo que NO puede pasar desapercibido: va arriba de todo.
 */
function pdfAlertBand(doc: jsPDF, text: string, y: number, margin = 14): number {
  const w = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  const lines = doc.splitTextToSize(`! ${text}`, w - margin * 2 - 8) as string[];
  const h = lines.length * 4.4 + 5;
  doc.setFillColor(254, 243, 199);
  doc.setDrawColor(...C.warning);
  doc.setLineWidth(0.4);
  doc.roundedRect(margin, y, w - margin * 2, h, 2, 2, 'FD');
  doc.setTextColor(...C.warning);
  doc.text(lines, margin + 4, y + 5.6);
  return y + h + 5;
}

/** Tabla «Cómo se llega al resultado». Un importe `null` se imprime «sin datos». */
function pdfWaterfallTable(doc: jsPDF, y: number, wf: WaterfallResult['rows'], margin = 14): number {
  autoTable(doc, {
    startY: y,
    body: wf.map((r) => [r.kind === 'total' ? `= ${r.label}` : `     ${r.label}`, pdfMoneyOrMissing(r.amount)]),
    theme: 'plain',
    styles: { fontSize: 9.5, cellPadding: { top: 1.7, bottom: 1.7, left: 3, right: 3 }, textColor: C.ink },
    columnStyles: { 0: { cellWidth: 120 }, 1: { halign: 'right' } },
    margin: { left: margin, right: margin },
    didParseCell: (h) => {
      const r = wf[h.row.index];
      if (!r || h.section !== 'body') return;
      if (h.column.index === 1 && r.amount === null) {
        h.cell.styles.textColor = C.warning;
        h.cell.styles.fontStyle = 'italic';
        if (r.kind === 'total') h.cell.styles.fillColor = C.surface;
        return;
      }
      if (r.kind === 'total') {
        h.cell.styles.fillColor = C.surface;
        h.cell.styles.fontStyle = 'bold';
        h.cell.styles.textColor = h.column.index === 1 && (r.amount ?? 0) < 0 ? C.negative : C.primary;
      } else if (h.column.index === 1) {
        h.cell.styles.textColor = r.kind === 'expense' ? C.negative : (r.amount ?? 0) < 0 ? C.negative : C.positive;
      } else {
        h.cell.styles.textColor = C.inkSoft;
      }
    },
    didDrawCell: (h) => {
      // Regla fina arriba de cada total: separa el subtotal de sus sumandos.
      const r = wf[h.row.index];
      if (h.section === 'body' && r?.kind === 'total') {
        doc.setDrawColor(...C.border);
        doc.setLineWidth(0.3);
        doc.line(h.cell.x, h.cell.y, h.cell.x + h.cell.width, h.cell.y);
      }
    },
  });
  return getLastTableY(doc, y + 60, 4);
}

/** Tabla de socios con barra de participación. Monto `null` ⇒ «sin datos». */
function pdfPartnerTable(
  doc: jsPDF,
  y: number,
  rows: PartnerShareRow[],
  total: number | null,
  margin = 14,
): number {
  autoTable(doc, {
    startY: y,
    head: [['Socio', 'Participación', 'Monto a recibir']],
    body: rows.map((p) => [p.name, `${(p.pct * 100).toFixed(1)}%`, pdfMoneyOrMissing(p.amount)]),
    foot: [['Total distribuido', '100%', pdfMoneyOrMissing(total)]],
    theme: 'striped',
    styles: { fontSize: 10, cellPadding: 3.2 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    footStyles: { fillColor: [234, 241, 250], textColor: C.primary, fontStyle: 'bold' },
    columnStyles: { 1: { cellWidth: 70 }, 2: { halign: 'right', fontStyle: 'bold', textColor: C.ink } },
    margin: { left: margin, right: margin },
    didParseCell: (h) => {
      if (h.section === 'foot' && h.column.index === 2) h.cell.styles.halign = 'right';
      if (h.column.index === 2 && h.cell.raw === SIN_DATOS) {
        h.cell.styles.textColor = C.warning;
        h.cell.styles.fontStyle = 'italic';
      }
    },
    didDrawCell: (h) => {
      // Barra de participación: rect proporcional al % del socio, a la derecha
      // del número, sobre un riel gris del ancho disponible.
      if (h.section !== 'body' || h.column.index !== 1) return;
      const p = rows[h.row.index];
      if (!p) return;
      const x0 = h.cell.x + 20;
      const full = h.cell.width - 24;
      const barH = 2.6;
      const by = h.cell.y + (h.cell.height - barH) / 2;
      doc.setFillColor(...C.border);
      doc.rect(x0, by, full, barH, 'F');
      const frac = Math.max(0, Math.min(1, p.pct));
      if (frac > 0) {
        doc.setFillColor(...C.accent);
        doc.rect(x0, by, full * frac, barH, 'F');
      }
    },
  });
  return getLastTableY(doc, y + 40, 8);
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
    accIn: number;
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
    { label: 'Comisión Propia', value: money(data.headOwnCalc?.commission ?? 0), tone: 'accent' },
    { label: 'Total + Salario', value: money(data.teamSummary.totalWithSalary), tone: 'positive' },
  ]);

  // ─── HEAD Own Commission Table ───
  if (data.headOwnCalc) {
    // El ROL REAL y no "HEAD" fijo (dueño, 2026-09-06): desde que un BDM con
    // Master IBs puede liderar un grupo, este informe también sale con un BDM
    // arriba, y un papel que dijera "Comision Propia del HEAD" para Ana sería
    // el mismo tipo de dato plausible y equivocado que persigue el §1.2. Para
    // un head la etiqueta sigue diciendo HEAD, letra por letra.
    y = pdfSection(doc, `Comisión Propia del ${data.headRole}`, y + 2);
    autoTable(doc, {
      startY: y,
      head: [['ND Mes Actual', 'Acumulado', 'División', '%', 'Comisión', 'Pago Real', 'Acc -> Sig.']],
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
    // «% Pagado» y NO «% Diff» ni «% Propio» (dueño, 2026-09-06): el informe
    // muestra SOLO el % por el que se le paga al head por esa línea — que con
    // pct_linea cargado ya no es un diferencial derivado. El % propio del BDM
    // es asunto de SU informe individual, no de este.
    head: [['Nombre', 'Email', '% Pagado', 'ND Mes', 'Acumulado', 'División', 'Comisión', 'Pago Real', 'Acc -> Sig.', 'Sueldo']],
    body: data.bdms.map(b => [
      b.name,
      b.email,
      `${b.diffPct}%`,
      money(b.nd),
      money(b.accIn),
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
    [`Comisión propia del ${data.headRole}`, money(data.teamSummary.headOwnPayment)],
    // «Diferencial del equipo» y no «de BDMs»: las líneas de un grupo pueden ser
    // BDMs (grupo de un head) o Master IBs (grupo de un BDM).
    ['Diferencial del equipo', money(data.teamSummary.diffTotal)],
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
  /** Deuda arrastrada del mes anterior (negativa = hay deuda). >= 0 = sin deuda. */
  prevDebt: number;
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
    { label: 'Comisión', value: money(data.commission), tone: 'accent' },
    { label: 'Salario', value: money(data.salary), tone: 'ink' },
  ]);

  // ─── Calculation detail table ───
  y = pdfSection(doc, 'Detalle del Cálculo', y + 2);
  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Valor']],
    body: [
      ['Porcentaje de comision', `${data.pct}%`],
      ['ND Mes Actual', money(data.nd)],
      ['Acumulado del mes anterior', money(data.accumulatedIn)],
      ['División (ND / 2)', money(data.division)],
      ['Comisión ((División + Acumulado) x %)', money(data.commission)],
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
  // Si hay deuda arrastrada (prevDebt < 0), se muestra el subtotal y la deuda
  // descontada para que TOTAL = Comision + Salario − Deuda cuadre a la vista.
  const hasDebt = data.prevDebt < 0;
  const rawTotal = Math.round((data.realPayment + data.salary) * 100) / 100;
  const summaryBody: string[][] = [
    ['Comisión (Pago Real)', money(data.realPayment)],
    ['Salario', money(data.salary)],
  ];
  if (hasDebt) {
    summaryBody.push(['Subtotal antes de deuda', money(rawTotal)]);
    summaryBody.push(['(-) Deuda arrastrada del mes anterior', money(data.prevDebt)]);
  }
  summaryBody.push(['TOTAL A PAGAR', money(data.total)]);
  const totalRowIdx = summaryBody.length - 1;
  const debtRowIdx = hasDebt ? summaryBody.length - 2 : -1;
  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Monto']],
    body: summaryBody,
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 4 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    bodyStyles: { textColor: C.ink },
    didParseCell: (hookData) => {
      if (hookData.section !== 'body') return;
      if (hookData.row.index === totalRowIdx) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.fillColor = [234, 241, 250];
        hookData.cell.styles.textColor = C.primary;
      } else if (hookData.row.index === debtRowIdx) {
        hookData.cell.styles.fillColor = [254, 243, 199]; // ámbar suave
        hookData.cell.styles.textColor = [146, 64, 14];
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
   * Deuda arrastrada del mes anterior (negativa = hay deuda; >= 0 = sin deuda).
   * Mismo contrato que PdfIndividualData: la pantalla ya la descuenta del
   * TOTAL, así que sin esta fila el PDF mostraba un total que no cuadraba con
   * "Pago Real + Salario" y nadie sabía por qué (reporte del dueño, 2026-09-02:
   * la deuda no se estaba mostrando en el PDF).
   */
  prevDebt: number;
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

  // KPIs. La cuarta tarjeta es «Total a Pagar» (data.total, con la deuda
  // arrastrada YA descontada) y NO «Pago Real» (dueño, 2026-09-11): el pago
  // real es antes de la deuda, y con deuda el Resumen de abajo daba otra
  // cifra — dos números grandes distintos para "lo que cobro" confunden a
  // quien recibe el informe. La tarjeta y el TOTAL A PAGAR del Resumen dicen
  // exactamente lo mismo.
  y = pdfCards(doc, y, [
    { label: 'PnL Mes Actual', value: money(data.pnl), tone: 'primary' },
    { label: 'Comisión', value: money(data.commission), tone: 'accent' },
    { label: 'Com. por Lotes', value: money(data.lotCommissions), tone: 'ink' },
    { label: 'Total a Pagar', value: money(data.total), tone: data.total >= 0 ? 'positive' : 'negative' },
  ], 14, 18);

  // Calculation detail
  y = pdfSection(doc, 'Detalle del Cálculo', y + 2);

  // Detalle del cálculo — en modo Especial se omiten las 3 filas que no
  // aplican (Acumulado previo, División, Acumulado siguiente) y se ajusta
  // el label de la comisión a la fórmula real del modo.
  const detailRows: string[][] = isSpecial
    ? [
        ['Porcentaje de comision', `${data.pct}%`],
        ['PnL Mes Actual', money(data.pnl)],
        ['Comisión (PnL x %)', money(data.commission)],
        ['Comisiones ganadas por Lotes (descuento)', `-${money(data.lotCommissions)}`],
        ['Pago Real (Comisión - Com. Lotes)', money(data.realPayment)],
      ]
    : [
        ['Porcentaje de comision', `${data.pct}%`],
        ['PnL Mes Actual', money(data.pnl)],
        ['Acumulado del mes anterior', money(data.accumulatedIn)],
        ['División (PnL / 2)', money(data.division)],
        ['Comisión ((División + Acumulado) x %)', money(data.commission)],
        ['Comisiones ganadas por Lotes (descuento)', `-${money(data.lotCommissions)}`],
        ['Pago Real (Comisión - Com. Lotes)', money(data.realPayment)],
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

  // Resumen de pago. Con deuda arrastrada (prevDebt < 0) se agregan el
  // subtotal y la fila de deuda, igual que en generateIndividualPDF: el TOTAL
  // tiene que cuadrar A LA VISTA con las filas de arriba, no por fe.
  y = getLastTableY(doc, y + 60, 10);
  y = pdfSection(doc, 'Resumen de Pago', y);
  const hasDebt = data.prevDebt < 0;
  const rawTotal = Math.round((data.realPayment + data.salary) * 100) / 100;
  const summaryBody: string[][] = [
    ['Comisión bruta', money(data.commission)],
    ['Comisiones por Lotes (descuento)', `-${money(data.lotCommissions)}`],
    ['Pago Real (Comisión - Lotes)', money(data.realPayment)],
    ['Salario', money(data.salary)],
  ];
  if (hasDebt) {
    summaryBody.push(['Subtotal antes de deuda', money(rawTotal)]);
    summaryBody.push(['(-) Deuda arrastrada del mes anterior', money(data.prevDebt)]);
  }
  summaryBody.push(['TOTAL A PAGAR', money(data.total)]);
  const totalRowIdx = summaryBody.length - 1;
  const debtRowIdx = hasDebt ? summaryBody.length - 2 : -1;
  autoTable(doc, {
    startY: y,
    head: [['Concepto', 'Monto']],
    body: summaryBody,
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 4 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    bodyStyles: { textColor: C.ink },
    didParseCell: (hookData) => {
      if (hookData.section !== 'body') return;
      if (hookData.row.index === totalRowIdx) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.fillColor = [234, 241, 250];
        hookData.cell.styles.textColor = C.primary;
      } else if (hookData.row.index === debtRowIdx) {
        hookData.cell.styles.fillColor = [254, 243, 199]; // ámbar suave
        hookData.cell.styles.textColor = [146, 64, 14];
      } else if (hookData.row.index === 1) {
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
//
// REDISEÑO 2026-10-05 (incidente de las ~22:10): el «PDF mes» de Vex Pro
// sep-2026 salió con «Ingresos Netos $23.616,52» y «Monto a Distribuir $0»
// porque las series del CRM todavía no habían llegado y la cadena cayó al
// manual 0 (ver distribution-inputs.ts). Además no decía de dónde salían los
// ingresos, la fecha salía en formato del navegador, «Como se calcula» sin
// tilde y sin desglose.
//
// Ahora es el mismo sistema que el Cierre mensual: período largo, «Generado
// el …», la cascada de `buildCloseWaterfall` (la MISMA función, no una
// segunda fórmula) con Broker P&L / Prop Firm / Inversiones / Otros, el aviso
// de serie faltante ARRIBA y «sin datos» —nunca $0— donde falta el dato, y la
// tabla de socios con barra de participación.
// ═══════════════════════════════════════════════════════════

export interface PdfPartnerPeriodData {
  companyName: string;
  /** URL del logo de la empresa. Opcional: sin él, el encabezado usa iniciales. */
  companyLogoUrl?: string | null;
  /** Nombre largo del período («Septiembre 2026») — ver `longPeriodLabel`. */
  periodLabel: string;
  /**
   * Rótulo para el nombre del archivo. Se mantiene el de siempre
   * (`Distribucion_Socios_<label corto>.pdf`) para no romper a quien los
   * archiva por nombre. Ausente ⇒ `periodLabel`.
   */
  fileLabel?: string;
  /** `currentChain.desglose` tal cual — los automáticos `null` si no llegaron. */
  desglose: CloseDesglose;
  // Todos de la MISMA cadena de distribución (currentChain)
  ingresosNetos: number;
  egresosNetos: number;
  saldo: number;
  reservaMes: number;
  /** Fracción 0..1 del período (rótulo de la reserva). */
  reservePct: number | null;
  deudaEntrada: number;
  montoDistribuir: number;
  /** Completitud del período (`computeCheckedChain`). Ausente ⇒ completo. */
  completeness?: CloseCompleteness | null;
  partners: { name: string; pct: number; amount: number }[];
}

export async function generatePartnerPeriodPDF(data: PdfPartnerPeriodData) {
  const doc = new jsPDF('portrait', 'mm', 'a4');
  const M = 14;

  const logoDataUrl = await loadLogoDataUrl(data.companyLogoUrl);
  let y = pdfHeader(doc, {
    logoDataUrl,
    title: 'Distribución a Socios',
    company: data.companyName,
    right: [data.periodLabel, generatedOnLabel()],
  });

  const waterfall = buildCloseWaterfall({
    desglose: data.desglose,
    ingresosNetos: data.ingresosNetos,
    egresos: data.egresosNetos,
    saldo: data.saldo,
    reservaMes: data.reservaMes,
    reservePct: data.reservePct,
    deudaEntrada: data.deudaEntrada,
    montoDistribuir: data.montoDistribuir,
    completeness: data.completeness,
  });
  const share = partnerShareRows(data.partners, waterfall.distribucionConocida);

  // ─── Aviso de serie faltante: lo primero que se lee ───
  if (waterfall.aviso) y = pdfAlertBand(doc, waterfall.aviso, y, M);

  // ─── KPIs ───
  const missing = data.completeness?.incompleto ?? [];
  const sources = incomeSourcesLabel(data.desglose);
  const pct = data.reservePct;
  y = pdfCards(
    doc,
    y,
    [
      {
        label: 'Ingresos netos',
        value: waterfall.resultadoConocido ? money(data.ingresosNetos) : SIN_DATOS,
        tone: !waterfall.resultadoConocido ? 'ink' : data.ingresosNetos >= 0 ? 'positive' : 'negative',
        sub: missing.length > 0 ? `Falta ${missingSeriesShort(missing)}` : sources || 'Sin ingresos registrados',
      },
      { label: 'Egresos', value: money(data.egresosNetos), tone: 'negative', sub: 'Del mes' },
      {
        label: 'Reserva del mes',
        value: waterfall.distribucionConocida ? money(data.reservaMes) : SIN_DATOS,
        tone: 'ink',
        sub: pct != null ? `${(pct * 100).toFixed(pct * 100 === Math.round(pct * 100) ? 0 : 1)}% del remanente` : '',
      },
      {
        label: 'Monto a distribuir',
        value: waterfall.distribucionConocida ? money(data.montoDistribuir) : SIN_DATOS,
        tone: 'accent',
        sub: `${data.partners.length} ${data.partners.length === 1 ? 'socio' : 'socios'}`,
      },
    ],
    M,
    24,
  );

  // ─── Cómo se llega al monto a distribuir ───
  y = pdfSection(doc, 'Cómo se llega al monto a distribuir', y + 2, M);
  y = pdfWaterfallTable(doc, y, waterfall.rows, M);
  const pageW = doc.internal.pageSize.getWidth();
  for (const w of waterfall.warnings) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...C.warning);
    const lines = doc.splitTextToSize(`! ${w}`, pageW - M * 2) as string[];
    doc.text(lines, M, y + 1);
    y += lines.length * 3.8 + 0.6;
  }
  y += 6;

  // ─── Reparto por socio ───
  y = pdfSection(doc, 'Reparto por Socio', y, M);
  if (waterfall.distribucionConocida && data.deudaEntrada > 0) {
    doc.setFontSize(8);
    doc.setTextColor(...C.warning);
    doc.setFont('helvetica', 'normal');
    doc.text(`Deuda arrastrada del mes anterior descontada: ${money(data.deudaEntrada)}`, M, y);
    y += 5;
  }
  pdfPartnerTable(doc, y, share.rows, share.total, M);

  pdfFooter(doc);
  doc.save(`Distribucion_Socios_${(data.fileLabel ?? data.periodLabel).replace(/\s/g, '_')}.pdf`);
}

// ═══════════════════════════════════════════════════════════
// Historial de Distribuciones — todos los meses
// ═══════════════════════════════════════════════════════════

export interface PdfPartnerHistoryData {
  companyName: string;
  /** URL del logo de la empresa. Opcional: sin él, el encabezado usa iniciales. */
  companyLogoUrl?: string | null;
  partnerNames: string[];
  /**
   * `amounts: null` = el mes depende de una serie del CRM que no llegó: se
   * imprime «sin datos» y NO suma a los totales (incidente 2026-10-05).
   */
  rows: { periodLabel: string; amounts: number[] | null; total: number | null }[];
  partnerTotals: number[];
  grandTotal: number;
  /** Aviso a imprimir bajo la tabla (p. ej. qué meses quedaron afuera). */
  note?: string | null;
}

export async function generatePartnerHistoryPDF(data: PdfPartnerHistoryData) {
  const doc = new jsPDF('landscape', 'mm', 'a4');

  const logoDataUrl = await loadLogoDataUrl(data.companyLogoUrl);
  let y = pdfHeader(doc, {
    logoDataUrl,
    title: 'Historial de Distribuciones',
    company: data.companyName,
    right: [generatedOnLabel()],
  });
  if (data.note) y = pdfAlertBand(doc, data.note, y);

  // ─── KPIs resumen ───
  const topPartnerIdx = data.partnerTotals.reduce((best, v, i, a) => (v > a[best] ? i : best), 0);
  const knownRows = data.rows.filter((r) => r.amounts !== null).length;
  y = pdfCards(doc, y, [
    { label: 'Meses distribuidos', value: String(knownRows), tone: 'primary' },
    { label: 'Total repartido', value: money(data.grandTotal), tone: 'accent' },
    { label: 'Promedio mensual', value: money(knownRows ? data.grandTotal / knownRows : 0), tone: 'ink' },
    { label: `Mayor socio (${data.partnerNames[topPartnerIdx] ?? '—'})`, value: money(data.partnerTotals[topPartnerIdx] ?? 0), tone: 'positive' },
  ]);

  y = pdfSection(doc, 'Reparto mensual por socio', y + 2);
  autoTable(doc, {
    startY: y,
    head: [['Período', ...data.partnerNames, 'Total']],
    body: data.rows.map((r) => [
      r.periodLabel,
      ...(r.amounts ? r.amounts.map((a) => money(a)) : data.partnerNames.map(() => SIN_DATOS)),
      pdfMoneyOrMissing(r.total),
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
      if (h.section === 'body' && h.cell.raw === SIN_DATOS) {
        h.cell.styles.textColor = C.warning;
        h.cell.styles.fontStyle = 'italic';
      }
    },
  });

  pdfFooter(doc);
  doc.save('Historial_Distribuciones.pdf');
}

// ═══════════════════════════════════════════════════════════
// Informe de Cierre Mensual — resumen ejecutivo del mes
//   (resultado en cascada, flujo de clientes, datos del CRM, egresos,
//    distribución)
//
// REDISEÑO 2026-10-05 (Kevin: «muestra datos en 0 o no los muestra, y hay
// que mejorarle el diseño»). Los números ya no se deciden acá: la cascada,
// el top de egresos, el flujo de clientes y la tabla del CRM salen de
// funciones puras en `monthly-close-pdf-data.ts` (con tests). Este bloque
// solo dibuja, con el sistema compartido (pdfHeader/pdfSection/pdfCards/
// pdfFooter) y la paleta de brand.ts.
//
// Medición que lo motivó (Vex Pro, sep-2026): Broker P&L y Prop Firm en $0,00
// contra 226.605,20 y 13.248,27 reales; Pay-Pros ausente del flujo (93.968,69
// de depósitos, 10.302,17 de retiros); «$-208,084.45» en egresos.
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
  /** Nombre largo del período («Septiembre 2026») — ver `longPeriodLabel`. */
  periodLabel: string;
  /**
   * Facturación del mes. Presente = empresa de servicios: el informe cambia
   * el flujo de depósitos y retiros de clientes por facturación por cliente, y
   * «Otros ingresos» se rotula «Facturación cobrada». Ausente = broker.
   */
  billing?: PdfMonthlyCloseBilling | null;
  /**
   * Los cuatro sumandos de `ingresosNetos`, tal cual `currentChain.desglose`.
   * NUNCA de las tablas manuales (operating_income / prop_firm_sales): desde
   * agosto 2026 Broker P&L y Prop Firm son automáticos y esas tablas están
   * vacías — era el bug de los $0,00.
   */
  desglose: CloseDesglose;
  // Todos de la MISMA cadena de distribución (currentChain)
  ingresosNetos: number;
  egresosNetos: number;
  saldo: number;
  reservaMes: number;
  /** Fracción 0..1 del período (rótulo de la reserva). */
  reservePct: number | null;
  reservaAcumulada: number;
  deudaEntrada: number;
  montoDistribuir: number;
  /** Egresos del período (todas las filas), para el top y su estado. */
  expenses: CloseExpenseInput[];
  egresosPagados: number;
  egresosPendientes: number;
  /** El modelo resta egresos en base caja (features().cashBasisExpenses). */
  cashBasisExpenses: boolean;
  /** Flujo de clientes (solo bróker). null = no aplica a este negocio. */
  clientFlow: ClientFlow | null;
  /** Métricas del CRM que no suman al resultado. Vacío ⇒ no hay sección. */
  crmInfo: CrmInfoRow[];
  /** La serie del CRM vino recortada por el techo de filas del endpoint. */
  crmInfoTruncated?: boolean;
  /**
   * Completitud del período (`computeCheckedChain`). Con una serie del CRM
   * faltante el informe imprime el aviso arriba y «sin datos» —no ceros— en
   * los renglones y totales que dependen de ella (incidente 2026-10-05).
   * Ausente ⇒ completo.
   */
  completeness?: CloseCompleteness | null;
  partners: { name: string; pct: number; amount: number }[];
}

export async function generateMonthlyClosePDF(data: PdfMonthlyCloseData) {
  const doc = new jsPDF('portrait', 'mm', 'a4');
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 14;

  const logoDataUrl = await loadLogoDataUrl(data.companyLogoUrl);
  const generated = generatedOnLabel();
  const header = () =>
    pdfHeader(doc, {
      logoDataUrl,
      title: 'Informe de Cierre Mensual',
      company: data.companyName,
      right: [data.periodLabel, generated],
    });
  /** Salto de página si lo que sigue no entra (deja lugar al pie). */
  const ensureSpace = (y: number, needed: number): number => {
    if (y + needed <= pageH - 16) return y;
    doc.addPage();
    return header();
  };
  /** Línea de aviso en color de atención. Devuelve la Y libre. */
  const warningLine = (text: string, y: number): number => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...C.warning);
    const lines = doc.splitTextToSize(`! ${text}`, pageW - M * 2) as string[];
    doc.text(lines, M, y);
    return y + lines.length * 3.8 + 0.6;
  };
  const toneOf = (n: number): RGB => (n < 0 ? C.negative : C.positive);

  /** Tabla «Datos del CRM (informativo)». Devuelve la Y libre. */
  const drawCrmInfo = (yy: number): number => {
    yy = pdfSection(doc, 'Datos del CRM (informativo)', yy + 2);
    // Dos métricas por fila: son datos de consulta, no merecen media página.
    const crmBody: string[][] = [];
    for (let i = 0; i < data.crmInfo.length; i += 2) {
      const a = data.crmInfo[i];
      const b = data.crmInfo[i + 1];
      crmBody.push([a.label, money(a.amount), b ? b.label : '', b ? money(b.amount) : '']);
    }
    autoTable(doc, {
      startY: yy,
      body: crmBody,
      theme: 'plain',
      styles: { fontSize: 8.5, cellPadding: 1.8, textColor: C.inkSoft },
      alternateRowStyles: { fillColor: C.surface },
      columnStyles: {
        0: { cellWidth: 56 },
        1: { halign: 'right', cellWidth: 33, fontStyle: 'bold', textColor: C.ink },
        2: { cellWidth: 60, cellPadding: { top: 1.8, bottom: 1.8, left: 6, right: 1.8 } },
        3: { halign: 'right', fontStyle: 'bold', textColor: C.ink },
      },
      margin: { left: M, right: M },
    });
    yy = getLastTableY(doc, yy + 30, 3);
    yy = pdfNote(doc, 'Informativo — no suma al resultado. Serie mensual del espejo del CRM.', yy);
    if (data.crmInfoTruncated) {
      yy = warningLine('La serie del CRM vino recortada por el límite de filas: puede estar incompleta', yy);
    }
    return yy + 4;
  };

  const billing = data.billing ?? null;
  const waterfall = buildCloseWaterfall({
    desglose: data.desglose,
    ingresosNetos: data.ingresosNetos,
    egresos: data.egresosNetos,
    saldo: data.saldo,
    reservaMes: data.reservaMes,
    reservePct: data.reservePct,
    deudaEntrada: data.deudaEntrada,
    montoDistribuir: data.montoDistribuir,
    otherLabel: billing ? 'Facturación cobrada' : undefined,
    completeness: data.completeness,
  });
  const exp = buildCloseExpenses(data.expenses, 10);
  const share = partnerShareRows(data.partners, waterfall.distribucionConocida);
  const missing = data.completeness?.incompleto ?? [];

  // ═══ Página 1 — Resultado ═══
  let y = header();
  // Serie del CRM faltante: el aviso va antes que cualquier número.
  if (waterfall.aviso) y = pdfAlertBand(doc, waterfall.aviso, y, M);

  const sources = incomeSourcesLabel(data.desglose, billing ? 'Facturación' : 'Otros');
  const reservaSub =
    data.reservaMes > 0 && data.reservePct != null
      ? `Reserva ${(data.reservePct * 100).toFixed(data.reservePct * 100 === Math.round(data.reservePct * 100) ? 0 : 1)}%`
      : '';
  const sociosSub = `${data.partners.length} ${data.partners.length === 1 ? 'socio' : 'socios'}`;
  y = pdfCards(
    doc,
    y,
    [
      {
        label: 'Ingresos netos',
        value: waterfall.resultadoConocido ? money(data.ingresosNetos) : SIN_DATOS,
        tone: !waterfall.resultadoConocido ? 'ink' : data.ingresosNetos >= 0 ? 'positive' : 'negative',
        sub: missing.length > 0 ? `Falta ${missingSeriesShort(missing)}` : sources || 'Sin ingresos registrados',
      },
      {
        label: 'Egresos',
        value: money(data.egresosNetos),
        tone: 'negative',
        sub: data.cashBasisExpenses
          ? `Base caja · ${exp.count} egresos`
          : `${exp.count} egresos · ${exp.paidCount} pagados`,
      },
      {
        label: 'Resultado del mes',
        value: waterfall.resultadoConocido ? money(data.saldo) : SIN_DATOS,
        tone: !waterfall.resultadoConocido ? 'ink' : data.saldo >= 0 ? 'positive' : 'negative',
        sub: !waterfall.resultadoConocido
          ? 'Ingresos - egresos'
          : data.saldo > 0 ? 'Ingresos - egresos' : 'Mes negativo: no se distribuye',
      },
      {
        label: 'A distribuir',
        value: waterfall.distribucionConocida ? money(data.montoDistribuir) : SIN_DATOS,
        tone: 'accent',
        sub: [reservaSub, sociosSub].filter(Boolean).join(' · '),
      },
    ],
    M,
    24,
  );

  // ─── Cómo se llega al resultado (cascada) ───
  y = pdfSection(doc, 'Cómo se llega al resultado', y + 2);
  y = pdfWaterfallTable(doc, y, waterfall.rows, M);
  for (const w of waterfall.warnings) y = warningLine(w, y + 1);
  if (data.cashBasisExpenses && Math.abs(exp.total - data.egresosNetos) > 0.01) {
    y = pdfNote(
      doc,
      `Base caja: el resultado resta lo pagado en el mes (${money(data.egresosNetos)}), no el total devengado (${money(exp.total)}).`,
      y + 1,
    );
  }
  y += 4;

  if (billing) {
    // ─── Facturación por cliente (empresa de servicios) ───
    y = ensureSpace(y, 40);
    y = pdfSection(doc, 'Facturación por Cliente', y);
    autoTable(doc, {
      startY: y,
      head: [['Cliente', 'Facturado', 'Cobrado', 'Por cobrar']],
      body: billing.clients.map((c) => [c.name, money(c.billed), money(c.collected), money(c.pending)]),
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
      margin: { left: M, right: M },
      didParseCell: (h) => {
        if (h.section === 'foot' && h.column.index > 0) h.cell.styles.halign = 'right';
      },
    });
    y = getLastTableY(doc, y + 30, 5);
    // Banda de lo que falta cobrar: NO entra en el saldo a favor y por lo
    // tanto no se reparte este mes.
    y = ensureSpace(y, 14);
    doc.setFillColor(...C.surface);
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(M, y, pageW - M * 2, 11, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...C.ink);
    doc.text('Facturado sin cobrar (no se distribuye)', M + 4, y + 7);
    doc.setTextColor(...(billing.pending > 0 ? C.negative : C.positive));
    doc.setFontSize(11);
    doc.text(money(billing.pending), pageW - M - 4, y + 7.2, { align: 'right' });
    y += 17;
  } else if (data.clientFlow) {
    // ─── Flujo de clientes (bróker) ───
    const flow = data.clientFlow;
    y = ensureSpace(y, 60);
    y = pdfSection(doc, 'Flujo de Depósitos y Retiros de Clientes', y);
    const maxRows = Math.max(flow.deposits.length, flow.withdrawals.length, 1);
    const amountText = (a: number | null) => (a === null ? 'sin datos' : money(a));
    const flowBody: string[][] = [];
    for (let i = 0; i < maxRows; i++) {
      const d = flow.deposits[i];
      const w = flow.withdrawals[i];
      flowBody.push([d ? d.label : '', d ? amountText(d.amount) : '', w ? w.label : '', w ? amountText(w.amount) : '']);
    }
    autoTable(doc, {
      startY: y,
      head: [['Depósitos por canal', 'Monto', 'Retiros por canal', 'Monto']],
      body: flowBody,
      foot: [['Total depósitos', money(flow.depositsTotal), 'Total retiros', money(flow.withdrawalsTotal)]],
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 2.6 },
      headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
      footStyles: { fillColor: C.surface, textColor: C.primary, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 52 }, 1: { halign: 'right', textColor: C.positive },
        2: { cellWidth: 52 }, 3: { halign: 'right', textColor: C.negative },
      },
      margin: { left: M, right: M },
      didParseCell: (h) => {
        if (h.section === 'foot' && (h.column.index === 1 || h.column.index === 3)) h.cell.styles.halign = 'right';
        if (h.section === 'body' && h.cell.raw === 'sin datos') {
          h.cell.styles.textColor = C.warning;
          h.cell.styles.fontStyle = 'italic';
        }
      },
    });
    y = getLastTableY(doc, y + 30, 4);
    // Banda de flujo neto
    y = ensureSpace(y, 34);
    doc.setFillColor(...C.surface);
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(M, y, pageW - M * 2, 11, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...C.ink);
    doc.text('Flujo neto de clientes (depósitos - retiros)', M + 4, y + 7);
    doc.setTextColor(...toneOf(flow.netFlow));
    doc.setFontSize(11);
    doc.text(money(flow.netFlow), pageW - M - 4, y + 7.2, { align: 'right' });
    y += 15;
    y = pdfCards(
      doc,
      y,
      [
        { label: 'Depósitos totales', value: money(flow.depositsTotal), tone: 'positive' },
        { label: 'Retiros totales', value: money(flow.withdrawalsTotal), tone: 'negative' },
        { label: 'Flujo neto', value: money(flow.netFlow), tone: flow.netFlow >= 0 ? 'positive' : 'negative' },
      ],
      M,
      18,
    );
    for (const w of flow.warnings) y = warningLine(w, y);
  }

  // ─── Datos del CRM (informativo) — al pie de la página 1 si entra ───
  // Es lo menos importante del informe: si no entra en la página 1 va al
  // final, después de la distribución, para no empujar la tabla de socios a
  // una tercera página.
  const crmNeeded = 26 + Math.ceil(data.crmInfo.length / 2) * 7;
  const crmOnPage1 = data.crmInfo.length > 0 && y + crmNeeded - 4 <= pageH - 13;
  if (crmOnPage1) y = drawCrmInfo(y);

  // ═══ Página 2 — Egresos y distribución ═══
  doc.addPage();
  y = header();

  // ─── Egresos ───
  y = ensureSpace(y, 50);
  y = pdfSection(doc, 'Egresos del Mes', y);
  y = pdfCards(doc, y, [
    { label: 'Egresos pagados', value: money(data.egresosPagados), tone: 'positive' },
    { label: 'Egresos pendientes', value: money(data.egresosPendientes), tone: data.egresosPendientes > 0 ? 'negative' : 'ink' },
    { label: 'Reserva del mes', value: waterfall.distribucionConocida ? money(data.reservaMes) : SIN_DATOS, tone: 'ink' },
    { label: 'Reserva acumulada', value: waterfall.distribucionConocida ? money(data.reservaAcumulada) : SIN_DATOS, tone: 'primary' },
  ], M, 18);

  if (exp.count > 0) {
    y = pdfSection(doc, 'Principales Egresos', y + 1);
    const pct = (f: number) => `${(f * 100).toFixed(1)}%`;
    const statusLabel = { pagado: 'Pagado', pendiente: 'Pendiente', parcial: 'Parcial' } as const;
    const body = exp.top.map((e) => [e.concept, statusLabel[e.status], pct(e.share), money(e.amount)]);
    if (exp.others) {
      body.push([
        `Otros ${exp.others.count} ${exp.others.count === 1 ? 'egreso' : 'egresos'}`,
        '',
        pct(exp.others.share),
        money(exp.others.amount),
      ]);
    }
    const othersIdx = exp.others ? body.length - 1 : -1;
    autoTable(doc, {
      startY: y,
      head: [['Concepto', 'Estado', '% del total', 'Monto']],
      body,
      foot: [['Total egresos del mes', '', exp.total > 0 ? '100%' : '', money(exp.total)]],
      theme: 'striped',
      styles: { fontSize: 9, cellPadding: 2.3 },
      headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.surface },
      footStyles: { fillColor: [234, 241, 250], textColor: C.primary, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 92 },
        1: { cellWidth: 26 },
        2: { halign: 'right', cellWidth: 24, textColor: C.muted },
        3: { halign: 'right', fontStyle: 'bold', textColor: C.negative },
      },
      margin: { left: M, right: M },
      didParseCell: (h) => {
        if ((h.section === 'foot' || h.section === 'head') && h.column.index >= 2) h.cell.styles.halign = 'right';
        if (h.section !== 'body') return;
        if (h.row.index === othersIdx) h.cell.styles.fontStyle = 'italic';
        if (h.column.index === 1) {
          const v = h.cell.raw;
          h.cell.styles.textColor = v === 'Pagado' ? C.positive : v === 'Pendiente' ? C.warning : C.inkSoft;
        }
      },
    });
    y = getLastTableY(doc, y + 40, 8);
  } else {
    y = pdfNote(doc, 'Sin egresos cargados en el mes.', y);
    y += 4;
  }

  // ─── Distribución a socios ───
  y = ensureSpace(y, 30 + data.partners.length * 8);
  y = pdfSection(doc, 'Distribución a Socios', y);
  if (waterfall.distribucionConocida && data.deudaEntrada > 0) {
    doc.setFontSize(8);
    doc.setTextColor(...C.warning);
    doc.setFont('helvetica', 'normal');
    doc.text(`Deuda arrastrada del mes anterior descontada: ${money(data.deudaEntrada)}`, M, y);
    y += 5;
  }
  const afterPartners = pdfPartnerTable(doc, y, share.rows, share.total, M);

  if (data.crmInfo.length > 0 && !crmOnPage1) {
    y = ensureSpace(afterPartners, crmNeeded);
    drawCrmInfo(y);
  }

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
    debt: 'Deuda con terceros',
    total: 'Total consolidado', channels: 'Canales',
    autoNote: 'Libro escrito automáticamente cada día a las 00:00 UTC con los datos de la API del proveedor. El saldo de cierre coincide con el saldo real reportado por el proveedor.',
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
    debt: 'Debt to third parties',
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
  /**
   * `balance` llega CON SIGNO: un lugar `debt` (préstamo recibido) viene en
   * negativo, así las filas cierran contra `total`. `debt` solo cambia el
   * rótulo de la columna Tipo.
   */
  channels: Array<{ label: string; isAuto: boolean; balance: number; debt?: boolean }>;
  /** Neto de deuda (`tallyCash`). */
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
    body: data.channels.map((c) => [
      c.label,
      c.debt ? L.debt : c.isAuto ? L.auto : L.manual,
      money(c.balance),
    ]),
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

// ═══════════════════════════════════════════════════════════════════════════════
// Informe de exposición y PNL por categoría de cuenta.
//
// ── EL DINERO NO SE SUMA, TAMPOCO EN PDF ───────────────────────────────────
// Es la misma regla que en la pantalla, y en papel importa MÁS: un PDF se
// imprime, se manda por correo y se lee fuera de contexto meses después, sin
// nadie al lado que aclare que esa columna estaba en centavos. Por eso cada
// importe lleva su unidad pegada y NO hay fila de total general.
//
// Sumar CENT con USD daría un número enorme, perfectamente creíble y falso:
// las cuentas Cent están denominadas en centavos y las PropFirm llevan capital
// virtual de desafío.
// ═══════════════════════════════════════════════════════════════════════════════

const EXPOSURE_T = {
  es: {
    title: 'Exposición y PNL', period: 'Período', generated: 'Generado',
    liveSection: 'PNL en vivo por categoría', historySection: 'Cierres diarios',
    category: 'Categoría', unit: 'Unidad', openPnl: 'PNL abierto',
    closedPnl: 'PNL cerrado', positions: 'Posiciones', accounts: 'Cuentas',
    deals: 'Operaciones', day: 'Día', outsideCrm: 'Fuera del CRM',
    inProgress: 'en curso', asOf: 'Foto del',
    noSum: 'Los importes NO se suman entre categorías: las cuentas Cent están denominadas en CENTAVOS y las PropFirm llevan capital virtual de desafío. Cada importe lleva su unidad.',
    scope: 'Solo cuentas live que además existen en el CRM. Lo que está en MetaTrader y no en el CRM son cuentas de prueba y queda fuera. Los cortes del día son UTC.',
    todayNote: 'El día de hoy sigue en curso: su cifra es "hasta ahora", no un cierre, y no es comparable con un día entero.',
  },
  en: {
    title: 'Exposure and P&L', period: 'Period', generated: 'Generated',
    liveSection: 'Live P&L by category', historySection: 'Daily closes',
    category: 'Category', unit: 'Unit', openPnl: 'Open P&L',
    closedPnl: 'Closed P&L', positions: 'Positions', accounts: 'Accounts',
    deals: 'Trades', day: 'Day', outsideCrm: 'Outside CRM',
    inProgress: 'in progress', asOf: 'Snapshot of',
    noSum: 'Amounts are NOT summed across categories: Cent accounts are denominated in CENTS and PropFirm carries virtual challenge capital. Every amount carries its unit.',
    scope: 'Only live accounts that also exist in the CRM. What is in MetaTrader but not in the CRM are test accounts and stay out. Day cut-offs are UTC.',
    todayNote: 'Today is still in progress: its figure is "so far", not a close, and is not comparable with a full day.',
  },
} as const;

export interface PdfExposureRow {
  utc_day: string;
  category: string;
  open_positions: number;
  open_accounts: number;
  open_pnl: number | null;
  closed_deals: number;
  closed_accounts: number;
  closed_pnl: number | null;
  accounts_outside_crm: number;
}

export interface PdfExposureData {
  company: { name: string; logoUrl?: string | null };
  range: { from: string; to: string };
  snapshotAt: string;
  /** La foto más reciente, una fila por categoría. */
  live: PdfExposureRow[];
  /** El cierre de cada día del rango. */
  history: PdfExposureRow[];
  locale?: LedgerLocale;
}

/** Sólo CENT está en centavos. Misma regla que en la pantalla. */
const exposureUnit = (categoria: string) => (categoria === 'CENT' ? 'cent' : 'USD');

/** Importe CON su unidad. Nunca un número de dinero solo. */
const exposureAmount = (n: number | null, categoria: string) =>
  n === null ? '—' : `${fmt(n)} ${categoria === 'CENT' ? 'cent' : 'USD'}`;

export async function generateExposurePDF(data: PdfExposureData) {
  const L = EXPOSURE_T[data.locale ?? 'es'];
  // Apaisado: la tabla de cierres tiene nueve columnas y en vertical los
  // importes se parten en dos líneas.
  const doc = new jsPDF('landscape', 'mm', 'a4');
  const hoy = new Date().toISOString().slice(0, 10);

  const logoDataUrl = await loadLogoDataUrl(data.company.logoUrl);
  let y = pdfHeader(doc, {
    logoDataUrl,
    title: L.title,
    company: data.company.name,
    right: [
      `${L.period} ${data.range.from} — ${data.range.to}`,
      `${L.asOf} ${new Date(data.snapshotAt).toLocaleString()}`,
      `${L.generated}: ${new Date().toLocaleDateString()}`,
    ],
  });

  // Una tarjeta por categoría con su PNL abierto. La unidad va DENTRO del
  // valor, no en el label: un label se recorta, el valor no.
  if (data.live.length > 0) {
    y = pdfCards(
      doc,
      y,
      data.live.map((r) => ({
        label: `${r.category} · ${L.openPnl}`,
        value: exposureAmount(r.open_pnl, r.category),
        tone: (r.open_pnl ?? 0) < 0 ? ('negative' as const) : ('positive' as const),
      })),
    );
  }

  y = pdfSection(doc, L.liveSection, y + 2);
  autoTable(doc, {
    startY: y,
    head: [[L.category, L.unit, L.openPnl, L.positions, L.accounts, L.closedPnl, L.deals, L.outsideCrm]],
    body: data.live.map((r) => [
      r.category,
      exposureUnit(r.category),
      exposureAmount(r.open_pnl, r.category),
      fmt(r.open_positions),
      fmt(r.open_accounts),
      exposureAmount(r.closed_pnl, r.category),
      fmt(r.closed_deals),
      r.accounts_outside_crm > 0 ? fmt(r.accounts_outside_crm) : '—',
    ]),
    theme: 'striped',
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    columnStyles: {
      1: { halign: 'center' },
      2: { halign: 'right', fontStyle: 'bold' },
      3: { halign: 'right' }, 4: { halign: 'right' },
      5: { halign: 'right', fontStyle: 'bold' },
      6: { halign: 'right' }, 7: { halign: 'right' },
    },
    margin: { left: 14, right: 14 },
  });

  y = pdfSection(doc, L.historySection, getLastTableY(doc, y + 40));
  autoTable(doc, {
    startY: y,
    head: [[L.day, L.category, L.closedPnl, L.deals, L.accounts, L.openPnl, L.positions, L.outsideCrm]],
    body: data.history.map((r) => [
      // El día en curso se marca EN LA FILA. Sin eso, un PDF leído en otro
      // momento muestra un día corto como si hubiera cerrado así.
      r.utc_day === hoy ? `${r.utc_day} (${L.inProgress})` : r.utc_day,
      r.category,
      exposureAmount(r.closed_pnl, r.category),
      fmt(r.closed_deals),
      fmt(r.closed_accounts),
      exposureAmount(r.open_pnl, r.category),
      fmt(r.open_positions),
      r.accounts_outside_crm > 0 ? fmt(r.accounts_outside_crm) : '—',
    ]),
    theme: 'striped',
    styles: { fontSize: 8.5, cellPadding: 2.2 },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    columnStyles: {
      2: { halign: 'right', fontStyle: 'bold' },
      3: { halign: 'right' }, 4: { halign: 'right' },
      5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' },
    },
    margin: { left: 14, right: 14 },
  });

  // Las tres advertencias van al final y en el documento, no en un pie de
  // pantalla que no viaja con el archivo.
  let ny = getLastTableY(doc, y + 40, 6);
  const w = doc.internal.pageSize.getWidth();
  doc.setFontSize(7.5);
  doc.setTextColor(...C.muted);
  doc.setFont('helvetica', 'normal');
  for (const nota of [L.noSum, L.scope, L.todayNote]) {
    const lineas = doc.splitTextToSize(nota, w - 28) as string[];
    // Si no entra, se pasa de página: una nota partida a la mitad por el borde
    // inferior es una nota que nadie lee.
    if (ny + lineas.length * 3.4 > doc.internal.pageSize.getHeight() - 16) {
      doc.addPage();
      ny = 20;
    }
    doc.text(lineas, 14, ny);
    ny += lineas.length * 3.4 + 2.5;
  }

  pdfFooter(doc);
  doc.save(`Exposicion_PNL_${data.range.from}_${data.range.to}.pdf`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prueba de revisión de un retiro de prop firm — EN INGLÉS, para el cliente.
//
// ── POR QUÉ ESTE DOCUMENTO ESTÁ EN INGLÉS Y LOS DEMÁS NO ───────────────────
// Kevin, 2026-08-27: «permite descargar un informe en inglés bien bonito que
// se le pueda enviar al cliente en pdf (con logos y colores de marca) como
// prueba de la revisión». No es un informe interno traducido: es el único PDF
// de la casa cuyo lector es el trader, no el revisor. Por eso no pasa por el
// diccionario es/en de los otros —no tiene versión en español que mantener— y
// por eso el disclaimer del pie es parte del contenido y no una nota de
// pantalla: el archivo viaja solo, sin la pantalla que lo generó.
//
// ── «NOT VERIFIABLE» NUNCA SE PINTA COMO CUMPLIDA ──────────────────────────
// Es la doctrina del módulo entero (ver propfirm-auto.ts): una regla sin
// comprobar NO está cumplida, está sin mirar. En un documento que se le manda
// al cliente el riesgo es mayor que en la pantalla —acá quedaría escrito— así
// que las tres categorías se cuentan por separado en las tarjetas, la columna
// de resultado dice literalmente «Not verifiable» y el pie lo explica.
// ═══════════════════════════════════════════════════════════════════════════════

export interface PdfPropfirmReviewCheck {
  label: string;
  status: 'pass' | 'fail' | 'unverifiable';
  detail: string;
  whyNot?: string;
}

export interface PdfPropfirmReviewData {
  company: { name: string; logoUrl?: string | null };
  withdrawal: {
    client: string;
    email: string | null;
    account: number | null;
    program: string | null;
    amount: number;
    requestedAt: string | null;
    status: string | null;
  };
  /** Período revisado. `startedAt` null = no se encontró el inicio del ciclo. */
  cycle: { startedAt: string | null; startedBy: string; excludedTrades: number } | null;
  outcome: string | null;
  checks: PdfPropfirmReviewCheck[];
  facts: {
    maxDrawdown: number;
    maxDrawdownPct: number | null;
    accountSize: number | null;
    netResult: number;
    durations: Array<{ label: string; count: number; profit: number }>;
  } | null;
  reviewedAt: string | null;
}

/** Lo que el REGLAMENTO establece, dicho en inglés y sin prometer una decisión. */
const PROPFIRM_OUTCOME_EN: Record<string, string> = {
  ok: 'No rule violations found',
  denied_new_period: 'Rulebook: payout denied, new trading period granted',
  denied_no_new_period: 'Rulebook: payout denied, no new trading period',
  cannot_review: 'Could not be reviewed',
};

const CHECK_STATUS_EN: Record<PdfPropfirmReviewCheck['status'], string> = {
  pass: 'Passed',
  fail: 'Failed',
  // Nunca «passed with reservations» ni un guion: el cliente tiene que leer
  // que esa regla no se miró.
  unverifiable: 'Not verifiable',
};

export async function generatePropfirmReviewPDF(data: PdfPropfirmReviewData) {
  const doc = new jsPDF('portrait', 'mm', 'a4');
  const logoDataUrl = await loadLogoDataUrl(data.company.logoUrl);

  const fecha = (iso: string | null | undefined) =>
    iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';

  let y = pdfHeader(doc, {
    logoDataUrl,
    title: 'Withdrawal Review Report',
    company: data.company.name,
    right: [
      `Account ${data.withdrawal.account ?? '—'}`,
      `Reviewed: ${fecha(data.reviewedAt)}`,
    ],
  });

  const pasa = data.checks.filter((c) => c.status === 'pass').length;
  const falla = data.checks.filter((c) => c.status === 'fail').length;
  const sinMirar = data.checks.filter((c) => c.status === 'unverifiable').length;

  // Los tres números SIEMPRE juntos, igual que en la pantalla: un solo
  // semáforo escondería justamente el que importa.
  y = pdfCards(doc, y, [
    { label: 'Requested amount', value: money(data.withdrawal.amount), tone: 'primary' },
    { label: 'Rules passed', value: String(pasa), tone: 'positive' },
    { label: 'Rules failed', value: String(falla), tone: falla > 0 ? 'negative' : 'ink' },
    { label: 'Not verifiable', value: String(sinMirar), tone: sinMirar > 0 ? 'accent' : 'ink' },
  ]);

  // ── Datos del retiro ─────────────────────────────────────────────────────
  y = pdfSection(doc, 'Withdrawal request', y + 2);
  autoTable(doc, {
    startY: y,
    body: [
      ['Client', data.withdrawal.client],
      ['Email', data.withdrawal.email ?? '—'],
      ['Trading account', String(data.withdrawal.account ?? '—')],
      ['Program', data.withdrawal.program ?? '—'],
      ['Amount requested', money(data.withdrawal.amount)],
      ['Requested on', fecha(data.withdrawal.requestedAt)],
      ['Status in CRM', data.withdrawal.status ?? '—'],
      [
        'Trading period reviewed',
        data.cycle
          ? `${data.cycle.startedAt ? data.cycle.startedAt.slice(0, 10) : 'account inception'} — ${data.withdrawal.requestedAt ? data.withdrawal.requestedAt.slice(0, 10) : 'request date'}` +
            (data.cycle.startedBy === 'retiro_pagado' ? ' (period started at the last paid withdrawal)' : ' (period started at account creation)')
          : '—',
      ],
    ],
    theme: 'plain',
    styles: { fontSize: 9.5, cellPadding: 1.8 },
    columnStyles: { 0: { fontStyle: 'bold', textColor: C.muted, cellWidth: 52 } },
    margin: { left: 14, right: 14 },
  });

  // ── Regla por regla ──────────────────────────────────────────────────────
  y = pdfSection(doc, 'Rule-by-rule result', getLastTableY(doc, y + 40));
  autoTable(doc, {
    startY: y,
    head: [['Rule', 'Result', 'What was measured']],
    body: data.checks.map((c) => [
      c.label,
      CHECK_STATUS_EN[c.status],
      c.status === 'unverifiable' ? (c.whyNot ?? 'This rule was not checked.') : c.detail,
    ]),
    theme: 'striped',
    styles: { fontSize: 8.8, cellPadding: 2.2, valign: 'top' },
    headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: C.surface },
    columnStyles: { 0: { cellWidth: 46, fontStyle: 'bold' }, 1: { cellWidth: 26 }, 2: { cellWidth: 'auto' } },
    // El color va en la CELDA del resultado, no en la fila entera: pintar la
    // fila de rojo entero hace ilegible el texto de lo medido.
    didParseCell: (hook) => {
      if (hook.section !== 'body' || hook.column.index !== 1) return;
      const s = data.checks[hook.row.index]?.status;
      if (s === 'fail') { hook.cell.styles.textColor = C.negative; hook.cell.styles.fontStyle = 'bold'; }
      else if (s === 'pass') { hook.cell.styles.textColor = C.positive; }
      else { hook.cell.styles.textColor = C.warning; hook.cell.styles.fontStyle = 'bold'; }
    },
    margin: { left: 14, right: 14 },
  });

  // ── Los datos del ciclo ──────────────────────────────────────────────────
  if (data.facts) {
    y = pdfSection(doc, 'Cycle figures', getLastTableY(doc, y + 40));
    autoTable(doc, {
      startY: y,
      body: [
        [
          'Maximum drawdown of the cycle',
          data.facts.maxDrawdownPct !== null
            ? `${money(data.facts.maxDrawdown)} (${data.facts.maxDrawdownPct}% of ${money(data.facts.accountSize ?? 0)})`
            : money(data.facts.maxDrawdown),
        ],
        ['Net result of the cycle', money(data.facts.netResult)],
      ],
      theme: 'plain',
      styles: { fontSize: 9.5, cellPadding: 1.8 },
      columnStyles: { 0: { fontStyle: 'bold', textColor: C.muted, cellWidth: 68 } },
      margin: { left: 14, right: 14 },
    });

    if (data.facts.durations.length > 0) {
      y = pdfSection(doc, 'Trade duration distribution', getLastTableY(doc, y + 30));
      autoTable(doc, {
        startY: y,
        head: [['Duration', 'Trades', 'Result']],
        body: data.facts.durations.map((d) => [d.label, fmt(d.count), money(d.profit)]),
        theme: 'striped',
        styles: { fontSize: 9, cellPadding: 2 },
        headStyles: { fillColor: C.primary, textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: C.surface },
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
        margin: { left: 14, right: 14 },
      });
    }
  }

  // ── El veredicto del reglamento y el disclaimer ──────────────────────────
  let ny = getLastTableY(doc, y + 40, 8);
  const w = doc.internal.pageSize.getWidth();
  const alto = doc.internal.pageSize.getHeight();
  const notas = [
    `Rulebook outcome: ${data.outcome ? (PROPFIRM_OUTCOME_EN[data.outcome] ?? data.outcome) : 'not available'}.`,
    'This report states what the program rulebook provides for the number of rule violations found. ' +
      'It is not an approval or a rejection: payouts are authorised separately.',
    sinMirar > 0
      ? `${sinMirar} rule(s) are marked "Not verifiable". They were NOT checked and must not be read as compliant: ` +
        'the data required to verify them is not available to this review.'
      : 'Every rule of the program was checked.',
    'The maximum drawdown above is measured on closed trades (balance). The CRM measures it on equity, ' +
      'which includes floating positions, so its figure will be equal or higher — and that is the one that disqualifies an account.',
    'Trades are taken from the trading server for the current trading cycle only: the cycle that started at the ' +
      'last paid withdrawal, or at account creation when no withdrawal has been paid yet.',
  ];
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...C.muted);
  for (const nota of notas) {
    const lineas = doc.splitTextToSize(nota, w - 28) as string[];
    if (ny + lineas.length * 3.6 > alto - 16) { doc.addPage(); ny = 20; }
    doc.text(lineas, 14, ny);
    ny += lineas.length * 3.6 + 2.6;
  }

  pdfFooter(doc);
  doc.save(`Withdrawal_Review_${data.withdrawal.account ?? 'account'}_${(data.withdrawal.requestedAt ?? '').slice(0, 10) || 'report'}.pdf`);
}
