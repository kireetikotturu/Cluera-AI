import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,expect,it} from 'vitest';

let db:PGlite;
const admin=randomUUID(),adminSession=randomUUID(),alice=randomUUID(),aliceSession=randomUUID(),bob=randomUUID(),bobSession=randomUUID();
const value=async(sql:string,args:unknown[]=[])=>(await db.query<any>(sql,args)).rows[0].value;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const file=(overrides:object={})=>({hash:hash('pdf-bytes'),name:'Alice CV.pdf',kind:'PDF',bytes:500_000,source:'phone',sessionRef:randomUUID(),text:'Alice Kumar, Java developer',...overrides});
const begin=(user:string,session:string,input:object)=>value('select public.customer_resume_begin($1,$2,$3) value',[user,session,input]);
const list=(query='',actor=admin,session=adminSession)=>value('select public.cluera_admin_resumes($1,$2,$3) value',[actor,session,query]);

beforeAll(async()=>{
 db=new PGlite();
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');
 // A storage.buckets table like Supabase's, so the bucket creation runs too.
 await db.exec('create schema storage;create table storage.buckets(id text primary key,name text not null,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);');
 for(const name of ['20261016014532_cluera_clean_foundation','20261126100000_cluera_resume_storage'])await db.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));
 for(const [user,session,email] of [[admin,adminSession,'admin@example.invalid'],[alice,aliceSession,'alice@example.invalid'],[bob,bobSession,'bob@example.invalid']]){
  await db.query('insert into auth.users values($1,$2,now())',[user,email]);
  await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[session,user]);
 }
 await db.query('insert into public.account_admin_profiles(user_id) values($1)',[admin]);
 // The first sign-in creates the customer account.
 for(const [user,session] of [[alice,aliceSession],[bob,bobSession]])await value('select public.customer_authorize($1,$2) value',[user,session]);
},90000);
afterAll(async()=>db?.close());

