import {emptyCredits,type AccountCredits,type CreditsView} from '../../shared/accountCredits';
/** Time ever put on the account: it grows only when time is added, not while it is used. */
const addedTime=(credits:AccountCredits):number=>credits.availableMilliseconds+credits.reservedMilliseconds+credits.spentMilliseconds;
const verifiedPayments=(credits:AccountCredits):number=>credits.payments.filter(payment=>payment.state==='VERIFIED').length;
import {AccountApi,AccountApiError} from './AccountApi';
import type {AccountSessionManager} from './AccountSessionManager';
type Authority=Pick<AccountSessionManager,'status'|'reportingCapability'|'rejectReportingAccess'>;
/** Main owns refresh scheduling. Reporting never opens a provider/reservation.
 * One request in flight, 5s event cooldown, 30s active-only reconciliation. */
export class AccountCreditsManager {
 private view=emptyCredits();private user?:string;private epoch=0;private closed=false;
 private pending?:Promise<CreditsView>;private request?:AbortController;
 private timer?:ReturnType<typeof setTimeout>;private settle?:ReturnType<typeof setTimeout>;
 private purchase?:ReturnType<typeof setTimeout>;private purchaseUntil=0;
 private watching?:ReturnType<typeof setTimeout>;private watchRun=0;
 private last=-Infinity;private since=0;
 constructor(private readonly account:Authority,private readonly api=new AccountApi(),
  private readonly changed:(view:CreditsView)=>void=()=>undefined,private readonly clock=()=>performance.now()){}
 status():CreditsView{return {...this.view,activeMilliseconds:this.view.active?Math.max(0,this.clock()-this.since):this.view.activeMilliseconds};}
 private publish(){this.changed(this.status());}
 ownerChanged(){
  const state=this.account.status(),user=state.state==='active'?state.userId:undefined;
  if(user===this.user)return;
  ++this.epoch;this.request?.abort();this.pending=undefined;clearTimeout(this.timer);clearTimeout(this.settle);
  this.timer=undefined;this.settle=undefined;
  clearTimeout(this.purchase);this.purchase=undefined;this.purchaseUntil=0;
  this.stopWatching();
  this.user=user;this.last=-Infinity;this.view=emptyCredits();this.publish();
  if(user)void this.refresh();
 }
 /** A deliberate browser checkout opens a bounded observation window. Focus
  * starts it, so time spent in the browser does not consume the refresh budget.
  * These are authenticated reads only; they never create or retry a purchase. */
 checkoutOpened(){if(!this.closed&&this.user)this.purchaseUntil=-1;}
 foreground(){
  if(this.closed||!this.user)return;
  if(this.purchaseUntil===-1){this.purchaseUntil=this.clock()+120000;this.observePurchase();}
  void this.refresh();
 }
 private observePurchase(){
  clearTimeout(this.purchase);this.purchase=undefined;
  if(this.closed||!this.user||this.purchaseUntil<=this.clock())return;
  this.purchase=setTimeout(()=>{this.purchase=undefined;void this.refresh().finally(()=>this.observePurchase());},5000);
  this.purchase.unref?.();
 }
 /** While the customer pays in the browser, looks for the time the payment adds, so the app can come back by itself.
  * Reads only: every 10 s for 5 minutes, then every 30 s, for at most 15 minutes (about 50 reads, well within the
  * server's limit). A new checkout replaces the earlier watch, and a live session ends it. */
 watchPurchase(added:()=>void,everyMs=10_000,forMs=900_000):void{
  this.stopWatching();
  if(this.closed||!this.user)return;
  const epoch=this.epoch,started=this.clock(),run=this.watchRun;
  const current=():boolean=>epoch===this.epoch&&run===this.watchRun&&!this.closed;
  // The starting balance is read now, before any payment can finish: an older one could miss a purchase made elsewhere
  // and bring the app back while the customer is still paying.
  let before:AccountCredits|undefined;
  void this.refresh().then(view=>{if(current()&&view.state==='ready')before??=view.snapshot;});
  const next=():void=>{
   this.watching=setTimeout(()=>{void this.refresh().then(view=>{
    if(!current())return;
    const now=view.state==='ready'?view.snapshot:undefined;
    if(now&&before&&(addedTime(now)>addedTime(before)||verifiedPayments(now)>verifiedPayments(before))){this.stopWatching();added();return;}
    before??=now;
    if(this.clock()<started+forMs)next();
   });},this.clock()-started<forMs/3?everyMs:everyMs*3);
   this.watching.unref?.();
  };
  next();
 }
 private stopWatching(){++this.watchRun;clearTimeout(this.watching);this.watching=undefined;}
 activity(active:boolean){
  if(this.closed||!this.user||this.view.active===active)return;
  // Time is being used: the payment watch ends (a live session must never be brought forward or interrupted).
  if(active)this.stopWatching();
  clearTimeout(this.settle);
  this.settle=undefined;
  this.view={...this.view,active,activeMilliseconds:active?0:this.status().activeMilliseconds};
  if(active){this.since=this.clock();void this.refresh();this.schedule();}
  else{clearTimeout(this.timer);
   // STOP is asynchronous across WSS. One bounded trailing read, not idle polling.
   this.settle=setTimeout(()=>{this.settle=undefined;void this.refresh();},Math.max(1500,5000-(this.clock()-this.last)));this.settle.unref?.();}
  this.publish();
 }
 private schedule(){clearTimeout(this.timer);if(!this.view.active||this.closed||!this.user)return;
  this.timer=setTimeout(()=>{void this.refresh().finally(()=>this.schedule());},30000);this.timer.unref?.();}
 refresh():Promise<CreditsView>{
  if(this.closed||!this.user)return Promise.resolve(this.status());
  if(this.pending)return this.pending;
  if(this.clock()-this.last<5000){
    // A reconnect/browser-return inside the cooldown gets one trailing read,
    // not a dropped event or an unbounded retry/poll loop.
    if(!this.settle){this.settle=setTimeout(()=>{this.settle=undefined;void this.refresh();},5000-(this.clock()-this.last));this.settle.unref?.();}
    return Promise.resolve(this.status());
  }
  const epoch=this.epoch,user=this.user;this.last=this.clock();const controller=new AbortController();this.request=controller;
  this.view={...this.view,refreshing:true};this.publish();
  const pending=(async()=>{
   try{
    const auth=await this.account.reportingCapability();
    if(epoch!==this.epoch||controller.signal.aborted)return this.status();
    const snapshot=await this.api.credits(auth.accessToken,AbortSignal.any([auth.signal,controller.signal]));
    if(epoch!==this.epoch||controller.signal.aborted||this.closed)return this.status();
    if(snapshot.userId!==user)throw new AccountApiError(401);
    this.view={...this.view,state:'ready',snapshot,lastSync:new Date().toISOString()};
   }catch(error){
    if(epoch!==this.epoch||controller.signal.aborted||this.closed)return this.status();
    if(error instanceof AccountApiError&&(error.status===401||error.status===403))this.account.rejectReportingAccess(error.status);
    else this.view={...this.view,state:'unavailable'}; // network failure is not revocation
   }finally{if(epoch===this.epoch&&!this.closed){this.view={...this.view,refreshing:false};this.publish();}}
   return this.status();
  })().finally(()=>{if(this.pending===pending)this.pending=undefined;});
  this.pending=pending;return pending;
 }
 dispose(){this.closed=true;++this.epoch;this.request?.abort();clearTimeout(this.timer);clearTimeout(this.settle);clearTimeout(this.purchase);clearTimeout(this.watching);this.purchaseUntil=0;this.view=emptyCredits();}
}
