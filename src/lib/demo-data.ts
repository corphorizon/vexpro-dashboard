import type {
  Company, Period, Deposit, Withdrawal, PropFirmSale, P2PTransfer,
  Expense, PreoperativeExpense, OperatingIncome, BrokerBalance,
  FinancialStatus, Partner, PartnerDistribution, LiquidityMovement, Investment,
  PeriodSummary,
} from './types';

// ============================================================
// COMPANY
// ============================================================
export const DEMO_COMPANY: Company = {
  id: 'vexpro-001',
  name: 'Vex Pro',
  slug: 'vexprofx',
  subdomain: 'vexprofx',
  logo_url: null,
  logo_url_white: null,
  color_primary: '#1E3A5F',
  color_secondary: '#3B82F6',
  currency: 'USD',
  active_modules: ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'partners'],
  default_wallet_id: '1079',
};

// ============================================================
// PERIODS
// ============================================================
export const DEMO_PERIODS: Period[] = [
  { id: 'p-oct-25', company_id: 'vexpro-001', year: 2025, month: 10, label: 'Oct 25', is_closed: true, reserve_pct: 0.10 },
  { id: 'p-nov-25', company_id: 'vexpro-001', year: 2025, month: 11, label: 'Nov 25', is_closed: true, reserve_pct: 0.10 },
  { id: 'p-dic-25', company_id: 'vexpro-001', year: 2025, month: 12, label: 'Dic 25', is_closed: true, reserve_pct: 0.10 },
  { id: 'p-jan-26', company_id: 'vexpro-001', year: 2026, month: 1, label: 'Ene 26', is_closed: true, reserve_pct: 0.10 },
  { id: 'p-feb-26', company_id: 'vexpro-001', year: 2026, month: 2, label: 'Feb 26', is_closed: true, reserve_pct: 0.10 },
  { id: 'p-mar-26', company_id: 'vexpro-001', year: 2026, month: 3, label: 'Mar 26', is_closed: false, reserve_pct: 0.10 },
  { id: 'p-apr-26', company_id: 'vexpro-001', year: 2026, month: 4, label: 'Abr 26', is_closed: false, reserve_pct: 0.10 },
];

// ============================================================
// DEPOSITS
// ============================================================
export const DEMO_DEPOSITS: Deposit[] = [
  // Oct 25 (was Sep-Oct)
  { id: 'd1', period_id: 'p-oct-25', company_id: 'vexpro-001', channel: 'coinsbuy', amount: 73599, notes: null },
  { id: 'd2', period_id: 'p-oct-25', company_id: 'vexpro-001', channel: 'fairpay', amount: 0, notes: null },
  { id: 'd3', period_id: 'p-oct-25', company_id: 'vexpro-001', channel: 'unipayment', amount: 3465, notes: null },
  { id: 'd4', period_id: 'p-oct-25', company_id: 'vexpro-001', channel: 'other', amount: 0, notes: null },
  // Nov 25
  { id: 'd5', period_id: 'p-nov-25', company_id: 'vexpro-001', channel: 'coinsbuy', amount: 505300, notes: null },
  { id: 'd6', period_id: 'p-nov-25', company_id: 'vexpro-001', channel: 'fairpay', amount: 405.77, notes: null },
  { id: 'd7', period_id: 'p-nov-25', company_id: 'vexpro-001', channel: 'unipayment', amount: 10849.39, notes: null },
  { id: 'd8', period_id: 'p-nov-25', company_id: 'vexpro-001', channel: 'other', amount: 0, notes: null },
  // Dic 25
  { id: 'd9', period_id: 'p-dic-25', company_id: 'vexpro-001', channel: 'coinsbuy', amount: 665309, notes: null },
  { id: 'd10', period_id: 'p-dic-25', company_id: 'vexpro-001', channel: 'fairpay', amount: 4197.71, notes: null },
  { id: 'd11', period_id: 'p-dic-25', company_id: 'vexpro-001', channel: 'unipayment', amount: 17769, notes: null },
  { id: 'd12', period_id: 'p-dic-25', company_id: 'vexpro-001', channel: 'other', amount: 0, notes: null },
  // Jan 26
  { id: 'd13', period_id: 'p-jan-26', company_id: 'vexpro-001', channel: 'coinsbuy', amount: 294664, notes: null },
  { id: 'd14', period_id: 'p-jan-26', company_id: 'vexpro-001', channel: 'fairpay', amount: 2431.47, notes: null },
  { id: 'd15', period_id: 'p-jan-26', company_id: 'vexpro-001', channel: 'unipayment', amount: 12172.42, notes: null },
  { id: 'd16', period_id: 'p-jan-26', company_id: 'vexpro-001', channel: 'other', amount: 0, notes: null },
  // Feb 26
  { id: 'd17', period_id: 'p-feb-26', company_id: 'vexpro-001', channel: 'coinsbuy', amount: 245907.23, notes: null },
  { id: 'd18', period_id: 'p-feb-26', company_id: 'vexpro-001', channel: 'fairpay', amount: 4278, notes: null },
  { id: 'd19', period_id: 'p-feb-26', company_id: 'vexpro-001', channel: 'unipayment', amount: 18875.74, notes: null },
  { id: 'd20', period_id: 'p-feb-26', company_id: 'vexpro-001', channel: 'other', amount: 17175, notes: null },
  // Mar 26
  { id: 'd21', period_id: 'p-mar-26', company_id: 'vexpro-001', channel: 'coinsbuy', amount: 0, notes: null },
  { id: 'd22', period_id: 'p-mar-26', company_id: 'vexpro-001', channel: 'fairpay', amount: 0, notes: null },
  { id: 'd23', period_id: 'p-mar-26', company_id: 'vexpro-001', channel: 'unipayment', amount: 0, notes: null },
  { id: 'd24', period_id: 'p-mar-26', company_id: 'vexpro-001', channel: 'other', amount: 6200, notes: null },
  // Abr 26
  { id: 'd25', period_id: 'p-apr-26', company_id: 'vexpro-001', channel: 'coinsbuy', amount: 0, notes: null },
  { id: 'd26', period_id: 'p-apr-26', company_id: 'vexpro-001', channel: 'fairpay', amount: 0, notes: null },
  { id: 'd27', period_id: 'p-apr-26', company_id: 'vexpro-001', channel: 'unipayment', amount: 0, notes: null },
  { id: 'd28', period_id: 'p-apr-26', company_id: 'vexpro-001', channel: 'other', amount: 0, notes: null },
];

// ============================================================
// WITHDRAWALS
// ============================================================
export const DEMO_WITHDRAWALS: Withdrawal[] = [
  { id: 'w1', period_id: 'p-oct-25', company_id: 'vexpro-001', category: 'ib_commissions', amount: 0, notes: null },
  { id: 'w2', period_id: 'p-oct-25', company_id: 'vexpro-001', category: 'broker', amount: 23493.04, notes: null },
  { id: 'w3', period_id: 'p-oct-25', company_id: 'vexpro-001', category: 'prop_firm', amount: 587.96, notes: null },
  { id: 'w4', period_id: 'p-oct-25', company_id: 'vexpro-001', category: 'other', amount: 0, notes: null },
  { id: 'w5', period_id: 'p-nov-25', company_id: 'vexpro-001', category: 'ib_commissions', amount: 27916.16, notes: null },
  { id: 'w6', period_id: 'p-nov-25', company_id: 'vexpro-001', category: 'broker', amount: 193080.1, notes: null },
  { id: 'w7', period_id: 'p-nov-25', company_id: 'vexpro-001', category: 'prop_firm', amount: 2115.3, notes: null },
  { id: 'w8', period_id: 'p-nov-25', company_id: 'vexpro-001', category: 'other', amount: 0, notes: null },
  { id: 'w9', period_id: 'p-dic-25', company_id: 'vexpro-001', category: 'ib_commissions', amount: 62943.39, notes: null },
  { id: 'w10', period_id: 'p-dic-25', company_id: 'vexpro-001', category: 'broker', amount: 429969.41, notes: null },
  { id: 'w11', period_id: 'p-dic-25', company_id: 'vexpro-001', category: 'prop_firm', amount: 5416.2, notes: null },
  { id: 'w12', period_id: 'p-dic-25', company_id: 'vexpro-001', category: 'other', amount: 0, notes: null },
  { id: 'w13', period_id: 'p-jan-26', company_id: 'vexpro-001', category: 'ib_commissions', amount: 47571.75, notes: null },
  { id: 'w14', period_id: 'p-jan-26', company_id: 'vexpro-001', category: 'broker', amount: 337206.46, notes: null },
  { id: 'w15', period_id: 'p-jan-26', company_id: 'vexpro-001', category: 'prop_firm', amount: 5888.5, notes: null },
  { id: 'w16', period_id: 'p-jan-26', company_id: 'vexpro-001', category: 'other', amount: 0, notes: null },
  { id: 'w17', period_id: 'p-feb-26', company_id: 'vexpro-001', category: 'ib_commissions', amount: 0, notes: null },
  { id: 'w18', period_id: 'p-feb-26', company_id: 'vexpro-001', category: 'broker', amount: 217421, notes: null },
  { id: 'w19', period_id: 'p-feb-26', company_id: 'vexpro-001', category: 'prop_firm', amount: 0, notes: null },
  { id: 'w20', period_id: 'p-feb-26', company_id: 'vexpro-001', category: 'other', amount: 0, notes: null },
  { id: 'w21', period_id: 'p-mar-26', company_id: 'vexpro-001', category: 'ib_commissions', amount: 0, notes: null },
  { id: 'w22', period_id: 'p-mar-26', company_id: 'vexpro-001', category: 'broker', amount: 0, notes: null },
  { id: 'w23', period_id: 'p-mar-26', company_id: 'vexpro-001', category: 'prop_firm', amount: 0, notes: null },
  { id: 'w24', period_id: 'p-mar-26', company_id: 'vexpro-001', category: 'other', amount: 0, notes: null },
  // Abr 26
  { id: 'w25', period_id: 'p-apr-26', company_id: 'vexpro-001', category: 'ib_commissions', amount: 0, notes: null },
  { id: 'w26', period_id: 'p-apr-26', company_id: 'vexpro-001', category: 'broker', amount: 0, notes: null },
  { id: 'w27', period_id: 'p-apr-26', company_id: 'vexpro-001', category: 'prop_firm', amount: 0, notes: null },
  { id: 'w28', period_id: 'p-apr-26', company_id: 'vexpro-001', category: 'other', amount: 0, notes: null },
];

