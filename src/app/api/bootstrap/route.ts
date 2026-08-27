import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { MODULE_KEYS, type ModuleKey } from '@/lib/modules';
import { BUILT_IN_ROLES } from '@/lib/roles';
import {
  CRITICAL_SLICES,
  slicesVedados,
  type BootstrapSliceKey,
} from '@/lib/bootstrap-slices';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/bootstrap — los 20 slices del arranque en UNA respuesta.
//
// ── El porqué, con la medición ─────────────────────────────────────────────
// Kevin, agosto 2026: los usuarios veían "La carga tardó demasiado" al entrar.
// El servidor estaba SANO — Postgres ~0ms de trabajo, RLS +0,8%, cero 5xx,
// payload de 128 KB gzip. El costo estaba entero en el cliente: el boot eran
// 20 consultas navegador→PostgREST = **40 round-trips** (19 preflight OPTIONS
// de CORS + 20 GET). Con el RTT medido desde LatAm/Dubái (250-350 ms) eso son
// 10-14 segundos de puro viaje, antes de que la DB haga nada. Y encima el lock
// de auth de supabase-js las SERIALIZA: medido 1.092 ms con lock contra 480 ms
// sin él, 2,3×.
//
// Esta ruta convierte esos 40 round-trips en 1. Mismo payload, mismas formas.
//
// ── SEGURIDAD: por qué este archivo tiene un gate por slice ────────────────
// En el navegador el filtro lo hacía RLS, que además de la empresa aplica la
// migración 064: a quien no es admin/hr le VACÍA employees, commercial_profiles
// y commercial_monthly_results (verificado: un usuario `soporte` los recibe
// vacíos). Acá se usa el admin client y **el service role no pasa por RLS**.
// Sin reproducir ese gate, esta ruta le mandaría sueldos, motivos de despido y
// contratos a cualquiera con sesión.
//
// La decisión vive en src/lib/bootstrap-slices.ts y usa el registro canónico
// de módulos (src/lib/modules.ts) + HR_ROLES (src/lib/roles.ts). No hay una
// segunda lista acá: sería exactamente el modo de falla número uno del repo.
//
// El resto de las reglas multi-tenant, sin excepción (§4.2):
//   · `company_id` sale del token (o del ?company_id= del superadmin, que
//     `verifyAdminAuth` valida). Jamás de un parámetro libre.
//   · Con el admin client, `.eq('company_id', …)` es OBLIGATORIO en CADA
//     slice. No hay una sola consulta acá sin ese filtro.
//
// ── Nada de recortes silenciosos (§1.2) ────────────────────────────────────
// · Un slice que falla vuelve como `null` (≠ `[]`) y su nombre aparece en
//   `partial`. "No lo sabemos" y "no hay filas" son datos distintos.
// · Un slice vedado por permisos vuelve `[]` —que es la respuesta correcta,
//   la misma que da RLS hoy— pero su nombre aparece en `gated`.
// · Si falla `company` o `periods` (sin ellos no se pinta nada) la respuesta
//   entera es un error y el cliente cae al camino de las 20 consultas.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Cota defensiva idéntica a la de src/lib/supabase/queries.ts (PERF-02). */
const ROW_CAP = 10_000;

type SliceResult = { rows: unknown[] | null; failed: boolean };

