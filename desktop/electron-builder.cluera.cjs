'use strict';
const {version}=require('./package.json');
if(!/^\d+[.]\d+[.]\d+$/.test(version))throw Error('Invalid Cluera version.');
module.exports={
 extends:null,publish:null,forceCodeSigning:false,appId:'ai.cluera.desktop',productName:'Cluera AI',asar:true,compression:'maximum',
 directories:{output:`release-cluera-staging/${version}`},
 extraMetadata:{name:'cluera-ai-desktop',version,clueraProduct:'cluera-ai',main:'dist/main/main.js'},
 files:['dist/**/*','resources/production-config.json','resources/cluera-public-key.pem','resources/account-distribution.json','package.json',
  '!**/*.sqlite*','!**/*.db','!**/secure-*.bin','!**/.env*','!**/file-library/**/*',
  'node_modules/**/*','!node_modules/**/*.map','!node_modules/**/*.ts','!node_modules/**/*.tsx',
  '!node_modules/**/test{,s}/**/*','!node_modules/**/__test{,s}__/**/*','!node_modules/**/*.md',
  // Mammoth's unused command-line parser is not needed for DOCX library extraction.
  '!node_modules/mammoth/bin/**/*','!node_modules/argparse/**/*','!node_modules/sprintf-js/**/*'],
 asarUnpack:['node_modules/sql.js/dist/sql-wasm.wasm'],
 beforePack:'scripts/verify-cluera-package.cjs',afterPack:'scripts/after-pack.cjs',
 win:{icon:'resources/cluera.ico',target:[{target:'nsis',arch:['x64']}],artifactName:'ClueraAITestSetup-${version}.${ext}',signAndEditExecutable:true},
 nsis:{include:'resources/cluera-installer.nsh',oneClick:false,shortcutName:'Cluera AI',uninstallDisplayName:'Cluera AI',
  perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:false,deleteAppDataOnUninstall:false},
};
