import {z} from 'zod';
const count=z.number().int().min(0).max(1_000_000_000);
const modelName=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,99}$/);
const label=z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
export const receiptMetadataSchema=z.object({requestHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
 inputTokens:count.optional(),outputTokens:count.optional(),cachedTokens:count.optional(),thinkingTokens:count.optional(),
 totalTokens:count.optional(),audioWindowMilliseconds:count.optional(),
 /** Audio actually sent to live transcription: what Deepgram bills. */
 audioSentMilliseconds:count.optional(),
 /** Input written to the provider's cache (priced higher), and the part kept for longer. */
 cacheWriteTokens:count.optional(),cacheWrite1hTokens:count.optional(),
 /** The model that actually answered, which can differ from the one asked for. */
 servedModel:modelName.optional(),serviceTier:label.optional(),region:label.optional(),
 /** The reply was stopped before the provider reported final counts, so these are approximate. */
 estimated:z.boolean().optional()}).strict();
export type ReceiptMetadata=z.infer<typeof receiptMetadataSchema>;
/** A provider's text is kept only when it is a plain model name or label; anything else is dropped, never stored. */
export function safeModelName(value:unknown):string|undefined{
 const text=typeof value==='string'?value.replace(/^models\//,''):'';
 return modelName.safeParse(text).success?text:undefined;
}
export const safeLabel=(value:unknown):string|undefined=>label.safeParse(value).success?value as string:undefined;
export const providerOutcome=z.enum(['SUCCEEDED','FAILED','CANCELLED','STOPPED']);
export type ProviderOutcome=z.infer<typeof providerOutcome>;
export const providerUsageReportSchema=z.object({code:z.literal('ACTIVE'),scope:z.literal('LATEST_REQUESTS'),limit:z.literal(50),
 costStatus:z.literal('UNAVAILABLE'),rows:z.array(z.object({operationId:z.uuid(),provider:z.enum(['gemini','deepgram','openai','anthropic']),
  model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/),startedAt:z.iso.datetime({offset:true}),
  finishedAt:z.iso.datetime({offset:true}).nullable(),outcome:z.enum(['SUCCEEDED','FAILED','CANCELLED','STOPPED','UNCONFIRMED']),
  elapsedMilliseconds:z.number().int().min(0).max(3_600_000).nullable(),requestHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  inputTokens:count.nullable(),outputTokens:count.nullable(),cachedTokens:count.nullable(),thinkingTokens:count.nullable(),
  totalTokens:count.nullable(),audioWindowMilliseconds:count.nullable(),cost:z.null(),costStatus:z.literal('UNAVAILABLE')}).strict()).max(50)}).strict().superRefine((report,context)=>{
 if(new Set(report.rows.map(row=>row.operationId.toLowerCase())).size!==report.rows.length)context.addIssue({code:'custom',message:'Duplicate operation.'});
 for(const row of report.rows){
  const terminal=[row.finishedAt,row.elapsedMilliseconds,row.requestHash,row.inputTokens,row.outputTokens,row.cachedTokens,row.thinkingTokens,row.totalTokens,row.audioWindowMilliseconds];
  if(row.outcome==='UNCONFIRMED'&&terminal.some(value=>value!==null))context.addIssue({code:'custom',message:'Unconfirmed receipt has terminal metadata.'});
  if(row.outcome!=='UNCONFIRMED'&&(row.finishedAt===null||row.elapsedMilliseconds===null))context.addIssue({code:'custom',message:'Confirmed receipt has no terminal time.'});
  if(row.finishedAt!==null&&Date.parse(row.finishedAt)<Date.parse(row.startedAt))context.addIssue({code:'custom',message:'Invalid receipt chronology.'});
 }
});
export type ProviderUsageReport=z.infer<typeof providerUsageReportSchema>;
