import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {describe,it} from 'vitest';

/** Isolated synthetic staging fixture ONLY. No Paddle network/API, checkout,
 * simulation conversion, payment, or real customer account is used. */
describe.skipIf(process.env.SIGMAROUND_RUN_RECURRING_ACCEPTANCE!=='true')('staging concurrent financial lifecycle',()=>{
  it('serializes renewal, refund, cancellation, queue and usage across real database connections',async()=>{
    const env=process.env;
    function check(v:unknown,message:string):asserts v{if(!v)throw new Error(`Recurring acceptance: ${message}`);}
    check(env.NEXT_PUBLIC_SUPABASE_URL==='https://dwqltsqumiwsxtkzdoaa.supabase.co'
      &&env.SIGMAROUND_ACCOUNT_ORIGIN==='https://cluera-ai-staging.vercel.app'&&env.SUPABASE_SERVICE_ROLE_KEY,'wrong target');
    const user=env.SIGMAROUND_RECURRING_FIXTURE_USER,session=env.SIGMAROUND_RECURRING_FIXTURE_SESSION;
    check(user&&session&&/^[a-f0-9-]{36}$/.test(user)&&/^[a-f0-9-]{36}$/.test(session),'fixture missing');
    const client=createClient(env.NEXT_PUBLIC_SUPABASE_URL!,env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const call=async(name:string,args:Record<string,unknown>={})=>{
      const r=await client.rpc(name,args);check(!r.error,'RPC failed; details withheld');return r.data;
    };
    const id=(p:string,n:number)=>`${p}_${user.replaceAll('-','').slice(0,24)}${String(n).padStart(2,'0')}`;
    const day=86400000,now=Date.now(),customer=id('ctm',0);
    const purchase=(n:number,offer='pro_40_hours',start=now-10000,sub=n)=>({action:'GRANT',transactionId:id('txn',n),subscriptionId:id('sub',sub),
      customerId:customer,offerCode:offer,state:'ACTIVE',cancelFuture:false,observedAt:new Date(now).toISOString(),
      periodStart:new Date(start).toISOString(),periodEnd:new Date(start+(offer==='enterprise_weekly'?7:30)*day).toISOString()});
    const intent=async(n:number,offer:string)=>{
      const r=await call('customer_checkout_prepare',{p_user_id:user,p_session_id:session,p_request_id:randomUUID(),p_offer_code:offer});
      check(r.code==='CLAIMED','checkout claim');
      check(await call('customer_checkout_complete',{p_intent_id:r.intentId,p_attempt_id:r.attemptId,p_transaction_id:id('txn',n),p_state:'BOUND'})==='BOUND','binding');
    };
    const event=async(n:number,v:ReturnType<typeof purchase>&{adjustmentId?:string})=>{
      check(await call('paddle_sandbox_receive',{p_event_id:id('evt',n),p_event_type:v.action==='GRANT'?'transaction.completed':
        v.action==='REFUND'?'adjustment.updated':'subscription.updated',p_occurred_at:new Date().toISOString(),
        p_resource_id:v.action==='GRANT'?v.transactionId:v.action==='REFUND'?v.adjustmentId:v.subscriptionId,p_event_digest:'c'.repeat(64)})==='STORED','event');
      return id('evt',n);
    };
    const claim=(e:string)=>call('customer_billing_claim',{p_event_id:e});
    const apply=(j:any,v:object)=>call('customer_billing_apply_recurring',{p_event_id:j.eventId,p_claim_id:j.claimId,p_event_digest:j.eventDigest,p_evidence:v});
    const balance=()=>call('customer_usage_balance',{p_user_id:user,p_session_id:session});
    const command=(run:string,sequence:number,action:string)=>call('customer_usage_command',{p_user_id:user,p_session_id:session,p_run_id:run,p_sequence:sequence,p_action:action});

    const first=purchase(1,'pro_40_hours',now-30*day-10000);await intent(1,first.offerCode);
    const e=await event(1,first),claims=await Promise.all([claim(e),claim(e)]);
    check(claims.filter(c=>c.code==='CLAIMED').length===1&&claims.filter(c=>c.code==='EMPTY').length===1,'exclusive claim');
    const j=claims.find(c=>c.code==='CLAIMED');const duplicate=await Promise.all([apply(j,first),apply(j,first)]);
    check(duplicate.filter(x=>x.code==='APPLIED').length===1&&duplicate.filter(x=>x.code==='STALE').length===1,'fenced duplicate');
    check((await balance()).availableMilliseconds===900000,'expired term does not roll over');

    const renew=purchase(2,'pro_40_hours',Date.parse(first.periodEnd),1),refundOld={...first,action:'REFUND',adjustmentId:id('adj',3)};
    const jr=await claim(await event(2,renew)),jf=await claim(await event(3,refundOld)),run=randomUUID();
    const renewalRace=await Promise.all([apply(jr,renew),apply(jf,refundOld),command(run,0,'START')]);
    check(renewalRace[0].code==='APPLIED'&&renewalRace[1].code==='APPLIED'&&renewalRace[2].code==='ACTIVE','renewal/refund/usage race');
    check(['CLOSED','DENIED'].includes((await command(run,1,'STOP')).code),'usage stop');
    let b=await balance();check(b.reservedMilliseconds===0&&b.availableMilliseconds>144850000&&b.availableMilliseconds<=144900000,'new allowance exact, no rollover');

    const ent=purchase(3,'enterprise_weekly');await intent(3,ent.offerCode);check((await apply(await claim(await event(4,ent)),ent)).code==='APPLIED','enterprise upgrade');
    b=await balance();check(b.availableMilliseconds>108850000&&b.availableMilliseconds<=108900000,'Pro is paused');
    const canceled={...ent,action:'STATUS',state:'CANCELED',cancelFuture:true,observedAt:new Date(now+1000).toISOString()};
    const jc=await claim(await event(5,canceled)),run2=randomUUID();
    const cancelRace=await Promise.all([apply(jc,canceled),command(run2,0,'START')]);
    check(cancelRace[0].code==='APPLIED'&&cancelRace[1].code==='ACTIVE','cancellation preserves paid term');
    const refund={...ent,action:'REFUND',adjustmentId:id('adj',6)};const je=await claim(await event(6,refund));
    const refundRace=await Promise.all([apply(je,refund),apply(je,refund),command(run2,1,'STOP')]);
    check(refundRace.filter(x=>x.code==='APPLIED').length===1&&refundRace.some(x=>x.code==='STALE'),'one refund application');
    b=await balance();check(b.reservedMilliseconds===0&&b.availableMilliseconds>144850000&&b.availableMilliseconds<=144900000,'original Pro grant resumes');

    const queued=purchase(4);await intent(4,queued.offerCode);await apply(await claim(await event(7,queued)),queued);
    b=await balance();check(b.availableMilliseconds<=144900000,'queued plan cannot be spent early');
    const refundPro={...renew,action:'REFUND',adjustmentId:id('adj',8)},jp=await claim(await event(8,refundPro)),run3=randomUUID();
    const queueRace=await Promise.all([apply(jp,refundPro),command(run3,0,'START')]);
    check(queueRace[0].code==='APPLIED'&&queueRace[1].code==='ACTIVE','queue activation/refund/usage race');
    check(['CLOSED','DENIED'].includes((await command(run3,1,'STOP')).code),'final stop');
    b=await balance();check(b.reservedMilliseconds===0&&b.availableMilliseconds>144850000&&b.availableMilliseconds<=144900000,'queue/refund conservation');
    console.info('Recurring acceptance passed: exclusive claims, fenced duplicate apply, concurrent renewal/refund/usage, cancellation/usage, Enterprise pause/refund/resume and queued-plan/refund races. No Paddle calls.');
  },90000);
});
