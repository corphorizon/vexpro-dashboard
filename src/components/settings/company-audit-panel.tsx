'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, ClipboardList } from 'lucide-react';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';

// ─────────────────────────────────────────────────────────────────────────────
// CompanyAuditPanel — used inside /superadmin/companies/[id] to list the
// most recent audit_log entries for that tenant. Superadmin-only surface.
// ─────────────────────────────────────────────────────────────────────────────

interface AuditRow {
  id: string;
  timestamp: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  module: string | null;
  details: string | null;
}

// Maps audit action → Badge variant. Badge only supports the 4 built-ins;
// 'neutral' covers the rest.
const ACTION_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  create: 'success',
  update: 'neutral',
  delete: 'danger',
  login: 'neutral',
  logout: 'neutral',
  export: 'warning',
  view: 'neutral',
};

export function CompanyAuditPanel({ companyId }: { companyId: string }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [moduleFilter, setModuleFilter] = useState<string>('all');

  const load = useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      const qs = new URLSearchParams();
      qs.set('limit', '200');
      if (actionFilter !== 'all') qs.set('action', actionFilter);
      if (moduleFilter !== 'all') qs.set('module', moduleFilter);
      const res = await apiFetch(`/api/superadmin/companies/${companyId}/audit-logs?${qs}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setRows(json.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando auditoría');
    }
  }, [companyId, actionFilter, moduleFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="h-9 px-3 rounded-lg border border-border bg-card text-sm"
        >
          <option value="all">Todas las acciones</option>
          <option value="create">Create</option>
          <option value="update">Update</option>
          <option value="delete">Delete</option>
          <option value="login">Login</option>
          <option value="logout">Logout</option>
          <option value="export">Export</option>
          <option value="view">View</option>
        </select>
        <select
          value={moduleFilter}
          onChange={(e) => setModuleFilter(e.target.value)}
          className="h-9 px-3 rounded-lg border border-border bg-card text-sm"
        >
          <option value="all">Todos los módulos</option>
          <option value="auth">Auth</option>
          <option value="deposits">Depósitos</option>
          <option value="withdrawals">Retiros</option>
          <option value="expenses">Egresos</option>
          <option value="income">Ingresos</option>
          <option value="liquidity">Liquidez</option>
          <option value="investments">Inversiones</option>
          <option value="partners">Socios</option>
          <option value="hr">RRHH</option>
          <option value="users">Usuarios</option>
          <option value="periods">Períodos</option>
        </select>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-negative/10 dark:border-red-800 text-red-800 dark:text-red-200 p-3 text-sm">
          {error}
        </div>
      )}

      {!error && rows === null && (
        <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          Cargando…
        </div>
      )}

      {rows !== null && !error && (
        <Card className="p-0 overflow-hidden">
          <DataTable<AuditRow>
            data={rows}
            density="compact"
            empty={
              <EmptyState
                compact
                icon={ClipboardList}
                title="Sin registros de auditoría"
                description="No hay actividad para esta empresa (con los filtros actuales)."
              />
            }
            columns={[
              {
                header: 'Fecha',
                accessor: (r) => (
                  <span className="text-xs whitespace-nowrap">
                    {new Date(r.timestamp).toLocaleString('es-ES')}
                  </span>
                ),
              },
              {
                header: 'Usuario',
                accessor: (r) => <span className="text-xs">{r.user_name ?? '—'}</span>,
              },
              {
                header: 'Acción',
                accessor: (r) => <Badge variant={variantFor(r.action)}>{r.action}</Badge>,
              },
              {
                header: 'Módulo',
                accessor: (r) => <span className="text-xs text-muted-foreground">{r.module ?? '—'}</span>,
              },
              {
                header: 'Detalle',
                className: 'max-w-md truncate',
                accessor: (r) => <span className="text-xs text-muted-foreground">{r.details ?? ''}</span>,
              },
            ]}
          />
        </Card>
      )}
    </div>
  );
}

function variantFor(action: string): 'neutral' | 'success' | 'warning' | 'danger' {
  return ACTION_TONE[action] ?? 'neutral';
}
