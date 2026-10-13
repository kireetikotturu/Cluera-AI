import {z} from 'zod';
import {DEEPGRAM_MODEL} from '../accountRelay/protocol';

/** The Flux wire adapter supports precisely one audio protocol/model. Reject
 * unsupported policies up front rather than persisting an unusable default. */
export const accountModelPolicy=z.object({
 modelId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/),
 displayName:z.string().trim().min(2).max(80),provider:z.enum(['gemini','deepgram']),
 enabled:z.boolean(),isDefault:z.boolean(),priority:z.number().int().min(0).max(1000),
 capabilities:z.array(z.enum(['text','image','audio'])).min(1).max(3),
 health:z.enum(['UNVERIFIED','HEALTHY','DEGRADED','UNAVAILABLE']),
}).strict().superRefine((value,ctx)=>{
 const capabilities=new Set(value.capabilities);
 if(capabilities.size!==value.capabilities.length)ctx.addIssue({code:'custom',message:'Duplicate capabilities.'});
 if(value.provider==='deepgram'&&(value.modelId!==DEEPGRAM_MODEL||capabilities.size!==1||!capabilities.has('audio')))
  ctx.addIssue({code:'custom',message:'Unsupported internal audio model policy.'});
 if(value.provider==='gemini'&&(!capabilities.has('text')||capabilities.has('audio')))
  ctx.addIssue({code:'custom',message:'Gemini policy requires text and optional image support.'});
 if(value.isDefault&&(!value.enabled||value.health==='UNAVAILABLE'))ctx.addIssue({code:'custom',message:'Default model must be available.'});
});
