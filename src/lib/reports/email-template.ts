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
    other: 'Otros',
  },
  en: {
    coinsbuy: 'Coinsbuy',
    fairpay: 'FairPay',
    unipayment: 'UniPayment',
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
  },
  en: {
    ib_commissions: 'IB Commissions',
    broker: 'Broker',
    prop_firm: 'Prop Firm',
    other: 'Other',
    p2p: 'P2P Transfer',
    coinsbuy_api: 'Coinsbuy (API)',
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

function pctVariation(current: number, previous: number): number | null {
  if (!previous) return null;
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

function renderCrmUsersSection(data: ReportData, primary: string, locale: EmailLocale): string {
  const u = data.crm_users;
  const title = `${lt(locale, 'crmUsersTitle')}${u.isMock ? ' <span style="font-size:11px;color:${BRAND_HEX.warning};font-weight:normal;">· mock</span>' : ''}`;
  const numLocale = locale === 'es' ? 'es' : 'en';
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
  const rangePctOfMonth = p.pnl_month
    ? (p.pnl_range / Math.abs(p.pnl_month)) * 100
    : null;

  const kpiRow =
    cadence === 'monthly'
      ? `
    <tr>
      ${renderKpi(lt(locale, 'pnlMonth'), formatCurrency(p.pnl_month), p.pnl_month >= 0 ? 'positive' : 'negative', variationTag(monthVsPrev, locale))}
      ${renderKpi(lt(locale, 'pnlPrevMonth'), formatCurrency(p.pnl_prev_month), 'neutral')}
      ${renderKpi(lt(locale, 'variationVsPrev'), variationText(monthVsPrev, locale), monthVsPrev === null ? 'neutral' : monthVsPrev >= 0 ? 'positive' : 'negative')}
    </tr>
  `
      : `
    <tr>
      ${renderKpi(lt(locale, 'pnlRange'), formatCurrency(p.pnl_range), p.pnl_range >= 0 ? 'positive' : 'negative', rangePctOfMonth !== null ? `${Math.round(rangePctOfMonth * 10) / 10}${lt(locale, 'pctOfMonth')}` : undefined)}
      ${renderKpi(lt(locale, 'pnlMonth'), formatCurrency(p.pnl_month), p.pnl_month >= 0 ? 'positive' : 'negative', variationTag(monthVsPrev, locale))}
      ${renderKpi(lt(locale, 'pnlPrevMonth'), formatCurrency(p.pnl_prev_month), 'neutral')}
    </tr>
  `;

  const title = `Broker P&amp;L${p.isMock ? ' <span style="font-size:11px;color:${BRAND_HEX.warning};font-weight:normal;">· mock</span>' : ''}`;
  return `
    ${sectionHeader(primary, '📈', title)}
    <table cellspacing="0" cellpadding="0" style="width:100%;">${kpiRow}</table>
  `;
}

function renderPropTradingSection(data: ReportData, primary: string, locale: EmailLocale): string {
  const p = data.prop_trading;
  const productRows = p.products.map((prod) => [
    prod.name,
    String(prod.quantity),
    formatCurrency(prod.amount),
  ]);

  const title = `${lt(locale, 'propTradingTitle')}${p.isMock ? ' <span style="font-size:11px;color:${BRAND_HEX.warning};font-weight:normal;">· mock</span>' : ''}`;
  return `
    ${sectionHeader(primary, '🎯', title)}

    <div style="margin-bottom:16px;">
      <h3 style="font-size:14px;color:${BRAND_HEX.inkSoft};margin:0 0 8px 0;">${lt(locale, 'productsSold')}</h3>
      ${renderTable([lt(locale, 'product'), lt(locale, 'quantity'), lt(locale, 'amount')], productRows, locale, [lt(locale, 'totalOfRange'), '', formatCurrency(p.total_sales_range)])}
    </div>

    <table cellspacing="0" cellpadding="0" style="width:100%;">
      <tr>
        ${renderKpi(lt(locale, 'salesOfRange'), formatCurrency(p.total_sales_range), 'info', lt(locale, 'monthPrefix', { value: formatCurrency(p.total_sales_month) }))}
        ${renderKpi(lt(locale, 'propWithdrawals'), formatCurrency(p.prop_withdrawals_range), 'neutral', lt(locale, 'withdrawalsCount', { count: p.prop_withdrawals_count_range }))}
        ${renderKpi(lt(locale, 'pnlRange'), formatCurrency(p.pnl_range), p.pnl_range >= 0 ? 'positive' : 'negative')}
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
      `  ${lt(locale, 'textRange')}: ${formatCurrency(data.broker_pnl.pnl_range)}`,
      `  ${lt(locale, 'textMonth')}: ${formatCurrency(data.broker_pnl.pnl_month)}`,
      `  ${lt(locale, 'textPrevMonth')}: ${formatCurrency(data.broker_pnl.pnl_prev_month)}`,
      ``,
    );
  }

  if (sections.prop_trading) {
    lines.push(
      lt(locale, 'textPropTrading'),
      `  ${lt(locale, 'textSalesRange')}: ${formatCurrency(data.prop_trading.total_sales_range)}`,
      `  ${lt(locale, 'textWithdrawalsRange')}: ${formatCurrency(data.prop_trading.prop_withdrawals_range)}`,
      `  ${lt(locale, 'textPnlRange')}: ${formatCurrency(data.prop_trading.pnl_range)}`,
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
