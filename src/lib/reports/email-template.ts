// ─────────────────────────────────────────────────────────────────────────────
// Reports email HTML template.
//
// Single renderer used by all three cadences (daily / weekly / monthly).
// The differences are:
//   · The title + subject are cadence-dependent (done by the caller).
//   · Whether to show "% vs mes" comparisons — daily/weekly show them,
//     monthly shows the full month-vs-prev-month block instead.
//
// Localised: every renderer takes an EmailLocale ('en' | 'es'). The original
// Spanish copy is preserved as the 'es' variant; 'en' is the default, per the
// business rule that recipients without a configured language get English.
// Strings live in the local `L` dictionary below (not in email-i18n) because
// they are template-internal and numerous.
//
// HTML is plain table-based email HTML — deliberately old-school, because
// every real email client in 2026 still renders it more reliably than CSS
// grid / flexbox. Inline styles only (no <style> tags inside the body,
// outlook strips them anyway).
//
// Colour palette matches the dashboard:
//   Primary navy:  ${BRAND_HEX.primary}
//   Accent blue:   ${BRAND_HEX.accent}
//   Emerald:       ${BRAND_HEX.positive} (positive)
//   Red:           ${BRAND_HEX.negative} (negative)
//   Slate body:    ${BRAND_HEX.inkSoft}
// ─────────────────────────────────────────────────────────────────────────────

import { BRAND_HEX } from '@/lib/brand';
import type { ReportData } from './data';
import { formatCurrency } from '@/lib/utils';
import type { EmailLocale } from '@/lib/email-i18n';
import {
  UNASSIGNED_CLIENT_KEY,
  UNCATEGORIZED,
  type CompanyResultReport,
} from './company-report';

const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'https://dashboard.horizonconsulting.ai';

export type ReportCadence = 'daily' | 'weekly' | 'monthly';

// Month names for the range header, per locale.
const MONTHS: Record<EmailLocale, string[]> = {
  es: [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ],
  en: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
};

const CHANNEL_LABEL: Record<EmailLocale, Record<string, string>> = {
  es: {
    coinsbuy: 'Coinsbuy',
    fairpay: 'FairPay',
    unipayment: 'UniPayment',
    paypros: 'Pay-Pros',
    other: 'Otros',
  },
  en: {
    coinsbuy: 'Coinsbuy',
    fairpay: 'FairPay',
    unipayment: 'UniPayment',
    paypros: 'Pay-Pros',
    other: 'Other',
  },
};
const CATEGORY_LABEL: Record<EmailLocale, Record<string, string>> = {
  es: {
    ib_commissions: 'Comisiones IB',
    broker: 'Broker',
    prop_firm: 'Prop Firm',
    other: 'Otros',
    p2p: 'P2P Transfer',
    coinsbuy_api: 'Coinsbuy (API)',
    paypros_api: 'Pay-Pros (API)',
  },
  en: {
    ib_commissions: 'IB Commissions',
    broker: 'Broker',
    prop_firm: 'Prop Firm',
    other: 'Other',
    p2p: 'P2P Transfer',
    coinsbuy_api: 'Coinsbuy (API)',
    paypros_api: 'Pay-Pros (API)',
  },
};

