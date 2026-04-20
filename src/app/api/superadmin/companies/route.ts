import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// POST /api/superadmin/companies
//
// Create a new tenant. Uses service_role under the hood so created_by gets
// populated regardless of RLS nuances. Idempotent on slug collision: returns
// 409 with the existing company so the UI can link the superadmin to it.
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const {
      name,
      slug: slugInput,
      subdomain,
      logo_url,
      color_primary,
      color_secondary,
      active_modules,
      reserve_pct,
      currency,
      status,
    } = body as {
      name?: string;
      slug?: string;
      subdomain?: string;
      logo_url?: string | null;
      color_primary?: string;
      color_secondary?: string;
      active_modules?: string[];
      reserve_pct?: number;
      currency?: string;
      status?: 'active' | 'inactive';
    };

    if (!name || name.trim().length < 2) {
      return NextResponse.json(
        { success: false, error: 'Nombre requerido (mínimo 2 caracteres)' },
        { status: 400 },
      );
    }

    const slug = slugify(slugInput || name);
    const sub = subdomain || slug;

    const admin = createAdminClient();

    // Slug uniqueness — surface a friendly 409 so UI can suggest alternatives.
    const { data: existing } = await admin
      .from('companies')
      .select('id, name, slug')
      .or(`slug.eq.${slug},subdomain.eq.${sub}`)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        {
          success: false,
          error: `Slug/subdomain "${slug}" ya está en uso por "${existing.name}"`,
          existingId: existing.id,
        },
        { status: 409 },
      );
    }

    const { data: created, error: insertError } = await admin
      .from('companies')
      .insert({
        name: name.trim(),
        slug,
        subdomain: sub,
        logo_url: logo_url || null,
        color_primary: color_primary || '#1E3A5F',
        color_secondary: color_secondary || '#3B82F6',
        active_modules: active_modules || [
          'summary', 'movements', 'expenses', 'liquidity', 'investments',
          'balances', 'partners', 'upload', 'periods',
        ],
        reserve_pct: reserve_pct ?? 0.1,
        currency: currency || 'USD',
        status: status || 'active',
        created_by: auth.userId,
      })
      .select('id, name, slug, subdomain, logo_url, color_primary, color_secondary, active_modules, reserve_pct, currency, status, created_at')
      .single();

    if (insertError || !created) {
      return NextResponse.json(
        { success: false, error: insertError?.message || 'No fue posible crear la entidad' },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, company: created });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/superadmin/companies
//
// Returns all companies with a user count attached. RLS with the superadmin
// bypass would also work for this, but pulling the aggregation here keeps
// the UI page simpler.
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const { data: companies, error } = await admin
      .from('companies')
      .select('id, name, slug, logo_url, color_primary, color_secondary, active_modules, status, created_at')
      .order('created_at', { ascending: true });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    // One aggregate query for user counts to avoid N+1.
    const { data: counts } = await admin
      .from('company_users')
      .select('company_id');

    const byCompany = new Map<string, number>();
    for (const row of counts ?? []) {
      byCompany.set(row.company_id as string, (byCompany.get(row.company_id as string) ?? 0) + 1);
    }

    const enriched = (companies ?? []).map((c) => ({
      ...c,
      user_count: byCompany.get(c.id) ?? 0,
    }));

    return NextResponse.json({ success: true, companies: enriched });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
