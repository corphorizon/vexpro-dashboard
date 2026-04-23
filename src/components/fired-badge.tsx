'use client';

import type { CommercialProfile } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// FiredBadge + firedNameClass
//
// Shared visual indicators for a terminated commercial_profile. The rule is
// consistent across the app (match `/rrhh` tab Empleados UnifiedEmployee
// derivation): a profile is "fired" only when BOTH
//   profile.status === 'inactive'  AND  profile.termination_date != null
// Plain inactive (e.g. leave of absence) does NOT show the badge.
//
// The pair is intentionally cheap: a tiny pill + a className — safe to drop
// anywhere a name is rendered without changing layouts.
// ─────────────────────────────────────────────────────────────────────────────

export function FiredBadge({ profile, className }: { profile: CommercialProfile; className?: string }) {
  const { t } = useI18n();
  const isFired = profile.status === 'inactive' && !!profile.termination_date;
  if (!isFired) return null;

  const categoryKey = profile.termination_category
    ? `hr.category${profile.termination_category.charAt(0).toUpperCase()}${profile.termination_category.slice(1)}`
    : null;

  const tooltip = [
    `${t('hr.firedOn')}: ${profile.termination_date}`,
    categoryKey ? `${t('hr.firedCategoryLabel')}: ${t(categoryKey)}` : null,
    profile.termination_reason ? `${t('hr.firedReasonLabel')}: ${profile.termination_reason}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <span
      title={tooltip}
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium',
        'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400',
        'cursor-help align-middle ml-1.5',
        className,
      )}
    >
      {t('hr.firedBadge')}
    </span>
  );
}

/**
 * Utility: returns a className that styles a name as "struck-through/faded"
 * when the profile is fired. Use alongside <FiredBadge>.
 */
export function firedNameClass(profile: CommercialProfile): string {
  const isFired = profile.status === 'inactive' && !!profile.termination_date;
  return isFired ? 'line-through opacity-60' : '';
}
