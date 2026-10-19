import path from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({execFile:vi.fn(),result:{valid:true,publisher:'CN=Cluera AI, O=Example, C=IN',timestamp:true}}));
vi.mock('node:child_process',async()=>{
 const actual=await vi.importActual<typeof import('node:child_process')>('node:child_process');
 return {...actual,execFile:fixture.execFile};
});
import {verifyWindowsPublisher} from '../src/main/updates/WindowsInstaller';
const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
const file='C:\\Cluera fixture with spaces\\approved.exe',publisher='CN=Cluera AI, O=Example, C=IN';
beforeEach(()=>{
 Object.defineProperty(process,'platform',{...platform,value:'win32'});
 fixture.result={valid:true,publisher,timestamp:true};
 fixture.execFile.mockReset().mockImplementation((_executable,_args,_options,done)=>{done(null,{stdout:JSON.stringify(fixture.result)});});
});
afterEach(()=>{Object.defineProperty(process,'platform',platform);});
it('uses a fixed hidden PowerShell command, literal environment path and exact publisher result',async()=>{
 await verifyWindowsPublisher(file,publisher);
 expect(fixture.execFile).toHaveBeenCalledOnce();
 const [executable,args,options]=fixture.execFile.mock.calls[0];
 expect(executable).toBe(path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'));
 expect(args.slice(0,3)).toEqual(['-NoProfile','-NonInteractive','-Command']);
 expect(args[3]).toContain('Get-AuthenticodeSignature -LiteralPath $env:SIGMAROUND_UPDATE_FILE');
 expect(args[3]).not.toContain(file);expect(args[3]).not.toContain(publisher);
 expect(options.env.SIGMAROUND_UPDATE_FILE).toBe(file);
 expect(options.windowsHide).toBe(true);expect(options.timeout).toBe(30000);expect(options.maxBuffer).toBe(8192);
});
it.each([{valid:false},{timestamp:false},{publisher:'CN=Another publisher'}])('rejects invalid signatures, absent timestamps and mismatched subjects %#',async change=>{
 fixture.result={...fixture.result,...change};
 await expect(verifyWindowsPublisher(file,publisher)).rejects.toThrow('Installer publisher or timestamp verification failed.');
});
it('does not invoke Windows verification when the publisher is unconfigured or the OS is unsupported',async()=>{
 await expect(verifyWindowsPublisher(file,undefined)).rejects.toThrow('not configured');
 Object.defineProperty(process,'platform',{...platform,value:'linux'});
 await expect(verifyWindowsPublisher(file,publisher)).rejects.toThrow('not configured');
 expect(fixture.execFile).not.toHaveBeenCalled();
});
