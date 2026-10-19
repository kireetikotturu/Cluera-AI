import {z} from 'zod';
const timestamp=z.iso.datetime({offset:true});
export const nativeCommandBoundary=z.object({createdAt:timestamp,id:z.uuid()}).strict();
export const nativeCommandRow=z.object({id:z.uuid(),userId:z.uuid(),subscriptionId:z.string().regex(/^sub_[A-Za-z0-9]{8,64}$/),
 kind:z.enum(['CANCEL_FUTURE','RESCHEDULE']),state:z.enum(['PENDING','CLAIMED','ACCEPTED','UNCERTAIN','REVIEW']),
 createdAt:timestamp,effectiveAt:timestamp.nullable(),leaseUntil:timestamp.nullable(),observedAt:timestamp.nullable()}).strict()
 .refine(row=>(row.kind==='RESCHEDULE')===(row.effectiveAt!==null));
const common={code:z.literal('ACTIVE'),observedAt:timestamp,subject:z.uuid().nullable(),rows:z.array(nativeCommandRow).max(50)};
const unique=(value:{rows:z.infer<typeof nativeCommandRow>[];subject:string|null})=>new Set(value.rows.map(row=>row.id)).size===value.rows.length
 &&value.rows.every(row=>value.subject===null||row.userId===value.subject);
export const nativeCommandsSqlSchema=z.object({...common,hasMore:z.boolean(),before:nativeCommandBoundary.nullable()}).strict()
 .refine(value=>unique(value)&&(value.hasMore?value.rows.length===50&&value.before?.id===value.rows.at(-1)?.id
  &&value.before?.createdAt===value.rows.at(-1)?.createdAt:value.before===null));
export const nativeCommandsSchema=z.object({...common,viewer:z.string().regex(/^[a-f0-9]{64}$/),
 nextCursor:z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).max(2048).nullable()}).strict().refine(unique);
export type NativeCommands=z.infer<typeof nativeCommandsSchema>;
