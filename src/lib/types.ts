export interface Company {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  logo_url: string | null;
  color_primary: string;
  color_secondary: string;
  currency: string;
  active_modules: string[];
}

export interface Period {
  id: string;
  company_id: string;
  year: number;
  month: number;
  label: string | null;
  is_closed: boolean;
}

export interface Deposit {
  id: string;
  period_id: string;
  company_id: string;
  channel: 'coinsbuy' | 'fairpay' | 'unipayment' | 'other';
  amount: number;
  notes: string | null;
}

export interface Withdrawal {
  id: string;
  period_id: string;
  company_id: string;
  category: 'ib_commissions' | 'broker' | 'prop_firm' | 'other';
  amount: number;
  notes: string | null;
}

export interface PropFirmSale {
  id: string;
  period_id: string;
  company_id: string;
  amount: number;
}

export interface P2PTransfer {
  id: string;
  period_id: string;
  company_id: string;
  amount: number;
}

export interface Expense {
  id: string;
  period_id: string;
  company_id: string;
  concept: string;
  amount: number;
  paid: number;
  pending: number;
  category: string | null;
  sort_order: number;
}

export interface PreoperativeExpense {
  id: string;
  company_id: string;
  concept: string;
  amount: number;
  paid: number;
  pending: number;
  sort_order: number;
}

export interface OperatingIncome {
  id: string;
  period_id: string;
  company_id: string;
  prop_firm: number;
  broker_pnl: number;
  other: number;
}

export interface BrokerBalance {
  id: string;
  period_id: string;
  company_id: string;
  pnl_book_b: number;
  liquidity_commissions: number;
}

export interface FinancialStatus {
  id: string;
  period_id: string;
  company_id: string;
  operating_expenses_paid: number;
  net_total: number;
  previous_month_balance: number;
  current_month_balance: number;
}

export interface Partner {
  id: string;
  company_id: string;
  user_id: string | null;
  name: string;
  email: string | null;
  percentage: number;
}

export interface PartnerDistribution {
  id: string;
  period_id: string;
  partner_id: string;
  company_id: string;
  percentage: number;
  amount: number;
}

export interface LiquidityMovement {
  id: string;
  company_id: string;
  date: string;
  user_email: string | null;
  mt_account: string | null;
  deposit: number;
  withdrawal: number;
  balance: number;
  notes: string | null;
}

export interface Investment {
  id: string;
  company_id: string;
  date: string;
  concept: string | null;
  responsible: string | null;
  deposit: number;
  withdrawal: number;
  profit: number;
  balance: number;
}

// Computed types for the dashboard
export interface PeriodSummary {
  period: Period;
  totalDeposits: number;
  totalWithdrawals: number;
  netDeposit: number;
  propFirmSales: number;
  brokerDeposits: number;
  p2pTransfer: number;
  totalExpenses: number;
  totalExpensesPaid: number;
  totalExpensesPending: number;
  operatingIncome: OperatingIncome | null;
  brokerBalance: BrokerBalance | null;
  financialStatus: FinancialStatus | null;
  deposits: Deposit[];
  withdrawals: Withdrawal[];
  expenses: Expense[];
}

// HR Types
export type CommercialRole = 'sales_manager' | 'head' | 'bdm';

export interface Employee {
  id: string;
  company_id: string;
  name: string;
  email: string;
  position: string;
  department: string;
  start_date: string;
  salary: number | null;
  status: 'active' | 'inactive' | 'probation';
  phone: string | null;
  country: string | null;
  notes: string | null;
  birthday: string | null;
  supervisor: string | null;
  comments: string | null;
}

export interface CommercialProfile {
  id: string;
  company_id: string;
  name: string;
  email: string;
  role: CommercialRole;
  head_id: string | null; // who they report to (null for sales_manager/independent heads)
  net_deposit_pct: number | null; // null = N/A
  pnl_pct: number | null; // null = N/A
  commission_per_lot: number | null; // USD per lot, null = N/A
  salary: number | null; // monthly USD, null = N/A
  benefits: string | null;
  comments: string | null;
  hire_date: string | null;
  birthday: string | null;
  status: 'active' | 'inactive';
}

export interface CommercialMonthlyResult {
  id: string;
  profile_id: string;
  period_id: string;
  net_deposit_current: number;
  net_deposit_accumulated: number;
  net_deposit_total: number;
  pnl_current: number;
  pnl_accumulated: number;
  pnl_total: number;
  commissions_earned: number;
  bonus: number;
  salary_paid: number;
  total_earned: number;
}

export type UserRole = 'admin' | 'socio' | 'auditor' | 'soporte' | 'hr' | 'invitado';

// Email Types
export type EmailType = 'welcome' | 'password_reset' | 'report' | 'notification' | 'login_notification';

export interface SendEmailRequest {
  to: string;
  type: EmailType;
  data: WelcomeEmailData | PasswordResetEmailData | ReportEmailData | NotificationEmailData | LoginNotificationData;
}

export interface WelcomeEmailData {
  userName: string;
}

export interface PasswordResetEmailData {
  resetLink: string;
}

export interface ReportEmailData {
  reportName: string;
  reportPeriod: string;
  reportSummary: string;
}

export interface NotificationEmailData {
  title: string;
  message: string;
}

export interface LoginNotificationData {
  userName: string;
  loginDate: string;
  loginTime: string;
  browser: string;
  ipAddress: string;
  dashboardUrl: string;
}

export interface SendEmailResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

export const CHANNEL_LABELS: Record<string, string> = {
  coinsbuy: 'Coinsbuy (Crypto)',
  fairpay: 'FairPay (Medio Local)',
  unipayment: 'Unipayment (Tarjeta)',
  other: 'Otros Depósitos',
};

export const WITHDRAWAL_LABELS: Record<string, string> = {
  ib_commissions: 'Comisiones IB',
  broker: 'Broker',
  prop_firm: 'Prop Firm',
  other: 'Otros',
};

export const MONTH_LABELS: Record<number, string> = {
  1: 'Enero',
  2: 'Febrero',
  3: 'Marzo',
  4: 'Abril',
  5: 'Mayo',
  6: 'Junio',
  7: 'Julio',
  8: 'Agosto',
  9: 'Septiembre',
  10: 'Octubre',
  11: 'Noviembre',
  12: 'Diciembre',
};
