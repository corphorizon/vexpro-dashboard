'use client';

// Entrada por el panel de plataforma. La vista vive en
// `components/liquidity/liquidity-pool-view.tsx` — acá sólo se elige que haya
// un "Volver" al listado de entidades.

import { LiquidityPoolView } from '@/components/liquidity/liquidity-pool-view';

export default function SuperadminLiquidityPage() {
  return <LiquidityPoolView backHref="/superadmin" />;
}
