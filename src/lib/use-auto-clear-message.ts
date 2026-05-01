// ─────────────────────────────────────────────────────────────────────────────
// useAutoClearMessage
//
// Tiny state hook for the success/error toast pattern that several admin pages
// implement by hand: hold a message string, auto-clear after a deadline,
// override the previous timer if a new message comes in.
//
// Why a hook: every inline implementation we had (periodos, egresos, socios,
// and a few others) leaked `setTimeout` handles on unmount and clobbered the
// new message when one arrived during the previous decay window. Same body
// rewritten 3 times. This consolidates the lifecycle.
//
// Usage:
//   const [msg, showMsg] = useAutoClearMessage();
//   showMsg('Guardado correctamente'); // default 3000 ms
//   showMsg('Error', 5000);            // custom duration
//   showMsg('');                       // explicit clear
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';

export type ShowFn = (message: string, durationMs?: number) => void;

export function useAutoClearMessage(defaultMs = 3000): [string, ShowFn] {
  const [msg, setMsg] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Track mount so we don't setState after the parent unmounts (prevents the
  // React 18 dev-time warning that periodically spammed our console).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const show: ShowFn = useCallback((message: string, durationMs?: number) => {
    if (!mountedRef.current) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setMsg(message);
    // Empty-string call = explicit clear. No timer scheduled.
    if (!message) return;
    const ms = durationMs ?? defaultMs;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (mountedRef.current) setMsg('');
    }, ms);
  }, [defaultMs]);

  return [msg, show];
}
