import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Server-side audit log helper.
//
// The browser helper in `src/lib/audit-log.ts` POSTs to /api/admin/audit-log
// from React components. Superadmin API routes don't have a browser context,
// so they need to insert into `audit_logs` directly via the admin client.
//
// The table schema (migration-001 + schema.sql):
//   { id, company_id, user_id, user_name, action, module, details,
//     ip_address, created_at }
//
// `action` is constrained to: create|update|delete|login|logout|export|view.
// ---------------------------------------------------------------------------

export type AuditAction = 'create' | 'update' | 'delete' | 'login' | 'logout' | 'export' | 'view';

export interface ServerAuditEntry {
  companyId: string | null;
  actorId: string;
  actorName: string;
  action: AuditAction;
  module: string;
  /** Human-readable summary. Include target + diff so the log is readable. */
  details: string;
}

/**
 * Insert an audit_logs row using the admin client. Never throws — audit
 * failures should not break the action they were recording. Errors are
 * logged to the server console for operator visibility.
 */
export async function serverAuditLog(
  admin: SupabaseClient,
  entry: ServerAuditEntry,
): Promise<void> {
  try {
    const { error } = await admin.from('audit_logs').insert({
      company_id: entry.companyId,
      user_id: entry.actorId,
      user_name: entry.actorName,
      action: entry.action,
      module: entry.module,
      details: entry.details,
    });
    if (error) {
      console.error('[server-audit] insert failed:', error.message);
    }
  } catch (err) {
    console.error('[server-audit] unexpected:', err);
  }
}
