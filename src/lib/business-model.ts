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

export const BUSINESS_MODELS = ['broker', 'company'] as const;
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
  /** P&L del broker y ventas de prop firm como fuente de ingresos. */
  brokerPnl: boolean;
  /** Pantalla de Movimientos: depósitos y retiros por período y canal. */
  movements: boolean;
  /** Cuentas de liquidez (MT) y su conciliación. */
  liquidity: boolean;
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
}

export const BUSINESS_MODEL_FEATURES: Record<BusinessModel, BusinessModelFeatures> = {
  broker: {
    deposits: true,
    withdrawals: true,
    netDeposit: true,
    brokerPnl: true,
    movements: true,
    liquidity: true,
    investments: true,
    // Un broker también puede facturar servicios sueltos; no molesta y da
    // el mismo detalle que ya tienen los egresos.
    incomeLines: true,
    riskManagement: true,
    commercialTeam: true,
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
    investments: false,
    incomeLines: true,
    riskManagement: false,
    commercialTeam: false,
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
  if (!f.investments) blocked.push('investments');
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

/** Sección inicial: la primera que el modelo admite. */
export function defaultUploadSection(model: unknown): string {
  return uploadSections(model)[0];
}

/**
 * Secciones del reporte por email que el modelo NO admite. El reporte las
 * omite aunque la configuración de la empresa las tenga encendidas: mandar
 * "Depósitos y retiros" en cero todos los días es peor que no mandarlo.
 */
export function blockedReportSections(model: unknown): string[] {
  const f = features(model);
  const blocked: string[] = [];
  if (!f.movements) blocked.push('deposits_withdrawals');
  if (!f.brokerPnl) blocked.push('broker_pnl', 'prop_trading');
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
