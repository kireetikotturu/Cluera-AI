import {expect,it,vi} from 'vitest';
import {accountFocusCheck} from '../src/main/accounts/AccountFocusCheck';
it('does not poll and bounds focus bursts/in-flight checks without verifying signed-out accounts',async()=>{
 let now=0,state='signed-out',finish!:()=>void;
 const authorizeWork=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const check=accountFocusCheck({status:()=>({state}),authorizeWork},()=>now);
 check.focus();expect(authorizeWork).not.toHaveBeenCalled();state='active';check.focus();check.focus();expect(authorizeWork).toHaveBeenCalledOnce();
 now=60000;check.focus();expect(authorizeWork).toHaveBeenCalledOnce();finish();await Promise.resolve();await Promise.resolve();
 check.focus();expect(authorizeWork).toHaveBeenCalledTimes(2);finish();await Promise.resolve();await Promise.resolve();
 now+=1000;check.focus();expect(authorizeWork).toHaveBeenCalledTimes(2);now+=30000;check.stop();check.focus();expect(authorizeWork).toHaveBeenCalledTimes(2);
});
