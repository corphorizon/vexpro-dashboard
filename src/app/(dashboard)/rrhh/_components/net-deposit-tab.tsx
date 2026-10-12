'use client';

import { useState, useMemo } from 'react';
import { useI18n } from '@/lib/i18n';
import { Panel } from '@/components/ui/panel';
import { KpiStrip } from '@/components/ui/kpi-strip';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money } from '@/components/ui/money';
import { hrRoleLabel } from '@/lib/hr/domain';
import type { RollupNode } from '@/lib/hr/net-deposit';
import {
  indexarNetDelCrm,
  resolveNetDepositInput,
  type ResolvedNetDeposit,
} from '@/lib/hr/net-deposit-input';
import { manualDeEstructura } from '@/lib/hr/overview';
import { IbProductionView } from './ib-production-tab';
import { useHrPeriod } from './hr-period-context';
import { NetWithSource, TreeNameCell } from './hr-ui';
import { flattenTree, type FlatTreeRow } from './hr-view';

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
//
// ── Y desde la tanda 2 hay una tercera columna: cuál de las dos MANDA ───────
// Sugerido y cargado siguen uno al lado del otro, pero ahora la pantalla dice
// además qué número es el que va a entrar al motor de comisiones, con su
// rótulo. Sale del mismo `resolveNetDepositInput` que usan /comisiones y la
// pestaña Comercial: si esta tabla dijera una cosa y el cálculo usara otra,
// nadie podría auditar el número mirando acá, que es para lo que existe.
//
// ── «Libro mayor» (2026-10-12) — sólo presentación ─────────────────────────
// Las tres tarjetas de totales → KpiStrip (sin asignar con su explicación en
// el sub); el árbol → FinTable (aplanado por `flattenTree`, hr-view.ts, con la
// sangría y el colapso de siempre); el conmutador de vistas → Segmented (antes
// `bg-primary` relleno, compitiendo con el único primario); error/«sin
// período» → Notice. El verde/rojo por signo se conserva (`tone="sign"`:
// acá el signo ES la noticia) pero ahora sale del token `pos`/`neg`.
// Medición (sin comentarios): antes 2 `text-[10px]` y 30 tokens legados
// (`text-positive`, `text-muted-foreground`, `bg-info/5`…); después 0.
// ─────────────────────────────────────────────────────────────────────────────

// El mes ya NO se elige acá: viene del selector único del módulo
// (rrhh/_components/hr-period-context.tsx). El <input type="month"> que vivía en
// esta pestaña era uno de los tres relojes del módulo.

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
  const { month } = useHrPeriod();
  const [vista, setVista] = useState<Vista>('net_deposit');

  return (
    <div className="space-y-4">
      {/* El mes lo pone el selector del módulo, arriba de las pestañas:
          cambiar de vista (o de pestaña) no le hace perder a nadie el mes
          que estaba mirando. */}
      <div className="flex justify-end">
        <Segmented
          options={[
            { value: 'net_deposit', label: t('hr.prodViewNetDeposit') },
            { value: 'production', label: t('hr.prodViewProduction') },
          ]}
          value={vista}
          onChange={setVista}
          aria-label={t('hr.netDepositTab')}
        />
      </div>

      {vista === 'net_deposit' ? <NetDepositView /> : <IbProductionView month={month} />}
    </div>
  );
}

