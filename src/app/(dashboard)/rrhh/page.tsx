'use client';

import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { Segmented, type SegmentedOption } from '@/components/ui/segmented';
import { useToasts } from '@/components/ui/toast';
import { ActionButton } from '@/components/payment-orders/action-button';
import { useData } from '@/lib/data-context';
import { downloadCSV } from '@/lib/csv-export';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { features } from '@/lib/business-model';
import { useExport2FA } from '@/components/verify-2fa-modal';
import {
  Users, Briefcase, Download, Handshake, UserX, Receipt,
  ClipboardCheck, AlertTriangle, TrendingUp,
} from 'lucide-react';
import type { Employee } from '@/lib/types';
import { hrRoleLabel } from '@/lib/hr/domain';
import {
  buildUnifiedEmployees,
  filterUnifiedEmployees,
  partitionByFired,
} from '@/lib/hr/employees-list';
import {
  totalesDe,
  totalesPorPerfil,
  type MonthlyResultRow,
} from '@/lib/hr/monthly-totals';
import { IbRebatesTab } from './_components/ib-rebates-tab';
import { OnboardingTab } from './_components/onboarding-tab';
import { WarningsTab } from './_components/warnings-tab';
import { NetDepositTab } from './_components/net-deposit-tab';
import { IbNegotiationsTab } from './_components/ib-negotiations-tab';
import { EmployeesTab } from './_components/employees-tab';
import { STATUS_LABEL_KEYS } from './_components/hr-view';
import { CommercialTab } from './_components/commercial-tab';
import { NegotiationsTab } from './_components/negotiations-tab';
import { HrPeriodProvider, useHrPeriod } from './_components/hr-period-context';
import { HrPeriodSelector } from './_components/period-selector';

// ─────────────────────────────────────────────────────────────────────────────
// /rrhh — SHELL del módulo: pestañas, selector de período y guardas. Nada más.
//
// ── Qué pasó acá el 2026-08-31 ─────────────────────────────────────────────
// Este archivo tenía 2.285 líneas y 76 `useState`: cuatro pestañas, tres
// formularios modales, las tarjetas de equipo y los CSV, todo inline, mientras
// las otras seis pestañas ya vivían en `_components/`. Cada pestaña además
// cargaba sus datos por su lado y con SU PROPIO criterio de fecha — tres
// relojes distintos (ver src/lib/hr/period-filter.ts).
//
// Ahora:
//  · Las nueve pestañas viven en `_components/`.
//  · El período se elige UNA vez, acá arriba, y baja por
//    <HrPeriodProvider> a todas (rrhh/_components/hr-period-context.tsx).
//  · Los datos del mes se piden UNA vez a /api/admin/hr-overview y se
//    comparten; cambiar de pestaña no refetchea.
//  · Los roles, la jerarquía y los predicados salen del registro único
//    (src/lib/hr/domain.ts), no de literales repetidos en la pantalla.
//
// Lo que NO cambió: los números. La unificación del net del CRM con lo cargado
// a mano es la tanda 2 — acá siguen viajando uno al lado del otro.
//
// `terminated` vive al lado de `employees` y no adentro: Daniela lo pidió así
// —«arribita, empleados y al lado despedidos»— y son la misma lista partida en
// dos, no una lista con un filtro escondido. Nadie se borra nunca.
// `ib_negotiations` es OTRA COSA que `negotiations`: aquélla es de perfiles
// comerciales y ésta de IBs del CRM (Kevin, «por aparte», 2026-08-27).
//
// ── «Libro mayor» (2026-10-12) ─────────────────────────────────────────────
// Sólo presentación: tres StatCard con ícono de color → KpiStrip (una
// superficie); las nueve pestañas → Segmented que ENVUELVE (`flex-wrap`, el
// mismo criterio del 2026-08-31: una fila con scroll escondía las últimas);
// el selector de período dentro de un Panel; los avisos de éxito/error van al
// toast flotante (`useToasts`) en vez de un banner verde/rojo arriba de todo,
// que quedaba fuera de vista al guardar desde el final de una tabla larga.
// Medición (sin comentarios): antes 5 clases de paleta cruda, 1 `dark:`,
// 1 `text-[11px]` y 15 tokens legados; después 0 en todo.
// DESCARTADO: `SectionTabs` (ui/section-tabs.tsx) — pinta el activo con
// `bg-[var(--color-primary)] text-white`, el relleno de marca que la spec
// reserva para el único botón primario.
// ─────────────────────────────────────────────────────────────────────────────

