// ─────────────────────────────────────────────────────────────────────────────
// Reports email HTML template.
//
// Single renderer used by all three cadences (daily / weekly / monthly).
// The differences are:
//   · The title + subject are cadence-dependent (done by the caller).
//   · Whether to show "% vs mes" comparisons — daily/weekly show them,
//     monthly shows the full month-vs-prev-month block instead.
//
// HTML is plain table-based email HTML — deliberately old-school, because
// every real email client in 2026 still renders it more reliably than CSS
// grid / flexbox. Inline styles only (no <style> tags inside the body,
// outlook strips them anyway).
//
// Colour palette matches the dashboard:
//   Primary navy:  #1E3A5F
//   Accent blue:   #3B82F6
//   Emerald:       #10B981 (positive)
//   Red:           #EF4444 (negative)
//   Slate body:    #334155
// ─────────────────────────────────────────────────────────────────────────────

import type { ReportData } from './data';
import { formatCurrency } from '@/lib/utils';

const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'https://dashboard.horizonconsulting.ai';

export type ReportCadence = 'daily' | 'weekly' | 'monthly';

// Spanish month names for the range header
const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

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

function formatDateEs(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS_ES[m - 1]} ${y}`;
}

function pctVariation(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function variationTag(pct: number | null, invertColor = false): string {
  if (pct === null || !isFinite(pct)) {
    return `<span style="color:#94a3b8;font-size:12px;">sin comparativa</span>`;
  }
  const rounded = Math.round(pct * 10) / 10;
  const positive = invertColor ? rounded < 0 : rounded >= 0;
  const color = positive ? '#10B981' : '#EF4444';
  const arrow = rounded >= 0 ? '▲' : '▼';
  return `<span style="color:${color};font-weight:600;font-size:12px;">${arrow} ${rounded > 0 ? '+' : ''}${rounded}% vs mes anterior</span>`;
}

/**
 * Plain-text "+12.5%" / "-3.2%" for KPI bodies where HTML would be escaped.
 * Use this when the percent should land in `value` (which goes through
 * escapeHtml); use variationTag() when it goes into `hint` (raw-rendered).
 */
function variationText(pct: number | null): string {
  if (pct === null || !isFinite(pct)) return 'sin datos';
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

// ─── Cadence metadata ──────────────────────────────────────────────────

export interface EmailSubjectParts {
  companyName: string;
  cadence: ReportCadence;
  range: { from: string; to: string };
}

export function reportEmailSubject(parts: EmailSubjectParts): string {
  const { companyName, cadence, range } = parts;
  if (cadence === 'daily') {
    return `📊 Reporte Financiero — ${companyName} — ${formatDateEs(range.from)}`;
  }
  if (cadence === 'weekly') {
    return `📊 Reporte Semanal — ${companyName} — Semana del ${formatDateEs(range.from)} al ${formatDateEs(range.to)}`;
  }
  // monthly: use the month of the `from` date.
  const [y, m] = range.from.split('-').map(Number);
  const monthLabel =
    y && m
      ? `${MONTHS_ES[m - 1]!.charAt(0).toUpperCase() + MONTHS_ES[m - 1]!.slice(1)} ${y}`
      : `${range.from} → ${range.to}`;
  return `📊 Reporte Mensual — ${companyName} — ${monthLabel}`;
}

function reportTitle(cadence: ReportCadence): string {
  if (cadence === 'daily') return 'Reporte Financiero Diario';
  if (cadence === 'weekly') return 'Reporte Financiero Semanal';
  return 'Reporte Financiero Mensual';
}

// ─── Partial renderers ────────────────────────────────────────────────

function renderKpi(
  label: string,
  value: string,
  tone: 'positive' | 'negative' | 'neutral' | 'info',
  hint?: string,
): string {
  const colors: Record<typeof tone, string> = {
    positive: '#10B981',
    negative: '#EF4444',
    neutral: '#334155',
    info: '#3B82F6',
  };
  return `
    <td align="center" valign="top" style="padding:10px;width:33%;">
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:16px;">
        <div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${escapeHtml(label)}</div>
        <div style="font-size:22px;color:${colors[tone]};font-weight:700;margin-top:6px;">${escapeHtml(value)}</div>
        ${hint ? `<div style="font-size:11px;color:#64748B;margin-top:4px;">${hint}</div>` : ''}
      </div>
    </td>
  `;
}

function renderTable(
  headers: string[],
  rows: string[][],
  totalRow?: string[],
): string {
  const thead = headers
    .map(
      (h, i) => `
    <th style="text-align:${i === 0 ? 'left' : 'right'};padding:8px 12px;background:#1E3A5F;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${escapeHtml(h)}</th>
  `,
    )
    .join('');

  const tbody = rows.length
    ? rows
        .map(
          (r, ri) => `
      <tr style="background:${ri % 2 === 0 ? '#fff' : '#F8FAFC'};">
        ${r.map((c, i) => `<td style="text-align:${i === 0 ? 'left' : 'right'};padding:8px 12px;font-size:13px;border-bottom:1px solid #E2E8F0;color:#334155;">${escapeHtml(c)}</td>`).join('')}
      </tr>
    `,
        )
        .join('')
    : `<tr><td colspan="${headers.length}" style="padding:12px;text-align:center;color:#64748B;font-size:12px;font-style:italic;">Sin datos en el período</td></tr>`;

  const foot = totalRow
    ? `
    <tr style="background:#F1F5F9;font-weight:700;">
      ${totalRow.map((c, i) => `<td style="text-align:${i === 0 ? 'left' : 'right'};padding:10px 12px;font-size:13px;color:#1E3A5F;">${escapeHtml(c)}</td>`).join('')}
    </tr>
  `
    : '';

  return `
    <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;">
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

