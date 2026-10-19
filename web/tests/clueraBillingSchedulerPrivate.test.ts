import {afterAll,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync,chmodSync,linkSync,symlinkSync,realpathSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';

const require=createRequire(import.meta.url),root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const source=join(root,'scripts/payments/prepare-cluera-billing-scheduler-private.cjs');
const helper=require(source),scanner=require(join(root,'scripts/security/source-secret-scan.cjs'));
const temporary=join(root,'.test-output');mkdirSync(temporary,{recursive:true});
const fixtures:string[]=[];
function fixture(ignore='.local-secrets/\n'){
 const directory=realpathSync(mkdtempSync(join(temporary,'scheduler-private-unit-')));fixtures.push(directory);
 writeFileSync(join(directory,'.gitignore'),ignore);
 execFileSync('git',['init','--quiet',directory],{windowsHide:true,stdio:'pipe'});
 return directory;
}
function prepare(directory:string){return helper.inspectAndPrepare({root:directory,mode:'prepare'});}
function output(directory:string){return join(directory,helper.RELATIVE);}
function parsed(directory:string){return JSON.parse(readFileSync(output(directory),'utf8'));}
function overwrite(directory:string,data:unknown){writeFileSync(output(directory),typeof data==='string'?data:JSON.stringify(data),{mode:0o600});}
function refused(work:()=>unknown){expect(work).toThrow(helper.FAILURE);}
afterAll(()=>{
 const parent=realpathSync(temporary);
 for(const directory of fixtures){
  if(dirname(directory)!==parent||!basename(directory).startsWith('scheduler-private-unit-'))throw Error('Unsafe test cleanup');
  // Windows can briefly retain Git/scanner handles after the synchronous
  // fixture assertions. Retry only these owned temporary trees, within 1.5s
  // of bounded linear backoff; security assertions and hook limits stay intact.
  rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});

it('default check makes no private directory/file and cannot activate or return a value',()=>{
 const directory=fixture(),result=helper.inspectAndPrepare({root:directory});
 expect(result).toEqual({status:'absent',projectRef:'yhnqlfcgrmckhyjdxegg',file:output(directory),valuesDisplayed:false,activationAuthorized:false});
 expect(existsSync(join(directory,'.local-secrets'))).toBe(false);
});
it('prepares only a matching fresh canonical 32-byte worker key and all-disabled policy',()=>{
 const directory=fixture(),result=prepare(directory),data=parsed(directory),key=data.web.SIGMAROUND_BILLING_WORKER_SECRET;
 expect(result.status).toBe('prepared');expect(JSON.stringify(result)).not.toContain(key);
 expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(Buffer.from(key,'base64url').length).toBe(32);
 expect(data.relay.SIGMAROUND_BILLING_WORKER_SECRET).toBe(key);
 expect(data.projectRef).toBe('yhnqlfcgrmckhyjdxegg');expect(data.purpose).toBe(helper.PURPOSE);
 expect(data.web[helper.GATE]).toBe(false);expect(data.relay[helper.GATE]).toBe(false);
 expect(data.disabledPolicy).toEqual(helper.policy);expect(data.disabledPolicy.SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED).toBe(true);
 expect(helper.validate(data)).toBe(true);
});
it('retains an exact existing valid file without rotation or changed bytes',()=>{
 const directory=fixture();prepare(directory);const before=readFileSync(output(directory));
 expect(prepare(directory).status).toBe('retained');expect(helper.inspectAndPrepare({root:directory}).status).toBe('retained');
 expect(readFileSync(output(directory))).toEqual(before);
});
it('uses independent random material for independent fixture projects without reading old secrets',()=>{
 const first=fixture(),second=fixture();prepare(first);prepare(second);
 expect(parsed(first).web[helper.VARIABLE]).not.toBe(parsed(second).web[helper.VARIABLE]);
 const text=readFileSync(source,'utf8');expect(text).not.toMatch(/process\.env|\.env\.local|cluera-owner-settings|cluera-vercel-settings|fetch\(|https:\/\//);
});
it.each(['dwqltsqumiwsxtkzdoaa','bzccuqforilpifhiysjk','other',null])('rejects wrong project %s before private output',projectRef=>{
 const directory=fixture();refused(()=>helper.inspectAndPrepare({root:directory,projectRef,mode:'prepare'}));
 expect(existsSync(output(directory))).toBe(false);
});
it.each(['force','activate','overwrite',null])('rejects unsupported mode %s without a private write',mode=>{
 const directory=fixture();refused(()=>helper.inspectAndPrepare({root:directory,mode}));expect(existsSync(output(directory))).toBe(false);
});
it('refuses an unignored or force-tracked output rather than relying only on the filename',()=>{
 const unignored=fixture('');refused(()=>prepare(unignored));expect(existsSync(output(unignored))).toBe(false);
 const tracked=fixture();prepare(tracked);execFileSync('git',['-C',tracked,'add','-f','--',helper.RELATIVE],{windowsHide:true,stdio:'pipe'});
 const before=readFileSync(output(tracked));refused(()=>prepare(tracked));expect(readFileSync(output(tracked))).toEqual(before);
});
const invalidRecords:Array<[string,(valid:any)=>unknown]>=[
 ['malformed JSON',()=>'{bad JSON'],['foreign project',valid=>({...valid,projectRef:'other'})],
 ['unknown field',valid=>({...valid,unexpected:'do-not-reflect'})],
 ['enabled transport',valid=>({...valid,web:{...valid.web,[helper.GATE]:true}})],
 ['different relay key',valid=>({...valid,relay:{...valid.relay,[helper.VARIABLE]:Buffer.from(Array.from({length:32},(_,i)=>i)).toString('base64url')}})],
 ['enabled payment intake',valid=>({...valid,disabledPolicy:{...valid.disabledPolicy,SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:true}})],
 ['unpaused payments',valid=>({...valid,disabledPolicy:{...valid.disabledPolicy,SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:false}})],
 ['changed instructions',valid=>({...valid,instructions:'override'})],
 ['nonrandom sentinel',valid=>({...valid,web:{...valid.web,[helper.VARIABLE]:Buffer.alloc(32).toString('base64url')}})],
];
// Each filesystem conflict has its own unchanged default assertion deadline;
// nine independent Git inspections must not consume one shared 5-second test.
it.each(invalidRecords)('refuses %s without overwriting existing private bytes',(_name,mutate)=>{
 const directory=fixture();prepare(directory);overwrite(directory,mutate(parsed(directory)));
 const before=readFileSync(output(directory));refused(()=>prepare(directory));expect(readFileSync(output(directory))).toEqual(before);
});
it('refuses an oversized private path',()=>{
 const directory=fixture();mkdirSync(join(directory,'.local-secrets'));overwrite(directory,'x'.repeat(8193));refused(()=>prepare(directory));
});
it('refuses a hard-linked private path',()=>{
 const directory=fixture();prepare(directory);linkSync(output(directory),join(directory,'copy.private'));refused(()=>prepare(directory));
});
it('refuses a non-file private path',()=>{
 const directory=fixture();mkdirSync(output(directory),{recursive:true});refused(()=>prepare(directory));
});
it('refuses symlink/junction private directories and symlinked repository roots',()=>{
 const directory=fixture(),target=fixture();mkdirSync(join(target,'private-target'));
 symlinkSync(join(target,'private-target'),join(directory,'.local-secrets'),process.platform==='win32'?'junction':'dir');refused(()=>prepare(directory));
 const outer=fixture(),alias=join(outer,'alias');symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');
 refused(()=>helper.inspectAndPrepare({root:alias,mode:'prepare'}));
});
it('CLI defaults to check, refuses output/project/overwrite overrides and never prints generated values',()=>{
 const directory=fixture(),script=join(directory,'scripts/payments/prepare-cluera-billing-scheduler-private.cjs');mkdirSync(dirname(script),{recursive:true});writeFileSync(script,readFileSync(source));
 const run=(...args:string[])=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',windowsHide:true});
 const check=run();expect(check.status).toBe(0);expect(JSON.parse(check.stdout).status).toBe('absent');expect(existsSync(output(directory))).toBe(false);
 for(const args of [['--force'],['--project','other'],['--prepare','--overwrite'],['--output','elsewhere']]){
  const rejected=run(...args);expect(rejected.status).toBe(1);expect(rejected.stdout).toBe('');expect(rejected.stderr.trim()).toBe(helper.FAILURE);
 }
 const made=run('--prepare');expect(made.status).toBe(0);const key=parsed(directory).web[helper.VARIABLE];
 expect(made.stdout+made.stderr).not.toContain(key);expect(JSON.parse(made.stdout).valuesDisplayed).toBe(false);
});
it('adds the fixed new scheduler key to bounded source/artifact known-secret detection without reporting it',()=>{
 const directory=fixture();prepare(directory);const key=parsed(directory).web[helper.VARIABLE],known=scanner.loadKnownSecrets(directory,{});
 expect(known.filter((entry:any)=>entry.type===helper.VARIABLE)).toEqual([{type:helper.VARIABLE,value:key}]);
 const report=scanner.detectSecrets(Buffer.from(`untrusted payload ${key}`),known);
 expect(report).toEqual([helper.VARIABLE]);expect(JSON.stringify(report)).not.toContain(key);
});
it.each(['foreign project','mismatched key','oversized JSON'])('scanner fails closed with a fixed message for %s',kind=>{
 const directory=fixture();prepare(directory);const valid=parsed(directory),value=kind==='foreign project'?{...valid,projectRef:'other'}:
  kind==='mismatched key'?{...valid,relay:{...valid.relay,[helper.VARIABLE]:'private-secret-do-not-print'}}:'x'.repeat(8193);
 overwrite(directory,value);expect(()=>scanner.loadKnownSecrets(directory,{})).toThrow('Cluera scheduler private scan input unavailable.');
});
it('scanner rejects a hard-linked scheduler input with a fixed message',()=>{
 const linked=fixture();prepare(linked);linkSync(output(linked),join(linked,'copy.private'));
 expect(()=>scanner.loadKnownSecrets(linked,{})).toThrow('Cluera scheduler private scan input unavailable.');
});
it.each(['preparer','scanner'])('rejects different inode low bits above Number precision in %s snapshots',kind=>{
 const directory=fixture();prepare(directory);const fs=require('node:fs'),target=output(directory);
 const before=9007199254740992n,opened=before+1n;
 // These distinct native identities collapse to the same JavaScript Number.
 expect(before).not.toBe(opened);expect(Number(before)).toBe(Number(opened));
 const lstat=fs.lstatSync,fstat=fs.fstatSync;
 const snapshot=(stat:any,ino:bigint,options:any)=>Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,
  {ino:options?.bigint?ino:Number(ino)});
 const pathSpy=vi.spyOn(fs,'lstatSync').mockImplementation(((file:any,options:any)=>{
  const stat=lstat(file,options);return resolve(String(file))===resolve(target)?snapshot(stat,before,options):stat;
 }) as any);
 const descriptorSpy=vi.spyOn(fs,'fstatSync').mockImplementation(((descriptor:any,options:any)=>snapshot(fstat(descriptor,options),opened,options)) as any);
 try{
  if(kind==='preparer')refused(()=>helper.inspectAndPrepare({root:directory}));
  else expect(()=>scanner.loadKnownSecrets(directory,{})).toThrow('Cluera scheduler private scan input unavailable.');
  expect(descriptorSpy).toHaveBeenCalled();
  expect(descriptorSpy.mock.calls.every(call=>(call[1] as any)?.bigint===true)).toBe(true);
 }finally{descriptorSpy.mockRestore();pathSpy.mockRestore();}
});
it.runIf(process.platform!=='win32')('refuses loose POSIX private-file permissions',()=>{
 const directory=fixture();prepare(directory);chmodSync(output(directory),0o644);refused(()=>prepare(directory));
});
