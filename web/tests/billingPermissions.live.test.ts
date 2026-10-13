import {describe,it} from 'vitest';
describe.skipIf(process.env.SIGMAROUND_RUN_BILLING_PERMISSION_CHECK!=='true')('private staging billing capability check',()=>{
  it('reports only status codes, never raw Paddle resources, keys or customer data',async()=>{
    const env=process.env;
    if(env.PADDLE_ENVIRONMENT!=='sandbox'||env.SIGMAROUND_ACCOUNT_ORIGIN!=='https://cluera-ai-staging.vercel.app'
      ||env.NEXT_PUBLIC_SUPABASE_URL!=='https://dwqltsqumiwsxtkzdoaa.supabase.co'||!env.PADDLE_API_KEY) throw new Error('Wrong staging target/config');
    // Syntactically valid nonexistent IDs avoid fetching existing customer records.
    const zero='0'.repeat(26);
    for(const [resource,prefix] of [['customers','ctm'],['subscriptions','sub'],['adjustments','adj']]){
      const response=await fetch(`https://sandbox-api.paddle.com/${resource}/${prefix}_${zero}`,{
        redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000),
        headers:{Authorization:`Bearer ${env.PADDLE_API_KEY}`,'Paddle-Version':'1'},
      });
      await response.body?.cancel();
      console.info(`Billing permissions: ${resource}.read HTTP ${response.status}`);
      if(![403,404].includes(response.status)) throw new Error('Unexpected permission probe status; details withheld');
    }
    // Deliberately invalid empty items: schema requires at least one. No charge,
    // customer or valid transaction is requested. A 403 proves missing permission;
    // a 400 is only validation evidence, not full checkout acceptance.
    const response=await fetch('https://sandbox-api.paddle.com/transactions',{
      method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${env.PADDLE_API_KEY}`,'Paddle-Version':'1','Content-Type':'application/json'},
      body:JSON.stringify({items:[],collection_mode:'automatic'}),
    });
    await response.body?.cancel();console.info(`Billing permissions: transaction.write invalid-request HTTP ${response.status}`);
    if(![400,403].includes(response.status)) throw new Error('Unexpected create-probe status; no payload logged');
    console.info(`Billing permissions: sandbox public checkout token configured ${/^test_[A-Za-z0-9]+$/.test(env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN??'')}`);
  },60000);
});
