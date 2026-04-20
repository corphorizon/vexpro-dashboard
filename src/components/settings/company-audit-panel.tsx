'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, ClipboardList } from 'lucide-react';

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
      const res = await fetch(`/api/superadmin/companies/${companyId}/audit-logs?${qs}`);
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
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800 text-red-800 dark:text-red-200 p-3 text-sm">
          {error}
        </div>
      )}

      {!error && rows === null && (
        <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          Cargando…
        </div>
      )}

      {rows !== null && rows.length === 0 && !error && (
        <Card className="text-center py-8 text-sm text-muted-foreground">
          <ClipboardList className="w-6 h-6 mx-auto mb-2 text-muted-foreground/60" />
          Sin registros de auditoría para esta empresa (con los filtros actuales).
        </Card>
      )}

      {rows !== null && rows.length > 0 && (
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Fecha</th>
                  <th className="text-left px-3 py-2 font-medium">Usuario</th>
                  <th className="text-left px-3 py-2 font-medium">Acción</th>
                  <th className="text-left px-3 py-2 font-medium">Módulo</th>
                  <th className="text-left px-3 py-2 font-medium">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border hover:bg-muted/30">
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {new Date(r.timestamp).toLocaleString('es-ES')}
                    </td>
                    <td className="px-3 py-2 text-xs">{r.user_name ?? '—'}</td>
                    <td className="px-3 py-2">
                      <Badge variant={variantFor(r.action)}>{r.action}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.module ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground max-w-md truncate">{r.details ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function variantFor(action: string): 'neutral' | 'success' | 'warning' | 'danger' {
  return ACTION_TONE[action] ?? 'neutral';
}
