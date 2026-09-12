// 找回密码的**入口页**：发送重设邮件。
//
// ── 缺陷 ──────────────────────────────────────────────────────────────
//     await A.resetPassword(email);          // ← 返回值整个丢掉
//     ok.textContent = "如果该邮箱已注册，重置链接已发送。请查收邮件…";
// 无论断网、5xx 还是被限流，页面一律说「已发送」。用户于是坐等一封
// 永远不会来的邮件 —— 而邮件投递本身还是独立阻塞项，他更难察觉。
// 这与本仓其他几处正好相反：不是把不确定说成失败，而是把**确定的失败
// 说成了成功**。同一条纪律的另一面。
//
// 另外 resetPasswordForEmail 在非 AuthError 时是 throw 的，而 resetPassword
// 没有 try/catch —— 异常一路穿出 submit 处理器，按钮永远停在「发送中…」。
//
// ── 必须保住的 ────────────────────────────────────────────────────────
// §5.3 的反枚举：任何分支都不能泄漏「这个邮箱有没有注册」。
// 传输层失败（连不上/服务端出错/限流）与账号是否存在无关，如实说不泄漏任何东西。
//
// 本地 stub：无真实账号/邮箱/邮件/服务，无外网请求。独占动态端口。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-fpw-"));
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
      e.__isAuthError=true; e.name=o.name||"AuthApiError"; e.status=o.status; return e; };
    return {
      auth: {
        getSession: function(){ return reply({ data:{ session:null }, error:null }); },
        onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
        signOut: function(){ return reply({}); },
        resetPasswordForEmail: function(){
          try { var o=JSON.parse(sessionStorage.getItem("fpCalls")||"{}"); o.n=(o.n||0)+1;
                sessionStorage.setItem("fpCalls", JSON.stringify(o)); } catch(e){}
          var m = S().resetMode || "ok";
          if (m === "throw")  throw new TypeError("Failed to fetch");
          if (m === "retryable") return reply({ data:null,
            error: (function(){ var e=new Error("network"); e.name="AuthRetryableFetchError"; e.status=0;
                                e.__isAuthError=true; return e; })() });
          if (m === "server") return reply({ data:null, error: authErr({ status:500, message:"boom" }) });
          if (m === "rate")   return reply({ data:null, error: authErr({ status:429, message:"too many" }) });
          return reply({ data:{}, error:null });
        },
        mfa: { getAuthenticatorAssuranceLevel: function(){
          return reply({ data:{ currentLevel:"aal1", nextLevel:"aal1" }, error:null }); } }
      },
      from: function(){ var q={ select:function(){return q;}, eq:function(){return q;},
        maybeSingle:function(){return q;},
        then:function(r){ return Promise.resolve({ data:[], error:null, status:200 }).then(r); } }; return q; },
      rpc: function(){ return reply({ data:null, error:null, status:200 }); },
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

  let nav = 0;
  const open = async (scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(scen) + ";" });
    await cdp.ev(`(()=>{try{sessionStorage.removeItem("fpCalls");}catch(e){} return true;})()`).catch(()=>{});
    await cdp.send("Page.navigate", { url: `${BASE}/forgot-password/?r=${++nav}` });
    await sleep(wait || 2400);
  };
  const send = async () => {
    await cdp.ev(`(()=>{document.getElementById("fEmail").value="a@example.invalid"; return true;})()`);
    await cdp.clickReal("#btnGo");
    await sleep(1500);
  };
  const state = async () => cdp.ev(`(()=>{
    const o=document.getElementById("ok"), e=document.getElementById("err"), b=document.getElementById("btnGo");
    return { ok:o?(o.textContent||"").trim():null, okShown:!!(o&&o.classList.contains("show")),
             err:e?(e.textContent||"").trim():null, errShown:!!(e&&e.classList.contains("show")),
             btnText:b?(b.textContent||"").trim():null, btnDisabled:!!(b&&b.disabled) };})()`);
  const sent = async () => (await cdp.ev(`(()=>{try{return (JSON.parse(sessionStorage.getItem("fpCalls")||"{}").n)||0;}catch(e){return 0;}})()`)) || 0;

  console.log("\n=== P 发送重设邮件 ===");
  await open({ resetMode: "ok" });
  ok("P0 前提：页面有发送表单", (await cdp.ev(`!!document.getElementById("btnGo")`)) === true);
  await send();
  const p1 = await state();
  ok("P1 请求被接受 → 统一文案（不泄漏邮箱是否已注册）",
     /如果该邮箱已注册/.test(p1.ok || "") && p1.okShown === true, JSON.stringify(p1));
  /* 受理 ≠ 投递。SMTP 上线配置仍是独立阻塞项，成功提示不能替投递打包票。 */
  ok("P1c 成功文案不承诺已送达，并给出没收到时的下一步",
     !/已送达|一定会收到|保证/.test(p1.ok || "") && /查收/.test(p1.ok || "") &&
     /再试|重试/.test(p1.ok || ""), JSON.stringify(p1));
  ok("P1b 按钮恢复可用", p1.btnDisabled === false && /发送重置邮件/.test(p1.btnText || ""), JSON.stringify(p1));

  /* ★ 拿不到回执 ≠ 没发出去。连接可能是在服务端**已经受理之后**才断的
     —— 监督独立反例 event342：服务端 accepted=1，页面却说「没能把这次请求
     发出去」。stub 在抛错/报错**之前**先记一次受理，把这个形态构造出来，
     所以下面每一条都同时断言「服务端确实收到了」。 */
  for (const [label, mode] of [["抛出（断网）","throw"], ["可重试网络错","retryable"], ["5xx","server"]]) {
    await open({ resetMode: mode });
    await send();
    const r = await state();
    ok("U 受理后丢回执（" + label + "）→ 前提：服务端确实收到了这次请求",
       (await sent()) === 1, "accepted=" + (await sent()));
    ok("U 受理后丢回执（" + label + "）→ **不**断言「没发出去」",
       !/没能把这次请求发出去|没有发出|没发出去/.test(r.err || ""), JSON.stringify(r));
    ok("U 受理后丢回执（" + label + "）→ **不**说「已发送」",
       !/已发送/.test(r.ok || "") || r.okShown === false, JSON.stringify(r));
    ok("U 受理后丢回执（" + label + "）→ 说没能确认处理结果",
       r.errShown === true && /没能确认|无法确认/.test(r.err || ""), JSON.stringify(r));
    ok("U 受理后丢回执（" + label + "）→ 给出查收与稍后重试两条指引",
       /查收/.test(r.err || "") && /重试|再试/.test(r.err || ""), JSON.stringify(r));
    ok("U 受理后丢回执（" + label + "）→ 按钮恢复，不卡在「发送中…」",
       r.btnDisabled === false && !/发送中/.test(r.btnText || ""), JSON.stringify(r));
    ok("U 受理后丢回执（" + label + "）→ 不泄漏邮箱是否已注册",
       !/未注册|不存在|没有该邮箱|已注册/.test(r.err || ""), JSON.stringify(r));
  }

  /* 限流是**确定**的：服务端明确回绝，这一次确实没有发信。
     这一条必须和上面那批「不确定」分得开，否则等于把所有失败一锅端成不确定。 */
  await open({ resetMode: "rate" });
  await send();
  const pr = await state();
  ok("R1 被限流 → 说太频繁，不说「已发送」",
     /频繁|稍等|稍后/.test(pr.err || "") && (!/已发送/.test(pr.ok || "") || pr.okShown === false), JSON.stringify(pr));
  ok("R1b 限流是确定的：明说「这一次没有发送」，不含糊成「没能确认」",
     /没有发送/.test(pr.err || "") && !/没能确认|无法确认/.test(pr.err || ""), JSON.stringify(pr));
  ok("P4b 限流文案同样不泄漏邮箱是否已注册",
     !/未注册|不存在|没有该邮箱|已注册/.test(pr.err || ""), JSON.stringify(pr));

  await open({ resetMode: "ok" });
  await send();
  ok("P5 正常路径只发出一次请求", (await sent()) === 1, "发出 " + (await sent()) + " 次");

  console.log("\n=== G 外发 ===");
  ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");

  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub：无真实账号/邮箱/邮件/服务，无外网请求。");
process.exit(fail ? 1 : 0);
