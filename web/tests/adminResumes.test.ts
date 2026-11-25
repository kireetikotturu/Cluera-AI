import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {accountAdminRequest} from '../lib/accounts/admin';
import {downloadName,shapeResumeList} from '../lib/accounts/adminResumes';
import {fileSize,ResumeTable,ResumeTotals,saved} from '../app/account/admin/AdminData';

const mocks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),limit:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
vi.mock('../lib/accounts/handler',async original=>({...await original<typeof import('../lib/accounts/handler')>(),activeSession:mocks.session,rateLimit:mocks.limit}));
const origin='https://www.clueraai.in',actor=randomUUID(),sid=randomUUID(),resume=randomUUID(),customer=randomUUID();
const path=`${customer}/${resume}.pdf`;
const token=`header.${Buffer.from(JSON.stringify({aal:'aal2'})).toString('base64url')}.synthetic`;
let rpc:ReturnType<typeof vi.fn>,files:{createSignedUrl:ReturnType<typeof vi.fn>;remove:ReturnType<typeof vi.fn>},order:string[];
beforeEach(()=>{
 for(const [key,value] of Object.entries({SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:origin,NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic-service-key-placeholder',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(key,value);
 mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},session:{access_token:token,refresh_token:'synthetic-refresh'}});
 mocks.limit.mockResolvedValue(undefined);order=[];
 rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  order.push(`${name}${args.p_mode?`:${args.p_mode}`:''}`);
  const data=name==='account_admin_check'?true
   :name==='cluera_admin_resumes'?{code:'ACTIVE',totals:{resumes:1},rows:[{id:resume,userId:customer,email:'a@example.invalid',name:'CV.pdf',kind:'PDF',hasFile:true,source:'windows',storedBytes:30_000,originalBytes:900_000,sessions:2}]}
   :name==='cluera_admin_resume_open'?{code:'ACTIVE',userId:customer,name:'Asha: CV?.pdf',kind:'PDF',storagePath:args.p_mode==='TEXT'?null:path,text:args.p_mode==='TEXT'?'Asha Rao':null}
   :name==='cluera_admin_resume_delete'?{code:'APPLIED'}:null;
  return {data,error:null,status:200};
 });
 files={createSignedUrl:vi.fn(async()=>({data:{signedUrl:'https://storage.invalid/signed?token=t'},error:null})),remove:vi.fn(async()=>{order.push('storage.remove');return {error:null};})};
 const auth={setSession:vi.fn(async(session:unknown)=>({data:{session},error:null})),getSession:vi.fn(async()=>({data:{session:{access_token:token,refresh_token:'synthetic-refresh'}},error:null}))};
 mocks.clients.mockReturnValue({service:{rpc,storage:{from:(bucket:string)=>{expect(bucket).toBe('customer-resumes');return files;}}},auth:{auth}});
});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
const post=(body:object,query='')=>accountAdminRequest(new Request(`${origin}/api/account/admin${query}`,{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)}));