// ============================================================
// PROP FIRM SALES
// ============================================================
export const DEMO_PROP_FIRM_SALES: PropFirmSale[] = [
  { id: 'pfs1', period_id: 'p-oct-25', company_id: 'vexpro-001', amount: 4883 },
  { id: 'pfs2', period_id: 'p-nov-25', company_id: 'vexpro-001', amount: 14061 },
  { id: 'pfs3', period_id: 'p-dic-25', company_id: 'vexpro-001', amount: 9709 },
  { id: 'pfs4', period_id: 'p-jan-26', company_id: 'vexpro-001', amount: 16778 },
  { id: 'pfs5', period_id: 'p-feb-26', company_id: 'vexpro-001', amount: 51409.65 },
  { id: 'pfs6', period_id: 'p-mar-26', company_id: 'vexpro-001', amount: 0 },
  { id: 'pfs7', period_id: 'p-apr-26', company_id: 'vexpro-001', amount: 0 },
];

// ============================================================
// P2P TRANSFERS
// ============================================================
export const DEMO_P2P_TRANSFERS: P2PTransfer[] = [
  { id: 'p2p1', period_id: 'p-oct-25', company_id: 'vexpro-001', amount: 0 },
  { id: 'p2p2', period_id: 'p-nov-25', company_id: 'vexpro-001', amount: 9787.04 },
  { id: 'p2p3', period_id: 'p-dic-25', company_id: 'vexpro-001', amount: 0 },
  { id: 'p2p4', period_id: 'p-jan-26', company_id: 'vexpro-001', amount: 0 },
  { id: 'p2p5', period_id: 'p-feb-26', company_id: 'vexpro-001', amount: 0 },
  { id: 'p2p6', period_id: 'p-mar-26', company_id: 'vexpro-001', amount: 0 },
  { id: 'p2p7', period_id: 'p-apr-26', company_id: 'vexpro-001', amount: 0 },
];

