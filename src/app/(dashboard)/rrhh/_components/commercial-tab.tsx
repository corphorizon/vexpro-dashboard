'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, moneyText } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Segmented } from '@/components/ui/segmented';
import { Chip } from '@/components/ui/chip';
import { ActionButton } from '@/components/ui/action-button';
import { useI18n } from '@/lib/i18n';
import { useData } from '@/lib/data-context';
import { cn } from '@/lib/utils';
import { deleteCommercialProfile, updateCommercialProfile } from '@/lib/supabase/mutations';
import { FiredBadge, firedNameClass } from '@/components/fired-badge';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import type { CommercialProfile } from '@/lib/types';
import {
  esBdm,
  esBdmGlobal,
  esLider,
  hrRoleLabel,
  sinSalario,
} from '@/lib/hr/domain';
import {
  indexarNetDelCrm,
  resolveNetDepositInput,
  type ResolvedNetDeposit,
} from '@/lib/hr/net-deposit-input';
import { comisionIndividualDeBdm, type ComisionDelMes } from '@/lib/hr/commission-preview';
import { manualDeEstructura } from '@/lib/hr/overview';
import { getAccumulatedIn, getPreviousPeriod } from '@/lib/commission-calculator';
import {
  totalesDe,
  totalesGenerales,
  totalesPorPerfil,
  type MonthlyResultRow,
} from '@/lib/hr/monthly-totals';
import { ProfileForm } from './profile-form';
import { useHrPeriod } from './hr-period-context';
import { NetWithSource, ROW_ACTION_CLASS, ROW_DANGER_CLASS, SearchField, TOGGLE_CLASS } from './hr-ui';
import {
  PROFILE_STATUS_FILTERS,
  matchesStatusFilter,
  pctText,
  profileStatusView,
  supervisorChain,
  type ProfileStatusFilter,
} from './hr-view';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña FUERZA COMERCIAL — las tarjetas de equipo, los BDM independientes y
// los resultados por período.
//
// ── El Net del CRM ahora sigue al selector ─────────────────────────────────
// Kevin, 2026-08-31: «lo de los net de los bdms y heads sigo sin verlo
// automatizado». El rollup automático vivía sólo en la pestaña Net Deposit, así
// que el 30/08 se agregó a estas tarjetas con un fetch propio del MES CORRIENTE
// FIJO — un parche: la tarjeta decía "Net CRM (mes)" y era otro mes que el que
// mostraba la pestaña de al lado. Ahora sale del overview del módulo y el mes es
// EL DEL SELECTOR, uno solo para todas las pestañas.
//
// `crmNet === null` significa "todavía no lo sabemos" (cargando, o el slice
// falló) y se pinta "—". Nunca $0: un cero acá diría "este equipo no produjo".
//
// ── Y desde la tanda 2, es el MISMO insumo que el motor de comisiones ───────
// El Net CRM de estas tarjetas ya no es el rollup crudo: pasa por
// `resolveNetDepositInput` (hr/net-deposit-input.ts), el registro único de la
// política «automático manda, manual cargado es override, período cerrado o
// anterior a agosto-26 queda congelado». Por eso cada número lleva su rótulo
// —CRM / manual / cerrado / sin datos—: sin él, un override y un automático se
// ven idénticos y nadie sabría cuál de los dos está mirando.
//
// La columna **Comisión del mes** dejó de ser `commissions_earned` guardado (lo
// que alguien tecleó y grabó alguna vez) y pasó a ser lo que el MOTOR calcula
// con ese insumo, por el mismo camino que el tab Individual de /comisiones
// (hr/commission-preview.ts). El total multi-período guardado sigue estando: es
// la tabla «Resultados por período» de más abajo, que no cambió.
//
// El motor corre en el CLIENTE y no en el overview a propósito: es puro, ya
// estaba en el bundle, y la cadena que necesita (el `accumulated_out` del mes
// anterior) sale de `monthlyResults`, que el cliente ya tiene. Calcularlo en el
// servidor obligaba a duplicar ahí la orquestación de /comisiones — dos copias
// de la misma plata, que es el modo de falla número uno del repo.
//
// Los totales de las columnas de dinero salen de src/lib/hr/monthly-totals.ts,
// que es el mismo camino que usa el CSV — antes eran cinco `reduce` inline en la
// tabla y otros cinco en el export.
//
// ── «Libro mayor» (2026-10-12) — sólo presentación ─────────────────────────
// · Cada equipo es un Panel (cabecera = el líder con su Net CRM y su total;
//   acciones a la derecha, colapsar incluido) y sus miembros, una FinTable al
//   ras: nombre con la JERARQUÍA como metadato («HEAD Hugo › BDM Ana» — antes
//   el Master IB sólo se distinguía por una sangría), rol, estado con
//   StatusBadge, Net CRM del mes con su rótulo de procedencia, comisión del
//   motor y acciones de fila. En < 720 px cada miembro es una tarjeta.
// · Filtros: buscador + Segmented de estado (todos / activos / inactivos, con
//   conteos) + Chip «sin salario». El de estado es nuevo: con 126 perfiles y
//   los despedidos mezclados, la pregunta «¿quién está trabajando?» no tenía
//   respuesta en esta pestaña. Los filtros ahora recortan también las FILAS
//   de cada equipo (antes «sin salario» elegía equipos pero mostraba a todos
//   sus miembros, con salario o sin él), y el pie del panel cuenta el recorte
//   («Mostrando 3 de 8 miembros»): reglas §1.2.
// · El rol dejó de tener color (antes violeta/ámbar/azul por rol, y GLOBAL /
//   Master IB en `bg-purple-100` / `bg-amber-100` crudos): un rol no es un
//   estado (spec §2.1). Los dos marcadores quedan como StatusBadge neutro.
// · El Net CRM del líder se pintaba verde/rojo por signo y el de los miembros
//   no: mismo dato, dos criterios. Ahora los dos `tone="sign"` (el signo del
//   net ES la noticia: plata que entró o se fue).
// · «Resultados por período» en FinTable con el pie de total (doble raya).
// Medición (sin comentarios): antes 24 clases de paleta cruda, 4 `dark:` de
// color, 6 `text-[10px]` y 66 tokens legados; después 0 / 0 / 0 / 0.
// DESCARTADO: una sola FinTable agrupada por líder (`groupBy`) — FinTable no
// colapsa grupos, y colapsar equipos es un pedido existente (collapseAll).
// ─────────────────────────────────────────────────────────────────────────────

