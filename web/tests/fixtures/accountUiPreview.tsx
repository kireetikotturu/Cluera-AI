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
createRoot(document.getElementById('root')!).render(admin?<main className="account-page account-admin-page"><header className="account-admin-heading"><p>ACCOUNT CONTROL CENTER</p><h1>Cluera administration <span>Staging</span></h1><p>Customers, policies and releases. Every change stays verified and audited.</p></header><AccountAdmin/></main>:<main className="account-page"><h1>Your Cluera account</h1><AccountPanel/></main>);
