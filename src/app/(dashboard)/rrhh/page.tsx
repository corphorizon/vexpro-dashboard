'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { useData } from '@/lib/data-context';
import { formatCurrency, cn } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { features } from '@/lib/business-model';
import { useExport2FA } from '@/components/verify-2fa-modal';
import {
  Users, Briefcase, Download, Handshake, UserX, Receipt,
  ClipboardCheck, AlertTriangle, TrendingUp, CheckCircle, AlertCircle,
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
import { EmployeesTab, STATUS_LABEL_KEYS } from './_components/employees-tab';
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
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // Capa optimista sobre `dataEmployees`: la pestaña Empleados la actualiza al
  // crear/editar/borrar y el DataProvider la reemplaza en el próximo refresh.
  const [employees, setEmployees] = useState<Employee[]>(dataEmployees);
  useEffect(() => { setEmployees(dataEmployees); }, [dataEmployees]);

  const flash = (t2: { type: 'success' | 'error'; msg: string }) => {
    setToast(t2);
    setTimeout(() => setToast(null), 4000);
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
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">{t('common.noAccess')}</p>
      </div>
    );
  }

  const tabButton = (key: Tab, Icon: typeof Users, label: string, extra?: React.ReactNode) => (
    <button
      onClick={() => setTab(key)}
      className={cn(
        'px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-colors whitespace-nowrap',
        tab === key ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="w-4 h-4 inline mr-1 sm:mr-2" />
      {label}
      {extra}
    </button>
  );

  return (
    <div className="space-y-6">
      {Modal2FA}
      {toast && (
        <div className={cn('flex items-center gap-2 px-4 py-3 rounded-lg text-sm', toast.type === 'success' ? 'bg-positive/10 text-positive border border-positive/30' : 'bg-negative/10 text-negative border border-negative/30')}>
          {toast.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      <PageHeader
        title={t('hr.title')}
        subtitle={t('hr.subtitle')}
        icon={Users}
        actions={
          <Button
            onClick={tab === 'employees' || tab === 'terminated' ? handleExportEmployees : handleExportCommercial}
            title={t('common.csv')}
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">{t('common.csv')}</span>
          </Button>
        }
      />

      {/* KPI Cards */}
      <div className={cn('grid grid-cols-1 gap-4', hasCommercialTeam && 'md:grid-cols-3')}>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-info/10"><Users className="w-5 h-5 text-blue-500" /></div>
            <span className="text-sm text-muted-foreground">{t('hr.employees')}</span>
          </div>
          <p className="text-2xl font-bold">{employees.length}</p>
        </Card>
        {hasCommercialTeam && (
        <>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-violet-50 dark:bg-violet-950/50"><Briefcase className="w-5 h-5 text-violet-500" /></div>
            <span className="text-sm text-muted-foreground">{t('hr.activeForce')}</span>
          </div>
          <p className="text-2xl font-bold">{activeProfiles}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-positive/10"><Briefcase className="w-5 h-5 text-emerald-500" /></div>
            <span className="text-sm text-muted-foreground">{t('hr.totalCommissions')}</span>
          </div>
          <p className="text-2xl font-bold">{formatCurrency(totalCommissionsFiltered)}</p>
        </Card>
        </>
        )}
      </div>

      {/* Tabs — flex-wrap y no overflow-x: con nueve pestañas la fila única
          escondía las últimas fuera de pantalla sin ningún indicador (Kevin,
          2026-08-31: «no lo veo»). En Mac el scrollbar ni se dibuja. */}
      <div className="flex flex-wrap gap-1 bg-muted p-1 rounded-lg w-fit max-w-full">
        {tabButton('employees', Users, t('hr.employees'))}
        {tabButton('terminated', UserX, t('hr.terminatedTab'),
          despedidos.length > 0 ? (
            <span className="ml-1.5 text-[11px] text-muted-foreground">({despedidos.length})</span>
          ) : null,
        )}
        {hasCommercialTeam && (
          <>
            {tabButton('commercial', Briefcase, t('hr.commercialForce'))}
            {tabButton('negotiations', Handshake, t('hr.negotiations'))}
            {tabButton('ib_negotiations', Handshake, t('hr.ibNegotiationsTab'))}
            {hasIbRebatesAccess && tabButton('ib_rebates', Receipt, t('hr.ibConfigTab'))}
            {tabButton('onboarding', ClipboardCheck, t('hr.onboardingTab'))}
            {tabButton('warnings', AlertTriangle, t('hr.warningsTab'))}
            {tabButton('net_deposit', TrendingUp, t('hr.netDepositTab'))}
          </>
        )}
      </div>

      {/* EL selector de período — uno solo para todo el módulo. Se esconde en
          las pestañas donde el tiempo no significa nada (una negociación
          abierta no es un dato de un mes): mostrarlo ahí sugeriría que filtra
          algo, que es peor que no mostrarlo. */}
      {!(TABS_SIN_PERIODO as readonly string[]).includes(tab) && (
        <Card>
          <HrPeriodSelector showPresets={(TABS_CON_PRESETS as readonly string[]).includes(tab)} />
        </Card>
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
