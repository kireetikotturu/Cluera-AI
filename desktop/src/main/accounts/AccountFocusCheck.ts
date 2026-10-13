/** Revalidate on a real foreground transition, never with an idle-page poll.
 * Shared in-flight work and a monotonic cooldown bound focus/collapse churn. */
export function accountFocusCheck(account:{status():{state:string};authorizeWork():Promise<unknown>},clock=()=>performance.now()){
 let pending=false,last=-Infinity,closed=false;
 return {
  focus(){
   if(closed||pending||account.status().state!=='active'||clock()-last<30000)return;
   pending=true;last=clock();
   void account.authorizeWork().catch(()=>undefined).finally(()=>{pending=false;});
  },
  stop(){closed=true;},
 };
}
