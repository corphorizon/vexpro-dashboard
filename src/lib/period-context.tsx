'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useData } from './data-context';

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
  const { periods, loading } = useData();
  const defaultPeriod = periods.length > 0 ? periods[periods.length - 1].id : '';
  const [mode, setMode] = useState<ViewMode>('single');
  const [selectedPeriodId, setSelectedPeriodIdState] = useState(defaultPeriod);
  const [selectedPeriodIds, setSelectedPeriodIds] = useState<string[]>([defaultPeriod]);
  const [consolidationLabel, setConsolidationLabel] = useState<string | null>(null);

  // Update default period when periods load from Supabase
  useEffect(() => {
    if (!loading && periods.length > 0 && !selectedPeriodId) {
      const lastPeriod = periods[periods.length - 1].id;
      setSelectedPeriodIdState(lastPeriod);
      setSelectedPeriodIds([lastPeriod]);
    }
  }, [loading, periods, selectedPeriodId]);

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
