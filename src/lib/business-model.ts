// ─────────────────────────────────────────────────────────────────────────────
// Modelo de negocio de una empresa — registro ÚNICO.
//
// No todas las empresas del dashboard son brokers. Horizon es una consultora:
// no tiene depósitos de clientes, ni retiros, ni Net Deposit. Mostrarle esas
// pantallas vacías no es solo ruido — invita a cargar datos donde no
// corresponde y ensucia la cadena de distribución.
//
// La lista vive acá y la importan la carga de datos, el resumen, el menú y el
// panel de superadmin. Es el mismo criterio que modules.ts y roles.ts: si cada
// pantalla decidiera por su cuenta qué esconder, se desincronizarían — el modo
// de falla número uno de este repo.
//
// Import-safe desde cliente y servidor: no toca Supabase ni React.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReportSectionKey } from './reports/sections';

// El identificador es `liquidity_provider` y no `liquidity_pool` A PROPÓSITO:
// `liquidity_pool` ya es la clave de un MÓDULO (modules.ts) y de una pantalla
// (/liquidez-pool). Usar la misma cadena para un modelo de negocio y para un
// módulo es exactamente cómo nacen las listas que se desincronizan: dos cosas
// distintas con el mismo nombre terminan comparándose entre sí sin que el
// compilador diga nada. El modelo describe A LA EMPRESA (administra un pool);
// el módulo describe LA PANTALLA.
export const BUSINESS_MODELS = ['broker', 'company', 'liquidity_provider'] as const;
export type BusinessModel = (typeof BUSINESS_MODELS)[number];

/** Default histórico: todo lo que existía antes de esta distinción es broker. */
export const DEFAULT_BUSINESS_MODEL: BusinessModel = 'broker';

export function isBusinessModel(v: unknown): v is BusinessModel {
  return typeof v === 'string' && (BUSINESS_MODELS as readonly string[]).includes(v);
}

export function normalizeBusinessModel(v: unknown): BusinessModel {
  return isBusinessModel(v) ? v : DEFAULT_BUSINESS_MODEL;
}

export const BUSINESS_MODEL_LABELS: Record<BusinessModel, { es: string; en: string }> = {
  broker: { es: 'Broker', en: 'Broker' },
  company: { es: 'Empresa', en: 'Company' },
  liquidity_provider: { es: 'Proveedor de Liquidez', en: 'Liquidity Provider' },
};

