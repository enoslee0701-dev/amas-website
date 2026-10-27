#!/usr/bin/env node
// Isolated PostgreSQL acceptance runner. No connection string or hosted DB fallback.
// npm install --prefix /tmp/pglite --ignore-scripts @electric-sql/pglite@0.3.7
// PGLITE_DIR=/tmp/pglite node scripts/run-sql-local.mjs [--catalog-out /tmp/catalog.json] tests.sql ...
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=process.env.PGLITE_DIR&&path.join(process.env.PGLITE_DIR,'node_modules/@electric-sql/pglite/dist');
if(!dist||!fs.existsSync(path.join(dist,'index.js'))){console.error('NOT_RUN: 找不到 PGlite；用 PGLITE_DIR 指向仓库外安装目录。');process.exit(2);}
const {PGlite}=await import(pathToFileURL(path.join(dist,'index.js')).href);
const argv=process.argv.slice(2),oi=argv.indexOf('--catalog-out');let catalogOut=null;
if(oi>=0){catalogOut=argv[oi+1];if(!catalogOut)process.exit(2);argv.splice(oi,2);}
const files=argv.length?argv:[null];let fails=0;
for(const file of files){
 const db=new PGlite({extensions:{pgcrypto:pathToFileURL(path.join(dist,'pgcrypto.tar.gz'))}});
 let notes=[];
 const exec=sql=>db.exec(sql,{onNotice:n=>notes.push(n.message)});
 try{
  await exec(fs.readFileSync(path.join(ROOT,'scripts/verify-g1/prelude.sql'),'utf8'));
  await exec(`create extension pgcrypto;
   alter table auth.users add column instance_id uuid, add column aud text, add column role text,
    add column encrypted_password text, add column raw_app_meta_data jsonb default '{}'::jsonb,
    add column updated_at timestamptz default now();
   create or replace function auth.uid() returns uuid language sql stable as $$
    select coalesce(nullif(current_setting('amas.test.uid',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
   $$;
   grant usage on schema public to anon,authenticated,service_role;
   alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
   alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
   alter default privileges in schema public grant all on functions to anon,authenticated,service_role;`);
  const migrations=fs.readdirSync(path.join(ROOT,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
  for(const f of migrations)await exec(fs.readFileSync(path.join(ROOT,'supabase/migrations',f),'utf8'));
  if(catalogOut){fs.writeFileSync(catalogOut,JSON.stringify((await db.query('select code,name_zh,is_open_for_application,sort_order from public.program_catalog order by sort_order')).rows,null,2));catalogOut=null;}
  console.log(`== ${file||'migration-load'} (fresh DB; ${migrations.length} migrations)`);notes=[];
  if(file)await exec(fs.readFileSync(path.resolve(file),'utf8').replace(/^\\(?:set ON_ERROR_STOP on|echo[^\r\n]*)\r?$/mg,''));
  notes.filter(n=>!/rehashing catalog|aborting transaction/.test(n)).forEach(n=>console.log('  '+n));
  console.log('PASS SQL '+(file||'migration-load'));
 }catch(e){fails++;notes.filter(n=>!/rehashing catalog/.test(n)).slice(-12).forEach(n=>console.log('  '+n));console.error('FAIL SQL '+(file||'migration-load')+': '+e.message);}
 finally{await db.close();}
}
console.log(`SQL ALL: ${files.length-fails} PASS / ${fails} FAIL`);process.exitCode=fails?1:0;