// ============================================================
// EXPENSES
// ============================================================
export const DEMO_EXPENSES: Expense[] = [
  // Oct 25 (combined Sep+Oct)
  { id: 'e1', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Internet ago', amount: 50.7, paid: 50.7, pending: 0, category: 'sep', sort_order: 1 },
  { id: 'e2', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'FX EXPO Medellín', amount: 4641, paid: 4641, pending: 0, category: 'sep', sort_order: 2 },
  { id: 'e3', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Administración Ofi Mexico (Ago/sep)', amount: 708.3, paid: 708.3, pending: 0, category: 'sep', sort_order: 3 },
  { id: 'e4', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Energía agos', amount: 67.49, paid: 67.49, pending: 0, category: 'sep', sort_order: 4 },
  { id: 'e5', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Verificación Doc', amount: 544.58, paid: 544.58, pending: 0, category: 'sep', sort_order: 5 },
  { id: 'e6', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Depósito Inflable expo', amount: 158, paid: 158, pending: 0, category: 'sep', sort_order: 6 },
  { id: 'e7', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Cambio logos Vertex a Vex', amount: 325, paid: 325, pending: 0, category: 'sep', sort_order: 7 },
  { id: 'e8', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Docu/ chipre Meta Trader', amount: 64.44, paid: 64.44, pending: 0, category: 'sep', sort_order: 8 },
  { id: 'e9', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'OVH Servers', amount: 149, paid: 149, pending: 0, category: 'sep', sort_order: 9 },
  { id: 'e10', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Reseñas Trust Pilot', amount: 310, paid: 310, pending: 0, category: 'sep', sort_order: 10 },
  { id: 'e11', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Correos Vex GODADDY', amount: 106.45, paid: 106.45, pending: 0, category: 'sep', sort_order: 11 },
  { id: 'e12', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Apoyo BDM Expo Transp / Hosp AED', amount: 2076.88, paid: 2076.88, pending: 0, category: 'sep', sort_order: 12 },
  { id: 'e13', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Apoyos BDM Expo Transp / Cena USD', amount: 512, paid: 512, pending: 0, category: 'sep', sort_order: 13 },
  { id: 'e14', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Unipayment Setup', amount: 1792.5, paid: 1792.5, pending: 0, category: 'sep', sort_order: 14 },
  { id: 'e15', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Correos Vex y Zoom Corporativo', amount: 152, paid: 152, pending: 0, category: 'sep', sort_order: 15 },
  { id: 'e16', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Egresos cuenta bancaria', amount: 343, paid: 343, pending: 0, category: 'oct', sort_order: 16 },
  { id: 'e17', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Pago servers.com', amount: 602.12, paid: 602.12, pending: 0, category: 'oct', sort_order: 17 },
  { id: 'e18', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Pago Sendgrid', amount: 125, paid: 125, pending: 0, category: 'oct', sort_order: 18 },
  { id: 'e19', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Pago servers OVH', amount: 546.38, paid: 546.38, pending: 0, category: 'oct', sort_order: 19 },
  { id: 'e20', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Pago COO Daniela', amount: 800, paid: 800, pending: 0, category: 'oct', sort_order: 20 },
  { id: 'e21', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Pago Legal Team | Sofia', amount: 200, paid: 200, pending: 0, category: 'oct', sort_order: 21 },
  { id: 'e22', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Diseñador Gráfico', amount: 750, paid: 750, pending: 0, category: 'oct', sort_order: 22 },
  { id: 'e23', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Equipo soporte', amount: 300, paid: 300, pending: 0, category: 'oct', sort_order: 23 },
  { id: 'e24', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Community Manager', amount: 150, paid: 150, pending: 0, category: 'oct', sort_order: 24 },
  { id: 'e25', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'CRM Servers', amount: 2000, paid: 2000, pending: 0, category: 'oct', sort_order: 25 },
  { id: 'e26', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Manejo servers/Sintéticos/Controladas', amount: 3750, paid: 3750, pending: 0, category: 'oct', sort_order: 26 },
  { id: 'e27', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Oficina Mexico Admin y Servicios', amount: 405.7, paid: 405.7, pending: 0, category: 'oct', sort_order: 27 },
  { id: 'e28', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Hoteles y Hospedaje BDM', amount: 1135.2, paid: 1135.2, pending: 0, category: 'oct', sort_order: 28 },
  { id: 'e29', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Correos Empresa outlook', amount: 152.15, paid: 152.15, pending: 0, category: 'oct', sort_order: 29 },
  { id: 'e30', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Pago Oficina Guadalajara', amount: 10955, paid: 10955, pending: 0, category: 'oct', sort_order: 30 },
  { id: 'e31', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Cambios empresa Dubai', amount: 1415, paid: 1415, pending: 0, category: 'oct', sort_order: 31 },
  { id: 'e32', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Presupuesto ADS', amount: 500, paid: 500, pending: 0, category: 'oct', sort_order: 32 },
  { id: 'e33', period_id: 'p-oct-25', company_id: 'vexpro-001', concept: 'Fee BNB', amount: 10, paid: 10, pending: 0, category: 'oct', sort_order: 33 },
  // Nov 25
  { id: 'e34', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Egresos cuenta bancaria', amount: 2490, paid: 2490, pending: 0, category: null, sort_order: 1 },
  { id: 'e35', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Pago servers.com', amount: 600, paid: 600, pending: 0, category: null, sort_order: 2 },
  { id: 'e36', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Pago Sendgrid', amount: 125, paid: 125, pending: 0, category: null, sort_order: 3 },
  { id: 'e37', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Pago servers OVH', amount: 400, paid: 400, pending: 0, category: null, sort_order: 4 },
  { id: 'e38', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Pago COO Daniela', amount: 800, paid: 800, pending: 0, category: null, sort_order: 5 },
  { id: 'e39', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Pago Legal Team | Sofia', amount: 200, paid: 200, pending: 0, category: null, sort_order: 6 },
  { id: 'e40', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Diseñador Gráfico', amount: 750, paid: 750, pending: 0, category: null, sort_order: 7 },
  { id: 'e41', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Equipo soporte', amount: 350, paid: 350, pending: 0, category: null, sort_order: 8 },
  { id: 'e42', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Community Manager', amount: 200, paid: 200, pending: 0, category: null, sort_order: 9 },
  { id: 'e43', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Trafficker', amount: 750, paid: 750, pending: 0, category: null, sort_order: 10 },
  { id: 'e44', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'CRM + Social Trading (40% off)', amount: 6000, paid: 6000, pending: 0, category: null, sort_order: 11 },
  { id: 'e45', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Manejo servers/Sintéticos/Controladas', amount: 4500, paid: 4500, pending: 0, category: null, sort_order: 12 },
  { id: 'e46', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Metaquotes', amount: 0, paid: 0, pending: 0, category: null, sort_order: 13 },
  { id: 'e47', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Alquiler Oficina Mexico', amount: 10200, paid: 10200, pending: 0, category: null, sort_order: 14 },
  { id: 'e48', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Oficina Mexico Admin y Servicios', amount: 405.7, paid: 405.7, pending: 0, category: null, sort_order: 15 },
  { id: 'e49', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'FX Expo Lima VexPro', amount: 13436, paid: 13436, pending: 0, category: null, sort_order: 16 },
  { id: 'e50', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'FX Expo Lima Exura 20%', amount: 565, paid: 565, pending: 0, category: null, sort_order: 17 },
  { id: 'e51', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Vuelos FX EXPO Lima', amount: 2429, paid: 2429, pending: 0, category: null, sort_order: 18 },
  { id: 'e52', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Equipo Dealing', amount: 950, paid: 950, pending: 0, category: null, sort_order: 19 },
  { id: 'e53', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Acuerdo Sebastian Molina', amount: 15000, paid: 15000, pending: 0, category: null, sort_order: 20 },
  { id: 'e54', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Adelanto Manuel Felipe', amount: 2000, paid: 2000, pending: 0, category: null, sort_order: 21 },
  { id: 'e55', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Asado y vuelo extra Expo Lima', amount: 550, paid: 550, pending: 0, category: null, sort_order: 22 },
  { id: 'e56', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Airbnb Expo Lima', amount: 755, paid: 755, pending: 0, category: null, sort_order: 23 },
  { id: 'e57', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Servidores Webs VEX (Hasta Enero)', amount: 1000, paid: 1000, pending: 0, category: null, sort_order: 24 },
  { id: 'e58', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Verificación Instagram', amount: 24, paid: 24, pending: 0, category: null, sort_order: 25 },
  { id: 'e59', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Trust Pilot', amount: 100, paid: 100, pending: 0, category: null, sort_order: 26 },
  { id: 'e60', period_id: 'p-nov-25', company_id: 'vexpro-001', concept: 'Cena Bucaramanga', amount: 53, paid: 53, pending: 0, category: null, sort_order: 27 },
  // Dic 25
  { id: 'e61', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Egresos cuenta bancaria', amount: 1855, paid: 1855, pending: 0, category: null, sort_order: 1 },
  { id: 'e62', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Pago servers.com', amount: 593.85, paid: 593.85, pending: 0, category: null, sort_order: 2 },
  { id: 'e63', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Pago Sendgrid', amount: 125, paid: 125, pending: 0, category: null, sort_order: 3 },
  { id: 'e64', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Pago servers OVH', amount: 178, paid: 178, pending: 0, category: null, sort_order: 4 },
  { id: 'e65', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Centroid', amount: 1000, paid: 1000, pending: 0, category: null, sort_order: 5 },
  { id: 'e66', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'B2Prime Liquidez', amount: 1500, paid: 1500, pending: 0, category: null, sort_order: 6 },
  { id: 'e67', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Pago COO Daniela', amount: 800, paid: 800, pending: 0, category: null, sort_order: 7 },
  { id: 'e68', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Pago Legal Team | Sofia', amount: 200, paid: 200, pending: 0, category: null, sort_order: 8 },
  { id: 'e69', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Diseñador Gráfico', amount: 750, paid: 750, pending: 0, category: null, sort_order: 9 },
  { id: 'e70', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Equipo soporte', amount: 800, paid: 800, pending: 0, category: null, sort_order: 10 },
  { id: 'e71', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Community Manager', amount: 200, paid: 200, pending: 0, category: null, sort_order: 11 },
  { id: 'e72', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Trafficker', amount: 750, paid: 750, pending: 0, category: null, sort_order: 12 },
  { id: 'e73', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'CRM + Social Trading', amount: 10000, paid: 10000, pending: 0, category: null, sort_order: 13 },
  { id: 'e74', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Manejo servers/Sintéticos/Controladas', amount: 4500, paid: 4500, pending: 0, category: null, sort_order: 14 },
  { id: 'e75', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Metaquotes', amount: 15295, paid: 15295, pending: 0, category: null, sort_order: 15 },
  { id: 'e76', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Oficina Mexico Admin y Servicios', amount: 495, paid: 495, pending: 0, category: null, sort_order: 16 },
  { id: 'e77', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Equipo Dealing', amount: 1500, paid: 1500, pending: 0, category: null, sort_order: 17 },
  { id: 'e78', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Renovación Vex Development Dubai', amount: 5340, paid: 5340, pending: 0, category: null, sort_order: 18 },
  { id: 'e79', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Contabilidad Vex Dev. - 3 Meses', amount: 1030, paid: 1030, pending: 0, category: null, sort_order: 19 },
  { id: 'e80', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Viáticos Equipo Exura', amount: 200, paid: 200, pending: 0, category: null, sort_order: 20 },
  { id: 'e81', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'FX EXPO Guadalajara', amount: 10000, paid: 10000, pending: 0, category: null, sort_order: 21 },
  { id: 'e82', period_id: 'p-dic-25', company_id: 'vexpro-001', concept: 'Bono a Juan', amount: 50, paid: 50, pending: 0, category: null, sort_order: 22 },
  // Jan 26
  { id: 'e83', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Egresos cuenta bancaria', amount: 762.62, paid: 762.62, pending: 0, category: null, sort_order: 1 },
  { id: 'e84', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Pago servers.com', amount: 593.85, paid: 593.85, pending: 0, category: null, sort_order: 2 },
  { id: 'e85', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Pago Sendgrid', amount: 125, paid: 125, pending: 0, category: null, sort_order: 3 },
  { id: 'e86', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Pago servers OVH', amount: 178, paid: 178, pending: 0, category: null, sort_order: 4 },
  { id: 'e87', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Centroid', amount: 1000, paid: 1000, pending: 0, category: null, sort_order: 5 },
  { id: 'e88', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'B2Prime Liquidez', amount: 1500, paid: 1500, pending: 0, category: null, sort_order: 6 },
  { id: 'e89', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Pago COO Daniela', amount: 800, paid: 800, pending: 0, category: null, sort_order: 7 },
  { id: 'e90', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Pago Legal Team | Sofia', amount: 200, paid: 200, pending: 0, category: null, sort_order: 8 },
  { id: 'e91', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Diseñador Gráfico', amount: 750, paid: 750, pending: 0, category: null, sort_order: 9 },
  { id: 'e92', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Equipo soporte', amount: 800, paid: 800, pending: 0, category: null, sort_order: 10 },
  { id: 'e93', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Community Manager', amount: 200, paid: 200, pending: 0, category: null, sort_order: 11 },
  { id: 'e94', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Trafficker', amount: 750, paid: 750, pending: 0, category: null, sort_order: 12 },
  { id: 'e95', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'CRM + Social Trading', amount: 10000, paid: 10000, pending: 0, category: null, sort_order: 13 },
  { id: 'e96', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Manejo servers/Sintéticos/Controladas', amount: 4500, paid: 4500, pending: 0, category: null, sort_order: 14 },
  { id: 'e97', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Metaquotes', amount: 15295, paid: 15295, pending: 0, category: null, sort_order: 15 },
  { id: 'e98', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Oficina Mexico Admin y Servicios', amount: 495, paid: 495, pending: 0, category: null, sort_order: 16 },
  { id: 'e99', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Equipo Dealing', amount: 1500, paid: 1500, pending: 0, category: null, sort_order: 17 },
  { id: 'e100', period_id: 'p-jan-26', company_id: 'vexpro-001', concept: 'Oficina 3 Meses', amount: 11680, paid: 11680, pending: 0, category: null, sort_order: 18 },
  // Feb 26
  { id: 'e101', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Egresos cuenta bancaria', amount: 1393.6, paid: 1393.6, pending: 0, category: null, sort_order: 1 },
  { id: 'e102', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Pago servers.com', amount: 604, paid: 604, pending: 0, category: null, sort_order: 2 },
  { id: 'e103', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Pago Sendgrid', amount: 125, paid: 125, pending: 0, category: null, sort_order: 3 },
  { id: 'e104', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Pago servers OVH', amount: 178, paid: 178, pending: 0, category: null, sort_order: 4 },
  { id: 'e105', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Centroid', amount: 1000, paid: 1000, pending: 0, category: null, sort_order: 5 },
  { id: 'e106', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'B2Prime Liquidez', amount: 1500, paid: 1500, pending: 0, category: null, sort_order: 6 },
  { id: 'e107', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Pago COO Daniela', amount: 800, paid: 800, pending: 0, category: null, sort_order: 7 },
  { id: 'e108', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Pago Legal Team | Sofia', amount: 200, paid: 200, pending: 0, category: null, sort_order: 8 },
  { id: 'e109', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Diseñador Gráfico', amount: 750, paid: 750, pending: 0, category: null, sort_order: 9 },
  { id: 'e110', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Equipo soporte', amount: 800, paid: 800, pending: 0, category: null, sort_order: 10 },
  { id: 'e111', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Community Manager', amount: 200, paid: 200, pending: 0, category: null, sort_order: 11 },
  { id: 'e112', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Trafficker', amount: 750, paid: 750, pending: 0, category: null, sort_order: 12 },
  { id: 'e113', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'CRM + Social Trading', amount: 10000, paid: 10000, pending: 0, category: null, sort_order: 13 },
  { id: 'e114', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Manejo servers/Sintéticos/Controladas', amount: 4500, paid: 4500, pending: 0, category: null, sort_order: 14 },
  { id: 'e115', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Metaquotes', amount: 15295, paid: 15295, pending: 0, category: null, sort_order: 15 },
  { id: 'e116', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Oficina Mexico Admin y Servicios', amount: 500, paid: 500, pending: 0, category: null, sort_order: 16 },
  { id: 'e117', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Equipo Dealing', amount: 1500, paid: 1500, pending: 0, category: null, sort_order: 17 },
  { id: 'e118', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Regulación SCA', amount: 20000, paid: 20000, pending: 0, category: null, sort_order: 18 },
  { id: 'e119', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Empresa USA', amount: 3500, paid: 3500, pending: 0, category: null, sort_order: 19 },
  { id: 'e120', period_id: 'p-feb-26', company_id: 'vexpro-001', concept: 'Contabilidad empresa Dubai', amount: 1030, paid: 1030, pending: 0, category: null, sort_order: 20 },
  // Mar 26
  { id: 'e121', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Pago servers.com', amount: 730, paid: 730, pending: 0, category: null, sort_order: 1 },
  { id: 'e122', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Pago Sendgrid', amount: 150, paid: 150, pending: 0, category: null, sort_order: 2 },
  { id: 'e123', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Pago servers OVH', amount: 178, paid: 178, pending: 0, category: null, sort_order: 3 },
  { id: 'e124', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Centroid', amount: 1000, paid: 1000, pending: 0, category: null, sort_order: 4 },
  { id: 'e125', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'B2Prime Liquidez', amount: 1500, paid: 1500, pending: 0, category: null, sort_order: 5 },
  { id: 'e126', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Recursos Humanos | Daniela', amount: 800, paid: 800, pending: 0, category: null, sort_order: 6 },
  { id: 'e127', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Directora Legal | Sofia', amount: 250, paid: 250, pending: 0, category: null, sort_order: 7 },
  { id: 'e128', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Diseñador Gráfico | Jonathan', amount: 750, paid: 750, pending: 0, category: null, sort_order: 8 },
  { id: 'e129', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Equipo soporte | Juan Miguel y Sebas', amount: 900, paid: 900, pending: 0, category: null, sort_order: 9 },
  { id: 'e130', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Community Manager | Liseth', amount: 200, paid: 200, pending: 0, category: null, sort_order: 10 },
  { id: 'e131', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Director Comercial | Brandon', amount: 1400, paid: 1400, pending: 0, category: null, sort_order: 11 },
  { id: 'e132', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'IT | Daniel', amount: 650, paid: 650, pending: 0, category: null, sort_order: 12 },
  { id: 'e133', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'CRM + Social Trading', amount: 10000, paid: 10000, pending: 0, category: null, sort_order: 13 },
  { id: 'e134', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Manejo servers/Sintéticos/Controladas', amount: 5100, paid: 5100, pending: 0, category: null, sort_order: 14 },
  { id: 'e135', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Metaquotes', amount: 15295, paid: 15295, pending: 0, category: null, sort_order: 15 },
  { id: 'e136', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Oficina Mexico Admin y Servicios', amount: 500, paid: 500, pending: 0, category: null, sort_order: 16 },
  { id: 'e137', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Equipo Dealing', amount: 2500, paid: 2500, pending: 0, category: null, sort_order: 17 },
  { id: 'e138', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'FX Expo Guadalajara', amount: 5917, paid: 5917, pending: 0, category: null, sort_order: 18 },
  { id: 'e139', period_id: 'p-mar-26', company_id: 'vexpro-001', concept: 'Gastos FX EXPO e INAUGURACIÓN', amount: 19432, paid: 19432, pending: 0, category: null, sort_order: 19 },
];

// ============================================================
// PREOPERATIVE EXPENSES
// ============================================================
export const DEMO_PREOPERATIVE: PreoperativeExpense[] = [
  { id: 'pre1', company_id: 'vexpro-001', concept: 'CRM MMtech', amount: 21000, paid: 21000, pending: 0, sort_order: 1 },
  { id: 'pre2', company_id: 'vexpro-001', concept: 'Equipo Diseño', amount: 1500, paid: 1500, pending: 0, sort_order: 2 },
  { id: 'pre3', company_id: 'vexpro-001', concept: 'Community Manager', amount: 500, paid: 500, pending: 0, sort_order: 3 },
  { id: 'pre4', company_id: 'vexpro-001', concept: 'Equipo Soporte (Daniel y Manuela)', amount: 1000, paid: 1000, pending: 0, sort_order: 4 },
  { id: 'pre5', company_id: 'vexpro-001', concept: 'Sitio web Vertex', amount: 1500, paid: 1500, pending: 0, sort_order: 5 },
  { id: 'pre6', company_id: 'vexpro-001', concept: 'Hosting y Dominio', amount: 553.03, paid: 553.03, pending: 0, sort_order: 6 },
  { id: 'pre7', company_id: 'vexpro-001', concept: 'Diseños web grupo financiero', amount: 2000, paid: 2000, pending: 0, sort_order: 7 },
  { id: 'pre8', company_id: 'vexpro-001', concept: 'Correos Google', amount: 63, paid: 63, pending: 0, sort_order: 8 },
  { id: 'pre9', company_id: 'vexpro-001', concept: 'Correos Outlook', amount: 100.2, paid: 100.2, pending: 0, sort_order: 9 },
  { id: 'pre10', company_id: 'vexpro-001', concept: 'Cuentas Bancarias', amount: 6000, paid: 6000, pending: 0, sort_order: 10 },
  { id: 'pre11', company_id: 'vexpro-001', concept: 'Empresa Saint Lucia', amount: 5500, paid: 5500, pending: 0, sort_order: 11 },
  { id: 'pre12', company_id: 'vexpro-001', concept: 'Empresa Mexico', amount: 3000, paid: 3000, pending: 0, sort_order: 12 },
  { id: 'pre13', company_id: 'vexpro-001', concept: 'Arrendamiento Oficina Mexico Agosto', amount: 10200, paid: 10200, pending: 0, sort_order: 13 },
  { id: 'pre14', company_id: 'vexpro-001', concept: 'Metaquotes', amount: 31269, paid: 31269, pending: 0, sort_order: 14 },
  { id: 'pre15', company_id: 'vexpro-001', concept: 'CRM + Social Trading', amount: 16000, paid: 16000, pending: 0, sort_order: 15 },
  { id: 'pre16', company_id: 'vexpro-001', concept: 'Manejo servers/Sintéticos/Controladas', amount: 4750, paid: 4750, pending: 0, sort_order: 16 },
  { id: 'pre17', company_id: 'vexpro-001', concept: 'Pago Sendgrid', amount: 150, paid: 150, pending: 0, sort_order: 17 },
  { id: 'pre18', company_id: 'vexpro-001', concept: 'Empresas grupo financiero', amount: 12459.4, paid: 12459.4, pending: 0, sort_order: 18 },
  { id: 'pre19', company_id: 'vexpro-001', concept: 'Citas SAT', amount: 304, paid: 304, pending: 0, sort_order: 19 },
  { id: 'pre20', company_id: 'vexpro-001', concept: 'Presta nombre adicional', amount: 101, paid: 101, pending: 0, sort_order: 20 },
  { id: 'pre21', company_id: 'vexpro-001', concept: 'Instalación de letreros', amount: 1515, paid: 1515, pending: 0, sort_order: 21 },
  { id: 'pre22', company_id: 'vexpro-001', concept: 'Abogado cambio de nombre legal', amount: 646, paid: 646, pending: 0, sort_order: 22 },
  { id: 'pre23', company_id: 'vexpro-001', concept: 'Traducción documentos + contratos', amount: 500, paid: 500, pending: 0, sort_order: 23 },
  { id: 'pre24', company_id: 'vexpro-001', concept: 'Internet no cancelado (6 meses)', amount: 424, paid: 424, pending: 0, sort_order: 24 },
  { id: 'pre25', company_id: 'vexpro-001', concept: 'Depósito cuenta bancaria', amount: 3000, paid: 3000, pending: 0, sort_order: 25 },
  { id: 'pre26', company_id: 'vexpro-001', concept: 'Oficina feb-julio (6 meses)', amount: 16200, paid: 16200, pending: 0, sort_order: 26 },
  { id: 'pre27', company_id: 'vexpro-001', concept: 'Mantenimiento edificio (6 meses)', amount: 1200, paid: 1200, pending: 0, sort_order: 27 },
  { id: 'pre28', company_id: 'vexpro-001', concept: 'Gastos Filipinas (5 personas x 30 USD)', amount: 150, paid: 150, pending: 0, sort_order: 28 },
  { id: 'pre29', company_id: 'vexpro-001', concept: 'Cena para fotos', amount: 166, paid: 166, pending: 0, sort_order: 29 },
  { id: 'pre30', company_id: 'vexpro-001', concept: 'Fotógrafo', amount: 78, paid: 78, pending: 0, sort_order: 30 },
  { id: 'pre31', company_id: 'vexpro-001', concept: 'Productos de marketing', amount: 480, paid: 480, pending: 0, sort_order: 31 },
  { id: 'pre32', company_id: 'vexpro-001', concept: 'Renta oficina Filipinas', amount: 68, paid: 68, pending: 0, sort_order: 32 },
  { id: 'pre33', company_id: 'vexpro-001', concept: 'Hospedaje Filipinas', amount: 290, paid: 290, pending: 0, sort_order: 33 },
  { id: 'pre34', company_id: 'vexpro-001', concept: 'Vuelos Filipinas (ida/vuelta)', amount: 784, paid: 784, pending: 0, sort_order: 34 },
  { id: 'pre35', company_id: 'vexpro-001', concept: 'Cambio Letreros oficina', amount: 300, paid: 300, pending: 0, sort_order: 35 },
  { id: 'pre36', company_id: 'vexpro-001', concept: 'Pago Director HK y Mauritius', amount: 125, paid: 125, pending: 0, sort_order: 36 },
];

// ============================================================
// OPERATING INCOME
// ============================================================
export const DEMO_OPERATING_INCOME: OperatingIncome[] = [
  { id: 'oi1', period_id: 'p-oct-25', company_id: 'vexpro-001', prop_firm: 0, broker_pnl: -3699, other: 0 },
  { id: 'oi2', period_id: 'p-nov-25', company_id: 'vexpro-001', prop_firm: 0, broker_pnl: 60251, other: 0 },
  { id: 'oi3', period_id: 'p-dic-25', company_id: 'vexpro-001', prop_firm: 0, broker_pnl: 135424.5, other: 0 },
  { id: 'oi4', period_id: 'p-jan-26', company_id: 'vexpro-001', prop_firm: 0, broker_pnl: 0, other: 0 },
  { id: 'oi5', period_id: 'p-feb-26', company_id: 'vexpro-001', prop_firm: 0, broker_pnl: 0, other: 0 },
  { id: 'oi6', period_id: 'p-mar-26', company_id: 'vexpro-001', prop_firm: 0, broker_pnl: 0, other: 0 },
  { id: 'oi7', period_id: 'p-apr-26', company_id: 'vexpro-001', prop_firm: 0, broker_pnl: 0, other: 0 },
];

// ============================================================
// BROKER BALANCE
// ============================================================
export const DEMO_BROKER_BALANCE: BrokerBalance[] = [
  { id: 'bb1', period_id: 'p-oct-25', company_id: 'vexpro-001', pnl_book_b: -3699, liquidity_commissions: 0 },
  { id: 'bb2', period_id: 'p-nov-25', company_id: 'vexpro-001', pnl_book_b: 60474, liquidity_commissions: 0 },
  { id: 'bb3', period_id: 'p-dic-25', company_id: 'vexpro-001', pnl_book_b: 135424.5, liquidity_commissions: 0 },
  { id: 'bb4', period_id: 'p-jan-26', company_id: 'vexpro-001', pnl_book_b: 0, liquidity_commissions: 0 },
  { id: 'bb5', period_id: 'p-feb-26', company_id: 'vexpro-001', pnl_book_b: 0, liquidity_commissions: 0 },
  { id: 'bb6', period_id: 'p-mar-26', company_id: 'vexpro-001', pnl_book_b: 0, liquidity_commissions: 0 },
  { id: 'bb7', period_id: 'p-apr-26', company_id: 'vexpro-001', pnl_book_b: 0, liquidity_commissions: 0 },
];

// ============================================================
// FINANCIAL STATUS (fixed balance chain)
// ============================================================
export const DEMO_FINANCIAL_STATUS: FinancialStatus[] = [
  { id: 'fs1', period_id: 'p-oct-25', company_id: 'vexpro-001', operating_expenses_paid: 35797.89, net_total: -31744.682, previous_month_balance: 0, current_month_balance: 16466.45 },
  { id: 'fs2', period_id: 'p-nov-25', company_id: 'vexpro-001', operating_expenses_paid: 64632.7, net_total: -8040.83, previous_month_balance: 16466.45, current_month_balance: 173080.85 },
  { id: 'fs3', period_id: 'p-dic-25', company_id: 'vexpro-001', operating_expenses_paid: 57161.85, net_total: -30272.525, previous_month_balance: 173080.85, current_month_balance: 165148.41 },
  { id: 'fs4', period_id: 'p-jan-26', company_id: 'vexpro-001', operating_expenses_paid: 51129.47, net_total: -36934.97, previous_month_balance: 165148.41, current_month_balance: -132839.64 },
  { id: 'fs5', period_id: 'p-feb-26', company_id: 'vexpro-001', operating_expenses_paid: 64625.6, net_total: -41773.1875, previous_month_balance: -132839.64, current_month_balance: -30753.63 },
  { id: 'fs6', period_id: 'p-mar-26', company_id: 'vexpro-001', operating_expenses_paid: 67252, net_total: -57252, previous_month_balance: -30753.63, current_month_balance: -44585.35 },
  { id: 'fs7', period_id: 'p-apr-26', company_id: 'vexpro-001', operating_expenses_paid: 0, net_total: 0, previous_month_balance: -44585.35, current_month_balance: -44585.35 },
];

// ============================================================
// PARTNERS
// ============================================================
export const DEMO_PARTNERS: Partner[] = [
  { id: 'partner1', company_id: 'vexpro-001', user_id: null, name: 'Sergio', email: null, percentage: 0.25 },
  { id: 'partner2', company_id: 'vexpro-001', user_id: null, name: 'Hugo', email: null, percentage: 0.30 },
  { id: 'partner3', company_id: 'vexpro-001', user_id: null, name: 'Kevin', email: null, percentage: 0.30 },
  { id: 'partner4', company_id: 'vexpro-001', user_id: null, name: 'Stiven', email: null, percentage: 0.15 },
];

// ============================================================
// PARTNER DISTRIBUTIONS
// ============================================================
export const DEMO_PARTNER_DISTRIBUTIONS: PartnerDistribution[] = [
  // Oct 25
  { id: 'pd1', period_id: 'p-oct-25', partner_id: 'partner1', company_id: 'vexpro-001', percentage: 0.25, amount: 119.05 },
  { id: 'pd2', period_id: 'p-oct-25', partner_id: 'partner2', company_id: 'vexpro-001', percentage: 0.30, amount: 142.86 },
  { id: 'pd3', period_id: 'p-oct-25', partner_id: 'partner3', company_id: 'vexpro-001', percentage: 0.30, amount: 142.86 },
  { id: 'pd4', period_id: 'p-oct-25', partner_id: 'partner4', company_id: 'vexpro-001', percentage: 0.15, amount: 71.43 },
  // Nov 25
  { id: 'pd5', period_id: 'p-nov-25', partner_id: 'partner1', company_id: 'vexpro-001', percentage: 0.25, amount: -2010.21 },
  { id: 'pd6', period_id: 'p-nov-25', partner_id: 'partner2', company_id: 'vexpro-001', percentage: 0.30, amount: -2412.25 },
  { id: 'pd7', period_id: 'p-nov-25', partner_id: 'partner3', company_id: 'vexpro-001', percentage: 0.30, amount: -2412.25 },
  { id: 'pd8', period_id: 'p-nov-25', partner_id: 'partner4', company_id: 'vexpro-001', percentage: 0.15, amount: -1206.12 },
  // Dic 25
  { id: 'pd9', period_id: 'p-dic-25', partner_id: 'partner1', company_id: 'vexpro-001', percentage: 0.25, amount: 16128.86 },
  { id: 'pd10', period_id: 'p-dic-25', partner_id: 'partner2', company_id: 'vexpro-001', percentage: 0.30, amount: 19354.63 },
  { id: 'pd11', period_id: 'p-dic-25', partner_id: 'partner3', company_id: 'vexpro-001', percentage: 0.30, amount: 19354.63 },
  { id: 'pd12', period_id: 'p-dic-25', partner_id: 'partner4', company_id: 'vexpro-001', percentage: 0.15, amount: 9677.32 },
  // Jan 26
  { id: 'pd13', period_id: 'p-jan-26', partner_id: 'partner1', company_id: 'vexpro-001', percentage: 0.25, amount: 3145.88 },
  { id: 'pd14', period_id: 'p-jan-26', partner_id: 'partner2', company_id: 'vexpro-001', percentage: 0.30, amount: 3775.05 },
  { id: 'pd15', period_id: 'p-jan-26', partner_id: 'partner3', company_id: 'vexpro-001', percentage: 0.30, amount: 3775.05 },
  { id: 'pd16', period_id: 'p-jan-26', partner_id: 'partner4', company_id: 'vexpro-001', percentage: 0.15, amount: 1887.53 },
  // Feb 26
  { id: 'pd17', period_id: 'p-feb-26', partner_id: 'partner1', company_id: 'vexpro-001', percentage: 0.25, amount: 9639.31 },
  { id: 'pd18', period_id: 'p-feb-26', partner_id: 'partner2', company_id: 'vexpro-001', percentage: 0.3, amount: 11567.17 },
  { id: 'pd19', period_id: 'p-feb-26', partner_id: 'partner3', company_id: 'vexpro-001', percentage: 0.3, amount: 11567.17 },
  { id: 'pd20', period_id: 'p-feb-26', partner_id: 'partner4', company_id: 'vexpro-001', percentage: 0.15, amount: 5783.59 },
  // Mar 26
  { id: 'pd21', period_id: 'p-mar-26', partner_id: 'partner1', company_id: 'vexpro-001', percentage: 0.25, amount: 0 },
  { id: 'pd22', period_id: 'p-mar-26', partner_id: 'partner2', company_id: 'vexpro-001', percentage: 0.3, amount: 0 },
  { id: 'pd23', period_id: 'p-mar-26', partner_id: 'partner3', company_id: 'vexpro-001', percentage: 0.3, amount: 0 },
  { id: 'pd24', period_id: 'p-mar-26', partner_id: 'partner4', company_id: 'vexpro-001', percentage: 0.15, amount: 0 },
  // Abr 26
  { id: 'pd25', period_id: 'p-apr-26', partner_id: 'partner1', company_id: 'vexpro-001', percentage: 0.25, amount: 0 },
  { id: 'pd26', period_id: 'p-apr-26', partner_id: 'partner2', company_id: 'vexpro-001', percentage: 0.3, amount: 0 },
  { id: 'pd27', period_id: 'p-apr-26', partner_id: 'partner3', company_id: 'vexpro-001', percentage: 0.3, amount: 0 },
  { id: 'pd28', period_id: 'p-apr-26', partner_id: 'partner4', company_id: 'vexpro-001', percentage: 0.15, amount: 0 },
];

// ============================================================
// LIQUIDITY MOVEMENTS
// ============================================================
export const DEMO_LIQUIDITY: LiquidityMovement[] = [
  { id: 'liq1', company_id: 'vexpro-001', date: '2025-11-11', user_email: 'desarrollohumano1287@gmail.com', mt_account: '100742', deposit: 28000, withdrawal: 0, balance: 28000, notes: null },
  { id: 'liq2', company_id: 'vexpro-001', date: '2025-11-19', user_email: 'jme.inversiones.trading@gmail.com', mt_account: '103111', deposit: 25000, withdrawal: 0, balance: 53000, notes: null },
  { id: 'liq3', company_id: 'vexpro-001', date: '2025-11-25', user_email: 'jme.inversiones.trading@gmail.com', mt_account: '103111', deposit: 12500, withdrawal: 0, balance: 65500, notes: null },
  { id: 'liq4', company_id: 'vexpro-001', date: '2025-12-11', user_email: 'jme.inversiones.trading@gmail.com', mt_account: '103111', deposit: 12236, withdrawal: 0, balance: 77736, notes: null },
  { id: 'liq5', company_id: 'vexpro-001', date: '2025-12-13', user_email: 'jme.inversiones.trading@gmail.com', mt_account: '103111', deposit: 50000, withdrawal: 0, balance: 127736, notes: null },
  { id: 'liq6', company_id: 'vexpro-001', date: '2025-12-15', user_email: 'jme.inversiones.trading@gmail.com', mt_account: '103111', deposit: 10000, withdrawal: 0, balance: 137736, notes: null },
  { id: 'liq7', company_id: 'vexpro-001', date: '2025-12-18', user_email: 'jme.inversiones.trading@gmail.com', mt_account: '103111', deposit: 0, withdrawal: 25000, balance: 112736, notes: null },
  { id: 'liq8', company_id: 'vexpro-001', date: '2026-01-08', user_email: 'jme.inversiones.trading@gmail.com', mt_account: '103111', deposit: 0, withdrawal: 13192, balance: 99544, notes: null },
  { id: 'liq9', company_id: 'vexpro-001', date: '2026-01-16', user_email: 'jme.inversiones.trading@gmail.com', mt_account: null, deposit: 0, withdrawal: 16500, balance: 83044, notes: null },
  { id: 'liq10', company_id: 'vexpro-001', date: '2026-01-20', user_email: 'jme.inversiones.trading@gmail.com', mt_account: null, deposit: 0, withdrawal: 23400, balance: 59644, notes: null },
  { id: 'liq11', company_id: 'vexpro-001', date: '2026-01-20', user_email: 'Pérdidas Totales', mt_account: null, deposit: 0, withdrawal: 59644, balance: 0, notes: 'Pérdidas Totales' },
  // Mar 2026 deposits
  { id: 'liq12', company_id: 'vexpro-001', date: '2026-03-06', user_email: 'zurita3103@gmail.com', mt_account: null, deposit: 2508, withdrawal: 0, balance: 2508, notes: null },
  { id: 'liq13', company_id: 'vexpro-001', date: '2026-03-06', user_email: 'guillermo.soto1908@gmail.com', mt_account: null, deposit: 850, withdrawal: 0, balance: 3358, notes: null },
  { id: 'liq14', company_id: 'vexpro-001', date: '2026-03-06', user_email: 'freddy_mejiaos10@outlook.com', mt_account: null, deposit: 12186, withdrawal: 0, balance: 15544, notes: null },
  { id: 'liq15', company_id: 'vexpro-001', date: '2026-03-10', user_email: 'zurita3103@gmail.com', mt_account: null, deposit: 2000, withdrawal: 0, balance: 17544, notes: null },
  { id: 'liq16', company_id: 'vexpro-001', date: '2026-03-10', user_email: 'carlosbolanos309@gmail.com', mt_account: null, deposit: 3278, withdrawal: 0, balance: 20822, notes: null },
  { id: 'liq17', company_id: 'vexpro-001', date: '2026-03-13', user_email: 'e.ruelas.va@gmail.com', mt_account: null, deposit: 2024, withdrawal: 0, balance: 22846, notes: null },
  { id: 'liq18', company_id: 'vexpro-001', date: '2026-03-13', user_email: 'javier.zurita@vexprofx.com', mt_account: null, deposit: 3129.35, withdrawal: 0, balance: 25975.35, notes: null },
  { id: 'liq19', company_id: 'vexpro-001', date: '2026-03-16', user_email: 'movinglosalamos@gmail.com', mt_account: null, deposit: 1073.02, withdrawal: 0, balance: 27048.37, notes: null },
  { id: 'liq20', company_id: 'vexpro-001', date: '2026-03-20', user_email: 'dani2121lopez@gmail.com', mt_account: null, deposit: 1729.88, withdrawal: 0, balance: 28778.25, notes: null },
  { id: 'liq21', company_id: 'vexpro-001', date: '2026-03-20', user_email: 'zuritaedinzon01@gmail.com', mt_account: null, deposit: 1773.36, withdrawal: 0, balance: 30551.61, notes: null },
  { id: 'liq22', company_id: 'vexpro-001', date: '2026-03-20', user_email: 'hugo.rodriguez.salgado@gmail.com', mt_account: null, deposit: 1890.31, withdrawal: 0, balance: 32441.92, notes: null },
  { id: 'liq23', company_id: 'vexpro-001', date: '2026-03-20', user_email: 'k10perezvanegas@gmail.com', mt_account: null, deposit: 1969.88, withdrawal: 0, balance: 34411.80, notes: null },
  { id: 'liq24', company_id: 'vexpro-001', date: '2026-03-20', user_email: 'pidollareun@gmail.com', mt_account: null, deposit: 5000, withdrawal: 0, balance: 39411.80, notes: null },
];

// ============================================================
// INVESTMENTS
// ============================================================
export const DEMO_INVESTMENTS: Investment[] = [
  { id: 'inv1', company_id: 'vexpro-001', date: '2025-12-18', concept: 'Inversión OTC', responsible: 'Kevin', deposit: 90000, withdrawal: 0, profit: 0, balance: 90000 },
  { id: 'inv2', company_id: 'vexpro-001', date: '2026-01-07', concept: null, responsible: null, deposit: 0, withdrawal: 22579, profit: 0, balance: 67421 },
  { id: 'inv3', company_id: 'vexpro-001', date: '2026-01-12', concept: 'Profit OTC', responsible: null, deposit: 0, withdrawal: 0, profit: 2700, balance: 70121 },
  { id: 'inv4', company_id: 'vexpro-001', date: '2026-01-13', concept: 'Transferencia para procesar retiros', responsible: null, deposit: 0, withdrawal: 30000, profit: 0, balance: 40121 },
  { id: 'inv5', company_id: 'vexpro-001', date: '2026-01-15', concept: 'Transferencia para procesar retiros', responsible: null, deposit: 0, withdrawal: 20000, profit: 0, balance: 20121 },
  { id: 'inv6', company_id: 'vexpro-001', date: '2026-01-16', concept: 'Transferencia para procesar retiros', responsible: null, deposit: 0, withdrawal: 20121, profit: 0, balance: 0 },
  { id: 'inv7', company_id: 'vexpro-001', date: '2026-03-10', concept: 'Inversión ORO RETORNO', responsible: 'Kevin', deposit: 42000, withdrawal: 0, profit: 0, balance: 42000 },
  { id: 'inv8', company_id: 'vexpro-001', date: '2026-03-12', concept: 'Inversión ORO RETORNO', responsible: 'Kevin', deposit: 20000, withdrawal: 0, profit: 0, balance: 62000 },
  { id: 'inv9', company_id: 'vexpro-001', date: '2026-03-25', concept: 'Ganancia 5% inversión oro', responsible: 'Kevin', deposit: 2900, withdrawal: 0, profit: 0, balance: 64900 },
  { id: 'inv10', company_id: 'vexpro-001', date: '2026-03-25', concept: 'Inversión ORO RETORNO', responsible: 'Kevin', deposit: 17500, withdrawal: 0, profit: 0, balance: 82400 },
  { id: 'inv11', company_id: 'vexpro-001', date: '2026-03-29', concept: 'Inversión ORO RETORNO', responsible: 'Sergio', deposit: 150000, withdrawal: 0, profit: 0, balance: 232400 },
  { id: 'inv12', company_id: 'vexpro-001', date: '2026-04-01', concept: 'Inversión ORO RETORNO', responsible: 'Kevin', deposit: 30000, withdrawal: 0, profit: 0, balance: 262400 },
];

// ============================================================
// SALDO A FAVOR: Chain computation for all periods
// ============================================================
const SALDO_START_PERIOD = 'p-oct-25';

export interface SaldoInfo {
  egresosNetos: number;
  saldoAnterior: number;
  saldoUsado: number;
  saldoNuevo: number;
  totalDistribuir: number;
}

export function isPeriodAfterSaldoStart(periodId: string): boolean {
  const startIdx = DEMO_PERIODS.findIndex(p => p.id === SALDO_START_PERIOD);
  const periodIdx = DEMO_PERIODS.findIndex(p => p.id === periodId);
  return periodIdx >= startIdx;
}

export function computeSaldoChain(): Map<string, SaldoInfo> {
  const chain = new Map<string, SaldoInfo>();
  let saldoAcumulado = 0;

  for (const period of DEMO_PERIODS) {
    if (!isPeriodAfterSaldoStart(period.id)) continue;

    const oi = DEMO_OPERATING_INCOME.find(o => o.period_id === period.id);
    const egresosNetos = DEMO_EXPENSES.filter(e => e.period_id === period.id).reduce((s, e) => s + e.amount, 0);
    // Prop Firm net income = sales - withdrawals
    const pfs = DEMO_PROP_FIRM_SALES.find(p => p.period_id === period.id)?.amount || 0;
    const pfW = DEMO_WITHDRAWALS.find(w => w.period_id === period.id && w.category === 'prop_firm')?.amount || 0;
    const propFirmNet = pfs - pfW;
    const ingresosNetos = (oi ? oi.broker_pnl + oi.other : 0) + propFirmNet;

    const netBalance = ingresosNetos - egresosNetos;

    const saldoAnterior = saldoAcumulado;
    let saldoUsado = 0;
    let totalDistribuir = ingresosNetos;

    if (netBalance < 0) {
      const deficit = Math.abs(netBalance);
      if (saldoAnterior >= deficit) {
        saldoUsado = deficit;
      } else {
        saldoUsado = saldoAnterior;
        const remaining = deficit - saldoAnterior;
        totalDistribuir = ingresosNetos - remaining;
      }
      saldoAcumulado = saldoAnterior - saldoUsado;
    } else if (netBalance > 0) {
      saldoAcumulado = saldoAnterior + netBalance;
    }

    chain.set(period.id, { egresosNetos, saldoAnterior, saldoUsado, saldoNuevo: saldoAcumulado, totalDistribuir });
  }

  return chain;
}

// ============================================================
// PERSISTED DATA HELPERS (localStorage with DEMO fallback)
// ============================================================
function getPersistedDeposits(periodId: string): Deposit[] {
  if (typeof window === 'undefined') return DEMO_DEPOSITS.filter(d => d.period_id === periodId);
  const key = `fd_data_deposits_${periodId}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored);
      return parsed.map((d: any) => ({
        id: d.id,
        period_id: periodId,
        company_id: 'vexpro-001',
        channel: d.channel,
        amount: d.amount,
        notes: null,
      }));
    }
  } catch { /* fall through */ }
  return DEMO_DEPOSITS.filter(d => d.period_id === periodId);
}

function getPersistedWithdrawals(periodId: string): Withdrawal[] {
  if (typeof window === 'undefined') return DEMO_WITHDRAWALS.filter(w => w.period_id === periodId);
  const key = `fd_data_withdrawals_${periodId}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored);
      return parsed.map((w: any) => ({
        id: w.id,
        period_id: periodId,
        company_id: 'vexpro-001',
        category: w.category,
        amount: w.amount,
        notes: null,
      }));
    }
  } catch { /* fall through */ }
  return DEMO_WITHDRAWALS.filter(w => w.period_id === periodId);
}

function getPersistedExpenses(periodId: string): Expense[] {
  if (typeof window === 'undefined') return DEMO_EXPENSES.filter(e => e.period_id === periodId);
  const key = `fd_data_expenses_${periodId}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored);
      return parsed.map((e: any, i: number) => ({
        id: e.id || `exp-${i}`,
        period_id: periodId,
        company_id: 'vexpro-001',
        concept: e.concept,
        amount: e.amount,
        paid: e.paid,
        pending: e.pending,
        category: e.category || null,
        sort_order: e.sort_order || i + 1,
      }));
    }
  } catch { /* fall through */ }
  return DEMO_EXPENSES.filter(e => e.period_id === periodId);
}

function getPersistedOperatingIncome(periodId: string): OperatingIncome | null {
  return DEMO_OPERATING_INCOME.find(oi => oi.period_id === periodId) || null;
}

export function getLiquidityData(): LiquidityMovement[] {
  if (typeof window === 'undefined') return DEMO_LIQUIDITY;
  try {
    const stored = localStorage.getItem('fd_upload_liquidity');
    if (stored) return JSON.parse(stored);
  } catch { /* fall through */ }
  return DEMO_LIQUIDITY;
}

export function getInvestmentsData(): Investment[] {
  if (typeof window === 'undefined') return DEMO_INVESTMENTS;
  try {
    const stored = localStorage.getItem('fd_upload_investments');
    if (stored) return JSON.parse(stored);
  } catch { /* fall through */ }
  return DEMO_INVESTMENTS;
}

// ============================================================
// HELPER: Get period summary (single or consolidated)
// ============================================================
export function getPeriodSummary(periodId: string): PeriodSummary | null {
  const period = DEMO_PERIODS.find(p => p.id === periodId);
  if (!period) return null;

  const deposits = getPersistedDeposits(periodId);
  const withdrawals = getPersistedWithdrawals(periodId);
  const expenses = getPersistedExpenses(periodId);
  const propFirmSale = DEMO_PROP_FIRM_SALES.find(p => p.period_id === periodId);
  const p2pTransfer = DEMO_P2P_TRANSFERS.find(p => p.period_id === periodId);
  const operatingIncome = getPersistedOperatingIncome(periodId);
  const brokerBalance = DEMO_BROKER_BALANCE.find(bb => bb.period_id === periodId) || null;
  const financialStatus = DEMO_FINANCIAL_STATUS.find(fs => fs.period_id === periodId) || null;

  const totalDeposits = deposits.reduce((sum, d) => sum + d.amount, 0);
  const totalWithdrawals = withdrawals.reduce((sum, w) => sum + w.amount, 0);
  const propFirmSales = propFirmSale?.amount || 0;
  const propFirmWithdrawal = withdrawals.find(w => w.category === 'prop_firm')?.amount || 0;
  const propFirmNetIncome = propFirmSales - propFirmWithdrawal;
  const p2p = p2pTransfer?.amount || 0;

  return {
    period,
    totalDeposits,
    totalWithdrawals,
    netDeposit: totalDeposits - totalWithdrawals,
    propFirmSales,
    propFirmNetIncome,
    investmentProfits: 0, // demo data has no investments — live mode computes
    brokerDeposits: totalDeposits - propFirmSales,
    p2pTransfer: p2p,
    totalExpenses: expenses.reduce((sum, e) => sum + e.amount, 0),
    totalExpensesPaid: expenses.reduce((sum, e) => sum + e.paid, 0),
    totalExpensesPending: expenses.reduce((sum, e) => sum + e.pending, 0),
    operatingIncome,
    brokerBalance,
    financialStatus,
    deposits,
    withdrawals,
    expenses,
  };
}

export function getConsolidatedSummary(periodIds: string[]): PeriodSummary | null {
  if (periodIds.length === 0) return null;
  if (periodIds.length === 1) return getPeriodSummary(periodIds[0]);

  const periods = DEMO_PERIODS.filter(p => periodIds.includes(p.id));
  if (periods.length === 0) return null;

  const firstPeriod = periods[0];
  const lastPeriod = periods[periods.length - 1];

  const allDeposits = periodIds.flatMap(pid => getPersistedDeposits(pid));
  const allWithdrawals = periodIds.flatMap(pid => getPersistedWithdrawals(pid));
  const allExpenses = periodIds.flatMap(pid => getPersistedExpenses(pid));

  // Consolidate deposits by channel
  const channels: Array<'coinsbuy' | 'fairpay' | 'unipayment' | 'other'> = ['coinsbuy', 'fairpay', 'unipayment', 'other'];
  const consolidatedDeposits: Deposit[] = channels.map((ch, i) => ({
    id: `cons-d-${ch}`,
    period_id: 'consolidated',
    company_id: firstPeriod.company_id,
    channel: ch,
    amount: allDeposits.filter(d => d.channel === ch).reduce((s, d) => s + d.amount, 0),
    notes: null,
  }));

  const categories: Array<'ib_commissions' | 'broker' | 'prop_firm' | 'other'> = ['ib_commissions', 'broker', 'prop_firm', 'other'];
  const consolidatedWithdrawals: Withdrawal[] = categories.map((cat) => ({
    id: `cons-w-${cat}`,
    period_id: 'consolidated',
    company_id: firstPeriod.company_id,
    category: cat,
    amount: allWithdrawals.filter(w => w.category === cat).reduce((s, w) => s + w.amount, 0),
    notes: null,
  }));

  const totalDeposits = consolidatedDeposits.reduce((s, d) => s + d.amount, 0);
  const totalWithdrawals = consolidatedWithdrawals.reduce((s, w) => s + w.amount, 0);
  const propFirmSales = DEMO_PROP_FIRM_SALES.filter(p => periodIds.includes(p.period_id)).reduce((s, p) => s + p.amount, 0);
  const propFirmWithdrawal = consolidatedWithdrawals.find(w => w.category === 'prop_firm')?.amount || 0;
  const propFirmNetIncome = propFirmSales - propFirmWithdrawal;
  const p2p = DEMO_P2P_TRANSFERS.filter(p => periodIds.includes(p.period_id)).reduce((s, p) => s + p.amount, 0);

  const incomes = periodIds.map(pid => getPersistedOperatingIncome(pid)).filter((oi): oi is OperatingIncome => oi !== null);
  const consolidatedIncome: OperatingIncome = {
    id: 'cons-oi',
    period_id: 'consolidated',
    company_id: firstPeriod.company_id,
    prop_firm: incomes.reduce((s, i) => s + i.prop_firm, 0),
    broker_pnl: incomes.reduce((s, i) => s + i.broker_pnl, 0),
    other: incomes.reduce((s, i) => s + i.other, 0),
  };

  const brokers = DEMO_BROKER_BALANCE.filter(bb => periodIds.includes(bb.period_id));
  const consolidatedBroker: BrokerBalance = {
    id: 'cons-bb',
    period_id: 'consolidated',
    company_id: firstPeriod.company_id,
    pnl_book_b: brokers.reduce((s, b) => s + b.pnl_book_b, 0),
    liquidity_commissions: brokers.reduce((s, b) => s + b.liquidity_commissions, 0),
  };

  const firstFs = DEMO_FINANCIAL_STATUS.find(fs => fs.period_id === firstPeriod.id);
  const lastFs = DEMO_FINANCIAL_STATUS.find(fs => fs.period_id === lastPeriod.id);
  const allFs = DEMO_FINANCIAL_STATUS.filter(fs => periodIds.includes(fs.period_id));

  const sumOperatingExpensesPaid = allFs.reduce((s, f) => s + f.operating_expenses_paid, 0);
  const sumNetTotal = allFs.reduce((s, f) => s + f.net_total, 0);
  const startingBalance = firstFs?.previous_month_balance || 0;

  const consolidatedFs: FinancialStatus = {
    id: 'cons-fs',
    period_id: 'consolidated',
    company_id: firstPeriod.company_id,
    operating_expenses_paid: sumOperatingExpensesPaid,
    net_total: sumNetTotal,
    previous_month_balance: startingBalance,
    current_month_balance: startingBalance + sumNetTotal,
  };

  const consolidatedPeriod: Period = {
    id: 'consolidated',
    company_id: firstPeriod.company_id,
    year: lastPeriod.year,
    month: lastPeriod.month,
    label: `${firstPeriod.label} — ${lastPeriod.label}`,
    is_closed: false,
    reserve_pct: 0.10,
  };

  return {
    period: consolidatedPeriod,
    totalDeposits,
    totalWithdrawals,
    netDeposit: totalDeposits - totalWithdrawals,
    propFirmSales,
    propFirmNetIncome,
    investmentProfits: 0, // demo data has no investments
    brokerDeposits: totalDeposits - propFirmSales,
    p2pTransfer: p2p,
    totalExpenses: allExpenses.reduce((s, e) => s + e.amount, 0),
    totalExpensesPaid: allExpenses.reduce((s, e) => s + e.paid, 0),
    totalExpensesPending: allExpenses.reduce((s, e) => s + e.pending, 0),
    operatingIncome: consolidatedIncome,
    brokerBalance: consolidatedBroker,
    financialStatus: consolidatedFs,
    deposits: consolidatedDeposits,
    withdrawals: consolidatedWithdrawals,
    expenses: allExpenses,
  };
}
