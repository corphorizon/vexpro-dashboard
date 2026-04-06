'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { DEMO_PERIODS } from './demo-data';

type ViewMode = 'single' | 'consolidated';

interface PeriodState {
  mode: ViewMode;
  selectedPeriodId: string;
  selectedPeriodIds: string[];
  consolidationLabel: string | null;
  setSelectedPeriod: (id: string) => void;
  setConsolidated: (ids: string[], label?: string) => void;
  setSingleMode: () => void;
}

const PeriodContext = createContext<PeriodState | null>(null);

export function PeriodProvider({ children }: { children: ReactNode }) {
  const defaultPeriod = DEMO_PERIODS[DEMO_PERIODS.length - 1].id;
  const [mode, setMode] = useState<ViewMode>('single');
  const [selectedPeriodId, setSelectedPeriodIdState] = useState(defaultPeriod);
  const [selectedPeriodIds, setSelectedPeriodIds] = useState<string[]>([defaultPeriod]);
  const [consolidationLabel, setConsolidationLabel] = useState<string | null>(null);

  const setSelectedPeriod = useCallback((id: string) => {
    setMode('single');
    setSelectedPeriodIdState(id);
    setSelectedPeriodIds([id]);
    setConsolidationLabel(null);
  }, []);

  const setConsolidated = useCallback((ids: string[], label?: string) => {
    setMode('consolidated');
    setSelectedPeriodIds(ids);
    setSelectedPeriodIdState(ids[ids.length - 1] || defaultPeriod);
    setConsolidationLabel(label || null);
  }, [defaultPeriod]);

  const setSingleMode = useCallback(() => {
    setMode('single');
    setSelectedPeriodIds([selectedPeriodId]);
    setConsolidationLabel(null);
  }, [selectedPeriodId]);

  return (
    <PeriodContext.Provider value={{
      mode, selectedPeriodId, selectedPeriodIds, consolidationLabel,
      setSelectedPeriod, setConsolidated, setSingleMode,
    }}>
      {children}
    </PeriodContext.Provider>
  );
}

export function usePeriod() {
  const ctx = useContext(PeriodContext);
  if (!ctx) throw new Error('usePeriod must be used within PeriodProvider');
  return ctx;
}
