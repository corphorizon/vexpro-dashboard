'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { useData } from '@/lib/data-context';
import type { CommercialMonthlyResult } from '@/lib/types';
import { useAuth, isCompanyAdmin } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { useI18n } from '@/lib/i18n';
import { formatCurrency, cn } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
// Lazy-loaded (Kevin 2026-06-06 code review): jspdf + jspdf-autotable
// se cargan solo al hacer click en cualquier botón "Exportar PDF". Antes
// estaban static-imported y se incluían en el bundle de /comisiones (~700KB).
// Llama a `loadPdfExports()` antes de invocar generateCommissionPDF, etc.
async function loadPdfExports() {
  return import('@/lib/pdf-export');
}
import { useExport2FA } from '@/components/verify-2fa-modal';
import { FiredBadge, firedNameClass } from '@/components/fired-badge';
import {
  calculateCommission,
  calculateGroupSummary,
  calculateSalaryFromND,
  calculateHeadSalaryFromND,
  prorateFixedSalary,
  calculateBdmPctFromND,
  getAccumulatedIn,
  calculatePnlSpecial,
  SALARY_TIERS,
  HEAD_SALARY_TIERS,
  BDM_PCT_TIERS,
  applyTotalEarnedDebt,
  calculateExtraOverHeadCommission,
  type CommissionCalcResult,
} from '@/lib/commission-calculator';
import { upsertCommissionEntries, type CommissionEntryRow } from '@/lib/supabase/mutations';
import { apiFetch } from '@/lib/api-fetch';
import { comisionIndividualDeBdm } from '@/lib/hr/commission-preview';
import {
  antesDelCorteHrNet,
  netParaElMotor,
  resolveNetDepositInput,
  type NetDepositSource,
  type ResolvedNetDeposit,
} from '@/lib/hr/net-deposit-input';
import {
  Calculator,
  Save,
  Download,
  ChevronLeft,
  ChevronRight,
  CheckCircle,
  AlertCircle,
  Info,
  UserCircle,
  Users,
  BarChart3,
  FileText,
  FileSpreadsheet,
  ChevronDown,
  Loader2,
  Sparkles,
  RefreshCw,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// `appearsInCommissions`
//
// Un perfil aparece en el calculador de comisiones cuando es:
//   - activo, O
//   - despedido (status='inactive' + termination_date seteado).
//
// NO aparecen los inactivos SIN termination_date (licencia/pausa — quedan
// fuera del calculador por ahora). La distinción existe porque hay que
// seguir cargando net deposits negativos post-despido contra el profile_id
// del BDM despedido.
//
// Helper único: antes los 10 filtros del archivo usaban `status === 'active'`
// y los despedidos desaparecían silenciosamente del calculador. Usar este
// predicado evita que vuelva a pasar si cambian los criterios.
// ─────────────────────────────────────────────────────────────────────────────
function appearsInCommissions(p: { status: string; termination_date?: string | null }): boolean {
  if (p.status === 'active') return true;
  if (p.status === 'inactive' && p.termination_date) return true;
  return false;
}

const ROLE_BADGE: Record<string, string> = {
  sales_manager: 'bg-warning/10 text-warning',
  head: 'bg-violet-50 dark:bg-violet-950/50 text-violet-700 dark:text-violet-400',
  bdm: 'bg-info/10 text-info',
  bdm_global: 'bg-purple-100 dark:bg-purple-950/50 text-purple-800 dark:text-purple-300 border border-purple-300',
};
const ROLE_LABEL: Record<string, string> = { sales_manager: 'Sales Manager', head: 'HEAD', bdm: 'BDM', bdm_global: 'BDM GLOBAL' };

type Tab = 'teams' | 'individual' | 'history';

/**
 * El rótulo de procedencia del insumo, debajo del input de ND.
 *
 * Existe porque el número dejó de tener una sola fuente: puede venir del rollup
 * del CRM, de un override cargado a mano, de un período congelado, o no existir.
 * Sin el rótulo, las cuatro cosas se ven idénticas en pantalla — y "no lo
 * sabemos" mostrado como $0 es el modo de falla que este repo persigue (§1.2).
 *
 * `auto` es el automático del mes: se muestra AL LADO del override para que
 * quien lo cargó a mano vea contra qué está corrigiendo.
 */
function NdSourceTag({
  source,
  auto,
  labels,
}: {
  source: NetDepositSource;
  auto: number | null;
  labels: (k: string) => string;
}) {
  if (source === 'crm') {
    return <span className="block text-[10px] uppercase tracking-wide text-positive/80 mt-0.5">{labels('comm.ndSourceCrm')}</span>;
  }
  if (source === 'manual') {
    return (
      <span className="block text-[10px] mt-0.5 text-warning" title={labels('comm.ndOverrideHint')}>
        {labels('comm.ndSourceManual')}
        {auto !== null && (
          <span className="ml-1 text-muted-foreground normal-case">({labels('comm.ndAutoRef')} {formatCurrency(auto)})</span>
        )}
      </span>
    );
  }
  if (source === 'frozen') {
    return <span className="block text-[10px] uppercase tracking-wide text-muted-foreground mt-0.5">{labels('comm.ndSourceFrozen')}</span>;
  }
  return <span className="block text-[10px] text-muted-foreground mt-0.5">{labels('comm.ndSourceNone')}</span>;
}

// ═══════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════

/**
 * Decide si una fila matchea el query de búsqueda. Búsqueda libre
 * case-insensitive sobre nombre, email, head/rol asignado, y cualquier
 * monto numérico que esté como propiedad del objeto.
 *
 * Acepta cualquier objeto con shape de comercial calculado (con .profileId
 * o nombre/email directos). Hace lookup del nombre/email/head del profile
 * usando los mapas disponibles, ya que muchas estructuras solo tienen
 * profileId. Si el query está vacío, retorna true (no filtra).
 */
function matchesCommissionSearch(
  row: Record<string, unknown>,
  query: string,
  profileLookup?: Map<string, { name?: string; email?: string; head_id?: string | null; role?: string }>,
  headLookup?: Map<string, { name?: string }>,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const parts: string[] = [];

  // Si row es un profile directo (tab History — usa allProfiles)
  if (typeof row.name === 'string') parts.push(row.name);
  if (typeof row.email === 'string') parts.push(row.email);
  if (typeof row.role === 'string') parts.push(row.role);

  // Si row es un cálculo (tab Teams / Individual — usa bdmCalcs etc)
  const profileId = row.profileId as string | undefined;
  if (profileId && profileLookup) {
    const profile = profileLookup.get(profileId);
    if (profile?.name) parts.push(profile.name);
    if (profile?.email) parts.push(profile.email);
    if (profile?.role) parts.push(profile.role);
    if (profile?.head_id && headLookup) {
      const head = headLookup.get(profile.head_id);
      if (head?.name) parts.push(head.name);
    }
  }

  // Montos numéricos del row (cualquier propiedad number), un nivel de anidación
  for (const [, value] of Object.entries(row)) {
    if (typeof value === 'number') parts.push(String(value));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [, sub] of Object.entries(value as Record<string, unknown>)) {
        if (typeof sub === 'number') parts.push(String(sub));
        if (typeof sub === 'string') parts.push(sub);
      }
    }
  }

  return parts.join(' ').toLowerCase().includes(q);
}

