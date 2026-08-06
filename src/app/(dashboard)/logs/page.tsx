'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Registro de Actividad — /logs
//
// La instrumentación ya existía (audit_logs se escribe desde login, CRUD,
// exports, sincronizaciones y los endpoints de admin), pero lo único que la
// mostraba era una pestaña dentro del panel de superadmin, limitada a 200
// filas y con dos selectores. Esto es la pantalla propia: filtros
// combinables, paginación real y exportación.
//
// Arranca mostrando HOY (pedido de Kevin: "que empiecen a mostrar desde hoy").
// El histórico sigue estando — basta correr la fecha de inicio hacia atrás.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScrollText, ChevronLeft, ChevronRight, FileDown, RotateCcw, Search,
} from 'lucide-react';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { moduleLabel } from '@/lib/modules';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

interface LogRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  module: string;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}

interface Facets {
  modules: string[];
  actions: string[];
  users: string[];
}

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Los módulos del log NO son los del menú: además de los 16 asignables
// aparecen orígenes técnicos (auth, integrations_sync, api_transactions) y
// claves con sufijo (balances_channel_config). moduleLabel() traduce los que
// conoce; el resto se muestra legible en vez de con guiones bajos.
function prettyModule(key: string): string {
  const known = moduleLabel(key);
  if (known !== key) return known;
  const EXTRA: Record<string, string> = {
    auth: 'Autenticación',
    integrations_sync: 'Sincronización de APIs',
    api_transactions: 'Transacciones API',
    finance: 'Finanzas',
    deposits: 'Depósitos',
    withdrawals: 'Retiros',
    income: 'Ingresos',
    'payment-orders': 'Órdenes de Pago',
    payment_orders: 'Órdenes de Pago',
    channel_ledger: 'Libro por Canal',
    reports_send: 'Envío de Reportes',
    reports_config: 'Configuración de Reportes',
    balances_channel_config: 'Configuración de Canales',
    balances_channel_balance: 'Balance de Canal',
  };
  return EXTRA[key] ?? key.replace(/[_-]/g, ' ');
}

const ACTION_LABELS: Record<string, string> = {
  create: 'Creación',
  update: 'Modificación',
  delete: 'Eliminación',
  login: 'Inicio de sesión',
  logout: 'Cierre de sesión',
  export: 'Exportación',
  view: 'Consulta',
  sync: 'Sincronización',
};

function actionTone(action: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (action === 'create') return 'success';
  if (action === 'delete') return 'danger';
  if (action === 'update') return 'warning';
  return 'neutral';
}

const PAGE_SIZE = 50;

