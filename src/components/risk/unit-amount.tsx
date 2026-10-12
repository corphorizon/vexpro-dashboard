import { NUM_CLASS, moneyToneClass, type MoneyTone } from '@/components/ui/money';
import { cn, formatNumber } from '@/lib/utils';
import { unitSuffix, type Mt5Unit } from './risk-format';

// ─────────────────────────────────────────────────────────────────────────────
// UnitAmount — un importe de MT5 SIEMPRE con su unidad («¢» / «USD»).
//
// POR QUÉ (2026-10-12): /risk/exposicion tenía un `Money` local con el mismo
// nombre que la primitiva de ui/ y otras reglas: pintaba verde TODO positivo
// (equity, margen — columnas donde todos son positivos y el color no dice
// nada, spec §2.1) y usaba `text-positive/negative` legados. Acá:
//   · cifra con `.num` (tabular, slashed-zero, nowrap) y el sufijo de unidad
//     en `text-3` — en centavos y en dólares un número se ve igual y no lo es;
//   · color con la MISMA regla que <Money> (`moneyToneClass`): 'auto' sólo
//     pinta negativos, 'sign' los dos signos (P&L, flotante);
//   · null → «—», nunca 0.
//
// DESCARTADO: usar <Money> de ui/ — pone «$» (dólares) delante de un número
// que puede estar en centavos. Ver risk-format.ts.
// ─────────────────────────────────────────────────────────────────────────────

export function UnitAmount({
  value,
  unit,
  tone = 'auto',
  className,
}: {
  value: number | null | undefined;
  unit: Mt5Unit;
  tone?: MoneyTone;
  className?: string;
}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return <span className={cn(NUM_CLASS, 'text-text-3', className)}>—</span>;
  }
  return (
    <span className={cn(NUM_CLASS, className)}>
      <span className={moneyToneClass(value, tone)}>{formatNumber(value)}</span>
      <span className="ml-1 text-[12px] font-normal text-text-3">{unitSuffix(unit)}</span>
    </span>
  );
}
