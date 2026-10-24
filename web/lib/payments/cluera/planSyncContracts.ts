import { z } from 'zod';
import { offerCode, planId } from './contracts';

export const testPlanInput = z.object({
  name:z.string().trim().min(2).max(80), amountPaise:z.number().int().min(100).max(10000000),
  allowanceSeconds:z.number().int().min(60).max(3600000), totalCount:z.number().int().min(1).max(120),
}).strict();
export const testPlanOperation = z.object({
  operationId:z.uuid(), offerCode, expectedRevisionId:z.uuid(), state:z.enum(['CLAIMED','BOUND','APPLIED']),
  input:testPlanInput, reason:z.string().min(10).max(500), razorpayPlanId:planId.nullable(),
}).strict();
export type TestPlanOperation = z.infer<typeof testPlanOperation>;
