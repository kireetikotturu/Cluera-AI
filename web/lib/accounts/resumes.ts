/** Saving a résumé used in a session (Admin "Data"). The customer's app first says what the résumé is (BEGIN). Text
 * résumés are saved at once; for a PDF or Word file the app gets a one-time upload address, sends the file straight to
 * private storage, then asks the server to check, compress and keep it (COMPLETE). */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AccountError } from './config';
import { SupabaseOperationError } from '../supabase/diagnostics';
import type { CompressedResume, ResumeFileKind } from '../resumes/compress';

export const RESUME_BUCKET = 'customer-resumes';
export const MAX_RESUME_BYTES = 20 * 1024 * 1024;
const MIME: Record<ResumeFileKind, string> = { PDF: 'application/pdf', DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const EXTENSION: Record<ResumeFileKind, string> = { PDF: 'pdf', DOCX: 'docx' };

export const resumeInput = z.discriminatedUnion('step', [
  z.object({
    step: z.literal('BEGIN'), hash: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(200),
    kind: z.enum(['PDF', 'DOCX', 'TEXT', 'MARKDOWN', 'TYPED']), bytes: z.number().int().min(1).max(MAX_RESUME_BYTES),
    sessionRef: z.uuid().nullable(), text: z.string().max(100_000),
  }).strict(),
  z.object({ step: z.literal('COMPLETE'), id: z.uuid() }).strict(),
]);
export type ResumeInput = z.infer<typeof resumeInput>;

type Result = { data: unknown; error: { message?: string } | null };
export interface ResumeService {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown; status?: number }>;
  storage: { from(bucket: string): {
    createSignedUploadUrl(path: string, options: { upsert: boolean }): Promise<Result>;
    download(path: string): Promise<Result>;
    upload(path: string, body: Buffer, options: { contentType: string; upsert: boolean }): Promise<Result>;
    remove(paths: string[]): Promise<Result>;
  } };
}
type Compress = { compressResume(bytes: Buffer, kind: ResumeFileKind): Promise<CompressedResume>; looksLike(bytes: Buffer, kind: ResumeFileKind): boolean };
/** Loaded only when a file is processed: the picture and PDF libraries are large. */
const loadCompression = (): Promise<Compress> => import('../resumes/compress');

const pendingPath = (userId: string, id: string) => `pending/${userId}/${id}`;
type Reply = { code?: string; id?: string; upload?: boolean; stale?: string[]; hash?: string; bytes?: number; kind?: ResumeFileKind };

export async function resumeCommand(service: ResumeService, owner: { userId: string; sessionId: string }, input: ResumeInput,
  source: 'phone' | 'windows', compression: () => Promise<Compress> = loadCompression) {
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const { data, error, status } = await service.rpc(name, { p_user: owner.userId, p_session: owner.sessionId, ...args });
    if (error) throw new SupabaseOperationError('account.resume', error as never, status);
    const reply = (data ?? {}) as Reply;
    if (reply.code === 'INVALID' || reply.code === 'NOT_FOUND') throw new AccountError('INVALID_INPUT', 400);
    if (reply.code === 'UNAUTHENTICATED') throw new AccountError('UNAUTHENTICATED', 401);
    if (!['ACTIVE', 'STORED', 'LIMIT'].includes(reply.code ?? '')) throw new AccountError('FORBIDDEN', 403);
    return reply;
  };
  const files = service.storage.from(RESUME_BUCKET);

  if (input.step === 'BEGIN') {
    const { step: _step, sessionRef, ...details } = input;
    const reply = await call('customer_resume_begin', { p_input: { ...details, source, sessionRef: sessionRef ?? '' } });
    // Files left behind by uploads that never finished.
    if (reply.stale?.length) await files.remove(reply.stale.map(id => pendingPath(owner.userId, id))).catch(() => undefined);
    if (reply.code === 'LIMIT' || !reply.id) return { stored: false, upload: null };
    if (!reply.upload) return { id: reply.id, stored: true, upload: null };
    const signed = await files.createSignedUploadUrl(pendingPath(owner.userId, reply.id), { upsert: true });
    const url = (signed.data as { signedUrl?: string } | null)?.signedUrl;
    if (signed.error || !url) throw new AccountError('UNAVAILABLE', 503);
    return { id: reply.id, stored: false, upload: { url } };
  }

  const declared = await call('customer_resume_pending', { p_id: input.id });
  if (declared.code === 'STORED') return { id: input.id, stored: true };
  const pending = pendingPath(owner.userId, input.id);
  const received = await files.download(pending);
  if (received.error || !received.data) throw new AccountError('INVALID_INPUT', 400);
  const bytes = Buffer.from(await (received.data as Blob).arrayBuffer());
  const kind = declared.kind as ResumeFileKind;
  const { compressResume, looksLike } = await compression();
  if (!MIME[kind] || bytes.length !== declared.bytes || createHash('sha256').update(bytes).digest('hex') !== declared.hash || !looksLike(bytes, kind)) {
    // Not the file that was described: nothing is kept.
    await files.remove([pending]).catch(() => undefined);
    await call('customer_resume_discard', { p_id: input.id });
    throw new AccountError('INVALID_INPUT', 400);
  }
  const compressed = await compressResume(bytes, kind);
  const path = `${owner.userId}/${input.id}.${EXTENSION[kind]}`;
  const saved = await files.upload(path, compressed.bytes, { contentType: MIME[kind], upsert: true });
  if (saved.error) throw new AccountError('UNAVAILABLE', 503);
  await call('customer_resume_stored', { p_id: input.id, p_path: path, p_bytes: compressed.bytes.length, p_compression: compressed.compression });
  await files.remove([pending]).catch(() => undefined);
  return { id: input.id, stored: true };
}
