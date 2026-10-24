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
  const [message,setMessage]=useState('Create and map monthly Razorpay Test plans here after reviewing their price and allowance. Plans cannot be edited or deleted at Razorpay.');
  const alive=useRef(false),locked=useRef(false),epoch=useRef(0),disabledRef=useRef(disabled),controller=useRef<AbortController|null>(null);
  const unknown=useRef<TestPlanOperation|null>(null);
  disabledRef.current=disabled;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;controller.current?.abort();};},[]);
  useEffect(()=>{if(disabled){epoch.current++;controller.current?.abort();unknown.current=null;setReady(false);setCatalog([]);setOperations([]);setFactors([]);}},[disabled]);
  const run=async(work:(signal:AbortSignal,current:()=>boolean)=>Promise<void>)=>{
    if(locked.current||disabledRef.current)return;
    locked.current=true;setBusy(true);const abort=new AbortController(),generation=epoch.current;controller.current=abort;
    const current=()=>alive.current&&!disabledRef.current&&!abort.signal.aborted&&generation===epoch.current;
    try{await work(abort.signal,current);}catch{if(current()){setReady(false);setMessage('The result is unconfirmed. Refresh Test plan sync to inspect the saved operation. Do not create another plan.');}}
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
    const values=new FormData(form),factorId=String(values.get('factor')),code=String(values.get('code'));
    const codeField=form.elements.namedItem('code');if(codeField instanceof HTMLInputElement)codeField.value='';
    if(!factors.includes(factorId)||!/^\d{6}$/.test(code)){setMessage('Choose an existing authenticator and enter its fresh six-digit code.');return;}
    let body:Record<string,unknown>,saved=op;
    if(op){const candidate=String(values.get('plan')??'').trim();if(candidate&&!/^plan_[A-Za-z0-9]{8,64}$/.test(candidate)){setMessage('Enter the original Test plan ID, or leave it empty to use the saved ID.');return;}
      body={action:'RECONCILE_TEST_PLAN',operationId:op.operationId,factorId,code,input:{razorpayPlanId:candidate||null}};
    }else{
      if(unknown.current||operations.some(value=>value.offerCode===row.offerCode))return;
      const price=String(values.get('price')).trim(),[whole,decimals='']=price.split('.');
      const input=testPlanInput.safeParse({name:String(values.get('name')).trim(),amountPaise:Number(whole)*100+Number(decimals.padEnd(2,'0')),
        allowanceSeconds:Number(values.get('minutes'))*60,totalCount:Number(values.get('totalCount'))});
      const reason=String(values.get('reason')).trim();
      if(!/^\d{1,6}(?:\.\d{1,2})?$/.test(price)||!input.success||reason.length<10||reason.length>500){setMessage('Check the price, allowance, charge count and reason before creating the Test plan.');return;}
      if(row.razorpayPlanId&&row.name===input.data.name&&row.amountPaise===input.data.amountPaise&&row.allowanceSeconds===input.data.allowanceSeconds&&row.totalCount===input.data.totalCount){setMessage('These terms already have a mapped Test plan. No duplicate was created.');return;}
      saved={operationId:crypto.randomUUID(),offerCode:row.offerCode,expectedRevisionId:row.revisionId,state:'CLAIMED',input:input.data,reason,razorpayPlanId:null};
      unknown.current=saved;setOperations(previous=>[...previous,saved!]);
      body={action:'CREATE_TEST_PLAN',operationId:saved.operationId,offerCode:row.offerCode,expectedRevisionId:row.revisionId,reason,input:input.data,factorId,code};
    }
    void run(async(signal,current)=>{
      setMessage(op?'Checking the original Test plan and completing its mapping…':'Creating the Test plan and verifying its saved mapping…');
      const response=await checkoutRequest(endpoint,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal,
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!current())return;
      if(!response.ok){
        if(!op&&[400,401,403,429].includes(response.status)){unknown.current=null;setOperations(previous=>previous.filter(value=>value.operationId!==saved!.operationId));}
        setReady(false);setMessage('The operation is not confirmed. Refresh and reconcile the original operation; do not create a replacement.');return;
      }
      const raw=await response.json();if(!current())return;
      if(!op&&(raw as {code?:unknown})?.code==='NOT_CREATED'){
        unknown.current=null;setOperations(previous=>previous.filter(value=>value.operationId!==saved!.operationId));setReady(false);
        setMessage('No plan was created. Refresh the current catalog before reviewing another change.');return;
      }
      if((raw as {code?:unknown})?.code!=='APPLIED'){setReady(false);setMessage('The original plan operation is still pending. Refresh to inspect its saved ID, then reconcile with fresh MFA.');return;}
      const result=appliedSchema.parse(raw);
      if(result.revision.offerCode!==row.offerCode||result.revision.enabled)throw Error();
      if(unknown.current?.operationId===saved!.operationId)unknown.current=null;
      setOperations(previous=>previous.filter(value=>value.operationId!==saved!.operationId));setReady(false);
      setMessage('Test plan mapped and verified. The new catalog revision is disabled. Refresh to view its plan ID; subscription acceptance and activation are separate.');
    });
  };
  return <section aria-label="Razorpay Test plan synchronization" aria-busy={busy}>
    <h2>Razorpay Test plan sync</h2><p role="status">{message}</p>
    <button type="button" disabled={disabled||busy} onClick={()=>void refresh()}>Refresh Test plan sync</button>
    {catalog.map(row=>{const op=operations.find(value=>value.offerCode===row.offerCode);return <article key={row.offerCode}>
      <h3>{row.name}</h3><p>{clueraPrice(row.amountPaise)} / month · {clueraAllowance(row.allowanceSeconds)}</p>
      <p>Mapped Test plan: {row.razorpayPlanId??'None'}</p>
      {op?<p>Unresolved operation: {op.operationId}. Saved plan: {op.razorpayPlanId??'Not yet confirmed'}. Review the original plan in Razorpay Test if its ID is missing.</p>:null}
      <form key={op?.operationId??row.revisionId} onSubmit={event=>{event.preventDefault();submit(row,event.currentTarget,op);}}>
        <fieldset disabled={disabled||busy||!ready||!factors.length||(!op&&!!unknown.current)}>
          <legend>{op?'Recover the original Test plan':'Create a monthly Test plan and mapping'}</legend>
          {op?<label>Original Test plan ID (optional if saved)<input name="plan" defaultValue={op.razorpayPlanId??''} maxLength={69} autoComplete="off"/></label>:<>
            <label>Plan name<input name="name" defaultValue={row.name} minLength={2} maxLength={80} required/></label>
            <label>Monthly price (INR)<input name="price" defaultValue={(row.amountPaise/100).toFixed(2)} inputMode="decimal" required/></label>
            <label>Monthly allowance (minutes)<input name="minutes" type="number" min={1} max={60000} step={1} defaultValue={row.allowanceSeconds/60} required/></label>
            <label>Maximum charges<input name="totalCount" type="number" min={1} max={120} step={1} defaultValue={row.totalCount??120} required/></label>
            <label>Reason<textarea name="reason" minLength={10} maxLength={500} required/></label>
          </>}
          <label>Verified authenticator<select name="factor" required><option value="">Choose authenticator</option>{factors.map((id,index)=><option key={id} value={id}>Authenticator {index+1}</option>)}</select></label>
          <label>Fresh six-digit code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></label>
          <button type="submit">{op?'Reconcile original Test plan':'Create Test plan and map'}</button>
        </fieldset>
      </form>
    </article>;})}
    <p>Plan synchronization creates templates only. Payment collection, monthly availability and Live remain controlled separately.</p>
  </section>;
}