export async function GET(request: NextRequest) {
  try {
    // Gate de la RUTA. `modules` se deriva del registro canónico (no es una
    // segunda lista): el arranque alimenta TODAS las pantallas, así que pasa
    // quien tenga al menos un módulo — semántica OR de canAccessAnyModule.
    // Un usuario con cero módulos recibe 403 y el cliente cae al camino de
    // fallback, que es exactamente lo que hace hoy.
    const auth = await verifyAdminAuth(request, {
      roles: BUILT_IN_ROLES,
      modules: MODULE_KEYS as ModuleKey[],
    });
    if (auth instanceof NextResponse) return auth;

    const companyId = auth.companyId;
    const admin = createAdminClient();

    // La empresa se lee primero: además de ser un slice, trae
    // `active_modules` y `business_model`, que el gate por slice necesita.
    const { data: company, error: companyError } = await admin
      .from('companies')
      .select('*')
      .eq('id', companyId)
      .maybeSingle();

    if (companyError) {
      return apiError('bootstrap:company', companyError, { status: 502 });
    }
    if (!company) {
      return NextResponse.json(
        { success: false, error: 'No se encontró la empresa' },
        { status: 404 },
      );
    }

    const gated = slicesVedados({
      role: auth.role,
      isSuperadmin: !!auth.isSuperadmin,
      allowedModules: auth.allowedModules ?? null,
      activeModules: Array.isArray(company.active_modules) ? company.active_modules : null,
      businessModel: company.business_model,
    });
    const estaVedado = (slice: BootstrapSliceKey) => gated.includes(slice);

    // Cada slice repite EXACTAMENTE las columnas, el orden y las cotas que
    // pide hoy su `fetchX` en src/lib/supabase/queries.ts, para que
    // data-context no tenga que cambiar ni un tipo.
    const consulta = (
      slice: BootstrapSliceKey,
      build: () => PromiseLike<{ data: unknown[] | null; error: unknown }>,
    ): Promise<[BootstrapSliceKey, SliceResult]> => {
      if (estaVedado(slice)) return Promise.resolve([slice, { rows: [], failed: false }]);
      return Promise.resolve(build()).then(
        ({ data, error }) => {
          if (error) {
            console.error(`[bootstrap] slice "${slice}" falló:`, error);
            return [slice, { rows: null, failed: true }] as [BootstrapSliceKey, SliceResult];
          }
          return [slice, { rows: data ?? [], failed: false }] as [BootstrapSliceKey, SliceResult];
        },
        (err) => {
          console.error(`[bootstrap] slice "${slice}" lanzó:`, err);
          return [slice, { rows: null, failed: true }] as [BootstrapSliceKey, SliceResult];
        },
      );
    };

    const t = (table: string) => admin.from(table).select('*').eq('company_id', companyId);

    const resultados = await Promise.all([
      consulta('periods', () =>
        t('periods').order('year', { ascending: true }).order('month', { ascending: true })),
      consulta('employees', () => t('employees').order('name', { ascending: true })),
      consulta('commercialProfiles', () =>
        t('commercial_profiles').order('name', { ascending: true })),
      consulta('monthlyResults', () => t('commercial_monthly_results').limit(ROW_CAP)),
      consulta('deposits', () => t('deposits').limit(ROW_CAP)),
      consulta('withdrawals', () => t('withdrawals').limit(ROW_CAP)),
      consulta('expenses', () =>
        t('expenses').order('sort_order', { ascending: true }).limit(ROW_CAP)),
      consulta('expenseTemplates', () =>
        t('expense_templates').order('sort_order', { ascending: true })),
      consulta('expenseTemplateHidden', () =>
        admin
          .from('expense_template_period_hidden')
          .select('id, company_id, template_id, period_id')
          .eq('company_id', companyId)),
      consulta('preoperativeExpenses', () =>
        t('preoperative_expenses').order('sort_order', { ascending: true })),
      consulta('operatingIncome', () => t('operating_income').limit(ROW_CAP)),
      consulta('brokerBalance', () => t('broker_balance').limit(ROW_CAP)),
      consulta('financialStatus', () => t('financial_status').limit(ROW_CAP)),
      consulta('partners', () => t('partners')),
      consulta('partnerDistributions', () => t('partner_distributions').limit(ROW_CAP)),
      consulta('propFirmSales', () => t('prop_firm_sales').limit(ROW_CAP)),
      consulta('p2pTransfers', () => t('p2p_transfers').limit(ROW_CAP)),
      consulta('liquidityMovements', () =>
        t('liquidity_movements').order('date', { ascending: true }).limit(ROW_CAP)),
      consulta('investments', () =>
        t('investments').order('date', { ascending: true }).limit(ROW_CAP)),
    ]);

    const porSlice = new Map<BootstrapSliceKey, SliceResult>(resultados);
    const partial = resultados.filter(([, r]) => r.failed).map(([slice]) => slice);

    // `periods` es crítico: sin él no hay dashboard. Que la respuesta salga
    // "exitosa" pero sin períodos sería justamente el fallo que no da error.
    const criticoRoto = partial.filter((s) =>
      (CRITICAL_SLICES as readonly string[]).includes(s),
    );
    if (criticoRoto.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'No se pudieron cargar los datos base de la empresa',
          partial: criticoRoto,
        },
        { status: 502 },
      );
    }

    const rows = (slice: BootstrapSliceKey): unknown[] | null => porSlice.get(slice)?.rows ?? null;

    // Post-procesos que hoy hacen las fetchX y que la UI da por hechos.
    const expenses = rows('expenses');
    const expensesNormalizados =
      expenses === null
        ? null
        : expenses.map((e) => ({
            ...(e as Record<string, unknown>),
            // Default defensivo idéntico a fetchExpenses: filas viejas sin la
            // columna no deben llegar como `undefined` a la UI.
            is_fixed: !!(e as { is_fixed?: unknown }).is_fixed,
          }));

    return NextResponse.json({
      success: true,
      companyId,
      /** Slices que no se pudieron leer. Vienen como `null`, nunca como `[]`. */
      partial,
      /** Slices que este usuario no tiene permitido ver. Vienen como `[]`. */
      gated,
      data: {
        company,
        periods: rows('periods'),
        employees: rows('employees'),
        commercialProfiles: rows('commercialProfiles'),
        monthlyResults: rows('monthlyResults'),
        deposits: rows('deposits'),
        withdrawals: rows('withdrawals'),
        expenses: expensesNormalizados,
        expenseTemplates: rows('expenseTemplates'),
        expenseTemplateHidden: rows('expenseTemplateHidden'),
        preoperativeExpenses: rows('preoperativeExpenses'),
        operatingIncome: rows('operatingIncome'),
        brokerBalance: rows('brokerBalance'),
        financialStatus: rows('financialStatus'),
        partners: rows('partners'),
        partnerDistributions: rows('partnerDistributions'),
        propFirmSales: rows('propFirmSales'),
        p2pTransfers: rows('p2pTransfers'),
        liquidityMovements: rows('liquidityMovements'),
        investments: rows('investments'),
      },
    });
  } catch (err) {
    return apiError('bootstrap', err, { status: 500 });
  }
}

// Ojo si alguien quiere sumar slices: las wallets fijadas (pinned_coinsbuy_
// wallets) y los channel_balances NO están acá a propósito — no son del
// arranque, y las wallets además necesitan `normalizePinnedWalletRole` antes
// de llegar a la UI. Agregarlas sin eso reintroduce el bug de la migración 084.
