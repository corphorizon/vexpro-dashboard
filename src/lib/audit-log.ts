export type AuditAction = 'create' | 'update' | 'delete' | 'login' | 'logout' | 'export' | 'view';

export type AuditModule =
  | 'auth'
  | 'deposits'
  | 'withdrawals'
  | 'expenses'
  | 'income'
  | 'liquidity'
  | 'investments'
  | 'partners'
  | 'hr'
  | 'users'
  | 'periods';

export interface AuditEntry {
  id: string;
  timestamp: string;
  user_id: string;
  user_name: string;
  action: AuditAction;
  module: AuditModule;
  details: string;
  ip?: string;
}

const STORAGE_KEY = 'fd_audit_log';
const MAX_ENTRIES = 500;

function getEntries(): AuditEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveEntries(entries: AuditEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function logAction(
  userId: string,
  userName: string,
  action: AuditAction,
  module: AuditModule,
  details: string,
): void {
  if (typeof window === 'undefined') return;
  const entry: AuditEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    user_id: userId,
    user_name: userName,
    action,
    module,
    details,
  };
  const entries = getEntries();
  entries.unshift(entry);
  // FIFO: keep only last MAX_ENTRIES
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES;
  }
  saveEntries(entries);
}

export interface AuditFilters {
  userId?: string;
  action?: AuditAction;
  module?: AuditModule;
  dateFrom?: string;
  dateTo?: string;
}

export function getAuditLog(filters?: AuditFilters): AuditEntry[] {
  let entries = getEntries();
  if (!filters) return entries;

  if (filters.userId) {
    entries = entries.filter((e) => e.user_id === filters.userId);
  }
  if (filters.action) {
    entries = entries.filter((e) => e.action === filters.action);
  }
  if (filters.module) {
    entries = entries.filter((e) => e.module === filters.module);
  }
  if (filters.dateFrom) {
    entries = entries.filter((e) => e.timestamp >= filters.dateFrom!);
  }
  if (filters.dateTo) {
    // Include the full day by comparing up to end of day
    const endOfDay = filters.dateTo + 'T23:59:59.999Z';
    entries = entries.filter((e) => e.timestamp <= endOfDay);
  }
  return entries;
}

export function clearAuditLog(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

const ACTION_LABELS: Record<AuditAction, string> = {
  create: 'Crear',
  update: 'Actualizar',
  delete: 'Eliminar',
  login: 'Inicio Sesión',
  logout: 'Cierre Sesión',
  export: 'Exportar',
  view: 'Visualizar',
};

const MODULE_LABELS_AUDIT: Record<AuditModule, string> = {
  auth: 'Autenticación',
  deposits: 'Depósitos',
  withdrawals: 'Retiros',
  expenses: 'Egresos',
  income: 'Ingresos',
  liquidity: 'Liquidez',
  investments: 'Inversiones',
  partners: 'Socios',
  hr: 'Recursos Humanos',
  users: 'Usuarios',
  periods: 'Períodos',
};

export function exportAuditLogCSV(entries: AuditEntry[]): string {
  const header = 'ID,Fecha/Hora,Usuario ID,Usuario,Acción,Módulo,Detalles';
  const rows = entries.map((e) => {
    const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
    return [
      escape(e.id),
      escape(new Date(e.timestamp).toLocaleString('es-MX')),
      escape(e.user_id),
      escape(e.user_name),
      escape(ACTION_LABELS[e.action] || e.action),
      escape(MODULE_LABELS_AUDIT[e.module] || e.module),
      escape(e.details),
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

export { ACTION_LABELS as AUDIT_ACTION_LABELS, MODULE_LABELS_AUDIT as AUDIT_MODULE_LABELS };
