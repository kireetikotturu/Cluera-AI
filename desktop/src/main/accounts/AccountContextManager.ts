import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { contextCommand,contextResult,selectedContextExcerpt,type ContextCommand,type ContextDocument,type ContextSnapshot } from '../../shared/accountContext';
import type { AccountSessionManager } from './AccountSessionManager';
import { ACCOUNT_ORIGIN } from './AccountApi';
import { DocumentProcessor } from '../documents/DocumentProcessor';
import { AnswerError } from './AnswerError';

/** A documents request that failed later than this hung or timed out: trying again would only delay the answer more. */
const QUICK_FAILURE_MS=5_000;

const unavailable=()=>new Error('Account context is unavailable. Retry the same change when online.');
class RejectedChange extends Error {constructor(){super('Context was not saved. Check document limits or retry later.');}}
export class AccountContextManager {
  private selected=new Set<string>();
  private pending?:ContextCommand;
  private pendingUncertain=false;
  private busy=false;
  /** The unconfirmed change being sent again for live answers; later questions wait for the same attempt. */
  private resending?:Promise<unknown>;
  private version=0;
  private ownerSignal?:AbortSignal;
  private readonly forget=()=>{this.selected.clear();this.pending=undefined;this.pendingUncertain=false;++this.version;};
  constructor(private readonly account:Pick<AccountSessionManager,'status'|'authorizeWork'>,private readonly owner:string,
    private readonly request:typeof fetch=fetch,private readonly processor=new DocumentProcessor()){}
  private assertOwner(){const state=this.account.status();if(state.state!=='active'||state.userId!==this.owner){this.forget();throw unavailable();}}
  private async call(command:ContextCommand,signal?:AbortSignal):Promise<ContextDocument[]>{
    try{return await this.exchange(command,signal);}catch(error){throw error instanceof RejectedChange?error:unavailable();}
  }
  private async exchange(command:ContextCommand,signal?:AbortSignal):Promise<ContextDocument[]>{
    this.assertOwner();const version=this.version,auth=await this.account.authorizeWork();this.assertOwner();
    if(this.ownerSignal!==auth.signal){this.ownerSignal?.removeEventListener('abort',this.forget);this.ownerSignal=auth.signal;auth.signal.addEventListener('abort',this.forget,{once:true});}
    if(auth.signal.aborted){this.forget();throw unavailable();}
    const abort=AbortSignal.any([auth.signal,AbortSignal.timeout(15000),...(signal?[signal]:[])]);
    const response=await this.request(`${ACCOUNT_ORIGIN}/api/account/native/context`,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:abort,
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${auth.accessToken}`},body:JSON.stringify(command)});
    if(!response.ok){await response.body?.cancel();if([400,413,429].includes(response.status))throw new RejectedChange();throw unavailable();}
    const reader=response.body?.getReader();if(!reader)throw unavailable();
    let size=0;const chunks:Uint8Array[]=[];
    try{while(true){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;
      if(size>6000000)throw unavailable();chunks.push(result.value);}}
    finally{await reader.cancel().catch(()=>undefined);}
    this.assertOwner();if(abort.aborted||version!==this.version)throw unavailable();
    return contextResult.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).documents;
  }
  private snapshot(documents:ContextDocument[]):ContextSnapshot{
    const valid=new Set(documents.map(doc=>doc.id));this.selected=new Set([...this.selected].filter(id=>valid.has(id)));
    return {documents,selectedIds:[...this.selected],pending:Boolean(this.pending)};
  }
  async list():Promise<ContextSnapshot>{if(this.busy)throw unavailable();return this.snapshot(await this.call({action:'LIST'}));}
  async select(input:unknown):Promise<ContextSnapshot>{
    if(this.busy||this.pending)throw unavailable();
    const command=contextCommand.parse({action:'READ',ids:input});if(command.action!=='READ')throw unavailable();
    const docs=await this.call({action:'LIST'}),valid=new Set(docs.map(doc=>doc.id));
    if(command.ids.some(id=>!valid.has(id)))throw unavailable();
    this.selected=new Set(command.ids);++this.version;return this.snapshot(docs);
  }
  async read(id:string):Promise<ContextDocument>{
    const command=contextCommand.parse({action:'READ',ids:[id]});const docs=await this.call(command);
    if(docs.length!==1)throw unavailable();return docs[0];
  }
  async change(input:unknown):Promise<ContextSnapshot>{
    const command=contextCommand.parse(input);if(!['SAVE','DELETE'].includes(command.action)||this.pending||this.busy)throw unavailable();
    this.pending=command;this.pendingUncertain=false;return this.retry();
  }
  async retry():Promise<ContextSnapshot>{
    if(!this.pending||this.busy)throw unavailable();this.busy=true;const command=this.pending;
    try{const docs=await this.call(command);this.pending=undefined;this.pendingUncertain=false;++this.version;return this.snapshot(docs);}
    catch(error){if(this.pending===command){
      if(error instanceof RejectedChange&&!this.pendingUncertain){this.pending=undefined;++this.version;}
      else if(!(error instanceof RejectedChange))this.pendingUncertain=true;
    }throw error;}
    finally{this.busy=false;}
  }
  async importFile(filePath:string,kind:unknown):Promise<ContextSnapshot>{
    this.assertOwner();if(this.busy||this.pending)throw unavailable();this.busy=true;
    let command:ContextCommand;
    try{const extracted=await this.processor.extract(filePath);this.assertOwner();command=contextCommand.parse({action:'SAVE',id:randomUUID(),operationId:randomUUID(),
      kind,name:path.basename(filePath).slice(0,120),body:extracted.text});}
    catch{throw new Error('Document could not be imported. Use readable PDF, DOCX, TXT or Markdown up to 20 MB and 120 KB extracted text.');}
    finally{this.busy=false;}
    return this.change(command);
  }
  async augment(prompt:string,signal:AbortSignal):Promise<string>{
    this.assertOwner();if(this.pending||this.busy)throw unavailable();
    const ids=[...this.selected];if(!ids.length)return prompt;
    const version=this.version,documents=await this.call({action:'READ',ids},signal);
    if(version!==this.version||signal.aborted)throw unavailable();
    // Refresh just before generation; deleted/unselected material cannot persist in
    // a local cache or next-session prompt. No whole-library fetch or idle polling.
    const current=new Set(documents.map(doc=>doc.id));this.selected=new Set(ids.filter(id=>current.has(id)));
    const result=prompt+selectedContextExcerpt(documents,prompt);
    if(result.length>120000)throw new AnswerError('Question and selected context exceed the answer limit. Reduce selected context.',true);
    return result;
  }
  /** augment() for a live answer. A document change that was never confirmed is sent again first (the same operation, so
   * it is never applied twice) instead of failing every answer until the app restarts, a momentary failure to load the
   * documents is tried once more, and a failure says what to do. */
  async augmentForAnswer(prompt:string,signal:AbortSignal):Promise<string>{
    this.assertOwner();
    if(!this.selected.size)return prompt; // nothing from the account goes with this answer
    if(this.pending&&!this.busy)this.resending=this.retry().catch(()=>undefined).finally(()=>{this.resending=undefined;});
    await this.resending;signal.throwIfAborted();
    if(this.busy)throw new AnswerError('Your documents are still being saved. Press Send to ask again in a moment.',true);
    if(this.pending)throw new AnswerError('Your last document change is not saved yet. Check your connection, then open Settings and tap Try again.',true);
    const started=performance.now();
    try{return await this.augment(prompt,signal);}
    catch(error){
      if(error instanceof AnswerError||signal.aborted)throw error;
      if(performance.now()-started<QUICK_FAILURE_MS){
        await delay(400,undefined,{signal});
        try{return await this.augment(prompt,signal);}
        catch(again){if(again instanceof AnswerError||signal.aborted)throw again;}
      }
      throw new AnswerError('Your saved documents could not be loaded for this answer. Check your connection, then press Send to ask again.',true);
    }
  }
}