export default function ComisionesPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const canAccess = useModuleAccess('commissions');
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const {
    company,
    periods,
    commercialProfiles,
    monthlyResults,
    getProfilesByHead,
    getPreviousPeriodResults,
    refresh,
    patchMonthlyResults,
  } = useData();

  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>((searchParams.get('tab') as Tab) || 'teams');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // Buscadores independientes por tab. Filtran solo las filas que se muestran
  // en cada tabla — los totales y contadores siguen reflejando el dataset
  // completo del período.
  const [teamsSearch, setTeamsSearch] = useState('');
  const [individualSearch, setIndividualSearch] = useState('');
  const [historySearch, setHistorySearch] = useState('');

  // ─── Shared: Periods ───
  const sortedPeriods = useMemo(
    () => [...periods].sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month)),
    [periods],
  );

  // Restore period from URL param if available
  const savedPeriodId = searchParams.get('period');
  const initialPeriodIdx = savedPeriodId
    ? Math.max(0, sortedPeriods.findIndex((p) => p.id === savedPeriodId))
    : Math.max(0, sortedPeriods.length - 1);
  const [periodIdx, setPeriodIdx] = useState(initialPeriodIdx);
  const selectedPeriod = sortedPeriods[periodIdx] ?? null;
  // Año/mes del período seleccionado — usados para prorratear el salario fijo
  // en el mes de ingreso (prorateFixedSalary). Primitivos para deps limpias.
  const periodYear = selectedPeriod?.year ?? 0;
  const periodMonth = selectedPeriod?.month ?? 0;

  const existingResults = useMemo(() => {
    if (!selectedPeriod) return [];
    return monthlyResults.filter((r) => r.period_id === selectedPeriod.id);
  }, [selectedPeriod, monthlyResults]);

  const navigatePeriod = (d: -1 | 1) => setPeriodIdx((p) => Math.max(0, Math.min(sortedPeriods.length - 1, p + d)));

  // ═══════════════════════════════════════════════════════════
  // TAB: TEAMS (HEAD + BDMs with differential)
  // ═══════════════════════════════════════════════════════════

  const heads = useMemo(() => {
    const list = commercialProfiles.filter((p) => p.role === 'head' || p.role === 'sales_manager' || commercialProfiles.some((sub) => sub.head_id === p.id));
    const roleOrder: Record<string, number> = { sales_manager: 0, head: 1, bdm: 2 };
    return list.sort((a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9));
  }, [commercialProfiles]);

  // Lookup maps para que el buscador resuelva nombre/email/head a partir de
  // profileId (los cálculos de Teams/Individual solo tienen profileId). Se
  // reconstruyen solo cuando cambian las listas base.
  const profileLookup = useMemo(() => {
    const map = new Map<string, { name?: string; email?: string; head_id?: string | null; role?: string }>();
    for (const p of commercialProfiles ?? []) {
      map.set(p.id, { name: p.name, email: p.email, head_id: p.head_id, role: p.role });
    }
    return map;
  }, [commercialProfiles]);

  const headLookup = useMemo(() => {
    const map = new Map<string, { name?: string }>();
    for (const h of heads ?? []) {
      map.set(h.id, { name: h.name });
    }
    return map;
  }, [heads]);

  const savedHeadId = searchParams.get('head');
  const [selectedHeadId, setSelectedHeadId] = useState<string>(savedHeadId || (heads[0]?.id ?? ''));

  // previousResults is defined after headProfile (see below line ~175)

  // ═══════════════════════════════════════════════════════════
  // EL INSUMO DEL MOTOR — de dónde sale `netDepositCurrent`
  //
  // La fórmula NO cambia: sigue viviendo sola en commission-calculator.ts. Lo
  // único que cambió (tanda 2, 2026-08-31) es de dónde sale el número que entra.
  // La política —automático manda, manual cargado es override, período cerrado
  // o anterior a agosto-26 queda congelado— vive entera en el resolver puro
  // `resolveNetDepositInput`, que es el MISMO que consume /rrhh. Acá sólo se le
  // pasa el contexto: qué mes, qué manual hay cargado y en qué renglón está la
  // persona (`own` cuando es el head mirándose a sí mismo, `structure` cuando es
  // un miembro del grupo — ver la cabecera de hr/net-deposit-input.ts).
  // ═══════════════════════════════════════════════════════════

  /** `YYYY-MM` del período elegido. */
  const autoMonth = selectedPeriod
    ? `${selectedPeriod.year}-${String(selectedPeriod.month).padStart(2, '0')}`
    : null;

  /**
   * ¿Este mes usa el automático? Si está cerrado o es anterior al corte, no se
   * pide siquiera: la RPC del rollup cuesta ~2 s y el número no se va a usar.
   */
  const periodoUsaAutomatico =
    !!selectedPeriod && !selectedPeriod.is_closed && !antesDelCorteHrNet(selectedPeriod);

  const [crmNet, setCrmNet] = useState<{
    month: string;
    index: Map<string, { own: number; total: number }>;
  } | null>(null);
  const [crmNetLoading, setCrmNetLoading] = useState(false);
  const [crmNetError, setCrmNetError] = useState(false);
  // Caché por mes en un ref: cambiar de head o de pestaña no vuelve a pagar la
  // RPC. Vive lo que vive la pantalla, y la clave lleva la empresa porque una
  // caché con clave global es cómo el usuario siguiente ve los datos del anterior.
  const crmNetCache = useRef(new Map<string, Map<string, { own: number; total: number }>>());

  useEffect(() => {
    if (!company?.id) return;
    if (!autoMonth || !periodoUsaAutomatico) { setCrmNet(null); setCrmNetError(false); return; }
    const clave = `${company.id}:${autoMonth}`;
    const cacheado = crmNetCache.current.get(clave);
    if (cacheado) { setCrmNet({ month: autoMonth, index: cacheado }); setCrmNetError(false); return; }

    let cancelado = false;
    setCrmNetLoading(true);
    setCrmNetError(false);
    (async () => {
      try {
        const res = await apiFetch(`/api/admin/commission-net-input?month=${autoMonth}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || 'commission-net-input failed');
        const index = new Map<string, { own: number; total: number }>(
          (json.entries as { profileId: string; own: number; total: number }[]).map((e) => [
            e.profileId,
            { own: Number(e.own) || 0, total: Number(e.total) || 0 },
          ]),
        );
        crmNetCache.current.set(clave, index);
        if (!cancelado) setCrmNet({ month: autoMonth, index });
      } catch {
        // El fallo NO se cachea como índice vacío: un árbol en cero se leería
        // como "este mes no produjo nadie" y le metería $0 al motor. Queda
        // `crmNet = null` → el resolver devuelve SIN DATOS y la pantalla lo dice.
        if (!cancelado) { setCrmNet(null); setCrmNetError(true); }
      } finally {
        if (!cancelado) setCrmNetLoading(false);
      }
    })();
    return () => { cancelado = true; };
  }, [company?.id, autoMonth, periodoUsaAutomatico]);

  /**
   * El insumo resuelto de CADA perfil, con su procedencia.
   *
   * OJO con las tablas de PnL: comparten este mismo Map de inputs y ahí el
   * número NO es un net deposit sino el PnL del mes (se guarda igual en
   * `net_deposit_current`, ver handleSaveBdm modo 'pnl'). A esos perfiles
   * —`pnl_pct` cargado— NO se les aplica el automático: meterles el net del CRM
   * les cambiaría la base del PnL en silencio, que es justo el modo de falla que
   * este repo persigue. Son 6 perfiles en Vex Pro y ninguno tiene los dos pct.
   */
  const ndResolved = useMemo((): Map<string, ResolvedNetDeposit> => {
    const out = new Map<string, ResolvedNetDeposit>();
    if (!selectedPeriod) return out;
    const results = monthlyResults.filter((r) => r.period_id === selectedPeriod.id);
    const index = crmNet && crmNet.month === autoMonth ? crmNet.index : null;

    for (const p of commercialProfiles) {
      // Buscar el registro que corresponde al grupo actual (head_id = selectedHeadId)
      // Así no se confunde con registros del mismo usuario en otros grupos
      const ex = tab === 'individual'
        ? results.find((r) => r.profile_id === p.id && r.net_deposit_current !== null)
        : results.find((r) => r.profile_id === p.id && r.head_id === selectedHeadId);
      // El HEAD del grupo seleccionado se mira a sí mismo: su ND es su PRODUCCIÓN
      // PROPIA (la «línea de ajuste»), no el total de su estructura. Cuando tiene
      // padre, ese número vive en `net_deposit_accumulated` de su fila en su
      // propio grupo — el `net_deposit_current` de ahí es del contexto del padre.
      const esElHeadDelGrupo = tab !== 'individual' && p.id === selectedHeadId;
      const hasOwnTeam = commercialProfiles.some((sub) => sub.head_id === p.id && appearsInCommissions(sub));
      let manual: number | null;
      if (esElHeadDelGrupo && hasOwnTeam && p.head_id) {
        const ownGroupResult = monthlyResults.find(
          (r) => r.profile_id === p.id
            && r.period_id === selectedPeriod.id
            && r.head_id === selectedHeadId
        );
        manual = ownGroupResult?.net_deposit_accumulated ?? null;
      } else {
        manual = ex?.net_deposit_current ?? null;
      }

      out.set(
        p.id,
        resolveNetDepositInput({
          profileId: p.id,
          period: selectedPeriod,
          scope: esElHeadDelGrupo ? 'own' : 'structure',
          crm: p.pnl_pct != null ? null : index,
          manual,
        }),
      );
    }
    return out;
  }, [commercialProfiles, selectedPeriod, monthlyResults, selectedHeadId, tab, crmNet, autoMonth]);

  // SHARED ND inputs — one Map for all profiles, synced between tabs
  const [ndInputs, setNdInputs] = useState<Map<string, number>>(new Map());
  // Store raw string for display (allows empty field + typing negatives)
  const [ndRawInputs, setNdRawInputs] = useState<Map<string, string>>(new Map());
  // Espejo en un ref de lo que se está tecleando, para que el efecto de seeding
  // sepa qué NO pisar sin tener que re-correr en cada tecla.
  const ndRawRef = useRef(ndRawInputs);
  useEffect(() => { ndRawRef.current = ndRawInputs; }, [ndRawInputs]);
  // Seed ND inputs from the resolved input (CRM / manual / congelado)
  useEffect(() => {
    if (!selectedPeriod) return;
    // SIN DATOS entra al motor como 0 —y eso es correcto: con ND=0 no se paga
    // nada pero el acumulado se CONSERVA (commission-calculator.ts:46-64)—, pero
    // la pantalla lo muestra vacío con el rótulo «sin datos», nunca $0.
    //
    // Lo que el usuario esté tecleando NO se pisa: este efecto ahora corre
    // también cuando llega la respuesta del CRM, que puede tardar ~2 s. Sin esta
    // guarda, quien empezó a escribir un ND mientras cargaba veía cómo el número
    // se le cambiaba solo debajo del cursor.
    setNdInputs((prev) => {
      const m = new Map<string, number>();
      for (const [id, r] of ndResolved) {
        m.set(id, ndRawRef.current.has(id) ? prev.get(id) ?? 0 : netParaElMotor(r));
      }
      return m;
    });

    // Seedear lotInputs desde pnl_current (donde se guarda el lotComm)
    if (tab === 'individual') {
      const results = monthlyResults.filter((r) => r.period_id === selectedPeriod.id);
      const lotMap = new Map<string, number>();
      for (const p of commercialProfiles) {
        if (p.pnl_pct != null) {
          const ex = results.find((r) => r.profile_id === p.id && r.net_deposit_current !== null);
          lotMap.set(p.id, ex?.pnl_current ?? 0);
        }
      }
      setLotInputs(lotMap);
    }
    // NO limpiar ndRawInputs aquí — se limpia en un effect separado
    // para preservar lo que el usuario está editando después de un refresh
  }, [ndResolved, selectedPeriod, monthlyResults, commercialProfiles, tab]);

  // Limpiar raw inputs solo cuando cambia el período o el head seleccionado
  useEffect(() => {
    setNdRawInputs(new Map());
  }, [selectedPeriod?.id, selectedHeadId]);

  const handleNdChange = useCallback((id: string, v: string) => {
    setNdRawInputs((prev) => { const n = new Map(prev); n.set(id, v); return n; });
    const num = v === '' || v === '-' ? 0 : parseFloat(v);
    setNdInputs((prev) => { const n = new Map(prev); n.set(id, isNaN(num) ? 0 : num); return n; });
  }, []);

  const getNdDisplay = useCallback((id: string): string => {
    const raw = ndRawInputs.get(id);
    if (raw !== undefined) return raw;
    // SIN DATOS se muestra VACÍO, no "0". Un 0 en el input es un dato ("cerró en
    // cero") y además es lo que se guarda al apretar Guardar: mostrarlo cuando
    // no sabemos es cómo se pisa lo que había (el incidente de agosto 2026, §6).
    if (ndResolved.get(id)?.value === null) return '';
    return (ndInputs.get(id) ?? 0).toString();
  }, [ndRawInputs, ndInputs, ndResolved]);

  /**
   * De dónde salió el número de esa fila, para el rótulo.
   *
   * Si el usuario está tecleando, manda lo tecleado: aunque el resolver diga
   * `crm`, lo que va a entrar al motor —y a guardarse— es lo que él escribió.
   */
  const getNdSource = useCallback((id: string): NetDepositSource => {
    if (ndRawInputs.get(id) !== undefined) return 'manual';
    return ndResolved.get(id)?.source ?? 'none';
  }, [ndRawInputs, ndResolved]);

  /** El automático del mes, para mostrarlo al lado del override como referencia. */
  const getNdAuto = useCallback((id: string): number | null => ndResolved.get(id)?.crm ?? null, [ndResolved]);

  // ─── Lot commissions (PnL section) ───
  const [lotInputs, setLotInputs] = useState<Map<string, number>>(new Map());
  const [lotRawInputs, setLotRawInputs] = useState<Map<string, string>>(new Map());

  const handleLotChange = useCallback((id: string, v: string) => {
    setLotRawInputs((prev) => { const n = new Map(prev); n.set(id, v); return n; });
    const num = v === '' || v === '-' ? 0 : parseFloat(v);
    setLotInputs((prev) => { const n = new Map(prev); n.set(id, isNaN(num) ? 0 : num); return n; });
  }, []);

  const getLotDisplay = useCallback((id: string): string => {
    const raw = lotRawInputs.get(id);
    if (raw !== undefined) return raw;
    return (lotInputs.get(id) ?? 0).toString();
  }, [lotRawInputs, lotInputs]);

  useEffect(() => { if (!selectedHeadId && heads.length > 0) setSelectedHeadId(heads[0].id); }, [heads, selectedHeadId]);

  const teamProfiles = useMemo(() => {
    if (!selectedHeadId) return [];
    const head = commercialProfiles.find((p) => p.id === selectedHeadId);
    if (!head) return [];
    const subs = getProfilesByHead(selectedHeadId).filter((p) => appearsInCommissions(p) && p.id !== selectedHeadId);
    return [head, ...subs];
  }, [selectedHeadId, commercialProfiles, getProfilesByHead]);

  // HEAD profile
  const headProfile = teamProfiles[0] ?? null;
  const headPct = headProfile?.net_deposit_pct ?? 0;
  const extraPct = headProfile?.extra_pct ?? 0;

  const headHasParent = !!(headProfile?.head_id);

  const previousResults = useMemo(() => {
    if (!selectedPeriod || !selectedHeadId) return [];
    const allPrevious = getPreviousPeriodResults(selectedPeriod.id);
    return allPrevious.filter(
      (r) => r.head_id === selectedHeadId
    );
  }, [selectedPeriod, selectedHeadId, getPreviousPeriodResults]);

  const previousResultsAll = useMemo(() => {
    if (!selectedPeriod) return [];
    return getPreviousPeriodResults(selectedPeriod.id);
  }, [selectedPeriod, getPreviousPeriodResults]);

  // Leer deuda acumulada del mes anterior (guardada en campo bonus)
  const getPrevDebt = useCallback((profileId: string, headId: string): number => {
    const prev = previousResults.find(
      (r) => r.profile_id === profileId && r.head_id === headId
    ) ?? previousResults.find(
      (r) => r.profile_id === profileId && r.head_id === profileId
    ) ?? previousResults.find((r) => r.profile_id === profileId);
    return prev?.bonus ?? 0;
  }, [previousResults]);

  const getPrevDebtAll = useCallback((profileId: string): number => {
    const profile = commercialProfiles.find((p) => p.id === profileId);
    const prev = previousResultsAll.find(
      (r) => r.profile_id === profileId && r.head_id === (profile?.head_id ?? profileId)
    ) ?? previousResultsAll.find((r) => r.profile_id === profileId);
    return prev?.bonus ?? 0;
  }, [previousResultsAll, commercialProfiles]);

  // HEAD's own ND commission — uses their personal ND from ndInputs
  // When HEAD has parent, accumulated is from their OWN group context (stored in division field of previous period)
  // not from the parent's accumulated_out
  const headOwnCalc = useMemo((): CommissionCalcResult | null => {
    if (!headProfile) return null;
    const nd = ndInputs.get(headProfile.id) ?? 0;
    let accIn = 0;
    if (headHasParent) {
      const prevResult = previousResults.find((r) => r.profile_id === headProfile.id);
      if (prevResult) {
        accIn = prevResult.accumulated_out ?? 0;
      }
    } else {
      // HEAD sin parent: buscar su registro del período anterior en su propio grupo
      const prevResult = previousResults.find(
        (r) => r.profile_id === headProfile.id && r.head_id === selectedHeadId
      ) ?? previousResults.find(
        (r) => r.profile_id === headProfile.id
      );
      accIn = prevResult?.accumulated_out ?? 0;
    }
    const calc = calculateCommission(nd, accIn, headPct);
    return { profileId: headProfile.id, commissionPct: headPct, salary: 0, totalEarnedDebt: 0, ...calc };
  }, [headProfile, ndInputs, previousResults, headPct, headHasParent]);

  // BDM rows — commission calculated at the DIFFERENTIAL rate (what HEAD earns from each BDM)
  //
  // BDM GLOBAL: MISMA lógica de diferencial que un BDM normal — lo único que
  // cambia es la REFERENCIA del HEAD: en vez de su net_deposit_pct, usa
  // pct_sobre_bdm_global. O sea, diferencial = (pct_sobre_bdm_global − %_propio_BDM).
  // HEAD intermedio (rol head/sales_manager bajo este HEAD): si tiene salario
  // fijo — o si este HEAD activó apply_pct_extra_to_head_without_salary — el
  // HEAD cobra pct_extra_sobre_head sobre la suma de ND de los BDMs de ese
  // HEAD intermedio. Si no aplica, se mantiene el diferencial de siempre.
  const bdmCalcs = useMemo((): (CommissionCalcResult & { bdmOwnPct: number; diffPct: number })[] => {
    const bdms = teamProfiles.filter((_, i) => i > 0);
    const pctSobreBdmGlobal = headProfile?.pct_sobre_bdm_global ?? 0;
    const pctExtraSobreHead = headProfile?.pct_extra_sobre_head ?? 0;
    const applyExtraNoSalary = headProfile?.apply_pct_extra_to_head_without_salary ?? false;
    return bdms.map((profile) => {
      const nd = ndInputs.get(profile.id) ?? 0;
      const accIn = getAccumulatedIn(previousResults, profile.id, selectedHeadId);

      // ── (c)/(d) HEAD intermedio bajo este HEAD ──
      const isIntermediateHead = profile.role === 'head' || profile.role === 'sales_manager';
      if (isIntermediateHead) {
        // El ND que se ingresa para el sub-HEAD en el grupo padre YA es el total
        // de su equipo (lo garantiza teamNdValidation). Sus BDMs viven en otro
        // grupo y no se cargan en esta vista, así que sumarlos daría 0. Usamos el
        // ND tecleado como base; solo si no hay ND tecleado caemos a la suma de
        // los BDMs que sí estén cargados.
        const sumNdBdmsFromTeam = commercialProfiles
          .filter((s) => s.head_id === profile.id && (s.role === 'bdm' || s.role === 'bdm_global') && appearsInCommissions(s))
          .reduce((sum, s) => sum + (ndInputs.get(s.id) ?? 0), 0);
        const sumNdBdms = nd !== 0 ? nd : sumNdBdmsFromTeam;
        const e = calculateExtraOverHeadCommission(
          pctExtraSobreHead,
          applyExtraNoSalary,
          [{ profileId: profile.id, name: profile.name, hasFixedSalary: !!profile.fixed_salary, sumNdBdms, accumulatedIn: accIn }],
        );
        if (e.details.length > 0) {
          const d = e.details[0];
          return {
            profileId: profile.id,
            commissionPct: pctExtraSobreHead,
            bdmOwnPct: profile.net_deposit_pct ?? 0,
            diffPct: pctExtraSobreHead,
            salary: profile.fixed_salary ? prorateFixedSalary(profile.salary ?? 0, profile.hire_date, periodYear, periodMonth) : calculateSalaryFromND(nd),
            totalEarnedDebt: 0,
            netDepositCurrent: sumNdBdms,
            accumulatedIn: accIn,
            division: d.division,
            commission: d.commission,
            realPayment: d.realPayment,
            accumulatedOut: d.accumulatedOut,
          };
        }
        // skipped → cae al diferencial de siempre (abajo)
      }

      // ── (a) BDM normal (y BDM GLOBAL): diferencial actual ──
      // Dynamic BDM pct tiers only apply to actual BDMs, not sub-HEADs
      const isSubHead = profile.role === 'head' || profile.role === 'sales_manager'
        || commercialProfiles.some((sub) => sub.head_id === profile.id && appearsInCommissions(sub));
      const bdmOwnPct = isSubHead || profile.fixed_salary
        ? (profile.net_deposit_pct ?? 0)
        : calculateBdmPctFromND(nd, profile.net_deposit_pct ?? 0);
      // BDM GLOBAL: el HEAD usa pct_sobre_bdm_global como su % de referencia en
      // vez de su net_deposit_pct. El resto del cálculo es idéntico al normal.
      const refPct = profile.role === 'bdm_global' ? pctSobreBdmGlobal : headPct;
      const naturalDiff = refPct - bdmOwnPct;
      // Extra % solo aplica cuando el diferencial natural es 0 (mismo %).
      // Y NUNCA negativo: si el BDM tieriza por encima del head, el head no
      // "paga" por el buen mes de su BDM — cobra 0 por ese diferencial
      // (auditoría 2026-08-06: head 5% con BDM tierizado a 6% le restaba
      // $1.000 al head). La función calculateHeadDifferential ya clampeaba
      // así, pero no era la que usaba esta pantalla.
      const diffPct = naturalDiff > 0 ? naturalDiff : naturalDiff === 0 ? extraPct : 0;
      const calc = calculateCommission(nd, accIn, diffPct);
      const bdmSalary = profile.fixed_salary ? prorateFixedSalary(profile.salary ?? 0, profile.hire_date, periodYear, periodMonth) : calculateSalaryFromND(nd);
      return { profileId: profile.id, commissionPct: diffPct, bdmOwnPct, diffPct, salary: bdmSalary, totalEarnedDebt: 0, ...calc };
    });
  }, [teamProfiles, ndInputs, previousResults, headPct, extraPct, headProfile, commercialProfiles, periodYear, periodMonth]);

  // HEAD differential total (sum of all BDM differential commissions)
  const headDiff = useMemo(() => {
    const totalDifferential = bdmCalcs.reduce((s, c) => s + c.commission, 0);
    const totalRealPayment = bdmCalcs.reduce((s, c) => s + c.realPayment, 0);
    return { totalDifferential, totalRealPayment };
  }, [bdmCalcs]);

  // Team totals — sum of ALL members including HEAD
  const teamTotalND = useMemo(() => {
    let total = 0;
    for (const p of teamProfiles) total += ndInputs.get(p.id) ?? 0;
    return total;
  }, [teamProfiles, ndInputs]);

  const autoSalary = useMemo(() => {
    if (headProfile?.fixed_salary) return prorateFixedSalary(headProfile.salary ?? 0, headProfile.hire_date, periodYear, periodMonth);
    return calculateHeadSalaryFromND(teamTotalND);
  }, [teamTotalND, headProfile, periodYear, periodMonth]);

  // Validation: if this HEAD belongs to a parent group, check that team total matches
  // what was entered for them in the parent's group
  const teamNdValidation = useMemo(() => {
    if (!headProfile || !headProfile.head_id || !selectedPeriod) return null;
    // Find what was saved for this HEAD in the parent's context
    const savedResult = existingResults.find((r) => r.profile_id === headProfile.id);
    if (!savedResult || savedResult.net_deposit_current === 0) return null;
    const expectedTotal = savedResult.net_deposit_current;
    if (teamTotalND !== 0 && Math.abs(teamTotalND - expectedTotal) > 0.01) {
      const parentProfile = commercialProfiles.find((p) => p.id === headProfile.head_id);
      return {
        parentName: parentProfile?.name ?? '',
        expected: expectedTotal,
        actual: teamTotalND,
      };
    }
    return null;
  }, [headProfile, selectedPeriod, existingResults, teamTotalND, commercialProfiles]);

  const teamSummary = useMemo(() => {
    const diffTotal = bdmCalcs.reduce((s, c) => s + c.realPayment, 0);
    const headOwnPayment = headOwnCalc?.realPayment ?? 0;
    const totalPayment = headOwnPayment + diffTotal;
    const rawTotalWithSalary = totalPayment + autoSalary;

    // La deuda del grupo se guarda en el campo bonus del HEAD (propio grupo)
    // Si bonus = 0 pero total_earned del mes anterior fue negativo,
    // usar total_earned como fallback (datos históricos sin bonus guardado)
    const prevHeadRecord = headProfile
      ? (previousResults.find(
          (r) => r.profile_id === headProfile.id && r.head_id === selectedHeadId
        ) ?? previousResults.find(
          (r) => r.profile_id === headProfile.id && r.head_id === headProfile.id
        ) ?? previousResults.find((r) => r.profile_id === headProfile.id))
      : null;

    // Usar bonus si tiene valor negativo — es la deuda acumulada del grupo
    // NO usar total_earned como fallback porque puede ser incorrecto
    const prevDebt = prevHeadRecord?.bonus ?? 0;

    const { finalTotalEarned: totalWithSalary, debtOut } = applyTotalEarnedDebt(prevDebt, rawTotalWithSalary);
    return {
      diffTotal,
      headOwnPayment,
      totalPayment,
      totalWithSalary,
      rawTotalWithSalary,
      prevDebt,
      debtOut,
    };
  }, [bdmCalcs, headOwnCalc, autoSalary, headProfile, selectedHeadId, previousResults]);

  // ═══════════════════════════════════════════════════════════
  // TAB: INDIVIDUAL (all BDMs)
  // ═══════════════════════════════════════════════════════════

  // Incluye BDM GLOBAL: en el tab Individual cobran su comisión propia igual
  // que un BDM normal (el aspecto "global" solo cambia lo que el HEAD cobra
  // sobre ellos en el tab Equipos, no su comisión individual).
  const allBdms = useMemo(
    () => commercialProfiles.filter((p) => (p.role === 'bdm' || p.role === 'bdm_global') && appearsInCommissions(p)),
    [commercialProfiles],
  );

  // La composición (qué % aplica, qué salario, con qué acumulado) vive en
  // hr/commission-preview.ts: la pestaña Comercial de /rrhh muestra el MISMO
  // número y no puede salir de otro lado (§2.1, invariante A3). La fórmula
  // sigue siendo la de commission-calculator.ts, intacta.
  const indCalcs = useMemo((): CommissionCalcResult[] => {
    return allBdms.map((profile) => {
      const accIn = getAccumulatedIn(previousResultsAll, profile.id, profile.head_id ?? undefined);
      const c = comisionIndividualDeBdm({
        profile,
        // Lo que el usuario tenga tecleado manda sobre el resolver: es lo que va
        // a entrar al motor Y lo que se va a guardar.
        resolved: ndRawInputs.has(profile.id)
          ? { value: ndInputs.get(profile.id) ?? 0, source: 'manual', crm: null, manual: ndInputs.get(profile.id) ?? 0 }
          : ndResolved.get(profile.id) ?? { value: null, source: 'none', crm: null, manual: null },
        accumulatedIn: accIn,
        periodYear,
        periodMonth,
      });
      // `allBdms` puede traer perfiles de PnL: para ésos `comisionIndividualDeBdm`
      // devuelve null y la fila cae a la tabla de PnL, que tiene su propio cálculo.
      if (!c) {
        const nd = ndInputs.get(profile.id) ?? 0;
        const calc = calculateCommission(nd, accIn, 0);
        return { profileId: profile.id, commissionPct: 0, salary: 0, totalEarnedDebt: 0, ...calc };
      }
      return {
        profileId: profile.id,
        netDepositCurrent: ndInputs.get(profile.id) ?? 0,
        accumulatedIn: c.accumulatedIn,
        division: c.division,
        commissionPct: c.commissionPct,
        commission: c.commission,
        realPayment: c.realPayment,
        accumulatedOut: c.accumulatedOut,
        salary: c.salary,
        totalEarnedDebt: 0,
      };
    });
  }, [allBdms, ndInputs, ndRawInputs, ndResolved, previousResultsAll, periodYear, periodMonth]);

  const indSummary = useMemo(() => calculateGroupSummary(indCalcs), [indCalcs]);

  // Filtered BDM lists by commission type
  const ndBdms = useMemo(() => allBdms.filter((p) => p.net_deposit_pct != null), [allBdms]);
  // PnL normal: perfiles con pct pero SIN modo especial
  const pnlBdms = useMemo(
    () => allBdms.filter((p) => p.pnl_pct != null && !p.pnl_special_mode),
    [allBdms],
  );

  // PnL Especial: perfiles con pct Y modo especial activo — renderizan en
  // una sección aparte con su propia lógica de cálculo (no dividida, sin
  // acumulado). Ver sección "PnL Especial" más abajo.
  const pnlSpecialBdms = useMemo(
    () => allBdms.filter((p) => p.pnl_pct != null && !!p.pnl_special_mode),
    [allBdms],
  );
  const lotBdms = useMemo(() => allBdms.filter((p) => p.commission_per_lot != null), [allBdms]);

  // PnL calculations — same formula as ND but using pnl_pct, no salary tiers
  const pnlCalcs = useMemo((): CommissionCalcResult[] => {
    return pnlBdms.map((profile) => {
      const nd = ndInputs.get(profile.id) ?? 0; // "PnL" value input
      const accIn = getAccumulatedIn(previousResultsAll, profile.id, profile.head_id ?? undefined);
      const pct = profile.pnl_pct ?? 0; // always fixed, no dynamic tiers
      const calc = calculateCommission(nd, accIn, pct);
      // No salary tiers for PnL — only fixed salary if configured
      const pnlSalary = profile.fixed_salary ? prorateFixedSalary(profile.salary ?? 0, profile.hire_date, periodYear, periodMonth) : 0;
      return { profileId: profile.id, commissionPct: pct, salary: pnlSalary, totalEarnedDebt: 0, ...calc };
    });
  }, [pnlBdms, ndInputs, previousResultsAll, periodYear, periodMonth]);

  const pnlSummary = useMemo(() => calculateGroupSummary(pnlCalcs), [pnlCalcs]);

  // ─── PnL Especial calculations ───
  // Fórmula: commission = pnl × pct (sin división, sin accumulated).
  // Los lotes se restan al calcular real_payment. Ver calculatePnlSpecial
  // en commission-calculator.ts — está aislada de calculateCommission.
  const pnlSpecialCalcs = useMemo(() => {
    return pnlSpecialBdms.map((profile) => {
      const pnl = ndInputs.get(profile.id) ?? 0;
      const lotComm = lotInputs.get(profile.id) ?? 0;
      const pct = profile.pnl_pct ?? 0;
      const specialSalary = profile.fixed_salary ? prorateFixedSalary(profile.salary ?? 0, profile.hire_date, periodYear, periodMonth) : 0;
      const calc = calculatePnlSpecial(pnl, pct, lotComm, specialSalary);
      return { profileId: profile.id, ...calc };
    });
  }, [pnlSpecialBdms, ndInputs, lotInputs, periodYear, periodMonth]);

  const pnlSpecialSummary = useMemo(() => {
    const totalRealPayment = pnlSpecialCalcs.reduce((s, c) => s + c.realPayment, 0);
    const totalSalary = pnlSpecialCalcs.reduce((s, c) => s + c.salary, 0);
    const totalCommission = pnlSpecialCalcs.reduce((s, c) => s + c.commission, 0);
    return {
      totalRealPayment: Math.round(totalRealPayment * 100) / 100,
      totalSalary: Math.round(totalSalary * 100) / 100,
      totalWithSalary: Math.round((totalRealPayment + totalSalary) * 100) / 100,
      totalCommission: Math.round(totalCommission * 100) / 100,
    };
  }, [pnlSpecialCalcs]);

  // ─── History filter (últimos 7 meses por defecto) ───
  const [historyFrom, setHistoryFrom] = useState(Math.max(0, sortedPeriods.length - 7));
  const [historyTo, setHistoryTo] = useState(sortedPeriods.length - 1);
  const historyPeriods = useMemo(() => sortedPeriods.slice(historyFrom, historyTo + 1), [sortedPeriods, historyFrom, historyTo]);

  // ═══════════════════════════════════════════════════════════
  // SAVE & EXPORT
  // ═══════════════════════════════════════════════════════════

  const [saving, setSaving] = useState(false);
  const [savingBdm, setSavingBdm] = useState<Set<string>>(new Set());

  const handleSaveBdm = useCallback(async (profileId: string, mode: 'nd' | 'pnl' | 'pnlSpecial') => {
    if (!selectedPeriod || !company) return;

    setSavingBdm((prev) => new Set(prev).add(profileId));
    try {
      const profile = commercialProfiles.find((p) => p.id === profileId);
      if (!profile) return;

      const headId = profile.head_id ?? profileId;

      let entry: CommissionEntryRow;

      if (mode === 'nd') {
        // ND BDM
        const calc = indCalcs.find((c) => c.profileId === profileId);
        if (!calc) return;
        const prevDebt = getPrevDebtAll(profileId);
        const rawTE = calc.realPayment + calc.salary;
        const { finalTotalEarned, debtOut } = applyTotalEarnedDebt(prevDebt, rawTE);
        entry = {
          profile_id: profileId,
          head_id: headId,
          net_deposit_current: calc.netDepositCurrent,
          net_deposit_accumulated: calc.accumulatedIn,
          division: calc.division,
          base_amount: 0,
          commissions_earned: calc.commission,
          real_payment: calc.realPayment,
          accumulated_out: calc.accumulatedOut,
          salary_paid: calc.salary,
          total_earned: finalTotalEarned,
          bonus: debtOut,
        };
      } else if (mode === 'pnl') {
        // PnL BDM
        const calc = pnlCalcs.find((c) => c.profileId === profileId);
        if (!calc) return;
        const lotComm = lotInputs.get(profileId) ?? 0;
        const adjustedReal = calc.realPayment - lotComm;
        const prevDebt = getPrevDebtAll(profileId);
        const rawTE = adjustedReal + calc.salary;
        const { finalTotalEarned, debtOut } = applyTotalEarnedDebt(prevDebt, rawTE);
        entry = {
          profile_id: profileId,
          head_id: headId,
          net_deposit_current: calc.netDepositCurrent,
          net_deposit_accumulated: calc.accumulatedIn,
          division: calc.division,
          base_amount: 0,
          commissions_earned: calc.commission,
          real_payment: adjustedReal,
          pnl_current: lotComm,
          accumulated_out: calc.accumulatedOut,
          salary_paid: calc.salary,
          total_earned: finalTotalEarned,
          bonus: debtOut,
        };
      } else {
        // PnL ESPECIAL — sin división ni acumulado
        const calc = pnlSpecialCalcs.find((c) => c.profileId === profileId);
        if (!calc) return;
        const prevDebt = getPrevDebtAll(profileId);
        const rawTE = calc.realPayment + calc.salary;
        const { finalTotalEarned, debtOut } = applyTotalEarnedDebt(prevDebt, rawTE);
        entry = {
          profile_id: profileId,
          head_id: headId,
          net_deposit_current: calc.pnl,           // PnL ingresado
          net_deposit_accumulated: 0,              // sin acumulado
          division: 0,                             // sin división
          base_amount: 0,
          commissions_earned: calc.commission,     // pnl × pct
          real_payment: calc.realPayment,          // ya viene con lotes restados
          pnl_current: calc.lotCommissions,        // guardar lotes (misma convención que PnL normal)
          accumulated_out: 0,                      // nunca lleva al siguiente mes
          salary_paid: calc.salary,
          total_earned: finalTotalEarned,
          bonus: debtOut,
        };
      }

      await upsertCommissionEntries(company.id, selectedPeriod.id, headId, [entry]);

      // Actualizar monthlyResults localmente
      patchMonthlyResults([{
        id: `temp-${entry.profile_id}`,
        profile_id: entry.profile_id,
        period_id: selectedPeriod.id,
        head_id: entry.head_id ?? headId,
        net_deposit_current: entry.net_deposit_current ?? 0,
        net_deposit_accumulated: entry.net_deposit_accumulated ?? 0,
        net_deposit_total: entry.net_deposit_current ?? 0,
        division: entry.division ?? 0,
        base_amount: entry.base_amount ?? 0,
        commissions_earned: entry.commissions_earned ?? 0,
        real_payment: entry.real_payment ?? 0,
        accumulated_out: entry.accumulated_out ?? 0,
        salary_paid: entry.salary_paid ?? 0,
        total_earned: entry.total_earned ?? 0,
        bonus: entry.bonus ?? 0,
        pnl_current: 0,
        pnl_accumulated: 0,
        pnl_total: 0,
      }]);

      // Actualizar input visual
      setNdInputs((prev) => {
        const next = new Map(prev);
        if (entry.net_deposit_current !== null) next.set(profileId, entry.net_deposit_current);
        return next;
      });
      setNdRawInputs((prev) => { const next = new Map(prev); next.delete(profileId); return next; });

      setToast({ type: 'success', msg: t('comm.savedOk') });
      setTimeout(() => setToast(null), 3000);
    } catch (err) {
      setToast({ type: 'error', msg: err instanceof Error ? err.message : t('comm.saveError') });
      setTimeout(() => setToast(null), 4000);
    } finally {
      setSavingBdm((prev) => { const next = new Set(prev); next.delete(profileId); return next; });
    }
  }, [selectedPeriod, company, commercialProfiles, ndInputs, indCalcs, pnlCalcs, pnlSpecialCalcs, lotInputs, getPrevDebtAll, applyTotalEarnedDebt, patchMonthlyResults]);

  // ─── Recalcular histórico de perfiles en PnL Especial (admin-only) ───
  //
  // Lee `commercial_monthly_results` existentes de perfiles con
  // pnl_special_mode=true y reescribe los valores usando la nueva fórmula:
  //   commission      = pnl × pct
  //   real_payment    = commission − com_lotes
  //   accumulated_out = 0
  //   division        = 0
  //   net_deposit_accumulated = 0
  //
  // No reprocesa la lógica de deuda entre meses (se usa prevDebt=0). Ajustar
  // esas cascadas históricas es peligroso y no se pidió explícitamente; si
  // luego se quiere, se hace aparte.
  const [recalcInProgress, setRecalcInProgress] = useState(false);

  const handleRecalcHistory = useCallback(async () => {
    if (!isCompanyAdmin(user)) {
      setToast({ type: 'error', msg: t('comm.recalcHistoryAdminOnly') });
      setTimeout(() => setToast(null), 4000);
      return;
    }
    if (pnlSpecialBdms.length === 0) {
      setToast({ type: 'error', msg: t('comm.recalcHistoryNoProfiles') });
      setTimeout(() => setToast(null), 4000);
      return;
    }
    if (!confirm(t('comm.recalcHistoryMessage'))) return;
    if (!company) return;

    setRecalcInProgress(true);
    try {
      const specialProfileIds = new Set(pnlSpecialBdms.map((p) => p.id));
      const affected = monthlyResults.filter((r) => specialProfileIds.has(r.profile_id));

      // Agrupar por (head_id, period_id) porque upsertCommissionEntries
      // trabaja por grupo — un solo call por (period, head).
      const grouped = new Map<string, { headId: string; periodId: string; entries: CommissionEntryRow[] }>();

      for (const r of affected) {
        const profile = pnlSpecialBdms.find((p) => p.id === r.profile_id);
        if (!profile) continue;
        const pnl = r.net_deposit_current ?? 0;       // PnL se guarda en net_deposit_current
        const lotComm = r.pnl_current ?? 0;           // lotes se guardan en pnl_current
        const pct = profile.pnl_pct ?? 0;
        const salary = r.salary_paid ?? 0;
        const calc = calculatePnlSpecial(pnl, pct, lotComm, salary);

        // Sin cascada de deudas: para el recálculo histórico usamos deuda 0.
        const prevDebt = 0;
        const rawTE = calc.realPayment + calc.salary;
        const { finalTotalEarned, debtOut } = applyTotalEarnedDebt(prevDebt, rawTE);

        const headId = r.head_id ?? profile.head_id ?? profile.id;
        const key = `${headId}::${r.period_id}`;
        if (!grouped.has(key)) grouped.set(key, { headId, periodId: r.period_id, entries: [] });
        grouped.get(key)!.entries.push({
          profile_id: r.profile_id,
          head_id: headId,
          net_deposit_current: calc.pnl,
          net_deposit_accumulated: 0,
          division: 0,
          base_amount: 0,
          commissions_earned: calc.commission,
          real_payment: calc.realPayment,
          pnl_current: calc.lotCommissions,
          accumulated_out: 0,
          salary_paid: calc.salary,
          total_earned: finalTotalEarned,
          bonus: debtOut,
        });
      }

      if (grouped.size === 0) {
        setToast({ type: 'error', msg: t('comm.recalcHistoryNoProfiles') });
        setTimeout(() => setToast(null), 4000);
        return;
      }

      // Secuencial — simpler + safer que Promise.all si un tenant tiene
      // muchos meses y la DB lockea a nivel de fila.
      for (const { headId, periodId, entries } of grouped.values()) {
        await upsertCommissionEntries(company.id, periodId, headId, entries);
      }

      await refresh();
      setToast({ type: 'success', msg: t('comm.recalcHistoryDone') });
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      setToast({ type: 'error', msg: err instanceof Error ? err.message : 'Error' });
      setTimeout(() => setToast(null), 5000);
    } finally {
      setRecalcInProgress(false);
    }
  }, [user, pnlSpecialBdms, monthlyResults, company, refresh, t]);

  const handleSave = async () => {
    if (!selectedPeriod || !company) return;

    // Si hay un warning de validación (el total del equipo no coincide
    // con lo que el grupo padre registró), bloquear el guardado
    if (tab === 'teams' && teamNdValidation) {
      setToast({
        type: 'error',
        msg: t('comm.teamNdMismatch', {
          actual: formatCurrency(teamNdValidation.actual),
          parent: teamNdValidation.parentName,
          expected: formatCurrency(teamNdValidation.expected),
        }),
      });
      setTimeout(() => setToast(null), 6000);
      return;
    }

    // Guarda anti-pisón. Re-guardar un grupo SOBRESCRIBE lo guardado con lo que
    // muestra la pantalla en vivo. Si al reabrir un mes el ND se sembró en 0,
    // guardar borraría el ND que estaba cargado. Detectamos ese caso puntual
    // (miembro con ND guardado != 0 que ahora se guardaría en 0) y avisamos con
    // nombres ANTES de borrar. Es la protección contra el incidente del 2026-08.
    if (tab === 'teams' && typeof window !== 'undefined') {
      const periodLabel = selectedPeriod.label || `${selectedPeriod.month}/${selectedPeriod.year}`;
      const wouldZero: string[] = [];
      for (const profile of teamProfiles) {
        if (profile.id === headProfile?.id) continue; // el HEAD tiene ND propio (net_deposit_accumulated)
        const saved = existingResults.find((r) => r.profile_id === profile.id && r.head_id === selectedHeadId);
        const savedNd = saved ? Number(saved.net_deposit_current) : 0;
        const inputNd = ndInputs.get(profile.id) ?? 0;
        if (savedNd !== 0 && inputNd === 0) wouldZero.push(profile.name);
      }
      if (wouldZero.length > 0) {
        const names = wouldZero.slice(0, 10).join(', ') + (wouldZero.length > 10 ? `, +${wouldZero.length - 10} más` : '');
        const ok = window.confirm(
          `⚠️ CUIDADO — posible borrado de datos en ${periodLabel}\n\n` +
          `${wouldZero.length} miembro(s) tienen ND guardado pero ahora aparecen en 0. ` +
          `Si guardás, se les BORRA el ND cargado:\n\n${names}\n\n` +
          `Esto pasa al reabrir un mes viejo cuyos datos no cargaron. ` +
          `Si NO estás re-cargando esos ND a propósito, CANCELÁ.\n\n` +
          `¿Guardar igual y poner esos ND en 0?`,
        );
        if (!ok) return;
      } else if (existingResults.some((r) => r.head_id === selectedHeadId)) {
        const ok = window.confirm(
          `Este grupo ya tiene comisiones guardadas para ${periodLabel}.\n\n` +
          `Vas a sobrescribirlas con los valores actuales. ¿Continuar?`,
        );
        if (!ok) return;
      }
    }

    setSaving(true);
    try {
      let entries: CommissionEntryRow[];
      if (tab === 'teams') {
        entries = [];

        // Save EVERY member of the team with their OWN data
        for (const profile of teamProfiles) {
          const isHead = profile.id === headProfile?.id;

          const nd = ndInputs.get(profile.id) ?? 0;
          const accIn = getAccumulatedIn(previousResults, profile.id, selectedHeadId);
          // HEAD/sub-HEADs keep profile pct; only actual BDMs use dynamic pct based on ND
          const isSubHead = !isHead && (profile.role === 'head' || profile.role === 'sales_manager'
            || commercialProfiles.some((sub) => sub.head_id === profile.id && appearsInCommissions(sub)));
          const pct = (isHead || isSubHead || profile.fixed_salary) ? (profile.net_deposit_pct ?? 0) : calculateBdmPctFromND(nd, profile.net_deposit_pct ?? 0);
          const calc = calculateCommission(nd, accIn, pct);

          if (isHead && headHasParent) {
            // HEAD with parent: save their personal ND and calculations
            // net_deposit_current is preserved (parent manages it via -1 flag)
            // but accumulated_out is their OWN from their own group's calculation
            entries.push({
              profile_id: profile.id,
              net_deposit_current: null, // flag: don't overwrite (parent manages this)
              net_deposit_accumulated: nd, // store personal ND here
              division: calc.division,
              base_amount: 0,
              commissions_earned: calc.commission + headDiff.totalDifferential,
              real_payment: calc.realPayment + headDiff.totalRealPayment,
              accumulated_out: calc.accumulatedOut,
              salary_paid: autoSalary,
              total_earned: teamSummary.totalWithSalary,
              bonus: teamSummary.debtOut,
            });
          } else {
            // Sub-members with own team: preserve net_deposit_accumulated (-1 flag)
            // because that field stores their personal ND from their own group
            const isSubWithTeam = !isHead && commercialProfiles.some((sub) => sub.head_id === profile.id && appearsInCommissions(sub));
            // Para sub-HEADs la comisión correcta (extra sobre head, sobre el ND
            // de su equipo) ya la resuelve bdmCalcs. Reusamos ese resultado para
            // que lo GUARDADO coincida con lo MOSTRADO. Los BDMs normales
            // conservan su cálculo propio (su payout individual).
            const bdmCalc = bdmCalcs.find((c) => c.profileId === profile.id);
            const src = (isSubWithTeam && bdmCalc) ? bdmCalc : calc;
            const memberSalary = profile.fixed_salary
              ? prorateFixedSalary(profile.salary ?? 0, profile.hire_date, periodYear, periodMonth)
              : calculateSalaryFromND(nd);
            // Deuda arrastrada de los MIEMBROS (no-head): guardar desde
            // Equipos escribía `bonus: 0` y un total_earned sin
            // applyTotalEarnedDebt — la misma fila que Individual guardaba
            // CON deuda. Resultado (auditoría 2026-08-06): un BDM que debía
            // $2.000 quedaba a cero con solo guardar desde la otra pestaña.
            // Ahora ambas pestañas aplican la misma regla.
            const memberDebt = (() => {
              if (isHead) return null;
              const prevDebt = getPrevDebtAll(profile.id);
              const rawTE = src.realPayment + memberSalary;
              return applyTotalEarnedDebt(prevDebt, rawTE);
            })();

            entries.push({
              profile_id: profile.id,
              net_deposit_current: nd,
              net_deposit_accumulated: isSubWithTeam ? null : accIn,
              division: src.division,
              base_amount: 0,
              // El HEAD sin padre también cobra el diferencial de sus BDMs:
              // guardarlo solo en total_earned (y no acá) hacía que todo
              // reporte que agrega commissions_earned lo subestimara.
              commissions_earned: isHead ? src.commission + headDiff.totalDifferential : src.commission,
              real_payment: isHead ? src.realPayment + headDiff.totalRealPayment : src.realPayment,
              accumulated_out: src.accumulatedOut,
              salary_paid: isHead ? autoSalary : memberSalary,
              total_earned: (isHead && !headHasParent)
                ? teamSummary.totalWithSalary
                : (memberDebt?.finalTotalEarned ?? src.realPayment + memberSalary),
              bonus: isHead ? teamSummary.debtOut : (memberDebt?.debtOut ?? 0),
            });
          }
        }
      } else {
        // ND BDM entries
        const ndEntries = indCalcs.filter((c) => ndBdms.some((b) => b.id === c.profileId)).map((c) => {
          const profile = commercialProfiles.find((p) => p.id === c.profileId);
          return {
            profile_id: c.profileId,
            head_id: profile?.head_id ?? selectedHeadId,
            net_deposit_current: c.netDepositCurrent,
            net_deposit_accumulated: c.accumulatedIn,
            division: c.division,
            base_amount: 0,
            commissions_earned: c.commission,
            real_payment: c.realPayment,
            accumulated_out: c.accumulatedOut,
            salary_paid: c.salary,
            ...(() => {
              const prevDebt = getPrevDebtAll(c.profileId);
              const rawTE = c.realPayment + c.salary;
              const { finalTotalEarned, debtOut } = applyTotalEarnedDebt(prevDebt, rawTE);
              return { total_earned: finalTotalEarned, bonus: debtOut };
            })(),
          };
        });
        // PnL BDM entries
        const pnlEntries = pnlCalcs.map((c) => {
          const profile = commercialProfiles.find((p) => p.id === c.profileId);
          const lotComm = lotInputs.get(c.profileId) ?? 0;
          const adjustedReal = c.realPayment - lotComm;
          return {
            profile_id: c.profileId,
            head_id: profile?.head_id ?? selectedHeadId,
            net_deposit_current: c.netDepositCurrent,
            net_deposit_accumulated: c.accumulatedIn,
            division: c.division,
            base_amount: 0,
            commissions_earned: c.commission,
            real_payment: adjustedReal,
            pnl_current: lotComm,
            accumulated_out: c.accumulatedOut,
            salary_paid: c.salary,
            ...(() => {
              const prevDebt = getPrevDebtAll(c.profileId);
              const rawTE = adjustedReal + c.salary;
              const { finalTotalEarned, debtOut } = applyTotalEarnedDebt(prevDebt, rawTE);
              return { total_earned: finalTotalEarned, bonus: debtOut };
            })(),
          };
        });
        // Merge: if a BDM appears in both ND and PnL, keep ND entry (primary)
        const pnlOnly = pnlEntries.filter((pe) => !ndEntries.some((ne) => ne.profile_id === pe.profile_id));
        entries = [...ndEntries, ...pnlOnly];
      }
      if (entries.length === 0) {
        setSaving(false);
        setToast({ type: 'error', msg: t('comm.noDataToSave') });
        setTimeout(() => setToast(null), 4000);
        return;
      }
      await upsertCommissionEntries(company.id, selectedPeriod.id, selectedHeadId, entries);

      // Actualizar monthlyResults localmente con los datos guardados
      const patched: CommercialMonthlyResult[] = entries.map((e) => ({
        id: `temp-${e.profile_id}`,
        profile_id: e.profile_id,
        period_id: selectedPeriod.id,
        head_id: e.head_id ?? selectedHeadId,
        net_deposit_current: e.net_deposit_current ?? 0,
        net_deposit_accumulated: e.net_deposit_accumulated ?? 0,
        net_deposit_total: e.net_deposit_current ?? 0,
        division: e.division ?? 0,
        base_amount: e.base_amount ?? 0,
        commissions_earned: e.commissions_earned ?? 0,
        real_payment: e.real_payment ?? 0,
        accumulated_out: e.accumulated_out ?? 0,
        salary_paid: e.salary_paid ?? 0,
        total_earned: e.total_earned ?? 0,
        bonus: e.bonus ?? 0,
        pnl_current: 0,
        pnl_accumulated: 0,
        pnl_total: 0,
      }));
      patchMonthlyResults(patched);

      // Actualizar ndInputs con valores guardados
      setNdInputs((prev) => {
        const next = new Map(prev);
        for (const entry of entries) {
          if (entry.net_deposit_current !== null) next.set(entry.profile_id, entry.net_deposit_current);
        }
        return next;
      });
      setNdRawInputs(new Map());
      setSaving(false);
      setToast({ type: 'success', msg: t('comm.saveSuccess') });
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      setSaving(false);
      setToast({ type: 'error', msg: err instanceof Error ? err.message : t('comm.saveError') });
      setTimeout(() => setToast(null), 4000);
    }
  };

  const doExport = () => {
    if (tab === 'history') {
      // Export the full history table from saved DB data
      // Historial: excluir despedidos (status inactive + termination_date). En
      // Equipos/Individual sí aparecen para cargar negativos post-despido, pero
      // en el Historial no se quieren ver.
      const activeProfiles = commercialProfiles.filter(
        (p) => appearsInCommissions(p) && !(p.status === 'inactive' && p.termination_date),
      );
      const smProfiles = activeProfiles.filter((p) => p.role === 'sales_manager');
      const headProfilesList = activeProfiles.filter((p) => p.role === 'head');
      // Stiven (2026-06-19): Bug — el CSV no incluía los BDM Global porque
      // solo filtraba `p.role === 'bdm'`. La tabla visual ya los muestra
      // correctamente con `role === 'bdm' || role === 'bdm_global'`.
      const bdmProfilesList = activeProfiles.filter((p) => p.role === 'bdm' || p.role === 'bdm_global');
      const allHistoryProfiles = [...smProfiles, ...headProfilesList, ...bdmProfilesList];

      const periodLabels = historyPeriods.map((p) => p.label || `${p.year}-${String(p.month).padStart(2, '0')}`);
      const headers = ['Nombre', 'Correo', 'Rol', ...periodLabels, 'Total'];

      const rows: (string | number)[][] = allHistoryProfiles.map((profile) => {
        const periodValues = historyPeriods.map((p) => {
          const records = monthlyResults.filter(
            (mr) => mr.profile_id === profile.id && mr.period_id === p.id
          );
          if (records.length === 0) return 0;
          let val: number;
          const ownGroupRecord = records.find((r) => r.head_id === profile.id);
          if (ownGroupRecord) {
            val = ownGroupRecord.total_earned;
          } else if (profile.head_id) {
            const headRecord = records.find((r) => r.head_id === profile.head_id);
            val = headRecord ? headRecord.total_earned : records.reduce((best, r) =>
              Math.abs(r.total_earned) > Math.abs(best.total_earned) ? r : best
            ).total_earned;
          } else {
            val = records.reduce((best, r) =>
              Math.abs(r.total_earned) > Math.abs(best.total_earned) ? r : best
            ).total_earned;
          }
          // Negativos se muestran como 0 en historial
          return val < 0 ? 0 : val;
        });
        const total = periodValues.reduce((s, v) => s + v, 0);
        return [profile.name, profile.email, ROLE_LABEL[profile.role] || profile.role, ...periodValues, total];
      });

      // Add totals row
      const totalRow: (string | number)[] = ['TOTAL', '', ''];
      for (let i = 0; i < historyPeriods.length; i++) {
        totalRow.push(rows.reduce((sum, row) => sum + (Number(row[i + 3]) || 0), 0));
      }
      totalRow.push(rows.reduce((sum, row) => sum + (Number(row[row.length - 1]) || 0), 0));
      rows.push(totalRow);

      const fromLabel = historyPeriods[0]?.label || '';
      const toLabel = historyPeriods[historyPeriods.length - 1]?.label || '';
      downloadCSV(`historial_comisiones_${fromLabel}_a_${toLabel}.csv`.replace(/\s/g, '_'), headers, rows);
      return;
    }
    if (!selectedPeriod) return;
    if (tab === 'teams') {
      const headers = ['Name', 'Role', '%', t('comm.ndCurrent'), t('comm.division'), t('comm.commission'), t('comm.realPayment')];
      const rows = bdmCalcs
        // Mismo criterio que el PDF: no listar despedidos sin ND (aportan $0).
        .filter((c) => {
          const p = commercialProfiles.find((pr) => pr.id === c.profileId);
          const isFired = p?.status === 'inactive' && !!p?.termination_date;
          return !(isFired && (c.netDepositCurrent ?? 0) === 0);
        })
        .map((c) => {
          const p = commercialProfiles.find((pr) => pr.id === c.profileId);
          return [p?.name ?? '', 'BDM', c.commissionPct, c.netDepositCurrent, c.division, c.commission, c.realPayment] as (string | number)[];
        });
      if (headProfile) {
        rows.push([headProfile.name, ROLE_LABEL[headProfile.role], `Diff`, '', '', '', headDiff.totalDifferential, headDiff.totalRealPayment]);
      }
      const headName = headProfile?.name ?? 'team';
      downloadCSV(`comisiones_${headName}_${selectedPeriod.year}-${selectedPeriod.month}.csv`, headers, rows);
    } else {
      // Export from saved DB data — not from real-time calculations (which may show 0 if ndInputs didn't load)
      const headers = ['Name', 'Role', '%', t('comm.ndCurrent'), t('comm.division'), t('comm.commission'), t('comm.realPayment'), 'Salario', 'Total'];
      const periodData = monthlyResults.filter((r) => r.period_id === selectedPeriod.id);
      const bdmProfilesSorted = [...commercialProfiles]
        .filter(appearsInCommissions)
        .sort((a, b) => a.name.localeCompare(b.name));
      const rows: (string | number)[][] = [];
      for (const profile of bdmProfilesSorted) {
        // Find the best record for this profile
        const records = periodData.filter((r) => r.profile_id === profile.id);
        if (records.length === 0) continue;
        // For HEADs: use own-group record; for BDMs: use head's group record
        const rec = records.find((r) => r.head_id === profile.id)
          ?? records.find((r) => r.head_id === profile.head_id)
          ?? records[0];
        rows.push([
          profile.name,
          ROLE_LABEL[profile.role] || profile.role,
          profile.net_deposit_pct ?? 0,
          rec.net_deposit_current,
          rec.division,
          rec.commissions_earned,
          rec.real_payment,
          rec.salary_paid,
          rec.total_earned,
        ]);
      }
      downloadCSV(`comisiones_individual_${selectedPeriod.year}-${selectedPeriod.month}.csv`, headers, rows);
    }
  };
  const handleExport = () => verify2FA(doExport);

  const doExportPDF = async () => {
    if (!selectedPeriod || !headProfile) return;
    const periodLabel = selectedPeriod.label || `${selectedPeriod.month}/${selectedPeriod.year}`;

    // Build salary tier label
    const tierLabels = HEAD_SALARY_TIERS.map(t => `≥$${t.minND.toLocaleString()} → $${t.salary.toLocaleString()}`).join(' | ');

    const { generateCommissionPDF } = await loadPdfExports();
    generateCommissionPDF({
      companyName: company?.name ?? 'Smart Dashboard',
      companyLogoUrl: company?.logo_url ?? null,
      headName: headProfile.name,
      headRole: ROLE_LABEL[headProfile.role] || headProfile.role,
      headEmail: headProfile.email,
      periodLabel,
      teamTotalND: teamTotalND,
      autoSalary,
      salaryTierLabel: tierLabels,
      headOwnCalc: headOwnCalc ? {
        netDepositCurrent: headOwnCalc.netDepositCurrent,
        accumulatedIn: headOwnCalc.accumulatedIn,
        division: headOwnCalc.division,
        commissionPct: headOwnCalc.commissionPct,
        commission: headOwnCalc.commission,
        realPayment: headOwnCalc.realPayment,
        accumulatedOut: headOwnCalc.accumulatedOut,
      } : null,
      headDiff,
      teamSummary,
      bdms: bdmCalcs
        // Excluir del reporte a los despedidos SIN ND: no tuvieron actividad
        // este mes (aportan $0), así que no deben figurar. Los despedidos CON
        // ND (ej. negativos post-despido) sí se muestran.
        .filter(c => {
          const p = commercialProfiles.find(pr => pr.id === c.profileId);
          const isFired = p?.status === 'inactive' && !!p?.termination_date;
          return !(isFired && (c.netDepositCurrent ?? 0) === 0);
        })
        .map(c => {
        const p = commercialProfiles.find(pr => pr.id === c.profileId);
        return {
          name: p?.name ?? '',
          email: p?.email ?? '',
          pct: c.bdmOwnPct,
          diffPct: c.diffPct,
          nd: c.netDepositCurrent,
          accIn: c.accumulatedIn,
          division: c.division,
          commission: c.commission,
          realPayment: c.realPayment,
          accOut: c.accumulatedOut,
          salary: c.salary,
        };
      }),
    });
  };
  const handleExportPDF = () => verify2FA(doExportPDF);

  const [showExportMenu, setShowExportMenu] = useState(false);

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════

  if (!canAccess) {
    return <div className="flex items-center justify-center h-64"><p className="text-muted-foreground">{t('common.noAccess')}</p></div>;
  }

  return (
    <div className="space-y-6">
      {Modal2FA}
      {/* Header */}
      <PageHeader
        title={t('comm.title')}
        subtitle={t('comm.subtitle')}
        icon={Calculator}
        actions={
        <div className="relative">
          <button
            onClick={() => setShowExportMenu(!showExportMenu)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
          >
            <Download className="w-4 h-4" />{t('comm.export')}
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          {showExportMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[180px]">
                <button
                  onClick={() => { handleExport(); setShowExportMenu(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                >
                  <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
                  {t('audit.exportCsv')}
                </button>
                {tab === 'teams' && (
                  <button
                    onClick={() => { handleExportPDF(); setShowExportMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                  >
                    <FileText className="w-4 h-4 text-red-500" />
                    {t('comm.exportPdfDetailed')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 bg-muted p-1 rounded-lg w-fit max-w-full overflow-x-auto">
        <button onClick={() => setTab('teams')} className={cn('flex items-center gap-2 px-3 sm:px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap', tab === 'teams' ? 'bg-card shadow-sm' : 'hover:bg-card/50')}>
          <Users className="w-4 h-4" />{t('comm.tabTeams')}
        </button>
        <button onClick={() => setTab('individual')} className={cn('flex items-center gap-2 px-3 sm:px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap', tab === 'individual' ? 'bg-card shadow-sm' : 'hover:bg-card/50')}>
          <UserCircle className="w-4 h-4" />{t('comm.tabIndividual')}
        </button>
        <button onClick={() => setTab('history')} className={cn('flex items-center gap-2 px-3 sm:px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap', tab === 'history' ? 'bg-card shadow-sm' : 'hover:bg-card/50')}>
          <BarChart3 className="w-4 h-4" />{t('comm.tabHistory')}
        </button>
      </div>

      {/* Period selector (teams & individual only) */}
      {tab !== 'history' && (
        <Card>
          <div className="flex flex-col sm:flex-row gap-4">
            {tab === 'teams' && (
              <div className="flex-1">
                <label className="block text-sm font-medium mb-1.5">{t('comm.selectHead')}</label>
                <select value={selectedHeadId} onChange={(e) => setSelectedHeadId(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
                  <option value="">{t('comm.selectHead')}</option>
                  {heads.map((h) => <option key={h.id} value={h.id}>{h.name} — {h.net_deposit_pct ?? 0}%</option>)}
                </select>
              </div>
            )}
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1.5">{t('comm.selectPeriod')}</label>
              <div className="flex items-center gap-2">
                <button onClick={() => navigatePeriod(-1)} disabled={periodIdx <= 0} className="p-2 rounded-lg border border-border hover:bg-muted disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
                <select value={selectedPeriod?.id ?? ''} onChange={(e) => { const i = sortedPeriods.findIndex((p) => p.id === e.target.value); if (i >= 0) setPeriodIdx(i); }} className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
                  {sortedPeriods.map((p) => <option key={p.id} value={p.id}>{p.label || `${p.year}-${String(p.month).padStart(2, '0')}`}</option>)}
                </select>
                <button onClick={() => navigatePeriod(1)} disabled={periodIdx >= sortedPeriods.length - 1} className="p-2 rounded-lg border border-border hover:bg-muted disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
              </div>
            </div>
          </div>
          {/* De dónde sale el insumo de este mes. Se dice SIEMPRE: un mes
              congelado y un mes automático se ven iguales en la tabla, y la
              diferencia es de dónde salió cada peso. */}
          <p className="text-xs text-muted-foreground mt-3">
            {!periodoUsaAutomatico
              ? t('comm.ndInputFrozenNotice')
              : crmNetLoading
                ? t('comm.ndInputLoading')
                : crmNetError
                  ? <span className="text-negative">{t('comm.ndInputError')}</span>
                  : t('comm.ndInputAutoNotice')}
          </p>
        </Card>
      )}

      {/* ═══════════ TAB: TEAMS ═══════════ */}
      {tab === 'teams' && selectedHeadId && headProfile && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-violet-100 dark:bg-violet-950/50 flex items-center justify-center"><UserCircle className="w-6 h-6 text-violet-600" /></div>
                <div>
                  <p className="font-semibold text-sm">{headProfile.name}</p>
                  <p className="text-xs text-muted-foreground"><Users className="w-3 h-3 inline mr-1" />{teamProfiles.length} {t('comm.members')}</p>
                </div>
              </div>
            </Card>
            <Card>
              <p className="text-sm text-muted-foreground">{t('comm.teamTotalND')}</p>
              <p className={cn('text-2xl font-bold', teamTotalND >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(teamTotalND)}</p>
            </Card>
            <Card>
              <p className="text-sm text-muted-foreground">{t('comm.autoSalary')}</p>
              <p className="text-2xl font-bold text-blue-600">{formatCurrency(autoSalary)}</p>
              <p className="text-xs text-muted-foreground mt-1">{HEAD_SALARY_TIERS.map((tier) => `≥${formatCurrency(tier.minND)} → ${formatCurrency(tier.salary)}`).join(' | ')}</p>
            </Card>
            <Card>
              <p className="text-sm text-muted-foreground">{t('comm.totalWithSalary')}</p>
              <p className={cn('text-2xl font-bold', teamSummary.totalWithSalary >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(teamSummary.totalWithSalary)}</p>
              {teamSummary.prevDebt < 0 && (
                <p className="text-xs text-warning mt-1">
                  {formatCurrency(teamSummary.rawTotalWithSalary)} − {formatCurrency(Math.abs(teamSummary.prevDebt))} deuda = {formatCurrency(teamSummary.totalWithSalary)}
                </p>
              )}
            </Card>
          </div>

          {/* Info */}
          <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-info/10/30 border border-info/30 text-blue-700 dark:text-blue-300 text-sm">
            <Info className="w-4 h-4 mt-0.5 shrink-0" /><span>{t('comm.teamFromHR')}</span>
          </div>

          {/* Validation warning */}
          {teamNdValidation && (
            <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-warning/10/30 border border-warning/30 text-amber-700 dark:text-amber-300 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                El ND total de este equipo ({formatCurrency(teamNdValidation.actual)}) no coincide con el valor ingresado en el grupo de <strong>{teamNdValidation.parentName}</strong> ({formatCurrency(teamNdValidation.expected)}). La suma del equipo debe ser igual.
              </span>
            </div>
          )}

          {/* Buscador libre — filtra solo las filas mostradas, no los totales */}
          <div className="relative flex items-center mb-3">
            <svg className="w-4 h-4 absolute left-2.5 text-muted-foreground pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={teamsSearch}
              onChange={(e) => setTeamsSearch(e.target.value)}
              placeholder={t('comm.searchPlaceholder')}
              className="pl-8 pr-8 py-1.5 text-base sm:text-sm border border-border rounded-md bg-background w-72 focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            {teamsSearch && (
              <button
                onClick={() => setTeamsSearch('')}
                className="absolute right-2 text-muted-foreground hover:text-foreground"
                aria-label={t('comm.clearSearch')}
              >
                ✕
              </button>
            )}
          </div>
          {teamsSearch && (
            <p className="text-xs text-muted-foreground mb-2">Mostrando filtrado por &quot;{teamsSearch}&quot;</p>
          )}

          {/* BDM Commission Table */}
          {bdmCalcs.length > 0 ? (
            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
                      <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('comm.role')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.ndCurrent')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.accumulated')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.division')}</th>
                      <th className="text-center py-2.5 px-3 text-muted-foreground font-medium">%</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.commission')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.realPayment')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.accNext')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* HEAD's own ND row — earns full percentage on own work */}
                    {headOwnCalc && (
                      <tr className="border-b border-border bg-violet-50/50 dark:bg-violet-950/20 hover:bg-violet-50 dark:hover:bg-violet-950/30">
                        <td className="px-3 py-3"><span className="font-semibold block">{headProfile.name}</span><span className="text-xs text-muted-foreground">{headProfile.email}</span></td>
                        <td className="px-3 py-3"><span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', ROLE_BADGE[headProfile.role])}>{ROLE_LABEL[headProfile.role]}</span></td>
                        <td className="px-3 py-3">
                          <input type="number" aria-label={t('comm.ndHeadAria')} placeholder={t('comm.ndPlaceholder')} title={t('comm.ndOverrideHint')} value={getNdDisplay(headProfile.id)} onChange={(e) => handleNdChange(headProfile.id, e.target.value)} onFocus={(e) => e.target.select()} className="w-28 px-2 py-1 text-right rounded border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                          <NdSourceTag source={getNdSource(headProfile.id)} auto={getNdAuto(headProfile.id)} labels={t} />
                        </td>
                        <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(headOwnCalc.accumulatedIn)}</td>
                        <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(headOwnCalc.division)}</td>
                        <td className="px-3 py-3 text-center text-xs font-medium">{headOwnCalc.commissionPct}%</td>
                        <td className={cn('px-3 py-3 text-right font-medium', headOwnCalc.commission >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(headOwnCalc.commission)}</td>
                        <td className="px-3 py-3 text-right font-semibold text-emerald-600">{formatCurrency(headOwnCalc.realPayment)}</td>
                        <td className={cn('px-3 py-3 text-right', headOwnCalc.accumulatedOut < 0 ? 'text-red-600' : 'text-muted-foreground')}>{formatCurrency(headOwnCalc.accumulatedOut)}</td>
                      </tr>
                    )}
                    {/* BDM rows */}
                    {bdmCalcs.filter((calc) => matchesCommissionSearch(calc as unknown as Record<string, unknown>, teamsSearch, profileLookup, headLookup)).map((calc) => {
                      const profile = commercialProfiles.find((p) => p.id === calc.profileId);
                      if (!profile) return null;
                      const hasOwnTeam = commercialProfiles.some((sub) => sub.head_id === profile.id && appearsInCommissions(sub));
                      return (
                        <tr key={calc.profileId} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                          <td className="px-3 py-3">
                            <span className={cn('font-medium block', firedNameClass(profile))}>
                              {profile.name}{hasOwnTeam && <span className="ml-1 text-[10px] text-violet-500">(equipo)</span>}
                              {profile.role === 'bdm_global' && (
                                <span className="inline-block ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800 border border-purple-300">GLOBAL</span>
                              )}
                              <FiredBadge profile={profile} />
                            </span>
                            <span className="text-xs text-muted-foreground">{profile.email}</span>
                          </td>
                          <td className="px-3 py-3"><span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', ROLE_BADGE[profile.role])}>{ROLE_LABEL[profile.role]}</span></td>
                          <td className="px-3 py-3">
                            <input type="number" aria-label={t('comm.ndProfileAria')} placeholder={t('comm.ndPlaceholder')} title={t('comm.ndOverrideHint')} value={getNdDisplay(calc.profileId)} onChange={(e) => handleNdChange(calc.profileId, e.target.value)} onFocus={(e) => e.target.select()} className="w-28 px-2 py-1 text-right rounded border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                            <NdSourceTag source={getNdSource(calc.profileId)} auto={getNdAuto(calc.profileId)} labels={t} />
                          </td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.accumulatedIn)}</td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.division)}</td>
                          <td className="px-3 py-3 text-center text-xs font-medium">
                            <span className="text-violet-600">{calc.diffPct}%</span>
                            <span className="block text-muted-foreground text-[10px]">({calc.bdmOwnPct}% base)</span>
                          </td>
                          <td className={cn('px-3 py-3 text-right font-medium', calc.commission >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(calc.commission)}</td>
                          <td className="px-3 py-3 text-right font-semibold text-emerald-600">{formatCurrency(calc.realPayment)}</td>
                          <td className={cn('px-3 py-3 text-right', calc.accumulatedOut < 0 ? 'text-red-600' : 'text-muted-foreground')}>{formatCurrency(calc.accumulatedOut)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/50 font-semibold">
                      <td className="px-3 py-3" colSpan={2}>{t('comm.groupTotal')}</td>
                      <td className="px-3 py-3 text-right">{formatCurrency(teamTotalND)}</td>
                      <td className="px-3 py-3" colSpan={4}></td>
                      <td className={cn('px-3 py-3 text-right', teamSummary.totalPayment >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(teamSummary.totalPayment)}</td>
                      <td className="px-3 py-3 text-right">
                        <span className={cn(teamSummary.totalPayment >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(teamSummary.totalPayment)}</span>
                        {autoSalary > 0 && (
                          <span className="block text-blue-600 text-xs">+ {formatCurrency(autoSalary)} sal. = {formatCurrency(teamSummary.totalWithSalary)}</span>
                        )}
                      </td>
                      <td className="px-3 py-3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
          ) : (
            <Card><p className="text-center text-muted-foreground py-8">{t('comm.noData')}</p></Card>
          )}
        </>
      )}

      {tab === 'teams' && !selectedHeadId && (
        <Card><p className="text-center text-muted-foreground py-8">{t('comm.selectHead')}</p></Card>
      )}

      {/* ═══════════ TAB: INDIVIDUAL ═══════════ */}
      {tab === 'individual' && (
        <>
          <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-info/10/30 border border-info/30 text-blue-700 dark:text-blue-300 text-sm">
            <Info className="w-4 h-4 mt-0.5 shrink-0" /><span>{t('comm.allBdms')} — {allBdms.length} BDMs</span>
          </div>

          {/* Buscador libre — filtra las 4 sub-tablas a la vez, no los totales */}
          <div className="relative flex items-center mt-2">
            <svg className="w-4 h-4 absolute left-2.5 text-muted-foreground pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={individualSearch}
              onChange={(e) => setIndividualSearch(e.target.value)}
              placeholder={t('comm.searchPlaceholder')}
              className="pl-8 pr-8 py-1.5 text-base sm:text-sm border border-border rounded-md bg-background w-72 focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            {individualSearch && (
              <button
                onClick={() => setIndividualSearch('')}
                className="absolute right-2 text-muted-foreground hover:text-foreground"
                aria-label={t('comm.clearSearch')}
              >
                ✕
              </button>
            )}
          </div>
          {individualSearch && (
            <p className="text-xs text-muted-foreground">Mostrando filtrado por &quot;{individualSearch}&quot;</p>
          )}

          {/* ── Section: Net Deposit ── */}
          <h3 className="text-base font-semibold flex items-center gap-2 mt-2">
            <Calculator className="w-4 h-4 text-emerald-600" />
            {t('comm.sectionND')}
            <span className="text-xs text-muted-foreground font-normal">({ndBdms.length})</span>
          </h3>
          {ndBdms.length > 0 ? (
            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
                      <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">HEAD</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.ndCurrent')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.accumulated')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.division')}</th>
                      <th className="text-center py-2.5 px-3 text-muted-foreground font-medium">%</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.commission')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.realPayment')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.salary')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">Total</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.accNext')}</th>
                      <th className="py-2.5 px-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {indCalcs.filter((c) => ndBdms.some((b) => b.id === c.profileId)).filter((calc) => matchesCommissionSearch(calc as unknown as Record<string, unknown>, individualSearch, profileLookup, headLookup)).map((calc) => {
                      const profile = commercialProfiles.find((p) => p.id === calc.profileId);
                      if (!profile) return null;
                      const headName = profile.head_id ? commercialProfiles.find((p) => p.id === profile.head_id)?.name : '—';
                      return (
                        <tr key={calc.profileId} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                          <td className="px-3 py-3"><span className={cn('font-medium block', firedNameClass(profile))}>{profile.name}{profile.role === 'bdm_global' && (<span className="inline-block ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800 border border-purple-300">GLOBAL</span>)}<FiredBadge profile={profile} /></span><span className="text-xs text-muted-foreground">{profile.email}</span></td>
                          <td className="px-3 py-3 text-xs text-muted-foreground">{headName}</td>
                          <td className="px-3 py-3">
                            <input type="number" aria-label={t('comm.ndProfileAria')} placeholder={t('comm.ndPlaceholder')} title={t('comm.ndOverrideHint')} value={getNdDisplay(calc.profileId)} onChange={(e) => handleNdChange(calc.profileId, e.target.value)} onFocus={(e) => e.target.select()} className="w-28 px-2 py-1 text-right rounded border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                            <NdSourceTag source={getNdSource(calc.profileId)} auto={getNdAuto(calc.profileId)} labels={t} />
                          </td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.accumulatedIn)}</td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.division)}</td>
                          <td className="px-3 py-3 text-center text-xs font-medium">{calc.commissionPct}%</td>
                          <td className={cn('px-3 py-3 text-right font-medium', calc.commission >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(calc.commission)}</td>
                          <td className="px-3 py-3 text-right font-semibold text-emerald-600">{formatCurrency(calc.realPayment)}</td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.salary)}</td>
                          <td className="px-3 py-3 text-right font-semibold">
                            {(() => {
                              const rawTE = calc.realPayment + calc.salary;
                              const prevDebt = getPrevDebtAll(calc.profileId);
                              const { finalTotalEarned } = applyTotalEarnedDebt(prevDebt, rawTE);
                              return (
                                <span className={prevDebt < 0 ? 'text-orange-600' : ''}>
                                  {formatCurrency(finalTotalEarned)}
                                  {prevDebt < 0 && (
                                    <span className="block text-[10px] text-orange-500">deuda: {formatCurrency(prevDebt)}</span>
                                  )}
                                </span>
                              );
                            })()}
                          </td>
                          <td className={cn('px-3 py-3 text-right', calc.accumulatedOut < 0 ? 'text-red-600' : 'text-muted-foreground')}>{formatCurrency(calc.accumulatedOut)}</td>
                          <td className="px-2 py-3">
                            <div className="flex items-center gap-1 justify-center">
                              <button
                                onClick={() => handleSaveBdm(calc.profileId, 'nd')}
                                disabled={savingBdm.has(calc.profileId)}
                                className="p-2 sm:p-1.5 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-950/30 text-emerald-600 hover:text-emerald-700 transition-colors disabled:opacity-50"
                                title={t('comm.saveBdm')}
                              >
                                {savingBdm.has(calc.profileId)
                                  ? <Loader2 className="w-4 h-4 animate-spin" />
                                  : <Save className="w-4 h-4" />}
                              </button>
                              <button
                                onClick={() => verify2FA(async () => {
                                  if (!selectedPeriod) return;
                                  const headP = profile.head_id ? commercialProfiles.find(p => p.id === profile.head_id) : null;
                                  const { generateIndividualPDF } = await loadPdfExports();
                                  generateIndividualPDF({
                                    companyName: company?.name ?? 'Smart Dashboard',
                                    companyLogoUrl: company?.logo_url ?? null,
                                    periodLabel: selectedPeriod.label || `${selectedPeriod.month}/${selectedPeriod.year}`,
                                    name: profile.name,
                                    email: profile.email,
                                    role: ROLE_LABEL[profile.role] || profile.role,
                                    headName: headP?.name ?? '—',
                                    pct: calc.commissionPct,
                                    nd: calc.netDepositCurrent,
                                    accumulatedIn: calc.accumulatedIn,
                                    division: calc.division,
                                    commission: calc.commission,
                                    realPayment: calc.realPayment,
                                    accumulatedOut: calc.accumulatedOut,
                                    salary: calc.salary,
                                    // Con la MISMA regla de deuda que la tabla
                                    // y el guardado: el PDF decía $5.000
                                    // cuando se pagaban $3.000 porque ignoraba
                                    // la deuda arrastrada (auditoría 2026-08-06).
                                    total: applyTotalEarnedDebt(
                                      getPrevDebtAll(calc.profileId),
                                      calc.realPayment + calc.salary,
                                    ).finalTotalEarned,
                                    // Deuda arrastrada para mostrarla en el
                                    // resumen (si negativa) y que el TOTAL cuadre.
                                    prevDebt: getPrevDebtAll(calc.profileId),
                                  });
                                })}
                                className="p-2 sm:p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 text-red-500 hover:text-red-600 transition-colors"
                                title={t('comm.downloadPdf')}
                              >
                                <FileText className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/50 font-semibold">
                      <td className="px-3 py-3" colSpan={2}>{t('comm.groupTotal')}</td>
                      <td className="px-3 py-3 text-right">{formatCurrency(indCalcs.filter((c) => ndBdms.some((b) => b.id === c.profileId)).reduce((s, c) => s + c.netDepositCurrent, 0))}</td>
                      <td className="px-3 py-3" colSpan={4}></td>
                      <td className={cn('px-3 py-3 text-right', indSummary.totalCommission >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(indCalcs.filter((c) => ndBdms.some((b) => b.id === c.profileId)).reduce((s, c) => s + c.realPayment, 0))}</td>
                      <td className="px-3 py-3 text-right text-emerald-600">{formatCurrency(indCalcs.filter((c) => ndBdms.some((b) => b.id === c.profileId)).reduce((s, c) => s + c.realPayment, 0))}</td>
                      <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(indCalcs.filter((c) => ndBdms.some((b) => b.id === c.profileId)).reduce((s, c) => s + c.salary, 0))}</td>
                      <td className="px-3 py-3 text-right font-semibold">{formatCurrency(indCalcs.filter((c) => ndBdms.some((b) => b.id === c.profileId)).reduce((s, c) => s + c.realPayment + c.salary, 0))}</td>
                      <td className="px-3 py-3"></td>
                      <td className="px-2 py-3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
          ) : (
            <Card><p className="text-center text-muted-foreground py-8">{t('comm.noBdmsInSection')}</p></Card>
          )}

          {/* ── Section: PnL ── */}
          <h3 className="text-base font-semibold flex items-center gap-2 mt-6">
            <BarChart3 className="w-4 h-4 text-blue-600" />
            {t('comm.sectionPnL')}
            <span className="text-xs text-muted-foreground font-normal">({pnlBdms.length})</span>
          </h3>
          {pnlBdms.length > 0 ? (
            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
                      <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">HEAD</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">PnL</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.lotCommShort')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.accumulated')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.division')}</th>
                      <th className="text-center py-2.5 px-3 text-muted-foreground font-medium">%</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.commission')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.realPayment')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">Total</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.accNext')}</th>
                      <th className="py-2.5 px-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pnlCalcs.filter((calc) => matchesCommissionSearch(calc as unknown as Record<string, unknown>, individualSearch, profileLookup, headLookup)).map((calc) => {
                      const profile = commercialProfiles.find((p) => p.id === calc.profileId);
                      if (!profile) return null;
                      const headName = profile.head_id ? commercialProfiles.find((p) => p.id === profile.head_id)?.name : '—';
                      return (
                        <tr key={calc.profileId} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                          <td className="px-3 py-3"><span className={cn('font-medium block', firedNameClass(profile))}>{profile.name}{profile.role === 'bdm_global' && (<span className="inline-block ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800 border border-purple-300">GLOBAL</span>)}<FiredBadge profile={profile} /></span><span className="text-xs text-muted-foreground">{profile.email}</span></td>
                          <td className="px-3 py-3 text-xs text-muted-foreground">{headName}</td>
                          <td className="px-3 py-3">
                            <input type="number" aria-label={t('comm.ndProfileAria')} value={getNdDisplay(calc.profileId)} onChange={(e) => handleNdChange(calc.profileId, e.target.value)} onFocus={(e) => e.target.select()} className="w-28 px-2 py-1 text-right rounded border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]" />
                          </td>
                          <td className="px-3 py-3">
                            <input
                              type="number"
                              value={getLotDisplay(calc.profileId)}
                              onChange={(e) => handleLotChange(calc.profileId, e.target.value)}
                              onFocus={(e) => e.target.select()}
                              placeholder="0"
                              className="w-24 px-2 py-1 text-right rounded border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                            />
                          </td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.accumulatedIn)}</td>
                          <td className="px-3 py-3 text-right text-muted-foreground">{formatCurrency(calc.division)}</td>
                          <td className="px-3 py-3 text-center text-xs font-medium">{calc.commissionPct}%</td>
                          <td className={cn('px-3 py-3 text-right font-medium', calc.commission >= 0 ? 'text-emerald-600' : 'text-red-600')}>{formatCurrency(calc.commission)}</td>
                          <td className="px-3 py-3 text-right font-semibold">
                            {(() => {
                              const lotComm = lotInputs.get(calc.profileId) ?? 0;
                              const finalReal = calc.realPayment - lotComm;
                              return (
                                <span className={finalReal >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                                  {formatCurrency(finalReal)}
                                  {lotComm > 0 && (
                                    <span className="block text-[10px] text-muted-foreground">
                                      {formatCurrency(calc.realPayment)} − {formatCurrency(lotComm)} lotes
                                    </span>
                                  )}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-3 text-right font-semibold">
                            {(() => {
                              const lotComm = lotInputs.get(calc.profileId) ?? 0;
                              const adjustedReal = calc.realPayment - lotComm;
                              const rawTE = adjustedReal + calc.salary;
                              const prevDebt = getPrevDebtAll(calc.profileId);
                              const { finalTotalEarned } = applyTotalEarnedDebt(prevDebt, rawTE);
                              return (
                                <span className={prevDebt < 0 ? 'text-orange-600' : ''}>
                                  {formatCurrency(finalTotalEarned)}
                                  {prevDebt < 0 && (
                                    <span className="block text-[10px] text-orange-500">deuda: {formatCurrency(prevDebt)}</span>
                                  )}
                                </span>
                              );
                            })()}
                          </td>
                          <td className={cn('px-3 py-3 text-right', calc.accumulatedOut < 0 ? 'text-red-600' : 'text-muted-foreground')}>{formatCurrency(calc.accumulatedOut)}</td>
                          <td className="px-2 py-3">
                            <div className="flex items-center gap-1 justify-center">
                              <button
                                onClick={() => handleSaveBdm(calc.profileId, 'pnl')}
                                disabled={savingBdm.has(calc.profileId)}
                                className="p-2 sm:p-1.5 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-950/30 text-emerald-600 hover:text-emerald-700 transition-colors disabled:opacity-50"
                                title={t('comm.saveBdm')}
                              >
                                {savingBdm.has(calc.profileId)
                                  ? <Loader2 className="w-4 h-4 animate-spin" />
                                  : <Save className="w-4 h-4" />}
                              </button>
                              <button
                                onClick={() => verify2FA(async () => {
                                  if (!selectedPeriod) return;
                                  const headP = profile.head_id ? commercialProfiles.find(p => p.id === profile.head_id) : null;
                                  const lotComm = lotInputs.get(calc.profileId) ?? 0;
                                  const adjustedReal = calc.realPayment - lotComm;
                                  const { generatePnlPDF } = await loadPdfExports();
                                  generatePnlPDF({
                                    companyName: company?.name ?? 'Smart Dashboard',
                                    companyLogoUrl: company?.logo_url ?? null,
                                    periodLabel: selectedPeriod.label || `${selectedPeriod.month}/${selectedPeriod.year}`,
                                    name: profile.name,
                                    email: profile.email,
                                    role: ROLE_LABEL[profile.role] || profile.role,
                                    headName: headP?.name ?? '—',
                                    pct: calc.commissionPct,
                                    pnl: calc.netDepositCurrent,
                                    accumulatedIn: calc.accumulatedIn,
                                    division: calc.division,
                                    commission: calc.commission,
                                    lotCommissions: lotComm,
                                    realPayment: adjustedReal,
                                    accumulatedOut: calc.accumulatedOut,
                                    salary: calc.salary,
                                    total: adjustedReal + calc.salary,
                                  });
                                })}
                                className="p-2 sm:p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 text-red-500 hover:text-red-600 transition-colors"
                                title={t('comm.downloadPdf')}
                              >
                                <FileText className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/50 font-semibold">
                      <td className="px-3 py-3" colSpan={2}>{t('comm.groupTotal')}</td>
                      <td className="px-3 py-3 text-right">{formatCurrency(pnlCalcs.reduce((s, c) => s + c.netDepositCurrent, 0))}</td>
                      <td className="px-3 py-3" colSpan={5}></td>
                      <td className="px-3 py-3 text-right text-emerald-600">{formatCurrency(pnlSummary.totalRealPayment)}</td>
                      <td className="px-3 py-3 text-right font-semibold">{formatCurrency(pnlSummary.totalWithSalary)}</td>
                      <td className="px-3 py-3"></td>
                      <td className="px-2 py-3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
          ) : (
            <Card><p className="text-center text-muted-foreground py-8">{t('comm.noBdmsInSection')}</p></Card>
          )}

          {/* ── Section: PnL Especial ── */}
          {/* Solo se renderiza si hay al menos un perfil con pnl_special_mode=true.
              Columnas reducidas (sin División, Acumulado, Acc→Sig), badge violeta
              "Especial" junto al nombre, botón admin-only de "Recalcular histórico". */}
          {pnlSpecialBdms.length > 0 && (
            <>
              <div className="flex items-center justify-between mt-6 gap-2 flex-wrap">
                <h3 className="text-base font-semibold flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-violet-600" />
                  {t('comm.sectionPnLSpecial')}
                  <span className="text-xs text-muted-foreground font-normal">({pnlSpecialBdms.length})</span>
                </h3>
                {isCompanyAdmin(user) && (
                  <button
                    onClick={() => handleRecalcHistory()}
                    disabled={recalcInProgress}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-violet-300 dark:border-violet-800 text-violet-700 dark:text-violet-400 text-xs font-medium hover:bg-violet-50 dark:hover:bg-violet-950/30 disabled:opacity-50"
                    title={t('comm.recalcHistoryTitle')}
                  >
                    {recalcInProgress ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    {recalcInProgress ? t('comm.recalcHistoryInProgress') : t('comm.recalcHistoryButton')}
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground -mt-1 mb-2">{t('comm.sectionPnLSpecialHint')}</p>
              <Card className="p-0 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[800px]">
                    <thead>
                      <tr className="border-b border-border bg-muted/50">
                        <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
                        <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">HEAD</th>
                        <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">PnL</th>
                        <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.lotCommShort')}</th>
                        <th className="text-center py-2.5 px-3 text-muted-foreground font-medium">%</th>
                        <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.commission')}</th>
                        <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.realPayment')}</th>
                        <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">Total</th>
                        <th className="py-2.5 px-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {pnlSpecialCalcs.filter((calc) => matchesCommissionSearch(calc as unknown as Record<string, unknown>, individualSearch, profileLookup, headLookup)).map((calc) => {
                        const profile = commercialProfiles.find((p) => p.id === calc.profileId);
                        if (!profile) return null;
                        const headName = profile.head_id
                          ? commercialProfiles.find((p) => p.id === profile.head_id)?.name
                          : '—';
                        const prevDebt = getPrevDebtAll(calc.profileId);
                        const rawTE = calc.realPayment + calc.salary;
                        const { finalTotalEarned } = applyTotalEarnedDebt(prevDebt, rawTE);
                        return (
                          <tr key={calc.profileId} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                            <td className="px-3 py-3">
                              <span className={cn('font-medium block', firedNameClass(profile))}>
                                {profile.name}
                                <FiredBadge profile={profile} />
                                <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300 align-middle">
                                  {t('comm.specialBadge')}
                                </span>
                              </span>
                              <span className="text-xs text-muted-foreground">{profile.email}</span>
                            </td>
                            <td className="px-3 py-3 text-xs text-muted-foreground">{headName}</td>
                            <td className="px-3 py-3">
                              <input
                                type="number"
                                value={getNdDisplay(calc.profileId)}
                                onChange={(e) => handleNdChange(calc.profileId, e.target.value)}
                                onFocus={(e) => e.target.select()}
                                className="w-28 px-2 py-1 text-right rounded border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                              />
                            </td>
                            <td className="px-3 py-3">
                              <input
                                type="number"
                                value={getLotDisplay(calc.profileId)}
                                onChange={(e) => handleLotChange(calc.profileId, e.target.value)}
                                onFocus={(e) => e.target.select()}
                                placeholder="0"
                                className="w-24 px-2 py-1 text-right rounded border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                              />
                            </td>
                            <td className="px-3 py-3 text-center text-xs font-medium">{calc.commissionPct}%</td>
                            <td className={cn('px-3 py-3 text-right font-medium', calc.commission >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                              {formatCurrency(calc.commission)}
                            </td>
                            <td className="px-3 py-3 text-right font-semibold">
                              <span className={calc.realPayment >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                                {formatCurrency(calc.realPayment)}
                                {calc.lotCommissions > 0 && (
                                  <span className="block text-[10px] text-muted-foreground">
                                    {formatCurrency(calc.commission)} − {formatCurrency(calc.lotCommissions)} lotes
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-right font-semibold">
                              <span className={prevDebt < 0 ? 'text-orange-600' : ''}>
                                {formatCurrency(finalTotalEarned)}
                                {prevDebt < 0 && (
                                  <span className="block text-[10px] text-orange-500">deuda: {formatCurrency(prevDebt)}</span>
                                )}
                              </span>
                            </td>
                            <td className="px-2 py-3">
                              <div className="flex items-center gap-1 justify-center">
                                <button
                                  onClick={() => handleSaveBdm(calc.profileId, 'pnlSpecial')}
                                  disabled={savingBdm.has(calc.profileId)}
                                  className="p-2 sm:p-1.5 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-950/30 text-emerald-600 hover:text-emerald-700 transition-colors disabled:opacity-50"
                                  title={t('comm.saveBdm')}
                                >
                                  {savingBdm.has(calc.profileId)
                                    ? <Loader2 className="w-4 h-4 animate-spin" />
                                    : <Save className="w-4 h-4" />}
                                </button>
                                {/* PDF: mismo reporte que PnL normal, pero con los valores
                                    del modo Especial — accumulatedIn=0, division=0,
                                    accumulatedOut=0 reflejan la regla "no hay acumulado". */}
                                <button
                                  onClick={() => verify2FA(async () => {
                                    if (!selectedPeriod) return;
                                    const headP = profile.head_id
                                      ? commercialProfiles.find(p => p.id === profile.head_id)
                                      : null;
                                    const { generatePnlPDF } = await loadPdfExports();
                                    generatePnlPDF({
                                      companyName: company?.name ?? 'Smart Dashboard',
                                      companyLogoUrl: company?.logo_url ?? null,
                                      periodLabel: selectedPeriod.label || `${selectedPeriod.month}/${selectedPeriod.year}`,
                                      name: profile.name,
                                      email: profile.email,
                                      role: ROLE_LABEL[profile.role] || profile.role,
                                      headName: headP?.name ?? '—',
                                      pct: calc.commissionPct,
                                      pnl: calc.pnl,
                                      accumulatedIn: 0,
                                      division: 0,
                                      commission: calc.commission,
                                      lotCommissions: calc.lotCommissions,
                                      realPayment: calc.realPayment,
                                      accumulatedOut: 0,
                                      salary: calc.salary,
                                      total: calc.realPayment + calc.salary,
                                      mode: 'special',
                                    });
                                  })}
                                  className="p-2 sm:p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 text-red-500 hover:text-red-600 transition-colors"
                                  title={t('comm.downloadPdf')}
                                >
                                  <FileText className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-muted/50 font-semibold">
                        <td className="px-3 py-3" colSpan={2}>{t('comm.groupTotal')}</td>
                        <td className="px-3 py-3 text-right">{formatCurrency(pnlSpecialCalcs.reduce((s, c) => s + c.pnl, 0))}</td>
                        <td className="px-3 py-3" colSpan={3}></td>
                        <td className="px-3 py-3 text-right text-emerald-600">{formatCurrency(pnlSpecialSummary.totalRealPayment)}</td>
                        <td className="px-3 py-3 text-right font-semibold">{formatCurrency(pnlSpecialSummary.totalWithSalary)}</td>
                        <td className="px-2 py-3"></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Card>
            </>
          )}

          {/* ── Section: Commission per Lot ── */}
          <h3 className="text-base font-semibold flex items-center gap-2 mt-6">
            <FileSpreadsheet className="w-4 h-4 text-amber-600" />
            {t('comm.sectionLot')}
            <span className="text-xs text-muted-foreground font-normal">({lotBdms.length})</span>
          </h3>
          {lotBdms.length > 0 ? (
            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
                      <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">HEAD</th>
                      <th className="text-center py-2.5 px-3 text-muted-foreground font-medium">{t('comm.usdPerLot')}</th>
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('comm.commission')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lotBdms.filter((profile) => matchesCommissionSearch(profile as unknown as Record<string, unknown>, individualSearch, profileLookup, headLookup)).map((profile) => {
                      const headName = profile.head_id ? commercialProfiles.find((p) => p.id === profile.head_id)?.name : '—';
                      return (
                        <tr key={profile.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                          <td className="px-3 py-3"><span className={cn('font-medium block', firedNameClass(profile))}>{profile.name}{profile.role === 'bdm_global' && (<span className="inline-block ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800 border border-purple-300">GLOBAL</span>)}<FiredBadge profile={profile} /></span><span className="text-xs text-muted-foreground">{profile.email}</span></td>
                          <td className="px-3 py-3 text-xs text-muted-foreground">{headName}</td>
                          <td className="px-3 py-3 text-center text-xs font-medium">{formatCurrency(profile.commission_per_lot ?? 0)}</td>
                          <td className="px-3 py-3 text-right text-muted-foreground italic text-xs">—</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : (
            <Card><p className="text-center text-muted-foreground py-8">{t('comm.noBdmsInSection')}</p></Card>
          )}
        </>
      )}
      {/* ═══════════ TAB: HISTORY ═══════════ */}
      {tab === 'history' && (() => {
        // Historial: excluir despedidos (status inactive + termination_date). En
      // Equipos/Individual sí aparecen para cargar negativos post-despido, pero
      // en el Historial no se quieren ver.
      const activeProfiles = commercialProfiles.filter(
        (p) => appearsInCommissions(p) && !(p.status === 'inactive' && p.termination_date),
      );
        const smProfiles = activeProfiles.filter((p) => p.role === 'sales_manager');
        const headProfiles = activeProfiles.filter((p) => p.role === 'head');
        const bdmProfiles = activeProfiles.filter((p) => p.role === 'bdm' || p.role === 'bdm_global');
        const allProfiles = [...smProfiles, ...headProfiles, ...bdmProfiles];

        const getTotal = (profileId: string, periodId: string) => {
          const profile = allProfiles.find(p => p.id === profileId);
          const records = monthlyResults.filter(
            (mr) => mr.profile_id === profileId && mr.period_id === periodId
          );
          if (records.length === 0) return null;
          let val: number;
          // Para HEADs/SM: buscar registro donde head_id = su propio ID (su grupo)
          const ownGroupRecord = records.find(r => r.head_id === profileId);
          if (ownGroupRecord) {
            val = ownGroupRecord.total_earned;
          } else if (profile?.head_id) {
            // Para BDMs: buscar registro donde head_id = su HEAD real
            const headRecord = records.find(r => r.head_id === profile.head_id);
            val = headRecord ? headRecord.total_earned : records.reduce((best, r) =>
              Math.abs(r.total_earned) > Math.abs(best.total_earned) ? r : best
            ).total_earned;
          } else {
            val = records.reduce((best, r) =>
              Math.abs(r.total_earned) > Math.abs(best.total_earned) ? r : best
            ).total_earned;
          }
          // Negativos se muestran como 0 en historial (solo visualización)
          return val < 0 ? 0 : val;
        };

        const getProfileTotal = (profileId: string) => {
          return historyPeriods.reduce((sum, p) => {
            const val = getTotal(profileId, p.id);
            return sum + (val ?? 0);
          }, 0);
        };

        return (
          <>
            {/* History period filter */}
            <Card>
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-1.5">{t('audit.filterFrom')}</label>
                  <select value={historyFrom} onChange={(e) => setHistoryFrom(Number(e.target.value))} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
                    {sortedPeriods.map((p, i) => <option key={p.id} value={i}>{p.label || `${p.year}-${String(p.month).padStart(2, '0')}`}</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-1.5">{t('audit.filterTo')}</label>
                  <select value={historyTo} onChange={(e) => setHistoryTo(Number(e.target.value))} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]">
                    {sortedPeriods.map((p, i) => <option key={p.id} value={i}>{p.label || `${p.year}-${String(p.month).padStart(2, '0')}`}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex items-end">
                <button
                  onClick={() => refresh()}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
                  Actualizar datos
                </button>
              </div>
            </Card>

            {/* Buscador libre — filtra solo las filas, no el footer de totales */}
            <div className="relative flex items-center">
              <svg className="w-4 h-4 absolute left-2.5 text-muted-foreground pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder={t('comm.searchPlaceholder')}
                className="pl-8 pr-8 py-1.5 text-base sm:text-sm border border-border rounded-md bg-background w-72 focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              {historySearch && (
                <button
                  onClick={() => setHistorySearch('')}
                  className="absolute right-2 text-muted-foreground hover:text-foreground"
                  aria-label={t('comm.clearSearch')}
                >
                  ✕
                </button>
              )}
            </div>
            {historySearch && (
              <p className="text-xs text-muted-foreground">Mostrando filtrado por &quot;{historySearch}&quot;</p>
            )}

            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left py-2.5 px-3 text-muted-foreground font-medium sticky left-0 bg-muted/50 z-10 min-w-[180px]">{t('common.name')}</th>
                      <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('comm.role')}</th>
                      {historyPeriods.map((p) => (
                        <th key={p.id} className="text-right py-2.5 px-3 text-muted-foreground font-medium whitespace-nowrap">
                          {p.label || `${p.year}-${String(p.month).padStart(2, '0')}`}
                        </th>
                      ))}
                      <th className="text-right py-2.5 px-3 text-muted-foreground font-medium bg-muted/80">{t('comm.totalAll')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allProfiles.filter((profile) => matchesCommissionSearch(profile as unknown as Record<string, unknown>, historySearch, profileLookup, headLookup)).map((profile, idx) => {
                      const prevRole = idx > 0 ? allProfiles[idx - 1].role : null;
                      const showSeparator = prevRole && prevRole !== profile.role;
                      const total = getProfileTotal(profile.id);
                      return (
                        <tr key={profile.id} className={cn('border-b border-border/50 hover:bg-muted/50 transition-colors', showSeparator && 'border-t-2 border-t-border')}>
                          <td className="px-4 py-2.5 sticky left-0 bg-card z-10"><span className={cn('font-medium block', firedNameClass(profile))}>{profile.name}{profile.role === 'bdm_global' && (<span className="inline-block ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800 border border-purple-300">GLOBAL</span>)}<FiredBadge profile={profile} />{profile.pnl_special_mode && (<span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300 align-middle">{t('comm.specialBadge')}</span>)}</span><span className="text-xs text-muted-foreground">{profile.email}</span></td>
                          <td className="px-2 py-2.5">
                            <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-medium', ROLE_BADGE[profile.role])}>
                              {ROLE_LABEL[profile.role]}
                            </span>
                          </td>
                          {historyPeriods.map((p) => {
                            const val = getTotal(profile.id, p.id);
                            return (
                              <td key={p.id} className={cn('px-3 py-2.5 text-right text-xs', val === null ? 'text-muted-foreground' : val >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                                {val !== null ? formatCurrency(val) : '—'}
                              </td>
                            );
                          })}
                          <td className={cn('px-4 py-2.5 text-right font-semibold bg-muted/30', total >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                            {formatCurrency(total)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/50 font-semibold">
                      <td className="px-3 py-3 sticky left-0 bg-muted/50 z-10">Total</td>
                      <td className="px-2 py-3"></td>
                      {historyPeriods.map((p) => {
                        const monthTotal = allProfiles.reduce((sum, profile) => {
                          const val = getTotal(profile.id, p.id);
                          return sum + (val ?? 0);
                        }, 0);
                        return (
                          <td key={p.id} className={cn('px-3 py-3 text-right text-xs', monthTotal >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                            {formatCurrency(monthTotal)}
                          </td>
                        );
                      })}
                      <td className={cn('px-3 py-3 text-right bg-muted/80', (() => { const gt = allProfiles.reduce((s, p) => s + getProfileTotal(p.id), 0); return gt >= 0 ? 'text-emerald-600' : 'text-red-600'; })())}>
                        {formatCurrency(allProfiles.reduce((s, p) => s + getProfileTotal(p.id), 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
          </>
        );
      })()}

      {/* Save button + toast at bottom */}
      <div className="flex items-center justify-end gap-4 sticky bottom-4">
        {toast && (
          <div className={cn('flex items-center gap-2 px-4 py-3 rounded-lg text-sm shadow-lg', toast.type === 'success' ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white')}>
            {toast.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}{toast.msg}
          </div>
        )}
        {/* Disable while EITHER the master save OR any per-row save is in
            flight. Skipping the per-row check let users hit Guardar mid-save
            of a single BDM, which races the two updates and can leave one
            with stale data. */}
        <button
          onClick={handleSave}
          disabled={saving || savingBdm.size > 0}
          className="flex items-center gap-2 px-6 py-3 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 shadow-lg"
        >
          <Save className="w-5 h-5" />{saving ? t('comm.saving') : t('comm.save')}
        </button>
      </div>
    </div>
  );
}
