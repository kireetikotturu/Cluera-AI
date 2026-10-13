import { z } from 'zod';

// Fixed server-owned models/limits. No customer-supplied URL, key, identity,
// ledger run ID, sequence number or amount is accepted. A requested model ID
// is only a selector into the server-owned approved registry, never routing authority.
export const GEMINI_MODEL = 'gemini-3.5-flash';
export const DEEPGRAM_MODEL = 'flux-general-en';
export const MAX_FRAME_BYTES = 7_000_000;
export const authFrame = z.object({ type: z.literal('authenticate'), accessToken: z.string().min(20).max(12000) }).strict();
const channel = z.enum(['interviewer', 'candidate']);
const image = z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z.string().min(4).max(6_666_668).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict().refine(value => {
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length > 5_000_000 || bytes.toString('base64') !== value.data) return false;
  if (value.mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (value.mimeType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
});
export const commandFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('generate'), id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    prompt: z.string().min(1).max(120000), image: image.optional(), modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/).optional() }).strict(),
  z.object({ type: z.literal('cancelGeneration') }).strict(),
  z.object({ type: z.literal('openAudio'), channel }).strict(),
  z.object({ type: z.literal('closeAudio'), channel }).strict(),
  z.object({ type: z.literal('forceEndTurn'), channel }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
]);
export type Generate = Extract<z.infer<typeof commandFrame>, { type: 'generate' }>;
export type Channel = z.infer<typeof channel>;

/** Retain only an incomplete secret prefix, not whole answer chunks. Handles a
 * secret split across arbitrarily many SSE events without adding normal latency. */
export function secretFilter(secrets: readonly string[]) {
  const keys = [...new Set(secrets.filter(Boolean))];
  let pending = '';
  return {
    push(text: string, final = false) {
      pending += text;
      for (const key of keys) pending = pending.split(key).join('[REDACTED]');
      let hold = 0;
      if (!final) for (const key of keys) {
        for (let length = Math.min(key.length - 1, pending.length); length > hold; length--) {
          if (pending.endsWith(key.slice(0, length))) { hold = length; break; }
        }
      }
      const result = pending.slice(0, pending.length - hold);
      pending = pending.slice(pending.length - hold);
      return result;
    },
  };
}
