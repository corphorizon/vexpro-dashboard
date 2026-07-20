'use client';

import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { EmptyState } from '@/components/ui/empty-state';
import { ShieldCheck } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Chart de revisiones Prop Firm por mes, apiladas por veredicto.
// Fuente: /api/risk/revisions (el mismo historial que usa /risk/retiros-propfirm).
// Colores semánticos: aprobada=positive, en revisión=warning, rechazada=negative.
// ─────────────────────────────────────────────────────────────────────────────

export interface RevisionSummary {
  savedAt: string; // ISO datetime
  verdict: 'approved' | 'rejected' | 'review' | null;
}

const MONTHS_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

export function RiskRevisionsChart({ revisions, maxMonths = 8 }: { revisions: RevisionSummary[]; maxMonths?: number }) {
  const data = useMemo(() => {
    const byMonth = new Map<string, { Aprobadas: number; 'En revisión': number; Rechazadas: number }>();
    for (const r of revisions) {
      const d = new Date(r.savedAt);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const bucket = byMonth.get(key) ?? { Aprobadas: 0, 'En revisión': 0, Rechazadas: 0 };
      if (r.verdict === 'approved') bucket.Aprobadas += 1;
      else if (r.verdict === 'rejected') bucket.Rechazadas += 1;
      else bucket['En revisión'] += 1;
      byMonth.set(key, bucket);
    }
    return [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-maxMonths)
      .map(([key, counts]) => {
        const [y, m] = key.split('-');
        return { name: `${MONTHS_ES[Number(m) - 1]} ${y.slice(2)}`, ...counts };
      });
  }, [revisions, maxMonths]);

  if (data.length === 0) {
    return (
      <EmptyState
        compact
        icon={ShieldCheck}
        title="Sin revisiones guardadas"
        description="Analizá retiros Prop Firm y guardá la revisión para ver la evolución mensual acá."
      />
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          width={36}
        />
        <Tooltip
          contentStyle={{
            borderRadius: '8px',
            border: '1px solid var(--border)',
            backgroundColor: 'var(--card)',
            color: 'var(--foreground)',
            fontSize: '12px',
            boxShadow: 'var(--elevation-2)',
          }}
          cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
        />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        <Bar dataKey="Aprobadas" stackId="rev" fill="var(--positive)" />
        <Bar dataKey="En revisión" stackId="rev" fill="var(--warning)" />
        <Bar dataKey="Rechazadas" stackId="rev" fill="var(--negative)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
