// Real local Auth + SDK + PostgREST. No mock clients, no hosted backend fallback.
import fs from 'node:fs';import http from 'node:http';import path from 'node:path';import {launchOwnChrome} from './lib/chrome-launcher.mjs';
const fi=process.argv.indexOf('--fixture'),oi=process.argv.indexOf('--out');if(fi<0||oi<0)throw new Error('--fixture and --out required');
const fixture=JSON.parse(fs.readFileSync(process.argv[fi+1],'utf8')),out=path.resolve(process.argv[oi+1]),ROOT=path.resolve(import.meta.dirname,'..');
if(!['127.0.0.1','localhost'].includes(new URL(fixture.api).hostname))throw new Error('Loopback backend required');
const MIME={'.html':'text/html;charset=utf-8','.js':'application/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{let url=new URL(req.url,'http://localhost');if(url.pathname.endsWith('/assets/js/supabase-config.local.js')){res.writeHead(404);res.end();return;}if(url.pathname.endsWith('/assets/js/supabase-config.js')){res.writeHead(200,{'Content-Type':'application/javascript'});res.end('window.SUPA='+JSON.stringify({url:fixture.api,anonKey:fixture.anon})+';');return;}let p=decodeURIComponent(url.pathname);if(p.endsWith('/'))p+='index.html';const full=path.resolve(ROOT,'.'+p);if(!full.startsWith(ROOT+path.sep)||!fs.existsSync(full)||fs.statSync(full).isDirectory()){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':MIME[path.extname(full)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(full).pipe(res);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const BASE='http://127.0.0.1:'+server.address().port;
const chrome=await launchOwnChrome({profilePrefix:'amas-real-auth-'});let ws,seq=0;const pending=new Map();let external=0;
const list=await(await fetch('http://127.0.0.1:'+chrome.port+'/json/list')).json();ws=new WebSocket(list.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
const send=(method,params={})=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method,params}));});
ws.onmessage=async e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Fetch.requestPaused'){const u=m.params.request.url;const safe=u.startsWith(BASE+'/')||u.startsWith(fixture.api+'/');if(!safe)external++;await send(safe?'Fetch.continueRequest':'Fetch.failRequest',safe?{requestId:m.params.requestId}:{requestId:m.params.requestId,errorReason:'BlockedByClient'});}};
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)throw new Error('Page evaluation failed');return r.result?.result?.value;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const wait=async expression=>{for(let i=0;i<120;i++){if(await ev(expression))return true;await sleep(100);}return false;};const results=[];const check=(name,passed)=>{results.push({name,passed:!!passed});console.log((passed?'PASS ':'FAIL ')+name);if(!passed)throw new Error(name);};
try{
 await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});await send('Page.navigate',{url:BASE+'/login/'});await wait(`!!document.querySelector('#loginForm')`);
 for(const [role,home]of[['super_admin','portal/admin/'],['student','portal/student/'],['attendance_clerk','portal/attendance/']]){
  await ev(`localStorage.clear();sessionStorage.clear();true`);await send('Page.navigate',{url:BASE+'/login/'});await wait(`!!document.querySelector('#loginForm')&&!!window.AmasAuth?.CONFIGURED`);
  const user=fixture.users[role];await ev(`document.querySelector('#fId').value=${JSON.stringify(user.email)};document.querySelector('#fPw').value=${JSON.stringify(user.password)};document.querySelector('#btnLogin').click();true`);
  await wait(`location.pathname.endsWith(${JSON.stringify('/'+home)})||!!document.querySelector('#spaces a')`);
  if(await ev(`!!document.querySelector('#spaces a')`))await ev(`(()=>{const a=[...document.querySelectorAll('#spaces a')].find(a=>new URL(a.href).pathname.endsWith(${JSON.stringify('/'+home)}));if(a)a.click();return !!a})()`);
  check('real browser login lands '+role,await wait(`location.pathname.endsWith(${JSON.stringify('/'+home)})&&!!document.querySelector('main')`));
  if(role==='super_admin'){await ev(`document.querySelector('a[href="attendance/"]').click();true`);check('real monthly page reads cohort schema and RPCs',await wait(`!!document.querySelector('.calendar')&&document.querySelector('#reviewStatus')?.textContent.includes('已读取')`));}
  if(role==='attendance_clerk')check('real clerk screen remains exclusive',await ev(`!document.querySelector('.portal-shell')&&document.body.textContent.includes('10月班考勤')&&!document.body.textContent.includes('费用管理')`));
  await ev(`window.AmasAuth.signOut();true`);check('real browser logout '+role,await wait(`location.pathname.includes('/login/')&&!!document.querySelector('#loginForm')`));
 }
 check('no non-loopback requests',external===0);
}catch(e){try{fs.writeFileSync(path.join(out,'auth-browser-diagnostic.json'),JSON.stringify(await ev(`({path:location.pathname,state:window.AmasAuth?.CONFIG_STATE,error:document.querySelector('#err')?.textContent,body:document.body.innerText})`),null,2));}catch{}results.push({name:'journey completed',passed:false,error:String(e.message)});console.log('FAIL '+e.message);}
finally{fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'auth-browser-results.json'),JSON.stringify({results,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,scope:'real local SDK/Auth/PostgREST; no hosted accounts or writes'},null,2));ws.close();chrome.dispose();server.close();}
process.exitCode=results.some(r=>!r.passed)?1:0;
