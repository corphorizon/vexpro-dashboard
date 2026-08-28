import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// La consulta del PnL mensual no se puede ejercitar sin MT5, así que lo que se
// fija acá es su FORMA. Suena pobre, pero el bug que estos tests bloquean fue
// exactamente un filtro de más en el lugar equivocado, y eso sí se ve en el SQL.
//
// El caso real: la comisión se cobra en la apertura Y en el cierre. Con
// `Entry IN (1,3)` aplicado a los importes se perdía la mitad — la cuenta
// 137983 daba -11.411,61 en marzo contra los -11.547,91 del MT5 Manager.
// ─────────────────────────────────────────────────────────────────────────────

const fuente = readFileSync(
  join(process.cwd(), 'src/lib/liquidity/monthly-pnl-calculator.ts'),
  'utf8',
);

// Sólo el bloque de la consulta, para no confundir el SQL con los comentarios
// de la cabecera —que mencionan `Entry IN (1,3)` justamente para explicarlo.
const sql = fuente.slice(
  fuente.indexOf('const SQL_POR_MES'),
  fuente.indexOf('].join', fuente.indexOf('const SQL_POR_MES')),
);

describe('SQL del PnL mensual', () => {
  it('NO restringe los importes a los deals de salida', () => {
    // Si alguien vuelve a poner `AND Entry IN (1,3)` en el WHERE, la comisión
    // de las aperturas desaparece y el total queda corto sin dar ningún error.
    expect(sql).not.toMatch(/AND\s+Entry\s+IN\s*\(1,\s*3\)/);
  });

  it('cuenta las operaciones sólo por las salidas', () => {
    // Cada operación deja un deal de entrada y otro de salida: contar todas las
    // filas daría el doble.
    expect(sql).toMatch(/CASE\s+WHEN\s+Entry\s+IN\s*\(1,\s*3\)\s+THEN\s+1/);
  });

  it('suma profit, swap y comisión', () => {
    expect(sql).toMatch(/SUM\(Profit\)/);
    expect(sql).toMatch(/SUM\(Storage\)/);
    expect(sql).toMatch(/SUM\(Commission\)/);
  });

  it('excluye los depósitos y retiros', () => {
    // Sin esto, `Action = 2` entra como si fuera ganancia. Medido en el repo:
    // suman 425 millones.
    expect(sql).toMatch(/Action\s+IN\s*\(0,\s*1\)/);
  });

  it('filtra por TimeMsc y no por Timestamp ni Time', () => {
    // `Timestamp` es FILETIME —comparado contra un epoch devuelve la tabla
    // entera— y `Time` no tiene índice.
    expect(sql).toMatch(/TimeMsc\s*>=\s*\?/);
    expect(sql).toMatch(/TimeMsc\s*<\s*\?/);
    expect(sql).not.toMatch(/\bTimestamp\b/);
  });
});
