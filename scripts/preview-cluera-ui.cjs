'use strict';
// Loopback-only synthetic UI preview. Not Next/dev, Auth, a BFF or a database.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),desktop=path.join(root,'desktop/dist/renderer'),output=path.join(root,'.test-output/ui-preview');
async function start(){
 fs.mkdirSync(output,{recursive:true});
 await require(path.join(root,'web/node_modules/esbuild')).build({entryPoints:[path.join(root,'web/tests/fixtures/accountUiPreview.tsx')],
  bundle:true,platform:'browser',format:'iife',outfile:path.join(output,'web.js'),loader:{'.svg':'dataurl'},logLevel:'warning'});
 const html='<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Cluera synthetic UI</title><link rel="stylesheet" href="/web.css"/></head><body class="account-site cluera-site"><div id="root"></div><script src="/web.js"></script></body></html>';
 const server=http.createServer((req,res)=>{
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  const url=new URL(req.url,'http://127.0.0.1');
  let base=output,name;
  if(url.pathname.startsWith('/desktop/')){base=desktop;name=url.pathname.slice(9)||'index.html';if(!name.includes('.'))name='index.html';}
  else if(['/account','/admin'].includes(url.pathname)){res.setHeader('Content-Type','text/html');res.end(html);return;}
  else name=url.pathname.slice(1);
  const file=path.resolve(base,name),relative=path.relative(base,file);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  const types={'.js':'application/javascript','.css':'text/css','.html':'text/html','.woff':'font/woff','.woff2':'font/woff2','.svg':'image/svg+xml'};
  res.setHeader('Content-Type',types[path.extname(file)]??'application/octet-stream');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(fs.readFileSync(file));
 });
 server.listen(43690,'127.0.0.1',()=>console.log('Synthetic Cluera UI preview listening on 127.0.0.1:43690. No real backend access.'));
 process.once('SIGTERM',()=>server.close());process.once('SIGINT',()=>server.close());
}
start().catch(()=>{console.error('Synthetic UI preview startup failed.');process.exitCode=1;});
