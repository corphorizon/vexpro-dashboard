// ─────────────────────────────────────────────────────────────────────────────
// Órdenes de Pago — generador de PDF (A4 vertical).
//
// Reproduce el formulario del cliente: banda oscura con logo + título, tres
// campos de cabecera, bloque de beneficiario, tabla de detalle, totales, el
// medio de pago ELEGIDO (no el formulario en blanco), observaciones y firmas.
//
// Reutiliza la paleta y el lenguaje visual de src/lib/pdf-export.ts (navy
// #1E3A5F + acento, tarjetas con borde, tablas autotable con cabecera navy),
// pero este documento tiene su propia maqueta, así que los helpers viven aquí.
//
// Bilingüe: TODO label visible sale de LABELS[order.locale]. El dinero se
// formatea igual en ambos idiomas ($1,234.56) — el dinero es dinero.
// ─────────────────────────────────────────────────────────────────────────────

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatNumber } from '@/lib/utils';
import {
  isAuthorized,
  STATUS_LABELS,
  type PaymentOrder,
  type PaymentOrderLocale,
} from './types';

// ── Contrato público ────────────────────────────────────────────────────────

export interface PaymentOrderCompany {
  name: string;
  logo_url?: string | null;
  color_primary?: string | null;
}

export interface PaymentOrderPdfOptions {
  /** true → dispara la descarga y devuelve void. false/omitido → devuelve Blob. */
  download?: boolean;
}

// ── Etiquetas ───────────────────────────────────────────────────────────────

const LABELS = {
  es: {
    title: 'ORDEN DE PAGO',
    subtitle: 'AUTORIZACIÓN DE PAGO',
    orderNumber: 'N° DE ORDEN',
    issueDate: 'FECHA DE EMISIÓN',
    paymentDate: 'FECHA DE PAGO',
    beneficiary: 'BENEFICIARIO · A QUIÉN SE PAGA',
    name: 'NOMBRE / RAZÓN SOCIAL',
    taxId: 'DOCUMENTO / ID FISCAL',
    email: 'EMAIL / CONTACTO',
    country: 'PAÍS',
    detail: 'DETALLE DEL PAGO',
    description: 'DESCRIPCIÓN',
    unitValue: 'VALOR UNITARIO',
    qty: 'CANT.',
    amount: 'MONTO',
    currency: 'MONEDA',
    subtotal: 'Subtotal',
    fees: 'Comisiones / Fees',
    total: 'TOTAL A PAGAR',
    method: 'MEDIO DE PAGO',
    crypto: 'USDT · CRIPTO',
    network: 'RED / NETWORK',
    wallet: 'DIRECCIÓN DE WALLET',
    memo: 'MEMO / TAG',
    bank: 'CUENTA BANCARIA',
    bankName: 'BANCO',
    accountHolder: 'TITULAR DE LA CUENTA',
    accountNumber: 'N° DE CUENTA / IBAN',
    swift: 'SWIFT / BIC',
    accountType: 'TIPO DE CUENTA',
    notes: 'CONCEPTO / OBSERVACIONES',
    requestedBy: 'SOLICITADO POR · NOMBRE Y FIRMA',
    authorizedBy: 'AUTORIZADO POR · NOMBRE Y FIRMA',
    footer: 'Documento interno · Verificá la red y la dirección antes de ejecutar el pago.',
    paidStamp: 'PAGADA',
    reference: 'Ref.',
    watermarkDraft: 'BORRADOR',
    watermarkVoid: 'ANULADA',
    watermarkRejected: 'RECHAZADA',
    fileName: 'Orden_de_Pago',
  },
  en: {
    title: 'PAYMENT ORDER',
    subtitle: 'PAYMENT AUTHORIZATION',
    orderNumber: 'ORDER No.',
    issueDate: 'ISSUE DATE',
    paymentDate: 'PAYMENT DATE',
    beneficiary: 'BENEFICIARY · WHO GETS PAID',
    name: 'NAME / LEGAL NAME',
    taxId: 'TAX ID',
    email: 'EMAIL · CONTACT',
    country: 'COUNTRY',
    detail: 'PAYMENT DETAIL',
    description: 'DESCRIPTION',
    unitValue: 'UNIT VALUE',
    qty: 'QTY',
    amount: 'AMOUNT',
    currency: 'CURRENCY',
    subtotal: 'Subtotal',
    fees: 'Fees',
    total: 'TOTAL TO PAY',
    method: 'PAYMENT METHOD',
    crypto: 'USDT · CRYPTO',
    network: 'NETWORK',
    wallet: 'WALLET ADDRESS',
    memo: 'MEMO · TAG',
    bank: 'BANK ACCOUNT',
    bankName: 'BANK',
    accountHolder: 'ACCOUNT HOLDER',
    accountNumber: 'ACCOUNT No. · IBAN',
    swift: 'SWIFT · BIC',
    accountType: 'ACCOUNT TYPE',
    notes: 'NOTES · REMARKS',
    requestedBy: 'REQUESTED BY · NAME AND SIGNATURE',
    authorizedBy: 'AUTHORIZED BY · NAME AND SIGNATURE',
    footer: 'Internal document · Verify network and address before executing the payment.',
    paidStamp: 'PAID',
    reference: 'Ref.',
    watermarkDraft: 'DRAFT',
    watermarkVoid: 'VOID',
    watermarkRejected: 'REJECTED',
    fileName: 'Payment_Order',
  },
} as const satisfies Record<PaymentOrderLocale, Record<string, string>>;

