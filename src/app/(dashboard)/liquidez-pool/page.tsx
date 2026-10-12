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
import { useAuth } from '@/lib/auth-context';

export default function LiquidezPoolPage() {
  // Dentro del tenant, el pool es informativo para los miembros de la empresa
  // proveedora (2026-10-12): las mutaciones son de superadmin y el server las
  // rechaza, así que la vista ni las ofrece. El superadmin "viendo como"
  // conserva sus botones.
  const { user } = useAuth();
  return <LiquidityPoolView readOnly={!user?.is_superadmin} />;
}
