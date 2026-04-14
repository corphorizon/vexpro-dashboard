import type { CommercialProfile, CommercialMonthlyResult, Period } from '@/lib/types';

// ---------------------------------------------------------------------------
// Rounding helper — avoid float precision issues in monetary calculations
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Commission calculation result for a single user in a single period
// ---------------------------------------------------------------------------

export interface CommissionCalcResult {
  profileId: string;
  netDepositCurrent: number;
  accumulatedIn: number;
  division: number;
  base: number;
  commissionPct: number;
  commission: number;
  realPayment: number;
  accumulatedOut: number;
  salary: number;
}

// ---------------------------------------------------------------------------
// Core calculation — implements the corrected accumulation formula
//
// division = net_deposit_current / 2
// base = division + accumulated_in
// commission = base * (percentage / 100)
// real_payment = MAX(0, commission)
// accumulated_out:
//   if commission >= 0 → division (carry only division forward)
//   if commission < 0  → base    (carry full negative base forward)
// ---------------------------------------------------------------------------

export function calculateCommission(
  netDepositCurrent: number,
  accumulatedIn: number,
  commissionPct: number,
): Omit<CommissionCalcResult, 'profileId' | 'salary' | 'commissionPct'> {
  // Only calculate if there's actual ND data for this month (0 = no data entered)
  if (netDepositCurrent === 0) {
    return { netDepositCurrent: 0, accumulatedIn, division: 0, base: 0, commission: 0, realPayment: 0, accumulatedOut: accumulatedIn };
  }
  // Negative ND is allowed — represents net withdrawals

  const division = round2(netDepositCurrent / 2);
  const base = round2(division + accumulatedIn);
  const commission = round2(base * (commissionPct / 100));
  const realPayment = round2(commission); // Real payment includes negatives — they affect the total
  // If commission >= 0: debt is settled, only carry forward the division (half of new ND)
  // If commission < 0: debt persists, carry forward the full base (negative accumulates until compensated)
  const accumulatedOut = round2(commission >= 0 ? division : base);

  return {
    netDepositCurrent,
    accumulatedIn,
    division,
    base,
    commission,
    realPayment,
    accumulatedOut,
  };
}

// ---------------------------------------------------------------------------
// Calculate commissions for an entire HEAD group in a single period
// ---------------------------------------------------------------------------

export function calculateGroupCommissions(
  profiles: CommercialProfile[],
  ndInputs: Map<string, number>,
  accumulatedIns: Map<string, number>,
): CommissionCalcResult[] {
  return profiles.map((profile) => {
    const ndCurrent = ndInputs.get(profile.id) ?? 0;
    const accIn = accumulatedIns.get(profile.id) ?? 0;
    const pct = profile.net_deposit_pct ?? 0;

    const calc = calculateCommission(ndCurrent, accIn, pct);

    return {
      profileId: profile.id,
      commissionPct: pct,
      salary: profile.salary ?? 0,
      ...calc,
    };
  });
}

// ---------------------------------------------------------------------------
// Get accumulated_in for a profile from the previous period's results
// ---------------------------------------------------------------------------

export function getAccumulatedIn(
  previousResults: CommercialMonthlyResult[],
  profileId: string,
): number {
  const prev = previousResults.find((r) => r.profile_id === profileId);
  return prev?.accumulated_out ?? 0;
}

// ---------------------------------------------------------------------------
// Get the previous period in chronological order
// ---------------------------------------------------------------------------

export function getPreviousPeriod(
  periods: Period[],
  currentPeriodId: string,
): Period | null {
  const sorted = [...periods].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  const idx = sorted.findIndex((p) => p.id === currentPeriodId);
  return idx > 0 ? sorted[idx - 1] : null;
}

// ---------------------------------------------------------------------------
// Automatic salary calculation based on team total Net Deposit
//
// BDM salary tiers (based on individual ND):
//   ND >= $200,000 → $2,000 USD
//   ND >= $100,000 → $1,000 USD
//   ND >=  $50,000 →   $500 USD
//   ND <   $50,000 →     $0 USD
//
// HEAD / Sales Manager salary tiers (based on full team ND):
//   ND total >= $500,000 → $5,000 USD
//   ND total >= $400,000 → $4,000 USD
//   ND total >= $300,000 → $3,000 USD
//   ND total >= $200,000 → $2,000 USD
//   ND total >= $100,000 → $1,000 USD
//   ND total <  $100,000 →     $0 USD
// ---------------------------------------------------------------------------

export interface SalaryTier {
  minND: number;
  salary: number;
}

// BDM tiers — individual ND
export const SALARY_TIERS: SalaryTier[] = [
  { minND: 200_000, salary: 2_000 },
  { minND: 100_000, salary: 1_000 },
  { minND: 50_000, salary: 500 },
];

