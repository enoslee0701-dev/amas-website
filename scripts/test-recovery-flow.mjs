// 找回密码：恢复链接 → 设置新密码。这是全站后果最重的一次写入 ——
// 说错一句话，用户会被锁在自己账号外面。
//
// ── 缺陷一：保存结果不明时说成「保存失败」──────────────────────────
//     const { data, error } = await A.callFn("recovery-finalize", …);
// auth.js 的 callFn 返回的是 { status, data }，**没有 error 字段**
// （与第六包在 portal/admin/students 修的是同一个误解构）。于是
// `error && error.message` 是死代码；断网（status 0）、5xx、网关 HTML
// （data 是 null）全都落到 code="network"/"unknown"，显示
// 「保存失败，请稍后重试。」—— **而密码很可能已经改掉了**。
// 用户照这句话去用旧密码登录，就进不去了。
//
// ── 缺陷二：读不到会话时说成「恢复链接无效或已过期」──────────────
// 页面用 20 次轮询等 supabase-js 消费 URL 里的凭据。getSession 读失败时
// 返回 null，轮询走完就 bail「恢复链接无效或已过期。请重新申请一封重设邮件。」
// 而邮件投递本身还是独立阻塞项 —— 等于把人推向一条走不通的路。
//
// 本地 stub：无真实账号/凭据/邮件/服务，无远端写入，无外网请求。
// 独占动态端口（DevToolsActivePort）。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-recov-"));
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
          return reply({ data:{ session:{ user:{ id:"u-recov" }, access_token:"fixture-token" } }, error:null });
        },
        onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
        signOut: function(){ return reply({}); },
        mfa: { getAuthenticatorAssuranceLevel: function(){
          return reply({ data:{ currentLevel:"aal1", nextLevel:"aal1" }, error:null }); } }
      },
      from: function(){ var q={ select:function(){return q;}, eq:function(){return q;},
        order:function(){return q;}, range:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
        then:function(r){ return Promise.resolve({ data:[], error:null, status:200 }).then(r); } }; return q; },
      rpc: function(name){
        var r = (S().rpc && S().rpc[name]) || { data:{ ok:true, flow_id:"flow-fixture-1" }, error:null };
        return reply({ data:r.data, error:r.error||null, status:r.status!=null?r.status:(r.error?500:200) });
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

  /** kind: ok | throw | http500 | html | refuse:<code> */
  const installFetch = async (kind) => cdp.ev(`(()=>{
    window.__fnHits = 0;
    const orig = window.fetch;
    window.fetch = function(u){
      if (String(u).indexOf("/functions/v1/") < 0) return orig.apply(this, arguments);
      window.__fnHits++;
      const k = ${JSON.stringify(kind)};
      if (k === "throw")   return Promise.reject(new TypeError("Failed to fetch"));
      if (k === "http500") return Promise.resolve(new Response(JSON.stringify({}), { status:500,
                                headers:{ "Content-Type":"application/json" } }));
      if (k === "html")    return Promise.resolve(new Response("<html>502</html>", { status:502,
                                headers:{ "Content-Type":"text/html" } }));
      if (k.indexOf("refuse:") === 0)
        return Promise.resolve(new Response(JSON.stringify({ ok:false, error:k.slice(7) }),
               { status:200, headers:{ "Content-Type":"application/json" } }));
      return Promise.resolve(new Response(JSON.stringify({ ok:true }), { status:200,
             headers:{ "Content-Type":"application/json" } }));
    };
    return true;})()`);

  /* 每次带一个不同的 query：只改 hash 的话浏览器**不会重新加载**，
     页面会停在上一个用例的卡片上，后面的断言全在读陈旧状态。 */
  let nav = 0;
  const open = async (scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(scen) + ";" });
    await cdp.send("Page.navigate", { url: `${BASE}/auth/recovery/?r=${++nav}#type=recovery&access_token=fixture` });
    await sleep(wait || 2600);
  };
  const shown = async () => cdp.ev(`(()=>{
    const ids=["cardForm","cardDone","cardFail"];
    const on=ids.filter(i=>{const e=document.getElementById(i); return e && !e.hidden;});
    const err=document.getElementById("err"), fail=document.getElementById("failMsg");
    const btn=document.getElementById("btn");
    return { card:on[0]||null, err: err?(err.textContent||"").trim():null,
             errShown: !!(err && err.classList.contains("show")),
             fail: fail?(fail.textContent||"").trim():null,
             btnDisabled: !!(btn && btn.disabled) };})()`);
  const submitPw = async () => {
    await cdp.ev(`(()=>{document.getElementById("pw1").value="NewFixturePw1";
      document.getElementById("pw2").value="NewFixturePw1"; return true;})()`);
    await cdp.clickReal("#btn");
    await sleep(1500);
  };

  // ════════ F 保存新密码 ════════
  console.log("\n=== F 保存新密码 ===");
  await open({});
  const f0 = await shown();
  ok("F0 前提：合法恢复链接进到设置新密码的表单", f0.card === "cardForm", JSON.stringify(f0));

  for (const [label, kind] of [["断网","throw"], ["5xx","http500"], ["网关 HTML","html"]]) {
    await open({});
    await installFetch(kind);
    await submitPw();
    const r = await shown();
    ok("F 结果不明（" + label + "）→ 不说「保存失败」",
       !/保存失败/.test(r.err || ""), JSON.stringify(r));
    ok("F 结果不明（" + label + "）→ 如实说没能确认密码是否已保存",
       /没能确认|无法确认/.test(r.err || ""), JSON.stringify(r));
    ok("F 结果不明（" + label + "）→ 并告诉人先用**新**密码试着登录",
       /新密码/.test(r.err || ""), JSON.stringify(r));
  }

  await open({});
  await installFetch("refuse:password_rejected");
  await submitPw();
  const fr = await shown();
  ok("F4 明确拒绝时保留原文案（没改坏）", /不被接受/.test(fr.err || ""), JSON.stringify(fr));
  ok("F4b 明确拒绝后按钮可以再用", fr.btnDisabled === false, JSON.stringify(fr));

  await open({});
  await installFetch("refuse:already_completed");
  await submitPw();
  ok("F5 已完成过 → 直接显示完成卡（没改坏）", (await shown()).card === "cardDone", JSON.stringify(await shown()));

  await open({});
  await installFetch("ok");
  await submitPw();
  ok("F6 真成功 → 完成卡（没改坏）", (await shown()).card === "cardDone", JSON.stringify(await shown()));

  // ════════ S 会话轮询 ════════
  console.log("\n=== S 恢复链接的会话轮询 ===");
  await open({ sessionMode: "error" }, 6500);
  const s1 = await shown();
  ok("S1 读不出会话时不说「恢复链接无效或已过期」",
     !/无效或已过期/.test(s1.fail || ""), JSON.stringify(s1));
  ok("S1b 而是如实说没能确认，并让人稍后用**同一个**链接重试",
     /没能确认|无法确认/.test(s1.fail || "") && /同一个链接|稍后/.test(s1.fail || ""), JSON.stringify(s1));

  await open({ sessionMode: "none" }, 6500);
  const s2 = await shown();
  ok("S2 确实没有会话 → 仍如实说链接无效或已过期（没改坏）",
     /无效或已过期/.test(s2.fail || ""), JSON.stringify(s2));

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
console.log("  本地 stub：无真实账号/密码/邮件/服务，无远端写入，无外网请求。");
console.log("  绿灯只证明「给定这些返回值时恢复页没有谎报结果」，不证明真实找回密码流程已验收。");
process.exit(fail ? 1 : 0);
