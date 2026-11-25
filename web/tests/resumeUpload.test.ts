import {createHash,randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {resumeCommand,resumeInput,type ResumeService} from '../lib/accounts/resumes';
import {resumeRequest} from '../lib/accounts/resumeUpload';
import {looksLike,writeZip} from '../lib/resumes/compress';

const owner={userId:randomUUID(),sessionId:randomUUID()},id=randomUUID();
const docx=writeZip([{name:'[Content_Types].xml',data:Buffer.from('<Types/>')},{name:'word/document.xml',data:Buffer.from('<w:t>Cv</w:t>'.repeat(50))}]);
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const begin={step:'BEGIN' as const,hash:sha(docx),name:'My CV.docx',kind:'DOCX' as const,bytes:docx.length,sessionRef:randomUUID(),text:'Cv text'};

function fake(replies:Record<string,unknown>,received:Buffer=docx){
 const calls:Array<[string,unknown]>=[];
 const files={createSignedUploadUrl:vi.fn(async(path:string)=>({data:{signedUrl:`https://storage.invalid/upload/${path}?token=t`},error:null})),
  download:vi.fn(async()=>({data:new Blob([new Uint8Array(received)]),error:null})),upload:vi.fn(async()=>({data:{},error:null})),remove:vi.fn(async()=>({data:[],error:null}))};
 const service:ResumeService={rpc:async(name,args)=>{calls.push([name,args]);return {data:replies[name]??{code:'ACTIVE'},error:null};},storage:{from:bucket=>{expect(bucket).toBe('customer-resumes');return files;}}};
 return {service,files,calls};
}
it('saves a text résumé at once and removes files of uploads that never finished',async()=>{
 const h=fake({customer_resume_begin:{code:'ACTIVE',id,upload:false,stale:['old-one']}});
 expect(await resumeCommand(h.service,owner,{...begin,kind:'TYPED'},'phone')).toEqual({id,stored:true,upload:null});
 expect(h.calls[0]).toEqual(['customer_resume_begin',{p_user:owner.userId,p_session:owner.sessionId,p_input:{hash:begin.hash,name:'My CV.docx',kind:'TYPED',bytes:docx.length,text:'Cv text',source:'phone',sessionRef:begin.sessionRef}}]);
 expect(h.files.remove).toHaveBeenCalledWith([`pending/${owner.userId}/old-one`]);expect(h.files.createSignedUploadUrl).not.toHaveBeenCalled();
});
it('gives a file one private upload address, then checks, compresses and keeps it',async()=>{
 const h=fake({customer_resume_begin:{code:'ACTIVE',id,upload:true,stale:[]},customer_resume_pending:{code:'ACTIVE',hash:sha(docx),bytes:docx.length,kind:'DOCX'}});
 expect(await resumeCommand(h.service,owner,begin,'windows')).toEqual({id,stored:false,upload:{url:`https://storage.invalid/upload/pending/${owner.userId}/${id}?token=t`}});
 expect(await resumeCommand(h.service,owner,{step:'COMPLETE',id},'windows')).toEqual({id,stored:true});
 const [path,body,options]=h.files.upload.mock.calls[0] as unknown as [string,Buffer,{contentType:string}];
 expect(path).toBe(`${owner.userId}/${id}.docx`);expect(looksLike(body,'DOCX')).toBe(true);expect(options.contentType).toContain('wordprocessingml');
 expect(h.calls.at(-1)![0]).toBe('customer_resume_stored');expect(h.calls.at(-1)![1]).toMatchObject({p_path:path,p_bytes:body.length});
 expect(h.files.remove).toHaveBeenLastCalledWith([`pending/${owner.userId}/${id}`]);
});
it('keeps nothing when the received file is not the one described',async()=>{
 for(const received of [Buffer.from('MZ executable'),Buffer.concat([docx,Buffer.from('x')])]){
  const h=fake({customer_resume_pending:{code:'ACTIVE',hash:sha(docx),bytes:docx.length,kind:'DOCX'}},received);
  await expect(resumeCommand(h.service,owner,{step:'COMPLETE',id},'phone')).rejects.toMatchObject({status:400});
  expect(h.files.upload).not.toHaveBeenCalled();expect(h.calls.at(-1)![0]).toBe('customer_resume_discard');
  expect(h.files.remove).toHaveBeenCalledWith([`pending/${owner.userId}/${id}`]);
 }
});
it('refuses suspended or signed-out customers and skips quietly at the storage limit',async()=>{
 await expect(resumeCommand(fake({customer_resume_begin:{code:'SUSPENDED'}}).service,owner,begin,'phone')).rejects.toMatchObject({status:403});
 await expect(resumeCommand(fake({customer_resume_begin:{code:'UNAUTHENTICATED'}}).service,owner,begin,'phone')).rejects.toMatchObject({status:401});
 expect(await resumeCommand(fake({customer_resume_begin:{code:'LIMIT',stale:[]}}).service,owner,begin,'phone')).toEqual({stored:false,upload:null});
});
it('accepts only the described request',()=>{
 expect(resumeInput.safeParse(begin).success).toBe(true);
 for(const bad of [{...begin,source:'windows'},{...begin,bytes:21*1024*1024},{...begin,hash:'ABC'},{...begin,sessionRef:'x'},{step:'COMPLETE',id:'1'},{step:'DELETE',id}])
  expect(resumeInput.safeParse(bad).success,JSON.stringify(bad).slice(0,80)).toBe(false);
});
beforeEach(()=>{for(const [key,value] of Object.entries({SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:'https://www.clueraai.in',NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic-infrastructure-service-key',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(key,value);vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('no network in tests');}));});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('turns away other sites, browser headers on app requests and requests without a sign-in',async()=>{
 const send=(headers:Record<string,string>,url='https://www.clueraai.in/api/account/resume')=>resumeRequest(new Request(url,{method:'POST',headers,body:'{}'}));
 expect((await send({origin:'https://attacker.invalid'})).status).toBe(403);
 expect((await send({})).status).toBe(403);
 expect((await send({authorization:'Bearer synthetic-access-token-000000',origin:'https://www.clueraai.in'})).status).toBe(403);
 expect((await send({authorization:'Bearer synthetic-access-token-000000',cookie:'a=b'})).status).toBe(403);
 expect((await send({authorization:'Bearer short'})).status).toBe(401);
 expect((await send({origin:'https://www.clueraai.in'})).status).toBe(401);
 expect((await resumeRequest(new Request('https://www.clueraai.in/api/account/resume'))).status).toBe(404);
});
