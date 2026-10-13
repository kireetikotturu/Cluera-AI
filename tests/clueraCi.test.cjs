'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('verification CI has read-only permissions, pinned actions and no deploy/private-secret authority',()=>{
 const s=fs.readFileSync(path.join(__dirname,'../.github/workflows/verify.yml'),'utf8');
 assert(s.includes('contents: read'));assert(s.includes('persist-credentials: false'));assert(s.includes('package-manager-cache: false'));
 assert.equal((s.match(/uses: [^\n]+@[a-f0-9]{40}/g)||[]).length,4);
 assert(!/pull_request_target|workflow_run|secrets\.|write-all|continue-on-error|audit-level=critical|upload-artifact|vercel deploy|supabase db push/.test(s));
 for(const step of ['test:preparation','verify:source','build:web','build:backend','build:desktop','--audit-level=moderate'])assert(s.includes(step));
});
