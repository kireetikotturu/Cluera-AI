import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {accountConfig} from '../lib/accounts/config';
import * as paymentConfig from '../lib/payments/core/config';
import {GET,POST} from '../app/api/account/payments/checkout/route';
import {paymentTestEnvironment} from './helpers/paymentTestMode';

const mocks=vi.hoisted(()=>({config:vi.fn(),clients:vi.fn(),session:vi.fn(),limit:vi.fn(),
  create:vi.fn(),status:vi.fn(),callback:vi.fn(),rpc:vi.fn()}));
vi.mock('../lib/accounts/workspace',()=>({stagingAccountConfig:mocks.config}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
vi.mock('../lib/accounts/handler',async original=>({...await original<typeof import('../lib/accounts/handler')>(),
  activeSession:mocks.session,rateLimit:mocks.limit}));
vi.mock('../lib/payments/checkout/service',()=>({createPaymentOrder:mocks.create,paymentStatus:mocks.status,
  verifyPaymentCallback:mocks.callback}));
const origin='https://cluera-ai-staging.vercel.app',uid=paymentTestEnvironment.SIGMAROUND_PAYMENT_TESTER_IDS;
const sid='00000000-0000-4000-8000-000000000812',requestId='00000000-0000-4000-8000-000000000813';
const account={userId:uid,sessionId:sid,email:'synthetic@example.invalid'};
const create={action:'CREATE',expectedAccountId:uid,requestId,offerCode:'pro_3_hours',provider:'razorpay'};
const callback={action:'VERIFY_CALLBACK',expectedAccountId:uid,orderId:'order_synthetic0001',
  paymentId:'pay_synthetic0001',signature:'a'.repeat(64)};
const endpoint=origin+'/api/account/payments/checkout';
const request=(method:'GET'|'POST',body:typeof create|typeof callback,includeAction=false)=>method==='GET'
  ?new Request(endpoint+'?expectedAccountId='+uid+(includeAction?'&action='+body.action:''))
  :new Request(endpoint,{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{
  vi.resetAllMocks();
  for(const [key,value] of Object.entries({...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',
    NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',
    SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),
    SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(key,value);
  mocks.config.mockImplementation(()=>accountConfig());
  mocks.clients.mockReturnValue({service:{rpc:mocks.rpc}});
  mocks.session.mockResolvedValue({account,session:{access_token:'synthetic-access',refresh_token:'synthetic-refresh'}});
  mocks.limit.mockResolvedValue(undefined);
  mocks.status.mockResolvedValue({code:'AVAILABLE',userId:uid,pending:null,resolvedOrderIds:[],history:[]});
  mocks.create.mockResolvedValue({code:'BOUND',orderId:create.requestId});
  mocks.callback.mockResolvedValue({code:'AWAITING_WEBHOOK'});
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real network');}));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});

for(const method of ['GET','POST'] as const)for(const body of [create,callback])
  it(`V2 closes legacy ${method} ${body.action} before all dependencies`,async()=>{
    const enabled=vi.spyOn(paymentConfig,'razorpayCheckoutEnabled'),allowed=vi.spyOn(paymentConfig,'razorpayCheckoutAllowed');
    const response=await (method==='GET'?GET:POST)(request(method,body,true));
    expect(response.status).toBe(404);expect(await response.json()).toEqual({error:'Not found.'});
    expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    for(const dependency of [enabled,allowed,mocks.config,mocks.clients,mocks.session,mocks.limit,
      mocks.create,mocks.status,mocks.callback,mocks.rpc,fetch])expect(dependency).not.toHaveBeenCalled();
  });

it('V2 false preserves the authenticated owned legacy GET status path',async()=>{
  vi.stubEnv('CLUERA_BILLING_V2_ENABLED','false');
  const response=await GET(request('GET',create));
  expect(response.status).toBe(200);expect(mocks.status).toHaveBeenCalledWith(expect.any(Function),account);
  expect(mocks.session).toHaveBeenCalledOnce();expect(mocks.limit).toHaveBeenCalledOnce();
  expect(mocks.create).not.toHaveBeenCalled();expect(mocks.callback).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it.each([create,callback])('V2 false preserves the legacy $action service selection',async body=>{
  vi.stubEnv('CLUERA_BILLING_V2_ENABLED','false');
  const response=await POST(request('POST',body));expect(response.status).toBe(200);
  expect(mocks.session).toHaveBeenCalledOnce();expect(mocks.limit).toHaveBeenCalledOnce();
  if(body.action==='CREATE'){
    expect(mocks.create).toHaveBeenCalledWith(expect.any(Function),account,requestId);expect(mocks.callback).not.toHaveBeenCalled();
  }else{
    expect(mocks.callback).toHaveBeenCalledWith(expect.any(Function),account,body);expect(mocks.create).not.toHaveBeenCalled();
  }
  expect(mocks.status).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();expect(mocks.rpc).not.toHaveBeenCalled();
});
