import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnswerContext, AppEventMap, AppEventName, AudioSourceDescriptor, SessionInput } from '../src/shared/types';
import type { AppConfig } from '../src/main/config/appConfig';
import { Database } from '../src/main/database/Database';
import { Repositories } from '../src/main/database/Repositories';
import { LocalRetriever } from '../src/main/retrieval/LocalRetriever';
import { ContextBuilder } from '../src/main/context/ContextBuilder';
import { SessionService } from '../src/main/app/SessionService';
import { DocumentProcessor } from '../src/main/documents/DocumentProcessor';
import { IntentDetector } from '../src/main/interview/IntentDetector';
import { TurnGate } from '../src/main/interview/TurnGate';
import { InterviewOrchestrator, mergeFinalCandidateText } from '../src/main/interview/InterviewOrchestrator';
import type { AnswerModel } from '../src/main/llm/AnswerModel';
import type { ScreenAnalysisRequest, ScreenAnalyzer } from '../src/main/screen/ScreenAnalyzer';

const runtime = path.join(process.cwd(), 'tests', '.runtime');
const input: SessionInput = { title:'Integration',role:'Engineer',company:'Acme',interviewType:'mixed',language:'English',answerStyle:'Natural',answerLength:'short',jobDescription:'React API role',resumeText:'Built React applications and secured APIs.',instructions:'Be honest.',selectedModel:'mock',saveTranscript:true };
const interviewer: AudioSourceDescriptor = { id:'mock-system',kind:'system',role:'remote_interviewer',label:'Mock system audio',canTriggerAnswers:true };
const candidate: AudioSourceDescriptor = { id:'candidate-microphone',kind:'microphone',role:'local_candidate',label:'Candidate microphone',canTriggerAnswers:false };
class ImmediateModel implements AnswerModel { readonly name='Mock streamed answer'; async *streamAnswer(context:AnswerContext):AsyncIterable<string>{ yield 'Grounded '; yield `answer to ${context.question}`; } }
class EmptyModel implements AnswerModel { readonly name='Empty model'; async *streamAnswer():AsyncIterable<string>{ return; yield ''; } }
class CapturingModel implements AnswerModel { readonly name='Context capture'; readonly seen:AnswerContext[]=[]; async *streamAnswer(context:AnswerContext):AsyncIterable<string>{this.seen.push(context);yield 'Screen-grounded answer';} }
class BlockingModel implements AnswerModel { readonly name='Blocking model'; readonly seen:AnswerContext[]=[]; private release!:()=>void; readonly finish=new Promise<void>(resolve=>{this.release=resolve;}); private markStarted!:()=>void; readonly started=new Promise<void>(resolve=>{this.markStarted=resolve;}); complete():void{this.release();} async *streamAnswer(context:AnswerContext):AsyncIterable<string>{this.seen.push(context);this.markStarted();yield 'First ';await this.finish;yield 'complete';} }
class ImmediateScreenAnalyzer implements ScreenAnalyzer {
  readonly name='Mock vision stream';
  seen:ScreenAnalysisRequest[]=[];
  async *streamAnalysis(request:ScreenAnalysisRequest){this.seen.push(request);request.onProviderRequest?.();request.onFirstToken?.();yield {type:'answer' as const,text:'Visible streamed answer'};yield {type:'context' as const,context:{sourceName:request.sourceName,capturedAt:request.capturedAt,visibleText:'const value = 1',currentTask:'Explain why the dependency array is required?',errorMessages:[],constraints:[],summary:'Visible code',confidence:.9}};}
}
const config:AppConfig={databasePath:'',isProduction:false,demoMode:true,debugMode:true,deepgram:{apiKey:'',model:'flux-general-en',language:'en',eotThreshold:.75,maxReconnects:2},gemini:{apiKey:'',model:'gemini',timeoutMs:1000},retrieval:{chunkSize:850,chunkOverlap:120,topK:5},screen:{enabled:true,maxBytes:5_000_000,maxDimension:2560,model:'gemini'},licensing:{enforced:false,serverUrl:'http://127.0.0.1:3000',publicKeyPem:''}};

