#!/usr/bin/env node
// Reproducible real Auth/SMTP/PostgREST + encrypted restore + browser acceptance.
// All mutations stay in the explicitly named disposable Docker stack.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const ROOT=path.resolve(import.meta.dirname,'..'),args=process.argv.slice(2),arg=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const cli=arg('--cli',process.env.SUPABASE_CLI||'supabase'),python=arg('--python',process.env.AMAS_BACKUP_PYTHON||'python3'),existing=arg('--existing-workdir',null),out=path.resolve(arg('--out',path.join(os.tmpdir(),'amas-local-acceptance-'+Date.now()))),workdir=existing||fs.mkdtempSync(path.join(os.tmpdir(),'amas-local-stack-'));fs.mkdirSync(out,{recursive:true});
const run=(command,argv,opts={})=>{const r=spawnSync(command,argv,{cwd:ROOT,encoding:'utf8',maxBuffer:32*1024*1024,...opts});if(r.status!==0){fs.writeFileSync(path.join(out,'setup-failure.log'),r.stderr||String(r.error||'Command failed'));throw new Error('Isolated command failed; see local setup-failure.log');}return r.stdout;};
let started=false;
try{
 if(!existing){
  const check=spawnSync('docker',['inspect','supabase_db_amas-attendance-isolated'],{stdio:'ignore'});if(check.status===0)throw new Error('Dedicated stack exists; use --existing-workdir explicitly');
  run(cli,['init','--workdir',workdir]);const config=path.join(workdir,'supabase/config.toml');let s=fs.readFileSync(config,'utf8').replace(/^project_id = .*$/m,'project_id = "amas-attendance-isolated"').replaceAll('54321','55321').replaceAll('54322','55322').replaceAll('54323','55323').replaceAll('54324','55324').replaceAll('54329','55329').replaceAll('54320','55320').replace('[auth.mfa.totp]\nenroll_enabled = false\nverify_enabled = false','[auth.mfa.totp]\nenroll_enabled = true\nverify_enabled = true');fs.writeFileSync(config,s);
  run(cli,['start','--workdir',workdir,'--exclude','realtime,storage-api,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor']);started=true;
  for(const file of fs.readdirSync(path.join(ROOT,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())run('docker',['exec','-i','supabase_db_amas-attendance-isolated','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],{input:fs.readFileSync(path.join(ROOT,'supabase/migrations',file),'utf8')});
 }
 run(python,['scripts/run-isolated-auth-restore.py','--cli',cli,'--workdir',workdir,'--out',out]);const fixture=fs.readFileSync(path.join(out,'fixture-location.txt'),'utf8').trim();run(process.execPath,['scripts/run-local-auth-browser.mjs','--fixture',fixture,'--out',out]);console.log('PASS real local acceptance; evidence: '+out);
}finally{if(started&&!args.includes('--keep'))run(cli,['stop','--workdir',workdir]);}
