'use client';

import { todayUtcISO } from '@/lib/dates';
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
//
// «Libro mayor» (2026-10-12): Panel de filtros con Field/Input/Select
// (borde `control-border` 3:1, label siempre visible), tabla FinTable (en
// < 720 px cada registro es una tarjeta: usuario + fecha a la izquierda,
// acción a la derecha, detalle debajo; sin scroll horizontal de página) y
// botones ActionButton. Lo que NO es visual, y por qué se tocó:
//   · Carga fallida ≠ «sin actividad». Antes un 500 o `success: false`
//     dejaba la tabla vacía con «Ningún registro coincide» — el auditor leía
//     «nadie hizo nada» cuando no sabíamos. Ahora: Notice `bad` + Reintentar,
//     y la tabla dice que la carga falló (logs-view.ts, con test).
//   · El CSV ya no se descarga PARCIAL en silencio: si una página falla a
//     mitad del export no se genera nada y se avisa; si se llega al tope de
//     10.000 filas, se descarga y se dice «N de M».
//   · La paginación se cuenta en el pie del panel: «Mostrando 1–50 de 900 ·
//     página 1 de 18» (un listado paginado es un recorte; reglas §1.2).
// Mismos endpoints, mismos parámetros y mismo tamaño de página que antes.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollText, ChevronLeft, ChevronRight, FileDown, RotateCcw } from 'lucide-react';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { moduleLabel } from '@/lib/modules';
import { useI18n } from '@/lib/i18n';
import { MONEY_LOCALE } from '@/lib/money';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { Field, Input, Select } from '@/components/ui/field';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { ActionButton, ROW_ACTION_CLASS } from '@/components/payment-orders/action-button';
import { ModuleForbidden } from '@/components/module-route-guard';
import {
  EXPORT_BATCH,
  EXPORT_MAX_PAGES,
  LOGS_PAGE_SIZE,
  auditActionKind,
  exportOutcome,
  pageRange,
  parseAuditLogResponse,
  totalPages as countPages,
  type ExportOutcome,
} from './logs-view';

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

// «Hoy» en UTC, como los created_at contra los que filtra — era una copia
// local con el día del navegador (misma familia del bug de Balances/órdenes:
// desde UTC−5 el filtro "hoy" no encontraba los registros de la noche).
// El registro canónico vive en lib/dates.ts.
const todayISO = todayUtcISO;

// Los módulos del log NO son los del menú: además de los 16 asignables
// aparecen orígenes técnicos (auth, integrations_sync, api_transactions) y
// claves con sufijo (balances_channel_config). moduleLabel() traduce los que
// conoce; el resto se muestra legible en vez de con guiones bajos.
const MODULE_EXTRA_KEYS: Record<string, string> = {
  auth: 'logs.module.auth',
  integrations_sync: 'logs.module.integrationsSync',
  api_transactions: 'logs.module.apiTransactions',
  finance: 'logs.module.finance',
  deposits: 'logs.module.deposits',
  withdrawals: 'logs.module.withdrawals',
  income: 'logs.module.income',
  'payment-orders': 'logs.module.paymentOrders',
  payment_orders: 'logs.module.paymentOrders',
  channel_ledger: 'logs.module.channelLedger',
  reports_send: 'logs.module.reportsSend',
  reports_config: 'logs.module.reportsConfig',
  balances_channel_config: 'logs.module.channelConfig',
  balances_channel_balance: 'logs.module.channelBalance',
  balances_business_units: 'logs.module.businessUnits',
  balances_location_units: 'logs.module.locationUnits',
};

const ACTION_KEYS: Record<string, string> = {
  create: 'logs.action.create',
  update: 'logs.action.update',
  delete: 'logs.action.delete',
  login: 'logs.action.login',
  logout: 'logs.action.logout',
  export: 'logs.action.export',
  view: 'logs.action.view',
  sync: 'logs.action.sync',
};

const EMPTY_FACETS: Facets = { modules: [], actions: [], users: [] };

type LoadState = 'loading' | 'ok' | 'error';

