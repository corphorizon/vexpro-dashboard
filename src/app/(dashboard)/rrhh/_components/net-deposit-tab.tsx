'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { formatCurrency, cn } from '@/lib/utils';
import { ROLE_LABELS_HR } from '@/lib/hr-data';
import type { RollupNode } from '@/lib/hr/net-deposit';
import { IbProductionView } from './ib-production-tab';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña Net Deposit — lo que Daniela arma hoy a mano, ya armado.
//
// «Ingreso al equipo de Hugo y miro en el CRM cuánto tiene en total y de ese
// total miro cada uno… cuando sumo todo lo de ellos tengo que restar o sumar
// para que me dé el valor que sale en el CRM y ese valor se lo pongo al head».
//
// LO CALCULADO NO PISA LO CARGADO. Cada fila muestra las dos columnas juntas:
// "sugerido" (lo que sale del CRM) y "cargado" (lo que hay en
// commercial_monthly_results). Esta pantalla no escribe nada.
//
// LA LÍNEA DE AJUSTE SE MUESTRA SIEMPRE, aunque dé cero. Es la diferencia entre
// la suma de los miembros y el total del CRM, y resulta ser exactamente la
// producción directa del líder. Medido en julio 2026: la estructura de Hugo
// sumaba 529.280 entre sus cuatro heads, el CRM decía 525.791 y el ajuste que
// ella cargó fue −3.489. No es un redondeo: es su propia línea.
//
// LO "SIN ASIGNAR" TAMBIÉN SE MUESTRA. Hay clientes cuya cadena de sponsors no
// llega a ningún comercial de la estructura: 18.314 de 556.917 en julio (3,3%).
// Aparecen aparte en vez de repartirse, porque repartirlos sería inventar.
// ─────────────────────────────────────────────────────────────────────────────

type RollupResponse = {
  month: string;
  hasPeriod: boolean;
  tree: RollupNode[];
  unassigned: number;
  totalAssigned: number;
  totalCrm: number;
};

function defaultMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Verde/rojo por el signo — un net deposit negativo es plata que se fue. */
function moneyClass(v: number): string {
  if (v > 0) return 'text-positive';
  if (v < 0) return 'text-negative';
  return 'text-muted-foreground';
}

/**
 * Las dos miradas de LA MISMA estructura comercial.
 *
 * Están en una sola pestaña y no en dos a propósito: Kevin pidió la producción
 * IB por estructura (2026-08-27) y es el mismo árbol de `head_id` con otras
 * columnas. Partirlo en dos pestañas obligaría a Daniela a acordarse de en cuál
 * está cada mitad del dato del mismo equipo.
 */
type Vista = 'net_deposit' | 'production';

