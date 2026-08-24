// ─────────────────────────────────────────────────────────────────────────────
// Tipos del espejo CRM → Supabase (migración 088).
//
// Las filas de acá son EL CONTRATO con las tablas crm_withdrawals /
// crm_deposits / crm_user_snapshots: un campo que no exista en la migración
// no puede aparecer acá (PostgREST rechaza la columna desconocida y se cae
// el lote entero, no la fila).
// ─────────────────────────────────────────────────────────────────────────────

/** Estados normalizados de retiro. Mismo check que la migración 088. */
export type WithdrawalStatusNorm =
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'pending'
  | 'unknown';

/** Estados normalizados de depósito. Mismo check que la migración 088. */
export type DepositStatusNorm =
  | 'completed'
  | 'cancelled'
  | 'pending'
  | 'in_review'
  | 'unknown';

/** Documento crudo de Mongo tal como lo entrega el driver. */
export type MongoDoc = Record<string, unknown>;

export interface CrmWithdrawalRow {
  company_id: string;
  external_id: string;
  user_external_id: string | null;
  username: string | null;
  email: string | null;
  requested_amount: number | null;
  transaction_amount: number | null;
  fee: number | null;
  coin: string | null;
  network: string | null;
  processor: string | null;
  status_raw: string | null;
  status_norm: WithdrawalStatusNorm;
  type: string | null;
  requested_at: string | null;
  authorized_at: string | null;
  processed_at: string | null;
  target_address: string | null;
  /** NO CONFIABLE (trampa 2). Se guarda para poder comparar, nunca para calcular. */
  crm_total_deposit_lifetime: number | null;
  /** NO CONFIABLE (trampa 2). */
  crm_total_withdraw_lifetime: number | null;
  raw: Record<string, unknown>;
  synced_at: string;
}

export interface CrmDepositRow {
  company_id: string;
  external_id: string;
  user_external_id: string | null;
  /** EL dinero real (trampa 1). */
  amount_paid: number | null;
  /** Intención del usuario, corrupta en parte del histórico (trampa 1). */
  deposit_value: number | null;
  coin: string | null;
  network: string | null;
  external_payment_id: string | null;
  is_fiat: boolean | null;
  status_raw: string | null;
  status_norm: DepositStatusNorm;
  type: string | null;
  deposit_at: string | null;
  raw: Record<string, unknown>;
  synced_at: string;
}

export interface CrmUserRow {
  company_id: string;
  user_external_id: string;
  username: string | null;
  email: string | null;
  country: string | null;
  status: string | null;
  kyc_status: string | null;
  user_type: string | null;
  register_date: string | null;
  sponsor_username: string | null;
  rank: string | null;
  pending_fee_debt: number | null;
  raw: Record<string, unknown>;
  synced_at: string;
  /** El `updatedAt` de Orion: el cursor de quien consuma nuestro espejo. */
  source_updated_at: string | null;
  first_name: string | null;
  last_name: string | null;
  /** Teléfono SIN normalizar: cuarta llave del cruce y dato de pantalla. */
  phone_raw: string | null;
  /** Prefijo telefónico, no el país. */
  phone_country_code: string | null;
  /** ISO del país: `country` es el nombre largo y no sirve para agrupar. */
  country_iso: string | null;
  language: string | null;
  /** Distinto de sponsor_username y no derivable de él. */
  sponsor_email: string | null;
  ib_program_name: string | null;
  ib_program_broker_name: string | null;
}

/** Conteos por colección que devuelve el sync. */
export interface CrmSyncCollectionStats {
  fetched: number;
  upserted: number;
}

/** Cursor incremental por colección: máximo `updatedAt` visto en el CRM. */
export interface CrmSyncCursors {
  withdrawals: string | null;
  deposits: string | null;
}

export interface CrmSyncResult {
  companyId: string;
  ranAt: string;
  /** true = se ignoró el cursor y se recorrió todo el histórico. */
  full: boolean;
  /** Desde dónde se filtró cada colección (null = sin filtro, carga completa). */
  since: CrmSyncCursors;
  withdrawals: CrmSyncCollectionStats;
  deposits: CrmSyncCollectionStats;
  users: CrmSyncCollectionStats;
  /** Valores de estado que el CRM trajo y que no sabemos mapear. */
  unknownStatuses: string[];
  /** Cuántos depositValue absurdos se guardaron como null (trampa 1). */
  corruptDepositValues: number;
  /** Cursor que queda guardado para la próxima corrida. */
  cursors: CrmSyncCursors;
  elapsedMs: number;
  errors: string[];
}
