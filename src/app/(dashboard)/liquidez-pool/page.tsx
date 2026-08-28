'use client';

// Entrada por el módulo `liquidity_pool` dentro de la empresa administradora.
//
// Sin "Volver": acá la navegación es el sidebar. La misma vista que
// `/superadmin/liquidity`, para que no existan dos pantallas del pool que se
// desincronicen.
//
// ── NO CONFUNDIR CON `/liquidez` ───────────────────────────────────────────
// `/liquidez` (módulo `liquidity`) es la conciliación de liquidez que usa Vex
// Pro, con sus propias tablas y su propia lógica. Es otra cosa. Este módulo
// lee cuentas MT5 y calcula el aporte al pool.

import { LiquidityPoolView } from '@/components/liquidity/liquidity-pool-view';

export default function LiquidezPoolPage() {
  return <LiquidityPoolView />;
}