export function NetDepositTab() {
  const { t } = useI18n();
  const [month, setMonth] = useState(defaultMonth);
  const [vista, setVista] = useState<Vista>('net_deposit');

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground" htmlFor="nd-month">{t('hr.warningMonth')}</label>
          <input
            id="nd-month"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-border bg-card text-base sm:text-sm"
          />
        </div>
        {/* El selector de mes es UNO SOLO y vive acá arriba: cambiar de vista no
            puede hacerle perder a nadie el mes que estaba mirando. */}
        <div className="inline-flex rounded-lg border border-border p-0.5" role="tablist">
          {([
            ['net_deposit', 'hr.prodViewNetDeposit'],
            ['production', 'hr.prodViewProduction'],
          ] as const).map(([v, key]) => (
            <button
              key={v}
              role="tab"
              aria-selected={vista === v}
              onClick={() => setVista(v)}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm transition-colors',
                vista === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>

      {vista === 'net_deposit' ? <NetDepositView month={month} /> : <IbProductionView month={month} />}
    </div>
  );
}

function NetDepositView({ month }: { month: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<RollupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await apiFetch(`/api/admin/hr-net-deposit-rollup?month=${month}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'load failed');
      setData(json as RollupResponse);
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

  // Solo se listan las estructuras que movieron algo o tienen gente colgando:
  // 126 perfiles de los cuales la mitad están en cero convierten la tabla en
  // ruido y esconden a los cuatro que importan.
  const roots = useMemo(
    () => (data?.tree ?? []).filter((n) => n.total !== 0 || n.children.length > 0 || n.manual != null),
    [data],
  );

  return (
    <div className="space-y-6">
      {/* El selector de mes vive en `NetDepositTab`, arriba del conmutador de
          vistas: es uno solo para las dos miradas de la misma estructura. */}
      <div className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/5 p-3">
        <Info className="w-4 h-4 text-info mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground">{t('hr.ndHint')}</p>
      </div>

      {loadError ? (
        <p className="text-sm text-negative">{t('hr.warningError')}</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : !data ? null : (
        <>
          {/* ── Totales del mes ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-lg border border-border p-4">
              <p className="text-sm text-muted-foreground mb-1">{t('hr.ndTotalCrm')}</p>
              <p className={cn('text-xl font-bold', moneyClass(data.totalCrm))}>{formatCurrency(data.totalCrm)}</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-sm text-muted-foreground mb-1">{t('hr.ndAssigned')}</p>
              <p className={cn('text-xl font-bold', moneyClass(data.totalAssigned))}>{formatCurrency(data.totalAssigned)}</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-sm text-muted-foreground mb-1">{t('hr.ndUnassigned')}</p>
              <p className={cn('text-xl font-bold', moneyClass(data.unassigned))}>{formatCurrency(data.unassigned)}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{t('hr.ndUnassignedHint')}</p>
            </div>
          </div>

          {!data.hasPeriod && (
            <p className="text-xs text-muted-foreground">{t('hr.ndNoPeriod')}</p>
          )}

          {/* ── Estructuras ─────────────────────────────────────────────── */}
          <div className="rounded-lg border border-border overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.role')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.ndTeam')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.ndAdjustment')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.ndSuggested')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('hr.ndManual')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium hidden md:table-cell">{t('hr.ndDiff')}</th>
                </tr>
              </thead>
              <tbody>
                {roots.map((n) => (
                  <RollupRows key={n.profileId} node={n} depth={0} collapsed={collapsed} toggle={toggle} />
                ))}
                {roots.length === 0 && (
                  <tr><td colSpan={7} className="text-center text-muted-foreground py-8">{t('hr.ndEmpty')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Una estructura y todo lo que cuelga de ella. Se devuelve como fragmento de
 * filas (no como <table> anidada) para que las columnas de un BDM de tercer
 * nivel sigan alineadas con las del sales manager de arriba.
 */
function RollupRows({ node, depth, collapsed, toggle }: {
  node: RollupNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (id: string) => void;
}) {
  const { t } = useI18n();
  const isCollapsed = collapsed.has(node.profileId);
  const hasKids = node.children.length > 0;
  const diff = node.manual == null ? null : node.total - node.manual;

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
        <td className={cn('py-2 px-3 text-right', moneyClass(node.team))}>
          {hasKids ? formatCurrency(node.team) : '-'}
        </td>
        {/* El ajuste se muestra siempre, aunque sea cero: es la línea que hoy
            se calcula de memoria y no verla es lo que la vuelve invisible. */}
        <td className={cn('py-2 px-3 text-right', moneyClass(node.adjustment))}>{formatCurrency(node.adjustment)}</td>
        <td className={cn('py-2 px-3 text-right font-medium', moneyClass(node.total))}>{formatCurrency(node.total)}</td>
        <td className="py-2 px-3 text-right text-muted-foreground">
          {node.manual == null ? '-' : formatCurrency(node.manual)}
        </td>
        <td className={cn('py-2 px-3 text-right hidden md:table-cell text-xs', diff == null ? 'text-muted-foreground' : moneyClass(diff))}>
          {diff == null ? t('hr.ndNotLoaded') : formatCurrency(diff)}
        </td>
      </tr>
      {!isCollapsed && node.children.map((c) => (
        <RollupRows key={c.profileId} node={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} />
      ))}
    </>
  );
}
