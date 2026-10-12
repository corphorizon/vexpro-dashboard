'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { ClipboardList, RotateCw } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Select } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionButton } from '@/components/payment-orders/action-button';
import {
  AUDIT_PAGE_LIMIT,
  atLimit,
  auditActionKind,
  formatCount,
} from '@/components/superadmin/superadmin-model';

// ─────────────────────────────────────────────────────────────────────────────
// CompanyAuditPanel — used inside /superadmin/companies/[id] to list the
// most recent audit_log entries for that tenant. Superadmin-only surface.
//
// «Libro mayor» (2026-10-12):
//   · Se piden AUDIT_PAGE_LIMIT (200) filas y el endpoint no dice si hay más:
//     con exactamente 200 la lista se veía completa. Ahora el pie lo dice
//     («las 200 más recientes; puede haber más — filtrá») — reglas §1.2.
//   · ACTION_TONE con variantes del Badge legado (export en ámbar como si
//     requiriera acción) → auditActionKind: borrar = bad, crear = info, el
//     resto gris. DataTable dentro de Card → FinTable dentro de Panel.
//   · Error con paleta cruda → Notice con «Reintentar». Filtros con Select.
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
      qs.set('limit', String(AUDIT_PAGE_LIMIT));
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

  const columns: FinColumn<AuditRow>[] = [
    {
      key: 'when',
      header: 'Fecha',
      cell: (r) => (
        <div className="min-w-0 py-1.5 max-[720px]:py-0">
          <div className="whitespace-nowrap text-foreground">{new Date(r.timestamp).toLocaleString('es-ES')}</div>
          <div className="mt-1 hidden flex-wrap items-center gap-1.5 text-[12px] text-text-3 max-[720px]:flex">
            <span>{r.user_name ?? '—'}</span>
            <span>· {r.module ?? '—'}</span>
          </div>
          {r.details && (
            <div className="mt-0.5 hidden truncate text-[12px] text-text-3 max-[720px]:block">{r.details}</div>
          )}
        </div>
      ),
    },
    { key: 'user', header: 'Usuario', hideSm: true, cell: (r) => r.user_name ?? '—' },
    {
      key: 'action',
      header: 'Acción',
      cardSide: 'right',
      cell: (r) => <StatusBadge kind={auditActionKind(r.action)} label={r.action} />,
    },
    { key: 'module', header: 'Módulo', hideSm: true, cell: (r) => <span className="text-text-2">{r.module ?? '—'}</span> },
    {
      key: 'details',
      header: 'Detalle',
      hideSm: true,
      width: '40%',
      cell: (r) => (
        <span className="block max-w-md truncate text-text-2" title={r.details ?? undefined}>
          {r.details ?? ''}
        </span>
      ),
    },
  ];

  const maybeMore = rows ? atLimit(rows.length, AUDIT_PAGE_LIMIT) : false;

  return (
    <Panel
      title="Auditoría"
      hint={rows ? `${formatCount(rows.length)} registros` : undefined}
      flush
      actions={
        <>
          <Select
            aria-label="Filtrar por acción"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="w-auto"
          >
            <option value="all">Todas las acciones</option>
            <option value="create">Create</option>
            <option value="update">Update</option>
            <option value="delete">Delete</option>
            <option value="login">Login</option>
            <option value="logout">Logout</option>
            <option value="export">Export</option>
            <option value="view">View</option>
          </Select>
          <Select
            aria-label="Filtrar por módulo"
            value={moduleFilter}
            onChange={(e) => setModuleFilter(e.target.value)}
            className="w-auto"
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
          </Select>
        </>
      }
      footer={
        maybeMore
          ? `Mostrando los ${formatCount(AUDIT_PAGE_LIMIT)} registros más recientes: puede haber más. Filtrá por acción o módulo para ver el resto.`
          : undefined
      }
    >
      {error && (
        <div className="p-4">
          <Notice
            kind="bad"
            title="No se pudo cargar la auditoría"
            action={
              <ActionButton variant="secondary" onClick={() => void load()}>
                <RotateCw aria-hidden className="size-4" /> Reintentar
              </ActionButton>
            }
          >
            {error}
          </Notice>
        </div>
      )}

      {!error && rows === null && (
        <div className="space-y-2 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      )}

      {rows !== null && !error && (
        <FinTable<AuditRow>
          caption="Registro de auditoría de la entidad"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={
            <EmptyState
              compact
              icon={ClipboardList}
              title="Sin registros de auditoría"
              description="No hay actividad para esta empresa (con los filtros actuales)."
            />
          }
        />
      )}
    </Panel>
  );
}