function renderBalancesByChannelSection(data: ReportData, primary: string): string {
  const b = data.balances_by_channel;
  const typeLabel = (t: 'api' | 'manual' | 'auto') =>
    t === 'api' ? 'API' : t === 'auto' ? 'Automático' : 'Manual';
  const rows = b.channels.map((c) => [
    c.label,
    typeLabel(c.type),
    formatCurrency(c.amount),
  ]);
  const totalRow: string[] = ['Total Consolidado', '', formatCurrency(b.total)];

  const emptyNote =
    b.channels.length === 0
      ? `<p style="font-size:12px;color:#64748B;font-style:italic;margin:6px 0 0 0;">No hay canales visibles configurados.</p>`
      : '';

  return `
    ${sectionHeader(primary, '🏦', 'Balances por Canal')}
    <p style="font-size:11px;color:#64748B;margin:0 0 8px 0;">Al ${escapeHtml(b.asOf)}</p>
    ${b.channels.length ? renderTable(['Canal', 'Tipo', 'Balance'], rows, totalRow) : ''}
    ${emptyNote}
  `;
}

function renderDepositsWithdrawalsSection(
  data: ReportData,
  cadence: ReportCadence,
  primary: string,
): string {
  const d = data.deposits_withdrawals;
  const depositsRows = d.range.deposits
    .sort((a, b) => b.amount - a.amount)
    .map((r) => [CHANNEL_LABEL[r.channel] ?? r.channel, String(r.count), formatCurrency(r.amount)]);
  const withdrawalsRows = d.range.withdrawals
    .sort((a, b) => b.amount - a.amount)
    .map((r) => [CATEGORY_LABEL[r.category] ?? r.category, String(r.count), formatCurrency(r.amount)]);

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
      ${renderKpi('Net Deposit del mes', formatCurrency(d.month.net_deposit), d.month.net_deposit >= 0 ? 'positive' : 'negative', variationTag(monthVsPrev))}
      ${renderKpi('Depósitos totales del mes', formatCurrency(d.month.total_deposits), 'info')}
      ${renderKpi('Retiros totales del mes', formatCurrency(d.month.total_withdrawals), 'neutral')}
    </tr>
  `
      : `
    <tr>
      ${renderKpi('Net Deposit del rango', formatCurrency(d.range.net_deposit), d.range.net_deposit >= 0 ? 'positive' : 'negative', rangePctOfMonth !== null ? `${Math.round(rangePctOfMonth * 10) / 10}% del mes` : undefined)}
      ${renderKpi('Net Deposit del mes', formatCurrency(d.month.net_deposit), d.month.net_deposit >= 0 ? 'positive' : 'negative', variationTag(monthVsPrev))}
      ${renderKpi('Net Deposit mes anterior', formatCurrency(d.prev_month.net_deposit), 'neutral')}
    </tr>
  `;

  return `
    ${sectionHeader(primary, '💰', 'Depósitos y Retiros')}

    <table cellspacing="0" cellpadding="0" style="width:100%;margin-bottom:16px;">${kpiRow}</table>

    <div style="margin-bottom:16px;">
      <h3 style="font-size:14px;color:#334155;margin:0 0 8px 0;">Depósitos por canal</h3>
      ${renderTable(['Canal', '#', 'Monto'], depositsRows, ['Total', '', formatCurrency(d.range.total_deposits)])}
    </div>

    <div>
      <h3 style="font-size:14px;color:#334155;margin:0 0 8px 0;">Retiros por categoría</h3>
      ${renderTable(['Categoría', '#', 'Monto'], withdrawalsRows, ['Total', '', formatCurrency(d.range.total_withdrawals)])}
    </div>
  `;
}

function renderCrmUsersSection(data: ReportData, primary: string): string {
  const u = data.crm_users;
  const title = `Usuarios CRM${u.isMock ? ' <span style="font-size:11px;color:#F59E0B;font-weight:normal;">· mock</span>' : ''}`;
  return `
    ${sectionHeader(primary, '👥', title)}
    <table cellspacing="0" cellpadding="0" style="width:100%;">
      <tr>
        ${renderKpi('Nuevos en el período', u.new_users_in_range.toLocaleString('es'), 'info')}
        ${renderKpi('Nuevos este mes', u.new_users_this_month.toLocaleString('es'), 'info')}
        ${renderKpi('Total en plataforma', u.total_users.toLocaleString('es'), 'neutral')}
      </tr>
    </table>
  `;
}

function renderBrokerPnlSection(data: ReportData, cadence: ReportCadence, primary: string): string {
  const p = data.broker_pnl;
  const monthVsPrev = pctVariation(p.pnl_month, p.pnl_prev_month);
  const rangePctOfMonth = p.pnl_month
    ? (p.pnl_range / Math.abs(p.pnl_month)) * 100
    : null;

  const kpiRow =
    cadence === 'monthly'
      ? `
    <tr>
      ${renderKpi('P&L del mes', formatCurrency(p.pnl_month), p.pnl_month >= 0 ? 'positive' : 'negative', variationTag(monthVsPrev))}
      ${renderKpi('P&L mes anterior', formatCurrency(p.pnl_prev_month), 'neutral')}
      ${renderKpi('Variación vs mes anterior', variationText(monthVsPrev), monthVsPrev === null ? 'neutral' : monthVsPrev >= 0 ? 'positive' : 'negative')}
    </tr>
  `
      : `
    <tr>
      ${renderKpi('P&L del rango', formatCurrency(p.pnl_range), p.pnl_range >= 0 ? 'positive' : 'negative', rangePctOfMonth !== null ? `${Math.round(rangePctOfMonth * 10) / 10}% del mes` : undefined)}
      ${renderKpi('P&L del mes', formatCurrency(p.pnl_month), p.pnl_month >= 0 ? 'positive' : 'negative', variationTag(monthVsPrev))}
      ${renderKpi('P&L mes anterior', formatCurrency(p.pnl_prev_month), 'neutral')}
    </tr>
  `;

  const title = `Broker P&amp;L${p.isMock ? ' <span style="font-size:11px;color:#F59E0B;font-weight:normal;">· mock</span>' : ''}`;
  return `
    ${sectionHeader(primary, '📈', title)}
    <table cellspacing="0" cellpadding="0" style="width:100%;">${kpiRow}</table>
  `;
}

function renderPropTradingSection(data: ReportData, primary: string): string {
  const p = data.prop_trading;
  const productRows = p.products.map((prod) => [
    prod.name,
    String(prod.quantity),
    formatCurrency(prod.amount),
  ]);

  const title = `Prop Trading Firm${p.isMock ? ' <span style="font-size:11px;color:#F59E0B;font-weight:normal;">· mock</span>' : ''}`;
  return `
    ${sectionHeader(primary, '🎯', title)}

    <div style="margin-bottom:16px;">
      <h3 style="font-size:14px;color:#334155;margin:0 0 8px 0;">Productos vendidos</h3>
      ${renderTable(['Producto', 'Cantidad', 'Monto'], productRows, ['Total del rango', '', formatCurrency(p.total_sales_range)])}
    </div>

    <table cellspacing="0" cellpadding="0" style="width:100%;">
      <tr>
        ${renderKpi('Ventas del rango', formatCurrency(p.total_sales_range), 'info', `Mes: ${formatCurrency(p.total_sales_month)}`)}
        ${renderKpi('Retiros Prop Firm', formatCurrency(p.prop_withdrawals_range), 'neutral', `${p.prop_withdrawals_count_range} retiros`)}
        ${renderKpi('P&L del rango', formatCurrency(p.pnl_range), p.pnl_range >= 0 ? 'positive' : 'negative')}
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
}

