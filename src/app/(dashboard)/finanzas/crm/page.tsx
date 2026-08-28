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
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Database, Info } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { formatCurrency } from '@/lib/utils';
import { CRM_MONTHLY_COMPARED_METRICS, CRM_MONTHLY_INFO_METRICS } from '@/lib/crm-monthly';

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

/** Debajo del centavo es redondeo, no una diferencia. */
const EPSILON = 0.009;

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
  const money = (n: number) => formatCurrency(n, currency);
  const label = (m: { labelEs: string; labelEn: string }) => (locale === 'en' ? m.labelEn : m.labelEs);
  const monthLabel = (r: Row) => r.periodLabel ?? `${r.year}-${String(r.month).padStart(2, '0')}`;

  const lastComputed = visible.map((r) => r.computedAt).filter(Boolean).sort().pop() ?? null;
  const activeInfoDef = infoWithData.find((m) => m.key === activeInfoMetric) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title={t('crmTotals.title')} subtitle={t('crmTotals.subtitle')} />

      {failed && (
        <Card className="p-4 border-destructive/40">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="w-4 h-4" />
            {t('crmTotals.loadFailed')}
          </div>
        </Card>
      )}

      {truncated && (
        <Card className="p-4">
          <div className="flex items-center gap-2 text-sm text-amber-600">
            <AlertTriangle className="w-4 h-4" />
            {t('crmTotals.truncated')}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <p>{t('crmTotals.explainer')}</p>
        </div>
      </Card>

      {rows === null ? (
        <Skeleton className="h-64 w-full" />
      ) : withData.length === 0 ? (
        <EmptyState
          icon={Database}
          title={t('crmTotals.emptyTitle')}
          description={t('crmTotals.emptyDesc')}
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {withData.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMetric(m.key)}
                className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                  activeMetric === m.key
                    ? 'bg-primary text-brand-on-primary border-primary'
                    : 'bg-background hover:bg-muted border-border'
                }`}
              >
                {label(m)}
              </button>
            ))}
          </div>

          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">{t('crmTotals.month')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('crmTotals.auto')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('crmTotals.manual')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('crmTotals.difference')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('crmTotals.txCount')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('crmTotals.excluded')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const dif =
                      r.auto === null || r.manual === null ? null : r.auto - r.manual;
                    return (
                      <tr key={`${r.year}-${r.month}`} className="border-t border-border">
                        <td className="px-4 py-2">
                          {monthLabel(r)}
                          {r.periodClosed ? (
                            <Badge variant="neutral" className="ml-2">{t('crmTotals.closed')}</Badge>
                          ) : null}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.auto === null ? (
                            <span className="text-muted-foreground">{t('crmTotals.notComputed')}</span>
                          ) : (
                            money(r.auto)
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.manual === null ? (
                            <span className="text-muted-foreground">{t('crmTotals.notLoaded')}</span>
                          ) : (
                            money(r.manual)
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {dif === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : Math.abs(dif) < EPSILON ? (
                            <span className="text-muted-foreground">{money(0)}</span>
                          ) : (
                            <span className="text-amber-600">{money(dif)}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{r.txCount}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.excludedCount === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span title={t('crmTotals.excludedHint')}>
                              {r.excludedCount} · {money(r.excludedAmount)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {lastComputed && (
            <p className="text-xs text-muted-foreground">
              {t('crmTotals.computedAt')}: {new Date(lastComputed).toLocaleString()}
            </p>
          )}
        </>
      )}

      {/* ── DATOS DEL CRM QUE NO CUENTAN EN EL RESULTADO ──────────────────
          Separada a propósito: sin columna manual, sin diferencia, sin
          sumarse a nada. La advertencia va ARRIBA de la tabla y no en un
          pie, porque el riesgo es que alguien lea el número antes de leer
          la aclaración. */}
      {rows !== null && infoWithData.length > 0 && (
        <div className="pt-6 mt-2 border-t-2 border-dashed border-border space-y-4">
          <div>
            <h2 className="text-lg font-semibold">{t('crmInfo.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('crmInfo.subtitle')}</p>
          </div>

          <Card className="p-4 border-amber-500/40 bg-amber-500/5">
            <div className="flex items-start gap-2 text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
              <div className="space-y-1">
                <p className="font-medium text-amber-700 dark:text-amber-500">
                  {t('crmInfo.warningTitle')}
                </p>
                <p className="text-muted-foreground">{t('crmInfo.warningBody')}</p>
              </div>
            </div>
          </Card>

          <div className="flex flex-wrap gap-2">
            {infoWithData.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setInfoMetric(m.key)}
                className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                  activeInfoMetric === m.key
                    ? 'bg-primary text-brand-on-primary border-primary'
                    : 'bg-background hover:bg-muted border-border'
                }`}
              >
                {label(m)}
              </button>
            ))}
          </div>

          {activeInfoDef && (
            <p className="text-sm text-muted-foreground">
              {locale === 'en' ? activeInfoDef.whyNotFinanceEn : activeInfoDef.whyNotFinanceEs}
            </p>
          )}

          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">{t('crmTotals.month')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('crmInfo.amount')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('crmTotals.txCount')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('crmInfo.corrections')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('crmInfo.reversals')}</th>
                  </tr>
                </thead>
                <tbody>
                  {infoVisible.map((r) => {
                    // El reverso vive en `detail`, no en una columna propia de
                    // la tabla: es contraste, no un total. `undefined` (la
                    // métrica no tiene reversos) se muestra como "—", nunca
                    // como $0.
                    const rev = r.detail?.reversals;
                    const revNum = typeof rev === 'number' ? rev : null;
                    return (
                      <tr key={`${r.year}-${r.month}`} className="border-t border-border">
                        <td className="px-4 py-2">{monthLabel(r)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.auto === null ? (
                            <span className="text-muted-foreground">{t('crmTotals.notComputed')}</span>
                          ) : (
                            money(r.auto)
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{r.txCount}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.excludedCount === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span title={t('crmInfo.correctionsHint')}>
                              {r.excludedCount} · {money(r.excludedAmount)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {revNum === null || revNum === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span title={t('crmInfo.reversalsHint')}>{money(revNum)}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <p className="text-xs text-muted-foreground">{t('crmInfo.footnote')}</p>
        </div>
      )}
    </div>
  );
}