it('creates a private bucket for the compressed files only',async()=>{
 const bucket=(await db.query<any>("select * from storage.buckets")).rows;
 expect(bucket).toEqual([expect.objectContaining({id:'customer-resumes',public:false})]);
 expect(bucket[0].allowed_mime_types).toEqual(['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
});
it('asks for the file once, keeps one copy per résumé and counts the sessions that used it',async()=>{
 const first=await begin(alice,aliceSession,file());expect(first).toMatchObject({code:'ACTIVE',upload:true});
 expect((await begin(alice,aliceSession,file())).upload).toBe(true);
 const declared=await value('select public.customer_resume_pending($1,$2,$3) value',[alice,aliceSession,first.id]);
 expect(declared).toEqual({code:'ACTIVE',hash:hash('pdf-bytes'),bytes:500_000,kind:'PDF'});
 expect((await list()).rows).toEqual([]);
 expect((await value('select public.customer_resume_stored($1,$2,$3,$4,$5,$6) value',[alice,aliceSession,first.id,`${bob}/${first.id}.pdf`,1000,'pdf-pages'])).code).toBe('INVALID');
 expect((await value('select public.customer_resume_stored($1,$2,$3,$4,$5,$6) value',[alice,aliceSession,first.id,`${alice}/${first.id}.pdf`,61_000,'pdf-pages'])).code).toBe('ACTIVE');
 const ref=randomUUID();
 expect((await begin(alice,aliceSession,file({sessionRef:ref,source:'windows'}))).upload).toBe(false);
 expect((await begin(alice,aliceSession,file({sessionRef:ref,source:'windows'}))).upload).toBe(false);
 const rows=(await list()).rows;expect(rows).toHaveLength(1);
 expect(rows[0]).toMatchObject({email:'alice@example.invalid',name:'Alice CV.pdf',kind:'PDF',originalBytes:500_000,storedBytes:61_000,compression:'pdf-pages',hasFile:true,source:'windows',sessions:3});
 expect((await value('select public.customer_resume_pending($1,$2,$3) value',[alice,aliceSession,first.id])).code).toBe('STORED');
});
it('saves typed or text résumés at once, and refuses incomplete or invalid input',async()=>{
 const typed=await begin(bob,bobSession,file({hash:hash('typed'),kind:'TYPED',name:'Typed résumé',bytes:5,text:'Bob — 100% React_dev'}));
 expect(typed).toMatchObject({code:'ACTIVE',upload:false});
 for(const bad of [{hash:'x'},{kind:'EXE'},{bytes:0},{bytes:30_000_000},{source:'web'},{kind:'TYPED',text:'   '},{sessionRef:'abc'},{name:''}])
  expect((await begin(bob,bobSession,file(bad))).code,JSON.stringify(bad)).toBe('INVALID');
 expect((await value('select public.customer_resume_pending($1,$2,$3) value',[alice,aliceSession,typed.id])).code).toBe('NOT_FOUND');
});
it('keeps another customer out and forgets uploads that never finished',async()=>{
 const pending=await begin(bob,bobSession,file({hash:hash('bobs-docx'),kind:'DOCX',name:'Bob.docx'}));
 expect((await value('select public.customer_resume_stored($1,$2,$3,$4,$5,$6) value',[alice,aliceSession,pending.id,`${alice}/${pending.id}.docx`,10,'original'])).code).toBe('NOT_FOUND');
 await db.query("update public.customer_resumes set created_at=now()-interval '2 days' where id=$1",[pending.id]);
 const next=await begin(bob,bobSession,file({hash:hash('bobs-new'),name:'New.pdf'}));
 expect(next.stale).toEqual([pending.id]);
 await value('select public.customer_resume_discard($1,$2,$3) value',[bob,bobSession,next.id]);
 expect((await db.query('select 1 from public.customer_resumes where id=$1',[next.id])).rows).toHaveLength(0);
});
it('keeps one account from filling the storage: few unfinished uploads, then text only past 40 MB',async()=>{
 const carol=randomUUID(),session=randomUUID();
 await db.query('insert into auth.users values($1,$2,now())',[carol,'carol@example.invalid']);
 await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[session,carol]);
 const big=(n:number)=>file({hash:hash(`big-${n}`),name:`big-${n}.pdf`,bytes:15*1024*1024});
 const first=await begin(carol,session,big(1)),second=await begin(carol,session,big(2));
 expect([first.upload,second.upload]).toEqual([true,true]);
 // A third 15 MB file would pass 40 MB: its text is kept instead.
 const third=await begin(carol,session,big(3));expect(third).toMatchObject({upload:false});
 const small=await begin(carol,session,file({hash:hash('small-1'),bytes:1000})),smaller=await begin(carol,session,file({hash:hash('small-2'),bytes:1000}));
 expect(small.upload).toBe(true);expect(smaller.stale).toEqual([first.id]);
 const rows=(await db.query<any>('select name,state,compression,storage_path from public.customer_resumes where user_id=$1 order by created_at',[carol])).rows;
 expect(rows.filter((r:any)=>r.state==='PENDING')).toHaveLength(3);
 expect(rows.find((r:any)=>r.name==='big-3.pdf')).toMatchObject({state:'STORED',compression:'text',storage_path:null});
 await db.query('delete from public.customer_resumes where user_id=$1',[carol]);
});
it('searches by e-mail or file name literally and pages through newest first',async()=>{
 expect((await list('ALICE')).rows.map((r:any)=>r.email)).toEqual(['alice@example.invalid']);
 expect((await list('100%')).rows).toHaveLength(0);// the file name has no "100%", only the text does
 expect((await list('Typed')).rows).toHaveLength(1);expect((await list('%')).rows).toHaveLength(0);expect((await list('_')).rows).toHaveLength(0);
 const all=await list();expect(all.totals).toMatchObject({resumes:2,customers:2,files:1,fileBytes:61_000,originalFileBytes:500_000});
 const older=await value('select public.cluera_admin_resumes($1,$2,$3,$4,$5) value',[admin,adminSession,'',all.rows[0].lastUsedAt,all.rows[0].id]);
 expect(older.rows.map((r:any)=>r.id)).toEqual([all.rows[1].id]);
});
it('records every view, download and delete in the Admin history',async()=>{
 const [entry]=(await list('alice')).rows,open=(mode:string,operation:string|null=randomUUID())=>value('select public.cluera_admin_resume_open($1,$2,$3,$4,$5) value',[admin,adminSession,entry.id,mode,operation]);
 expect(await open('TEXT')).toMatchObject({code:'ACTIVE',text:'Alice Kumar, Java developer',storagePath:null});
 const download=await open('FILE');expect(download).toMatchObject({storagePath:`${alice}/${entry.id}.pdf`,text:null});
 expect((await open('FILE',null)).code).toBe('INVALID');
 expect(await open('PATH',null)).toMatchObject({storagePath:`${alice}/${entry.id}.pdf`});
 const operation=randomUUID(),remove=(op=operation,reason='Customer asked for deletion')=>value('select public.cluera_admin_resume_delete($1,$2,$3,$4,$5) value',[admin,adminSession,op,entry.id,reason]);
 expect((await remove(randomUUID(),'short')).code).toBe('INVALID');
 expect((await remove()).code).toBe('APPLIED');expect((await remove()).code).toBe('APPLIED');expect((await remove(randomUUID())).code).toBe('NOT_FOUND');
 const audit=(await db.query<any>("select action,subject_id from public.account_admin_audit where action like 'RESUME%' order by created_at")).rows;
 expect(audit.map((a:any)=>a.action)).toEqual(['RESUME_VIEW','RESUME_DOWNLOAD','RESUME_DELETE']);
 expect(audit.every((a:any)=>a.subject_id===alice)).toBe(true);
});
it('is closed to customers and to non-admins, with server-only functions',async()=>{
 expect((await list('',alice,aliceSession)).code).toBe('FORBIDDEN');
 await db.exec("update auth.sessions set aal='aal1'");expect((await list()).code).toBe('FORBIDDEN');await db.exec("update auth.sessions set aal='aal2'");
 for(const role of ['anon','authenticated','service_role'])expect((await db.query<any>("select has_table_privilege($1,'public.customer_resumes','SELECT,INSERT,UPDATE,DELETE') allowed",[role])).rows[0].allowed).toBe(false);
 const functions=(await db.query<any>("select oid,prosecdef,proconfig,proname from pg_proc where proname like 'customer_resume_%' or proname like 'cluera_admin_resume%'")).rows;
 expect(functions).toHaveLength(7);
 for(const fn of functions){
  expect(fn.prosecdef).toBe(true);expect(fn.proconfig).toContain('search_path=""');
  for(const role of ['anon','authenticated','service_role'])expect((await db.query<any>("select has_function_privilege($1,$2::oid,'EXECUTE') allowed",[role,fn.oid])).rows[0].allowed,`${fn.proname} ${role}`).toBe(role==='service_role');
 }
 expect((await db.query<any>("select relrowsecurity from pg_class where oid='public.customer_resumes'::regclass")).rows[0].relrowsecurity).toBe(true);
});
