// A deliberately small diagnostic boundary. PostgREST errors can contain SQL
// values, request data, and hints, so never retain their raw message or cause.
const operations = [
  'billing.sandbox.receive', 'billing.checkout', 'billing.reconcile', 'billing.outbox',
  'account.authorize', 'account.rateLimit', 'account.usage', 'account.workspace', 'account.admin', 'account.models',
  'admin.profile.read', 'admin.rateLimit',
  'catalog.pricing.read', 'catalog.pricing.update',
  'catalog.models.read', 'catalog.models.upsert',
  'license.rateLimit', 'license.validate', 'license.create', 'license.usage', 'license.runtime',
  'license.list', 'license.get', 'license.action', 'license.resetDevice', 'license.audit',
  'release.latest', 'release.list', 'release.create', 'release.publishRead', 'release.publish',
] as const;

export type SupabaseOperation = typeof operations[number];
const knownOperations = new Set<string>(operations);
const knownCodes = new Set([
  '42501', '42P01', '42703', '42883', '23503', '23505',
  'PGRST000', 'PGRST116', 'PGRST202', 'PGRST205', 'PGRST301',
]);

function safeCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && knownCodes.has(code) ? code : undefined;
}

function safeStatus(status: unknown): number | undefined {
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
    ? status : undefined;
}

function diagnosticMessage(code: string | undefined): string {
  switch (code) {
    case '42501': return 'Database role lacks the required privilege.';
    case '42P01': return 'A required database table is missing.';
    case '42703': return 'The database schema does not match the application query.';
    case '42883': return 'A required database function is missing.';
    case 'PGRST000': return 'The Data API could not reach the database.';
    case 'PGRST202': return 'A required RPC is absent from the API schema cache.';
    case 'PGRST205': return 'A required table is absent from the API schema cache.';
    case 'PGRST301': return 'The Data API rejected its authorization token.';
    default: return 'Supabase operation failed.';
  }
}

export class SupabaseOperationError extends Error {
  override readonly name = 'SupabaseOperationError';
  readonly operation: SupabaseOperation | 'unknown';
  readonly code: string | undefined;
  readonly httpStatus: number | undefined;

  constructor(operation: SupabaseOperation, error: unknown, status?: unknown) {
    const code = safeCode(error);
    super(diagnosticMessage(code));
    this.operation = knownOperations.has(operation) ? operation : 'unknown';
    this.code = code;
    this.httpStatus = safeStatus(status);
  }
}
