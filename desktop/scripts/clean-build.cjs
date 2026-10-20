'use strict';
const fs=require('node:fs'),path=require('node:path');
const desktop=path.resolve(__dirname,'..'),target=path.resolve(desktop,'dist');
if(path.dirname(target)!==desktop||path.basename(target)!=='dist')throw Error('Invalid desktop build target.');
if(fs.existsSync(target)){
 if(fs.lstatSync(target).isSymbolicLink()||fs.realpathSync(target)!==target)throw Error('Refusing linked desktop build output.');
 fs.rmSync(target,{recursive:true,force:true});
}
