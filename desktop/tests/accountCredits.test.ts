import {afterEach,describe,it,expect,vi} from 'vitest';
import {AccountCreditsManager} from '../src/main/accounts/AccountCreditsManager';
import {AccountApi,AccountApiError} from '../src/main/accounts/AccountApi';
import {allowancePercent,creditDuration,type AccountCredits} from '../src/shared/accountCredits';
const uid='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const snapshot:AccountCredits={userId:uid,displayName:'',serverTime:'2026-10-09T00:00:00Z',availableMilliseconds:900000,
 reservedMilliseconds:0,spentMilliseconds:0,buckets:[],plans:[],payments:[],checkoutAvailable:false};
function fixture(){
 vi.useFakeTimers();let state={state:'active',userId:uid};let clock=0;
 const auth={status:()=>({...state}),reportingCapability:vi.fn(async()=>({accessToken:'synthetic-access-token',signal:new AbortController().signal})),rejectReportingAccess:vi.fn()};
 const credits=vi.fn(async(_access:string,_signal:AbortSignal)=>({...snapshot,userId:state.userId}));const changed=vi.fn();
 const manager=new AccountCreditsManager(auth as any,{credits} as any,changed,()=>clock);
 return {manager,auth,credits,changed,setState:(next:typeof state)=>{state=next;manager.ownerChanged();},advance:async(ms:number)=>{clock+=ms;await vi.advanceTimersByTimeAsync(ms);}};
}
afterEach(()=>vi.useRealTimers());
describe('Account credit reporting ownership and scheduling',()=>{
 it('single-flights refresh bursts without provider operations',async()=>{
  const f=fixture();f.manager.ownerChanged();await Promise.all(Array.from({length:15},()=>f.manager.refresh()));
  expect(f.credits).toHaveBeenCalledTimes(1);expect(f.manager.status().snapshot).toEqual(snapshot);f.manager.dispose();
 });
 it('does not poll idle and checks every 30 seconds only while actual managed work is active',async()=>{
  const f=fixture();f.manager.ownerChanged();await f.manager.refresh();await f.advance(300000);expect(f.credits).toHaveBeenCalledTimes(1);
  f.manager.activity(true);await f.advance(30001);expect(f.credits).toHaveBeenCalledTimes(3);
  f.manager.activity(false);await f.advance(5001);const calls=f.credits.mock.calls.length;
  await f.advance(300000);expect(f.credits).toHaveBeenCalledTimes(calls);f.manager.dispose();
 });
 it('preserves last good snapshot on network failure, never treats it as suspension',async()=>{
  const f=fixture();f.manager.ownerChanged();await f.manager.refresh();f.credits.mockRejectedValueOnce(new AccountApiError(503));await f.advance(5000);await f.manager.refresh();
  expect(f.manager.status()).toMatchObject({state:'unavailable',snapshot});expect(f.auth.rejectReportingAccess).not.toHaveBeenCalled();f.manager.dispose();
 });
 it('definitive server denials invalidate through the session owner',async()=>{
  for(const status of [401,403]){const f=fixture();f.credits.mockRejectedValueOnce(new AccountApiError(status));f.manager.ownerChanged();await f.manager.refresh();
   expect(f.auth.rejectReportingAccess).toHaveBeenCalledWith(status);f.manager.dispose();}
 });
 it('fences late results and clears snapshots at logout and account switch',async()=>{
  const f=fixture();let resolve!:(value:AccountCredits)=>void;
  f.credits.mockImplementationOnce(()=>new Promise(r=>resolve=r));f.manager.ownerChanged();await Promise.resolve();
  const before=f.manager.refresh();f.setState({state:'signed-out',userId:uid});resolve(snapshot);await before;
  expect(f.manager.status().snapshot).toBeUndefined();f.setState({state:'active',userId:other});await f.manager.refresh();
  expect(f.manager.status().snapshot?.userId).toBe(other);f.manager.dispose();
 });
 it('cancels reporting transport on disposal without starting a reservation',async()=>{
  const f=fixture();f.manager.ownerChanged();await f.manager.refresh();const signal=f.credits.mock.calls[0][1] as AbortSignal;
  f.manager.dispose();expect(signal.aborted).toBe(true);await f.advance(60000);expect(f.credits).toHaveBeenCalledTimes(1);
 });
 it('never mixes lifetime spending with the current allowance percentage',()=>{
  const pack={kind:'PACK' as const,grantedMilliseconds:21600000,spentMilliseconds:3600000,reservedMilliseconds:30000,availableMilliseconds:17970000};
  expect(allowancePercent(pack)).toBeCloseTo(16.6667);expect(creditDuration(1080000000+600000)).toBe('300h 10m');
  expect(allowancePercent({...pack,grantedMilliseconds:0})).toBeNull();expect(creditDuration(59000)).toBe('59s');
 });
 it('bounds response fields, keeps tokens in main headers, and preserves opaque 12-character refresh support',async()=>{
  const request=vi.fn(async(_input:RequestInfo|URL,_options?:RequestInit)=>Response.json(snapshot));const api=new AccountApi(request as any,()=>undefined);
  expect(await api.credits('synthetic-access-token',new AbortController().signal)).toEqual(snapshot);
  expect(request.mock.calls[0][0]).toMatch(/\/api\/account\/native\/credits$/);
  expect(request.mock.calls[0][1]).toMatchObject({method:'GET',credentials:'omit',redirect:'error',cache:'no-store'});
  request.mockResolvedValueOnce(Response.json({...snapshot,secret:'synthetic-forbidden'}));await expect(api.credits('access',new AbortController().signal)).rejects.toMatchObject({status:503});
 });
 it.each(['cluera_pack_3h_v2','cluera_monthly_40h_v2','cluera_monthly_100h_v2','cluera_monthly_200h_v2'])('accepts only the additive Cluera financial offer enum %s',async offerCode=>{
  const value={...snapshot,payments:[{offerCode,state:'VERIFIED' as const,createdAt:snapshot.serverTime}]};
  const api=new AccountApi(vi.fn(async()=>Response.json(value)) as any,()=>undefined);
  expect(await api.credits('synthetic-access',new AbortController().signal)).toEqual(value);
  const bad=new AccountApi(vi.fn(async()=>Response.json({...value,payments:[{...value.payments[0],offerCode:'unreviewed_plan'}]})) as any,()=>undefined);
  await expect(bad.credits('synthetic-access',new AbortController().signal)).rejects.toMatchObject({status:503});
 });
});
