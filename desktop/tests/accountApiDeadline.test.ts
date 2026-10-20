import {afterEach,expect,it,vi} from 'vitest';
import {AccountApi} from '../src/main/accounts/AccountApi';

afterEach(()=>vi.useRealTimers());
it('bounds an abort-ignoring request and discards a late response without leaking credentials',async()=>{
 vi.useFakeTimers();
 let complete!:(response:Response)=>void;
 const request=vi.fn((_input:string|URL|Request,_init?:RequestInit)=>new Promise<Response>(resolve=>{complete=resolve;}));
 const diagnostic=vi.fn(),cancel=vi.fn();
 const api=new AccountApi(request as typeof fetch,diagnostic);
 const attempt=api.login({email:'private@example.invalid',password:'private-password'});
 const rejected=expect(attempt).rejects.toThrow('Account service is unavailable.');
 await vi.advanceTimersByTimeAsync(15000);await rejected;
 expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
 complete(new Response(new ReadableStream({cancel})));await Promise.resolve();
 expect(cancel).toHaveBeenCalledOnce();
 expect(diagnostic.mock.calls).toEqual([[{operation:'login',cause:'request_or_response_failed',status:503}]]);
});
it('bounds a stalled response body even when cancellation never settles',async()=>{
 vi.useFakeTimers();
 const cancel=vi.fn(()=>new Promise<void>(()=>undefined));
 const body=new ReadableStream<Uint8Array>({pull:()=>new Promise<void>(()=>undefined),cancel});
 const api=new AccountApi(async()=>new Response(body),()=>undefined);
 let finished=false;
 const attempt=api.authOptions().finally(()=>{finished=true;});
 const rejected=expect(attempt).rejects.toThrow('Account service is unavailable.');
 await vi.advanceTimersByTimeAsync(14999);expect(finished).toBe(false);
 await vi.advanceTimersByTimeAsync(1);await rejected;expect(cancel).toHaveBeenCalledOnce();
});
it('preserves credential rejection without waiting for error-body cleanup',async()=>{
 const cancel=vi.fn(()=>new Promise<void>(()=>undefined));
 const api=new AccountApi(async()=>new Response(new ReadableStream({cancel}),{status:401}),()=>undefined);
 await expect(api.login({email:'private@example.invalid',password:'private-password'})).rejects.toMatchObject({status:401});
 expect(cancel).toHaveBeenCalledOnce();
});
it('cancels an in-flight OAuth exchange immediately when the owner ends the attempt',async()=>{
 const owner=new AbortController();
 const request=vi.fn((_input:string|URL|Request,_init?:RequestInit)=>new Promise<Response>(()=>undefined));
 const api=new AccountApi(request as typeof fetch,()=>undefined);
 const attempt=api.oauthExchange('private-code','private-verifier',owner.signal);
 const rejected=expect(attempt).rejects.toThrow('Account service is unavailable.');
 owner.abort();await rejected;expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
it('does not start an account request after its owner has already cancelled',async()=>{
 const owner=new AbortController();owner.abort();const request=vi.fn();
 const api=new AccountApi(request,()=>undefined);
 await expect(api.authOptions(owner.signal)).rejects.toThrow('Account service is unavailable.');
 expect(request).not.toHaveBeenCalled();
});
