/** Synthetic browser-only Admin/Auth responses. No server or real mutation. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AccountPanel} from '../../app/account/AccountPanel';
import {AccountAdmin} from '../../app/account/admin/AccountAdmin';
import '../../app/globals.css';
import '../../app/cluera.css';
const userId='00000000-0000-4000-8000-000000000001';
const calls:string[]=[];
window.fetch=(async(url:any,options:any={})=>{
 calls.push(`${options.method??'GET'}:${String(url)}`);
 // Synthetic plans for the Admin "Plans" screen: no server, nothing is saved.
 if(String(url).includes('/cluera/live/plans')){
  const plan=(n:number,name:string,amountPaise:number,allowanceSeconds:number,enabled:boolean,archived=false,openCheckouts=0)=>({planId:`00000000-0000-4000-8000-00000000010${n}`,revisionId:`00000000-0000-4000-8000-00000000020${n}`,offerCode:'cluera_pack_3h_v2',name,amountPaise,currency:'INR',allowanceSeconds,kind:'PACK',version:n,enabled,archived,createdAt:new Date().toISOString(),openCheckouts});
  if(options.method==='POST')return Response.json({code:'APPLIED',plan:plan(1,'Cluera 3 Hours',54900,10800,true)});
  return Response.json({code:'ACTIVE',plans:[plan(1,'Cluera 3 Hours',54900,10800,true,false,1),plan(2,'Cluera 10 Hours',149900,36000,false),plan(3,'Old Launch Pack',39900,7200,false,true)],
   history:[{at:new Date().toISOString(),by:'owner@example.invalid',action:'PLAN_EDIT',reason:'Reason given: Better value',before:{name:'Cluera 3 Hours',amountPaise:49900,allowanceSeconds:10800},after:{name:'Cluera 3 Hours',amountPaise:54900,allowanceSeconds:10800}}]});
 }
 if(String(url).includes('readiness=1'))return Response.json({readiness:{mode:'live',ready:false,audience:'nobody',items:[
  {id:'site',area:'Website',label:'Accounts are enabled on the Cluera website',ok:true,fix:''},
  {id:'checkout',area:'Razorpay',label:'The Live Buy button is switched on',ok:false,fix:'This is the last switch. After the database "promote" step has worked, set CLUERA_LIVE_CHECKOUT_ENABLED=true in Vercel, then push to main and promote the deployment. See docs/GO_LIVE_FINAL.md, step 2.'},
  {id:'catalog',area:'Catalog',label:'At least one plan is switched On',ok:true,fix:''}]}});
 if(options.method==='POST')return Response.json({error:'Synthetic request rejected',code:'INVALID'},{status:400});
 if(String(url).includes('/session'))return Response.json({},{status:401});
 if(String(url).includes('releases=1'))return Response.json({code:'ACTIVE',releases:[]});
 if(String(url).includes('providers=1'))return Response.json({providerStatus:{observedAt:new Date().toISOString(),providers:[{provider:'gemini',configured:true},{provider:'deepgram',configured:true}]}});
 return Response.json({users:[{userId,email:'synthetic@example.invalid',state:'ACTIVE',emailVerified:true}],
  grants:[{id:'trial-one',kind:'TRIAL',state:'ACTIVE',grantedMilliseconds:900000,spentMilliseconds:0,testGrant:false}],trial:{registered:true,remainingMilliseconds:900000},balances:{TRIAL:900000,PACK:0,RECURRING:0},sessions:[],billing:[],models:[],
  audit:[{id:'audit-one',action:'CATALOG',createdAt:new Date().toISOString(),reason:'Synthetic reviewed catalog display change'}],
  catalog:[{code:'pro_3_hours',name:'SigmaPro 3 Hours',enabled:true,priority:1,priceId:'synthetic-legacy-price',amount:'54900',currency:'INR',seconds:10800,interval:null}]});
}) as any;
(window as any).accountUiFixture={calls};
const admin=location.pathname.includes('admin');
createRoot(document.getElementById('root')!).render(admin?<main className="account-page account-admin-page"><header className="account-admin-heading"><p>CLUERA ADMIN</p><h1>Cluera Admin</h1><p>Look after your AI keys, payments, plans and customers. Every change is saved in the history.</p></header><AccountAdmin liveBillingAdmin/></main>:<main className="account-page"><h1>Your Cluera account</h1><AccountPanel/></main>);
