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
import { UNASSIGNED_CLIENT_KEY, UNCATEGORIZED, formatShare, type CompanyReport } from './company-report';
import { LOCATION_TYPE_LABELS } from '@/lib/cash-locations';
import type { ReportCadence } from './email-template';
import jsPDF from 'jspdf';
import { BRAND_RGB, hexToRgb } from '@/lib/brand';
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
  /**
   * Reporte de una empresa de servicios. Cuando viene, REEMPLAZA las secciones
   * de broker: son las de un negocio que no tiene depósitos ni P&L. La
   * portada, el pie y la paginación son los mismos — el destinatario recibe
   * el mismo documento, con el contenido de su modelo.
   */
  companyReport?: CompanyReport;
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

/**
 * Loads a public asset as a data URL. jsPDF requires base64-encoded
 * images — it can't fetch from a URL directly. Returns null on failure
 * (network, 404) so the PDF still renders without the brand mark.
 */
async function assetToDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Dibuja una imagen CONTENIDA en una caja, respetando su relación de aspecto.
//
// Antes cada addImage fijaba ancho Y alto (140x80 en la portada, 90x24 y 60x14
// en los pies). jsPDF estira la imagen hasta llenar esa caja, así que todo
// logo que no midiera exactamente esa proporción salía deformado — que es
// justo lo que se veía mal en los reportes. Los logos de marca vienen en
// proporciones muy distintas (cuadrados, horizontales, isotipos), así que
// fijar las dos medidas nunca podía funcionar.
//
// Ahora se leen las medidas reales y se escala por el lado que primero toca
// el borde, centrando el resultado dentro de la caja.
// ─────────────────────────────────────────────────────────────────────────────
function drawImageContained(
  doc: jsPDF,
  dataUrl: string,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
): boolean {
  try {
    const props = doc.getImageProperties(dataUrl);
    if (!props?.width || !props?.height) return false;

    const scale = Math.min(boxW / props.width, boxH / props.height);
    const w = props.width * scale;
    const h = props.height * scale;
    const x = boxX + (boxW - w) / 2;
    const y = boxY + (boxH - h) / 2;

    // El formato sale de las props: forzar 'PNG' sobre un JPEG hacía fallar
    // el addImage y caer al texto de respaldo.
    const format = (props.fileType || 'PNG').toUpperCase();
    doc.addImage(dataUrl, format, x, y, w, h, undefined, 'FAST');
    return true;
  } catch {
    return false;
  }
}

