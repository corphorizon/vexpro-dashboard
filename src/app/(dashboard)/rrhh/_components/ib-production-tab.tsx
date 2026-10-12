'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { formatNumber } from '@/lib/utils';
import { Panel } from '@/components/ui/panel';
import { KpiStrip } from '@/components/ui/kpi-strip';
import { Notice } from '@/components/ui/notice';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { NUM_CLASS } from '@/components/ui/money';
import { ROLE_LABELS_HR } from '@/lib/hr-data';
import type { IbProduction, IbProductionNode } from '@/lib/hr/ib-production';
import { hasProduction } from '@/lib/hr/ib-production';
import { TreeNameCell } from './hr-ui';
import { flattenTree, type FlatTreeRow } from './hr-view';

// ─────────────────────────────────────────────────────────────────────────────
// Vista "Producción IB" — la misma estructura comercial que el net deposit,
// mirada por lo que el CRM PAGÓ.
//
// Kevin, 2026-08-27: «Me gustaría tener el dato por estructura del PNL de cada
// BDM, de la cantidad de pagos por lotes y lotes movidos que se pagaron (basado
// en el crm, ya que tiene ciertas reglas para pagar), discriminar por activos de
// forex y activos sintéticos».
//
// VA EN LA MISMA PESTAÑA QUE EL NET DEPOSIT, no en una nueva: es el mismo árbol
// con otras columnas, y quien mira la producción de un equipo no tiene que
// acordarse de en cuál de dos pantallas está cada mitad del dato.
//
// ── "SIN DATO" ESTÁ ESCRITO, NO DIBUJADO COMO CERO ────────────────────────
// El desglose forex/sintéticos sale de `ibrewards`, que el bróker purga a los
// quince días. Un mes que no se alcanzó a espejar NO TIENE el desglose y nunca
// lo va a tener. En esas celdas dice "sin dato" y arriba hay un aviso con los
// días que sí están cubiertos. Un cero ahí diría "este equipo no operó
// sintéticos", que es una afirmación que no tenemos cómo sostener.
//
// ── LOS LOTES NO SON PLATA ────────────────────────────────────────────────
// Lotes y pagos van con formato de número; comisión y PNL con formato de moneda
// y USD. Todo el origen es USD (verificado: currency='USD' en el 100% de las
// filas). Los lotes son ESTÁNDAR: las cuentas cent ya vienen ÷100 del bróker,
// así que un lote cent no es un lote acá.
//
// ── «Libro mayor» (2026-10-12) — sólo presentación ────────────────────────
// Totales → KpiStrip; árbol → FinTable (flattenTree) con la fila «sin
// asignar» como fila de total al pie; avisos de cobertura → Notice (`pend` si
// falta parte del mes, `info` si está completo). Los totales del mes eran
// `formatCurrency(data.totalAssigned?.commission ?? 0)`: sin `totalAssigned`
// mostraban $0 y 0 lotes; ahora «—» (reglas §1.3). Medición (sin
// comentarios): antes 1 `text-[11px]`, 37 tokens legados y 5 `?? 0`; después
// 0 / 0 / 0.
// ─────────────────────────────────────────────────────────────────────────────

export type IbProductionResponse = {
  month: string;
  currency: string;
  tree: IbProductionNode[];
  unassigned: IbProduction | null;
  totalAssigned: IbProduction | null;
  symbolCoverage: {
    days: number;
    daysInMonth: number;
    from: string | null;
    to: string | null;
  };
};

/** Lotes / conteos: 2 decimales como siempre (formatNumber), tabulares. */
function Num({ v, trimZeros }: { v: number; trimZeros?: boolean }) {
  const txt = formatNumber(v);
  return <span className={NUM_CLASS}>{trimZeros ? txt.replace(/\.00$/, '') : txt}</span>;
}

/**
 * Lotes de una clase de activo. `null` NO se dibuja como 0: dice "sin dato".
 * Es la diferencia entre "no operó sintéticos" y "ese mes no está espejado", y
 * confundirlas es el modo de fallo que esta pantalla existe para evitar.
 */
function Lots({ v }: { v: number | null }) {
  const { t } = useI18n();
  if (v === null) return <span className="text-[12px] text-text-3">{t('hr.prodNoData')}</span>;
  return <Num v={v} />;
}

/** Una fila de la tabla: un nodo del árbol o la línea «sin asignar». */
type ProdRow =
  | ({ kind: 'node' } & FlatTreeRow<IbProductionNode>)
  | { kind: 'unassigned'; production: IbProduction };

const prodOf = (r: ProdRow): IbProduction => (r.kind === 'node' ? r.node.total : r.production);

