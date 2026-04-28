import type { createAdminClient } from '@/lib/supabase/admin';

// Helper compartido: registra una entrada en `ib_rebate_config_history`
// resolviendo el nombre del usuario que cambió (company_users o
// platform_users). Usado por POST/PATCH del recurso ib-rebates.

type AdminClient = ReturnType<typeof createAdminClient>;

export async function logIbRebateHistory(
  admin: AdminClient,
  params: {
    configId: string;
    companyId: string;
    changeType: 'create' | 'edit' | 'upgrade' | 'downgrade' | 'goals_met' | 'note';
    snapshot: Record<string, unknown>;
    changedBy: string;
    notes?: string | null;
  },
) {
  let changedByName: string | null = null;

  const { data: cu } = await admin
    .from('company_users')
    .select('name')
    .eq('user_id', params.changedBy)
    .maybeSingle();
  if (cu?.name) {
    changedByName = cu.name;
  } else {
    const { data: pu } = await admin
      .from('platform_users')
      .select('name')
      .eq('user_id', params.changedBy)
      .maybeSingle();
    if (pu?.name) changedByName = pu.name;
  }

  await admin.from('ib_rebate_config_history').insert({
    config_id: params.configId,
    company_id: params.companyId,
    change_type: params.changeType,
    snapshot: params.snapshot,
    changed_by: params.changedBy,
    changed_by_name: changedByName,
    notes: params.notes ?? null,
  });
}
