import { createServer } from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { MAX_FRAME_BYTES } from './protocol';
import { attachRelaySession } from './session';
import type {RelayConfig} from './config';
import {PROVIDER_METADATA_PATH,providerStatusResponse,verifyProviderStatusRequest} from './providerMetadata';
import {INFRASTRUCTURE_STATUS_PATH,infrastructureStatusResponse,verifyInfrastructureStatusRequest} from './infrastructureMetadata';

/** Persistent Node server, NOT a Next/Vercel function. TLS must terminate at the
 * private container ingress. No access logging of paths/headers/bodies/tokens. */
export function createRelayServer(dependencies: Parameters<typeof attachRelaySession>[1]&{internalRequest?:(request:IncomingMessage,response:ServerResponse)=>boolean},revision?:string,metadata?:RelayConfig,databaseCheck?:()=>Promise<boolean>) {
  let statusAttempts=0,statusWindow=performance.now();
  let infrastructureAttempts=0,infrastructureWindow=performance.now(),infrastructureBusy=false;
  const infrastructureNonces=new Map<string,number>();
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', 'application/json');
    if(dependencies.internalRequest?.(request,response))return;
    if(metadata&&databaseCheck&&request.url===INFRASTRUCTURE_STATUS_PATH){
      const now=Date.now(),elapsed=performance.now();
      if(elapsed-infrastructureWindow>=60000){infrastructureWindow=elapsed;infrastructureAttempts=0;}
      for(const [nonce,expiry] of infrastructureNonces)if(expiry<now)infrastructureNonces.delete(nonce);
      const header=(name:string)=>typeof request.headers[name]==='string'?request.headers[name] as string:'';
      const nonce=header('x-cluera-nonce'),key=Buffer.from(metadata.rateKey,'base64');
      const valid=request.method==='GET'&&!request.headers.origin&&!request.headers.cookie&&!request.headers.authorization
        &&!request.headers['transfer-encoding']&&(!request.headers['content-length']||request.headers['content-length']==='0')
        &&verifyInfrastructureStatusRequest(key,{timestamp:header('x-cluera-time'),nonce,signature:header('x-cluera-proof')},now);
      if(!valid||infrastructureNonces.has(nonce)||infrastructureBusy||++infrastructureAttempts>12){response.writeHead(403);response.end('{"error":"Unavailable."}');return;}
      infrastructureNonces.set(nonce,now+60000);infrastructureBusy=true;
      void Promise.resolve().then(databaseCheck).catch(()=>false).then(authenticated=>{
        if(response.destroyed)return;
        const result=infrastructureStatusResponse(key,nonce,authenticated===true);
        response.setHeader('X-Cluera-Proof',result.signature);response.writeHead(200);response.end(result.body);
      }).finally(()=>{infrastructureBusy=false;});
      return;
    }
    if(metadata&&request.url===PROVIDER_METADATA_PATH){
      const now=performance.now();if(now-statusWindow>=60000){statusWindow=now;statusAttempts=0;}
      const header=(name:string)=>typeof request.headers[name]==='string'?request.headers[name] as string:'';
      const valid=request.method==='GET'&&!request.headers.origin&&!request.headers.cookie&&!request.headers.authorization
        &&!request.headers['transfer-encoding']&&(!request.headers['content-length']||request.headers['content-length']==='0')
        &&verifyProviderStatusRequest(Buffer.from(metadata.rateKey,'base64'),{timestamp:header('x-cluera-time'),
          nonce:header('x-cluera-nonce'),signature:header('x-cluera-proof')});
      if(!valid||++statusAttempts>60){response.writeHead(403);response.end('{"error":"Unavailable."}');return;}
      const result=providerStatusResponse(metadata,header('x-cluera-nonce'));
      response.setHeader('X-Cluera-Proof',result.signature);response.writeHead(200);response.end(result.body);return;
    }
    const healthy = request.method === 'GET' && request.url === '/healthz';
    // Non-secret deployment evidence only; never reflect arbitrary environment data.
    if(healthy&&revision&&/^[a-f0-9]{40}$/.test(revision))response.setHeader('X-Cluera-Revision',revision);
    response.writeHead(healthy ? 200 : 404);
    response.end(healthy ? '{"ok":true}' : '{"error":"Not found."}');
  });
  server.headersTimeout = 10000; server.requestTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  let stopping = false, attempts = 0, windowStart = performance.now();
  const sessions = new Map<WebSocket, ReturnType<typeof attachRelaySession>>();
  server.on('upgrade', (request, socket, head) => {
    // This phase is native-main-process only. Browser BFF relay authorization is
    // not exposed; reject ambient cookies and all browser-origin handshakes.
    const now = performance.now();
    if (now - windowStart >= 60000) { attempts = 0; windowStart = now; }
    if (stopping || ++attempts > 120 || sockets.clients.size >= 16 || request.method !== 'GET'
      || request.url !== '/v1/session' || request.headers.origin || request.headers.cookie
      || request.headers.authorization || request.headers['sec-websocket-protocol']) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    sockets.handleUpgrade(request, socket, head, peer => {
      const session = attachRelaySession(peer, dependencies); sessions.set(peer, session);
      peer.once('close', () => sessions.delete(peer));
    });
  });
  return { server, async stop() {
    stopping = true; for (const session of sessions.values()) session.stop();
    await Promise.all([new Promise<void>(resolve => sockets.close(() => resolve())),
      new Promise<void>(resolve => server.close(() => resolve()))]);
  } };
}