export function IbProductionView({ month }: { month: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<IbProductionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await apiFetch(`/api/admin/hr-ib-production-rollup?month=${month}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'load failed');
      setData(json as IbProductionResponse);
    } catch {
      setLoadError(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Sólo las estructuras que movieron algo o tienen gente colgando: 126
  // perfiles de los cuales la mitad están en cero convierten la tabla en ruido.
  const roots = useMemo(
    () => (data?.tree ?? []).filter((n) => hasProduction(n) || n.children.length > 0),
    [data],
  );
  const hiddenRoots = data ? data.tree.length - roots.length : 0;
  const rows = useMemo((): ProdRow[] => {
    const flat: ProdRow[] = flattenTree(roots, collapsed).map((r) => ({ kind: 'node' as const, ...r }));
    if (data?.unassigned) flat.push({ kind: 'unassigned', production: data.unassigned });
    return flat;
  }, [roots, collapsed, data]);

  const cov = data?.symbolCoverage;
  const coverageMsg = !cov
    ? null
    : cov.days === 0
      ? { tone: 'warn' as const, text: t('hr.prodCoverageNone') }
      : cov.days < cov.daysInMonth
        ? {
            tone: 'warn' as const,
            text: t('hr.prodCoveragePartial')
              .replace('{days}', String(cov.days))
              .replace('{total}', String(cov.daysInMonth))
              .replace('{from}', cov.from ?? '')
              .replace('{to}', cov.to ?? ''),
          }
        : { tone: 'info' as const, text: t('hr.prodCoverageFull') };

  const columns: FinColumn<ProdRow>[] = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (r) =>
        r.kind === 'node' ? (
          <TreeNameCell
            name={r.node.name}
            depth={r.depth}
            hasKids={r.hasKids}
            collapsed={r.collapsed}
            onToggle={() => toggle(r.node.profileId)}
          />
        ) : (
          <span className="pl-7 text-text-2">{t('hr.ndUnassigned')}</span>
        ),
      mobileMeta: (r) => (r.kind === 'node' ? ROLE_LABELS_HR[r.node.role] : null),
    },
    {
      key: 'role',
      header: t('hr.role'),
      hideSm: true,
      cell: (r) => <span className="text-text-2">{r.kind === 'node' ? ROLE_LABELS_HR[r.node.role] : ''}</span>,
    },
    { key: 'rewards', header: t('hr.prodRewards'), align: 'right', hideSm: true, cell: (r) => <Num v={prodOf(r).rewards} trimZeros /> },
    { key: 'lots', header: t('hr.prodLots'), align: 'right', hideSm: true, cell: (r) => <Num v={prodOf(r).lots} /> },
    { key: 'forex', header: t('hr.prodForex'), align: 'right', hideSm: true, cell: (r) => <Lots v={prodOf(r).forexLots} /> },
    { key: 'synthetic', header: t('hr.prodSynthetic'), align: 'right', hideSm: true, cell: (r) => <Lots v={prodOf(r).syntheticLots} /> },
    { key: 'commission', header: t('hr.prodCommission'), kind: 'money', value: (r) => prodOf(r).commission, subtotal: false },
    {
      key: 'pnl',
      header: t('hr.prodPnl'),
      kind: 'money',
      hideSm: true,
      money: { tone: 'sign' },
      value: (r) => prodOf(r).pnl,
      subtotal: false,
    },
  ];

  const tot = data?.totalAssigned ?? null;
  const lots = tot?.lots ?? null;

  return (
    <div className="space-y-4">
      {coverageMsg && (
        <Notice kind={coverageMsg.tone === 'warn' ? 'pend' : 'info'} title={coverageMsg.text} />
      )}

      {loadError ? (
        <Notice kind="bad" title={t('hr.warningError')} />
      ) : loading ? (
        <p className="text-[13px] text-text-3">{t('common.loading')}</p>
      ) : !data ? null : (
        <>
          {/* ── Totales del mes ─────────────────────────────────────────── */}
          {/* Sin `totalAssigned` el KPI es «—», no 0 (antes `?? 0`). */}
          <KpiStrip
            items={[
              {
                key: 'lots',
                label: t('hr.prodLots'),
                value: lots,
                format: 'count',
                // El KPI redondea a entero; el exacto va abajo.
                sub: lots != null && !Number.isInteger(lots) ? formatNumber(lots) : undefined,
              },
              { key: 'commission', label: t('hr.prodCommission'), value: tot?.commission ?? null, hero: true },
              { key: 'pnl', label: t('hr.prodPnl'), value: tot?.pnl ?? null, tone: 'sign', sub: t('hr.prodPnlHint') },
              { key: 'rewards', label: t('hr.prodRewards'), value: tot?.rewards ?? null, format: 'count' },
            ]}
          />

          {/* ── Estructuras ─────────────────────────────────────────────── */}
          <Panel
            title={t('hrv.structures')}
            hint={data.month?.slice(0, 7)}
            flush
            footer={hiddenRoots > 0 ? t('hrv.hiddenZeroStructures', { n: String(hiddenRoots) }) : undefined}
          >
            <p className="border-b border-border px-4 py-2.5 text-[12.5px] leading-5 text-text-3">{t('hr.prodHint')}</p>
            <FinTable
              columns={columns}
              rows={rows}
              rowKey={(r) => (r.kind === 'node' ? r.node.profileId : '__unassigned__')}
              rowVariant={(r) => (r.kind === 'unassigned' ? 'total' : undefined)}
              caption={t('hr.prodViewProduction')}
              empty={t('hr.prodEmpty')}
            />
          </Panel>
        </>
      )}
    </div>
  );
}
