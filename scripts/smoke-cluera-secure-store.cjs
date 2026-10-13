'use strict';
// Run using the independent development Electron binary, not the installer.
// No window, Auth, provider calls or old user profile. Do not relax security flags.
const {app,safeStorage}=require('electron'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base=path.join(root,'.test-output');fs.mkdirSync(base,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(base,'secure-store-')));
const timeout=setTimeout(()=>{console.log('{"status":"unaccepted","category":"startup_timeout"}');app.exit(1);},20000);
app.whenReady().then(()=>{
 try{if(!safeStorage.isEncryptionAvailable())throw Error();const value=crypto.randomBytes(32).toString('base64');const sealed=safeStorage.encryptString(value);if(safeStorage.decryptString(sealed)!==value)throw Error();console.log('{"status":"passed","syntheticOsEncryptionRoundTrip":true,"installedLoginAccepted":false}');clearTimeout(timeout);app.exit(0);}
 catch{console.log('{"status":"unaccepted","category":"os_encryption_unavailable"}');clearTimeout(timeout);app.exit(1);}
}).catch(()=>{clearTimeout(timeout);console.log('{"status":"unaccepted","category":"startup_failed"}');app.exit(1);});
