import {z} from 'zod';
import {clueraOfferCode} from './publicCatalog';

const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const reportTimestamp=z.iso.datetime({offset:true});
const revision=z.object({revisionId:z.uuid(),offerCode:clueraOfferCode,version:integer.min(1),
 name:z.string().trim().min(2).max(80),kind:z.enum(['PACK','RECURRING']),
 amountPaise:integer.min(100).max(10_000_000),currency:z.literal('INR')}).strict();
const payment=z.object({paymentId:z.string().regex(/^pay_[A-Za-z0-9]{8,64}$/),
 orderId:z.string().regex(/^order_[A-Za-z0-9]{8,64}$/),invoiceId:z.string().regex(/^inv_[A-Za-z0-9]{8,64}$/).nullable(),
 subscriptionId:z.string().regex(/^sub_[A-Za-z0-9]{8,64}$/).nullable(),state:z.enum(['VERIFIED','REFUNDED']),
 amountPaise:integer.min(100).max(10_000_000),currency:z.literal('INR'),paidAt:reportTimestamp.nullable()}).strict();
export const financialReportRow=z.object({intentId:z.uuid(),userId:z.uuid(),createdAt:reportTimestamp,
 intentState:z.enum(['CREATING','BOUND','UNCERTAIN','VERIFIED','REFUNDED']),revision,payment:payment.nullable()}).strict()
 .superRefine((row,ctx)=>{
  if((row.revision.kind==='PACK')!==(row.revision.offerCode==='cluera_pack_3h_v2')
   ||row.payment&&(row.payment.amountPaise!==row.revision.amountPaise
    ||(row.revision.kind==='PACK'?(row.payment.invoiceId!==null||row.payment.subscriptionId!==null||row.payment.paidAt!==null)
     :(row.payment.invoiceId===null||row.payment.subscriptionId===null||row.payment.paidAt===null))))
   ctx.addIssue({code:'custom',message:'Invalid financial record.'});
 });
export const financialTotals=z.object({scope:z.literal('CURRENT_PAGE'),currency:z.literal('INR'),
 verifiedCount:integer.max(50),verifiedAmountPaise:integer.max(500_000_000),
 refundedCount:integer.max(50),refundedAmountPaise:integer.max(500_000_000),requestsWithoutPayment:integer.max(50)}).strict();
export const reportBoundary=z.object({createdAt:reportTimestamp,intentId:z.uuid(),
 paymentId:z.string().regex(/^pay_[A-Za-z0-9]{8,64}$/).nullable()}).strict();
const common={code:z.literal('ACTIVE'),from:reportTimestamp,to:reportTimestamp,subject:z.uuid().nullable(),
 observedAt:reportTimestamp,rows:z.array(financialReportRow).max(50),totals:financialTotals};
export function reportInvariants(value:{from:string;to:string;subject:string|null;rows:z.infer<typeof financialReportRow>[];totals:z.infer<typeof financialTotals>},ctx:z.RefinementCtx){
 const expected={verifiedCount:0,verifiedAmountPaise:0,refundedCount:0,refundedAmountPaise:0,requestsWithoutPayment:0};
 const keys=new Set<string>();
 for(const row of value.rows){
  const key=row.payment?.paymentId??row.intentId;
  if(keys.has(key)||Date.parse(row.createdAt)<Date.parse(value.from)||Date.parse(row.createdAt)>=Date.parse(value.to)
   ||value.subject!==null&&row.userId!==value.subject)ctx.addIssue({code:'custom',message:'Invalid financial page.'});
  keys.add(key);
  if(!row.payment)expected.requestsWithoutPayment++;
  else if(row.payment.state==='VERIFIED'){expected.verifiedCount++;expected.verifiedAmountPaise+=row.payment.amountPaise;}
  else{expected.refundedCount++;expected.refundedAmountPaise+=row.payment.amountPaise;}
 }
 for(const key of Object.keys(expected)as Array<keyof typeof expected>)if(value.totals[key]!==expected[key])
  ctx.addIssue({code:'custom',message:'Invalid financial totals.'});
}
export const financialReportSqlSchema=z.object({...common,hasMore:z.boolean(),before:reportBoundary.nullable()}).strict()
 .superRefine((value,ctx)=>{
  reportInvariants(value,ctx);
  const last=value.rows.at(-1);
  if(value.hasMore?(value.rows.length!==50||!value.before||value.before.createdAt!==last?.createdAt
   ||value.before.intentId!==last?.intentId||value.before.paymentId!==(last?.payment?.paymentId??null))
   :value.before!==null)ctx.addIssue({code:'custom',message:'Invalid financial cursor.'});
 });
export const financialReportSchema=z.object({...common,viewer:z.string().regex(/^[a-f0-9]{64}$/),
 nextCursor:z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).max(2048).nullable()}).strict().superRefine(reportInvariants);
export type FinancialReport=z.infer<typeof financialReportSchema>;
