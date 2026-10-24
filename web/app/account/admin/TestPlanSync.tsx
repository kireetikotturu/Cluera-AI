'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { checkoutRequest } from '../../../lib/payments/cluera/checkoutRequest';
import { revisionSchema, type Revision } from '../../../lib/payments/cluera/contracts';
import { testPlanInput, testPlanOperation, type TestPlanOperation } from '../../../lib/payments/cluera/planSyncContracts';
import { clueraPrice, clueraAllowance, clueraPublicRevision } from '../../../lib/payments/cluera/publicCatalog';

const endpoint='/api/account/payments/cluera/admin';
const readSchema=z.object({code:z.literal('ACTIVE'),catalog:z.array(revisionSchema).max(4),operations:z.array(testPlanOperation).max(3)}).strict();
const factorsSchema=z.object({factors:z.array(z.object({id:z.uuid(),status:z.literal('verified')}).strict()).max(20)}).strict();
const appliedSchema=z.object({code:z.literal('APPLIED'),revision:clueraPublicRevision}).strict();

/** Explicit owner actions only. Reload discovers unresolved operations in the database. */
export function TestPlanSync({disabled=false}:{disabled?:boolean}) {
  const [catalog,setCatalog]=useState<Revision[]>([]),[operations,setOperations]=useState<TestPlanOperation[]>([]);
  const [factors,setFactors]=useState<string[]>([]),[busy,setBusy]=useState(false),[ready,setReady]=useState(false);
  const [notices,setNotices]=useState<Record<string,string>>({});
  const [message,setMessage]=useState('Create and map monthly Razorpay Test plans here after reviewing their price and allowance. Plans cannot be edited or deleted at Razorpay.');
  const report=(value:string,offer?:string)=>{setMessage(value);if(offer)setNotices(previous=>({...previous,[offer]:value}));};
  const alive=useRef(false),locked=useRef(false),epoch=useRef(0),disabledRef=useRef(disabled),controller=useRef<AbortController|null>(null);
  const unknown=useRef<TestPlanOperation|null>(null);
  disabledRef.current=disabled;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;controller.current?.abort();};},[]);
  useEffect(()=>{if(disabled){epoch.current++;controller.current?.abort();unknown.current=null;setReady(false);setCatalog([]);setOperations([]);setFactors([]);setNotices({});}},[disabled]);
  const run=async(work:(signal:AbortSignal,current:()=>boolean)=>Promise<void>,offer?:string)=>{
    if(locked.current||disabledRef.current)return;
    locked.current=true;setBusy(true);const abort=new AbortController(),generation=epoch.current;controller.current=abort;
    const current=()=>alive.current&&!disabledRef.current&&!abort.signal.aborted&&generation===epoch.current;
    try{await work(abort.signal,current);}catch{if(current()){setReady(false);report('The result is unconfirmed. Refresh Test plan sync to inspect the saved operation. Do not create another plan.',offer);}}
    finally{locked.current=false;if(controller.current===abort)controller.current=null;if(alive.current)setBusy(false);}
  };
  const refresh=()=>run(async(signal,current)=>{
    setReady(false);
    const response=await checkoutRequest(`${endpoint}?plans=1`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
    if(!current())return;
    if(!response.ok){setCatalog([]);setFactors([]);setMessage('Test plan sync requires the installed schema and an active Admin session with MFA.');return;}
    const data=readSchema.parse(await response.json());
    if(!current())return;
    setCatalog(data.catalog.filter(row=>row.kind==='RECURRING'));
    // A missing operation after a lost response is not proof that the original request stopped.
    const unresolved=[...data.operations];
    if(unknown.current&&!unresolved.some(op=>op.operationId===unknown.current!.operationId))unresolved.push(unknown.current);
    setOperations(unresolved);
    const auth=await checkoutRequest(`${endpoint}?factors=1`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
    if(!current())return;if(!auth.ok)throw Error();
    const verified=factorsSchema.parse(await auth.json());if(!current())return;
    setFactors(verified.factors.map(factor=>factor.id));setReady(true);
    setMessage(unresolved.length?'An earlier plan operation needs review. Reconcile that operation with fresh MFA; recovery never creates a plan.':'Test catalog loaded. Creation saves a verified mapping in a disabled future revision.');
  });
  const submit=(row:Revision,form:HTMLFormElement,op?:TestPlanOperation)=>{
    if(disabledRef.current||locked.current||!ready||!factors.length)return;
    const notice=(value:string)=>report(value,row.offerCode);
    const values=new FormData(form),factorId=String(values.get('factor')),code=String(values.get('code'));
    if(!factors.includes(factorId)||!/^\d{6}$/.test(code)){notice('Choose an existing authenticator and enter its fresh six-digit code.');return;}
    let body:Record<string,unknown>,saved=op;
    if(op){const candidate=String(values.get('plan')??'').trim();if(candidate&&!/^plan_[A-Za-z0-9]{8,64}$/.test(candidate)){notice('Enter the original Test plan ID, or leave it empty to use the saved ID.');return;}
      body={action:'RECONCILE_TEST_PLAN',operationId:op.operationId,factorId,code,input:{razorpayPlanId:candidate||null}};
    }else{
      if(unknown.current||operations.some(value=>value.offerCode===row.offerCode))return;
      const price=String(values.get('price')).trim(),[whole,decimals='']=price.split('.');
      const input=testPlanInput.safeParse({name:String(values.get('name')).trim(),amountPaise:Number(whole)*100+Number(decimals.padEnd(2,'0')),
        allowanceSeconds:Number(values.get('minutes'))*60,totalCount:Number(values.get('totalCount'))});
      const reason=String(values.get('reason')).trim();
      if(!/^\d{1,6}(?:\.\d{1,2})?$/.test(price)||!input.success||reason.length<10||reason.length>500){notice('Check the price, allowance, charge count and reason before creating the Test plan.');return;}
      if(row.razorpayPlanId&&row.name===input.data.name&&row.amountPaise===input.data.amountPaise&&row.allowanceSeconds===input.data.allowanceSeconds&&row.totalCount===input.data.totalCount){notice('These terms already have a mapped Test plan. No duplicate was created.');return;}
      saved={operationId:crypto.randomUUID(),offerCode:row.offerCode,expectedRevisionId:row.revisionId,state:'CLAIMED',input:input.data,reason,razorpayPlanId:null};
      unknown.current=saved;setOperations(previous=>[...previous,saved!]);
      body={action:'CREATE_TEST_PLAN',operationId:saved.operationId,offerCode:row.offerCode,expectedRevisionId:row.revisionId,reason,input:input.data,factorId,code};
    }
    void run(async(signal,current)=>{
      const codeField=form.elements.namedItem('code');if(codeField instanceof HTMLInputElement)codeField.value='';
      notice(op?'Checking the original Test plan and completing its mapping…':'Creating the Test plan and verifying its saved mapping…');
      const response=await checkoutRequest(endpoint,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal,
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!current())return;
      if(!response.ok){
        setReady(false);
        if(!op&&[400,401,403,429].includes(response.status)){
          unknown.current=null;setOperations(previous=>previous.filter(value=>value.operationId!==saved!.operationId));
          notice(response.status===401||response.status===403
            ?'Admin authorization or authenticator verification was rejected. No plan was created by this request. Refresh Test plan sync and use a fresh code.'
            :response.status===429?'Too many Admin requests. No plan was created by this request. Wait before refreshing Test plan sync.'
            :'The submitted plan details were rejected. No plan was created by this request. Refresh Test plan sync and review the form.');return;
        }
        notice('The operation is not confirmed. Refresh and reconcile the original operation; do not create a replacement.');return;
      }
      const raw=await response.json();if(!current())return;
      if(!op&&(raw as {code?:unknown})?.code==='NOT_CREATED'){
        unknown.current=null;setOperations(previous=>previous.filter(value=>value.operationId!==saved!.operationId));setReady(false);
        notice('No plan was created. Refresh the current catalog before reviewing another change.');return;
      }
      if((raw as {code?:unknown})?.code!=='APPLIED'){setReady(false);notice('The original plan operation is still pending. Refresh to inspect its saved ID, then reconcile with fresh MFA.');return;}
      const result=appliedSchema.parse(raw);
      if(result.revision.offerCode!==row.offerCode||result.revision.enabled)throw Error();
      if(unknown.current?.operationId===saved!.operationId)unknown.current=null;
      setOperations(previous=>previous.filter(value=>value.operationId!==saved!.operationId));setReady(false);
      notice('Test plan mapped and verified. Subscription checkout is still disabled. Loading the saved plan ID…');
      // Confirmation is already authoritative. Failure of this read cannot turn it into an unknown write.
      try{
        const read=await checkoutRequest(`${endpoint}?plans=1`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
        if(!current())return;if(!read.ok)throw Error();
        const data=readSchema.parse(await read.json());if(!current())return;
        const mapped=data.catalog.find(value=>value.revisionId===result.revision.revisionId&&value.offerCode===row.offerCode);
        if(!mapped?.razorpayPlanId||!mapped.testPlanValidated)throw Error();
        setCatalog(data.catalog.filter(value=>value.kind==='RECURRING'));setOperations(data.operations);setReady(true);
        notice('Test plan mapped and verified. Its saved ID is shown above. Subscription acceptance and activation are separate.');
      }catch{if(current())notice('Mapping succeeded, but the updated catalog could not be loaded. Refresh Test plan sync to see its saved ID. Do not create this plan again.');}
    },row.offerCode);
  };
  return <section className="ai-provider-console" aria-label="Razorpay Test plan synchronization" aria-busy={busy}>
    <h2>Razorpay Test plan sync</h2><p role="status">{message}</p>
    <button type="button" disabled={disabled||busy} onClick={()=>void refresh()}>Refresh Test plan sync</button>
    {catalog.map(row=>{const op=operations.find(value=>value.offerCode===row.offerCode);const form=<form key={op?.operationId??row.revisionId} onSubmit={event=>{event.preventDefault();submit(row,event.currentTarget,op);}}>
        <fieldset disabled={disabled||busy||!ready||!factors.length||(!op&&!!unknown.current)}>
          <legend>{op?'Recover the original Test plan':row.razorpayPlanId?'Create a new monthly Test plan revision':'Create a monthly Test plan and mapping'}</legend>
          {op?<label>Original Test plan ID (optional if saved)<input name="plan" defaultValue={op.razorpayPlanId??''} maxLength={69} autoComplete="off"/></label>:<>
            <label>Plan name<input name="name" defaultValue={row.name} minLength={2} maxLength={80} required/></label>
            <label>Monthly price (INR)<input name="price" defaultValue={(row.amountPaise/100).toFixed(2)} inputMode="decimal" required/></label>
            <label>Monthly allowance (minutes)<input name="minutes" type="number" min={1} max={60000} step={1} defaultValue={row.allowanceSeconds/60} required/></label>
            <label>Maximum charges<input name="totalCount" type="number" min={1} max={120} step={1} defaultValue={row.totalCount??120} required/></label>
            <label>Reason<textarea name="reason" minLength={10} maxLength={500} required/></label>
          </>}
          <label>Verified authenticator<select key={factors.join(',')} name="factor" defaultValue={factors.length===1?factors[0]:''} required><option value="">Choose authenticator</option>{factors.map((id,index)=><option key={id} value={id}>Authenticator {index+1}</option>)}</select></label>
          <label>Fresh six-digit code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></label>
          <p>The code clears when the request is sent. Check the result below before taking another action.</p>
          <button type="submit">{op?'Reconcile original Test plan':row.razorpayPlanId?'Create new Test plan revision':'Create Test plan and map'}</button>
        </fieldset>
      </form>;return <article className="ai-provider-card" key={row.offerCode}>
      <h3>{row.name}</h3><p>{clueraPrice(row.amountPaise)} / month · {clueraAllowance(row.allowanceSeconds)}</p>
      <p>Mapped Test plan: {row.razorpayPlanId??'None'}</p>
      {row.razorpayPlanId?<p>{row.testPlanValidated?'Plan verified and mapped. You do not need to create it again.':'The saved plan mapping still needs verification.'} {row.enabled?'The catalog is enabled; checkout still requires the other Test gates.':'Subscription checkout is still disabled; mapping a plan does not activate sales.'}</p>:null}
      {op?<p>Unresolved operation: {op.operationId}. Saved plan: {op.razorpayPlanId??'Not yet confirmed'}. Review the original plan in Razorpay Test if its ID is missing.</p>:null}
      {row.razorpayPlanId&&!op?<details key={row.revisionId}><summary>Create a new revision with changed terms</summary>{form}</details>:form}
      <p role="status" aria-atomic="true">{notices[row.offerCode]??''}</p>
    </article>;})}
    <p>Plan synchronization creates templates only. Payment collection, monthly availability and Live remain controlled separately.</p>
  </section>;
}
