/** Admin "Data": the stored résumés. The database checks the Admin session and the authenticator step again for every
 * call and records each view, download and delete in History. Files are reached only through short-lived links. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccountError } from './config';
import { RESUME_BUCKET } from './resumes';

export const resumeListQuery = z.object({
  query: z.string().trim().max(200),
  before: z.iso.datetime({ offset: true }).nullable(),
  beforeId: z.uuid().nullable(),
}).strict().refine(value => Boolean(value.before) === Boolean(value.beforeId));
export const resumeOpen = z.object({ action: z.literal('RESUME_OPEN'), id: z.uuid(), mode: z.enum(['TEXT', 'FILE']) }).strict();
export const resumeDelete = z.object({ id: z.uuid() }).strict();
/** Long enough to start a download, short enough to be useless if copied. */
const LINK_SECONDS = 120;

type Rpc = (name: string, args: Record<string, unknown>) => Promise<any>;
type Storage = { from(bucket: string): {
  createSignedUrl(path: string, seconds: number, options: { download: string }): Promise<{ data: { signedUrl: string } | null; error: unknown }>;
  remove(paths: string[]): Promise<{ error: unknown }>;
} };
type AdminArgs = { p_actor: string; p_session: string };

const EXTENSION: Record<string, string> = { PDF: '.pdf', DOCX: '.docx', TEXT: '.txt', MARKDOWN: '.md', TYPED: '.txt' };
/** A safe download name that keeps the customer's file name and ends with the right extension. */
export function downloadName(name: string, kind: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'resume';
  const extension = EXTENSION[kind] ?? '.txt';
  return clean.toLowerCase().endsWith(extension) ? clean : `${clean.replace(/\.(pdf|docx|txt|md|markdown)$/i, '')}${extension}`;
}

const num = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; };
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export function shapeResumeList(report: Record<string, any>) {
  const totals = report.totals ?? {};
  return {
    totals: { resumes: num(totals.resumes), customers: num(totals.customers), files: num(totals.files), fileBytes: num(totals.fileBytes),
      originalFileBytes: num(totals.originalFileBytes), textBytes: num(totals.textBytes) },
    rows: (Array.isArray(report.rows) ? report.rows : []).map((row: Record<string, unknown>) => ({
      id: text(row.id), userId: text(row.userId), email: text(row.email), name: text(row.name), kind: text(row.kind),
      originalBytes: num(row.originalBytes), storedBytes: num(row.storedBytes), compression: text(row.compression), hasFile: row.hasFile === true,
      source: row.source === 'windows' ? 'windows' : 'phone', sessions: num(row.sessions), createdAt: text(row.createdAt), lastUsedAt: text(row.lastUsedAt),
    })),
  };
}
export type ResumeList = ReturnType<typeof shapeResumeList>;
export type ResumeRow = ResumeList['rows'][number];

export async function openResume(rpc: Rpc, storage: Storage, admin: AdminArgs, input: z.infer<typeof resumeOpen>): Promise<{ status: number; body: object }> {
  const reply = await rpc('cluera_admin_resume_open', { ...admin, p_id: input.id, p_mode: input.mode, p_operation: randomUUID() });
  if (reply?.code === 'NOT_FOUND') return { status: 404, body: { error: 'NOT_FOUND' } };
  if (reply?.code !== 'ACTIVE') throw new AccountError('FORBIDDEN', 403);
  const name = downloadName(text(reply.name), text(reply.kind));
  if (input.mode === 'FILE' && typeof reply.storagePath === 'string') {
    const link = await storage.from(RESUME_BUCKET).createSignedUrl(reply.storagePath, LINK_SECONDS, { download: name });
    if (link.error || !link.data?.signedUrl) throw new AccountError('UNAVAILABLE', 503);
    return { status: 200, body: { name, url: link.data.signedUrl } };
  }
  return { status: 200, body: { name, text: text(reply.text) } };
}

/** The file goes first, so a résumé is never left in storage without a record that it exists. */
export async function deleteResume(rpc: Rpc, storage: Storage, admin: AdminArgs, change: { operationId: string; reason: string; id: string }) {
  const found = await rpc('cluera_admin_resume_open', { ...admin, p_id: change.id, p_mode: 'PATH', p_operation: null });
  if (found?.code === 'FORBIDDEN') throw new AccountError('FORBIDDEN', 403);
  if (found?.code === 'ACTIVE' && typeof found.storagePath === 'string') {
    const removed = await storage.from(RESUME_BUCKET).remove([found.storagePath]);
    if (removed.error) throw new AccountError('UNAVAILABLE', 503);
  }
  // A repeat of a finished delete finds nothing and is confirmed from History.
  return rpc('cluera_admin_resume_delete', { ...admin, p_operation: change.operationId, p_id: change.id, p_reason: change.reason });
}
