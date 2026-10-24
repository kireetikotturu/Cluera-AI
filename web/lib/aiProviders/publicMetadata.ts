import {z} from 'zod';
// Browser-safe, secret-free DTO. No Node crypto or server configuration import.
export const metadataSchema=z.object({provider:z.enum(['gemini','deepgram','openai','anthropic']),revision:z.number().int().positive(),credentialPresent:z.literal(true),enabled:z.boolean(),defaultModel:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/).nullable(),probeStatus:z.enum(['UNVERIFIED','VERIFIED','REJECTED','UNAVAILABLE']),probeAt:z.iso.datetime({offset:true}).nullable(),models:z.array(z.object({id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/),runtimeCompatible:z.boolean()}).strict()).max(1000),complete:z.boolean(),updatedAt:z.iso.datetime({offset:true})}).strict();
export type Metadata=z.infer<typeof metadataSchema>;
export const metadataListSchema=z.object({code:z.literal('ACTIVE'),providers:z.array(metadataSchema).max(4)}).strict().refine(v=>new Set(v.providers.map(p=>p.provider)).size===v.providers.length);
export const operationContextSchema=z.object({provider:metadataSchema.shape.provider,revision:z.number().int().min(0)}).strict();
export type OperationContext=z.infer<typeof operationContextSchema>;
export type PendingOperation=OperationContext&{operationId:string}&({action:'REPLACE'}|{action:'TEST'}|{action:'CONFIGURE';enabled:boolean;defaultModel:string|null;fallback:'NONE'});
export const operationStatusSchema=z.discriminatedUnion('code',[
 z.object({code:z.literal('APPLIED'),operationId:z.uuid(),metadata:metadataSchema}).strict(),
 z.object({code:z.literal('SUPERSEDED'),operationId:z.uuid(),metadata:metadataSchema}).strict(),
 z.object({code:z.literal('REJECTED'),operationId:z.uuid(),metadata:metadataSchema}).strict(),
 z.object({code:z.literal('NOT_RECORDED'),operationId:z.uuid(),metadata:metadataSchema.nullable()}).strict(),
]);