function NetDepositView() {
  const { t } = useI18n();
  // Los datos salen del overview del módulo, que ya los pidió una vez para el
  // mes del selector. Esta pestaña NO llama más a /api/admin/hr-net-deposit-
  // rollup (que sigue vivo para otros consumidores): volver a pedirlos cada vez
  // que alguien entraba acá repetía la RPC del rollup entera.
  const { overview, loading, error } = useHrPeriod();
  // `net` es null cuando el slice falló: se muestra el mismo error que antes,
  // nunca un árbol vacío que se leería como "este mes no produjo nadie".
  const data = overview?.data.net ?? null;
  const hasPeriod = overview?.hasPeriod ?? false;
  const loadError = error || (!!overview && overview.partial.includes('net'));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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
  const hiddenRoots = data ? data.tree.length - roots.length : 0;
  const rows = useMemo(() => flattenTree(roots, collapsed), [roots, collapsed]);

  /**
   * Qué número manda por perfil, con su procedencia — el MISMO resolver que el
   * motor. Alcance `structure`: esta tabla mira la producción de la estructura
   * (la columna «sugerido» es `total`), y la propia del líder ya tiene su
   * columna aparte («ajuste»).
   */
  const insumo = useMemo((): Map<string, ResolvedNetDeposit> => {
    const out = new Map<string, ResolvedNetDeposit>();
    if (!data?.tree) return out;
    const idx = indexarNetDelCrm(data.tree);
    const rowsMr = overview?.data.monthlyResults ?? null;
    const manual = rowsMr ? manualDeEstructura(rowsMr) : null;
    const [y, m] = (overview?.month ?? '').split('-');
    const period = overview?.period ?? (y && m ? { year: Number(y), month: Number(m), is_closed: false } : null);
    if (!period) return out;
    for (const id of idx.keys()) {
      out.set(id, resolveNetDepositInput({
        profileId: id,
        period,
        scope: 'structure',
        crm: idx,
        manual: manual ? manual.get(id) ?? null : null,
      }));
    }
    return out;
  }, [data, overview]);

  type Row = FlatTreeRow<RollupNode>;
  const columns: FinColumn<Row>[] = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (r) => (
        <TreeNameCell
          name={r.node.name}
          depth={r.depth}
          hasKids={r.hasKids}
          collapsed={r.collapsed}
          onToggle={() => toggle(r.node.profileId)}
        />
      ),
      mobileMeta: (r) => hrRoleLabel(r.node.role),
    },
    {
      key: 'role',
      header: t('hr.role'),
      hideSm: true,
      cell: (r) => <span className="text-text-2">{hrRoleLabel(r.node.role)}</span>,
    },
    {
      key: 'team',
      header: t('hr.ndTeam'),
      kind: 'money',
      hideSm: true,
      money: { tone: 'sign' },
      value: (r) => (r.hasKids ? r.node.team : null),
    },
    // El ajuste se muestra siempre, aunque sea cero: es la línea que hoy se
    // calcula de memoria y no verla es lo que la vuelve invisible.
    { key: 'adjustment', header: t('hr.ndAdjustment'), kind: 'money', hideSm: true, money: { tone: 'sign' }, value: (r) => r.node.adjustment },
    { key: 'suggested', header: t('hr.ndSuggested'), kind: 'money', money: { tone: 'sign' }, value: (r) => r.node.total },
    { key: 'manual', header: t('hr.ndManual'), kind: 'money', hideSm: true, money: { tone: 'neutral' }, value: (r) => r.node.manual },
    // Cuál de las dos manda. `null` = sin datos → «—» + stale, nunca $0.
    {
      key: 'input',
      header: t('hr.ndInput'),
      align: 'right',
      cardSide: 'right',
      cell: (r) => {
        const res = insumo.get(r.node.profileId);
        return <NetWithSource value={res?.value ?? null} source={res?.source ?? 'none'} tone="sign" />;
      },
    },
    {
      key: 'diff',
      header: t('hr.ndDiff'),
      align: 'right',
      hideSm: true,
      cell: (r) =>
        r.node.manual == null ? (
          <span className="text-[12px] text-text-3">{t('hr.ndNotLoaded')}</span>
        ) : (
          <Money value={r.node.total - r.node.manual} tone="sign" />
        ),
    },
  ];

  if (loadError) return <Notice kind="bad" title={t('hr.warningError')} />;
  if (loading) return <p className="text-[13px] text-text-3">{t('common.loading')}</p>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <KpiStrip
        items={[
          { key: 'crm', label: t('hr.ndTotalCrm'), value: data.totalCrm, tone: 'sign', hero: true },
          { key: 'assigned', label: t('hr.ndAssigned'), value: data.totalAssigned, tone: 'sign' },
          {
            key: 'unassigned',
            label: t('hr.ndUnassigned'),
            value: data.unassigned,
            tone: 'sign',
            sub: t('hr.ndUnassignedHint'),
          },
        ]}
      />

      {!hasPeriod && <Notice kind="info" title={t('hr.ndNoPeriod')} />}

      <Panel
        title={t('hrv.structures')}
        hint={overview?.month?.slice(0, 7)}
        flush
        // Recorte contado (reglas §1.2): las estructuras en cero no se listan.
        footer={hiddenRoots > 0 ? t('hrv.hiddenZeroStructures', { n: String(hiddenRoots) }) : undefined}
      >
        <p className="border-b border-border px-4 py-2.5 text-[12.5px] leading-5 text-text-3">{t('hr.ndHint')}</p>
        <FinTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.node.profileId}
          caption={t('hr.prodViewNetDeposit')}
          empty={t('hr.ndEmpty')}
        />
      </Panel>
    </div>
  );
}
