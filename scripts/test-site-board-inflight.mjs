import {startHarness,sleep} from './lib/sis-harness.mjs';
const h=await startHarness({profilePrefix:'amas-audit-board-race-'});
await h.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
 window.SUPA_IS_FILLED=()=>true;
 const orig=window.fetch;window.__downloadClicks=0;
 const ac=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.hasAttribute('download'))window.__downloadClicks++;return ac.call(this);};
 window.fetch=function(url,opts){const u=String(url);
  if(u.includes('/rpc/site_public'))return new Promise(resolve=>{window.__releaseBoard=()=>resolve(new Response(JSON.stringify({cohorts:[],announcements:[]}),{status:200,headers:{'Content-Type':'application/json'}}));});
  if(opts?.method==='HEAD'&&u.includes('student-handbook'))return new Promise(resolve=>{window.__releaseHead=()=>resolve(new Response('',{status:200}));});
  if(u.includes('__audit_ai'))return new Promise(resolve=>{window.__releaseAi=()=>resolve(new Response(JSON.stringify({reply:'本地模拟回答'}),{status:200,headers:{'Content-Type':'application/json'}}));});
  return orig.apply(this,arguments);
 };
})();`});
try{
 await h.open('index.html',{},600);await h.click('[data-download="student-handbook"]');await sleep(500);
 let before=await h.ev(`({busy:document.querySelector('[data-download="student-handbook"]').disabled,waiting:!!document.querySelector('.resource-status'),heldBoard:!!window.__releaseBoard,heldHead:!!window.__releaseHead})`);
 h.ok('RESOURCE setup: real download and site board requests both pending',before.busy&&before.waiting&&before.heldBoard&&before.heldHead,JSON.stringify(before));
 await h.ev('window.__releaseBoard();true');await sleep(150);
 let after=await h.ev(`({busy:document.querySelector('[data-download="student-handbook"]').disabled,waiting:!!document.querySelector('.resource-status')})`);
 h.ok('RESOURCE unrelated board response preserves pending state',after.busy&&after.waiting,JSON.stringify(after));
 await h.ev('window.__releaseHead();true');await sleep(150);
 h.ok('RESOURCE completed HEAD still delivers the requested file',await h.ev('window.__downloadClicks===1'),'download clicks='+await h.ev('window.__downloadClicks'));
 await h.open('index.html',{},600);await h.ev('window.__releaseBoard();true');await sleep(100);await h.click('[data-download="student-handbook"]');await h.ev('window.__releaseHead();true');await sleep(150);
 h.ok('RESOURCE positive control: board finishes first, download is delivered',await h.ev('window.__downloadClicks===1'));
 await h.open('index.html',{},600);await h.ev(`CONFIG.ai.endpoint='/__audit_ai';true`);await h.click('#chatFab');await h.setVal('#chatText','测试公告与咨询并发');await h.click('#chatSend');await sleep(100);
 before=await h.ev(`({heldBoard:!!window.__releaseBoard,heldAi:!!window.__releaseAi,busy:document.querySelector('#chatSend').disabled})`);
 h.ok('CHAT setup: AI and site board requests both pending',before.heldAi&&before.heldBoard,JSON.stringify(before));
 await h.ev('window.__releaseBoard();true');await sleep(100);await h.ev('window.__releaseAi();true');await sleep(150);
 const text=await h.txt();
 h.ok('CHAT unrelated board response does not discard valid AI reply',text.includes('本地模拟回答'),await h.ev(`document.querySelector('#chatMessages')?.textContent||document.querySelector('#chatPanel')?.textContent||'reply missing'`));
 await h.open('index.html',{},600);await h.ev('window.__releaseBoard();true');await sleep(100);await h.ev(`CONFIG.ai.endpoint='/__audit_ai';true`);await h.click('#chatFab');await h.setVal('#chatText','正常咨询对照');await h.click('#chatSend');await sleep(100);await h.ev('window.__releaseAi();true');await sleep(150);
 h.ok('CHAT positive control: board finishes first, valid AI reply is shown',(await h.txt()).includes('本地模拟回答'));
}catch(e){h.fail(e.stack||e.message);}
process.exit((await h.close('SITE BOARD INFLIGHT RACE'))?1:0);