// ── Paleta (misma que pdf-export.ts) ────────────────────────────────────────

type RGB = [number, number, number];
const C = {
  primary: [30, 58, 95] as RGB,   // #1E3A5F — fallback de marca
  gold: [193, 154, 87] as RGB,    // #C19A57 — regla fina bajo la banda
  ink: [15, 23, 42] as RGB,       // #0F172A
  muted: [100, 116, 139] as RGB,  // #64748B
  border: [226, 232, 240] as RGB, // #E2E8F0
  surface: [248, 250, 252] as RGB,// #F8FAFC
  positive: [5, 150, 105] as RGB, // #059669
  negative: [220, 38, 38] as RGB, // #DC2626
  watermark: [148, 163, 184] as RGB, // #94A3B8
  white: [255, 255, 255] as RGB,
};

/** #RRGGBB / #RGB → RGB. Devuelve el fallback si el hex no es válido. */
function hexToRgb(hex: string | null | undefined, fallback: RGB): RGB {
  if (!hex) return fallback;
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return fallback;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

// ── Formateo ────────────────────────────────────────────────────────────────

/** El dinero se ve igual en los dos idiomas: $1,234.56 (Intl en-US). */
const money = (n: number) => `$${formatNumber(Number(n) || 0)}`;

const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' (o ISO completo) → fecha local del documento, sin saltos de TZ. */
function formatDate(value: string | null | undefined, locale: PaymentOrderLocale): string {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const [, y, mo, d] = m;
  return locale === 'es'
    ? `${d}/${mo}/${y}`
    : `${EN_MONTHS[Number(mo) - 1] ?? mo} ${Number(d)}, ${y}`;
}

/** Fecha + hora para la traza de firma ("14/07/2026 · 16:32"). */
function formatDateTime(value: string | null | undefined, locale: PaymentOrderLocale): string {
  if (!value) return '';
  const date = formatDate(value, locale);
  const t = /T(\d{2}):(\d{2})/.exec(value);
  return t ? `${date} · ${t[1]}:${t[2]}` : date;
}

// ── Carga del logo remoto ───────────────────────────────────────────────────

interface LoadedLogo {
  dataUrl: string;
  format: 'PNG' | 'JPEG' | 'WEBP';
}

/**
 * Descarga el logo y lo convierte a dataURL. Devuelve null ante CUALQUIER
 * fallo (red, CORS, formato raro): un logo roto no puede romper el PDF, el
 * encabezado cae al nombre de la empresa en blanco.
 */
async function loadLogo(url: string): Promise<LoadedLogo | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const type = (blob.type || '').toLowerCase();
    // jsPDF no digiere SVG con addImage.
    if (type.includes('svg')) return null;
    const format: LoadedLogo['format'] = type.includes('jpeg') || type.includes('jpg')
      ? 'JPEG'
      : type.includes('webp')
        ? 'WEBP'
        : 'PNG';

    const dataUrl = await new Promise<string>((resolve, reject) => {
      if (typeof FileReader === 'undefined') {
        reject(new Error('FileReader no disponible'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('lectura fallida'));
      reader.readAsDataURL(blob);
    });
    if (!dataUrl.startsWith('data:image')) return null;
    return { dataUrl, format };
  } catch {
    return null;
  }
}

// ── Helpers de maqueta ──────────────────────────────────────────────────────

/** jspdf-autotable añade `lastAutoTable` al doc pero no lo tipa. */
interface AutoTableDoc extends jsPDF {
  lastAutoTable?: { finalY?: number };
}

/** API de opacidad de jsPDF 4 — se comprueba en runtime antes de usarla. */
interface GStateDoc {
  GState?: (params: { opacity: number }) => unknown;
  setGState?: (state: unknown) => void;
}

const MARGIN = 14;
const HEADER_H = 30;

/**
 * Texto alineado a la derecha CON letter-spacing.
 * jsPDF calcula el align:'right' ignorando charSpace, así que el texto se sale
 * del margen: aquí se mide a mano y se pinta alineado a la izquierda.
 */
function textRight(doc: jsPDF, text: string, right: number, y: number, charSpace = 0): void {
  const width = doc.getTextWidth(text) + charSpace * Math.max(0, text.length - 1);
  doc.text(text, right - width, y, charSpace ? { charSpace } : undefined);
}

/** Label pequeño en mayúsculas + valor debajo. Devuelve la Y tras el valor. */
function field(
  doc: jsPDF,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  opts: { mono?: boolean; rule?: boolean } = {},
): number {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.4);
  doc.setTextColor(...C.muted);
  doc.text(label, x, y, { charSpace: 0.25 });

  doc.setFont(opts.mono ? 'courier' : 'helvetica', 'bold');
  doc.setFontSize(opts.mono ? 8 : 9);
  doc.setTextColor(...C.ink);
  const lines = doc.splitTextToSize(value || '—', width);
  doc.text(lines, x, y + 4.4);
  const bottom = y + 4.4 + (lines.length - 1) * (opts.mono ? 3.6 : 4.2);

  if (opts.rule !== false) {
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    doc.line(x, bottom + 1.8, x + width, bottom + 1.8);
  }
  return bottom + (opts.rule === false ? 1.6 : 5.4);
}

