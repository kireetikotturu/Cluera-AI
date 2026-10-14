'use strict';
// Operator-only protected build diagnostic. GETs only; always no website artifact.
const path=require('node:path'),Module=require('node:module');
const paymentFlags=['CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED',
 'SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED','SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED'];
async function run(dependencies,env=process.env){
 const result={configuration:false,paymentsDisabled:false,vaultDisabled:false,serviceKeyAuthenticated:false,
  relayAuthenticated:false,relayDatabaseAuthenticated:false,authOnly:false,providersDisabled:false,providerRequests:0,mutations:0};
 try{
  const config=dependencies.accountConfig(env);result.configuration=true;
  result.paymentsDisabled=paymentFlags.every(name=>env[name]==='false');
  result.vaultDisabled=env.CLUERA_PROVIDER_VAULT_ENABLED!=='true'&&!env.CLUERA_PROVIDER_VAULT_KEYRING_BASE64;
  if(!result.paymentsDisabled||!result.vaultDisabled)return result;
  // SDK enforces the fixed project's TLS origin and a ten-second deadline.
  // Discard all returned user identities and provider metadata; never log bodies/errors.
  const {error}=await dependencies.accountClients(config).service.auth.admin.listUsers({page:1,perPage:1});
  result.serviceKeyAuthenticated=!error;if(error)return result;
  const status=await dependencies.readProviderStatus(config);result.relayAuthenticated=true;
  result.authOnly=status.bootstrapMode==='auth-only';
  result.providersDisabled=status.providers.length===2&&status.providers.every(p=>p.enabled===false&&!p.configured&&p.fingerprint===null);
  if(!result.authOnly||!result.providersDisabled)return result;
  const infrastructure=await dependencies.readRelayInfrastructureStatus(config);
  result.relayDatabaseAuthenticated=infrastructure.databaseAuthenticated===true;
 }catch{/* Fixed booleans only. Never stringify exceptions, credentials or API responses. */}
 return result;
}
async function loadApplication(){
 const root=path.resolve(__dirname,'..'),web=path.join(root,'web');
 const esbuild=require(path.join(web,'node_modules','esbuild'));
 const built=await esbuild.build({stdin:{contents:"export {accountConfig} from './lib/accounts/config';export {accountClients} from './lib/accounts/clients';export {readProviderStatus} from './lib/accounts/providerStatus';export {readRelayInfrastructureStatus} from './lib/accounts/relayInfrastructureStatus';",resolveDir:web,loader:'ts'},
  bundle:true,platform:'node',format:'cjs',target:'node24',write:false,logLevel:'silent'});
 const loaded=new Module(path.join(web,'private-configuration-memory.cjs'),module);loaded.filename=path.join(web,'private-configuration-memory.cjs');loaded.paths=Module._nodeModulePaths(web);
 loaded._compile(built.outputFiles[0].text,loaded.filename);return loaded.exports;
}
module.exports={run,paymentFlags};
if(require.main===module)loadApplication().then(run).then(value=>{
 console.log('CLUERA_PRIVATE_CONFIGURATION '+JSON.stringify(value));process.exitCode=1;
}).catch(()=>{console.log('CLUERA_PRIVATE_CONFIGURATION_UNAVAILABLE');process.exitCode=1;});