// Template-internal strings. Original Spanish preserved as 'es'.
const L: Record<EmailLocale, Record<string, string>> = {
  es: {
    noComparison: 'sin comparativa',
    vsPrevMonth: 'vs mes anterior',
    noData: 'sin datos',
    subjectDaily: '📊 Reporte Financiero — {company} — {date}',
    subjectWeekly: '📊 Reporte Semanal — {company} — Semana del {from} al {to}',
    subjectMonthly: '📊 Reporte Mensual — {company} — {month}',
    titleDaily: 'Reporte Financiero Diario',
    titleWeekly: 'Reporte Financiero Semanal',
    titleMonthly: 'Reporte Financiero Mensual',
    noDataInPeriod: 'Sin datos en el período',
    sectionNotConnected: 'Sin datos: esta sección no tiene fuente conectada.',
    productsNoBreakdown:
      'Sin desglose disponible: el CRM guarda el total del mes, no qué producto se vendió.',
    balancesTitle: 'Balances por Canal',
    asOf: 'Al {date}',
    typeApi: 'API',
    typeAuto: 'Automático',
    typeManual: 'Manual',
    channel: 'Canal',
    type: 'Tipo',
    balance: 'Balance',
    totalConsolidated: 'Total Consolidado',
    noVisibleChannels: 'No hay canales visibles configurados.',
    depositsWithdrawalsTitle: 'Depósitos y Retiros',
    netDepositMonth: 'Net Deposit del mes',
    totalDepositsMonth: 'Depósitos totales del mes',
    totalWithdrawalsMonth: 'Retiros totales del mes',
    netDepositRange: 'Net Deposit del rango',
    netDepositPrevMonth: 'Net Deposit mes anterior',
    pctOfMonth: '% del mes',
    depositsByChannel: 'Depósitos por canal',
    withdrawalsByCategory: 'Retiros por categoría',
    category: 'Categoría',
    amount: 'Monto',
    total: 'Total',
    crmUsersTitle: 'Usuarios CRM',
    newInPeriod: 'Nuevos en el período',
    newThisMonth: 'Nuevos este mes',
    totalOnPlatform: 'Total en plataforma',
    pnlMonth: 'P&L del mes',
    pnlPrevMonth: 'P&L mes anterior',
    pnlRange: 'P&L del rango',
    variationVsPrev: 'Variación vs mes anterior',
    crmPnlDay: 'P&L del día (CRM)',
    crmPnlPeriod: 'P&L del período (CRM)',
    crmPnlVolume: 'Volumen (lotes)',
    crmPnlDeals: 'Operaciones',
    crmPnlDays: 'sobre {days} día(s) con dato',
    crmPnlNoData: 'sin dato',
    crmPnlSource: 'Cierre diario tomado del CRM. Las cuentas Cent ya están convertidas a dólares.',
    crmPnlMissing: 'faltan {n} día(s) en el período: {days}',
    textCrmPnlDay: 'P&L del día (CRM)',
    textCrmPnlPeriod: 'P&L del período (CRM)',
    propTradingTitle: 'Prop Trading Firm',
    productsSold: 'Productos vendidos',
    product: 'Producto',
    quantity: 'Cantidad',
    totalOfRange: 'Total del rango',
    salesOfRange: 'Ventas del rango',
    monthPrefix: 'Mes: {value}',
    propWithdrawals: 'Retiros Prop Firm',
    withdrawalsCount: '{count} retiros',
    failureNote:
      '⚠️ Algunas fuentes no respondieron y se omitieron del reporte: {failures}. El resto de los datos son correctos.',
    mockNote:
      'Los datos de Orion CRM provienen del entorno mock. Configure las credenciales en Superadmin → APIs externas para recibir datos reales.',
    generatedBy: 'Reporte generado automáticamente por',
    dataUpdated: 'Datos actualizados: {stamp}',
    unsubscribe: 'Para dejar de recibir este reporte, contacta a tu administrador.',
    textPeriod: 'Período',
    textDepositsWithdrawals: 'DEPÓSITOS Y RETIROS (rango)',
    textTotalDeposits: 'Total depósitos',
    textTotalWithdrawals: 'Total retiros',
    textCurrentMonth: 'MES ACTUAL',
    textPrevMonth: 'mes anterior',
    textBalancesByChannel: 'BALANCES POR CANAL',
    textNoVisibleChannels: '(sin canales visibles)',
    textCrmUsers: 'USUARIOS CRM',
    textNewInRange: 'Nuevos en rango',
    textNewThisMonth: 'Nuevos este mes',
    textTotal: 'Total',
    textBrokerPnl: 'BROKER P&L',
    textRange: 'Rango',
    textMonth: 'Mes',
    textPropTrading: 'PROP TRADING FIRM',
    textSalesRange: 'Ventas rango',
    textWithdrawalsRange: 'Retiros rango',
    textPnlRange: 'P&L rango',
    textAutoDaily: 'Reporte diario automático.',
    textAutoWeekly: 'Reporte semanal automático.',
    textAutoMonthly: 'Reporte mensual automático.',
    companyResultTitle: 'Facturación y Resultado',
    monthsCovered: 'Meses incluidos: {months}',
    noPeriodsInRange: 'El rango no toca ningún mes cargado.',
    billed: 'Facturado',
    collected: 'Cobrado',
    receivable: 'Por cobrar',
    billingByClient: 'Facturación por cliente',
    client: 'Cliente',
    unassignedClient: 'Sin cliente',
    expensesTitle: 'Egresos del período',
    expensesByCategory: 'Egresos por categoría',
    uncategorized: 'Sin categoría',
    expensesTotal: 'Egresos totales',
    expensesPaid: 'Pagado',
    expensesPending: 'Pendiente',
    cashResultLabel: 'Resultado de caja (cobrado − egresos pagados)',
    textCompanyResult: 'FACTURACIÓN Y RESULTADO',
    textBilled: 'Facturado',
    textCollected: 'Cobrado',
    textReceivable: 'Por cobrar',
    textExpensesPaid: 'Egresos pagados',
    textExpensesPending: 'Egresos pendientes',
    textCashResult: 'Resultado de caja',
  },
  en: {
    noComparison: 'no comparison',
    vsPrevMonth: 'vs previous month',
    noData: 'no data',
    subjectDaily: '📊 Financial Report — {company} — {date}',
    subjectWeekly: '📊 Weekly Report — {company} — Week of {from} to {to}',
    subjectMonthly: '📊 Monthly Report — {company} — {month}',
    titleDaily: 'Daily Financial Report',
    titleWeekly: 'Weekly Financial Report',
    titleMonthly: 'Monthly Financial Report',
    noDataInPeriod: 'No data in this period',
    sectionNotConnected: 'No data: this section has no connected source.',
    productsNoBreakdown:
      'No breakdown available: the CRM stores the monthly total, not which product was sold.',
    balancesTitle: 'Balances by Channel',
    asOf: 'As of {date}',
    typeApi: 'API',
    typeAuto: 'Automatic',
    typeManual: 'Manual',
    channel: 'Channel',
    type: 'Type',
    balance: 'Balance',
    totalConsolidated: 'Consolidated Total',
    noVisibleChannels: 'No visible channels configured.',
    depositsWithdrawalsTitle: 'Deposits & Withdrawals',
    netDepositMonth: 'Net Deposit (month)',
    totalDepositsMonth: 'Total deposits (month)',
    totalWithdrawalsMonth: 'Total withdrawals (month)',
    netDepositRange: 'Net Deposit (range)',
    netDepositPrevMonth: 'Net Deposit (prev. month)',
    pctOfMonth: '% of month',
    depositsByChannel: 'Deposits by channel',
    withdrawalsByCategory: 'Withdrawals by category',
    category: 'Category',
    amount: 'Amount',
    total: 'Total',
    crmUsersTitle: 'CRM Users',
    newInPeriod: 'New in period',
    newThisMonth: 'New this month',
    totalOnPlatform: 'Total on platform',
    pnlMonth: 'P&L (month)',
    pnlPrevMonth: 'P&L (prev. month)',
    pnlRange: 'P&L (range)',
    variationVsPrev: 'Change vs previous month',
    crmPnlDay: 'P&L for the day (CRM)',
    crmPnlPeriod: 'P&L for the period (CRM)',
    crmPnlVolume: 'Volume (lots)',
    crmPnlDeals: 'Trades',
    crmPnlDays: 'over {days} day(s) with data',
    crmPnlNoData: 'no data',
    crmPnlSource: 'Daily close taken from the CRM. Cent accounts are already converted to dollars.',
    crmPnlMissing: '{n} day(s) missing in the period: {days}',
    textCrmPnlDay: 'P&L for the day (CRM)',
    textCrmPnlPeriod: 'P&L for the period (CRM)',
    propTradingTitle: 'Prop Trading Firm',
    productsSold: 'Products sold',
    product: 'Product',
    quantity: 'Quantity',
    totalOfRange: 'Range total',
    salesOfRange: 'Sales (range)',
    monthPrefix: 'Month: {value}',
    propWithdrawals: 'Prop Firm withdrawals',
    withdrawalsCount: '{count} withdrawals',
    failureNote:
      '⚠️ Some data sources did not respond and were omitted from this report: {failures}. The remaining figures are accurate.',
    mockNote:
      'Orion CRM data comes from the mock environment. Configure credentials in Superadmin → External APIs to receive real data.',
    generatedBy: 'Report generated automatically by',
    dataUpdated: 'Data updated: {stamp}',
    unsubscribe: 'To stop receiving this report, contact your administrator.',
    textPeriod: 'Period',
    textDepositsWithdrawals: 'DEPOSITS & WITHDRAWALS (range)',
    textTotalDeposits: 'Total deposits',
    textTotalWithdrawals: 'Total withdrawals',
    textCurrentMonth: 'CURRENT MONTH',
    textPrevMonth: 'previous month',
    textBalancesByChannel: 'BALANCES BY CHANNEL',
    textNoVisibleChannels: '(no visible channels)',
    textCrmUsers: 'CRM USERS',
    textNewInRange: 'New in range',
    textNewThisMonth: 'New this month',
    textTotal: 'Total',
    textBrokerPnl: 'BROKER P&L',
    textRange: 'Range',
    textMonth: 'Month',
    textPropTrading: 'PROP TRADING FIRM',
    textSalesRange: 'Sales (range)',
    textWithdrawalsRange: 'Withdrawals (range)',
    textPnlRange: 'P&L (range)',
    textAutoDaily: 'Automated daily report.',
    textAutoWeekly: 'Automated weekly report.',
    textAutoMonthly: 'Automated monthly report.',
    companyResultTitle: 'Billing & Result',
    monthsCovered: 'Months included: {months}',
    noPeriodsInRange: 'The range does not cover any recorded month.',
    billed: 'Billed',
    collected: 'Collected',
    receivable: 'Receivable',
    billingByClient: 'Billing by client',
    client: 'Client',
    unassignedClient: 'No client',
    expensesTitle: 'Expenses in the period',
    expensesByCategory: 'Expenses by category',
    uncategorized: 'Uncategorised',
    expensesTotal: 'Total expenses',
    expensesPaid: 'Paid',
    expensesPending: 'Pending',
    cashResultLabel: 'Cash result (collected − expenses paid)',
    textCompanyResult: 'BILLING & RESULT',
    textBilled: 'Billed',
    textCollected: 'Collected',
    textReceivable: 'Receivable',
    textExpensesPaid: 'Expenses paid',
    textExpensesPending: 'Expenses pending',
    textCashResult: 'Cash result',
  },
};