export const BUSINESS_MODEL_DESCRIPTIONS: Record<BusinessModel, { es: string; en: string }> = {
  broker: {
    es: 'Opera cuentas de clientes: depósitos, retiros y P&L del broker.',
    en: 'Runs client accounts: deposits, withdrawals and broker P&L.',
  },
  company: {
    es: 'Factura servicios: ingresos por concepto y egresos, sin depósitos ni retiros.',
    en: 'Bills for services: income by concept and expenses, no deposits or withdrawals.',
  },
  liquidity_provider: {
    es: 'Administra un pool de liquidez sobre cuentas MT5: aporte al pool, inversiones y egresos. Sin depósitos, retiros ni P&L de broker.',
    en: 'Runs a liquidity pool over MT5 accounts: pool contribution, investments and expenses. No deposits, withdrawals or broker P&L.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Qué aplica a cada modelo
//
// Un `false` acá no es cosmético: apaga la pestaña de carga Y las tarjetas del
// resumen que se alimentan de esos datos.
// ─────────────────────────────────────────────────────────────────────────────

export interface BusinessModelFeatures {
  /** Depósitos de clientes por canal de pago. */
  deposits: boolean;
  /** Retiros (incluye el desglose por categoría y las transferencias P2P). */
  withdrawals: boolean;
  /** Net Deposit = depósitos − retiros. Sin depósitos no significa nada. */
  netDeposit: boolean;
  /**
   * P&L del broker y ventas de prop firm como fuente de ingresos.
   *
   * En false NO es solo cosmético: `buildDistributionInputs` mete brokerPnl y
   * propFirmNetIncome en CERO en la cadena de distribución. Si no, una entidad
   * que pasó de 'broker' a 'company' seguía repartiendo plata que ninguna
   * pantalla muestra (las esconde blockedConsolidatedColumns).
   */
  brokerPnl: boolean;
  /** Pantalla de Movimientos: depósitos y retiros por período y canal. */
  movements: boolean;
  /**
   * Cuentas de liquidez (MT) y su conciliación — la pantalla /liquidez que usa
   * Vex Pro, con sus propias tablas. NO es el pool: ver `liquidityPool`.
   */
  liquidity: boolean;
  /**
   * Pool de liquidez sobre cuentas MT5 (/liquidez-pool): cuánto hay que
   * reservar, distinguiendo «Balance MT5» de «Equity a Liquidez».
   *
   * Es un módulo distinto de `liquidity` y conviven (ver el comentario de
   * `liquidity_pool` en modules.ts). Hasta el 2026-09-01 ningún modelo lo
   * nombraba: vivía sólo del `onlyWhereActivated` del módulo. Ahora el modelo
   * lo decide, como todo lo demás.
   */
  liquidityPool: boolean;
  /** Inversiones activas y su rendimiento. */
  investments: boolean;
  /** Detalle de ingresos por concepto y cliente (facturación). */
  incomeLines: boolean;
  /** Gestión de riesgo: revisión de retiros, cuentas MT, wallets externas. */
  riskManagement: boolean;
  /**
   * Equipo comercial de RRHH: perfiles de BDM/HEAD, comisiones, rebates de IB
   * y onboarding. Con esto en false, Recursos Humanos queda solo con la
   * ficha de empleados — que es lo que una empresa de servicios necesita.
   */
  commercialTeam: boolean;
  /**
   * Los egresos entran a la cadena de distribución por base CAJA (`paid`) en
   * vez de DEVENGADO (`amount`).
   *
   * Vivía como `businessModel === 'company'` escrito a mano en dos archivos
   * (distribution-inputs.ts y period-close-checklist.ts). Con un tercer modelo
   * eso ya no es una pregunta binaria, y una comparación suelta contra un
   * literal es justo lo que este registro existe para evitar.
   *
   * Sigue siendo true SÓLO en 'company', y por la misma medición de siempre:
   * AP Markets (broker) tiene ~$24.900 de egresos con `paid = 0` porque ese
   * equipo no usa el campo "pagado". Aplicar caja donde no se carga `paid`
   * lleva los egresos a cero e INFLA la base distribuible.
   */
  cashBasisExpenses: boolean;
  /**
   * La empresa LLEVA CONTABILIDAD de período. Un solo interruptor porque es
   * una sola pregunta: si la respuesta es no, no hay nada que cargar, nada que
   * cerrar, nada que repartir y nada que reportar. Apaga, juntos:
   *   · `expenses` (Egresos) y `balances` (Balances)
   *   · `partners` (Socios) y `payment_orders` (Órdenes de Pago)
   *   · `upload` (Carga de Datos) — y por lo tanto `uploadSections` queda VACÍO
   *   · `periods` (Períodos) y `reports` (Reportes, incluido el mail diario)
   *
   * Van juntos A PROPÓSITO y no como siete flags: separarlos invitaría a
   * dejar, por ejemplo, «Balances» prendido en una empresa que no carga un
   * solo número — una pantalla en cero que se lee como un dato. Cuando exista
   * un modelo que quiera uno sí y otro no, ahí se parte el flag, con la
   * medición que lo justifique.
   */
  accounting: boolean;
}

export const BUSINESS_MODEL_FEATURES: Record<BusinessModel, BusinessModelFeatures> = {
  broker: {
    deposits: true,
    withdrawals: true,
    netDeposit: true,
    brokerPnl: true,
    movements: true,
    liquidity: true,
    // El pool es de quien lo administra, no de quien opera cuentas. Ver la
    // nota de orden de despliegue en la migración 122.
    liquidityPool: false,
    investments: true,
    // ── Corregido (Kevin, 2026-08-26): un broker NO factura por concepto ────
    // Antes esto estaba en true con el argumento de que "no molesta". Sí
    // molesta: Ingresos y Clientes son la contabilidad de una empresa de
    // servicios, y en un broker aparecen siempre vacíos invitando a cargar
    // datos donde no corresponde.
    //
    // Medido antes de apagarlo: los cuatro brokers tienen CERO líneas de
    // ingreso entre todos; las 70 que existen son de Horizon, que es
    // `company`. Apagarlo no esconde ningún dato real.
    incomeLines: false,
    riskManagement: true,
    commercialTeam: true,
    cashBasisExpenses: false,
    accounting: true,
  },
  company: {
    deposits: false,
    withdrawals: false,
    netDeposit: false,
    brokerPnl: false,
    // Movimientos son depósitos y retiros de clientes; liquidez son cuentas
    // MT del broker; inversiones es rendimiento de trading. Una consultora
    // no tiene nada de eso — la plata que sí tiene se ve en Balances, con
    // su ubicación (wallet, banco, prestada).
    movements: false,
    liquidity: false,
    liquidityPool: false,
    investments: false,
    incomeLines: true,
    riskManagement: false,
    commercialTeam: false,
    cashBasisExpenses: true,
    accounting: true,
  },
  // ── Proveedor de liquidez (Kevin, 2026-09-01) ──────────────────────────
  // «este sería otro tipo de organización, que solo tendría esa lógica nada
  // más» + «dale, dejale también el módulo inversiones» + la corrección de
  // alcance del mismo día: «realmente este es más informativo, por eso solo
  // necesito lo del pool y lo de inversiones».
  //
  // Es una empresa INFORMATIVA: administra un pool de liquidez sobre cuentas
  // MT5 y mira el rendimiento de sus inversiones. NO lleva contabilidad, no
  // carga datos, no cierra períodos, no reparte a socios y no manda reportes.
  //
  // Lo único que queda encendido, entonces, son `liquidityPool` e
  // `investments`. Los módulos que no dependen de ninguna feature —`summary`,
  // `users`, `logs`— siguen accesibles y son los que hacen que la app se
  // pueda usar: `summary` NO se puede apagar porque es el destino al que el
  // dispatcher manda a todo usuario no-admin con acceso al grupo Finanzas
  // (module-groups.ts: `homeHref: '/resumen-general'`), y apagarlo lo dejaría
  // aterrizando en un 403.
  //
  // NO PARTICIPA DE LA CADENA DE DISTRIBUCIÓN: sin `partners` ni
  // `payment_orders` no hay pantalla que la muestre. La cadena se sigue
  // calculando en el data-context (es global) y no explota sin socios ni
  // períodos —devuelve una lista vacía—, pero su resultado no se exhibe en
  // ningún lado. Ver el test de buildDistributionInputs.
  liquidity_provider: {
    deposits: false,
    withdrawals: false,
    netDeposit: false,
    brokerPnl: false,
    movements: false,
    // `liquidity` (la conciliación de Vex Pro) en FALSE a propósito: es otra
    // pantalla y otras tablas. Confundirla con el pool es el error que el
    // comentario de `liquidity_pool` en modules.ts ya advierte.
    liquidity: false,
    liquidityPool: true,
    investments: true,
    incomeLines: false,
    riskManagement: false,
    commercialTeam: false,
    // Sin contabilidad no hay base caja que elegir. Queda en false por la
    // misma razón que en broker: nadie midió que este equipo cargue `paid`.
    cashBasisExpenses: false,
    accounting: false,
  },
};

/**
 * Módulos que el modelo NO admite. El menú y el guard de rutas los tratan
 * como no habilitados aunque figuren en `active_modules`: es más seguro que
 * confiar en que nadie los tilde por error en el alta de la empresa.
 */
export function blockedModules(model: unknown): string[] {
  const f = features(model);
  const blocked: string[] = [];
  if (!f.riskManagement) blocked.push('risk');
  if (!f.commercialTeam) blocked.push('commissions', 'ib_rebates');
  if (!f.movements) blocked.push('movements');
  if (!f.liquidity) blocked.push('liquidity');
  // El pool se BLOQUEA donde el modelo no lo tiene, aunque el módulo ya sea
  // `onlyWhereActivated`. Las dos capas dicen cosas distintas: aquélla dice
  // «esta pantalla vive en una sola empresa», ésta dice «este negocio no
  // administra un pool». Consecuencia de ORDEN DE DESPLIEGUE: la migración 122
  // tiene que estar aplicada antes de que este código llegue a producción, o
  // Exura Liquidez —que hoy figura como 'broker'— pierde /liquidez-pool hasta
  // que se aplique. Ese orden ya era obligatorio igual: sin el CHECK ampliado,
  // guardar el modelo nuevo lo rechaza Postgres.
  if (!f.liquidityPool) blocked.push('liquidity_pool');
  if (!f.investments) blocked.push('investments');
  // Ingresos por concepto y la cartera de clientes a los que se factura: son
  // la misma contabilidad y se encienden o apagan juntos.
  if (!f.incomeLines) blocked.push('income', 'clients');
  // Sin contabilidad de período no queda nada que cargar, cerrar, repartir ni
  // reportar. Ver `accounting` arriba para por qué es un solo interruptor.
  if (!f.accounting) {
    blocked.push('expenses', 'balances', 'partners', 'payment_orders', 'upload', 'periods', 'reports');
  }
  return blocked;
}

export function moduleAllowedForModel(model: unknown, moduleKey: string): boolean {
  return !blockedModules(model).includes(moduleKey);
}

export function features(model: unknown): BusinessModelFeatures {
  return BUSINESS_MODEL_FEATURES[normalizeBusinessModel(model)];
}

/**
 * Pestañas de la carga de datos que corresponden al modelo, EN ORDEN.
 * Las claves son las mismas `DataSection` que usa /upload.
 */
export function uploadSections(model: unknown): string[] {
  const f = features(model);
  // Sin contabilidad no hay nada que cargar: lista VACÍA, y el módulo `upload`
  // además está bloqueado. Se devuelve vacío en vez de "una pestaña por las
  // dudas" porque una pestaña de carga en una empresa que no carga datos es
  // una invitación a cargarlos donde no corresponde.
  if (!f.accounting) return [];
  // El ORDEN de las pestañas de un broker no se toca: moverlas cambiaría la
  // pantalla que su equipo usa todos los días. Para 'company' arranca por
  // Ingresos, que es de donde nace su contabilidad.
  if (f.deposits || f.withdrawals) {
    const sections: string[] = [];
    if (f.deposits) sections.push('depositos');
    if (f.withdrawals) sections.push('retiros');
    sections.push('egresos', 'ingresos', 'liquidez', 'inversiones');
    return sections;
  }
  const sections = ['ingresos', 'egresos'];
  if (f.liquidity) sections.push('liquidez');
  if (f.investments) sections.push('inversiones');
  return sections;
}

/**
 * Sección inicial: la primera que el modelo admite, o `null` si el modelo no
 * carga datos. `null` explícito y no `undefined` disfrazado de `string`: el
 * llamador tiene que decidir qué hacer con "no hay ninguna", y con la firma
 * vieja (`: string`) devolvía `undefined` sin que el compilador dijera nada.
 */
export function defaultUploadSection(model: unknown): string | null {
  return uploadSections(model)[0] ?? null;
}

/**
 * Secciones del reporte por email que el modelo NO admite. El reporte las
 * omite aunque la configuración de la empresa las tenga encendidas: mandar
 * "Depósitos y retiros" en cero todos los días es peor que no mandarlo.
 */
export function blockedReportSections(model: unknown): ReportSectionKey[] {
  const f = features(model);
  // Tipado contra el registro único (src/lib/reports/sections.ts) desde el
  // 2026-08-31: acá se empujaban CADENAS SUELTAS a una lista de secciones, y
  // `loadReportConfig` las aplicaba con `if (key in sections)` — o sea, un
  // typo acá («broker_pnl_» y no «broker_pnl») no apagaba nada y no fallaba en
  // ningún lado. Ahora un nombre que no existe no compila.
  const blocked: ReportSectionKey[] = [];
  if (!f.movements) blocked.push('deposits_withdrawals');
  // Las tres secciones del CRM del broker salen de la MISMA fuente (Orion
  // CRM): P&L, prop trading y los usuarios de la plataforma de trading.
  // `crm_users` cuenta las altas de clientes del broker — una consultora no
  // tiene esa plataforma, así que su reporte diario venía con "Usuarios CRM:
  // 0 / 0 / 0" (o peor, sin conectar) como una de sus dos únicas secciones.
  if (!f.brokerPnl) blocked.push('broker_pnl', 'prop_trading', 'crm_users');
  // Sin contabilidad tampoco hay balances por canal — y con las cinco
  // bloqueadas el reporte no tiene NADA que contar. Por eso el módulo
  // `reports` también está bloqueado y `sendReports` mira el modelo antes de
  // mandar: un mail con cero secciones es el reporte diario en $0 que Exura
  // Liquidez venía recibiendo.
  if (!f.accounting) blocked.push('balances_by_channel');
  return blocked;
}

/**
 * Columnas del consolidado que el modelo no admite. Se filtran ANTES de las
 * que el usuario ocultó a mano: una columna que su negocio no tiene no debería
 * ni aparecer en el selector.
 */
export function blockedConsolidatedColumns(model: unknown): string[] {
  const f = features(model);
  const blocked: string[] = [];
  if (!f.deposits) blocked.push('totalDeposits');
  if (!f.withdrawals) blocked.push('totalWithdrawals', 'p2p');
  if (!f.netDeposit) blocked.push('netDeposit');
  if (!f.brokerPnl) blocked.push('brokerPnl', 'propFirmNet', 'propFirmSales');
  if (!f.investments) blocked.push('investmentProfits');
  return blocked;
}
