import { z } from 'zod';

/** Browser-safe command metadata; lease, merchant, plan and provider bodies stay server-side. */
export const cancellationResource = z.string().regex(/^sub_[A-Za-z0-9]{8,64}$/);
export const cancellationInput = z.object({ expectedAccountId: z.uuid(), operationId: z.uuid(), subscriptionId: cancellationResource }).strict();
export const cancellationResult = z.object({ code: z.literal('RECORDED'), command: z.object({
  operationId: z.uuid(), subscriptionId: cancellationResource,
  state: z.enum(['CLAIMED','UNCERTAIN','ACCEPTED','CONFIRMED']),
}).strict() }).strict();
export type CancellationCommand = z.infer<typeof cancellationResult>['command'];
