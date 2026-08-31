import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ALL_WITHDRAWAL_CATEGORIES,
  INFORMATIONAL_WITHDRAWAL_CATEGORIES,
  isInformationalWithdrawal,
  withdrawalCategoryLabel,
} from './withdrawal-categories';
import { WITHDRAWAL_LABELS } from './types';

// El diccionario real, recortado a lo que importa acá. Se copia a propósito en
// vez de importar i18n.tsx (un .tsx con contexto de React): lo que se está
// probando es que la CLAVE que arma `withdrawalCategoryLabel` exista en los dos
// idiomas, y para eso alcanza con el par clave→texto.
const EN: Record<string, string> = {
  'movements.categoryLabel.ib_commissions': 'IB commissions',
  'movements.categoryLabel.broker': 'Broker',
  'movements.categoryLabel.prop_firm': 'Prop Firm',
  'movements.categoryLabel.other': 'Other',
};
const ES: Record<string, string> = {
  'movements.categoryLabel.ib_commissions': 'Comisiones IB',
  'movements.categoryLabel.broker': 'Broker',
  'movements.categoryLabel.prop_firm': 'Prop Firm',
  'movements.categoryLabel.other': 'Otros',
};
/** `t` de i18n.tsx: si la clave no está, devuelve la clave. */
const tOf = (dict: Record<string, string>) => (key: string) => dict[key] ?? key;

describe('registro de categorías de retiro', () => {
  it('son las cuatro del CHECK de la tabla, en orden de pantalla', () => {
    expect(ALL_WITHDRAWAL_CATEGORIES).toEqual([
      'ib_commissions',
      'broker',
      'prop_firm',
      'other',
    ]);
  });

  it('sólo `broker` suma a Retiros Totales', () => {
    // Decisión de Kevin del 2026-06-06: el manual de Broker es el suplemento
    // Coinsbuy que la API no alcanzó a reportar y SÍ suma; las otras tres son
    // informativas porque los retiros reales ya están en el total de la API.
    expect(isInformationalWithdrawal('broker')).toBe(false);
    for (const c of INFORMATIONAL_WITHDRAWAL_CATEGORIES) {
      expect(isInformationalWithdrawal(c), c).toBe(true);
    }
    expect(INFORMATIONAL_WITHDRAWAL_CATEGORIES).toHaveLength(
      ALL_WITHDRAWAL_CATEGORIES.length - 1,
    );
  });
});

describe('withdrawalCategoryLabel — la tarjeta de Retiros ya se traduce', () => {
  it('cada categoría tiene texto en inglés Y en castellano', () => {
    // El bug: `WITHDRAWAL_LABELS` era castellano fijo, así que un usuario en
    // inglés veía la columna Depósitos traducida y justo al lado «Comisiones IB
    // / Broker / Prop Firm / Otros» en castellano. El CSV, igual.
    for (const cat of ALL_WITHDRAWAL_CATEGORIES) {
      const en = withdrawalCategoryLabel(cat, tOf(EN));
      const es = withdrawalCategoryLabel(cat, tOf(ES));
      expect(en, cat).toBeTruthy();
      expect(es, cat).toBeTruthy();
      // Ninguna puede quedar mostrando la clave cruda.
      expect(en).not.toContain('movements.categoryLabel');
      expect(es).not.toContain('movements.categoryLabel');
    }
    expect(withdrawalCategoryLabel('ib_commissions', tOf(EN))).toBe('IB commissions');
    expect(withdrawalCategoryLabel('ib_commissions', tOf(ES))).toBe('Comisiones IB');
  });

  it('sin la clave i18n cae al castellano viejo, nunca a la clave cruda', () => {
    const tVacio = (k: string) => k;
    for (const cat of ALL_WITHDRAWAL_CATEGORIES) {
      expect(withdrawalCategoryLabel(cat, tVacio)).toBe(WITHDRAWAL_LABELS[cat]);
    }
  });

  it('las claves EXISTEN en i18n.tsx, en los dos idiomas', () => {
    // El test de arriba prueba la función contra un diccionario de mentira; éste
    // prueba que el diccionario de verdad las tenga. Sin él, olvidarse de una
    // clave se ve como «la fila salió en castellano» y nadie lo mira: el
    // fallback no rompe (regla §7: la clave nueva va en `en` Y en `es`).
    const dict = readFileSync(path.resolve(__dirname, './i18n.tsx'), 'utf8');
    for (const cat of ALL_WITHDRAWAL_CATEGORIES) {
      const key = `'movements.categoryLabel.${cat}'`;
      const veces = dict.split(key).length - 1;
      expect(veces, `${key} tiene que estar en 'en' y en 'es'`).toBe(2);
    }
  });

  it('una categoría desconocida vuelve tal cual, no rompe', () => {
    expect(withdrawalCategoryLabel('lo_que_sea', (k) => k)).toBe('lo_que_sea');
  });

  it('el castellano del registro coincide con WITHDRAWAL_LABELS', () => {
    // Si divergieran, el mismo retiro se llamaría de dos formas según pasara
    // por i18n o por el fallback — que es la divergencia que este registro vino
    // a cerrar.
    for (const cat of ALL_WITHDRAWAL_CATEGORIES) {
      expect(withdrawalCategoryLabel(cat, tOf(ES)), cat).toBe(WITHDRAWAL_LABELS[cat]);
    }
  });
});