// HEAD / Sales Manager tiers — team total ND
export const HEAD_SALARY_TIERS: SalaryTier[] = [
  { minND: 500_000, salary: 5_000 },
  { minND: 400_000, salary: 4_000 },
  { minND: 300_000, salary: 3_000 },
  { minND: 200_000, salary: 2_000 },
  { minND: 100_000, salary: 1_000 },
];

/** BDM salary based on individual ND */
export function calculateSalaryFromND(individualND: number): number {
  if (individualND < 0) return 0;
  const absND = Math.abs(individualND);
  for (const tier of SALARY_TIERS) {
    if (absND >= tier.minND) return tier.salary;
  }
  return 0;
}

/** HEAD / Sales Manager salary based on team total ND */
export function calculateHeadSalaryFromND(teamTotalND: number): number {
  if (teamTotalND < 0) return 0;
  const absND = Math.abs(teamTotalND);
  for (const tier of HEAD_SALARY_TIERS) {
    if (absND >= tier.minND) return tier.salary;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// BDM commission percentage tiers — based on individual ND
//
//   ND >= $200,000 → 6%
//   ND >= $100,000 → 5%
//   ND >=  $50,000 → 4%
//   ND <   $50,000 → 0% (profile default)
// ---------------------------------------------------------------------------

export interface PctTier {
  minND: number;
  pct: number;
}

export const BDM_PCT_TIERS: PctTier[] = [
  { minND: 200_000, pct: 6 },
  { minND: 100_000, pct: 5 },
  { minND: 50_000, pct: 4 },
];

/** BDM commission percentage based on individual ND.
 *  If ND < $50,000, returns null so the caller can fall back to the profile default. */
export function calculateBdmPctFromND(individualND: number, profilePct?: number): number {
  if (individualND >= 0) {
    for (const tier of BDM_PCT_TIERS) {
      if (individualND >= tier.minND) return tier.pct;
    }
  }
  // Below all tiers or negative ND — use the profile's configured percentage
  return profilePct ?? 0;
}

// ---------------------------------------------------------------------------
// HEAD differential calculation
//
// When a HEAD has BDMs, the HEAD earns the DIFFERENTIAL percentage on each
// BDM's ND, using the same formula (ND/2 + accumulated × diff%).
//
// diff_pct = (head_pct - bdm_pct) + extra_pct
//
// Example: HEAD 7%, BDM 4%, extra 0% → diff = 3%
// Example: HEAD 4%, BDM 4%, extra 1% → diff = 1%
// ---------------------------------------------------------------------------

export interface DifferentialDetail {
  bdmProfileId: string;
  bdmName: string;
  bdmNd: number;
  bdmPct: number;
  diffPct: number;
  division: number;
  base: number;
  commission: number;
  realPayment: number;
}

export interface HeadDifferentialResult {
  totalDifferential: number;
  totalRealPayment: number;
  details: DifferentialDetail[];
}

export function calculateHeadDifferential(
  headPct: number,
  extraPct: number,
  bdmResults: { profileId: string; name: string; netDepositCurrent: number; accumulatedIn: number; commissionPct: number }[],
): HeadDifferentialResult {
  const details: DifferentialDetail[] = bdmResults.map((bdm) => {
    const diffPct = (headPct - bdm.commissionPct) + extraPct;
    const division = round2(bdm.netDepositCurrent / 2);
    const base = round2(division + bdm.accumulatedIn);
    const commission = round2(base * (diffPct / 100));
    const realPayment = round2(Math.max(0, commission));

    return {
      bdmProfileId: bdm.profileId,
      bdmName: bdm.name,
      bdmNd: bdm.netDepositCurrent,
      bdmPct: bdm.commissionPct,
      diffPct,
      division,
      base,
      commission,
      realPayment,
    };
  });

  const totalDifferential = round2(details.reduce((sum, d) => sum + d.commission, 0));
  const totalRealPayment = round2(details.reduce((sum, d) => sum + d.realPayment, 0));

  return { totalDifferential, totalRealPayment, details };
}

// ---------------------------------------------------------------------------
// Group summary totals
// ---------------------------------------------------------------------------

export interface GroupSummary {
  totalRealPayment: number;
  totalSalary: number;
  totalWithSalary: number;
  totalCommission: number;
}

export function calculateGroupSummary(
  results: CommissionCalcResult[],
): GroupSummary {
  const totalRealPayment = round2(results.reduce((sum, r) => sum + r.realPayment, 0));
  const totalSalary = round2(results.reduce((sum, r) => sum + r.salary, 0));
  const totalCommission = round2(results.reduce((sum, r) => sum + r.commission, 0));

  return {
    totalRealPayment,
    totalSalary,
    totalWithSalary: round2(totalRealPayment + totalSalary),
    totalCommission,
  };
}
