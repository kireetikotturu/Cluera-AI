import { z } from 'zod';
import { CheckoutTransportError } from './diagnostics';
import { sandboxOffer, type SandboxOffer } from '../sandboxCatalog';

export type CheckoutBinding={transactionId:string};
const draft=z.object({id:z.string().regex(/^txn_[a-z0-9]{26}$/),status:z.enum(['draft','ready']),
  collection_mode:z.literal('automatic'),currency_code:z.literal('INR'),
  custom_data:z.object({sigma_checkout_intent:z.uuid()}),
  items:z.array(z.object({quantity:z.literal(1),price:z.object({id:z.string()})})).length(1),
});

/** One fixed sandbox POST; never bills/invoices/charges or retries an unknown outcome.
 * No arbitrary URL, amount, customer identity or checkout success claim accepted. */
export async function createSandboxCheckout(offer:SandboxOffer,intentId:string,env=process.env,request:typeof fetch=fetch):Promise<CheckoutBinding> {
  const canonical=sandboxOffer(offer.code,env.PADDLE_ENVIRONMENT);
  if(canonical.priceId!==offer.priceId || !z.uuid().safeParse(intentId).success || !env.PADDLE_API_KEY
    || env.SIGMAROUND_ACCOUNT_ORIGIN!=='https://cluera-ai-staging.vercel.app'
    || env.NEXT_PUBLIC_SUPABASE_URL!=='https://dwqltsqumiwsxtkzdoaa.supabase.co'
    || env.SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF!=='dwqltsqumiwsxtkzdoaa') throw new CheckoutTransportError('configuration');
  let stage:'request'|'http'|'body'|'schema'|'binding'='request';
  let status:number|undefined;
  try {
    const response=await request('https://sandbox-api.paddle.com/transactions',{
      method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${env.PADDLE_API_KEY}`,'Paddle-Version':'1','Content-Type':'application/json'},
      body:JSON.stringify({items:[{price_id:canonical.priceId,quantity:1}],currency_code:'INR',collection_mode:'automatic',
        custom_data:{sigma_checkout_intent:intentId},checkout:{url:`${env.SIGMAROUND_ACCOUNT_ORIGIN}/account/checkout`}}),
    });
    status=response.status;stage=response.ok?'body':'http';
    if(!response.body) throw new CheckoutTransportError(stage,status);
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try {
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>256*1024)throw new CheckoutTransportError(stage,status);chunks.push(value);}
    } finally {await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!response.ok) throw new CheckoutTransportError('http',status,envelope?.error?.code,envelope?.meta?.request_id);
    stage='schema';
    const data=draft.parse(envelope.data);
    stage='binding';
    if(data.custom_data.sigma_checkout_intent!==intentId || data.items[0].price.id!==canonical.priceId) throw new CheckoutTransportError(stage,status);
    return {transactionId:data.id}; // Never forward raw response, metadata, payer data or URLs.
  } catch(error) {throw error instanceof CheckoutTransportError?error:new CheckoutTransportError(stage,status);}
}