export async function downloadReportPDF(params: DownloadReportPdfParams): Promise<void> {
  const {
    data,
    cadence,
    companyName,
    companyLogoDataUrl,
    primaryColor,
    companyReport,
    sections = {
      deposits_withdrawals: true,
      balances_by_channel: true,
      crm_users: true,
      broker_pnl: true,
      prop_trading: true,
    },
  } = params;

  const brokerSections: ReportSectionToggles = companyReport
    ? {
        deposits_withdrawals: false,
        balances_by_channel: false,
        crm_users: false,
        broker_pnl: false,
        prop_trading: false,
      }
    : sections;

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const MARGIN_X = 40;
  const primary = hexToRgb(primaryColor);

  // Smart Dashboard brand logo — loaded once, reused on cover + every footer.
  // PNG because jsPDF needs a rasterised image with a proper data URL header.
  // Fallback to text mark if the fetch fails (offline, 404, etc.).
  const brandLogoDataUrl = await assetToDataUrl('/brand/logo-black.png');

  // ─── Cover page ───
  drawCoverPage(doc, {
    companyName,
    companyLogoDataUrl,
    brandLogoDataUrl,
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
    doc.setTextColor(...BRAND_RGB.white);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text(label, MARGIN_X + 12, cursorY + 18);
    cursorY += 40;
  };

  const addSubHeader = (label: string) => {
    doc.setTextColor(...BRAND_RGB.inkSoft); // slate-700
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
      doc.setFillColor(...BRAND_RGB.surface); // slate-50
      doc.setDrawColor(...BRAND_RGB.border); // slate-200
      doc.roundedRect(x, cursorY, boxW, boxH, 4, 4, 'FD');
      doc.setTextColor(...BRAND_RGB.muted); // slate-500
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.text(k.label.toUpperCase(), x + 10, cursorY + 16);
      if (k.tone === 'ok') doc.setTextColor(...BRAND_RGB.positive); // emerald-500
      else if (k.tone === 'bad') doc.setTextColor(...BRAND_RGB.negative); // red-500
      else doc.setTextColor(...BRAND_RGB.ink); // slate-900
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text(k.value, x + 10, cursorY + 38);
    });
    cursorY += boxH + 18;
  };

  const addEmptyNote = (text: string) => {
    doc.setTextColor(...BRAND_RGB.muted);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'italic');
    doc.text(text, MARGIN_X, cursorY);
    cursorY += 24;
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
  if (brokerSections.deposits_withdrawals) {
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
  if (brokerSections.balances_by_channel) {
    addSectionHeader('Balances por Canal');
    const b = data.balances_by_channel;
    if (b.channels.length === 0) {
      doc.setTextColor(...BRAND_RGB.muted);
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
          // Sin dato (ni libro ni snapshot) se imprime 's/d': un $0,00 se
          // leería como "la cuenta está vacía".
          c.source === 'missing' ? 's/d' : fmtCurrency(c.amount),
        ]),
        [['Total Consolidado', '', fmtCurrency(b.total)]],
      );
    }
  }

  // ─── Section: Usuarios CRM ───
  if (brokerSections.crm_users && (data.crm_users.connected || data.crm_users.isMock)) {
    addSectionHeader('Usuarios CRM');
    addKpiRow([
      { label: 'Nuevos en el rango', value: data.crm_users.new_users_in_range.toLocaleString('es') },
      { label: 'Nuevos este mes', value: data.crm_users.new_users_this_month.toLocaleString('es') },
      { label: 'Total en plataforma', value: data.crm_users.total_users.toLocaleString('es') },
    ]);
  }

  // ─── Section: Broker P&L ───
  if (brokerSections.broker_pnl && (data.broker_pnl.connected || data.broker_pnl.isMock)) {
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
  if (brokerSections.prop_trading && (data.prop_trading.connected || data.prop_trading.isMock)) {
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

  // ─── Secciones de una empresa de servicios ───
  if (companyReport) {
    const r = companyReport;

    addSectionHeader('Facturación del período');
    addKpiRow([
      { label: 'Total facturado', value: fmtCurrency(r.billing.billed) },
      { label: 'Cobrado', value: fmtCurrency(r.billing.collected), tone: 'ok' },
      {
        label: 'Por cobrar',
        value: fmtCurrency(r.billing.pending),
        tone: r.billing.pending > 0 ? 'bad' : 'neutral',
      },
    ]);
    if (r.billing.clients.length === 0) {
      addEmptyNote('Sin facturación en el período.');
    } else {
      addSubHeader('Por cliente');
      renderAutoTable(
        [['Cliente', 'Facturado', 'Cobrado', 'Por cobrar']],
        r.billing.clients.map((c) => [
          c.key === UNASSIGNED_CLIENT_KEY ? 'Sin cliente' : c.name,
          fmtCurrency(c.billed),
          fmtCurrency(c.collected),
          fmtCurrency(c.pending),
        ]),
        [[
          'Total',
          fmtCurrency(r.billing.billed),
          fmtCurrency(r.billing.collected),
          fmtCurrency(r.billing.pending),
        ]],
      );
    }

    addSectionHeader('Egresos del período');
    addKpiRow([
      { label: 'Total', value: fmtCurrency(r.expenses.total) },
      { label: 'Pagado', value: fmtCurrency(r.expenses.paid), tone: 'ok' },
      {
        label: 'Pendiente',
        value: fmtCurrency(r.expenses.pending),
        tone: r.expenses.pending > 0 ? 'bad' : 'neutral',
      },
    ]);
    if (r.expenses.categories.length === 0) {
      addEmptyNote('Sin egresos en el período.');
    } else {
      addSubHeader('Por categoría');
      renderAutoTable(
        [['Categoría', '#', 'Monto', 'Pendiente']],
        r.expenses.categories.map((c) => [
          c.category === UNCATEGORIZED ? 'Sin categoría' : c.category,
          String(c.count),
          fmtCurrency(c.amount),
          fmtCurrency(c.pending),
        ]),
        [['Total', '', fmtCurrency(r.expenses.total), fmtCurrency(r.expenses.pending)]],
      );
    }

    addSectionHeader('Resultado del período');
    addKpiRow([
      {
        label: 'Resultado de caja',
        value: fmtCurrency(r.result.cashResult),
        tone: r.result.cashResult >= 0 ? 'ok' : 'bad',
      },
      {
        label: 'Saldo a favor',
        value: fmtCurrency(r.result.saldoAFavor),
        tone: r.result.saldoAFavor >= 0 ? 'ok' : 'bad',
      },
      { label: 'A distribuir', value: fmtCurrency(r.result.montoDistribuir) },
    ]);
    renderAutoTable(
      [['Concepto', 'Monto']],
      [
        ['Cobrado a clientes', fmtCurrency(r.result.collected)],
        ['Egresos pagados', fmtCurrency(r.result.paidExpenses)],
        ['Ingresos netos', fmtCurrency(r.result.ingresosNetos)],
        ['Egresos netos', fmtCurrency(r.result.egresosNetos)],
        ['Reserva del período', fmtCurrency(r.result.reserveThisPeriod)],
      ],
      [['Monto a distribuir', fmtCurrency(r.result.montoDistribuir)]],
    );

    addSectionHeader('Dónde está el dinero');
    addKpiRow([
      { label: 'Disponible', value: fmtCurrency(r.cash.summary.liquid), tone: 'ok' },
      {
        label: 'Prestado',
        value: fmtCurrency(r.cash.summary.lent),
        tone: r.cash.summary.lent > 0 ? 'bad' : 'neutral',
      },
      { label: 'Total', value: fmtCurrency(r.cash.summary.total) },
    ]);
    // Una ubicación compartida sale una vez por unidad dueña, con su parte.
    // El "· 60% de $X" no es decorativo: sin él dos filas de la misma wallet
    // con montos distintos parecen un error de carga.
    const cashRows = r.cash.byUnit.flatMap((g) =>
      g.locations.map((l) => [
        [
          l.holder ? `${l.label} · ${l.holder}` : l.label,
          l.share < 0.9999 ? `compartida — ${formatShare(l.share)}% de ${fmtCurrency(l.fullBalance)}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        LOCATION_TYPE_LABELS[l.location_type].es,
        g.unit?.name ?? 'Sin unidad',
        fmtCurrency(l.balance),
      ]),
    );
    if (cashRows.length === 0) {
      addEmptyNote('Sin ubicaciones configuradas.');
    } else {
      renderAutoTable(
        [['Ubicación', 'Tipo', 'Unidad', 'Saldo']],
        cashRows,
        [['Total', '', '', fmtCurrency(r.cash.summary.total)]],
      );
    }
  }

  // ─── Footer on every page ───
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    drawFooter(doc, { pageNum: i, totalPages, companyName, primary, brandLogoDataUrl });
  }

  // ─── Download ───
  const range = companyReport?.range ?? data.range;
  const fileName =
    params.fileName ??
    `reporte_${companyName.replace(/\s+/g, '_')}_${range.from}_${range.to}.pdf`;
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
  /** Smart Dashboard brand mark (black on transparent). Used in the cover
   *  bottom-centre as the platform signature. */
  brandLogoDataUrl?: string | null;
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
  // La caja es el LÍMITE, no el tamaño: el logo se ajusta adentro sin
  // deformarse, sea cuadrado, horizontal o un isotipo.
  const drewLogo =
    !!p.companyLogoDataUrl &&
    drawImageContained(doc, p.companyLogoDataUrl, centerX - 100, logoTop, 200, 90);

  if (!drewLogo) {
    doc.setTextColor(p.primary[0], p.primary[1], p.primary[2]);
    doc.setFontSize(28);
    doc.setFont('helvetica', 'bold');
    doc.text(p.companyName, centerX, logoTop + 40, { align: 'center' });
  }

  // Title.
  doc.setTextColor(...BRAND_RGB.ink);
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text(p.title, centerX, logoTop + 160, { align: 'center' });

  // Divider.
  doc.setDrawColor(p.primary[0], p.primary[1], p.primary[2]);
  doc.setLineWidth(2);
  doc.line(centerX - 80, logoTop + 180, centerX + 80, logoTop + 180);

  // Period.
  doc.setTextColor(...BRAND_RGB.inkSoft);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `Período: ${fmtDateEs(p.range.from)} — ${fmtDateEs(p.range.to)}`,
    centerX,
    logoTop + 210,
    { align: 'center' },
  );

  // Generated on.
  doc.setTextColor(...BRAND_RGB.muted);
  doc.setFontSize(10);
  const now = new Date();
  doc.text(
    `Generado: ${now.toLocaleDateString('es')} ${now.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`,
    centerX,
    logoTop + 232,
    { align: 'center' },
  );

  // Footer on cover — Smart Dashboard brand logo + confidentiality note.
  const drewBrand =
    !!p.brandLogoDataUrl &&
    drawImageContained(doc, p.brandLogoDataUrl, centerX - 60, pageHeight - 74, 120, 30);

  if (!drewBrand) {
    doc.setTextColor(...BRAND_RGB.mutedLight);
    doc.setFontSize(9);
    doc.text('Smart Dashboard', centerX, pageHeight - 50, { align: 'center' });
  }
  doc.setTextColor(...BRAND_RGB.mutedLight);
  doc.setFontSize(9);
  doc.text('Documento confidencial', centerX, pageHeight - 30, { align: 'center' });
}

interface FooterParams {
  pageNum: number;
  totalPages: number;
  companyName: string;
  primary: [number, number, number];
  brandLogoDataUrl?: string | null;
}

function drawFooter(doc: jsPDF, p: FooterParams): void {
  // Cover page already has its own footer; skip it.
  if (p.pageNum === 1) return;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const MARGIN_X = 40;

  // Divider line.
  doc.setDrawColor(...BRAND_RGB.border);
  doc.setLineWidth(0.5);
  doc.line(MARGIN_X, pageHeight - 40, pageWidth - MARGIN_X, pageHeight - 40);

  // Small Smart Dashboard logo, bottom-centre above the text line.
  if (p.brandLogoDataUrl) {
    drawImageContained(doc, p.brandLogoDataUrl, pageWidth / 2 - 40, pageHeight - 37, 80, 16);
  }

  doc.setTextColor(...BRAND_RGB.muted);
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
