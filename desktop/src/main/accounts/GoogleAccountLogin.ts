import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {AccountApi,AccountApiError,type AccountTokens} from './AccountApi';

export const NATIVE_GOOGLE_CALLBACK='http://127.0.0.1:43822/cluera/callback';
/** The page the browser shows after Google. It tries to close its own tab, which browsers allow only for some tabs;
 * otherwise the customer is told they can close it. Its one fixed script is the only script its policy allows. */
const CLOSE_TAB_SCRIPT="setTimeout(function(){window.close()},1500)";
const RETURN_PAGE='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  +'<title>Cluera AI · Sign-in</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c14;color:#eef0ff;font:16px/1.5 system-ui,sans-serif}'
  +'main{max-width:420px;padding:28px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#b8bbd4}</style></head>'
  +'<body><main><h1>Return to Cluera AI</h1><p>Cluera AI is finishing your sign-in and has come back on your screen. You can close this tab.</p></main>'
  +`<script>${CLOSE_TAB_SCRIPT}</script></body></html>`;
const RETURN_PAGE_POLICY=`default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(CLOSE_TAB_SCRIPT).digest('base64')}'; frame-ancestors 'none'`;
/** One bounded loopback listener per explicit login attempt. No tokens, verifier,
 * user content or external scripts are returned to the browser. `returned` runs as soon as the browser sends the
 * customer back, before the sign-in is finished, so the app can come back on screen at once. */
export async function googleAccountLogin(open:(url:string)=>Promise<void>,signal:AbortSignal,
  api=new AccountApi(),returned:()=>void=()=>undefined):Promise<AccountTokens>{
 if(signal.aborted)throw new AccountApiError(401);
 // Renderer capability is display-only. Recheck the fixed server capability on
 // every deliberate attempt before opening a browser or binding the callback.
 const options=await api.authOptions(signal);
 if(signal.aborted)throw new AccountApiError(401);
 if(options.google!=='enabled')throw new AccountApiError(503);
 const verifier=randomBytes(48).toString('base64url'),state=randomBytes(32).toString('hex');
 const challenge=createHash('sha256').update(verifier).digest('base64url');
 const authorize=new URL('https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/authorize');
 authorize.search=new URLSearchParams({provider:'google',redirect_to:`${NATIVE_GOOGLE_CALLBACK}?state=${state}`,code_challenge:challenge,code_challenge_method:'s256'}).toString();
 let complete!:(code:string)=>void,fail!:(error:Error)=>void,accepted=false;
 const callback=new Promise<string>((resolve,reject)=>{complete=resolve;fail=reject;});
 // Attach immediately so cancellation before browser launch never rejects unobserved.
 void callback.catch(()=>undefined);
 const abort=()=>fail(new AccountApiError(401));
 const timer=setTimeout(abort,300000);timer.unref?.();
 const server=createServer({maxHeaderSize:4096,requestTimeout:5000,headersTimeout:5000},(request,response)=>{
  response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");response.setHeader('Connection','close');
  let url:URL;
  try{url=new URL(request.url??'/',NATIVE_GOOGLE_CALLBACK);}
  catch{response.writeHead(400);response.end('Invalid sign-in callback.');return;}
  const received=url.searchParams.get('state')??'';
  const valid=request.method==='GET'&&request.socket.remoteAddress==='127.0.0.1'&&request.headers.host==='127.0.0.1:43822'
   &&!request.headers.origin&&request.url?.startsWith('/cluera/callback?')&&url.origin===new URL(NATIVE_GOOGLE_CALLBACK).origin
   &&url.pathname==='/cluera/callback'&&url.searchParams.getAll('state').length===1&&/^[a-f0-9]{64}$/.test(received)
   &&timingSafeEqual(Buffer.from(received),Buffer.from(state))&&!accepted;
  const code=url.searchParams.get('code');
  if(!valid){response.writeHead(400);response.end('Invalid sign-in callback.');return;}
  accepted=true;
  if(!code||code.length>1024||url.searchParams.getAll('code').length!==1||url.searchParams.has('error')){response.writeHead(400);response.end('Sign-in was not completed. Return to Cluera.');abort();return;}
  response.setHeader('Content-Security-Policy',RETURN_PAGE_POLICY);
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(RETURN_PAGE);complete(code);
 });
 server.maxConnections=4;server.on('error',()=>fail(new AccountApiError(503)));
 signal.addEventListener('abort',abort,{once:true});
 try{
  if(signal.aborted)throw new AccountApiError(401);
  await new Promise<void>((resolve,reject)=>{server.once('error',()=>reject(new AccountApiError(503)));server.listen(43822,'127.0.0.1',()=>resolve());});
  if(signal.aborted)throw new AccountApiError(401);
  // The OS opener may never settle. Cancellation/deadline and a valid callback
  // still finish this attempt and release the single loopback listener.
  await Promise.race([open(authorize.toString()),callback.then(()=>undefined)]);
  const code=await callback;if(signal.aborted)throw new AccountApiError(401);
  returned();
  return await api.oauthExchange(code,verifier,signal);
 }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);server.close();server.closeAllConnections();}
}