describe('mock transcript integration pipeline', () => {
  let database:Database; let repositories:Repositories;
  it('stops an in-flight answer on access loss, discards late chunks, and permits a later normal start', async () => {
    const model = new BlockingModel(); const { session, orchestrator, events } = setup(model);
    await orchestrator.start(session.id, interviewer);
    const pending = orchestrator.answer({ sessionId: session.id, question: 'How do you secure an API?', origin: 'typed' });
    await model.started;
    await orchestrator.stop();
    const stoppedEvents = events.length;
    model.complete(); await pending;
    expect(events.slice(stoppedEvents).some(event => event.name === 'answer:token' || event.name === 'answer:completed')).toBe(false);
    expect(repositories.getDetail(session.id)!.questions[0].answer).toBeUndefined();
    await expect(orchestrator.injectMockTranscript(interviewer, 'What about logging?')).rejects.toThrow('Start an interview');
    await orchestrator.start(session.id, interviewer);
    expect(await orchestrator.answer({ sessionId: session.id, question: 'Explain logging.', origin: 'typed' })).toBe(true);
    await orchestrator.stop();
  });
  it('retains the complete session setup, behavior preferences and indexed context after restart', async () => {
    const service = new SessionService(repositories, new DocumentProcessor(), new LocalRetriever(repositories, config.retrieval));
    const session = service.save({ ...input, autoAnswer: true, saveTranscript: false,
      interviewUrl: 'https://example.com/careers/engineer', resumeFileName: 'my-resume.pdf', language: 'Telugu' });
    service.addText(session.id, 'supporting', 'Session supporting context', 'I implemented an event sourcing platform.');
    service.addExtracted(session.id, 'supporting', { name: 'notes.md', text: 'Postgres replication notes', mimeType: 'text/markdown', sizeBytes: 26 });
    database.close(); await database.initialize(); repositories = new Repositories(database);
    const detail = repositories.getDetail(session.id)!;
    expect(detail.session).toMatchObject({ ...session, autoAnswer: true, saveTranscript: false });
    expect(detail.documents.map((document) => document.name)).toEqual(expect.arrayContaining(['Session supporting context', 'notes.md']));
    expect(new LocalRetriever(repositories, config.retrieval).retrieve(session.id, 'event sourcing', 5)[0]?.text).toContain('event sourcing');
    // Older clients that don't supply new fields must not erase them on edit.
    expect(repositories.saveSession({ ...input, saveTranscript: undefined, id: session.id, title: 'Updated' })).toMatchObject({
      autoAnswer: true, saveTranscript: false, resumeFileName: 'my-resume.pdf', interviewUrl: session.interviewUrl,
    });
  });
  it('migrates old sessions without changing their prior recording and automatic-answer defaults', async () => {
    const session = repositories.saveSession(input);
    for (const column of ['auto_answer', 'save_transcript', 'interview_url', 'resume_file_name']) {
      database.connection().run(`ALTER TABLE sessions DROP COLUMN ${column}`);
    }
    database.close(); await database.initialize(); repositories = new Repositories(database);
    expect(repositories.getSession(session.id)).toMatchObject({ ...input, autoAnswer: false, saveTranscript: true, interviewUrl: '', resumeFileName: '' });
  });
  it('defaults new sessions to no transcript and preserves an explicit opt-in on edits/restart', async () => {
    const session = repositories.saveSession({ ...input, saveTranscript: undefined });
    expect(session.saveTranscript).toBe(false);
    repositories.addTurn(session.id, 'candidate', 'Ephemeral speech');
    expect(repositories.getDetail(session.id)!.conversation).toEqual([]);
    repositories.saveSession({ ...session, saveTranscript: true });
    const edited = repositories.saveSession({ ...session, saveTranscript: undefined, title: 'Edited' });
    expect(edited.saveTranscript).toBe(true);
    database.close(); await database.initialize(); repositories = new Repositories(database);
    expect(repositories.getSession(session.id)?.saveTranscript).toBe(true);
    expect(repositories.getDetail(session.id)!.conversation).toEqual([]);
  });
  it('uses unsaved speech as live context without putting it into transcript history', async () => {
    const model = new CapturingModel(); const { session, orchestrator } = setup(model, false);
    repositories.saveSession({ ...session, saveTranscript: false });
    await orchestrator.start(session.id, interviewer);
    await orchestrator.injectMockTranscript(interviewer, 'Let us discuss your production deployment.');
    await orchestrator.injectMockTranscript(candidate, 'I used staged rollouts.');
    await orchestrator.injectMockTranscript(candidate, 'We monitored the error rate.');
    expect(repositories.getDetail(session.id)!.conversation).toEqual([]);
    expect(repositories.contextTurns(session.id).filter((turn) => turn.speaker === 'candidate')).toHaveLength(1);
    await orchestrator.answer({ sessionId: session.id, question: 'Summarize what I said.', origin: 'typed' });
    expect(model.seen[0].recentConversation).toEqual(expect.arrayContaining([
      expect.objectContaining({ speaker: 'candidate', text: 'I used staged rollouts. We monitored the error rate.' }),
      expect.objectContaining({ speaker: 'interviewer', text: 'Let us discuss your production deployment.' }),
    ]));
    expect(repositories.getDetail(session.id)!.conversation.every((turn) => turn.speaker === 'copilot')).toBe(true);
    expect(repositories.getDetail(session.id)!.questions[0].answer).toBeDefined();
    const analyzer = new ImmediateScreenAnalyzer();
    await orchestrator.answerFromScreen({ sessionId: session.id, captureId: 'test-capture', signal: new AbortController().signal, question: 'Explain this screenshot.', sourceName: 'Code',
      capturedAt: new Date().toISOString(), optimizedImage: Promise.resolve({ bytes: Buffer.from('synthetic'), mimeType: 'image/png', width: 100, height: 100, preserveSmallText: true, resized: false }), analyzer });
    expect(analyzer.seen[0].context.recentConversation.some((turn) => turn.speaker === 'candidate')).toBe(true);
    orchestrator.setInteractionEnabled(false);
    expect(repositories.contextTurns(session.id).some((turn) => turn.speaker === 'candidate')).toBe(false);
    await orchestrator.stop();
  });
  it('bounds and isolates unrecorded speech and never reloads it from disk', async () => {
    const session = repositories.saveSession({ ...input, saveTranscript: false });
    const other = repositories.saveSession({ ...input, title: 'Different session' });
    for (let index = 0; index < 125; index++) repositories.addTurn(session.id, 'candidate', `Private speech ${index}`, candidate);
    expect(repositories.contextTurns(session.id, 120)).toHaveLength(120);
    expect(repositories.contextTurns(other.id)).toEqual([]);
    database.close(); await database.initialize(); repositories = new Repositories(database);
    expect(repositories.contextTurns(session.id)).toEqual([]);
    expect(repositories.getDetail(session.id)!.conversation).toEqual([]);
  });
  it('persists and indexes a supporting file staged before the session save', () => {
    const session = repositories.saveSession(input);
    const retriever = new LocalRetriever(repositories, config.retrieval);
    const service = new SessionService(repositories, new DocumentProcessor(), retriever);
    const document = service.addExtracted(session.id, 'supporting', {
      name: 'architecture-notes.md',
      mimeType: 'text/markdown',
      text: 'Event sourcing preserves an immutable sequence of domain changes.',
      sizeBytes: 64,
    });
    expect(document).toMatchObject({ name: 'architecture-notes.md', type: 'supporting', mimeType: 'text/markdown' });
    expect(retriever.retrieve(session.id, 'immutable event sourcing', 5)[0]?.documentId).toBe(document.id);
  });
  it('keeps streaming a shot while retaining incoming interviewer turns for follow-ups', async () => {
    const model = new CapturingModel(); const { session, events, orchestrator } = setup(model);
    await orchestrator.start(session.id, interviewer);
    let first!: () => void; const started = new Promise<void>(resolve => { first = resolve; });
    let finish!: () => void; const completed = new Promise<void>(resolve => { finish = resolve; });
    const analyzer: ScreenAnalyzer = { name: 'Slow vision', async *streamAnalysis(request) {
      yield { type: 'answer', text: 'The issue is' };
      first(); await completed;
      yield { type: 'answer', text: ' a missing dependency.' };
      yield { type: 'context', context: { sourceName: request.sourceName, capturedAt: request.capturedAt, visibleText: 'useEffect', errorMessages: ['Missing dependency'], constraints: [], summary: 'React effect dependency', confidence: .9, technologies: ['React'] } };
    } };
    const pending = orchestrator.answerFromScreen({ sessionId: session.id, question: 'What is wrong here?', sourceName: 'Code', capturedAt: new Date().toISOString(), optimizedImage: Promise.resolve({ bytes: Buffer.from('private image bytes'), mimeType: 'image/png', width: 800, height: 600, preserveSmallText: true, resized: false }), analyzer, signal: new AbortController().signal });
    try {
      await started;
      expect(events.some(event => event.name === 'answer:token')).toBe(true);
      expect(events.some(event => event.name === 'answer:completed')).toBe(false);
      await orchestrator.injectMockTranscript(interviewer, 'Why did you choose React?');
      expect(model.seen).toHaveLength(0);
      expect(repositories.getDetail(session.id)!.conversation.some(turn => turn.text.includes('Why did you choose React'))).toBe(true);
    } finally { finish(); }
    await pending;
    await orchestrator.answer({ sessionId: session.id, question: 'How do I fix it?' });
    expect(model.seen[0].screenContext?.summary).toBe('React effect dependency');
    expect(JSON.stringify(repositories.getDetail(session.id))).not.toContain('private image bytes');
  });
  it('cancels during shot preparation without calling the vision provider', async () => {
    const { session, orchestrator } = setup();
    const analyzer = new ImmediateScreenAnalyzer(); const cancel = new AbortController();
    let imageReady!: (value: import('../src/main/screen/ScreenImageOptimizer').OptimizedScreenImage) => void;
    const optimizedImage = new Promise<import('../src/main/screen/ScreenImageOptimizer').OptimizedScreenImage>(resolve => { imageReady = resolve; });
    const pending = orchestrator.answerFromScreen({ sessionId: session.id, question: 'Explain this code.', sourceName: 'Code', capturedAt: new Date().toISOString(), optimizedImage, analyzer, signal: cancel.signal });
    cancel.abort(); imageReady({ bytes: Buffer.from('image'), mimeType: 'image/png', width: 800, height: 600, preserveSmallText: true, resized: false });
    await expect(pending).rejects.toThrow();
    expect(analyzer.seen).toHaveLength(0);
    expect(repositories.getDetail(session.id)!.questions[0].answer).toBeUndefined();
  });
  it('does not leak retained screenshot context into another session', async () => {
    const model = new CapturingModel(); const { session, orchestrator } = setup(model);
    await orchestrator.answer({ sessionId: session.id, question: 'First question?' });
    orchestrator.setScreenContext({ sourceName: 'Private source', capturedAt: new Date().toISOString(), visibleText: 'private text', errorMessages: [], constraints: [], summary: 'Session A screen', confidence: .9 }, session.id);
    const other = repositories.saveSession({ ...input, title: 'Other session' });
    await orchestrator.answer({ sessionId: other.id, question: 'What is wrong here?' });
    expect(model.seen[1].screenContext).toBeUndefined();
  });
  beforeEach(async()=>{fs.mkdirSync(runtime,{recursive:true});database=new Database(path.join(runtime,`${randomUUID()}.sqlite`));await database.initialize();repositories=new Repositories(database);});
  afterEach(()=>{database.close();fs.rmSync(runtime,{recursive:true,force:true});});
  function setup(model:AnswerModel=new ImmediateModel(), autoAnswerEnabled=true){const session=repositories.saveSession(input);const retriever=new LocalRetriever(repositories,config.retrieval);const events:Array<{name:AppEventName;payload:unknown}>=[];
    const emit=<K extends AppEventName>(name:K,payload:AppEventMap[K]):void=>{events.push({name,payload});};
    const orchestrator=new InterviewOrchestrator(config,repositories,new IntentDetector(),new TurnGate(),new ContextBuilder(repositories,retriever),model,emit);if(autoAnswerEnabled)orchestrator.setAutoAnswerEnabled(true);return{session,events,orchestrator};}
  it('transcribes both sources during device check while blocking AI and persistence until Start',async()=>{const model=new CapturingModel();const {session,events,orchestrator}=setup(model);await orchestrator.start(session.id,interviewer,false);await orchestrator.injectMockTranscript(interviewer,'Can you explain dependency injection?');await orchestrator.injectMockTranscript(candidate,'My microphone test is clear.');const preStartDetail=repositories.getDetail(session.id)!;const finals=events.filter((event)=>event.name==='transcript:final').map((event)=>event.payload as AppEventMap['transcript:final']);expect(finals.map((event)=>event.sourceRole)).toEqual(expect.arrayContaining(['remote_interviewer','local_candidate']));expect(preStartDetail.questions).toHaveLength(0);expect(preStartDetail.conversation).toHaveLength(0);expect(model.seen).toHaveLength(0);await expect(orchestrator.answer({sessionId:session.id,question:'Do not send this yet.',origin:'typed'})).rejects.toThrow('Click Start');orchestrator.setInteractionEnabled(true);await orchestrator.injectMockTranscript(interviewer,'How would you secure an API?');const startedDetail=repositories.getDetail(session.id)!;expect(startedDetail.questions).toHaveLength(1);expect(startedDetail.questions[0].answer?.text).toBe('Screen-grounded answer');expect(model.seen).toHaveLength(1);});
  it('keeps Auto Answer off by default and accumulates paused interviewer segments until manual Send',async()=>{const {session,events,orchestrator}=setup(new ImmediateModel(),false);await orchestrator.start(session.id,interviewer);await orchestrator.injectMockTranscript(interviewer,'Can you explain');await orchestrator.injectMockTranscript(interviewer,'how dependency injection works?');expect(repositories.getDetail(session.id)!.questions).toHaveLength(0);const finals=events.filter((event)=>event.name==='transcript:final').map((event)=>event.payload as AppEventMap['transcript:final']);expect(finals.at(-1)?.text).toBe('Can you explain how dependency injection works?');expect(await orchestrator.answer({sessionId:session.id,question:'Can you explain how dependency injection works?',origin:'transcript'})).toBe(true);const detail=repositories.getDetail(session.id)!;expect(detail.questions).toHaveLength(1);expect(detail.questions[0].answer?.text).toContain('Grounded answer');expect(detail.conversation.filter((turn)=>turn.speaker==='interviewer')).toHaveLength(2);});
  it('streams and saves an answer for a remote interviewer final turn and suppresses duplicates',async()=>{const {session,events,orchestrator}=setup();await orchestrator.start(session.id,interviewer);await orchestrator.injectMockTranscript(interviewer,'How have you used React in production?');await orchestrator.injectMockTranscript(interviewer,'How have you used React in production?');const detail=repositories.getDetail(session.id)!;expect(detail.questions).toHaveLength(1);expect(detail.questions[0].answer?.text).toContain('Grounded answer');expect(events.some((event)=>event.name==='answer:token')).toBe(true);});
  it('does not create another answer when Chat manually submits an automatically answered question',async()=>{const {session,orchestrator}=setup();await orchestrator.start(session.id,interviewer);await orchestrator.injectMockTranscript(interviewer,'How would you secure an API?');expect(await orchestrator.answer({sessionId:session.id,question:'how would you secure an api'})).toBe(false);expect(repositories.getDetail(session.id)!.questions).toHaveLength(1);});
  it('allows deliberately typed text even when it repeats an automatically handled question',async()=>{const {session,orchestrator}=setup();await orchestrator.start(session.id,interviewer);await orchestrator.injectMockTranscript(interviewer,'How would you secure an API?');expect(await orchestrator.answer({sessionId:session.id,question:'How would you secure an API?',origin:'typed'})).toBe(true);expect(repositories.getDetail(session.id)!.questions).toHaveLength(2);});
  it('accepts a typed question while live audio is paused',async()=>{const {session,events,orchestrator}=setup();await orchestrator.start(session.id,interviewer);orchestrator.pause(true);expect(await orchestrator.answer({sessionId:session.id,question:'Explain dependency injection?'})).toBe(true);const detail=repositories.getDetail(session.id)!;expect(detail.questions).toHaveLength(1);expect(detail.questions[0].answer?.text).toContain('Grounded answer');expect(events.some((event)=>event.name==='answer:started')).toBe(true);expect(events.at(-1)).toMatchObject({name:'copilot:status',payload:{status:'paused'}});});
  it('does not duplicate an automatic question while its answer is still streaming',async()=>{const model=new BlockingModel();const {session,orchestrator}=setup(model);await orchestrator.start(session.id,interviewer);const pending=orchestrator.injectMockTranscript(interviewer,'How would you diagnose a slow API?');await model.started;await orchestrator.answer({sessionId:session.id,question:'How would you diagnose a slow API?'});expect(repositories.getDetail(session.id)!.questions).toHaveLength(1);model.complete();await pending;});
  it('still allows an explicit answer transformation for a handled question',async()=>{const {session,orchestrator}=setup();await orchestrator.start(session.id,interviewer);await orchestrator.injectMockTranscript(interviewer,'How would you secure an API?');await orchestrator.answer({sessionId:session.id,question:'How would you secure an API?',mode:'shorter'});expect(repositories.getDetail(session.id)!.questions).toHaveLength(2);});
  it('retains non-question interviewer turns as later session context',async()=>{const {session,orchestrator}=setup();await orchestrator.start(session.id,interviewer);await orchestrator.injectMockTranscript(interviewer,'Next we will discuss graph traversal and shortest paths.');expect(repositories.getDetail(session.id)!.conversation.some((turn)=>turn.text.includes('graph traversal'))).toBe(true);});
  it('stores candidate speech as context without triggering an answer',async()=>{const model=new CapturingModel();const {session,orchestrator}=setup(model);await orchestrator.start(session.id,interviewer);await orchestrator.injectMockTranscript(candidate,'I explained that I used a queue for breadth first search.');expect(repositories.getDetail(session.id)!.questions).toHaveLength(0);await orchestrator.answer({sessionId:session.id,question:'What did I just explain?'});expect(model.seen[0].recentConversation.some((turn)=>turn.speaker==='candidate'&&turn.text.includes('breadth first search'))).toBe(true);expect(repositories.getDetail(session.id)!.conversation.some((turn)=>turn.speaker==='candidate')).toBe(true);});
  it('groups candidate final segments and associates them with the active question',async()=>{const {session,orchestrator}=setup();await orchestrator.start(session.id,interviewer);await orchestrator.injectMockTranscript(interviewer,'Tell me about a difficult technical problem you solved?');const question=repositories.getDetail(session.id)!.questions[0];await orchestrator.injectMockTranscript(candidate,'At my previous company, we had an API latency issue.');await orchestrator.injectMockTranscript(candidate,'I profiled the service and discovered a slow database query.');const detail=repositories.getDetail(session.id)!;const candidateTurns=detail.conversation.filter((turn)=>turn.speaker==='candidate');expect(detail.questions).toHaveLength(1);expect(candidateTurns).toHaveLength(1);expect(candidateTurns[0]).toMatchObject({questionId:question.id,sourceRole:'local_candidate',canTriggerAnswers:false});expect(candidateTurns[0].text).toContain('API latency issue. I profiled');});
  it('persists candidate speech while the AI suggestion is still streaming',async()=>{const model=new BlockingModel();const {session,orchestrator}=setup(model);await orchestrator.start(session.id,interviewer);const pending=orchestrator.injectMockTranscript(interviewer,'How would you diagnose a slow API?');await model.started;await orchestrator.injectMockTranscript(candidate,'I would begin by checking latency percentiles and traces.');expect(repositories.getDetail(session.id)!.conversation.some((turn)=>turn.speaker==='candidate'&&turn.text.includes('latency percentiles'))).toBe(true);model.complete();await pending;});
  it('keeps an in-progress candidate response linked to the preceding question',async()=>{const {session,orchestrator}=setup();await orchestrator.start(session.id,interviewer);await orchestrator.injectMockTranscript(interviewer,'Tell me about your API project?');const firstQuestion=repositories.getDetail(session.id)!.questions[0];await orchestrator.injectMockTranscript(candidate,'I started by profiling',false);expect(repositories.getDetail(session.id)!.conversation.filter((turn)=>turn.speaker==='candidate')).toHaveLength(0);await orchestrator.injectMockTranscript(interviewer,'What did you find next?');await orchestrator.injectMockTranscript(candidate,'I started by profiling and found a slow query.');const candidateTurn=repositories.getDetail(session.id)!.conversation.find((turn)=>turn.speaker==='candidate');expect(candidateTurn?.questionId).toBe(firstQuestion.id);});
  it('merges cumulative and overlapping candidate finals without duplicating words',()=>{expect(mergeFinalCandidateText('I profiled the API','I profiled the API and found the query')).toBe('I profiled the API and found the query');expect(mergeFinalCandidateText('I checked the API latency','API latency before changing the query')).toBe('I checked the API latency before changing the query');});
  it('retains approved screen context for follow-up prompts until explicitly cleared',async()=>{const model=new CapturingModel();const {session,orchestrator}=setup(model);await orchestrator.start(session.id,interviewer);orchestrator.setScreenContext({sourceName:'Chrome',capturedAt:new Date().toISOString(),visibleText:'Graph problem',errorMessages:[],constraints:['Python'],summary:'Shortest path task',confidence:.9},session.id);await orchestrator.answer({sessionId:session.id,question:'Solve this in Python.'});await orchestrator.answer({sessionId:session.id,question:'Now explain the complexity.'});expect(model.seen).toHaveLength(2);expect(model.seen.every((context)=>context.screenContext?.summary==='Shortest path task')).toBe(true);});
  it('falls back to complete resume and job context for broad prompts with no lexical match',async()=>{const model=new CapturingModel();const {session,orchestrator}=setup(model);await orchestrator.answer({sessionId:session.id,question:'Introduce yourself briefly.'});expect(model.seen[0].resumeContext[0]?.text).toContain('Built React applications');expect(model.seen[0].jobContext[0]?.text).toContain('React API role');});
  it('does not attach broad resume and job fallbacks to an unrelated simple technical question',async()=>{const model=new CapturingModel();const {session,orchestrator}=setup(model);await orchestrator.answer({sessionId:session.id,question:'What is dependency injection?'});expect(model.seen[0].resumeContext).toEqual([]);expect(model.seen[0].jobContext).toEqual([]);});
  it('processes a typed manual-interviewer question without starting audio',async()=>{const {session,events,orchestrator}=setup();await orchestrator.answer({sessionId:session.id,question:'How would you secure an API?'});const detail=repositories.getDetail(session.id)!;expect(detail.questions).toHaveLength(1);expect(detail.questions[0].answer?.text).toContain('Grounded answer');expect(events.some((event)=>event.name==='answer:completed')).toBe(true);});
  it('keeps the detailed screen instruction hidden and resolves a short visible question',async()=>{const {session,events,orchestrator}=setup();const analyzer=new ImmediateScreenAnalyzer();const timing:string[]=[];const hiddenInstruction='Analyze the screenshot using the full interview context and produce the best grounded answer without asking for another instruction.';const context=await orchestrator.answerFromScreen({sessionId:session.id,question:hiddenInstruction,displayQuestion:'Answer the question detected from the screenshot',sourceName:'VS Code',capturedAt:new Date().toISOString(),optimizedImage:Promise.resolve({bytes:Buffer.from('image'),mimeType:'image/png',width:1280,height:720,preserveSmallText:true,resized:false}),analyzer,signal:new AbortController().signal,onTiming:(mark)=>timing.push(mark)});const detail=repositories.getDetail(session.id)!;expect(context.summary).toBe('Visible code');expect(detail.questions[0].text).toBe('Explain why the dependency array is required?');expect(detail.questions[0].answer?.text).toBe('Visible streamed answer');expect(detail.conversation.some((turn)=>turn.text===hiddenInstruction)).toBe(false);expect(analyzer.seen[0].question).toBe(hiddenInstruction);expect(analyzer.seen[0].context.resumeContext).toEqual([]);expect(events.some((event)=>event.name==='question:resolved')).toBe(true);expect(events.some((event)=>event.name==='answer:token')).toBe(true);expect(timing).toContain('first-token');});
  it('reports an error instead of marking an empty provider response ready',async()=>{const {session,events,orchestrator}=setup(new EmptyModel());expect(await orchestrator.answer({sessionId:session.id,question:'How would you secure an API?'})).toBe(false);const detail=repositories.getDetail(session.id)!;expect(detail.questions[0].answer).toBeUndefined();expect(events.some((event)=>event.name==='answer:completed')).toBe(false);expect(events.some((event)=>event.name==='app:error')).toBe(true);});
  it('cascades new source and screen-context records when a session is deleted',()=>{const {session}=setup();repositories.saveAudioSource(session.id,interviewer);repositories.saveScreenContext(session.id,{sourceName:'Editor',capturedAt:new Date().toISOString(),visibleText:'code',errorMessages:[],constraints:[],summary:'code',confidence:.8});expect(database.all('SELECT * FROM session_audio_sources')).toHaveLength(1);expect(database.all('SELECT * FROM screen_contexts')).toHaveLength(1);repositories.deleteSession(session.id);expect({sources:database.all('SELECT * FROM session_audio_sources').length,screens:database.all('SELECT * FROM screen_contexts').length}).toEqual({sources:0,screens:0});});
});
