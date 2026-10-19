import fs from 'node:fs';
import path from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({appPath:'',userData:''}));
vi.mock('electron',()=>({app:{isPackaged:true,getAppPath:()=>fixture.appPath,getPath:()=>fixture.userData}}));
import {createAppConfig} from '../src/main/config/appConfig';
const base=path.resolve('../.test-output');
const resources=path.resolve('resources');
let directory:string;
let product:Record<string,unknown>;
beforeEach(()=>{
 fs.mkdirSync(base,{recursive:true});directory=fs.mkdtempSync(path.join(base,'publisher-pin-'));
 fixture.appPath=directory;fixture.userData=path.join(directory,'profile');fs.mkdirSync(path.join(directory,'resources'));
 fs.copyFileSync(path.join(resources,'cluera-public-key.pem'),path.join(directory,'resources/cluera-public-key.pem'));
 product=JSON.parse(fs.readFileSync(path.join(resources,'production-config.json'),'utf8'));
});
afterEach(()=>{
 vi.unstubAllEnvs();
 if(path.dirname(directory)!==base||!path.basename(directory).startsWith('publisher-pin-'))throw Error('Unexpected fixture path.');
 fs.rmSync(directory,{recursive:true,force:true});
});
function load(value?:unknown){
 fs.writeFileSync(path.join(directory,'resources/production-config.json'),JSON.stringify({...product,...(value===undefined?{}:{updatePublisher:value})}));
 return createAppConfig();
}
it('preserves the unsigned TEST default and ignores an environment publisher override',()=>{
 vi.stubEnv('CLUERA_UPDATE_PUBLISHER','CN=Untrusted environment');
 expect(load().licensing.updatePublisher).toBeUndefined();
});
it.each(['CN=Cluera AI, O=Example Private Limited, C=IN','CN="Example, Inc.", O=Cluera AI, C=IN'])('loads the exact bundled publisher subject: %s',publisher=>{
 expect(load(publisher).licensing.updatePublisher).toBe(publisher);
});
it.each([null,false,123,{},[], '', ' ', 'Cluera AI','CN=', 'CN= ', ' CN=Cluera AI','CN=Cluera AI ',
 'CN=Cluera\nAI','CN=Cluera\rAI','CN=Cluera\0AI','CN='+ 'x'.repeat(1022)])('fails closed for malformed publisher metadata %#',publisher=>{
 expect(()=>load(publisher)).toThrow('Cluera update publisher pin is invalid.');
});
