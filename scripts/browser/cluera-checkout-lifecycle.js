// Run with the Playwright browser_run_code tool against canonical staging.
// Every account/payment API and the Checkout SDK are intercepted. No real login,
// provider payment, order creation, cancellation or credit grant is performed.
async (page) => {
 const context=await page.context().browser().newContext({viewport:{width:390,height:844}});
 const tab=await context.newPage(),calls=[],errors=[],reports=[];
 const userId='00000000-0000-4000-8000-000000000801',revisionId='00000000-0000-4000-8000-000000000821',orderId='order_synthetic0001';
 const pack={revisionId,offerCode:'cluera_pack_3h_v2',name:'Cluera 3 Hours',version:1,amountPaise:54900,currency:'INR',allowanceSeconds:10800,kind:'PACK',interval:null,totalCount:null,testPlanValidated:true,enabled:true};
 let hold=false,release,attempted=false,throttled=false,failSdk=false;
 tab.on('pageerror',error=>errors.push(error.message));
 await tab.clock.install();
 await context.route('https://checkout.razorpay.com/**',route=>failSdk?route.abort():route.fulfill({contentType:'application/javascript',body:'window.Razorpay=class {constructor(o){window.syntheticCheckout=o;}open(){window.syntheticOpened=(window.syntheticOpened||0)+1;}close(){window.syntheticClosed=(window.syntheticClosed||0)+1;}on(){}};'}));
 await context.route('**/api/account/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;calls.push({path,method:request.method()});
  if(request.method()!=='GET'){await route.abort();errors.push('Unexpected write');return;}
  let body,status=200;
  if(path==='/api/account/credits'){
   body={userId,displayName:'Synthetic verified customer',availableMilliseconds:900000,payments:[],plans:[]};
   if(hold){hold=false;await new Promise(resolve=>{release=resolve;});body={...body,userId:revisionId,displayName:'Foreign stale account'};}
  }else if(path.endsWith('/catalog'))body={catalog:[pack,...[40,100,200].map((hours,index)=>({...pack,revisionId:'00000000-0000-4000-8000-00000000082'+(index+2),offerCode:'cluera_monthly_'+hours+'h_v2',name:'Cluera '+hours+' Hours',amountPaise:[549900,959900,1954900][index],allowanceSeconds:hours*3600,kind:'RECURRING',interval:'MONTH',totalCount:120,enabled:false,testPlanValidated:false}))]};
  else if(path.endsWith('/history'))body={history:{code:'ACTIVE',userId,payments:[],subscriptions:[],hasMorePayments:false,hasMoreSubscriptions:false}};
  else if(path.endsWith('/resume')){
   status=throttled?429:attempted?409:200;
   body=status===200?{payment:{code:'BOUND',kind:'PACK',orderId,subscriptionId:null,keyId:'rzp_test_synthetic123456',amountPaise:54900,currency:'INR',revisionId,offerCode:pack.offerCode}}:{error:'PRIVATE_DO_NOT_REFLECT'};
  }else if(path.endsWith('/checkout'))body={payment:{userId,code:'PENDING',pending:{legacy:false,intentId:'00000000-0000-4000-8000-000000000811',state:'BOUND',kind:'PACK',revisionId,offerCode:pack.offerCode,orderId,subscriptionId:null},resolvedOrderIds:[],resolvedSubscriptionIds:[]}};
  else {await route.abort();return;}
  await route.fulfill({status,contentType:'application/json',headers:{'cache-control':'no-store','x-content-type-options':'nosniff',...(status===429?{'retry-after':'7'}:{})},body:JSON.stringify(body)}).catch(()=>{});
 });
 const resume=()=>tab.getByRole('button',{name:'Continue existing checkout',exact:true});
 const refresh=()=>tab.getByRole('button',{name:'Refresh billing status',exact:true});
 const go=async()=>{await tab.goto('https://cluera-ai-staging.vercel.app/account/checkout?offer=cluera_pack_3h_v2');await resume().waitFor();};
 const check=async(name)=>{
  if(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Horizontal overflow: '+name);
  const body=await tab.locator('body').innerText();if(body.includes('PRIVATE_DO_NOT_REFLECT')||body.includes('Foreign stale account'))throw Error('Unsafe response: '+name);
  if(await tab.locator('button[data-checkout-action="purchase"]:not(:disabled)').count())throw Error('Replacement purchase enabled: '+name);
  reports.push({name,passed:true});
 };
 try{
  await go();hold=true;await refresh().click();await tab.waitForFunction(()=>document.body.innerText.includes('Refreshing payment status'));
  if(!await resume().isEnabled())throw Error('Continuation blocked by background read');
  await tab.getByRole('button',{name:'Continue payment: Cluera 3 Hours',exact:true}).click();await tab.waitForFunction(()=>window.syntheticOpened===1);release();
  if(new URL(tab.url()).search!=='?offer=cluera_pack_3h_v2')throw Error('Popup discarded selected-plan URL');
  const options=await tab.evaluate(()=>({order:window.syntheticCheckout.order_id,timeout:window.syntheticCheckout.timeout,retry:window.syntheticCheckout.retry.enabled}));
  if(options.order!==orderId||options.timeout!==600||options.retry!==false)throw Error('Wrong SDK binding/window');
  if(await tab.locator('button[data-offer-code]').filter({hasText:'Checkout unavailable'}).count())throw Error('Generic unavailable label returned');
  await check('slow background read superseded; exact original order opened');
  await tab.evaluate(()=>window.syntheticCheckout.modal.ondismiss());await resume().waitFor();
  await resume().click();await tab.waitForFunction(()=>window.syntheticOpened===2);await check('closed original order revalidated and deliberately reopened');
  await tab.clock.fastForward(600000);await tab.getByRole('status').filter({hasText:'Your order was not canceled'}).waitFor();await resume().waitFor();
  await check('ten-minute expiry reconciles without cancellation or replacement');
  await resume().click();await tab.waitForFunction(()=>window.syntheticOpened===3);attempted=true;
  await tab.evaluate(()=>window.syntheticCheckout.modal.ondismiss());await tab.getByRole('status').filter({hasText:'existing payment or order'}).waitFor();
  if(await resume().count())throw Error('Attempted order offered as untouched');await check('attempted order stays locked');
  attempted=false;failSdk=true;await go();await resume().click();await tab.waitForFunction(()=>!document.querySelector('script[src*="checkout.razorpay"]'));
  await resume().waitFor();failSdk=false;await resume().click();await tab.waitForFunction(()=>window.syntheticOpened===1);await check('SDK failure safely recovers same order');
  await go();throttled=true;await resume().click();await tab.getByRole('status').filter({hasText:'Please wait 7s'}).waitFor();
  if(await refresh().isEnabled())throw Error('Throttle ignored');await tab.clock.fastForward(7000);throttled=false;
  await refresh().click();await resume().waitFor();await check('retry delay preserves identity and original order');
  await tab.setViewportSize({width:1440,height:1000});await check('desktop layout');
  const width=await tab.locator('main').evaluate(element=>element.getBoundingClientRect().width);
  if(width<1000)throw Error('Billing still uses narrow sign-in container');
  if(errors.length)throw Error(JSON.stringify(errors));
  return {reports,options,financialWrites:calls.filter(call=>call.method!=='GET').length,resumeReads:calls.filter(call=>call.path.endsWith('/resume')).length,errors,actualCustomerSession:false};
 }finally{release?.();await context.close();}
}
