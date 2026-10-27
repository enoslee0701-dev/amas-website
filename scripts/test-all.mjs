#!/usr/bin/env node
// One explicit local/CI entry point. No hosted writes and no hidden skips.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
const ROOT=path.resolve(import.meta.dirname,'..');process.chdir(ROOT);
const argv=process.argv.slice(2);const group=argv.includes('--group')?argv[argv.indexOf('--group')+1]:'all';
if(!['all','fast','browser','sql','types','critical'].includes(group))throw new Error('group: all|fast|browser|sql|types|critical');
const out=path.resolve(process.env.TEST_OUT||path.join('logs/evidence','checks-'+new Date().toISOString().replace(/[:.]/g,'-')));fs.mkdirSync(out,{recursive:true});
const chrome=process.env.CHROME_PATH||process.env.CHROME||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'google-chrome');
const env={...process.env,CHROME_PATH:chrome,CHROME:chrome};const results=[];
async function run(label,command,args=[],extra={}){
 const logfile=path.join(out,label+'.log'),stream=fs.createWriteStream(logfile),started=Date.now();
 const child=spawn(command,args,{cwd:ROOT,env:{...env,...extra},stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
 child.stdout.pipe(stream);child.stderr.pipe(stream);
 let timeout=false;const timer=setTimeout(()=>{timeout=true;try{if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill();}catch{}},Number(process.env.SUITE_TIMEOUT_MS||720000));
 const code=await new Promise(resolve=>{child.on('error',e=>{stream.write(String(e));resolve(2);});child.on('close',(c)=>resolve(timeout?124:c??1));});
 clearTimeout(timer);await new Promise(resolve=>stream.end(resolve));
 const row={label,command:[command,...args],code,seconds:Number(((Date.now()-started)/1000).toFixed(2)),log:path.relative(ROOT,logfile)};results.push(row);
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log(`${code===0?'PASS':code===2?'NOT_RUN':'FAIL'} ${label} (${row.seconds}s)`);return code;
}
const critical=new Set(['test-attendance-operator','test-role-workspaces','test-finance-security','test-finance-board','test-site-board-inflight','test-role-guard','test-pages-touch','test-register-signup','test-login-errors']);
const jobs=[];
for(const file of fs.readdirSync('scripts').filter(f=>/^test-.*\.(mjs|py)$/.test(f)).sort()){
 if(file==='test-all.mjs')continue;
 const src=fs.readFileSync(path.join('scripts',file),'utf8');const browser=/launchOwnChrome|startHarness|--headless|spawn\(CHROME/.test(src);
 const label=file.replace(/\.(mjs|py)$/,'');
 if(group==='sql'||group==='types'||(group==='fast'&&browser)||(group==='browser'&&!browser)||(group==='critical'&&!critical.has(label)))continue;
 for(const only of file==='test-student-todo-loop.mjs'?['St,A,G','Sf,A,G','Se,A,G','Sp,A,G','Cp,Cn,A,G']:[null])jobs.push([label+(only?'-'+only.replaceAll(',','-'):''),file.endsWith('.py')?'python3':process.execPath,['scripts/'+file],only?{ONLY:only}:{}]);
}
if(['all','fast'].includes(group))for(const file of ['check-inline-scripts.mjs','check-site-static.mjs','check-internal-links.py','check-cache-bust.py','check-browser-feature-floor.mjs','check-sis-rpc-contract.mjs','check-probe-syntax.mjs','check-css-prefixes.mjs','check-account-status-vocab.mjs','check-portal-config.py'])jobs.push([file.split('.')[0],file.endsWith('.py')?'python3':process.execPath,['scripts/'+file]]);
if(argv.includes('--list')){jobs.forEach(j=>console.log(j[0]));process.exit(0);}
const workers=Number(process.env.TEST_WORKERS||2);
if(!Number.isInteger(workers)||workers<1||workers>4)throw new Error("TEST_WORKERS must be an integer from 1 to 4");
let index=0;
await Promise.all(Array.from({length:Math.min(Math.max(workers,1),4)},async()=>{for(;;){const i=index++;if(i>=jobs.length)return;await run(...jobs[i]);}}));
if(['all','sql'].includes(group)){
 const catalog=path.join(out,'program-catalog.json');
 const sql=['acceptance_tests','portal1_acceptance','portal2_acceptance','portal2_number_void','portal2b_acceptance','db3_schema_contract','sis0_lifecycle_e2e','sis1_acceptance','sis2_acceptance','sis3_acceptance','attendance_operator_acceptance','staff_role_lifecycle_acceptance','finance_acceptance','content_roles_acceptance','invitation_creation_acceptance','portal2b_irreversible_guard'].map(n=>'supabase/tests/'+n+'.sql');
 await run('sql-isolated',process.execPath,['scripts/run-sql-local.mjs','--catalog-out',catalog,...sql,'scripts/verify-g1/checks.sql']);
 if(fs.existsSync(catalog))await run('program-catalog',process.execPath,['supabase/tests/program_catalog_consistency.mjs'],{AMAS_CATALOG_JSON:catalog});
 else await run('program-catalog',process.execPath,['-e','console.error("NOT_RUN: no catalog export after SQL failure");process.exit(2)']);
}
if(['all','sql'].includes(group))await run('attendance-binding-plan',process.execPath,['scripts/verify-attendance-assignment.mjs']);
if(group==='all'&&process.env.AMAS_APP_DIR)await run('course-migration',process.execPath,['scripts/check-course-migration.mjs']);
if(['all','types'].includes(group)){
 const deno=process.env.DENO_BIN||'deno';const functions=fs.readdirSync('supabase/functions').filter(f=>fs.existsSync(`supabase/functions/${f}/index.ts`));
 await run('edge-types',deno,['check','--config=supabase/functions/deno.json','--frozen',...functions.map(f=>`supabase/functions/${f}/index.ts`)]);
 for(const name of functions)await run('edge-http-'+name,deno,['run','--config=supabase/functions/deno.json','--frozen','--allow-env','--allow-read=supabase/functions','--allow-net=127.0.0.1,localhost','scripts/test-edge-http.ts',name]);
}
const counts={total:results.length,pass:results.filter(r=>r.code===0).length,fail:results.filter(r=>r.code!==0&&r.code!==2).length,not_run:results.filter(r=>r.code===2).length};
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({group,...counts,results},null,2));console.log(JSON.stringify({group,...counts,output:out}));
process.exitCode=counts.fail||counts.not_run?1:0;