/** Barra de sección: rectángulo de marca con el texto en blanco espaciado. */
function sectionBar(doc: jsPDF, y: number, label: string, brand: RGB): number {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(...brand);
  doc.rect(MARGIN, y, w - MARGIN * 2, 6.4, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.8);
  doc.setTextColor(...C.white);
  doc.text(label, MARGIN + 3, y + 4.4, { charSpace: 0.5 });
  return y + 6.4 + 4.2;
}

// ── Generador ───────────────────────────────────────────────────────────────

export async function generatePaymentOrderPDF(
  order: PaymentOrder,
  company: PaymentOrderCompany,
  opts?: PaymentOrderPdfOptions,
): Promise<Blob | void> {
  const L = LABELS[order.locale] ?? LABELS.es;
  const brand = hexToRgb(company.color_primary, C.primary);
  const doc = new jsPDF('portrait', 'mm', 'a4');
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const contentW = pageW - MARGIN * 2;

  // Logo primero: es la única parte asíncrona y condiciona el encabezado.
  const logo = company.logo_url ? await loadLogo(company.logo_url) : null;

  // ── 1. Banda de cabecera ──────────────────────────────────────────────────
  doc.setFillColor(...brand);
  doc.rect(0, 0, pageW, HEADER_H, 'F');
  doc.setFillColor(...C.gold);
  doc.rect(0, HEADER_H, pageW, 1.2, 'F');

  let logoPainted = false;
  if (logo) {
    try {
      const props = doc.getImageProperties(logo.dataUrl);
      const maxW = 42;
      const maxH = 16;
      const ratio = Math.min(maxW / props.width, maxH / props.height);
      const w = props.width * ratio;
      const h = props.height * ratio;
      doc.addImage(logo.dataUrl, logo.format, MARGIN, (HEADER_H - h) / 2, w, h);
      logoPainted = true;
    } catch {
      logoPainted = false; // logo ilegible → se cae al nombre en texto
    }
  }
  if (!logoPainted) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...C.white);
    doc.text(company.name, MARGIN, HEADER_H / 2 + 1.5);
  }

  // Bloque derecho: título grande, subtítulo espaciado, entidad legal.
  doc.setTextColor(...C.white);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  textRight(doc, L.title, pageW - MARGIN, 13, 0.4);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.6);
  textRight(doc, L.subtitle, pageW - MARGIN, 18.6, 1.4);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  textRight(doc, company.name, pageW - MARGIN, 25);

  // ── 2. Tres campos de cabecera ────────────────────────────────────────────
  let y = HEADER_H + 9;
  const colGap = 6;
  const colW = (contentW - colGap * 2) / 3;
  const headerFields: [string, string][] = [
    [L.orderNumber, order.order_number],
    [L.issueDate, formatDate(order.issue_date, order.locale)],
    [L.paymentDate, formatDate(order.payment_date, order.locale)],
  ];
  let headerBottom = y;
  headerFields.forEach(([label, value], i) => {
    const end = field(doc, MARGIN + i * (colW + colGap), y, colW, label, value);
    headerBottom = Math.max(headerBottom, end);
  });
  y = headerBottom + 2;

  // ── 3. Beneficiario ───────────────────────────────────────────────────────
  y = sectionBar(doc, y, L.beneficiary, brand);
  const halfW = (contentW - colGap) / 2;
  const rightX = MARGIN + halfW + colGap;

  let rowEnd = Math.max(
    field(doc, MARGIN, y, halfW, L.name, order.beneficiary_name),
    field(doc, rightX, y, halfW, L.taxId, order.beneficiary_tax_id ?? '—'),
  );
  y = rowEnd + 1;
  rowEnd = Math.max(
    field(doc, MARGIN, y, halfW, L.email, order.beneficiary_email ?? '—'),
    field(doc, rightX, y, halfW, L.country, order.beneficiary_country ?? '—'),
  );
  y = rowEnd + 3;

  // ── 4. Detalle del pago ───────────────────────────────────────────────────
  y = sectionBar(doc, y, L.detail, brand);
  autoTable(doc, {
    startY: y,
    head: [[L.description, L.unitValue, L.qty, L.amount]],
    body: order.lines.map((l) => [
      l.description,
      money(l.unitValue),
      String(l.quantity),
      money(l.amount),
    ]),
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 1.9, textColor: C.ink, lineColor: C.border, lineWidth: 0.2 },
    headStyles: { fillColor: brand, textColor: 255, fontStyle: 'bold', fontSize: 7 },
    alternateRowStyles: { fillColor: C.surface },
    columnStyles: {
      0: { cellWidth: contentW - 30 - 16 - 38 },
      1: { cellWidth: 30, halign: 'right' },
      2: { cellWidth: 16, halign: 'center' },
      3: { cellWidth: 38, halign: 'right', fontStyle: 'bold' },
    },
    margin: { left: MARGIN, right: MARGIN },
  });
  y = ((doc as AutoTableDoc).lastAutoTable?.finalY ?? y + 30) + 5;

  // ── 5. Moneda + totales ───────────────────────────────────────────────────
  const totalsW = 78;
  const totalsX = pageW - MARGIN - totalsW;

  field(doc, MARGIN, y + 2, halfW - 10, L.currency, order.currency, { rule: false });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...C.muted);
  doc.text(L.subtotal, totalsX, y + 2.5);
  doc.setTextColor(...C.ink);
  doc.text(money(order.subtotal), pageW - MARGIN, y + 2.5, { align: 'right' });
  doc.setTextColor(...C.muted);
  doc.text(L.fees, totalsX, y + 8);
  doc.setTextColor(...C.ink);
  doc.text(money(order.fees), pageW - MARGIN, y + 8, { align: 'right' });

  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.3);
  doc.line(totalsX, y + 11, pageW - MARGIN, y + 11);

  // Barra oscura de total, con el importe en una celda recuadrada clara.
  const totalBarY = y + 13.5;
  doc.setFillColor(...brand);
  doc.rect(totalsX, totalBarY, totalsW, 11, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.8);
  doc.setTextColor(...C.white);
  doc.text(L.total, totalsX + 3, totalBarY + 6.8, { charSpace: 0.3 });
  doc.setFillColor(...C.white);
  doc.rect(totalsX + totalsW - 42, totalBarY + 1.5, 40.5, 8, 'F');
  doc.setFontSize(10.5);
  doc.setTextColor(...brand);
  doc.text(money(order.total), pageW - MARGIN - 3.4, totalBarY + 7.2, { align: 'right' });

  // Sello discreto de PAGADA junto al total.
  if (order.status === 'paid') {
    doc.setDrawColor(...C.positive);
    doc.setLineWidth(0.6);
    doc.roundedRect(MARGIN, totalBarY - 1, 62, 13, 2, 2, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...C.positive);
    doc.text(L.paidStamp, MARGIN + 4, totalBarY + 5, { charSpace: 0.8 });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.2);
    const ref = order.payment_reference
      ? `${L.reference} ${order.payment_reference}`
      : formatDate(order.paid_at, order.locale);
    doc.text(doc.splitTextToSize(ref, 54), MARGIN + 4, totalBarY + 9.4);
  }

  y = totalBarY + 11 + 6;

  // ── 6. Medio de pago (solo el elegido) ────────────────────────────────────
  y = sectionBar(doc, y, L.method, brand);

  const cardX = MARGIN;
  const cardW = contentW;
  const cardTop = y;
  let cardCursor = cardTop + 9; // deja aire para el título de la tarjeta

  // Se pinta el contenido primero para medir el alto real del recuadro, luego
  // se dibuja el borde por encima: así una wallet larga nunca se sale.
  const drawCardTitle = (label: string) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...brand);
    doc.text(label, cardX + 5, cardTop + 6, { charSpace: 0.4 });
  };

  if (order.payment_method === 'crypto') {
    drawCardTitle(L.crypto);
    cardCursor = field(doc, cardX + 5, cardCursor, cardW - 10, L.network, order.crypto_network ?? '—');
    // splitTextToSize evita que una ERC20 de 42 caracteres se desborde.
    cardCursor = field(doc, cardX + 5, cardCursor, cardW - 10, L.wallet, order.crypto_wallet ?? '—', { mono: true });
    if (order.crypto_memo) {
      cardCursor = field(doc, cardX + 5, cardCursor, cardW - 10, L.memo, order.crypto_memo, { mono: true });
    }
  } else {
    drawCardTitle(L.bank);
    cardCursor = Math.max(
      field(doc, cardX + 5, cardCursor, halfW - 5, L.bankName, order.bank_name ?? '—'),
      field(doc, rightX, cardCursor, halfW - 5, L.accountHolder, order.bank_account_holder ?? '—'),
    );
    cardCursor = field(doc, cardX + 5, cardCursor, cardW - 10, L.accountNumber, order.bank_account_number ?? '—', { mono: true });
    cardCursor = Math.max(
      field(doc, cardX + 5, cardCursor, halfW - 5, L.swift, order.bank_swift ?? '—', { mono: true }),
      field(doc, rightX, cardCursor, halfW - 5, L.accountType, order.bank_account_type ?? '—'),
    );
  }

  const cardH = cardCursor - cardTop;
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.4);
  doc.roundedRect(cardX, cardTop, cardW, cardH, 2, 2, 'S');
  doc.setFillColor(...brand);
  doc.rect(cardX, cardTop, 1.6, cardH, 'F');
  y = cardTop + cardH + 6;

  // ── 7. Concepto / observaciones ───────────────────────────────────────────
  y = sectionBar(doc, y, L.notes, brand);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...C.ink);
  const noteLines = doc.splitTextToSize(order.notes?.trim() || '—', contentW - 8);
  const notesH = Math.max(18, noteLines.length * 4 + 7);
  doc.setFillColor(...C.surface);
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.3);
  doc.roundedRect(MARGIN, y, contentW, notesH, 2, 2, 'FD');
  doc.text(noteLines, MARGIN + 4, y + 5.5);
  y += notesH;

  // ── 8. Firmas ─────────────────────────────────────────────────────────────
  // Las firmas se anclan al pie de la página; si el cuerpo llegó demasiado
  // abajo, el bloque se va entero a la siguiente hoja (nunca se parte).
  // La raya de firma baja al pie si sobra espacio, pero nunca invade el footer.
  const signLineY = Math.max(y + 10, pageH - 26);
  if (signLineY > pageH - 22) {
    doc.addPage();
    y = MARGIN + 16;
  } else {
    y = signLineY;
  }

  const authorized = isAuthorized(order.status);
  const signW = (contentW - 16) / 2;
  const signs: { label: string; who: string | null; when: string | null; x: number }[] = [
    { label: L.requestedBy, who: order.created_by_name, when: order.created_at, x: MARGIN },
    { label: L.authorizedBy, who: order.approved_by_name, when: order.approved_at, x: MARGIN + signW + 16 },
  ];

  signs.forEach((s) => {
    // El documento emitido lleva su traza digital; el borrador se firma a mano.
    if (authorized && s.who) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(...C.ink);
      doc.text(s.who, s.x + signW / 2, y - 2, { align: 'center' });
    }
    doc.setDrawColor(...C.ink);
    doc.setLineWidth(0.4);
    doc.line(s.x, y, s.x + signW, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.6);
    doc.setTextColor(...C.muted);
    doc.text(s.label, s.x + signW / 2, y + 4, { align: 'center', charSpace: 0.2 });
    if (authorized && s.who && s.when) {
      doc.setFontSize(6);
      doc.text(formatDateTime(s.when, order.locale), s.x + signW / 2, y + 8, { align: 'center' });
    }
  });

  // ── 9. Marca de agua / sello de estado ────────────────────────────────────
  paintStatusWatermark(doc, order, L);

  // ── 10. Pie ───────────────────────────────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, pageH - 13, pageW - MARGIN, pageH - 13);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(...C.muted);
    doc.text(`${company.name} · ${L.footer}`, MARGIN, pageH - 8.5);
    doc.setTextColor(...C.muted);
    doc.text(
      `${order.order_number} · ${STATUS_LABELS[order.locale][order.status]}${pages > 1 ? `  ·  ${p}/${pages}` : ''}`,
      pageW - MARGIN,
      pageH - 8.5,
      { align: 'right' },
    );
  }

  // ── Salida ────────────────────────────────────────────────────────────────
  if (opts?.download) {
    doc.save(paymentOrderFileName(order));
    return;
  }
  return doc.output('blob');
}