/** Format an ISO timestamp as "DD MMM YYYY · HH:MM UTC". Used in the
 *  email footer to convey data freshness. Returns empty string if input
 *  is null / unparseable so the footer simply omits the line. */
function formatSyncTimestamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const day = d.getUTCDate();
  const month = MONTHS_ES[d.getUTCMonth()] ?? '';
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year} · ${hh}:${mm} UTC`;
}

export function renderReportEmail(params: RenderReportEmailParams): string {
  const { data, cadence, companyName, companyLogoUrl } = params;
  const sections = params.sections ?? ALL_SECTIONS_ON;
  const primary = normalizeHex(params.primaryColor) ?? '#1E3A5F';
  const title = reportTitle(cadence);
  const syncStamp = formatSyncTimestamp(params.lastSyncedAt);
  const rangeLabel =
    cadence === 'daily'
      ? formatDateEs(data.range.from)
      : `${formatDateEs(data.range.from)} — ${formatDateEs(data.range.to)}`;

  const failureNote =
    data.failures.length > 0
      ? `
    <div style="margin:16px 0;padding:12px;background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;color:#92400E;font-size:12px;">
      ⚠️ Algunas fuentes no respondieron y se omitieron del reporte: ${data.failures.join(', ')}. El resto de los datos son correctos.
    </div>
  `
      : '';

  const mockNote = data.anyMock
    ? `
    <div style="margin:16px 0;padding:10px;background:#FEF9C3;border:1px solid #FACC15;border-radius:8px;color:#854D0E;font-size:11px;">
      Los datos de Orion CRM provienen del entorno mock. Configure las credenciales en Superadmin → APIs externas para recibir datos reales.
    </div>
  `
    : '';

  const logoHtml = companyLogoUrl
    ? `<img src="${escapeHtml(companyLogoUrl)}" alt="${escapeHtml(companyName)}" style="max-height:44px;max-width:200px;object-fit:contain;display:block;" />`
    : `<div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">${escapeHtml(companyName)}</div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#334155;">
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
              ${sections.deposits_withdrawals ? renderDepositsWithdrawalsSection(data, cadence, primary) : ''}
              ${sections.balances_by_channel ? renderBalancesByChannelSection(data, primary) : ''}
              ${sections.crm_users ? renderCrmUsersSection(data, primary) : ''}
              ${sections.broker_pnl ? renderBrokerPnlSection(data, cadence, primary) : ''}
              ${sections.prop_trading ? renderPropTradingSection(data, primary) : ''}
            </td>
          </tr>

          <!-- Dark footer -->
          <tr>
            <td style="padding:24px 32px;background:#0F172A;color:#CBD5E1;font-size:11px;text-align:center;">
              <div style="font-weight:600;color:#ffffff;font-size:12px;margin-bottom:10px;">${escapeHtml(companyName)}</div>
              <img src="${DASHBOARD_URL}/brand/logo-white.png" alt="Smart Dashboard" width="140" style="max-width:140px;height:auto;display:inline-block;margin:4px 0 10px 0;opacity:0.9;" />
              <br />
              Reporte generado automáticamente por
              <a href="${DASHBOARD_URL}" style="color:#93C5FD;text-decoration:none;">Smart Dashboard</a>.
              ${syncStamp ? `<br /><span style="color:#94A3B8;font-size:10px;">Datos actualizados: ${escapeHtml(syncStamp)}</span>` : ''}
              <br />
              <span style="color:#94A3B8;font-size:10px;">Para dejar de recibir este reporte, contacta a tu administrador.</span>
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
  const title = reportTitle(cadence);
  const d = data.deposits_withdrawals;
  return [
    `${title} — ${companyName}`,
    `Período: ${data.range.from} → ${data.range.to}`,
    ``,
    `DEPÓSITOS Y RETIROS (rango)`,
    `  Total depósitos: ${formatCurrency(d.range.total_deposits)}`,
    `  Total retiros:   ${formatCurrency(d.range.total_withdrawals)}`,
    `  Net Deposit:     ${formatCurrency(d.range.net_deposit)}`,
    ``,
    `MES ACTUAL`,
    `  Net Deposit:     ${formatCurrency(d.month.net_deposit)}`,
    `  (mes anterior:   ${formatCurrency(d.prev_month.net_deposit)})`,
    ``,
    `BALANCES POR CANAL`,
    ...(data.balances_by_channel.channels.length === 0
      ? [`  (sin canales visibles)`]
      : data.balances_by_channel.channels.map(
          (c) => `  ${c.label.padEnd(28, ' ')} ${formatCurrency(c.amount)}`,
        )),
    `  ${'TOTAL'.padEnd(28, ' ')} ${formatCurrency(data.balances_by_channel.total)}`,
    ``,
    `USUARIOS CRM`,
    `  Nuevos en rango: ${data.crm_users.new_users_in_range}`,
    `  Nuevos este mes: ${data.crm_users.new_users_this_month}`,
    `  Total:           ${data.crm_users.total_users}`,
    ``,
    `BROKER P&L`,
    `  Rango:        ${formatCurrency(data.broker_pnl.pnl_range)}`,
    `  Mes:          ${formatCurrency(data.broker_pnl.pnl_month)}`,
    `  Mes anterior: ${formatCurrency(data.broker_pnl.pnl_prev_month)}`,
    ``,
    `PROP TRADING FIRM`,
    `  Ventas rango:  ${formatCurrency(data.prop_trading.total_sales_range)}`,
    `  Retiros rango: ${formatCurrency(data.prop_trading.prop_withdrawals_range)}`,
    `  P&L rango:     ${formatCurrency(data.prop_trading.pnl_range)}`,
    ``,
    `---`,
    `Smart Dashboard · ${DASHBOARD_URL}`,
    cadence === 'daily' ? 'Reporte diario automático.' : cadence === 'weekly' ? 'Reporte semanal automático.' : 'Reporte mensual automático.',
  ].join('\n');
}
