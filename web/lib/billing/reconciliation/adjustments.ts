import {z} from 'zod';
import {PaddleBoundaryError} from '../paddle';
import {assertCheckoutStaging} from '../checkout/service';

const adjustment=z.object({id:z.string().regex(/^adj_[a-z0-9]{26}$/),transaction_id:z.string(),customer_id:z.string(),
  action:z.string(),type:z.enum(['full','partial']),status:z.enum(['approved','pending_approval','rejected','reversed']),
  currency_code:z.literal('INR')});

/** Complete bounded adjustment snapshot. Never follow provider-supplied URLs.
 * Failure/oversized history is a retry/review, not evidence of "no refunds". */
export async function inspectTransactionAdjustments(transactionId:string,customerId:string,env=process.env,request:typeof fetch=fetch){
  assertCheckoutStaging(env);
  if(!/^txn_[a-z0-9]{26}$/.test(transactionId)||!/^ctm_[a-z0-9]{26}$/.test(customerId)
    ||!env.PADDLE_API_KEY||env.PADDLE_API_KEY.length<20)throw new PaddleBoundaryError();
  const collected:z.infer<typeof adjustment>[]=[];let after:string|undefined;
  try{
    for(let page=0;page<4;page++){
      const query=new URLSearchParams({transaction_id:transactionId,per_page:'50',order_by:'id[ASC]'});
      if(after)query.set('after',after);
      const response=await request(`https://sandbox-api.paddle.com/adjustments?${query}`,{
        headers:{Authorization:`Bearer ${env.PADDLE_API_KEY}`,'Paddle-Version':'1',Accept:'application/json'},
        redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10_000)});
      if(!response.ok||!response.body){await response.body?.cancel();throw new PaddleBoundaryError();}
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;
        bytes+=value.byteLength;if(bytes>256*1024)throw new PaddleBoundaryError();chunks.push(value);}}
      finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
      const value=z.object({data:z.array(adjustment).max(50),meta:z.object({pagination:z.object({has_more:z.boolean()})})})
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      for(const a of value.data){
        if(a.transaction_id!==transactionId||a.customer_id!==customerId||collected.some(c=>c.id===a.id))throw new PaddleBoundaryError();
        collected.push(a);
      }
      if(!value.meta.pagination.has_more)return collected;
      const next=value.data.at(-1)?.id;if(!next||next===after)throw new PaddleBoundaryError();after=next;
    }
    throw new PaddleBoundaryError();
  }catch{throw new PaddleBoundaryError();}
}