/** Template-local translate with {param} interpolation. */
function lt(
  locale: EmailLocale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const raw = L[locale]?.[key] ?? L.en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}

/** Validates a hex colour string (#rgb or #rrggbb). Returns the normalised
 *  6-char hex on success, null otherwise — we never interpolate user input
 *  straight into the email HTML without a guard. */
function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const m = s.slice(1);
    return `#${m[0]}${m[0]}${m[1]}${m[1]}${m[2]}${m[2]}`.toUpperCase();
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));
}

// formatCurrency lives in @/lib/utils — imported above. Kept this comment
// as a breadcrumb because the previous local copy diverged silently.

function formatDate(iso: string, locale: EmailLocale): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  if (locale === 'en') return `${MONTHS.en[m - 1]} ${d}, ${y}`;
  return `${d} ${MONTHS.es[m - 1]} ${y}`;
}

/**
 * `null` en cualquiera de los dos lados = NO HAY COMPARACIÓN posible. Antes los
 * parámetros eran `number` y el llamador venía de un `?? 0`: comparar contra un
 * cero inventado daba «−100%» con cara de dato (§1.3).
 */
function pctVariation(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function variationTag(pct: number | null, locale: EmailLocale, invertColor = false): string {
  if (pct === null || !isFinite(pct)) {
    return `<span style="color:${BRAND_HEX.mutedLight};font-size:12px;">${lt(locale, 'noComparison')}</span>`;
  }
  const rounded = Math.round(pct * 10) / 10;
  const positive = invertColor ? rounded < 0 : rounded >= 0;
  const color = positive ? BRAND_HEX.positive : BRAND_HEX.negative;
  const arrow = rounded >= 0 ? '▲' : '▼';
  return `<span style="color:${color};font-weight:600;font-size:12px;">${arrow} ${rounded > 0 ? '+' : ''}${rounded}% ${lt(locale, 'vsPrevMonth')}</span>`;
}

/**
 * Plain-text "+12.5%" / "-3.2%" for KPI bodies where HTML would be escaped.
 * Use this when the percent should land in `value` (which goes through
 * escapeHtml); use variationTag() when it goes into `hint` (raw-rendered).
 */
function variationText(pct: number | null, locale: EmailLocale): string {
  if (pct === null || !isFinite(pct)) return lt(locale, 'noData');
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

// ─── Cadence metadata ──────────────────────────────────────────────────

export interface EmailSubjectParts {
  companyName: string;
  cadence: ReportCadence;
  range: { from: string; to: string };
  locale?: EmailLocale;
}

export function reportEmailSubject(parts: EmailSubjectParts): string {
  const { companyName, cadence, range } = parts;
  const locale = parts.locale ?? 'en';
  if (cadence === 'daily') {
    return lt(locale, 'subjectDaily', {
      company: companyName,
      date: formatDate(range.from, locale),
    });
  }
  if (cadence === 'weekly') {
    return lt(locale, 'subjectWeekly', {
      company: companyName,
      from: formatDate(range.from, locale),
      to: formatDate(range.to, locale),
    });
  }
  // monthly: use the month of the `from` date.
  const [y, m] = range.from.split('-').map(Number);
  const monthName = y && m ? MONTHS[locale][m - 1]! : null;
  const monthLabel =
    y && m && monthName
      ? `${monthName.charAt(0).toUpperCase() + monthName.slice(1)} ${y}`
      : `${range.from} → ${range.to}`;
  return lt(locale, 'subjectMonthly', { company: companyName, month: monthLabel });
}

function reportTitle(cadence: ReportCadence, locale: EmailLocale): string {
  if (cadence === 'daily') return lt(locale, 'titleDaily');
  if (cadence === 'weekly') return lt(locale, 'titleWeekly');
  return lt(locale, 'titleMonthly');
}

// ─── Partial renderers ────────────────────────────────────────────────

function renderKpi(
  label: string,
  value: string,
  tone: 'positive' | 'negative' | 'neutral' | 'info',
  hint?: string,
): string {
  const colors: Record<typeof tone, string> = {
    positive: BRAND_HEX.positive,
    negative: BRAND_HEX.negative,
    neutral: BRAND_HEX.inkSoft,
    info: BRAND_HEX.accent,
  };
  return `
    <td align="center" valign="top" style="padding:10px;width:33%;">
      <div style="background:${BRAND_HEX.surface};border:1px solid ${BRAND_HEX.border};border-radius:8px;padding:16px;">
        <div style="font-size:11px;color:${BRAND_HEX.muted};text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${escapeHtml(label)}</div>
        <div style="font-size:22px;color:${colors[tone]};font-weight:700;margin-top:6px;">${escapeHtml(value)}</div>
        ${hint ? `<div style="font-size:11px;color:${BRAND_HEX.muted};margin-top:4px;">${hint}</div>` : ''}
      </div>
    </td>
  `;
}

function renderTable(
  headers: string[],
  rows: string[][],
  locale: EmailLocale,
  totalRow?: string[],
): string {
  const thead = headers
    .map(
      (h, i) => `
    <th style="text-align:${i === 0 ? 'left' : 'right'};padding:8px 12px;background:${BRAND_HEX.primary};color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${escapeHtml(h)}</th>
  `,
    )
    .join('');

  const tbody = rows.length
    ? rows
        .map(
          (r, ri) => `
      <tr style="background:${ri % 2 === 0 ? '#fff' : BRAND_HEX.surface};">
        ${r.map((c, i) => `<td style="text-align:${i === 0 ? 'left' : 'right'};padding:8px 12px;font-size:13px;border-bottom:1px solid ${BRAND_HEX.border};color:${BRAND_HEX.inkSoft};">${escapeHtml(c)}</td>`).join('')}
      </tr>
    `,
        )
        .join('')
    : `<tr><td colspan="${headers.length}" style="padding:12px;text-align:center;color:${BRAND_HEX.muted};font-size:12px;font-style:italic;">${lt(locale, 'noDataInPeriod')}</td></tr>`;

  const foot = totalRow
    ? `
    <tr style="background:#F1F5F9;font-weight:700;">
      ${totalRow.map((c, i) => `<td style="text-align:${i === 0 ? 'left' : 'right'};padding:10px 12px;font-size:13px;color:${BRAND_HEX.primary};">${escapeHtml(c)}</td>`).join('')}
    </tr>
  `
    : '';

  return `
    <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid ${BRAND_HEX.border};border-radius:8px;overflow:hidden;">
      <thead><tr>${thead}</tr></thead>
      <tbody>${tbody}${foot}</tbody>
    </table>
  `;
}

// ─── Sections ─────────────────────────────────────────────────────────

/**
 * Section header block — a subtle tinted background with a thick left
 * accent bar in the company's primary colour. Gmail / Outlook / Apple Mail
 * all render the left-border-style without issue when it lives on a
 * table-cell.
 */
function sectionHeader(primary: string, emoji: string, title: string): string {
  return `
    <table cellspacing="0" cellpadding="0" style="width:100%;margin:32px 0 12px 0;">
      <tr>
        <td style="background:${primary}12;border-left:4px solid ${primary};padding:10px 14px;border-radius:4px;">
          <h2 style="font-size:17px;color:${primary};margin:0;font-weight:700;line-height:1.2;">
            <span style="margin-right:6px;">${emoji}</span>${title}
          </h2>
        </td>
      </tr>
    </table>
  `;
}

function renderBalancesByChannelSection(
  data: ReportData,
  primary: string,
  locale: EmailLocale,
): string {
  const b = data.balances_by_channel;
  const typeLabel = (t: 'api' | 'manual' | 'auto') =>
    t === 'api' ? lt(locale, 'typeApi') : t === 'auto' ? lt(locale, 'typeAuto') : lt(locale, 'typeManual');
  // `missing` = no hubo ni libro ni snapshot para ese canal. Mostrar $0,00
  // afirmaría que la cuenta está vacía, que no es lo mismo que no saberlo.
  const rows = b.channels.map((c) => [
    c.label,
    typeLabel(c.type),
    c.source === 'missing' ? 's/d' : formatCurrency(c.amount),
  ]);
  const totalRow: string[] = [lt(locale, 'totalConsolidated'), '', formatCurrency(b.total)];

  const emptyNote =
    b.channels.length === 0
      ? `<p style="font-size:12px;color:${BRAND_HEX.muted};font-style:italic;margin:6px 0 0 0;">${lt(locale, 'noVisibleChannels')}</p>`
      : '';

  return `
    ${sectionHeader(primary, '🏦', lt(locale, 'balancesTitle'))}
    <p style="font-size:11px;color:${BRAND_HEX.muted};margin:0 0 8px 0;">${lt(locale, 'asOf', { date: escapeHtml(b.asOf) })}</p>
    ${b.channels.length ? renderTable([lt(locale, 'channel'), lt(locale, 'type'), lt(locale, 'balance')], rows, locale, totalRow) : ''}
    ${emptyNote}
  `;
}

/**
 * Resultado de una empresa de servicios: qué facturó, qué cobró, qué le
 * deben, qué gastó y qué le quedó.
 *
 * Es la contracara de "Depósitos y Retiros": esa sección responde por la
 * plata de los CLIENTES del broker, ésta por la plata de la EMPRESA. No se
 * ofrece como toggle en la configuración porque no es una preferencia —
 * viene o no viene según el modelo de negocio (`data.company_result`).
 */
function renderCompanyResultSection(
  result: CompanyResultReport,
  primary: string,
  locale: EmailLocale,
): string {
  const b = result.billing;
  const e = result.expenses;

  // Top 8 clientes: el email es para leer en el teléfono, no para auditar.
  // El detalle completo vive en el reporte de la pantalla.
  const clientRows = b.clients
    .slice(0, 8)
    .map((c) => [
      c.key === UNASSIGNED_CLIENT_KEY ? lt(locale, 'unassignedClient') : c.name,
      formatCurrency(c.billed),
      formatCurrency(c.collected),
      formatCurrency(c.pending),
    ]);

  const categoryRows = e.categories
    .slice(0, 8)
    .map((c) => [
      c.category === UNCATEGORIZED ? lt(locale, 'uncategorized') : c.category,
      formatCurrency(c.amount),
      formatCurrency(c.pending),
    ]);

  const periodsNote = result.periods.length
    ? lt(locale, 'monthsCovered', {
        months: escapeHtml(result.periods.map((p) => p.label).join(' · ')),
      })
    : lt(locale, 'noPeriodsInRange');

  return `
    ${sectionHeader(primary, '🧾', lt(locale, 'companyResultTitle'))}
    <p style="font-size:11px;color:${BRAND_HEX.muted};margin:0 0 8px 0;">${periodsNote}</p>

    <table cellspacing="0" cellpadding="0" style="width:100%;margin-bottom:16px;">
      <tr>
        ${renderKpi(lt(locale, 'billed'), formatCurrency(b.billed), 'info')}
        ${renderKpi(lt(locale, 'collected'), formatCurrency(b.collected), 'positive')}
        ${renderKpi(lt(locale, 'receivable'), formatCurrency(b.pending), b.pending > 0 ? 'negative' : 'neutral')}
      </tr>
    </table>

    <div style="margin-bottom:16px;">
      <h3 style="font-size:14px;color:${BRAND_HEX.inkSoft};margin:0 0 8px 0;">${lt(locale, 'billingByClient')}</h3>
      ${renderTable(
        [lt(locale, 'client'), lt(locale, 'billed'), lt(locale, 'collected'), lt(locale, 'receivable')],
        clientRows,
        locale,
        [lt(locale, 'total'), formatCurrency(b.billed), formatCurrency(b.collected), formatCurrency(b.pending)],
      )}
    </div>

    <table cellspacing="0" cellpadding="0" style="width:100%;margin-bottom:16px;">
      <tr>
        ${renderKpi(lt(locale, 'expensesTotal'), formatCurrency(e.total), 'neutral')}
        ${renderKpi(lt(locale, 'expensesPaid'), formatCurrency(e.paid), 'negative')}
        ${renderKpi(lt(locale, 'expensesPending'), formatCurrency(e.pending), e.pending > 0 ? 'negative' : 'neutral')}
      </tr>
    </table>

    <div style="margin-bottom:16px;">
      <h3 style="font-size:14px;color:${BRAND_HEX.inkSoft};margin:0 0 8px 0;">${lt(locale, 'expensesByCategory')}</h3>
      ${renderTable(
        [lt(locale, 'category'), lt(locale, 'amount'), lt(locale, 'expensesPending')],
        categoryRows,
        locale,
        [lt(locale, 'total'), formatCurrency(e.total), formatCurrency(e.pending)],
      )}
    </div>

    <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid ${BRAND_HEX.border};border-radius:8px;overflow:hidden;">
      <tr style="background:${BRAND_HEX.surface};">
        <td style="padding:12px 14px;font-size:13px;font-weight:600;color:${BRAND_HEX.inkSoft};">${lt(locale, 'cashResultLabel')}</td>
        <td align="right" style="padding:12px 14px;font-size:18px;font-weight:700;color:${result.cashResult >= 0 ? BRAND_HEX.positive : BRAND_HEX.negative};">${escapeHtml(formatCurrency(result.cashResult))}</td>
      </tr>
    </table>
  `;
}

function renderDepositsWithdrawalsSection(
  data: ReportData,
  cadence: ReportCadence,
  primary: string,
  locale: EmailLocale,
): string {
  const d = data.deposits_withdrawals;
  const depositsRows = d.range.deposits
    .sort((a, b) => b.amount - a.amount)
    .map((r) => [CHANNEL_LABEL[locale][r.channel] ?? r.channel, String(r.count), formatCurrency(r.amount)]);
  const withdrawalsRows = d.range.withdrawals
    .sort((a, b) => b.amount - a.amount)
    .map((r) => [CATEGORY_LABEL[locale][r.category] ?? r.category, String(r.count), formatCurrency(r.amount)]);

  const monthVsPrev = pctVariation(d.month.net_deposit, d.prev_month.net_deposit);
  const rangePctOfMonth = d.month.net_deposit
    ? (d.range.net_deposit / Math.abs(d.month.net_deposit)) * 100
    : null;

  // Daily/weekly: highlight net deposit of range + % of month.
  // Monthly: highlight net deposit of month + month vs prev.
  const kpiRow =
    cadence === 'monthly'
      ? `
    <tr>
      ${renderKpi(lt(locale, 'netDepositMonth'), formatCurrency(d.month.net_deposit), d.month.net_deposit >= 0 ? 'positive' : 'negative', variationTag(monthVsPrev, locale))}
      ${renderKpi(lt(locale, 'totalDepositsMonth'), formatCurrency(d.month.total_deposits), 'info')}
      ${renderKpi(lt(locale, 'totalWithdrawalsMonth'), formatCurrency(d.month.total_withdrawals), 'neutral')}
    </tr>
  `
      : `
    <tr>
      ${renderKpi(lt(locale, 'netDepositRange'), formatCurrency(d.range.net_deposit), d.range.net_deposit >= 0 ? 'positive' : 'negative', rangePctOfMonth !== null ? `${Math.round(rangePctOfMonth * 10) / 10}${lt(locale, 'pctOfMonth')}` : undefined)}
      ${renderKpi(lt(locale, 'netDepositMonth'), formatCurrency(d.month.net_deposit), d.month.net_deposit >= 0 ? 'positive' : 'negative', variationTag(monthVsPrev, locale))}
      ${renderKpi(lt(locale, 'netDepositPrevMonth'), formatCurrency(d.prev_month.net_deposit), 'neutral')}
    </tr>
  `;

  return `
    ${sectionHeader(primary, '💰', lt(locale, 'depositsWithdrawalsTitle'))}

    <table cellspacing="0" cellpadding="0" style="width:100%;margin-bottom:16px;">${kpiRow}</table>

    <div style="margin-bottom:16px;">
      <h3 style="font-size:14px;color:${BRAND_HEX.inkSoft};margin:0 0 8px 0;">${lt(locale, 'depositsByChannel')}</h3>
      ${renderTable([lt(locale, 'channel'), '#', lt(locale, 'amount')], depositsRows, locale, [lt(locale, 'total'), '', formatCurrency(d.range.total_deposits)])}
    </div>

    <div>
      <h3 style="font-size:14px;color:${BRAND_HEX.inkSoft};margin:0 0 8px 0;">${lt(locale, 'withdrawalsByCategory')}</h3>
      ${renderTable([lt(locale, 'category'), '#', lt(locale, 'amount')], withdrawalsRows, locale, [lt(locale, 'total'), '', formatCurrency(d.range.total_withdrawals)])}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRES CORRECCIONES DE HONESTIDAD (2026-08-31, auditoría de finanzas)
//
// 1. `connected` NO SE LEÍA EN NINGÚN LADO. El campo existe en las tres
//    secciones de CRM desde que se escribieron, y ninguna plantilla lo miraba:
//    una sección sin fuente salía con $0,00 y 0 usuarios, indistinguible de una
//    empresa que de verdad no vendió nada ese día. Ahora una sección no
//    conectada dice que no lo está y no dibuja ningún número.
//
// 2. EL BADGE «mock» ESTABA ROTO. Las tres líneas de título metían
//    `${BRAND_HEX.warning}` dentro de un string entre COMILLAS SIMPLES, así que
//    el correo mostraba el texto literal `${BRAND_HEX.warning}` como valor de
//    `color:` — el badge que avisa que los datos son falsos salía él mismo
//    roto. Estaba en :699, :742 y :798.
//
// 3. NINGÚN NÚMERO NULO SE DIBUJA COMO CERO. Ver `kpiNumber`.
// ─────────────────────────────────────────────────────────────────────────────

/** Importe para el cuerpo en TEXTO PLANO. `null` = «sin dato», jamás $0,00. */
export function moneyOrNoData(value: number | null, locale: EmailLocale): string {
  return value === null || !Number.isFinite(value)
    ? lt(locale, 'crmPnlNoData')
    : formatCurrency(value);
}

/** Badge «mock», con el color interpolado de verdad (ver punto 2 de arriba). */
function mockBadge(isMock: boolean): string {
  return isMock
    ? ` <span style="font-size:11px;color:${BRAND_HEX.warning};font-weight:normal;">· mock</span>`
    : '';
}

/**
 * Importe para un KPI: `null` es «sin dato», nunca $0,00 en verde.
 * Devuelve también el tono, porque un valor desconocido no es ni bueno ni malo.
 */
function kpiMoney(
  value: number | null,
  locale: EmailLocale,
): { text: string; tone: 'positive' | 'negative' | 'neutral' } {
  if (value === null || !Number.isFinite(value)) {
    return { text: lt(locale, 'crmPnlNoData'), tone: 'neutral' };
  }
  return { text: formatCurrency(value), tone: value >= 0 ? 'positive' : 'negative' };
}

/** Aviso de sección sin fuente configurada. Reemplaza a los ceros. */
function notConnectedNote(locale: EmailLocale): string {
  return `<p style="font-size:12px;color:${BRAND_HEX.muted};margin:0 10px 8px 10px;font-style:italic;">${lt(locale, 'sectionNotConnected')}</p>`;
}

function renderCrmUsersSection(data: ReportData, primary: string, locale: EmailLocale): string {
  const u = data.crm_users;
  const title = `${lt(locale, 'crmUsersTitle')}${mockBadge(u.isMock)}`;
  const numLocale = locale === 'es' ? 'es' : 'en';

  // Sin espejo de usuarios no hay tres ceros: hay tres «no lo sabemos».
  if (!u.connected && !u.isMock) {
    return `${sectionHeader(primary, '👥', title)}${notConnectedNote(locale)}`;
  }

  return `
    ${sectionHeader(primary, '👥', title)}
    <table cellspacing="0" cellpadding="0" style="width:100%;">
      <tr>
        ${renderKpi(lt(locale, 'newInPeriod'), u.new_users_in_range.toLocaleString(numLocale), 'info')}
        ${renderKpi(lt(locale, 'newThisMonth'), u.new_users_this_month.toLocaleString(numLocale), 'info')}
        ${renderKpi(lt(locale, 'totalOnPlatform'), u.total_users.toLocaleString(numLocale), 'neutral')}
      </tr>
    </table>
  `;
}

function renderBrokerPnlSection(
  data: ReportData,
  cadence: ReportCadence,
  primary: string,
  locale: EmailLocale,
): string {
  const p = data.broker_pnl;
  const monthVsPrev = pctVariation(p.pnl_month, p.pnl_prev_month);
  // Sin PNL del mes no hay porcentaje del mes. Antes `p.pnl_month` venía
  // colapsado a 0 con un `?? 0` en data.ts y esto daba null igual — por
  // casualidad, no por diseño.
  const rangePctOfMonth =
    p.pnl_month !== null && p.pnl_month !== 0 && p.pnl_range !== null
      ? (p.pnl_range / Math.abs(p.pnl_month)) * 100
      : null;

  const kMonth = kpiMoney(p.pnl_month, locale);
  const kPrev = kpiMoney(p.pnl_prev_month, locale);
  const kRange = kpiMoney(p.pnl_range, locale);

  const kpiRow =
    cadence === 'monthly'
      ? `
    <tr>
      ${renderKpi(lt(locale, 'pnlMonth'), kMonth.text, kMonth.tone, variationTag(monthVsPrev, locale))}
      ${renderKpi(lt(locale, 'pnlPrevMonth'), kPrev.text, 'neutral')}
      ${renderKpi(lt(locale, 'variationVsPrev'), variationText(monthVsPrev, locale), monthVsPrev === null ? 'neutral' : monthVsPrev >= 0 ? 'positive' : 'negative')}
    </tr>
  `
      : `
    <tr>
      ${renderKpi(lt(locale, 'pnlRange'), kRange.text, kRange.tone, rangePctOfMonth !== null ? `${Math.round(rangePctOfMonth * 10) / 10}${lt(locale, 'pctOfMonth')}` : undefined)}
      ${renderKpi(lt(locale, 'pnlMonth'), kMonth.text, kMonth.tone, variationTag(monthVsPrev, locale))}
      ${renderKpi(lt(locale, 'pnlPrevMonth'), kPrev.text, 'neutral')}
    </tr>
  `;

  const title = `Broker P&amp;L${mockBadge(p.isMock)}`;

  // ── El cierre que da el CRM ──────────────────────────────────────────────
  // El diario lleva EL DÍA (que es lo que se pregunta a la mañana); el
  // semanal y el mensual llevan el acumulado del período. Y los dos llevan
  // sobre cuántos días se calculó: un acumulado al que le faltan días es un
  // número más chico y perfectamente creíble si nadie lo dice.
  const c = p.crm;
  const crmBlock = !c
    ? ''
    : `
    <table cellspacing="0" cellpadding="0" style="width:100%;">
      <tr>
        ${
          cadence === 'daily'
            ? renderKpi(
                lt(locale, 'crmPnlDay'),
                c.last_broker_pnl === null ? lt(locale, 'crmPnlNoData') : formatCurrency(c.last_broker_pnl),
                c.last_broker_pnl === null ? 'neutral' : c.last_broker_pnl >= 0 ? 'positive' : 'negative',
                c.last_day ?? undefined,
              )
            : renderKpi(
                lt(locale, 'crmPnlPeriod'),
                c.broker_pnl_range === null ? lt(locale, 'crmPnlNoData') : formatCurrency(c.broker_pnl_range),
                c.broker_pnl_range === null ? 'neutral' : c.broker_pnl_range >= 0 ? 'positive' : 'negative',
                lt(locale, 'crmPnlDays', { days: String(c.days_with_data) }),
              )
        }
        ${renderKpi(lt(locale, 'crmPnlVolume'), c.volume_lots_range.toLocaleString(locale === 'es' ? 'es-ES' : 'en-US'), 'neutral')}
        ${renderKpi(lt(locale, 'crmPnlDeals'), c.deals_range.toLocaleString(locale === 'es' ? 'es-ES' : 'en-US'), 'neutral')}
      </tr>
    </table>
    <p style="font-size:11px;color:${BRAND_HEX.muted};margin:4px 10px 0 10px;">
      ${lt(locale, 'crmPnlSource')}${
        c.days_missing.length > 0
          ? ` · ${escapeHtml(lt(locale, 'crmPnlMissing', { n: String(c.days_missing.length), days: c.days_missing.slice(0, 5).join(', ') }))}`
          : ''
      }
    </p>
  `;

  if (!p.connected && !p.isMock && !p.crm) {
    return `${sectionHeader(primary, '📈', title)}${notConnectedNote(locale)}`;
  }

  return `
    ${sectionHeader(primary, '📈', title)}
    <table cellspacing="0" cellpadding="0" style="width:100%;">${kpiRow}</table>
    ${crmBlock}
  `;
}

function renderPropTradingSection(data: ReportData, primary: string, locale: EmailLocale): string {
  const p = data.prop_trading;
  const title = `${lt(locale, 'propTradingTitle')}${mockBadge(p.isMock)}`;

  if (!p.connected && !p.isMock) {
    return `${sectionHeader(primary, '🎯', title)}${notConnectedNote(locale)}`;
  }

  const kSales = kpiMoney(p.total_sales_range, locale);
  const kWdr = kpiMoney(p.prop_withdrawals_range, locale);
  const kPnl = kpiMoney(p.pnl_range, locale);
  const kMonth = kpiMoney(p.total_sales_month, locale);

  // «Productos vendidos» sin desglose: `crm_monthly_totals` guarda el total del
  // mes, no qué se vendió. Antes esto era una tabla vacía, que se lee como «no
  // se vendió nada». Se dice que el desglose no está, y se muestra el total.
  const productsBlock =
    p.products === null
      ? `<p style="font-size:12px;color:${BRAND_HEX.muted};margin:0 10px 8px 10px;font-style:italic;">${lt(locale, 'productsNoBreakdown')}</p>`
      : renderTable(
          [lt(locale, 'product'), lt(locale, 'quantity'), lt(locale, 'amount')],
          p.products.map((prod) => [prod.name, String(prod.quantity), formatCurrency(prod.amount)]),
          locale,
          [lt(locale, 'totalOfRange'), '', kSales.text],
        );

  return `
    ${sectionHeader(primary, '🎯', title)}

    <div style="margin-bottom:16px;">
      <h3 style="font-size:14px;color:${BRAND_HEX.inkSoft};margin:0 0 8px 0;">${lt(locale, 'productsSold')}</h3>
      ${productsBlock}
    </div>

    <table cellspacing="0" cellpadding="0" style="width:100%;">
      <tr>
        ${renderKpi(lt(locale, 'salesOfRange'), kSales.text, 'info', lt(locale, 'monthPrefix', { value: kMonth.text }))}
        ${renderKpi(lt(locale, 'propWithdrawals'), kWdr.text, 'neutral', p.prop_withdrawals_count_range === null ? undefined : lt(locale, 'withdrawalsCount', { count: p.prop_withdrawals_count_range }))}
        ${renderKpi(lt(locale, 'pnlRange'), kPnl.text, kPnl.tone)}
      </tr>
    </table>
  `;
}

// ─── Main render ──────────────────────────────────────────────────────

export interface ReportSectionToggles {
  deposits_withdrawals: boolean;
  balances_by_channel: boolean;
  crm_users: boolean;
  broker_pnl: boolean;
  prop_trading: boolean;
}

const ALL_SECTIONS_ON: ReportSectionToggles = {
  deposits_withdrawals: true,
  balances_by_channel: true,
  crm_users: true,
  broker_pnl: true,
  prop_trading: true,
};

export interface RenderReportEmailParams {
  data: ReportData;
  cadence: ReportCadence;
  companyName: string;
  companyLogoUrl?: string | null;
  /** Hex colour (with leading #) that brands the email header + section
   *  accents. Falls back to the Horizon navy. */
  primaryColor?: string | null;
  sections?: ReportSectionToggles;
  /** ISO timestamp of the most recent external-API sync. When present,
   *  rendered as a small footer line so the recipient knows how fresh
   *  the numbers are. */
  lastSyncedAt?: string | null;
  /** Recipient language. Defaults to 'en' — users without a configured
   *  preference receive English. */
  locale?: EmailLocale;
}

/** Format an ISO timestamp as "DD MMM YYYY · HH:MM UTC". Used in the
 *  email footer to convey data freshness. Returns empty string if input
 *  is null / unparseable so the footer simply omits the line. */
function formatSyncTimestamp(iso: string | null | undefined, locale: EmailLocale): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const day = d.getUTCDate();
  const month = MONTHS[locale][d.getUTCMonth()] ?? '';
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (locale === 'en') return `${month} ${day} ${year} · ${hh}:${mm} UTC`;
  return `${day} ${month} ${year} · ${hh}:${mm} UTC`;
}

export function renderReportEmail(params: RenderReportEmailParams): string {
  const { data, cadence, companyName, companyLogoUrl } = params;
  const locale = params.locale ?? 'en';
  const sections = params.sections ?? ALL_SECTIONS_ON;
  const primary = normalizeHex(params.primaryColor) ?? BRAND_HEX.primary;
  const title = reportTitle(cadence, locale);
  const syncStamp = formatSyncTimestamp(params.lastSyncedAt, locale);
  const rangeLabel =
    cadence === 'daily'
      ? formatDate(data.range.from, locale)
      : `${formatDate(data.range.from, locale)} — ${formatDate(data.range.to, locale)}`;

  const failureNote =
    data.failures.length > 0
      ? `
    <div style="margin:16px 0;padding:12px;background:#FEF3C7;border:1px solid ${BRAND_HEX.warning};border-radius:8px;color:#92400E;font-size:12px;">
      ${lt(locale, 'failureNote', { failures: data.failures.join(', ') })}
    </div>
  `
      : '';

  const mockNote = data.anyMock
    ? `
    <div style="margin:16px 0;padding:10px;background:#FEF9C3;border:1px solid #FACC15;border-radius:8px;color:#854D0E;font-size:11px;">
      ${lt(locale, 'mockNote')}
    </div>
  `
    : '';

  const logoHtml = companyLogoUrl
    ? `<img src="${escapeHtml(companyLogoUrl)}" alt="${escapeHtml(companyName)}" style="max-height:44px;max-width:200px;object-fit:contain;display:block;" />`
    : `<div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">${escapeHtml(companyName)}</div>`;

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND_HEX.inkSoft};">
  <table cellspacing="0" cellpadding="0" style="width:100%;background:#F1F5F9;padding:24px 0;">
    <tr>
      <td align="center">
        <table cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(15,23,42,0.08);">

          <!-- Branded header (primary colour fill) -->
          <tr>
            <td style="background:${primary};padding:28px 32px;">
              <table cellspacing="0" cellpadding="0" style="width:100%;">
                <tr>
                  <td style="vertical-align:middle;">
                    ${logoHtml}
                  </td>
                  <td align="right" style="vertical-align:middle;color:#ffffffcc;font-size:11px;letter-spacing:0.3px;">
                    Smart Dashboard
                  </td>
                </tr>
              </table>
              <h1 style="font-size:22px;color:#ffffff;margin:18px 0 4px 0;font-weight:700;">${escapeHtml(title)}</h1>
              <div style="color:#ffffffcc;font-size:13px;">${escapeHtml(rangeLabel)}</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:8px 32px 32px 32px;">
              ${failureNote}
              ${mockNote}
              ${data.company_result ? renderCompanyResultSection(data.company_result, primary, locale) : ''}
              ${sections.deposits_withdrawals ? renderDepositsWithdrawalsSection(data, cadence, primary, locale) : ''}
              ${sections.balances_by_channel ? renderBalancesByChannelSection(data, primary, locale) : ''}
              ${sections.crm_users ? renderCrmUsersSection(data, primary, locale) : ''}
              ${sections.broker_pnl ? renderBrokerPnlSection(data, cadence, primary, locale) : ''}
              ${sections.prop_trading ? renderPropTradingSection(data, primary, locale) : ''}
            </td>
          </tr>

          <!-- Dark footer -->
          <tr>
            <td style="padding:24px 32px;background:${BRAND_HEX.ink};color:#CBD5E1;font-size:11px;text-align:center;">
              <div style="font-weight:600;color:#ffffff;font-size:12px;margin-bottom:10px;">${escapeHtml(companyName)}</div>
              <img src="${DASHBOARD_URL}/brand/logo-white.png" alt="Smart Dashboard" width="140" style="max-width:140px;height:auto;display:inline-block;margin:4px 0 10px 0;opacity:0.9;" />
              <br />
              ${lt(locale, 'generatedBy')}
              <a href="${DASHBOARD_URL}" style="color:#93C5FD;text-decoration:none;">Smart Dashboard</a>.
              ${syncStamp ? `<br /><span style="color:${BRAND_HEX.mutedLight};font-size:10px;">${lt(locale, 'dataUpdated', { stamp: escapeHtml(syncStamp) })}</span>` : ''}
              <br />
              <span style="color:${BRAND_HEX.mutedLight};font-size:10px;">${lt(locale, 'unsubscribe')}</span>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Plain-text fallback — SendGrid appends this when set, improves deliverability.
export function renderReportEmailText(params: RenderReportEmailParams): string {
  const { data, cadence, companyName } = params;
  const locale = params.locale ?? 'en';
  // Igual que el HTML: el cuerpo text/plain también respeta las secciones. Antes
  // imprimía SIEMPRE depósitos / Net Deposit / Broker P&L / Prop Trading, así que
  // una empresa 'company' recibía en el texto los bloques que el HTML omitía.
  const sections = params.sections ?? ALL_SECTIONS_ON;
  const title = reportTitle(cadence, locale);
  const d = data.deposits_withdrawals;

  const lines: string[] = [
    `${title} — ${companyName}`,
    `${lt(locale, 'textPeriod')}: ${data.range.from} → ${data.range.to}`,
    ``,
  ];

  // Mismo criterio que el HTML: el bloque de la empresa de servicios no es
  // un toggle, viene con el modelo de negocio.
  if (data.company_result) {
    const r = data.company_result;
    lines.push(
      lt(locale, 'textCompanyResult'),
      `  ${lt(locale, 'textBilled')}: ${formatCurrency(r.billing.billed)}`,
      `  ${lt(locale, 'textCollected')}: ${formatCurrency(r.billing.collected)}`,
      `  ${lt(locale, 'textReceivable')}: ${formatCurrency(r.billing.pending)}`,
      `  ${lt(locale, 'textExpensesPaid')}: ${formatCurrency(r.expenses.paid)}`,
      `  ${lt(locale, 'textExpensesPending')}: ${formatCurrency(r.expenses.pending)}`,
      `  ${lt(locale, 'textCashResult')}: ${formatCurrency(r.cashResult)}`,
      ``,
    );
  }

  if (sections.deposits_withdrawals) {
    lines.push(
      lt(locale, 'textDepositsWithdrawals'),
      `  ${lt(locale, 'textTotalDeposits')}: ${formatCurrency(d.range.total_deposits)}`,
      `  ${lt(locale, 'textTotalWithdrawals')}: ${formatCurrency(d.range.total_withdrawals)}`,
      `  Net Deposit: ${formatCurrency(d.range.net_deposit)}`,
      ``,
      lt(locale, 'textCurrentMonth'),
      `  Net Deposit: ${formatCurrency(d.month.net_deposit)}`,
      `  (${lt(locale, 'textPrevMonth')}: ${formatCurrency(d.prev_month.net_deposit)})`,
      ``,
    );
  }

  if (sections.balances_by_channel) {
    lines.push(
      lt(locale, 'textBalancesByChannel'),
      ...(data.balances_by_channel.channels.length === 0
        ? [`  ${lt(locale, 'textNoVisibleChannels')}`]
        : data.balances_by_channel.channels.map(
            (c) =>
              `  ${c.label.padEnd(28, ' ')} ${c.source === 'missing' ? 's/d' : formatCurrency(c.amount)}`,
          )),
      `  ${'TOTAL'.padEnd(28, ' ')} ${formatCurrency(data.balances_by_channel.total)}`,
      ``,
    );
  }

  if (sections.crm_users) {
    lines.push(
      lt(locale, 'textCrmUsers'),
      `  ${lt(locale, 'textNewInRange')}: ${data.crm_users.new_users_in_range}`,
      `  ${lt(locale, 'textNewThisMonth')}: ${data.crm_users.new_users_this_month}`,
      `  ${lt(locale, 'textTotal')}: ${data.crm_users.total_users}`,
      ``,
    );
  }

  if (sections.broker_pnl) {
    lines.push(
      lt(locale, 'textBrokerPnl'),
      `  ${lt(locale, 'textRange')}: ${moneyOrNoData(data.broker_pnl.pnl_range, locale)}`,
      `  ${lt(locale, 'textMonth')}: ${moneyOrNoData(data.broker_pnl.pnl_month, locale)}`,
      `  ${lt(locale, 'textPrevMonth')}: ${moneyOrNoData(data.broker_pnl.pnl_prev_month, locale)}`,
    );
    const c = data.broker_pnl.crm;
    if (c) {
      // Mismo criterio que el HTML: el diario lleva el día, el resto el
      // acumulado, y los dos dicen sobre cuántos días se calcularon.
      lines.push(
        cadence === 'daily'
          ? `  ${lt(locale, 'textCrmPnlDay')}${c.last_day ? ` (${c.last_day})` : ''}: ${c.last_broker_pnl === null ? lt(locale, 'crmPnlNoData') : formatCurrency(c.last_broker_pnl)}`
          : `  ${lt(locale, 'textCrmPnlPeriod')}: ${c.broker_pnl_range === null ? lt(locale, 'crmPnlNoData') : formatCurrency(c.broker_pnl_range)} (${lt(locale, 'crmPnlDays', { days: String(c.days_with_data) })})`,
      );
      if (c.days_missing.length > 0) {
        lines.push(
          `  ${lt(locale, 'crmPnlMissing', { n: String(c.days_missing.length), days: c.days_missing.slice(0, 5).join(', ') })}`,
        );
      }
    }
    lines.push(``);
  }

  if (sections.prop_trading) {
    lines.push(
      lt(locale, 'textPropTrading'),
      `  ${lt(locale, 'textSalesRange')}: ${moneyOrNoData(data.prop_trading.total_sales_range, locale)}`,
      `  ${lt(locale, 'textWithdrawalsRange')}: ${moneyOrNoData(data.prop_trading.prop_withdrawals_range, locale)}`,
      `  ${lt(locale, 'textPnlRange')}: ${moneyOrNoData(data.prop_trading.pnl_range, locale)}`,
      ``,
    );
  }

  lines.push(
    `---`,
    `Smart Dashboard · ${DASHBOARD_URL}`,
    cadence === 'daily'
      ? lt(locale, 'textAutoDaily')
      : cadence === 'weekly'
        ? lt(locale, 'textAutoWeekly')
        : lt(locale, 'textAutoMonthly'),
  );

  return lines.join('\n');
}