type Tab = 'employees' | 'terminated' | 'commercial' | 'negotiations' | 'ib_negotiations' | 'ib_rebates' | 'onboarding' | 'warnings' | 'net_deposit';

const RESTORABLE_TABS: readonly Tab[] = [
  'employees', 'terminated', 'commercial', 'negotiations', 'ib_negotiations', 'ib_rebates', 'onboarding', 'warnings', 'net_deposit',
] as const;

/** Las pestañas que miran PERÍODOS CONTABLES y por lo tanto usan los presets. */
const TABS_CON_PRESETS: readonly Tab[] = ['commercial'] as const;

/** Las pestañas donde el selector de período no significa nada. */
const TABS_SIN_PERIODO: readonly Tab[] = [
  'employees', 'terminated', 'negotiations', 'ib_negotiations', 'ib_rebates', 'onboarding',
] as const;

export default function RRHHPage() {
  // El provider envuelve TODO el módulo: el selector y las pestañas tienen que
  // leer el mismo reloj, y montarlo adentro de una pestaña lo reiniciaría al
  // cambiar de pestaña.
  return (
    <HrPeriodProvider>
      <RRHHShell />
    </HrPeriodProvider>
  );
}

function RRHHShell() {
  const { t } = useI18n();
  const { company, employees: dataEmployees, commercialProfiles: profiles, monthlyResults } = useData();
  const { user } = useAuth();
  const { periodIds } = useHrPeriod();

  // Module gate — igual que el resto de las pantallas de módulo. /rrhh era el
  // outlier: se renderizaba sin chequear, así que un usuario de un tenant sin
  // `hr` en active_modules podía entrar por URL y ver empleados. El bypass de
  // superadmin está adentro del hook.
  const canAccess = useModuleAccess('hr');
  // Sub-módulo independiente: comparte el módulo padre 'hr' para vivir bajo
  // /rrhh sin abrir un módulo top-level nuevo.
  const hasIbRebatesAccess = useModuleAccess('ib_rebates');
  // Una empresa de servicios lleva empleados y nada más: sin fuerza comercial no
  // hay perfiles, negociaciones, rebates ni onboarding que mostrar.
  const hasCommercialTeam = features(company?.business_model).commercialTeam;

  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const [tab, setTab] = useState<Tab>(hasCommercialTeam ? 'commercial' : 'employees');
  const { toast, ToastHost } = useToasts();
  const [searchQuery, setSearchQuery] = useState('');
  // Capa optimista sobre `dataEmployees`: la pestaña Empleados la actualiza al
  // crear/editar/borrar y el DataProvider la reemplaza en el próximo refresh.
  const [employees, setEmployees] = useState<Employee[]>(dataEmployees);
  useEffect(() => { setEmployees(dataEmployees); }, [dataEmployees]);

  const flash = (t2: { type: 'success' | 'error'; msg: string }) => {
    if (t2.type === 'success') toast.success(t2.msg);
    else toast.error(t2.msg);
  };

  // `company` puede llegar después del primer render: si la pestaña activa no
  // existe para el modelo de negocio, se cae a Empleados en vez de dejar la
  // pantalla en blanco. Despedidos SÍ existe sin fuerza comercial: una empresa
  // de servicios también despide gente.
  useEffect(() => {
    if (!hasCommercialTeam && tab !== 'employees' && tab !== 'terminated') setTab('employees');
  }, [hasCommercialTeam, tab]);

  // Restaurar la pestaña activa después de un reload disparado por una acción
  // (ej. despedir). Flag de un solo uso: se lee y se borra, así una navegación
  // normal a /rrhh sigue cayendo en 'commercial'.
  useEffect(() => {
    try {
      const restore = sessionStorage.getItem('rrhh-restore-tab');
      if (restore) {
        // Registro único: las pestañas válidas son RESTORABLE_TABS, no un `||`
        // que se olvida de actualizar al agregar una.
        if ((RESTORABLE_TABS as readonly string[]).includes(restore)) setTab(restore as Tab);
        sessionStorage.removeItem('rrhh-restore-tab');
      }
    } catch {
      // sessionStorage puede no estar disponible (SSR / modo privado)
    }
  }, []);

  // ─── La plantilla unificada: UNA derivación para la tabla y para el CSV ───
  const unificados = useMemo(
    () => buildUnifiedEmployees(employees, profiles),
    [employees, profiles],
  );
  const { activos, despedidos } = useMemo(
    () => partitionByFired(filterUnifiedEmployees(unificados, searchQuery)),
    [unificados, searchQuery],
  );
  const employeesTabList = tab === 'terminated' ? despedidos : activos;

  const totales = useMemo(
    () => totalesPorPerfil(monthlyResults as unknown as MonthlyResultRow[], periodIds),
    [monthlyResults, periodIds],
  );
  const totalCommissionsFiltered = useMemo(
    () => [...totales.values()].reduce((s, v) => s + v.total, 0),
    [totales],
  );
  const activeProfiles = profiles.filter(p => p.status === 'active').length;

  const handleExportEmployees = () => verify2FA(() => {
    // Exporta lo mismo que se ve: la lista de LA PESTAÑA (en Despedidos, los
    // despedidos) con el filtro del buscador ya aplicado.
    const headers = [
      t('common.name'), t('common.email'), t('hr.position'), t('hr.department'),
      t('hr.type'), t('hr.hireDate'), t('hr.terminationDate'),
      t('hr.salary'), t('hr.status'),
    ];
    const rows = employeesTabList.map(e => [
      e.name, e.email, e.position, e.department,
      e.source === 'commercial' ? t('hr.typeCommercial') : t('hr.typeAdmin'),
      e.start_date || '',
      e.termination_date || '',
      e.salary ?? 'N/A',
      t(STATUS_LABEL_KEYS[e.status]),
    ] as (string | number)[]);
    downloadCSV('empleados.csv', headers, rows);
  });

  const handleExportCommercial = () => verify2FA(() => {
    const headers = [t('common.name'), t('common.email'), t('hr.role'), t('hr.netDepPct'), t('hr.pnlPct'), t('hr.commLotPlaceholder'), t('hr.salary'), t('hr.total')];
    // El total sale del MISMO camino que la tabla (hr/monthly-totals.ts): antes
    // había dos `reduce` distintos y el día que se agregara una columna una de
    // las dos copias se olvidaba.
    const rows = profiles.map(p => [
      p.name, p.email, hrRoleLabel(p.role),
      p.net_deposit_pct != null ? `${p.net_deposit_pct}%` : 'N/A',
      p.pnl_pct != null ? `${p.pnl_pct}%` : 'N/A',
      p.commission_per_lot != null ? p.commission_per_lot : 'N/A',
      p.fixed_salary && p.salary != null ? p.salary : 'N/A',
      totalesDe(totales, p.id).total,
    ] as (string | number)[]);
    downloadCSV('fuerza_comercial.csv', headers, rows);
  });

  if (!canAccess) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-text-2">{t('common.noAccess')}</p>
      </div>
    );
  }

  // Las pestañas, en el orden de siempre. Ícono + nombre; Despedidos lleva el
  // conteo (sólo si hay: un «0» al lado no agrega nada y `null` no se dibuja).
  const tabLabel = (Icon: typeof Users, label: string) => (
    <>
      <Icon aria-hidden className="size-[15px] shrink-0" strokeWidth={1.75} />
      {label}
    </>
  );
  const tabOptions: SegmentedOption<Tab>[] = [
    { value: 'employees', label: tabLabel(Users, t('hr.employees')) },
    {
      value: 'terminated',
      label: tabLabel(UserX, t('hr.terminatedTab')),
      count: despedidos.length > 0 ? despedidos.length : null,
    },
    ...(hasCommercialTeam
      ? ([
          { value: 'commercial', label: tabLabel(Briefcase, t('hr.commercialForce')) },
          { value: 'negotiations', label: tabLabel(Handshake, t('hr.negotiations')) },
          { value: 'ib_negotiations', label: tabLabel(Handshake, t('hr.ibNegotiationsTab')) },
          ...(hasIbRebatesAccess ? [{ value: 'ib_rebates' as const, label: tabLabel(Receipt, t('hr.ibConfigTab')) }] : []),
          { value: 'onboarding', label: tabLabel(ClipboardCheck, t('hr.onboardingTab')) },
          { value: 'warnings', label: tabLabel(AlertTriangle, t('hr.warningsTab')) },
          { value: 'net_deposit', label: tabLabel(TrendingUp, t('hr.netDepositTab')) },
        ] satisfies SegmentedOption<Tab>[])
      : []),
  ];

  const kpis: KpiItem[] = [
    { key: 'employees', label: t('hr.employees'), value: employees.length, format: 'count' },
    ...(hasCommercialTeam
      ? ([
          { key: 'force', label: t('hr.activeForce'), value: activeProfiles, format: 'count' },
          {
            key: 'commissions',
            label: t('hr.totalCommissions'),
            value: totalCommissionsFiltered,
            hero: true,
            // El total respeta el preset de la pestaña Comercial (hr/monthly-totals.ts).
            sub: t('hrv.periodsInScope', { n: String(periodIds.length) }),
          },
        ] satisfies KpiItem[])
      : []),
  ];

  return (
    <div className="space-y-4">
      {Modal2FA}
      {ToastHost}

      <PageHeader
        title={t('hr.title')}
        subtitle={t('hr.subtitle')}
        actions={
          <ActionButton
            onClick={tab === 'employees' || tab === 'terminated' ? handleExportEmployees : handleExportCommercial}
            title={t('common.csv')}
            aria-label={t('common.csv')}
          >
            <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
            <span className="max-sm:hidden">{t('common.csv')}</span>
          </ActionButton>
        }
      />

      <KpiStrip items={kpis} />

      {/* Tabs — flex-wrap y no overflow-x: con nueve pestañas la fila única
          escondía las últimas fuera de pantalla sin ningún indicador (Kevin,
          2026-08-31: «no lo veo»). En Mac el scrollbar ni se dibuja. */}
      <Segmented
        options={tabOptions}
        value={tab}
        onChange={setTab}
        aria-label={t('hr.title')}
        className="max-w-full flex-wrap"
      />

      {/* EL selector de período — uno solo para todo el módulo. Se esconde en
          las pestañas donde el tiempo no significa nada (una negociación
          abierta no es un dato de un mes): mostrarlo ahí sugeriría que filtra
          algo, que es peor que no mostrarlo. */}
      {!(TABS_SIN_PERIODO as readonly string[]).includes(tab) && (
        <Panel flush bodyClassName="px-4 py-3">
          <HrPeriodSelector showPresets={(TABS_CON_PRESETS as readonly string[]).includes(tab)} />
        </Panel>
      )}

      {tab === 'warnings' && hasCommercialTeam && <WarningsTab profiles={profiles} />}
      {tab === 'ib_negotiations' && hasCommercialTeam && <IbNegotiationsTab />}
      {tab === 'net_deposit' && hasCommercialTeam && <NetDepositTab />}
      {tab === 'ib_rebates' && hasIbRebatesAccess && hasCommercialTeam && <IbRebatesTab />}
      {tab === 'onboarding' && hasCommercialTeam && <OnboardingTab profiles={profiles} />}

      {(tab === 'employees' || tab === 'terminated') && (
        <EmployeesTab
          tab={tab}
          list={employeesTabList}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          setEmployees={setEmployees}
          onToast={flash}
        />
      )}

      {tab === 'commercial' && hasCommercialTeam && <CommercialTab onToast={flash} />}

      {tab === 'negotiations' && hasCommercialTeam && <NegotiationsTab onToast={flash} />}
    </div>
  );
}
