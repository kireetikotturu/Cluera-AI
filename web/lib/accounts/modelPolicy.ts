import {z} from 'zod';

/** An Admin-approved AI model. Answer models come from Gemini, ChatGPT (OpenAI) or
 * Claude (Anthropic); live transcription uses a Deepgram Flux model. */
export const accountModelPolicy=z.object({
 modelId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/),
 displayName:z.string().trim().min(2).max(80),provider:z.enum(['gemini','openai','anthropic','deepgram']),
 enabled:z.boolean(),isDefault:z.boolean(),priority:z.number().int().min(0).max(1000),
 capabilities:z.array(z.enum(['text','image','audio'])).min(1).max(3),
 health:z.enum(['UNVERIFIED','HEALTHY','DEGRADED','UNAVAILABLE']),
 /** Label shown next to the name in the app. Blank = automatic, "-" = no label. */
 tag:z.string().trim().max(24).refine(value=>!/[<>]/.test(value)&&![...value].some(char=>char.charCodeAt(0)<32),'Tags cannot contain control characters or angle brackets.').optional(),
}).strict().superRefine((value,ctx)=>{
 const capabilities=new Set(value.capabilities);
 if(capabilities.size!==value.capabilities.length)ctx.addIssue({code:'custom',message:'Duplicate capabilities.'});
 if(value.provider==='deepgram'&&(!/^flux-[a-z0-9-]{1,60}$/.test(value.modelId)||capabilities.size!==1||!capabilities.has('audio')))
  ctx.addIssue({code:'custom',message:'Deepgram live transcription needs a Flux model (for example flux-general-en).'});
 if(value.provider!=='deepgram'&&(!capabilities.has('text')||capabilities.has('audio')))
  ctx.addIssue({code:'custom',message:'Answer models need text and optional image support.'});
 if(value.isDefault&&(!value.enabled||value.health==='UNAVAILABLE'))ctx.addIssue({code:'custom',message:'Default model must be available.'});
});
export const modelDelete=z.object({modelId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/)}).strict();
