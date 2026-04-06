import type { Employee, CommercialProfile, CommercialMonthlyResult } from './types';

// ─── Employees (general staff) ───
export const DEMO_EMPLOYEES: Employee[] = [
  { id: 'emp-001', company_id: 'vexpro-001', name: 'Kevin', email: 'kevin@vexprofx.com', position: 'CEO', department: 'Dirección', start_date: '2024-01-01', salary: null, status: 'active', phone: null, country: null, notes: null, birthday: null, supervisor: null, comments: null },
  { id: 'emp-002', company_id: 'vexpro-001', name: 'Daniela', email: 'daniela@vexprofx.com', position: 'Contadora', department: 'Finanzas', start_date: '2024-03-01', salary: 800, status: 'active', phone: null, country: null, notes: null, birthday: null, supervisor: null, comments: null },
];

// ─── Commercial Force ───
// Data extracted from "Net Deposit & PNL VEX PRO LATAM.xlsx"

export const DEMO_COMMERCIAL_PROFILES: CommercialProfile[] = [
  // HEADs
  { id: 'cp-001', company_id: 'vexpro-001', name: 'Hugo Ortiz', email: 'huguitoo.95@gmail.com', role: 'sales_manager', head_id: null, net_deposit_pct: 7, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: 'Top earner. Variable salary in some months.', hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-002', company_id: 'vexpro-001', name: 'Andres Arciniegas', email: 'afarciniegas@gmail.com', role: 'head', head_id: null, net_deposit_pct: 7, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-003', company_id: 'vexpro-001', name: 'Luka Angeles', email: 'lukaangeles@gmail.com', role: 'head', head_id: null, net_deposit_pct: 7, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-004', company_id: 'vexpro-001', name: 'Luis Diaz', email: 'luismigueldiazortega@gmail.com', role: 'head', head_id: null, net_deposit_pct: 7, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-005', company_id: 'vexpro-001', name: 'Nicolas Garzaro', email: 'nicolasgarzaro@gmail.com', role: 'head', head_id: null, net_deposit_pct: 7, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: 'Promoted from BDM to HEAD.', hire_date: null, birthday: null, status: 'active' },

  // BDMs under Hugo Ortiz (cp-001)
  { id: 'cp-006', company_id: 'vexpro-001', name: 'Javier Castillo', email: 'javiercastillofx@gmail.com', role: 'bdm', head_id: 'cp-001', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-007', company_id: 'vexpro-001', name: 'Angie Tapia', email: 'tpangietapia@gmail.com', role: 'bdm', head_id: 'cp-001', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-008', company_id: 'vexpro-001', name: 'Aldo Vital', email: 'aldovital@gmail.com', role: 'bdm', head_id: 'cp-001', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-009', company_id: 'vexpro-001', name: 'Jeff Alfonso', email: 'jeffalfonsoskt8@gmail.com', role: 'bdm', head_id: 'cp-001', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-010', company_id: 'vexpro-001', name: 'Christian Prada', email: 'christianpradaoficial@gmail.com', role: 'bdm', head_id: 'cp-001', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-011', company_id: 'vexpro-001', name: 'Zeidy Riano', email: 'zeidyriano@gmail.com', role: 'bdm', head_id: 'cp-001', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-012', company_id: 'vexpro-001', name: 'Javier Zurita', email: 'zuritajavier6@gmail.com', role: 'bdm', head_id: 'cp-001', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: 500, benefits: null, comments: 'Fixed salary in Nov 2024.', hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-013', company_id: 'vexpro-001', name: 'Jefry Orozco', email: 'orozcotrading7@gmail.com', role: 'bdm', head_id: 'cp-001', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-014', company_id: 'vexpro-001', name: 'Mario Sanchez', email: 'mariosnchz33@gmail.com', role: 'bdm', head_id: 'cp-001', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-015', company_id: 'vexpro-001', name: 'Jose Elizalde', email: 'eliaselizalde11@gmail.com', role: 'bdm', head_id: 'cp-001', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-016', company_id: 'vexpro-001', name: 'Antony Flores', email: 'tonnyutreras@gmail.com', role: 'bdm', head_id: 'cp-001', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },

  // BDMs under Andres Arciniegas (cp-002)
  { id: 'cp-017', company_id: 'vexpro-001', name: 'Luis Montalban', email: 'luismontalbanfx@gmail.com', role: 'bdm', head_id: 'cp-002', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: 500, benefits: null, comments: 'Fixed salary in Dec 2024.', hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-018', company_id: 'vexpro-001', name: 'Christian Arellano', email: 'christianarellanofx@gmail.com', role: 'bdm', head_id: 'cp-002', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },

  // BDMs under Luka Angeles (cp-003)
  { id: 'cp-019', company_id: 'vexpro-001', name: 'Ana Garcia', email: 'garciaana4531@gmail.com', role: 'bdm', head_id: 'cp-003', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-020', company_id: 'vexpro-001', name: 'Omar Sosa', email: 'omarsosa.fx@gmail.com', role: 'bdm', head_id: 'cp-003', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },

  // BDMs under Luis Diaz (cp-004)
  { id: 'cp-021', company_id: 'vexpro-001', name: 'Jose Bozua', email: 'josebozua@gmail.com', role: 'bdm', head_id: 'cp-004', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-022', company_id: 'vexpro-001', name: 'Juan Hernandez', email: 'juancamilohernandez08@gmail.com', role: 'bdm', head_id: 'cp-004', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-023', company_id: 'vexpro-001', name: 'Eladio Garfias', email: 'eladiogarfiasfx@gmail.com', role: 'bdm', head_id: 'cp-004', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-024', company_id: 'vexpro-001', name: 'German Bolivar', email: 'germanbolivar81@gmail.com', role: 'bdm', head_id: 'cp-004', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },

  // BDMs under Nicolas Garzaro (cp-005)
  { id: 'cp-025', company_id: 'vexpro-001', name: 'Andres Serrano', email: 'andresserranofx@gmail.com', role: 'bdm', head_id: 'cp-005', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-026', company_id: 'vexpro-001', name: 'Rafael Martinez', email: 'rafaelmartinezlatam@gmail.com', role: 'bdm', head_id: 'cp-005', net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },

  // Independent BDMs (no head assigned)
  { id: 'cp-027', company_id: 'vexpro-001', name: 'Ali Germenos', email: 'aligermenos15@gmail.com', role: 'bdm', head_id: null, net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-028', company_id: 'vexpro-001', name: 'Nicolas Raffo', email: 'nicolasraffo@gmail.com', role: 'bdm', head_id: null, net_deposit_pct: null, pnl_pct: null, commission_per_lot: null, salary: 2000, benefits: null, comments: 'Fixed salary $2,000/month.', hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-029', company_id: 'vexpro-001', name: 'Tonny Valencia', email: 'tonnyvalencia@gmail.com', role: 'bdm', head_id: null, net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-030', company_id: 'vexpro-001', name: 'Lynette Cushcagua', email: 'lynettecushcagua@gmail.com', role: 'bdm', head_id: null, net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-031', company_id: 'vexpro-001', name: 'Johana Rangel', email: 'johanarangel@gmail.com', role: 'bdm', head_id: null, net_deposit_pct: 4, pnl_pct: null, commission_per_lot: null, salary: null, benefits: null, comments: null, hire_date: null, birthday: null, status: 'active' },
  { id: 'cp-032', company_id: 'vexpro-001', name: 'Stephan Tible', email: 'stephantible@gmail.com', role: 'bdm', head_id: null, net_deposit_pct: null, pnl_pct: null, commission_per_lot: null, salary: 1500, benefits: null, comments: 'Fixed salary $1,500/month.', hire_date: null, birthday: null, status: 'active' },

  // PNL-based profile
  { id: 'cp-033', company_id: 'vexpro-001', name: 'Millones693', email: 'millones693@gmail.com', role: 'bdm', head_id: null, net_deposit_pct: null, pnl_pct: 20, commission_per_lot: null, salary: null, benefits: null, comments: '20% of PNL. Special arrangement.', hire_date: null, birthday: null, status: 'active' },
];

// ─── Monthly Results ───
// period IDs match demo-data: p-oct-25, p-nov-25, p-dic-25, p-jan-26, p-feb-26

// Helper to build result entries
function mr(id: string, profileId: string, periodId: string, current: number, accumulated: number, total: number, pnl: number, commissions: number, bonus: number, salary: number): CommercialMonthlyResult {
  return { id, profile_id: profileId, period_id: periodId, net_deposit_current: current, net_deposit_accumulated: accumulated, net_deposit_total: total, pnl_current: pnl, pnl_accumulated: 0, pnl_total: pnl, commissions_earned: commissions, bonus, salary_paid: salary, total_earned: commissions + bonus + salary };
}

export const DEMO_MONTHLY_RESULTS: CommercialMonthlyResult[] = [
  // ─── Hugo Ortiz (cp-001) ───
  mr('mr-001', 'cp-001', 'p-oct-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-002', 'cp-001', 'p-nov-25', 0, 0, 0, 0, 0, 0, 2000),
  mr('mr-003', 'cp-001', 'p-dic-25', 0, 0, 0, 0, 0, 0, 1000),
  mr('mr-004', 'cp-001', 'p-jan-26', 117950, 0, 117950, 0, 8256.50, 0, 0),
  mr('mr-005', 'cp-001', 'p-feb-26', 79350, 58975, 138325, 0, 12921.19, 0, 0),

  // ─── Andres Arciniegas (cp-002) ───
  mr('mr-006', 'cp-002', 'p-oct-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-007', 'cp-002', 'p-nov-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-008', 'cp-002', 'p-dic-25', 18400, 0, 18400, 0, 1288.00, 0, 0),
  mr('mr-009', 'cp-002', 'p-jan-26', 3800, 9200, 13000, 0, 358.46, 0, 0),
  mr('mr-010', 'cp-002', 'p-feb-26', 3000, 5900, 8900, 0, 840.00, 0, 0),

  // ─── Luka Angeles (cp-003) ───
  mr('mr-011', 'cp-003', 'p-oct-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-012', 'cp-003', 'p-nov-25', 0, 0, 0, 0, 0, 0, 1000),
  mr('mr-013', 'cp-003', 'p-dic-25', 14500, 0, 14500, 0, 1015.00, 0, 0),
  mr('mr-014', 'cp-003', 'p-jan-26', 12700, 7250, 19950, 0, 1305.96, 0, 0),
  mr('mr-015', 'cp-003', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Luis Diaz (cp-004) ───
  mr('mr-016', 'cp-004', 'p-oct-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-017', 'cp-004', 'p-nov-25', 0, 0, 0, 0, 0, 0, 750),
  mr('mr-018', 'cp-004', 'p-dic-25', 11700, 0, 11700, 0, 819.00, 0, 0),
  mr('mr-019', 'cp-004', 'p-jan-26', 28200, 5850, 34050, 0, 2265.42, 0, 0),
  mr('mr-020', 'cp-004', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Nicolas Garzaro (cp-005) ───
  mr('mr-021', 'cp-005', 'p-oct-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-022', 'cp-005', 'p-nov-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-023', 'cp-005', 'p-dic-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-024', 'cp-005', 'p-jan-26', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-025', 'cp-005', 'p-feb-26', 2000, 0, 2000, 0, 140.00, 0, 0),

  // ─── Javier Castillo (cp-006) ───
  mr('mr-026', 'cp-006', 'p-oct-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-027', 'cp-006', 'p-nov-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-028', 'cp-006', 'p-dic-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-029', 'cp-006', 'p-jan-26', 11750, 0, 11750, 0, 470.00, 0, 0),
  mr('mr-030', 'cp-006', 'p-feb-26', 600, 5875, 6475, 0, 259.00, 0, 0),

  // ─── Angie Tapia (cp-007) ───
  mr('mr-031', 'cp-007', 'p-jan-26', 2000, 0, 2000, 0, 80.00, 0, 0),
  mr('mr-032', 'cp-007', 'p-feb-26', 0, 1000, 1000, 0, 40.00, 0, 0),

  // ─── Aldo Vital (cp-008) ───
  mr('mr-033', 'cp-008', 'p-jan-26', 2500, 0, 2500, 0, 100.00, 0, 0),
  mr('mr-034', 'cp-008', 'p-feb-26', 5800, 1250, 7050, 0, 282.00, 0, 0),

  // ─── Jeff Alfonso (cp-009) ───
  mr('mr-035', 'cp-009', 'p-jan-26', 5000, 0, 5000, 0, 200.00, 0, 0),
  mr('mr-036', 'cp-009', 'p-feb-26', 0, 2500, 2500, 0, 100.00, 0, 0),

  // ─── Christian Prada (cp-010) ───
  mr('mr-037', 'cp-010', 'p-jan-26', 2000, 0, 2000, 0, 80.00, 0, 0),
  mr('mr-038', 'cp-010', 'p-feb-26', 0, 1000, 1000, 0, 40.00, 0, 0),

  // ─── Zeidy Riano (cp-011) ───
  mr('mr-039', 'cp-011', 'p-jan-26', 6600, 0, 6600, 0, 264.00, 0, 0),
  mr('mr-040', 'cp-011', 'p-feb-26', 11900, 3300, 15200, 0, 608.00, 0, 0),

  // ─── Javier Zurita (cp-012) ───
  mr('mr-041', 'cp-012', 'p-nov-25', 0, 0, 0, 0, 0, 0, 500),
  mr('mr-042', 'cp-012', 'p-jan-26', 7500, 0, 7500, 0, 300.00, 0, 0),
  mr('mr-043', 'cp-012', 'p-feb-26', 3100, 3750, 6850, 0, 274.00, 0, 0),

  // ─── Jefry Orozco (cp-013) ───
  mr('mr-044', 'cp-013', 'p-jan-26', 5500, 0, 5500, 0, 220.00, 0, 0),
  mr('mr-045', 'cp-013', 'p-feb-26', 0, 2750, 2750, 0, 110.00, 0, 0),

  // ─── Mario Sanchez (cp-014) ───
  mr('mr-046', 'cp-014', 'p-jan-26', 6750, 0, 6750, 0, 270.00, 0, 0),
  mr('mr-047', 'cp-014', 'p-feb-26', 0, 3375, 3375, 0, 135.00, 0, 0),

  // ─── Jose Elizalde (cp-015) ───
  mr('mr-048', 'cp-015', 'p-jan-26', 11750, 0, 11750, 0, 470.00, 0, 0),
  mr('mr-049', 'cp-015', 'p-feb-26', 8650, 5875, 14525, 0, 581.00, 0, 0),

  // ─── Antony Flores (cp-016) ───
  mr('mr-050', 'cp-016', 'p-feb-26', 2000, 0, 2000, 0, 80.00, 0, 0),

  // ─── Luis Montalban (cp-017) ───
  mr('mr-051', 'cp-017', 'p-dic-25', 0, 0, 0, 0, 0, 0, 500),
  mr('mr-052', 'cp-017', 'p-jan-26', 3800, 0, 3800, 0, 152.00, 0, 0),
  mr('mr-053', 'cp-017', 'p-feb-26', 3000, 1900, 4900, 0, 196.00, 0, 0),

  // ─── Christian Arellano (cp-018) ───
  mr('mr-054', 'cp-018', 'p-dic-25', 18400, 0, 18400, 0, 736.00, 0, 0),
  mr('mr-055', 'cp-018', 'p-jan-26', 0, 9200, 9200, 0, 368.00, 0, 0),
  mr('mr-056', 'cp-018', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Ana Garcia (cp-019) ───
  mr('mr-057', 'cp-019', 'p-dic-25', 6000, 0, 6000, 0, 240.00, 0, 0),
  mr('mr-058', 'cp-019', 'p-jan-26', 10200, 3000, 13200, 0, 528.00, 0, 0),
  mr('mr-059', 'cp-019', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Omar Sosa (cp-020) ───
  mr('mr-060', 'cp-020', 'p-dic-25', 8500, 0, 8500, 0, 340.00, 0, 0),
  mr('mr-061', 'cp-020', 'p-jan-26', 2500, 4250, 6750, 0, 270.00, 0, 0),
  mr('mr-062', 'cp-020', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Jose Bozua (cp-021) ───
  mr('mr-063', 'cp-021', 'p-dic-25', 6500, 0, 6500, 0, 260.00, 0, 0),
  mr('mr-064', 'cp-021', 'p-jan-26', 13700, 3250, 16950, 0, 678.00, 0, 0),
  mr('mr-065', 'cp-021', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Juan Hernandez (cp-022) ───
  mr('mr-066', 'cp-022', 'p-dic-25', 1200, 0, 1200, 0, 48.00, 0, 0),
  mr('mr-067', 'cp-022', 'p-jan-26', 9000, 600, 9600, 0, 384.00, 0, 0),
  mr('mr-068', 'cp-022', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Eladio Garfias (cp-023) ───
  mr('mr-069', 'cp-023', 'p-dic-25', 4000, 0, 4000, 0, 160.00, 0, 0),
  mr('mr-070', 'cp-023', 'p-jan-26', 5500, 2000, 7500, 0, 300.00, 0, 0),
  mr('mr-071', 'cp-023', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── German Bolivar (cp-024) ───
  mr('mr-072', 'cp-024', 'p-jan-26', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-073', 'cp-024', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Andres Serrano (cp-025) ───
  mr('mr-074', 'cp-025', 'p-feb-26', 2000, 0, 2000, 0, 80.00, 0, 0),

  // ─── Rafael Martinez (cp-026) ───
  mr('mr-075', 'cp-026', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Ali Germenos (cp-027) ───
  mr('mr-076', 'cp-027', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Nicolas Raffo (cp-028) — Fixed salary ───
  mr('mr-077', 'cp-028', 'p-oct-25', 0, 0, 0, 0, 0, 0, 2000),
  mr('mr-078', 'cp-028', 'p-nov-25', 0, 0, 0, 0, 0, 0, 2000),
  mr('mr-079', 'cp-028', 'p-dic-25', 0, 0, 0, 0, 0, 0, 2000),
  mr('mr-080', 'cp-028', 'p-jan-26', 0, 0, 0, 0, 0, 0, 2000),
  mr('mr-081', 'cp-028', 'p-feb-26', 0, 0, 0, 0, 0, 0, 2000),

  // ─── Tonny Valencia (cp-029) ───
  mr('mr-082', 'cp-029', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Lynette Cushcagua (cp-030) ───
  mr('mr-083', 'cp-030', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Johana Rangel (cp-031) ───
  mr('mr-084', 'cp-031', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),

  // ─── Stephan Tible (cp-032) — Fixed salary ───
  mr('mr-085', 'cp-032', 'p-oct-25', 0, 0, 0, 0, 0, 0, 1500),
  mr('mr-086', 'cp-032', 'p-nov-25', 0, 0, 0, 0, 0, 0, 1500),
  mr('mr-087', 'cp-032', 'p-dic-25', 0, 0, 0, 0, 0, 0, 1500),
  mr('mr-088', 'cp-032', 'p-jan-26', 0, 0, 0, 0, 0, 0, 1500),
  mr('mr-089', 'cp-032', 'p-feb-26', 0, 0, 0, 0, 0, 0, 1500),

  // ─── Millones693 PNL (cp-033) ───
  mr('mr-090', 'cp-033', 'p-oct-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-091', 'cp-033', 'p-nov-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-092', 'cp-033', 'p-dic-25', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-093', 'cp-033', 'p-jan-26', 0, 0, 0, 0, 0, 0, 0),
  mr('mr-094', 'cp-033', 'p-feb-26', 0, 0, 0, 0, 0, 0, 0),
];

// ─── Role labels ───
export const ROLE_LABELS_HR: Record<string, string> = {
  sales_manager: 'Sales Manager',
  head: 'HEAD',
  bdm: 'BDM',
};

// ─── Helpers ───
export function getProfilesByHead(headId: string): CommercialProfile[] {
  return DEMO_COMMERCIAL_PROFILES.filter(p => p.head_id === headId);
}

export function getMonthlyResults(profileId: string): CommercialMonthlyResult[] {
  return DEMO_MONTHLY_RESULTS.filter(r => r.profile_id === profileId);
}

export function getResultsByPeriod(periodId: string): CommercialMonthlyResult[] {
  return DEMO_MONTHLY_RESULTS.filter(r => r.period_id === periodId);
}

export function getProfileById(id: string): CommercialProfile | undefined {
  return DEMO_COMMERCIAL_PROFILES.find(p => p.id === id);
}

export function getTotalCommissions(profileId: string): number {
  return DEMO_MONTHLY_RESULTS
    .filter(r => r.profile_id === profileId)
    .reduce((sum, r) => sum + r.total_earned, 0);
}
