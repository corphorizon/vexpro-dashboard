'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /finanzas/crm — Totales del CRM, mes a mes.
//
// Tres números que hasta hoy se tecleaban en "Carga de Datos" y que el CRM ya
// tiene al centavo: transferencias P2P, ventas de prop firm y retiros de prop
// firm aprobados. El cron los calcula (src/lib/crm-sync/monthly-totals.ts) y
// esta pantalla los muestra AL LADO de lo cargado a mano, con la diferencia.
//
// ── POR QUÉ AL LADO Y NO SUMADO ────────────────────────────────────────────
// Porque es el MISMO dinero. Medido el 2026-08-27 en producción: la columna
// manual de `prop_firm_sales` de Vex Pro ya trae, mes por mes, exactamente el
// `amountPaid` de Orion (2026-02: 51.409,65 = 51.409,65). Sumarlas duplicaría
// el ingreso — que es justo lo que hace hoy /movimientos con la vieja API de
// Orion, y sólo no se nota porque esa API devuelve 0. Acá no se suma nada, y
// esta pantalla NO escribe: lo manual sigue siendo de quien lo carga.
//
// La diferencia no es un error: un mes abierto todavía se mueve, y un mes
// donde nadie cargó nada muestra "sin cargar" (null), no cero. `null` y `0`
// son datos distintos.
//
// ── Y ABAJO, LO QUE ES DATO Y NO FINANZAS (Kevin, 2026-08-28) ──────────────
// Tres series más —comisiones IB acreditadas, social trading fees y fee debt
// recovery— viven en una sección aparte, al final, marcada «no cuentan en el
// resultado». El motivo es que este dashboard es BASE CAJA y esas tres mueven
// la BILLETERA del cliente o del IB, no la caja del bróker: la comisión IB
// acreditada es deuda interna, y la caja recién se mueve el día que el IB
// retira — retiro que YA se cuenta como egreso. Sumarlas al resultado
// duplicaría ese dólar.
//
// Por eso no comparten tabla con las de arriba, no tienen columna "manual" ni
// "diferencia", y llevan la advertencia encima. La separación es visual a
// propósito: el bug que se evita no es de código, es de que alguien las lea
// como si fueran ingresos.
//
// ── «LIBRO MAYOR» (2026-10-12) ────────────────────────────────────────────
// Botonera de métricas → `Segmented`; tablas a mano → `FinTable` (números a
// la derecha, tabulares, tarjeta en móvil); avisos con `text-amber-600` y
// `dark:text-amber-500` crudos → `Notice` (pend/bad/info). La diferencia
// ≠ 0 va en `neg` (antes ámbar: no es «pendiente», es lo que no cuadra).
// Las métricas que no suman al resultado llevan «Informativo — no suma al
// resultado» en un `StatusBadge neutral`, leído de `feedsResult` del
// registro (crm-monthly.ts) — incluida P2P, que se compara pero tampoco
// suma. Las reglas de cada celda (diferencia, reversos, detail) están en
// crm-totals-view.ts, con test. Ningún número cambió de fórmula.
// Medido antes/después en este archivo: 7 clases de paleta cruda + 1 `dark:`
// → 0; 23 tokens legados (`muted-foreground`, `destructive`, `bg-muted`) → 0.
//
// DESCARTADO: total al pie (la tabla nunca lo tuvo; ver crm-totals-view.ts)
// y `Chip` para elegir métrica (son excluyentes: eso es un segmented).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Database } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { StatusBadge } from '@/components/ui/status-badge';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money } from '@/components/ui/money';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { CRM_MONTHLY_COMPARED_METRICS, CRM_MONTHLY_INFO_METRICS } from '@/lib/crm-monthly';
import { crmDiff, detailNumber, isOutsideResult, lastComputedAt, reversalsShown } from './crm-totals-view';

interface Row {
  year: number;
  month: number;
  metric: string;
  auto: number | null;
  currency: string;
  txCount: number;
  excludedCount: number;
  excludedAmount: number;
  detail: Record<string, unknown> | null;
  computedAt: string | null;
  manual: number | null;
  periodLabel: string | null;
  periodClosed: boolean | null;
}

