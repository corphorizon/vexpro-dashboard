// ─────────────────────────────────────────────────────────────────────────────
// Glosario — single source of truth for conceptual definitions surfaced via
// <InfoTip /> across the finance modules. Keeping them here lets us tweak
// wording once and have it propagate everywhere.
//
// Keys are plain camelCase (not i18n keys) because these strings are
// intentionally Spanish-only — they're explanations written for the
// accounting team and partners. When EN needs to be added, add parallel
// keys (e.g. `propFirmEn`).
// ─────────────────────────────────────────────────────────────────────────────

export const GLOSSARY = {
  netDeposit:
    'Depósito Neto = Depósitos Totales − Retiros Totales del período. Representa el flujo neto de capital.',

  propFirm:
    'Prop Firm: programa donde el trader opera con capital de la firma. "Ventas Prop Firm" son los ingresos por cuentas vendidas; "Retiros Prop Firm" son pagos a traders que ganaron.',

  libroB:
    'Libro B: modelo en el que el broker actúa como contraparte del trader (no envía las órdenes al mercado). El P&L Libro B es la ganancia/pérdida que genera este esquema.',

  netoOperativo:
    'Neto Operativo = Ingresos Operativos − Egresos Operativos del mes. Número que usa /socios para decidir cuánto se distribuye.',

  reserve:
    'Reserva: porcentaje del saldo disponible que se guarda cada período como respaldo financiero (default 10%). Se acumula mes a mes y queda disponible para cubrir meses negativos.',

  montoDistribuir:
    'Monto a Distribuir = Saldo disponible del mes × (1 − % Reserva). Es lo que se reparte entre los socios según su porcentaje.',

  deudaArrastrada:
    'Deuda Arrastrada: cuando un mes termina negativo y no alcanza la reserva acumulada para cubrirlo, el faltante se arrastra al siguiente período y se descuenta antes de distribuir.',

  // CORRECCIÓN 2026-08-31 (auditoría de finanzas): la etiqueta «(API)» del
  // número era engañosa y esta definición la repetía. «Depósitos Totales (API)»
  // NO es solo lo que reportan las integraciones: `computeDerivedNetDeposit`
  // suma también TODO lo cargado a mano en /upload, canal por canal, vía
  // `manualDepositsByChannel` de deposit-channels.ts. Quien leía «(API)»
  // buscaba la diferencia contra la carga manual y no la encontraba, porque ya
  // estaba adentro.
  brokerDeposits:
    'Restante (Broker) = Depósitos Totales − Ventas Prop Firm. Es lo que queda atribuido al broker después de descontar la parte de Prop Firm. Ojo con la etiqueta «(API)» del indicador: ese total incluye lo reportado por las integraciones Y lo cargado a mano en Carga de Datos, no solo lo primero.',

  consolidatedMode:
    'Modo Consolidado: estás viendo los totales sumados de varios meses. Algunas ediciones (egresos, socios) se desactivan en este modo para evitar ambigüedad sobre a qué período aplicar el cambio.',

  // ENGANCHADA (2026-08-31, auditoría de finanzas, ítem 20). Estaba definida y
  // sin usar: una explicación correcta que no leía nadie. La tanda anterior la
  // dejó marcada con las dos salidas posibles —engancharla o borrarla— y se
  // elige la primera, porque lo que dice es justo lo que la tabla de Depósitos
  // de /movimientos NO explica: cada fila es «API + manual», los dos suman y el
  // manual nunca se pisa. Va en el encabezado de la columna Canal, que es donde
  // aparece el rótulo «api» que la motiva.
  apiManualCoexist:
    'Los canales con integración suman dos fuentes: lo reportado por la API y lo cargado manualmente en Carga de Datos. Ambos conviven — el manual nunca se sobrescribe.',
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
