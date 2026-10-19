import { z } from 'zod';
import { clueraOfferCode } from './publicCatalog';

// Customer-safe immutable policy snapshot. No merchant, payer, provider plan,
// credential, invoice URL, raw receipt or privileged audit evidence is returned.
const revision = z.object({
  revisionId: z.uuid(), offerCode: clueraOfferCode, version: z.number().int().positive(),
  name: z.string().trim().min(2).max(80), kind: z.enum(['PACK', 'RECURRING']),
  amountPaise: z.number().int().min(100).max(10_000_000), currency: z.literal('INR'),
  allowanceSeconds: z.number().int().min(60).max(3_600_000),
}).strict().refine(row => (row.kind === 'PACK') === (row.offerCode === 'cluera_pack_3h_v2'));
const timestamp = z.iso.datetime({ offset: true });
const subscriptionId = z.string().regex(/^sub_[A-Za-z0-9]{8,64}$/);
const payment = z.object({
  paymentId: z.string().regex(/^pay_[A-Za-z0-9]{8,64}$/),
  invoiceId: z.string().regex(/^inv_[A-Za-z0-9]{8,64}$/).nullable(),
  subscriptionId: subscriptionId.nullable(), state: z.enum(['VERIFIED', 'REFUNDED']),
  revision, intentCreatedAt: timestamp, paidAt: timestamp.nullable(),
  periodStart: timestamp.nullable(), periodEnd: timestamp.nullable(),
}).strict().superRefine((row, context) => {
  const pack = row.revision.kind === 'PACK';
  if (pack ? row.invoiceId !== null || row.subscriptionId !== null || row.paidAt !== null
      || row.periodStart !== null || row.periodEnd !== null
    : row.invoiceId === null || row.subscriptionId === null || row.paidAt === null
      || row.periodStart === null || row.periodEnd === null || Date.parse(row.periodEnd) <= Date.parse(row.periodStart))
    context.addIssue({ code: 'custom', message: 'Invalid payment history.' });
});
const subscription = z.object({
  subscriptionId, state: z.enum(['ACTIVE', 'PAST_DUE', 'CANCELED', 'PAUSED']),
  revision: revision.refine(row => row.kind === 'RECURRING'), observedAt: timestamp,
  paidThrough: timestamp.nullable(), graceUntil: timestamp.nullable(),
  cancelFuture: z.boolean(), cancellationAt: timestamp.nullable(),
}).strict();
const milliseconds=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const clueraNativeHistoryTerm=z.object({
  invoiceId:z.string().regex(/^inv_[A-Za-z0-9]{8,64}$/),subscriptionId,
  revision:revision.refine(row=>row.kind==='RECURRING'),
  state:z.enum(['ACTIVE','SUSPENDED','QUEUED','PRESERVED','ENDED','REFUNDED']),
  startsAt:timestamp.nullable(),endsAt:timestamp.nullable(),savedWallMilliseconds:milliseconds.nullable(),
  allowanceMilliseconds:milliseconds,spentMilliseconds:milliseconds,reservedMilliseconds:milliseconds,
  remainingAllowanceMilliseconds:milliseconds,spendableMilliseconds:milliseconds,
}).strict().superRefine((row,context)=>{
  const saved=row.state==='PRESERVED'||row.state==='QUEUED',closed=row.state==='ENDED'||row.state==='REFUNDED';
  if(row.allowanceMilliseconds!==row.revision.allowanceSeconds*1000||row.spentMilliseconds+row.reservedMilliseconds>row.allowanceMilliseconds
    ||row.remainingAllowanceMilliseconds!==(closed?0:row.allowanceMilliseconds-row.spentMilliseconds-row.reservedMilliseconds)
    ||row.spendableMilliseconds>row.remainingAllowanceMilliseconds||(row.state!=='ACTIVE'&&row.spendableMilliseconds!==0)
    ||(row.spendableMilliseconds!==0&&row.spendableMilliseconds!==row.remainingAllowanceMilliseconds)||(closed&&row.reservedMilliseconds!==0)
    ||(row.state==='PRESERVED'&&row.revision.offerCode==='cluera_monthly_200h_v2')
    ||(saved?(row.startsAt!==null||row.endsAt!==null||!row.savedWallMilliseconds||row.reservedMilliseconds!==0)
      :row.savedWallMilliseconds!==null)
    ||((row.state==='ACTIVE'||row.state==='SUSPENDED')&&(row.startsAt===null||row.endsAt===null||Date.parse(row.endsAt)<=Date.parse(row.startsAt))))
    context.addIssue({code:'custom',message:'Invalid native entitlement snapshot.'});
});
const nativeSchedule=z.object({observedAt:timestamp,terms:z.array(clueraNativeHistoryTerm).max(50),hasMoreTerms:z.boolean()}).strict()
  .superRefine((value,context)=>{
    if(new Set(value.terms.map(row=>row.invoiceId)).size!==value.terms.length||(value.hasMoreTerms&&value.terms.length!==50)
      ||value.terms.filter(row=>row.state==='ACTIVE'||row.state==='SUSPENDED').length>1)
      context.addIssue({code:'custom',message:'Invalid native entitlement boundary.'});
    for(const row of value.terms)if(row.spendableMilliseconds>0&&(row.startsAt===null||row.endsAt===null
      ||Date.parse(row.startsAt)>Date.parse(value.observedAt)||Date.parse(row.endsAt)<=Date.parse(value.observedAt)))
      context.addIssue({code:'custom',message:'Invalid spendable entitlement window.'});
  });
export const clueraBillingHistorySchema = z.object({
  code: z.literal('ACTIVE'), userId: z.uuid(),
  payments: z.array(payment).max(50), subscriptions: z.array(subscription).max(50),
  hasMorePayments: z.boolean(), hasMoreSubscriptions: z.boolean(),
  nativeSchedule:nativeSchedule.optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.payments.map(row => row.paymentId)).size !== value.payments.length
    || new Set(value.payments.flatMap(row => row.invoiceId ? [row.invoiceId] : [])).size
      !== value.payments.filter(row => row.invoiceId !== null).length
    || new Set(value.subscriptions.map(row => row.subscriptionId)).size !== value.subscriptions.length)
    context.addIssue({ code: 'custom', message: 'Duplicate history entry.' });
  if ((value.hasMorePayments && value.payments.length !== 50)
    || (value.hasMoreSubscriptions && value.subscriptions.length !== 50))
    context.addIssue({ code: 'custom', message: 'Invalid history boundary.' });
});
export type ClueraBillingHistory = z.infer<typeof clueraBillingHistorySchema>;