export default function LogsPage() {
  const accessDenied = !useModuleAccess('logs');

  const [from, setFrom] = useState(todayISO);
  const [to, setTo] = useState(todayISO);
  const [moduleKey, setModuleKey] = useState('');
  const [action, setAction] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<Facets>({ modules: [], actions: [], users: [] });
  const [loading, setLoading] = useState(true);

  // Un cambio de filtro tiene que volver a la página 1: si estabas en la 4 y
  // el nuevo filtro devuelve 12 resultados, la 4 sale vacía y parece un bug.
  const resetPage = () => setPage(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from, to, page: String(page), limit: String(PAGE_SIZE) });
      if (moduleKey) qs.set('module', moduleKey);
      if (action) qs.set('action', action);
      if (userFilter) qs.set('user', userFilter);
      if (q.trim()) qs.set('q', q.trim());

      const res = await apiFetch(`/api/admin/audit-log?${qs}`);
      const json = await res.json();
      if (json.success) {
        setRows(json.entries ?? []);
        setTotal(json.total ?? 0);
        setFacets(json.facets ?? { modules: [], actions: [], users: [] });
      }
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [from, to, moduleKey, action, userFilter, q, page]);

  useEffect(() => { void load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetFilters = () => {
    setFrom(todayISO()); setTo(todayISO());
    setModuleKey(''); setAction(''); setUserFilter(''); setQ('');
    setPage(1);
  };

  // El CSV exporta lo que se ve con los filtros actuales, no solo la página:
  // exportar 50 de 900 filas sin decirlo sería engañoso.
  const exportCsv = async () => {
    // Pagina hasta traer TODO lo que matchea los filtros: antes cortaba en
    // 200 filas sin avisar, así que "exportar" 900 registros devolvía 200 y
    // el CSV mentía (auditoría 2026-08-06). Tope de seguridad: 50 páginas
    // (10.000 filas) para no colgar el navegador con un rango descomunal.
    const all: LogRow[] = [];
    for (let p = 1; p <= 50; p++) {
      const qs = new URLSearchParams({ from, to, page: String(p), limit: '200' });
      if (moduleKey) qs.set('module', moduleKey);
      if (action) qs.set('action', action);
      if (userFilter) qs.set('user', userFilter);
      if (q.trim()) qs.set('q', q.trim());

      const res = await apiFetch(`/api/admin/audit-log?${qs}`);
      const json = await res.json();
      const batch: LogRow[] = json.entries ?? [];
      all.push(...batch);
      if (batch.length < 200 || all.length >= (json.total ?? 0)) break;
    }

    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      ['Fecha', 'Usuario', 'Acción', 'Módulo', 'Detalle', 'IP'].map(esc).join(','),
      ...all.map((r) => [
        new Date(r.created_at).toLocaleString(),
        r.user_name ?? '',
        ACTION_LABELS[r.action] ?? r.action,
        prettyModule(r.module),
        r.details ?? '',
        r.ip_address ?? '',
      ].map(esc).join(',')),
    ].join('\n');

    // BOM para que Excel abra las tildes bien.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `registro-actividad_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selectCls = 'h-9 rounded-lg border border-border bg-card px-3 text-base sm:text-sm';

  const summary = useMemo(() => {
    if (loading) return '…';
    if (total === 0) return 'Sin registros';
    const desde = (page - 1) * PAGE_SIZE + 1;
    const hasta = Math.min(page * PAGE_SIZE, total);
    return `${desde}–${hasta} de ${total}`;
  }, [loading, total, page]);

  if (accessDenied) {
    return (
      <EmptyState
        icon={ScrollText}
        title="403 · Acceso restringido"
        description="No tenés acceso al registro de actividad."
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Registro de Actividad"
        subtitle="Quién hizo qué, cuándo y desde dónde"
        icon={ScrollText}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={resetFilters}>
              <RotateCcw className="w-4 h-4" /> Hoy
            </Button>
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={total === 0}>
              <FileDown className="w-4 h-4" /> CSV
            </Button>
          </div>
        }
      />

      {/* Filtros */}
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Desde</span>
            <input type="date" value={from} className={selectCls}
              onChange={(e) => { setFrom(e.target.value); resetPage(); }} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Hasta</span>
            <input type="date" value={to} className={selectCls}
              onChange={(e) => { setTo(e.target.value); resetPage(); }} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Módulo</span>
            <select value={moduleKey} className={selectCls}
              onChange={(e) => { setModuleKey(e.target.value); resetPage(); }}>
              <option value="">Todos</option>
              {facets.modules.map((m) => (
                <option key={m} value={m}>{prettyModule(m)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Acción</span>
            <select value={action} className={selectCls}
              onChange={(e) => { setAction(e.target.value); resetPage(); }}>
              <option value="">Todas</option>
              {facets.actions.map((a) => (
                <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Usuario</span>
            <select value={userFilter} className={selectCls}
              onChange={(e) => { setUserFilter(e.target.value); resetPage(); }}>
              <option value="">Todos</option>
              {facets.users.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Buscar en el detalle</span>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                value={q}
                placeholder="OP-2026-0007, monto…"
                className={`${selectCls} w-full pl-8`}
                onChange={(e) => { setQ(e.target.value); resetPage(); }}
              />
            </div>
          </label>
        </div>
      </Card>

      {/* Tabla */}
      <Card className="p-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-xs text-muted-foreground tabular-nums">{summary}</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Página anterior"
              disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums px-1">
              {page} / {totalPages}
            </span>
            <Button variant="ghost" size="icon" aria-label="Página siguiente"
              disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-medium whitespace-nowrap">Fecha</th>
                <th className="px-4 py-3 font-medium">Usuario</th>
                <th className="px-4 py-3 font-medium">Acción</th>
                <th className="px-4 py-3 font-medium">Módulo</th>
                <th className="px-4 py-3 font-medium">Detalle</th>
                <th className="px-4 py-3 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">…</td></tr>
              )}

              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-0">
                    <EmptyState
                      icon={ScrollText}
                      title="Sin actividad"
                      description="No hay registros con estos filtros. Probá ampliando el rango de fechas."
                    />
                  </td>
                </tr>
              )}

              {!loading && rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40 align-top">
                  <td className="px-4 py-3 whitespace-nowrap tabular-nums text-muted-foreground">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{r.user_name ?? '—'}</td>
                  <td className="px-4 py-3">
                    <Badge variant={actionTone(r.action)}>
                      {ACTION_LABELS[r.action] ?? r.action}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{prettyModule(r.module)}</td>
                  {/* break-words: los detalles traen JSON serializado sin
                      espacios y desbordan la celda si se rompe por palabra. */}
                  <td className="px-4 py-3 max-w-md break-words text-muted-foreground">
                    {r.details ?? '—'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground tabular-nums">
                    {r.ip_address ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