export default function LogsPage() {
  const accessDenied = !useModuleAccess('logs');
  const { t, locale } = useI18n();

  const [from, setFrom] = useState(todayISO);
  const [to, setTo] = useState(todayISO);
  const [moduleKey, setModuleKey] = useState('');
  const [action, setAction] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  // Resultado de la ÚLTIMA respuesta, con la clave del pedido que la generó.
  // Si la clave no es la del pedido actual, estamos cargando: así no hace
  // falta un setState síncrono al empezar, y una respuesta vieja (filtro
  // anterior) nunca pisa a la nueva.
  const [result, setResult] = useState<{
    key: string;
    status: 'ok' | 'error';
    rows: LogRow[];
    /** null = no sabemos (la carga falló). Nunca 0 por defecto. */
    total: number | null;
  } | null>(null);
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [reloadTick, setReloadTick] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportOutcome | null>(null);

  const countFmt = useMemo(() => new Intl.NumberFormat(MONEY_LOCALE, { maximumFractionDigits: 0 }), []);
  const n = useCallback((v: number) => countFmt.format(v), [countFmt]);

  const prettyModule = useCallback((key: string): string => {
    const known = moduleLabel(key, locale);
    if (known !== key) return known;
    const extra = MODULE_EXTRA_KEYS[key];
    return extra ? t(extra) : key.replace(/[_-]/g, ' ');
  }, [t, locale]);

  const actionLabel = useCallback(
    (a: string): string => (ACTION_KEYS[a] ? t(ACTION_KEYS[a]) : a),
    [t],
  );

  // Un cambio de filtro tiene que volver a la página 1: si estabas en la 4 y
  // el nuevo filtro devuelve 12 resultados, la 4 sale vacía y parece un bug.
  const resetPage = () => setPage(1);

  const buildQs = useCallback((p: number, limit: number) => {
    const qs = new URLSearchParams({ from, to, page: String(p), limit: String(limit) });
    if (moduleKey) qs.set('module', moduleKey);
    if (action) qs.set('action', action);
    if (userFilter) qs.set('user', userFilter);
    if (q.trim()) qs.set('q', q.trim());
    return qs;
  }, [from, to, moduleKey, action, userFilter, q]);

  const qsStr = buildQs(page, LOGS_PAGE_SIZE).toString();
  // reloadTick: el botón «Reintentar» vuelve a pedir la misma página.
  const reqKey = `${qsStr}#${reloadTick}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: NonNullable<typeof result>;
      try {
        const res = await apiFetch(`/api/admin/audit-log?${qsStr}`);
        const json = await res.json().catch(() => null);
        const parsed = parseAuditLogResponse<LogRow>(res.ok, json);
        if (parsed) {
          next = { key: reqKey, status: 'ok', rows: parsed.entries, total: parsed.total };
          if (!cancelled) setFacets(parsed.facets);
        } else {
          next = { key: reqKey, status: 'error', rows: [], total: null };
        }
      } catch {
        next = { key: reqKey, status: 'error', rows: [], total: null };
      }
      if (!cancelled) setResult(next);
    })();
    return () => { cancelled = true; };
  }, [qsStr, reqKey]);

  const current = result?.key === reqKey ? result : null;
  const loadState: LoadState = current ? current.status : 'loading';
  const rows = current?.rows ?? [];
  const total = current ? current.total : null;

  const pages = countPages(total ?? 0);

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
    // 2026-10-12: una página que falla ya no corta el bucle con un CSV
    // parcial con cara de completo (`json.entries ?? []` daba un lote
    // vacío): ahora no se descarga y se avisa. El tope se avisa con N de M.
    setExporting(true);
    setExportResult(null);
    const all: LogRow[] = [];
    let fullTotal: number | null = null;
    let failed = false;
    try {
      for (let p = 1; p <= EXPORT_MAX_PAGES; p++) {
        const res = await apiFetch(`/api/admin/audit-log?${buildQs(p, EXPORT_BATCH)}`);
        const json = await res.json().catch(() => null);
        const parsed = parseAuditLogResponse<LogRow>(res.ok, json);
        if (!parsed) { failed = true; break; }
        fullTotal = parsed.total;
        all.push(...parsed.entries);
        if (parsed.entries.length < EXPORT_BATCH || all.length >= parsed.total) break;
      }
    } catch {
      failed = true;
    }

    const outcome = exportOutcome(all.length, fullTotal, failed);
    setExportResult(outcome);
    setExporting(false);
    if (outcome.kind === 'failed') return;

    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      [
        t('common.date'), t('logs.colUser'), t('logs.colAction'),
        t('logs.colModule'), t('logs.colDetails'), t('logs.colIp'),
      ].map(esc).join(','),
      ...all.map((r) => [
        new Date(r.created_at).toLocaleString(),
        r.user_name ?? '',
        actionLabel(r.action),
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
    a.download = `${t('logs.csvFilename')}_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const range = loadState === 'ok' && total != null ? pageRange(page, total) : null;

  const hint = useMemo(() => {
    if (loadState === 'loading') return t('common.loading');
    if (loadState === 'error' || total == null) return '—';
    if (total === 0) return t('logs.noRecords');
    return t('lmAdm.logs.records', { n: n(total) });
  }, [loadState, total, t, n]);

  const footer = useMemo(() => {
    if (loadState !== 'ok' || total == null || total === 0 || !range) return undefined;
    if (pages === 1) return t('lmAdm.logs.footerAll', { total: n(total) });
    return t('lmAdm.logs.footerPaged', {
      from: n(range.from), to: n(range.to), total: n(total),
      page: n(page), pages: n(pages),
    });
  }, [loadState, total, range, pages, page, t, n]);

  const columns: FinColumn<LogRow>[] = [
    {
      key: 'date',
      header: t('common.date'),
      hideSm: true,
      width: '170px',
      cell: (r) => (
        <span className="whitespace-nowrap tabular-nums text-text-2">{new Date(r.created_at).toLocaleString()}</span>
      ),
    },
    {
      key: 'user',
      header: t('logs.colUser'),
      cell: (r) => r.user_name ?? '—',
      // En tarjeta, la fecha y el módulo (columnas ocultas) van bajo el nombre.
      mobileMeta: (r) => (
        <>
          <span className="tabular-nums">{new Date(r.created_at).toLocaleString()}</span>
          <span aria-hidden>·</span>
          <span>{prettyModule(r.module)}</span>
        </>
      ),
    },
    {
      key: 'action',
      header: t('logs.colAction'),
      cardSide: 'right',
      cell: (r) => <StatusBadge kind={auditActionKind(r.action)} label={actionLabel(r.action)} />,
    },
    {
      key: 'module',
      header: t('logs.colModule'),
      hideSm: true,
      cell: (r) => <span className="whitespace-nowrap">{prettyModule(r.module)}</span>,
    },
    {
      key: 'details',
      header: t('logs.colDetails'),
      // break-words / anywhere: los detalles traen JSON serializado sin
      // espacios y desbordan la celda (y en móvil, la página) si se rompe
      // por palabra.
      cell: (r) => (
        <span className="block max-w-md py-1.5 text-text-2 [overflow-wrap:anywhere] max-[720px]:max-w-none max-[720px]:py-0 max-[720px]:text-[12.5px]">
          {r.details ?? '—'}
        </span>
      ),
    },
    {
      key: 'ip',
      header: t('logs.colIp'),
      hideSm: true,
      cell: (r) => <span className="whitespace-nowrap tabular-nums text-text-3">{r.ip_address ?? '—'}</span>,
    },
  ];

  if (accessDenied) {
    return <ModuleForbidden moduleKey="logs" />;
  }

  const busy = loadState === 'loading';

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('nav.logs')}
        subtitle={t('logs.subtitle')}
        icon={ScrollText}
        actions={
          <>
            <ActionButton onClick={resetFilters}>
              <RotateCcw aria-hidden className="size-[15px]" strokeWidth={1.75} />
              {t('logs.today')}
            </ActionButton>
            <ActionButton
              onClick={() => void exportCsv()}
              loading={exporting}
              disabled={loadState !== 'ok' || !total}
            >
              {!exporting && <FileDown aria-hidden className="size-[15px]" strokeWidth={1.75} />}
              {exporting ? t('lmAdm.logs.exporting') : t('common.csv')}
            </ActionButton>
          </>
        }
      />

      {exportResult?.kind === 'failed' && (
        <Notice kind="bad" title={t('lmAdm.logs.exportFailedTitle')}>
          {t('lmAdm.logs.exportFailedBody', { rows: n(exportResult.rows) })}
        </Notice>
      )}
      {exportResult?.kind === 'capped' && (
        <Notice
          kind="pend"
          title={t('lmAdm.logs.exportCappedTitle', { rows: n(exportResult.rows), total: n(exportResult.total) })}
        >
          {t('lmAdm.logs.exportCappedBody', { max: n(EXPORT_BATCH * EXPORT_MAX_PAGES) })}
        </Notice>
      )}

      {loadState === 'error' && (
        <Notice
          kind="bad"
          title={t('lmAdm.logs.loadErrorTitle')}
          action={
            <ActionButton variant="secondary" onClick={() => setReloadTick((x) => x + 1)}>
              {t('lmAdm.retry')}
            </ActionButton>
          }
        >
          {t('lmAdm.logs.loadErrorBody')}
        </Notice>
      )}

      {/* Filtros */}
      <Panel title={t('lmAdm.logs.filtersTitle')}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <Field label={t('logs.from')}>
            <Input type="date" value={from}
              onChange={(e) => { setFrom(e.target.value); resetPage(); }} />
          </Field>
          <Field label={t('logs.to')}>
            <Input type="date" value={to}
              onChange={(e) => { setTo(e.target.value); resetPage(); }} />
          </Field>
          <Field label={t('logs.colModule')}>
            <Select value={moduleKey}
              onChange={(e) => { setModuleKey(e.target.value); resetPage(); }}>
              <option value="">{t('common.all')}</option>
              {facets.modules.map((m) => (
                <option key={m} value={m}>{prettyModule(m)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('logs.colAction')}>
            <Select value={action}
              onChange={(e) => { setAction(e.target.value); resetPage(); }}>
              <option value="">{t('logs.allActions')}</option>
              {facets.actions.map((a) => (
                <option key={a} value={a}>{actionLabel(a)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('logs.colUser')}>
            <Select value={userFilter}
              onChange={(e) => { setUserFilter(e.target.value); resetPage(); }}>
              <option value="">{t('common.all')}</option>
              {facets.users.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('logs.searchLabel')}>
            <Input
              type="search"
              value={q}
              placeholder={t('logs.searchPlaceholder')}
              onChange={(e) => { setQ(e.target.value); resetPage(); }}
            />
          </Field>
        </div>
      </Panel>

      {/* Tabla */}
      <Panel
        title={t('lmAdm.logs.tableTitle')}
        hint={<span className="tabular-nums">{hint}</span>}
        flush
        footer={footer}
        actions={
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={ROW_ACTION_CLASS}
              aria-label={t('logs.prevPage')}
              disabled={page <= 1 || busy}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft aria-hidden className="size-4" strokeWidth={1.75} />
            </button>
            <span className="px-1 text-[12.5px] tabular-nums text-text-3">
              {loadState === 'ok' ? `${n(page)} / ${n(pages)}` : '—'}
            </span>
            <button
              type="button"
              className={ROW_ACTION_CLASS}
              aria-label={t('logs.nextPage')}
              disabled={page >= pages || busy || loadState !== 'ok'}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight aria-hidden className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        }
      >
        <FinTable
          columns={columns}
          rows={busy ? [] : rows}
          rowKey={(r) => r.id}
          caption={t('lmAdm.logs.tableTitle')}
          empty={
            busy ? (
              t('common.loading')
            ) : loadState === 'error' ? (
              t('lmAdm.logs.unknownRows')
            ) : (
              <span className="flex flex-col items-center gap-1">
                <span className="font-medium text-foreground">{t('logs.emptyTitle')}</span>
                <span>{t('logs.emptyDesc')}</span>
              </span>
            )
          }
        />
      </Panel>
    </div>
  );
}