/** Marca de agua diagonal para los estados que invalidan el documento. */
function paintStatusWatermark(
  doc: jsPDF,
  order: PaymentOrder,
  L: (typeof LABELS)[PaymentOrderLocale],
): void {
  const text =
    order.status === 'draft' ? L.watermarkDraft
      : order.status === 'cancelled' ? L.watermarkVoid
      : order.status === 'rejected' ? L.watermarkRejected
      : null;
  if (!text) return; // approved → el bloque de firmas ya sella; paid → sello verde

  const color: RGB = order.status === 'draft' ? C.watermark : C.negative;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const gdoc = doc as unknown as GStateDoc;
  // La API de opacidad existe en jsPDF 4, pero se comprueba antes de usarla:
  // sin ella se cae a un gris muy claro y el documento sigue saliendo bien.
  const hasGState = typeof gdoc.GState === 'function' && typeof gdoc.setGState === 'function';

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    if (hasGState) doc.saveGraphicsState();
    if (hasGState) gdoc.setGState!(gdoc.GState!({ opacity: order.status === 'draft' ? 0.1 : 0.14 }));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(74);
    doc.setTextColor(...(hasGState ? color : ([222, 226, 232] as RGB)));
    doc.text(text, pageW / 2, pageH / 2, { align: 'center', angle: 32, charSpace: 2 });
    if (hasGState) doc.restoreGraphicsState();
  }
  doc.setPage(pages);
}

/** `Orden_de_Pago_OP-2026-0001.pdf` (es) · `Payment_Order_OP-2026-0001.pdf` (en). */
export function paymentOrderFileName(order: PaymentOrder): string {
  const prefix = (LABELS[order.locale] ?? LABELS.es).fileName;
  return `${prefix}_${order.order_number}.pdf`;
}
