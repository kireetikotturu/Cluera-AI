import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {AccountApi,AccountApiError,type AccountTokens} from './AccountApi';

export const NATIVE_GOOGLE_CALLBACK='http://127.0.0.1:43822/cluera/callback';
/** One bounded loopback listener per explicit login attempt. No tokens, verifier,
 * user content or external scripts are returned to the browser. */
export async function googleAccountLogin(open:(url:string)=>Promise<void>,signal:AbortSignal,
  api=new AccountApi()):Promise<AccountTokens>{
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
  response.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});response.end('Return to Cluera to finish signing in. You can close this tab.');complete(code);
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
  return await api.oauthExchange(code,verifier,signal);
 }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);server.close();server.closeAllConnections();}
}
