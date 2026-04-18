'use client';

import { Info } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// InfoTip — tiny "i" icon that shows a definition on hover/focus.
//
// Uses the native title attribute so it works on touch devices (long-press)
// and is accessible via keyboard focus. Keeps the markup flat — no portal,
// no overlay, no z-index juggling. For longer explanations consider a
// dedicated Popover component.
// ─────────────────────────────────────────────────────────────────────────────

interface InfoTipProps {
  text: string;
  className?: string;
  /** Icon size in pixels (default 12). */
  size?: number;
}

export function InfoTip({ text, className = '', size = 12 }: InfoTipProps) {
  return (
    <span
      tabIndex={0}
      role="img"
      aria-label={text}
      title={text}
      className={`inline-flex items-center justify-center text-muted-foreground hover:text-foreground cursor-help transition-colors ${className}`}
    >
      <Info style={{ width: size, height: size }} />
    </span>
  );
}
