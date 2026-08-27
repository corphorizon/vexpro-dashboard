'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, Info, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { formatCurrency, formatNumber, cn } from '@/lib/utils';
import { ROLE_LABELS_HR } from '@/lib/hr-data';
import type { IbProduction, IbProductionNode } from '@/lib/hr/ib-production';
import { hasProduction } from '@/lib/hr/ib-production';

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

/** Verde/rojo por el signo — un PNL negativo del cliente es plata del bróker. */
function moneyClass(v: number): string {
  if (v > 0) return 'text-positive';
  if (v < 0) return 'text-negative';
  return 'text-muted-foreground';
}

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

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/5 p-3">
        <Info className="w-4 h-4 text-info mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground">{t('hr.prodHint')}</p>
      </div>

      {coverageMsg && (
        <div className={cn(
          'flex items-start gap-2 rounded-lg border p-3',
          coverageMsg.tone === 'warn' ? 'border-warning/30 bg-warning/5' : 'border-border',
        )}>
          {coverageMsg.tone === 'warn'
            ? <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
            : <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />}
          <p className="text-xs text-muted-foreground">{coverageMsg.text}</p>
        </div>
      )}

      {loadError ? (
        <p className="text-sm text-negative">{t('hr.warningError')}</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : !data ? null : (
        <>
          {/* ── Totales del mes ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Total label={t('hr.prodLots')} value={formatNumber(data.totalAssigned?.lots ?? 0)} />
            <Total label={t('hr.prodCommission')} value={formatCurrency(data.totalAssigned?.commission ?? 0)} />
            <Total
              label={t('hr.prodPnl')}
              value={formatCurrency(data.totalAssigned?.pnl ?? 0)}
              hint={t('hr.prodPnlHint')}
              tone={moneyClass(data.totalAssigned?.pnl ?? 0)}
            />
            <Total label={t('hr.prodRewards')} value={formatNumber(data.totalAssigned?.rewards ?? 0).replace(/\.00$/, '')} />
          </div>

          {/* ── Estructuras ─────────────────────────────────────────────── */}
          <div className="rounded-lg border border-border overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.role')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.prodRewards')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.prodLots')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.prodForex')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.prodSynthetic')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.prodCommission')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium hidden md:table-cell">{t('hr.prodPnl')}</th>
                </tr>
              </thead>
              <tbody>
                {roots.map((n) => (
                  <ProductionRows key={n.profileId} node={n} depth={0} collapsed={collapsed} toggle={toggle} />
                ))}
                {roots.length === 0 && (
                  <tr><td colSpan={8} className="text-center text-muted-foreground py-8">{t('hr.prodEmpty')}</td></tr>
                )}
                {data.unassigned && (
                  <tr className="border-t border-border bg-muted/30">
                    <td className="py-2 px-3 text-muted-foreground italic" colSpan={2}>{t('hr.ndUnassigned')}</td>
                    <td className="py-2 px-3 text-right text-muted-foreground">{formatNumber(data.unassigned.rewards).replace(/\.00$/, '')}</td>
                    <td className="py-2 px-3 text-right text-muted-foreground">{formatNumber(data.unassigned.lots)}</td>
                    <td className="py-2 px-3 text-right text-muted-foreground"><Lots v={data.unassigned.forexLots} /></td>
                    <td className="py-2 px-3 text-right text-muted-foreground"><Lots v={data.unassigned.syntheticLots} /></td>
                    <td className="py-2 px-3 text-right text-muted-foreground">{formatCurrency(data.unassigned.commission)}</td>
                    <td className="py-2 px-3 text-right text-muted-foreground hidden md:table-cell">{formatCurrency(data.unassigned.pnl)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Total({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-sm text-muted-foreground mb-1">{label}</p>
      <p className={cn('text-xl font-bold', tone)}>{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

/**
 * Lotes de una clase de activo. `null` NO se dibuja como 0: dice "sin dato".
 * Es la diferencia entre "no operó sintéticos" y "ese mes no está espejado", y
 * confundirlas es el modo de fallo que esta pantalla existe para evitar.
 */
function Lots({ v }: { v: number | null }) {
  const { t } = useI18n();
  if (v === null) return <span className="text-muted-foreground/60 italic text-xs">{t('hr.prodNoData')}</span>;
  return <>{formatNumber(v)}</>;
}

/**
 * Una estructura y todo lo que cuelga de ella. Se devuelve como fragmento de
 * filas (no como <table> anidada) para que las columnas de un BDM de tercer
 * nivel sigan alineadas con las del sales manager de arriba.
 */
function ProductionRows({ node, depth, collapsed, toggle }: {
  node: IbProductionNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (id: string) => void;
}) {
  const isCollapsed = collapsed.has(node.profileId);
  const hasKids = node.children.length > 0;
  const p = node.total;

  return (
    <>
      <tr className={cn('border-b border-border/50 hover:bg-muted/50', depth === 0 && 'font-medium')}>
        <td className="py-2 px-3">
          <div className="flex items-center gap-1" style={{ paddingLeft: depth * 16 }}>
            {hasKids ? (
              <button onClick={() => toggle(node.profileId)} className="text-muted-foreground hover:text-foreground" aria-label={node.name}>
                {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            ) : (
              <span className="w-3.5" />
            )}
            {node.name}
          </div>
        </td>
        <td className="py-2 px-3 text-muted-foreground hidden sm:table-cell">{ROLE_LABELS_HR[node.role]}</td>
        <td className="py-2 px-3 text-right">{formatNumber(p.rewards).replace(/\.00$/, '')}</td>
        <td className="py-2 px-3 text-right font-medium">{formatNumber(p.lots)}</td>
        <td className="py-2 px-3 text-right text-muted-foreground"><Lots v={p.forexLots} /></td>
        <td className="py-2 px-3 text-right text-muted-foreground"><Lots v={p.syntheticLots} /></td>
        <td className="py-2 px-3 text-right font-medium">{formatCurrency(p.commission)}</td>
        <td className={cn('py-2 px-3 text-right hidden md:table-cell', moneyClass(p.pnl))}>{formatCurrency(p.pnl)}</td>
      </tr>
      {!isCollapsed && node.children.map((c) => (
        <ProductionRows key={c.profileId} node={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} />
      ))}
    </>
  );
}
