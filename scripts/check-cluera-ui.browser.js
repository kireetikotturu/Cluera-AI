async (page) => {
 const context=await page.context().browser().newContext({viewport:{width:1280,height:800},storageState:{cookies:[],origins:[]}});
 const p=await context.newPage(),errors=[],requests=[],checks=[];
 p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>requests.push({method:r.method(),url:r.url()}));
 await context.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:43690/')?route.continue():route.abort());
 await context.addInitScript(()=>{
  const active={mode:'cluera-staging',state:'active',userId:'synthetic-owner',email:'synthetic@example.invalid'};
  const credits={state:'ready',refreshing:false,active:false,activeMilliseconds:0,snapshot:{userId:active.userId,displayName:'Synthetic tester',serverTime:new Date().toISOString(),availableMilliseconds:900000,reservedMilliseconds:0,spentMilliseconds:0,buckets:[{kind:'TRIAL',grantedMilliseconds:900000,spentMilliseconds:0,reservedMilliseconds:0,availableMilliseconds:900000}],plans:[],payments:[],checkoutAvailable:false}};
  const settings={theme:'dark',overlayOpacity:.96,privateMode:true,debugMode:false,demoMode:false,shortcuts:{},geminiModel:'flash',deepgramModel:'flux'};
  const provider={providerMode:'managed',demoMode:false,deepgramConfigured:true,geminiConfigured:true,databasePath:'synthetic',models:['flash'],modelOptions:[{provider:'gemini',modelId:'flash',displayName:'Approved synthetic model',description:'UI fixture'}],defaultGeminiModel:'flash',deepgramModelOptions:[{provider:'deepgram',modelId:'flux',displayName:'Synthetic transcription',description:'UI fixture'}],defaultDeepgramModel:'flux',screenAnalysisEnabled:true};
  let sessions=[],detail;window.__fixtureCalls=[];
  window.accountAPI={status:async()=>location.hash==='#active'?active:{mode:'cluera-staging',state:'signed-out'},onStatus:()=>()=>{},
   login:async()=>{window.__fixtureCalls.push('login');return {mode:'cluera-staging',state:'signed-out',message:'Synthetic rejected sign-in'};},google:async()=>({mode:'cluera-staging',state:'signed-out'}),retry:async()=>({mode:'cluera-staging',state:'signed-out'}),logout:async()=>({mode:'cluera-staging',state:'signed-out'}),openWeb:async action=>{window.__fixtureCalls.push('web:'+action);},
   credits:{refresh:async()=>credits,onChange:()=>()=>{}},context:{list:async()=>({documents:[],selectedIds:[],version:0}),onChange:()=>()=>{}}};
  window.electronAPI={bridgeVersion:'synthetic-v1',onEvent:()=>()=>{},getUpdateStatus:async()=>({state:'current',currentVersion:'1.0.0',sessionActive:false}),checkForUpdates:async()=>({state:'current'}),
   getProviderStatus:async()=>{
    if(window.__fixtureProviderState==='disabled')return {...provider,modelOptions:[],deepgramModelOptions:[]};
    if(window.__fixtureProviderState==='pending')return new Promise(resolve=>{window.__resolveProvider=()=>resolve(provider);});
    return provider;
   },getSettings:async()=>settings,saveSettings:async next=>next,listSessions:async()=>sessions,getSession:async()=>detail??null,listLibraryFiles:async()=>[],
   uploadLibraryFile:async kind=>({libraryFileId:'synthetic-file',name:'Synthetic resume.txt',text:'Synthetic resume content',sizeBytes:24,category:kind}),
   saveSession:async input=>{window.__fixtureCalls.push('save');const now=new Date().toISOString(),session={...input,id:'synthetic-session',createdAt:now,updatedAt:now};sessions=[session];detail={session,documents:[],conversation:[],questions:[],answers:[],rounds:[]};return session;},
   addTextDocument:async()=>({id:'synthetic-document'}),addExtractedDocument:async()=>({id:'synthetic-file'}),deleteSession:async()=>{},removeDocument:async()=>{},
   startInterview:async()=>{window.__fixtureCalls.push('blocked-synthetic-start');throw new Error('Synthetic preview: AI START unavailable.');},
   setAutoAnswer:async value=>value,setInterviewInteractionEnabled:async value=>value,stopInterview:async()=>{},setSessionWindowMode:async()=>{},setLiveCollapsed:async()=>{},adjustZoom:async()=>1,closeWindow:async()=>{},openExternal:async()=>{},getSelectedScreenSource:async()=>null,listDesktopCaptureSources:async()=>[],getRoundHistory:async()=>({items:[],page:0,total:0})};
 });
 const assert=(ok,name,detail)=>{if(!ok)throw Error(name+' '+JSON.stringify(detail));checks.push(name);};
 const geometry=()=>p.evaluate(()=>({width:innerWidth,doc:document.documentElement.scrollWidth,height:innerHeight}));
 try{
  for(const viewport of [{width:1280,height:800},{width:800,height:600}]){
   await p.setViewportSize(viewport);await p.goto('http://127.0.0.1:43690/desktop/login');await p.getByRole('heading',{name:'Welcome back.'}).waitFor();await p.evaluate(()=>document.fonts.ready);
   assert((await geometry()).doc<=viewport.width,'login no horizontal clipping '+viewport.width,await geometry());
   await p.getByRole('button',{name:'Create account',exact:true}).click();assert((await p.evaluate(()=>window.__fixtureCalls)).includes('web:signup'),'signup fixed browser handoff');
   await p.locator('input[type=email]').fill('synthetic@example.invalid');await p.locator('input[type=password]').fill('synthetic-only');await p.getByRole('button',{name:'Show password'}).click();assert(await p.locator('input[type=text]').count()===1,'password visibility');
   await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.getByText('Synthetic rejected sign-in').waitFor();assert(await p.locator('input[type=password]').inputValue()==='','password cleared after rejection');
  }
  await p.setViewportSize({width:1280,height:800});await p.goto('http://127.0.0.1:43690/desktop/home#active');await p.getByText('No sessions yet').waitFor();
  assert((await geometry()).doc<=1280,'dashboard no horizontal overflow');await p.screenshot({path:'C:/Users/kiree/Downloads/sigmaroundAI Copies/products/cluera-ai/.test-output/cluera-desktop-dashboard.png'});
  await p.setViewportSize({width:800,height:600});
  await p.evaluate(()=>{window.__fixtureProviderState='disabled';const content=document.querySelector('.dashboard-content');content.scrollTop=content.scrollHeight;});
  await p.getByRole('button',{name:'Create Session',exact:true}).last().click();
  const alert=p.getByRole('alert');await alert.filter({hasText:'administrator'}).waitFor();
  assert(await alert.evaluate(el=>document.activeElement===el),'disabled model failure receives focus');
  const alertBounds=await alert.boundingBox();assert(alertBounds&&alertBounds.y>=0&&alertBounds.y+alertBounds.height<=600,'disabled model reason visible',alertBounds);
  assert((await p.evaluate(()=>window.__fixtureCalls.filter(x=>x==='save').length))===0,'disabled models cannot save a session');
  await p.screenshot({path:'C:/Users/kiree/Downloads/sigmaroundAI Copies/products/cluera-ai/.test-output/cluera-desktop-session-blocked.png'});
  await p.evaluate(()=>{window.__fixtureProviderState='pending';});
  await p.getByRole('button',{name:'Create Session',exact:true}).first().click();
  await p.getByText('Checking session setup…',{exact:true}).waitFor();
  assert(await p.getByRole('button',{name:'Checking…',exact:true}).first().isDisabled(),'session check shows progress and disables repeated clicks');
  await p.evaluate(()=>{window.__fixtureProviderState='ready';window.__resolveProvider();});
  await p.getByPlaceholder('Frontend interview at Acme').waitFor();
  for(const viewport of [{width:1280,height:800},{width:1000,height:600},{width:420,height:360},{width:800,height:600}]){
   await p.setViewportSize(viewport);const g=await p.locator('.wizard-actions').boundingBox();assert(!!g&&g.y>=0&&g.y+g.height<=viewport.height+1,'session footer visible '+viewport.width,g);assert((await geometry()).doc<=viewport.width,'session no horizontal clipping '+viewport.width,await geometry());
  }
  await p.screenshot({path:'C:/Users/kiree/Downloads/sigmaroundAI Copies/products/cluera-ai/.test-output/cluera-desktop-session-800.png'});
  await p.getByPlaceholder('Frontend interview at Acme').fill('Synthetic UI session');await p.getByPlaceholder('Acme Inc.').fill('Synthetic company');await p.getByPlaceholder('Software Engineer').fill('Engineer');
  await p.getByRole('button',{name:'Upload resume',exact:true}).click();await p.getByPlaceholder('Paste or type the job description...').fill('Synthetic description');await p.getByLabel('Supporting context text').fill('Synthetic supporting notes');
  await p.getByRole('button',{name:'Create Session',exact:true}).click();await p.locator('.copilot-page, .copilot').first().waitFor({state:'visible',timeout:5000}).catch(()=>{});
  assert((await p.evaluate(()=>window.__fixtureCalls.filter(x=>x==='save').length))===1,'exactly one synthetic session save');assert((await geometry()).doc<=800,'live workspace no horizontal clipping');
  await p.getByText('Synthetic preview: AI START unavailable.',{exact:true}).waitFor();
  assert((await p.evaluate(()=>window.__fixtureCalls.filter(x=>x==='blocked-synthetic-start').length))===1,'synthetic AI START explicitly blocked, not a missing bridge method');
  await p.screenshot({path:'C:/Users/kiree/Downloads/sigmaroundAI Copies/products/cluera-ai/.test-output/cluera-desktop-live-800.png'});
  assert(errors.length===0,'desktop renderer no page errors',errors);assert(requests.every(r=>r.method==='GET'),'desktop synthetic preview zero HTTP writes');
  return {synthetic:true,checks,requests:requests.length,pageErrors:errors,providerRequests:requests.filter(r=>!r.url.startsWith('http://127.0.0.1:43690/')).length};
 }finally{await context.close();}
}
