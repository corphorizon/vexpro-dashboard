// ---------------------------------------------------------------------------
// GET /api/admin/payment-orders/line-suggestions?beneficiary_id=…&name=…
//
// Devuelve los CONCEPTOS que ya se le facturaron antes a un beneficiario, para
// ofrecerlos al escribir una línea nueva. Pedido de Kevin: "que en descripción
// pueda elegir los que le haya puesto a ese usuario antes".
//
// Por qué acá y no en el cliente: las líneas viven en la columna jsonb `lines`
// de payment_orders. Traerse las órdenes enteras al navegador para juntar sus
// descripciones sería mandar montos, wallets y datos de otras órdenes que la
// pantalla no necesita.
//
// El match acepta id O nombre porque la mayoría de las órdenes viejas nacieron
// antes de la libreta y tienen beneficiary_id en null — sin el nombre, un
// beneficiario histórico no sugeriría nada. El nombre se compara
// case-insensitive, igual que el upsert de la libreta.
//
// Se devuelve también el último valor unitario de cada concepto: el formulario
// lo usa para prellenar el importe cuando el usuario elige la sugerencia y el
// campo está vacío. Es el mismo criterio que la libreta con el medio de pago —
// lo último que se usó es el mejor default.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

/** Órdenes recientes que se miran. Más allá el concepto ya no es "el que usa". */
const ORDERS_SCANNED = 60;
/** Sugerencias devueltas. Un datalist más largo que esto no se lee. */
const MAX_SUGGESTIONS = 15;

/**
 * El id se interpola en un `.or()` de PostgREST — una coma o un paréntesis ahí
 * adentro agrega condiciones al filtro. Se valida la forma antes de usarlo.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LineSuggestion {
  description: string;
  /** Último valor unitario usado con ese concepto, o null si no era un número. */
  lastUnitValue: number | null;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['payment_orders'] });
    if (auth instanceof NextResponse) return auth;

    const beneficiaryId = request.nextUrl.searchParams.get('beneficiary_id')?.trim() || null;
    const name = request.nextUrl.searchParams.get('name')?.trim() || null;
    if (beneficiaryId && !UUID_RE.test(beneficiaryId)) {
      return NextResponse.json(
        { success: false, error: 'Beneficiario inválido' },
        { status: 400 },
      );
    }
    if (!beneficiaryId && !name) {
      return NextResponse.json({ success: true, suggestions: [] });
    }

    const admin = createAdminClient();
    let query = admin
      .from('payment_orders')
      .select('lines, created_at')
      .eq('company_id', auth.companyId)
      .order('created_at', { ascending: false })
      .limit(ORDERS_SCANNED);

    // `or` con dos condiciones: el id cubre las órdenes de la libreta y el
    // nombre las anteriores a ella. Las comas dentro de un nombre romperían la
    // sintaxis de PostgREST, así que ese caso cae solo al id.
    if (beneficiaryId && name && !name.includes(',')) {
      query = query.or(`beneficiary_id.eq.${beneficiaryId},beneficiary_name.ilike.${name}`);
    } else if (beneficiaryId) {
      query = query.eq('beneficiary_id', beneficiaryId);
    } else if (name) {
      query = query.ilike('beneficiary_name', name);
    }

    const { data, error } = await query;
    if (error) return apiError('payment-orders/line-suggestions', error, { status: 500 });

    // Dedup case-insensitive conservando la grafía y el importe MÁS RECIENTES
    // (las filas ya vienen ordenadas por fecha desc, así que la primera gana).
    const seen = new Map<string, LineSuggestion>();
    for (const row of (data ?? []) as Array<{ lines: unknown }>) {
      if (!Array.isArray(row.lines)) continue;
      for (const raw of row.lines) {
        const line = raw as { description?: unknown; unitValue?: unknown };
        const description = typeof line?.description === 'string' ? line.description.trim() : '';
        if (!description) continue;
        const key = description.toLowerCase();
        if (seen.has(key)) continue;
        const unit = Number(line?.unitValue);
        seen.set(key, {
          description,
          lastUnitValue: Number.isFinite(unit) && unit > 0 ? unit : null,
        });
        if (seen.size >= MAX_SUGGESTIONS) break;
      }
      if (seen.size >= MAX_SUGGESTIONS) break;
    }

    return NextResponse.json({ success: true, suggestions: [...seen.values()] });
  } catch (err) {
    return apiError('payment-orders/line-suggestions', err, { status: 500 });
  }
}
