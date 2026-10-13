'use strict';
const path=require('node:path');
const {scan}=require('./security/source-secret-scan.cjs');
try{const result=scan(path.resolve(__dirname,'..'),process.argv.includes('--history'));console.log(JSON.stringify(result));if(result.findings.length)process.exitCode=1;}
catch{console.error('Cluera source scan unavailable.');process.exitCode=1;}