const rowKey = (r: Row) => `${r.year}-${r.month}`;

export default function CrmTotalsPage() {
  const { t, locale } = useI18n();
  const canView = useModuleAccess('income');
  const { company } = useData();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [metric, setMetric] = useState<string>(CRM_MONTHLY_COMPARED_METRICS[0].key);
  const [infoMetric, setInfoMetric] = useState<string>(CRM_MONTHLY_INFO_METRICS[0].key);

  useEffect(() => {
    if (!canView) return;
    let alive = true;
    apiFetch('/api/admin/crm-monthly-totals')
      .then((res) => res.json())
      .then((json: { success?: boolean; rows?: Row[]; truncated?: boolean }) => {
        if (!alive) return;
        if (json?.success) {
          setRows(json.rows ?? []);
          setTruncated(Boolean(json.truncated));
        } else {
          setRows([]);
          setFailed(true);
        }
      })
      .catch(() => {
        if (alive) {
          setRows([]);
          setFailed(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [canView]);

  // Qué métricas tienen datos. Una empresa sin prop firm no tiene filas: eso
  // es "no aplica", y mostrarle una tabla en cero le diría "vendiste nada".
  const withData = useMemo(() => {
    const s = new Set((rows ?? []).map((r) => r.metric));
    return CRM_MONTHLY_COMPARED_METRICS.filter((m) => s.has(m.key));
  }, [rows]);

  // Lo mismo para las informativas: AP Markets no tiene un solo movimiento de
  // fee debt recovery, así que esa serie no se le muestra. Una tabla en cero
  // afirmaría "no se recuperó nada", que es un dato que no tenemos.
  const infoWithData = useMemo(() => {
    const s = new Set((rows ?? []).map((r) => r.metric));
    return CRM_MONTHLY_INFO_METRICS.filter((m) => s.has(m.key));
  }, [rows]);

  // La métrica efectiva se DERIVA en vez de corregirse en un efecto: si la
  // elegida no tiene datos para esta empresa, se cae a la primera que sí. Un
  // setState dentro de un efecto para lo mismo dispara un render en cascada.
  const activeMetric = withData.some((m) => m.key === metric)
    ? metric
    : withData[0]?.key ?? metric;

  const visible = useMemo(
    () => (rows ?? []).filter((r) => r.metric === activeMetric),
    [rows, activeMetric],
  );

  const activeInfoMetric = infoWithData.some((m) => m.key === infoMetric)
    ? infoMetric
    : infoWithData[0]?.key ?? infoMetric;

  const infoVisible = useMemo(
    () => (rows ?? []).filter((r) => r.metric === activeInfoMetric),
    [rows, activeInfoMetric],
  );

  if (!canView) {
    return <EmptyState icon={Database} title={t('crmTotals.title')} description={t('common.noAccess')} />;
  }

  const currency = visible[0]?.currency || company?.currency || 'USD';
  const label = (m: { labelEs: string; labelEn: string }) => (locale === 'en' ? m.labelEn : m.labelEs);
  const monthLabel = (r: Row) => r.periodLabel ?? `${r.year}-${String(r.month).padStart(2, '0')}`;
  const muted = (text: string) => <span className="text-text-3">{text}</span>;

  const lastComputed = lastComputedAt(visible);
  const activeDef = withData.find((m) => m.key === activeMetric) ?? null;
  const activeInfoDef = infoWithData.find((m) => m.key === activeInfoMetric) ?? null;

  // «Informativo — no suma al resultado»: lo decide el registro
  // (`feedsResult`), no esta pantalla. Neutral: no es un estado de dinero.
  const outsideBadge = <StatusBadge kind="neutral" label={t('crmTotals.lm.outsideResult')} />;

  // Excluido / correcciones: «n · $x», o «—» si no hubo. El conteo va primero
  // porque es lo que se audita; el monto es contexto.
  const excludedCell = (r: Row, hint: string) =>
    r.excludedCount === 0 ? (
      muted('—')
    ) : (
      <span title={hint} className="whitespace-nowrap">
        <span className="tabular-nums">{r.excludedCount}</span>
        {' · '}
        <Money value={r.excludedAmount} currency={currency} />
      </span>
    );

  const columns: FinColumn<Row>[] = [
    {
      key: 'month',
      header: t('crmTotals.month'),
      cell: (r) => monthLabel(r),
      meta: (r) => (r.periodClosed ? t('crmTotals.closed') : null),
    },
    {
      key: 'auto',
      header: t('crmTotals.auto'),
      kind: 'money',
      cell: (r) =>
        r.auto === null ? (
          muted(t('crmTotals.notComputed'))
        ) : (
          <Money value={r.auto} currency={currency} className="font-medium" />
        ),
    },
    {
      key: 'manual',
      header: t('crmTotals.manual'),
      kind: 'money',
      cell: (r) =>
        r.manual === null ? muted(t('crmTotals.notLoaded')) : <Money value={r.manual} currency={currency} />,
    },
    {
      key: 'diff',
      header: t('crmTotals.difference'),
      kind: 'money',
      cell: (r) => {
        const d = crmDiff(r.auto, r.manual);
        if (d.kind === 'unknown') return muted('—');
        if (d.kind === 'match') return <Money value={0} currency={currency} className="text-text-3" />;
        // Una diferencia no es un error (un mes abierto se mueve), pero es lo
        // que hay que mirar: `neg` con el signo explícito.
        return <Money value={d.value} currency={currency} signed tone="neg" className="font-medium" />;
      },
    },
    {
      key: 'txCount',
      header: t('crmTotals.txCount'),
      kind: 'number',
      value: (r) => r.txCount,
      hideSm: true,
    },
    {
      key: 'excluded',
      header: t('crmTotals.excluded'),
      kind: 'number',
      cell: (r) => excludedCell(r, t('crmTotals.excludedHint')),
      hideSm: true,
    },
  ];

  // Columnas de la tabla informativa: las fijas + las que declara la métrica
  // en el registro (hedge fund: rendimientos y capital devuelto). La lista
  // sale de `detailColumns`, no de acá.
  const infoColumns: FinColumn<Row>[] = [
    { key: 'month', header: t('crmTotals.month'), cell: (r) => monthLabel(r) },
    {
      key: 'amount',
      header: t('crmInfo.amount'),
      kind: 'money',
      cell: (r) =>
        r.auto === null ? (
          muted(t('crmTotals.notComputed'))
        ) : (
          <Money value={r.auto} currency={currency} className="font-medium" />
        ),
    },
    { key: 'txCount', header: t('crmTotals.txCount'), kind: 'number', value: (r) => r.txCount, hideSm: true },
    {
      key: 'corrections',
      header: t('crmInfo.corrections'),
      kind: 'number',
      cell: (r) => excludedCell(r, t('crmInfo.correctionsHint')),
      hideSm: true,
    },
    {
      key: 'reversals',
      header: t('crmInfo.reversals'),
      kind: 'money',
      // El reverso vive en `detail`: es contraste, no un total. `undefined`
      // (la métrica no tiene reversos) o 0 se muestran «—», nunca $0.
      cell: (r) => {
        const rev = reversalsShown(r.detail);
        return rev === null ? (
          muted('—')
        ) : (
          <span title={t('crmInfo.reversalsHint')}>
            <Money value={rev} currency={currency} />
          </span>
        );
      },
      hideSm: true,
    },
    ...(activeInfoDef?.detailColumns ?? []).map<FinColumn<Row>>((c) => ({
      key: `detail-${c.key}`,
      header: locale === 'en' ? c.labelEn : c.labelEs,
      kind: 'money',
      hideSm: true,
      // `undefined` = la serie no vino en el detail (fila vieja, calculada
      // antes de que la columna existiera) → «—». `0` es un cero real.
      cell: (r) => {
        const n = detailNumber(r.detail, c.key);
        const cnt = r.detail?.[`${c.key}Count`];
        return n === null ? (
          muted('—')
        ) : (
          <span title={typeof cnt === 'number' ? `${cnt}` : undefined}>
            <Money value={n} currency={currency} />
          </span>
        );
      },
    })),
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t('crmTotals.title')} subtitle={t('crmTotals.subtitle')} />

      {failed && <Notice kind="bad" title={t('crmTotals.loadFailed')} />}

      {/* Recorte del endpoint: un recorte silencioso es indistinguible de
          «no hay más meses» (reglas §1.2). */}
      {truncated && <Notice kind="pend" title={t('crmTotals.truncated')} />}

      <Notice kind="info" title={t('crmTotals.lm.explainerTitle')}>
        {t('crmTotals.explainer')}
      </Notice>

      {rows === null ? (
        <Skeleton className="h-64 w-full" />
      ) : withData.length === 0 ? (
        <Panel>
          <EmptyState icon={Database} title={t('crmTotals.emptyTitle')} description={t('crmTotals.emptyDesc')} />
        </Panel>
      ) : (
        <Panel
          flush
          title={activeDef ? label(activeDef) : t('crmTotals.title')}
          hint={
            <span className="inline-flex flex-wrap items-center gap-2">
              {t('crmTotals.lm.monthsHint', { count: String(visible.length) })}
              {activeDef && isOutsideResult(activeDef) && outsideBadge}
            </span>
          }
          actions={
            withData.length > 1 ? (
              <Segmented
                aria-label={t('crmTotals.lm.metricAria')}
                value={activeMetric}
                onChange={setMetric}
                options={withData.map((m) => ({ value: m.key, label: label(m) }))}
              />
            ) : undefined
          }
          footer={
            lastComputed ? (
              <span>
                {t('crmTotals.computedAt')}: {new Date(lastComputed).toLocaleString()}
              </span>
            ) : undefined
          }
        >
          <FinTable
            columns={columns}
            rows={visible}
            rowKey={rowKey}
            caption={activeDef ? label(activeDef) : t('crmTotals.title')}
          />
        </Panel>
      )}

      {/* ── DATOS DEL CRM QUE NO CUENTAN EN EL RESULTADO ──────────────────
          Separada a propósito: sin columna manual, sin diferencia, sin
          sumarse a nada. La advertencia va ARRIBA de la tabla y no en un
          pie, porque el riesgo es que alguien lea el número antes de leer
          la aclaración. */}
      {rows !== null && infoWithData.length > 0 && (
        <section
          aria-labelledby="crm-info-title"
          className="mt-2 space-y-4 border-t border-dashed border-border-strong pt-6"
        >
          <div>
            <h2 id="crm-info-title" className="text-[15px] font-semibold tracking-[-0.005em] text-foreground">
              {t('crmInfo.title')}
            </h2>
            <p className="mt-0.5 text-[13px] text-text-2">{t('crmInfo.subtitle')}</p>
          </div>

          <Notice kind="pend" title={t('crmInfo.warningTitle')}>
            {t('crmInfo.warningBody')}
          </Notice>

          <Panel
            flush
            title={activeInfoDef ? label(activeInfoDef) : t('crmInfo.title')}
            hint={outsideBadge}
            actions={
              infoWithData.length > 1 ? (
                <Segmented
                  aria-label={t('crmTotals.lm.infoMetricAria')}
                  value={activeInfoMetric}
                  onChange={setInfoMetric}
                  options={infoWithData.map((m) => ({ value: m.key, label: label(m) }))}
                />
              ) : undefined
            }
            footer={t('crmInfo.footnote')}
          >
            {activeInfoDef && (
              <p className="border-b border-border px-4 py-2.5 text-[13px] text-text-2">
                {locale === 'en' ? activeInfoDef.whyNotFinanceEn : activeInfoDef.whyNotFinanceEs}
              </p>
            )}
            <FinTable
              columns={infoColumns}
              rows={infoVisible}
              rowKey={rowKey}
              caption={activeInfoDef ? label(activeInfoDef) : t('crmInfo.title')}
            />
          </Panel>
        </section>
      )}
    </div>
  );
}
