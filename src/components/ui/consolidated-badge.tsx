'use client';

import { Layers } from 'lucide-react';
import { InfoTip } from '@/components/ui/info-tip';
import { GLOSSARY } from '@/lib/glossary';

// ─────────────────────────────────────────────────────────────────────────────
// ConsolidatedBadge — visible indicator that the page is showing totals for
// multiple periods. Renders nothing when `count < 2` so pages can drop it in
// unconditionally and it disappears in single-period mode.
// ─────────────────────────────────────────────────────────────────────────────

interface ConsolidatedBadgeProps {
  count: number;
  className?: string;
}

export function ConsolidatedBadge({ count, className = '' }: ConsolidatedBadgeProps) {
  if (count < 2) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-100 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900 ${className}`}
    >
      <Layers className="w-3 h-3" />
      Consolidado · {count} meses
      <InfoTip text={GLOSSARY.consolidatedMode} size={10} />
    </span>
  );
}