it('lists résumés with the search as typed and a complete page cursor only',async()=>{
 const response=await accountAdminRequest(new Request(`${origin}/api/account/admin?data=resumes&query=${encodeURIComponent('a@x')}`));
 expect(response.status).toBe(200);expect((await response.json()).rows[0]).toMatchObject({email:'a@example.invalid',source:'windows',sessions:2});
 expect(rpc).toHaveBeenCalledWith('cluera_admin_resumes',{p_actor:actor,p_session:sid,p_query:'a@x',p_before:null,p_before_id:null});
 expect((await accountAdminRequest(new Request(`${origin}/api/account/admin?data=resumes&before=2026-11-26T00:00:00Z`))).status).toBe(400);
});
it('opens a file through a short-lived download link, or its text, using the read allowance',async()=>{
 const link=await post({action:'RESUME_OPEN',id:resume,mode:'FILE'},'?open=resume');
 expect(await link.json()).toEqual({name:'Asha CV .pdf',url:'https://storage.invalid/signed?token=t'});
 expect(files.createSignedUrl).toHaveBeenCalledWith(path,120,{download:'Asha CV .pdf'});
 expect(mocks.limit).toHaveBeenLastCalledWith(expect.anything(),expect.anything(),expect.anything(),'admin@example.invalid','billing-read');
 expect(await (await post({action:'RESUME_OPEN',id:resume,mode:'TEXT'},'?open=resume')).json()).toEqual({name:'Asha CV .pdf',text:'Asha Rao'});
 const opened=rpc.mock.calls.filter(([name])=>name==='cluera_admin_resume_open').map(([,args])=>args.p_operation);
 expect(opened.every(operation=>typeof operation==='string')).toBe(true);expect(opened[0]).not.toBe(opened[1]);
});
it('keeps the open address and the open action together, behind the authenticator step',async()=>{
 expect((await post({action:'RESUME_OPEN',id:resume,mode:'FILE'})).status).toBe(403);
 expect((await post({action:'SUSPEND',operationId:randomUUID(),subjectId:customer,reason:'Synthetic reason here',input:{}},'?open=resume')).status).toBe(403);
 rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>({data:name==='account_admin_check'&&!args.p_require_mfa,error:null,status:200}));
 expect((await post({action:'RESUME_OPEN',id:resume,mode:'FILE'},'?open=resume')).status).toBe(403);
 expect(files.createSignedUrl).not.toHaveBeenCalled();
});
it('deletes the stored file before its record, and reports success only from the database',async()=>{
 const change={action:'RESUME_DELETE',operationId:randomUUID(),subjectId:customer,reason:'Deleted from the Admin Data section',input:{id:resume}};
 const response=await post(change);expect(response.status).toBe(200);expect(await response.json()).toEqual({code:'APPLIED'});
 expect(order.filter(step=>step!=='account_admin_check')).toEqual(['cluera_admin_resume_open:PATH','storage.remove','cluera_admin_resume_delete']);
 files.remove.mockResolvedValue({error:{message:'x'}});
 expect((await post({...change,operationId:randomUUID()})).status).toBe(503);
 expect(order.filter(step=>step==='cluera_admin_resume_delete')).toHaveLength(1);
 expect((await post({...change,subjectId:null})).status).toBe(403);
 expect((await post({...change,input:{id:'x'}})).status).toBe(400);
});
it('shows sizes, savings and safe download names, and never runs anything from a customer’s text',()=>{
 expect([fileSize(500),fileSize(33_000),fileSize(1_600_000),fileSize(25_000_000)]).toEqual(['500 B','32 KB','1.5 MB','24 MB']);
 expect(saved(900_000,30_000)).toBe('97% smaller than 879 KB');expect(saved(100,100)).toBe('');
 expect(downloadName('../../etc/passwd','PDF')).toBe('.. .. etc passwd.pdf');expect(downloadName('cv.PDF','PDF')).toBe('cv.PDF');
 expect(downloadName('resume.docx','TEXT')).toBe('resume.txt');expect(downloadName('\u0001','DOCX')).toBe('resume.docx');
 const list=shapeResumeList({totals:{resumes:3,customers:2,files:2,fileBytes:60_000,originalFileBytes:1_200_000},rows:[{name:'Asha CV.pdf',kind:'PDF',hasFile:true,storedBytes:30_000,originalBytes:900_000,source:'phone',email:'<b>x</b>@example.invalid'}]});
 const html=renderToStaticMarkup(createElement(ResumeTotals,{totals:list.totals}))+renderToStaticMarkup(createElement(ResumeTable,{rows:list.rows,busy:false,confirming:'',onView(){},onDownload(){},onDelete(){},onConfirm(){}}));
 for(const text of ['Résumés saved','From 2 customers · 2 files','59 KB','1.1 MB','97% smaller than 879 KB','Phone','View text','Download','Delete','&lt;b&gt;x&lt;/b&gt;@example.invalid'])expect(html).toContain(text);
});
