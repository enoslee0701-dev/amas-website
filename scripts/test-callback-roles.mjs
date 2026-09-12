// 两处还没收口的「读不到当成确定」：
//   auth/callback 的邮箱验证回调 —— 20 次 getSession 读不到就说
//     「链接无效或已过期」，而读失败时 getSession 同样返回 null。
//     用户会以为验证邮件失效，跑去重新注册或重新发信（邮件投递仍是阻塞项）。
//   fetchRoles —— `{data:null,error:null}` 时给出「确实没有角色」。
//     PostgREST 对集合返回函数无行时返回 []，data:null 属防御性形状；
//     分不清结构同样是「不知道」，不能替它断定成没有权限。
//     （防御性边界，不声称真实服务上已经发生过。）
//
// 本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。独占动态端口。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".png":"image/png", ".webp":"image/webp",
  ".svg":"image/svg+xml", ".ico":"image/x-icon", ".woff2":"font/woff2" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
                       "Cache-Control":"no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-cbrole-"));
const CHROME = process.env.CHROME_PATH || process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0",
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP *.supabase.co 0.0.0.0, MAP *.supabase.in 0.0.0.0",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

async function ownDebugPort() {
  const f = path.join(prof, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    try { const n = Number(fs.readFileSync(f, "utf8").split("\n")[0].trim());
      if (Number.isInteger(n) && n > 0) return n; } catch (e) {}
    if (chrome.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error("没能从自己的 Chrome 取得独占调试端口；本套件不附着现成 Chrome，退出。");
}

let externalHits = 0;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  on(m, f) { this.handlers.set(m, f); }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try { const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
      if (!url) await sleep(200);
    }
    if (!url) throw new Error("连不上自己的 Chrome 调试端口 " + port);
    const s = await new Promise((res, rej) => { const k = new WebSocket(url); k.onopen = () => res(k); k.onerror = rej; });
    const c = new Cdp(s);
    s.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method && c.handlers.has(m.method)) c.handlers.get(m.method)(m.params); };
    return c;
  }
  send(method, params = {}, ms = 30000) {
    return new Promise((res, rej) => { const i = ++this.id;
      const t = setTimeout(() => { if (this.pending.delete(i)) rej(new Error("TIMEOUT " + method)); }, ms);
      this.pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async ev(x) {
    const r = await this.send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval 抛错: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  }
  async clickReal(sel) {
    const pt = await this.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return null; el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,ok:!!hit&&(hit===el||el.contains(hit)||hit.contains(el))};})()`);
    if (!pt) throw new Error("找不到 " + sel);
    if (!pt.ok) throw new Error("点没命中 " + sel);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await sleep(340);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';

const STUB = `
window.supabase = {
  createClient: function(){
    var S = function(){ return window.__SCEN || {}; };
    var reply = function(v){ return Promise.resolve(v); };
    var authErr = function(o){ var e=new Error(o.message||"err");
      e.__isAuthError=true; e.name="AuthApiError"; e.status=o.status; return e; };
    return {
      auth: {
        getSession: function(){
          var m = S().sessionMode || "ok";
          if (m === "error") return reply({ data:{ session:null }, error: authErr({ status:500, message:"boom" }) });
          if (m === "none")  return reply({ data:{ session:null }, error:null });
          return reply({ data:{ session:{ user:{ id:"u-fix" }, access_token:"fixture-token" } }, error:null });
        },
        onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
        signOut: function(){ return reply({}); },
        updateUser: function(){ return reply({ data:{}, error:null }); },
        mfa: { getAuthenticatorAssuranceLevel: function(){
          return reply({ data:{ currentLevel:"aal1", nextLevel:"aal1" }, error:null }); } }
      },
      from: function(){ var q={ select:function(){return q;}, eq:function(){return q;},
        order:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
        then:function(r){ return Promise.resolve({ data:[], error:null, status:200 }).then(r); } }; return q; },
      rpc: function(name){
        var sc = S();
        if (name === "my_roles") {
          var m = sc.rolesMode || "ok";
          if (m === "nodata") return reply({ data:null, error:null, status:200 });   // 防御性形状
          if (m === "empty")  return reply({ data:[], error:null, status:200 });
          if (m === "error")  return reply({ data:null, error:{ message:"boom" }, status:500 });
          return reply({ data:(sc.roles||["student"]).map(function(r){return {role:r};}), error:null, status:200 });
        }
        if (name === "my_profile") return reply({ data:{ display_name:"测试", email:"a@example.invalid" }, error:null, status:200 });
        var r = (sc.rpc && sc.rpc[name]) || { data:null, error:null };
        return reply({ data:r.data, error:r.error||null, status:200 });
      },
      functions: { invoke: function(){ return reply({ data:null, error:null }); } }
    };
  }
};`;

let port;
try { port = await ownDebugPort(); console.log("  独占调试端口（本进程自己的 Chrome）: " + port); }
catch (e) { chrome.kill(); server.close(); console.error("  " + e.message); process.exit(1); }

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("cdn.jsdelivr.net") > -1 && u.indexOf("supabase-js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name:"Content-Type", value:"application/javascript" },
                            { name:"Cache-Control", value:"no-store" }], body: b64(STUB) }); return;
      }
      if (u.indexOf("supabase-config.js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name:"Content-Type", value:"application/javascript" },
                            { name:"Cache-Control", value:"no-store" }], body: b64(CFG) }); return;
      }
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });

  let pageErrors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    pageErrors.push(String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || ""));
  });
  let nav = 0;
  const open = async (page, scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(scen) + ";" });
    const sep = page.indexOf("?") > -1 ? "&" : "?";
    await cdp.send("Page.navigate", { url: `${BASE}/${page}${sep}r=${++nav}` });
    await sleep(wait || 2600);
  };
  const vis = async () => cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template,[hidden]").forEach(n=>n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();})()`);

  // ════════ V auth/callback 邮箱验证回调 ════════
  console.log("\n=== V 邮箱验证回调 ===");
  pageErrors = [];
  await open("auth/callback/", { sessionMode:"error" }, 9500);
  const v1 = await vis();
  console.log("  [诊断] V1 页面异常: " + JSON.stringify(pageErrors.slice(0,2)));
  console.log("  [诊断] V1 可见文本: " + JSON.stringify(v1.slice(0,200)));
  console.log("  [诊断] V1 卡片: " + JSON.stringify(await cdp.ev(`(()=>{
    const out={}; document.querySelectorAll("[id^=state]").forEach(e=>out[e.id]=!e.hidden); return out;})()`)));
  ok("V1 读不出会话时不说「链接无效或已过期」", !/无效或已过期/.test(v1), v1.slice(0, 160));
  ok("V1b 而是如实说没能确认，并让人稍后用同一个链接重试",
     /没能确认|无法确认/.test(v1), v1.slice(0, 200));

  await open("auth/callback/", { sessionMode:"none" }, 9500);
  ok("V2 确实没有会话 → 仍如实说链接无效或已过期（没改坏）",
     /无效或已过期/.test(await vis()), (await vis()).slice(0, 160));

  await open("auth/callback/", { sessionMode:"ok", roles:["student"] }, 3000);
  ok("V3 有会话 → 邮箱验证成功（没改坏）", /验证成功/.test(await vis()), (await vis()).slice(0, 160));

  // ════════ N fetchRoles 的 data 缺失 ════════
  console.log("\n=== N fetchRoles 的防御性边界 ===");
  await open("portal/student/", { sessionMode:"ok", rolesMode:"ok", roles:["student"] }, 3000);
  const n1 = await cdp.ev(`(async()=>{
    const A = window.AmasAuth;
    window.__SCEN.rolesMode = "nodata";
    const r = await A.fetchRoles();
    window.__SCEN.rolesMode = "empty";
    const e = await A.fetchRoles();
    return { nodata: r, empty: e };
  })()`);
  ok("N1 data 读不出来时 failed=true（不是「确实没有角色」）",
     n1.nodata.failed === true, JSON.stringify(n1.nodata));
  ok("N2 而 data 是空数组时仍是「确实没有角色」（两者必须分得开）",
     n1.empty.failed === false && n1.empty.roles.length === 0, JSON.stringify(n1.empty));

  await open("portal/student/", { sessionMode:"ok", rolesMode:"nodata" }, 3000);
  const n3 = await vis();
  ok("N3 页面层：显示「没能确认你的权限」，而不是「还没有门户权限」",
     /没能确认你的权限/.test(n3) && !/还没有门户权限/.test(n3), n3.slice(0, 160));

  await open("portal/student/", { sessionMode:"ok", rolesMode:"empty" }, 3000);
  ok("N4 确实没有角色时仍说「还没有门户权限」（没改坏）",
     /还没有门户权限/.test(await vis()), (await vis()).slice(0, 160));

  // ════════ G 外发 ════════
  console.log("\n=== G 外发 ===");
  ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");

  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。");
process.exit(fail ? 1 : 0);