export function CommercialTab({
  onToast,
}: {
  onToast: (t: { type: 'success' | 'error'; msg: string }) => void;
}) {
  const { t } = useI18n();
  const { company, commercialProfiles: profiles, monthlyResults, periods } = useData();
  const { periodIds, overview } = useHrPeriod();

  const [showProfileForm, setShowProfileForm] = useState(false);
  const [editingProfile, setEditingProfile] = useState<CommercialProfile | undefined>();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [commercialSearch, setCommercialSearch] = useState('');
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set());
  // Filtro «sin salario»: checklist para que RRHH cargue los que faltan (Kevin
  // 2026-08-28: el salario es opcional, pero las metas por net deposit muestran
  // vacío sin él; ~103/126 perfiles no lo tenían).
  const [soloSinSalario, setSoloSinSalario] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ProfileStatusFilter>('all');

  const totales = useMemo(
    () => totalesPorPerfil(monthlyResults as unknown as MonthlyResultRow[], periodIds),
    [monthlyResults, periodIds],
  );
  const totalGeneral = useMemo(() => totalesGenerales(totales), [totales]);

  /** Net del CRM del mes del selector, por perfil. `null` = no lo sabemos. */
  const crmNet = useMemo(() => {
    const tree = overview?.data.net?.tree;
    if (!tree) return null;
    // CORRECCIÓN (dueño, 2026-09-06): acá se aplicaba
    // descontarSubredesDeMasters y era la semántica equivocada — el BDM cobra
    // su % sobre el TOTAL de su línea, master incluido, y esta pantalla tiene
    // que mostrar el mismo insumo que /comisiones (§2.1). La discriminación
    // del master es su PROPIA fila (es root del árbol), no una resta al padre.
    return indexarNetDelCrm(tree);
  }, [overview]);

  /**
   * EL INSUMO RESUELTO del mes del selector, por perfil — el MISMO resolver que
   * usa /comisiones (hr/net-deposit-input.ts). Acá el alcance es siempre
   * `structure`: la pregunta de esta pantalla es «cuánto produjo la estructura
   * de esta persona», que es lo que muestran la tarjeta del equipo y la columna
   * Net CRM. La producción propia del líder (la línea de ajuste) se sigue viendo
   * en la pestaña Net Deposit, que dibuja el árbol entero.
   */
  const insumo = useMemo((): Map<string, ResolvedNetDeposit> => {
    const out = new Map<string, ResolvedNetDeposit>();
    const period = overview?.period ?? null;
    const rows = overview?.data.monthlyResults ?? null;
    const manual = rows ? manualDeEstructura(rows) : null;
    // Sin período contable no hay manual posible; el mes se trata como abierto y
    // posterior al corte sólo si el mes del selector lo es.
    const [y, m] = (overview?.month ?? '').split('-');
    const periodoLike = period ?? (y && m ? { year: Number(y), month: Number(m), is_closed: false } : null);
    if (!periodoLike) return out;
    for (const p of profiles) {
      out.set(
        p.id,
        resolveNetDepositInput({
          profileId: p.id,
          period: periodoLike,
          scope: 'structure',
          crm: p.pnl_pct != null ? null : crmNet,
          manual: manual ? manual.get(p.id) ?? null : null,
        }),
      );
    }
    return out;
  }, [overview, profiles, crmNet]);

  /**
   * La comisión del mes que sale del MOTOR con ese insumo — no lo tecleado.
   *
   * El acumulado de entrada es el `accumulated_out` del período anterior, que es
   * de donde lo saca /comisiones: la cadena es secuencial y el acumulado se
   * arrastra (§2.2). Sin período contable no hay cadena y no se muestra número.
   */
  const comisiones = useMemo((): Map<string, ComisionDelMes> => {
    const out = new Map<string, ComisionDelMes>();
    const period = overview?.period ?? null;
    if (!period) return out;
    const prev = getPreviousPeriod(periods, period.id);
    const prevRows = prev ? monthlyResults.filter((r) => r.period_id === prev.id) : [];
    // El % manual del mes (migración 129), cargado desde /comisiones. Se lee
    // acá por el mismo motivo que el insumo: esta pantalla muestra lo que se le
    // va a pagar a la persona, y si ignorara el override mostraría un número
    // distinto del que /comisiones va a guardar. Se saltea la fila del líder en
    // su propio grupo (head_id === profile_id), igual que `manualDeEstructura`.
    const overridePorPerfil = new Map<string, number>();
    for (const r of monthlyResults) {
      if (r.period_id !== period.id) continue;
      if (r.head_id && r.head_id === r.profile_id) continue;
      if (r.pct_override === null || r.pct_override === undefined) continue;
      const n = Number(r.pct_override);
      if (Number.isFinite(n)) overridePorPerfil.set(r.profile_id, n);
    }
    for (const p of profiles) {
      const resolved = insumo.get(p.id);
      if (!resolved) continue;
      const c = comisionIndividualDeBdm({
        profile: p,
        resolved,
        pctOverride: overridePorPerfil.get(p.id) ?? null,
        accumulatedIn: getAccumulatedIn(prevRows, p.id, p.head_id ?? undefined),
        periodYear: period.year,
        periodMonth: period.month,
      });
      if (c) out.set(p.id, c);
    }
    return out;
  }, [overview, periods, monthlyResults, profiles, insumo]);

  const toggleTeamCollapsed = (leaderId: string) => {
    setCollapsedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(leaderId)) next.delete(leaderId); else next.add(leaderId);
      return next;
    });
  };

  const commercialQ = commercialSearch.trim().toLowerCase();
  const matchesCommercial = (p: CommercialProfile, q: string) =>
    !q ||
    p.name.toLowerCase().includes(q) ||
    p.email.toLowerCase().includes(q) ||
    hrRoleLabel(p.role).toLowerCase().includes(q);
  const pasaFiltroSalario = (p: CommercialProfile) => !soloSinSalario || sinSalario(p);
  const pasaFiltros = (p: CommercialProfile) => pasaFiltroSalario(p) && matchesStatusFilter(p, statusFilter);
  const totalSinSalario = profiles.filter(sinSalario).length;
  const statusCounts = useMemo(() => {
    const counts: Record<ProfileStatusFilter, number> = { all: 0, active: 0, inactive: 0 };
    for (const p of profiles) {
      for (const f of PROFILE_STATUS_FILTERS) if (matchesStatusFilter(p, f)) counts[f] += 1;
    }
    return counts;
  }, [profiles]);

  const byId = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  // Registro único: quién lidera y quién es BDM lo decide hr/domain.ts.
  const lideres = profiles.filter((p) => esLider(p.role));
  const salesManagers = profiles.filter((p) => p.role === 'sales_manager');
  const heads = profiles.filter((p) => p.role === 'head');
  const independentBdms = profiles.filter((p) => esBdm(p.role) && !p.head_id);

  /**
   * Los Master IB de un miembro (migración 129). Cuelgan de un BDM — no de un
   * líder — así que sin esto no caían en NINGUNA tarjeta y desaparecían de la
   * pantalla (dueño, 2026-09-06: buscó a millonariosteam2018 para editarlo y
   * "no sale"). Se listan dentro de la tarjeta donde está su BDM, a
   * continuación de él. Un nivel alcanza: un master no puede colgar de otro
   * master por el formulario, y si algún día pasa, el de abajo vuelve a caer
   * acá al buscarse por su propio BDM.
   */
  const mastersDe = (bdmId: string) =>
    profiles.filter((m) => m.is_master_ib && m.head_id === bdmId);
  const conSusMasters = (miembros: CommercialProfile[]) =>
    miembros.flatMap((b) => [b, ...mastersDe(b.id)]);

  // Un equipo se muestra si matchea el líder O algún BDM bajo su estructura
  // (masters de esos BDM incluidos).
  const teamHasMatch = (leader: CommercialProfile) =>
    (matchesCommercial(leader, commercialQ) && pasaFiltros(leader)) ||
    conSusMasters(profiles.filter((p) => p.head_id === leader.id))
      .some((p) => matchesCommercial(p, commercialQ) && pasaFiltros(p));
  const visibleSalesManagers = salesManagers.filter(teamHasMatch);
  const visibleHeads = heads.filter(teamHasMatch);
  // También acá van los masters: un Master IB colgado de un BDM SIN head no
  // cae en ninguna tarjeta de líder, así que se lista a continuación de su BDM.
  const visibleIndependentBdms = conSusMasters(independentBdms).filter(
    (b) => matchesCommercial(b, commercialQ) && pasaFiltros(b),
  );
  const filtering = Boolean(commercialQ) || soloSinSalario || statusFilter !== 'all';

  const handleDeleteProfile = async (id: string) => {
    try {
      await deleteCommercialProfile(id);
      setDeletingId(null);
      window.location.reload();
    } catch (err) {
      setDeletingId(null);
      onToast({ type: 'error', msg: err instanceof Error ? err.message : t('hr.deleteError') });
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // EL % POR LÍNEA, editable en la fila (migración 130, dueño 2026-09-06)
  //
  // Va acá y no sólo en el formulario porque es lo que el dueño pidió con su
  // captura: la fila de cada miembro, al lado de su «Net Dep %». El número
  // significa «lo que cobra EL DE ARRIBA por la línea de esta persona», no el
  // % de ella — por eso está en su fila DENTRO de la tarjeta de su líder, que
  // es donde se lee la relación.
  //
  // VACÍO NO ES CERO (§1.3): el input vacío guarda `null` = diferencial
  // natural de siempre; un `0` tecleado guarda `0` y significa que el de
  // arriba no cobra nada por esa línea. Lo tecleado queda en un mapa local y
  // manda sobre el perfil: `useData()` no se refresca solo tras el PATCH, así
  // que limpiarlo mostraría el valor viejo como si el guardado no hubiera
  // pasado. Si el guardado FALLA se revierte a lo del perfil: un input que
  // muestra lo que no se guardó es exactamente el fallo mudo del §1.2.
  //
  // Escribir lo sigue decidiendo el rol (§4.1): el endpoint de perfiles ya
  // exige HR_ROLES + módulo `hr`, el mismo que habilita el lápiz de esta fila.
  // ───────────────────────────────────────────────────────────────────────────
  const [pctLineaRaw, setPctLineaRaw] = useState<Map<string, string>>(new Map());
  const [savingPctLinea, setSavingPctLinea] = useState<string | null>(null);

  const pctLineaDisplay = (p: CommercialProfile): string => {
    const raw = pctLineaRaw.get(p.id);
    if (raw !== undefined) return raw;
    return p.pct_linea === null || p.pct_linea === undefined ? '' : String(p.pct_linea);
  };

  const guardarPctLinea = async (p: CommercialProfile) => {
    const raw = pctLineaRaw.get(p.id);
    if (raw === undefined) return; // no lo tocaron
    const txt = raw.trim();
    const valor = txt === '' || txt === '-' ? null : Number(txt);
    if (valor !== null && !Number.isFinite(valor)) {
      // Basura tecleada: no se guarda nada y el campo vuelve a lo real.
      setPctLineaRaw((prev) => { const n = new Map(prev); n.delete(p.id); return n; });
      return;
    }
    const actual = p.pct_linea ?? null;
    if (valor === actual) return; // sin cambios: ni PATCH ni toast
    setSavingPctLinea(p.id);
    try {
      await updateCommercialProfile(p.id, { pct_linea: valor });
      onToast({
        type: 'success',
        msg: t('hr.pctLineaSaved', { name: p.name, pct: valor === null ? t('hr.pctLineaAuto') : `${valor}%` }),
      });
    } catch (err) {
      setPctLineaRaw((prev) => { const n = new Map(prev); n.delete(p.id); return n; });
      onToast({ type: 'error', msg: err instanceof Error ? err.message : t('hr.saveError') });
    } finally {
      setSavingPctLinea(null);
    }
  };

  /** La celda editable del % por línea. */
  const pctLineaCell = (p: CommercialProfile) => {
    const value = pctLineaDisplay(p);
    const cargado = value.trim() !== '' && value.trim() !== '-';
    return (
      <span className="inline-flex items-center gap-1">
        <input
          type="number"
          step="0.01"
          aria-label={t('hr.pctLineaAria', { name: p.name })}
          title={t('hr.pctLineaHint')}
          placeholder={t('hr.pctLineaPlaceholder')}
          value={value}
          disabled={savingPctLinea === p.id}
          onChange={(e) => {
            const v = e.target.value;
            setPctLineaRaw((prev) => { const n = new Map(prev); n.set(p.id, v); return n; });
          }}
          onBlur={() => { void guardarPctLinea(p); }}
          // Enter también guarda (dueño, 2026-09-06: "¿cómo lo guardo?"). El
          // blur ya lo hacía, pero Enter es lo que la mano teclea primero: se
          // dispara el blur y el guardado sale por el mismo único camino.
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className={cn(
            'h-8 w-16 rounded-ui-md border bg-card px-1.5 text-right text-[13px] tabular-nums placeholder:text-text-3 disabled:opacity-60 [@media(pointer:coarse)]:h-10',
            // Un % cargado es una excepción a la regla de siempre: se marca
            // (info: «esto no es el automático»), no se alarma. Antes
            // `border-warning text-warning`, color de «pendiente» sin pendiente.
            cargado ? 'border-info font-semibold text-info' : 'border-control-border text-foreground',
          )}
        />
        <span className="text-[12px] text-text-3">%</span>
      </span>
    );
  };

  /** La comisión del mes según el motor. «—» si el perfil no cobra por net deposit. */
  const comisionCell = (profileId: string) => {
    const c = comisiones.get(profileId);
    if (!c) return <Money value={null} nullLabel={t('ui.noData')} />;
    if (c.nd === null) return <NetWithSource value={null} source={c.source} />;
    return (
      <NetWithSource
        value={c.commission}
        source={c.source}
        title={t('hr.commissionBreakdown', {
          net: moneyText(c.nd),
          division: moneyText(c.division),
          acc: moneyText(c.accumulatedIn),
          pct: String(c.commissionPct),
        })}
      />
    );
  };

  const openEdit = (p: CommercialProfile) => {
    setEditingProfile(p);
    setShowProfileForm(true);
  };

  /** Editar + borrar (con confirmación en línea) + ver perfil. */
  const rowActions = (p: CommercialProfile, canDelete = true) =>
    deletingId === p.id ? (
      <span className="inline-flex items-center gap-1">
        <ActionButton variant="danger" onClick={() => handleDeleteProfile(p.id)}>
          {t('common.delete')}
        </ActionButton>
        <ActionButton variant="ghost" onClick={() => setDeletingId(null)}>
          {t('common.no')}
        </ActionButton>
      </span>
    ) : (
      <>
        <button
          type="button"
          onClick={() => openEdit(p)}
          className={ROW_ACTION_CLASS}
          aria-label={t('common.edit')}
          title={t('common.edit')}
        >
          <Pencil aria-hidden className="size-[15px]" strokeWidth={1.75} />
        </button>
        {canDelete && (
          <button
            type="button"
            onClick={() => setDeletingId(p.id)}
            className={ROW_DANGER_CLASS}
            aria-label={t('common.delete')}
            title={t('common.delete')}
          >
            <Trash2 aria-hidden className="size-[15px]" strokeWidth={1.75} />
          </button>
        )}
        <Link
          href={`/rrhh/perfil?id=${p.id}`}
          className={ROW_ACTION_CLASS}
          aria-label={t('hr.viewProfile')}
          title={t('hr.viewProfile')}
        >
          <UserRound aria-hidden className="size-[15px]" strokeWidth={1.75} />
        </Link>
      </>
    );

  /** Nombre + marcadores (GLOBAL, Master IB, despedido). Sin color: no son estados. */
  const nameCell = (p: CommercialProfile) => (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Link href={`/rrhh/perfil?id=${p.id}`} className={cn('truncate hover:underline', firedNameClass(p))}>
        {p.name}
      </Link>
      {esBdmGlobal(p.role) && <StatusBadge kind="neutral" label="GLOBAL" />}
      {p.is_master_ib && <StatusBadge kind="neutral" label={t('hr.masterIb')} />}
      <FiredBadge profile={p} />
    </span>
  );

  /** La jerarquía como metadato: «HEAD Hugo › BDM Ana» (o el email, si no cuelga de nadie). */
  const hierarchyMeta = (p: CommercialProfile) => {
    const chain = supervisorChain(p, byId);
    if (chain.length === 0) return p.email;
    return chain.map((s) => `${hrRoleLabel(s.role)} ${s.name}`).join(' › ');
  };

  const statusCell = (p: CommercialProfile) => {
    const v = profileStatusView(p);
    return <StatusBadge kind={v.kind} label={t(v.labelKey)} />;
  };

  const positiveOrNull = (v: number) => (v > 0 ? v : null);

  /** Columnas de una tabla de miembros. `withPnlPct` para los BDM independientes. */
  const memberColumns = (withPnlPct: boolean): FinColumn<CommercialProfile>[] => [
    {
      key: 'name',
      header: t('common.name'),
      cell: nameCell,
      meta: hierarchyMeta,
      mobileMeta: statusCell,
    },
    {
      key: 'role',
      header: t('hr.role'),
      cell: (p) => <span className="text-text-2">{hrRoleLabel(p.role)}</span>,
      hideSm: true,
    },
    { key: 'status', header: t('hr.status'), cell: statusCell, hideSm: true },
    {
      key: 'netCrm',
      header: t('hr.netCrmCol'),
      align: 'right',
      cardSide: 'right',
      cell: (p) => {
        const r = insumo.get(p.id);
        return <NetWithSource value={r?.value ?? null} source={r?.source ?? 'none'} tone="sign" />;
      },
    },
    {
      key: 'ndPct',
      header: t('hr.netDepPct'),
      align: 'right',
      hideSm: true,
      cell: (p) => <span className="tabular-nums">{pctText(p.net_deposit_pct) ?? '—'}</span>,
    },
    // El % que cobra el LÍDER por esta línea (migración 130). Al lado del Net
    // Dep % porque es la comparación que el dueño hace al mirar la tarjeta.
    {
      key: 'pctLinea',
      header: <span title={t('hr.pctLineaHint')}>{t('hr.pctLineaCol')}</span>,
      align: 'right',
      hideSm: true,
      cell: pctLineaCell,
    },
    ...(withPnlPct
      ? [
          {
            key: 'pnlPct',
            header: t('hr.pnlPct'),
            align: 'right' as const,
            hideSm: true,
            cell: (p: CommercialProfile) => <span className="tabular-nums">{pctText(p.pnl_pct) ?? '—'}</span>,
          },
        ]
      : []),
    {
      key: 'salary',
      header: t('hr.salaryCol'),
      kind: 'money',
      hideSm: true,
      value: (p) => (p.fixed_salary && p.salary != null ? p.salary : null),
      subtotal: false,
    },
    {
      key: 'pnl',
      header: t('hr.pnl'),
      kind: 'money',
      hideSm: true,
      // Igual que antes: un PnL de 0 se muestra como raya, no como $0.00.
      value: (p) => positiveOrNull(totalesDe(totales, p.id).pnl),
      subtotal: false,
    },
    {
      key: 'commission',
      header: t('hr.commissionsMonth'),
      align: 'right',
      cardSide: 'right',
      cell: (p) => comisionCell(p.id),
    },
    {
      key: 'bonus',
      header: t('hr.bonus'),
      kind: 'money',
      hideSm: true,
      value: (p) => positiveOrNull(totalesDe(totales, p.id).bonus),
      subtotal: false,
    },
    {
      key: 'total',
      header: t('hr.total'),
      kind: 'money',
      hideSm: true,
      value: (p) => totalesDe(totales, p.id).total,
      subtotal: false,
    },
  ];

  const renderTeamCard = (leader: CommercialProfile) => {
    // Miembros directos + los Master IB colgados de ellos (ver mastersDe).
    const allBdms = conSusMasters(profiles.filter((p) => p.head_id === leader.id));
    const leaderMatchesQ = matchesCommercial(leader, commercialQ);
    // Al buscar: si el líder NO matchea, sólo los miembros que matchean. Los
    // filtros de estado y salario recortan siempre (ver cabecera).
    const bdms = allBdms.filter(
      (b) => pasaFiltros(b) && (!commercialQ || leaderMatchesQ || matchesCommercial(b, commercialQ)),
    );
    // Colapsar se ignora mientras hay búsqueda activa (siempre expandido).
    const isCollapsed = !commercialQ && collapsedTeams.has(leader.id);
    const leaderTotal = totalesDe(totales, leader.id).total;
    const r = insumo.get(leader.id);
    const shownNote =
      !isCollapsed && bdms.length < allBdms.length
        ? t('hrv.membersShowing', { shown: String(bdms.length), total: String(allBdms.length) })
        : undefined;

    return (
      <Panel
        key={leader.id}
        flush
        title={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => toggleTeamCollapsed(leader.id)}
              className={TOGGLE_CLASS}
              aria-label={isCollapsed ? t('hr.expandTeam') : t('hr.collapseTeam')}
              aria-expanded={!isCollapsed}
              title={isCollapsed ? t('hr.expandTeam') : t('hr.collapseTeam')}
            >
              {isCollapsed ? <ChevronRight aria-hidden className="size-4" /> : <ChevronDown aria-hidden className="size-4" />}
            </button>
            <Link href={`/rrhh/perfil?id=${leader.id}`} className={cn('hover:underline', firedNameClass(leader))}>
              {leader.name}
            </Link>
            <FiredBadge profile={leader} />
          </span>
        }
        hint={
          <>
            {hrRoleLabel(leader.role)}
            {' · '}
            {t('hrv.membersCount', { n: String(allBdms.length) })}
            {' · '}
            {t('hr.netDepPct')} {pctText(leader.net_deposit_pct) ?? '—'}
          </>
        }
        actions={
          <>
            <span className="inline-flex flex-col items-end text-[12px] leading-4 text-text-3">
              <span>{t('hr.netCrmMonth')}</span>
              <NetWithSource value={r?.value ?? null} source={r?.source ?? 'none'} tone="sign" />
            </span>
            <span className="inline-flex flex-col items-end text-[12px] leading-4 text-text-3">
              <span>{t('hr.total')}</span>
              <Money value={leaderTotal} className="text-[13px] font-semibold text-foreground" />
            </span>
            <span className="inline-flex items-center">{rowActions(leader)}</span>
          </>
        }
        footer={shownNote}
      >
        {!isCollapsed && bdms.length > 0 && (
          <FinTable
            columns={memberColumns(false)}
            rows={bdms}
            rowKey={(b) => b.id}
            caption={t('hrv.teamOf', { name: leader.name })}
            rowActions={(b) => rowActions(b)}
          />
        )}
        {!isCollapsed && bdms.length === 0 && (
          <p className="px-4 py-3 text-[13px] text-text-3">{t('hrv.noMembers')}</p>
        )}
      </Panel>
    );
  };

  const statusLabels: Record<ProfileStatusFilter, string> = {
    all: t('hrv.filterAll'),
    active: t('hrv.filterActive'),
    inactive: t('hrv.filterInactive'),
  };

  // ─── Resultados por período (todos los perfiles) ───
  // Mismo criterio que antes: se listan los que movieron algo en el período
  // (ganaron o trajeron net deposit).
  const resultRows = profiles
    .filter((p) => {
      const tot = totales.get(p.id);
      return !!tot && (tot.total > 0 || tot.netDepositCurrent > 0);
    })
    .sort((a, b) => totalesDe(totales, b.id).total - totalesDe(totales, a.id).total);

  const resultColumns: FinColumn<CommercialProfile>[] = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (p) => (
        <Link href={`/rrhh/perfil?id=${p.id}`} className="hover:underline">
          {p.name}
        </Link>
      ),
      meta: (p) => hrRoleLabel(p.role),
    },
    { key: 'nd', header: t('hr.netDeposit'), kind: 'money', value: (p) => totalesDe(totales, p.id).netDepositTotal },
    {
      key: 'pnl',
      header: t('hr.pnl'),
      kind: 'money',
      hideSm: true,
      value: (p) => positiveOrNull(totalesDe(totales, p.id).pnl),
    },
    {
      key: 'commissions',
      header: t('hr.commissions'),
      kind: 'money',
      hideSm: true,
      value: (p) => totalesDe(totales, p.id).commissions,
    },
    {
      key: 'bonus',
      header: t('hr.bonus'),
      kind: 'money',
      hideSm: true,
      value: (p) => positiveOrNull(totalesDe(totales, p.id).bonus),
    },
    {
      key: 'salary',
      header: t('hr.salaryCol'),
      kind: 'money',
      hideSm: true,
      value: (p) => positiveOrNull(totalesDe(totales, p.id).salary),
    },
    { key: 'total', header: t('hr.total'), kind: 'money', value: (p) => totalesDe(totales, p.id).total },
  ];

  return (
    <div className="space-y-4">
      {showProfileForm && (
        <ProfileForm
          editing={editingProfile}
          onClose={() => { setEditingProfile(undefined); setShowProfileForm(false); }}
          companyId={company?.id || ''}
        />
      )}

      {/* Filtros (por encargado HEAD/SM o por BDM) + colapsar/expandir todo.
          El selector de período NO vive acá: es uno solo del módulo y está
          arriba de las pestañas (ver rrhh/page.tsx). */}
      <Panel
        title={t('hr.commercialForce')}
        hint={t('hrv.profilesCount', { n: String(profiles.length) })}
        actions={
          <ActionButton variant="primary" onClick={() => { setEditingProfile(undefined); setShowProfileForm(true); }}>
            <Plus aria-hidden className="size-[15px]" strokeWidth={1.75} /> {t('hr.addProfile')}
          </ActionButton>
        }
        footer={
          filtering ? (
            <>
              {t('hr.showingTeams', { teams: String(visibleSalesManagers.length + visibleHeads.length) })}
              {visibleIndependentBdms.length > 0 ? t('hr.showingBdms', { count: String(visibleIndependentBdms.length) }) : ''}
              {commercialQ ? t('hr.forQuery', { query: commercialSearch }) : '.'}
            </>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            value={commercialSearch}
            onChange={setCommercialSearch}
            placeholder={t('hr.searchCommercialPlaceholder')}
            className="max-w-[320px] flex-1"
          />
          <Segmented
            options={PROFILE_STATUS_FILTERS.map((f) => ({ value: f, label: statusLabels[f], count: statusCounts[f] }))}
            value={statusFilter}
            onChange={setStatusFilter}
            aria-label={t('hr.status')}
          />
          <Chip active={soloSinSalario} onClick={() => setSoloSinSalario((v) => !v)}>
            {t('hr.noSalaryFilter', { count: String(totalSinSalario) })}
          </Chip>
          {!commercialQ && (
            <span className="inline-flex items-center gap-1 sm:ml-auto">
              <ActionButton variant="ghost" onClick={() => setCollapsedTeams(new Set(lideres.map((l) => l.id)))}>
                {t('hr.collapseAll')}
              </ActionButton>
              <ActionButton variant="ghost" onClick={() => setCollapsedTeams(new Set())}>
                {t('hr.expandAll')}
              </ActionButton>
            </span>
          )}
        </div>
      </Panel>

      {/* Sales Managers */}
      {visibleSalesManagers.map((sm) => renderTeamCard(sm))}

      {/* HEADs */}
      {visibleHeads.map((head) => renderTeamCard(head))}

      {/* Sin resultados */}
      {filtering &&
        visibleSalesManagers.length === 0 &&
        visibleHeads.length === 0 &&
        visibleIndependentBdms.length === 0 && (
          <Panel>
            <p className="py-6 text-center text-[13px] text-text-3">
              {commercialQ ? t('hr.noResultsFor', { query: commercialSearch }) : t('ui.table.empty')}
            </p>
          </Panel>
        )}

      {/* Independent BDMs */}
      {visibleIndependentBdms.length > 0 && (
        <Panel
          title={t('hr.independentBdms')}
          hint={t('hrv.membersCount', { n: String(visibleIndependentBdms.length) })}
          flush
        >
          {/* Los Master IB de un BDM sin líder caen en esta tabla: su línea
              también la cobra alguien (su BDM), así que el % por línea tiene
              que estar acá también. Sin botón de borrar, igual que antes. */}
          <FinTable
            columns={memberColumns(true)}
            rows={visibleIndependentBdms}
            rowKey={(b) => b.id}
            caption={t('hr.independentBdms')}
            rowActions={(b) => rowActions(b, false)}
          />
        </Panel>
      )}

      {/* ─── Resultados por período (todos los perfiles) ─── */}
      <Panel title={t('hr.resultsByPeriod')} hint={t('hrv.periodsInScope', { n: String(periodIds.length) })} flush>
        <FinTable
          columns={resultColumns}
          rows={resultRows}
          rowKey={(p) => p.id}
          caption={t('hr.resultsByPeriod')}
          footer={{
            label: t('hr.total'),
            // Sobre TODOS los perfiles (totalesGenerales), el mismo camino que
            // el CSV — no la suma de las filas visibles.
            values: {
              nd: totalGeneral.netDepositTotal,
              pnl: positiveOrNull(totalGeneral.pnl),
              commissions: totalGeneral.commissions,
              bonus: positiveOrNull(totalGeneral.bonus),
              salary: positiveOrNull(totalGeneral.salary),
              total: totalGeneral.total,
            },
          }}
        />
      </Panel>
    </div>
  );
}
