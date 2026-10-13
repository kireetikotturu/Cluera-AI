import { ZodError } from 'zod';
import { isIP } from 'node:net';
import { SupabaseOperationError } from './supabase/diagnostics';

export class InvalidInputError extends Error {}

export async function readJsonBody(request: Request, maximumBytes = 16_384): Promise<unknown> {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximumBytes) throw new InvalidInputError('Request is too large.');
  if (!request.body) throw new InvalidInputError('Request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new InvalidInputError('Request is too large.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(data)) as unknown;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

const configurationNames = new Set([
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'LICENSE_HASH_PEPPER_BASE64',
  'LICENSE_SIGNING_PRIVATE_KEY_BASE64', 'LICENSE_LEASE_DAYS',
]);
const supabaseOperations = new Set([
  'billing.sandbox.receive', 'billing.checkout', 'billing.reconcile', 'billing.outbox',
  'account.authorize', 'account.rateLimit', 'account.usage',
  'admin.profile.read', 'admin.rateLimit',
  'catalog.pricing.read', 'catalog.pricing.update',
  'catalog.models.read', 'catalog.models.upsert',
  'license.rateLimit', 'license.validate', 'license.create', 'license.runtime',
  'license.list', 'license.get', 'license.action', 'license.resetDevice', 'license.audit', 'license.usage',
  'release.latest', 'release.list', 'release.create', 'release.publishRead', 'release.publish',
]);
const supabaseCodes = new Set([
  '42501', '42P01', '42703', '42883', '23503', '23505',
  'PGRST000', 'PGRST116', 'PGRST202', 'PGRST205', 'PGRST301',
]);
const supabaseMessages = new Set([
  'Database role lacks the required privilege.',
  'A required database table is missing.',
  'The database schema does not match the application query.',
  'A required database function is missing.',
  'The Data API could not reach the database.',
  'A required RPC is absent from the API schema cache.',
  'A required table is absent from the API schema cache.',
  'The Data API rejected its authorization token.',
  'Supabase operation failed.',
]);

const errorStages = ['admin.release.authorize', 'admin.release.readBody', 'admin.release.validate', 'admin.release.create'] as const;
export type ApiErrorStage = typeof errorStages[number];

function logServerError(error: unknown, stage?: ApiErrorStage): void {
  // Never derive context from a request URL, header or body. Check even typed
  // callers at runtime so an arbitrary value cannot become a log field.
  const context = stage && errorStages.includes(stage) ? { stage } : {};
  // Log only values constructed at our typed error boundary. Raw PostgREST
  // messages, Error objects, stacks, causes, details and hints may include
  // credentials, request data or customer information.
  if (error instanceof SupabaseOperationError) {
    const operation = supabaseOperations.has(error.operation) ? error.operation : 'unknown';
    const message = supabaseMessages.has(error.message) ? error.message : 'Supabase operation failed.';
    const code = error.code && supabaseCodes.has(error.code) ? error.code : undefined;
    const httpStatus = typeof error.httpStatus === 'number' && Number.isInteger(error.httpStatus)
      && error.httpStatus >= 400 && error.httpStatus <= 599 ? error.httpStatus : undefined;
    console.error('[web-api] request failed', {
      type: 'SupabaseOperationError',
      ...context,
      operation,
      message,
      ...(code ? { code } : {}),
      ...(httpStatus ? { httpStatus } : {}),
    });
    return;
  }
  // Node's URL exception carries the original input. Log only an allowlisted
  // code and our fixed description, never the exception/input/message itself.
  const invalidUrl = error instanceof TypeError && 'code' in error && error.code === 'ERR_INVALID_URL';
  console.error('[web-api] request failed', {
    type: 'UnexpectedError',
    ...context,
    ...(error instanceof TypeError ? { errorType: 'TypeError' } : {}),
    ...(invalidUrl ? { code: 'ERR_INVALID_URL' } : {}),
    message: invalidUrl ? 'URL parsing failed.' : 'Exception details withheld.',
  });
}

export function apiError(error: unknown, stage?: ApiErrorStage): Response {
  if (error instanceof InvalidInputError) return json({ error: error.message }, 400);
  if (error instanceof ZodError) return json({ error: 'Invalid request values.' }, 400);
  if (error instanceof SyntaxError) return json({ error: 'Invalid request.' }, 400);
  logServerError(error, stage);
  return json({ error: 'The request could not be completed.' }, 500);
}

export function clientIp(request: Request): string {
  // Vercel overwrites these headers at its ingress. Outside Vercel they are
  // caller-controlled, so use a shared bucket instead of trusting a spoofed IP.
  if (process.env.VERCEL !== '1') return 'unknown';
  const forwarded = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim() ?? '';
  return isIP(first) ? first : 'unknown';
}
