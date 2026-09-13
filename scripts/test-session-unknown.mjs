// 读不出登录状态（getSession）时，三个入口分别会怎样对待用户。
//
// ── 缺陷 ──────────────────────────────────────────────────────────────
// assets/js/portal/auth.js:
//     async function getSession() {
//       const { data } = await client.auth.getSession();   // ← error 被丢掉
//       return data.session || null;
//     }
// 读失败时 SDK 返回的正是 { data:{ session:null }, error } —— 于是「读不到」
// 在调用方眼里和「没登录」一模一样。第四包已在 portal/mfa/ 这一条路上证实，
// 本轮把其余入口收口。同一条纪律：**不确定不能当成确定**。
//
// ── 三个入口的实际后果 ────────────────────────────────────────────────
//   requireRole   读不出 → 当没登录 → replace 去 /login/?next=…。
//                 一个**登录仍然有效**的学员被要求重新输密码；影响每一个门户页。
//                 抛出那一支更糟：getSession 没有 try/catch，异常穿出守卫，
//                 页面什么都不显示。
//   callFn        读不出 → 返回 {status:401, error:"unauthenticated"}，
//                 三处 UI 把它渲染成「登录状态已失效，请重新登录。」——
//                 一句确定性的假话，而且请求其实**一次都没发出去**。
//   faculty/verify 读不出 → 提交时把人弹去登录页，表单里填的东西丢掉。
//
// ── 用的是什么 ────────────────────────────────────────────────────────
// 本地 stub；无真实账号/凭据/服务；supabase 域名钉 0.0.0.0 并有断言兜底。
// 独占动态端口（DevToolsActivePort），不附着现成 Chrome。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-sess-"));
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

/** __SCEN:
      sessionMode "ok" | "error"（返回 {data:{session:null}, error} —— 真实形状）
                  | "throw"（2.116.0 对非 AuthError 是 throw 的）
                  | "none"（确实没有会话）
      roles / aal / factors 同前几套。__SCEN 在页面里可改，C 段据此切换。 */
const STUB = `
window.supabase = {
  createClient: function(){
    var reply = function(v){ return Promise.resolve(v); };
    var S = function(){ return window.__SCEN || {}; };
    var ss = function(k){ try { return sessionStorage.getItem(k); } catch (e) { return null; } };
    var set = function(k,v){ try { sessionStorage.setItem(k,v); } catch (e) {} };
    var bump = function(k){ try { var o=JSON.parse(ss("aalCalls")||"{}"); o[k]=(o[k]||0)+1;
      set("aalCalls", JSON.stringify(o)); } catch (e) {} };
    var wait = function(key){ var ms=(S().slow||{})[key]||0;
      return ms ? new Promise(function(r){ setTimeout(r, ms); }) : Promise.resolve(); };
    var authErr = function(o){ var e=new Error(o.message||"auth error");
      e.__isAuthError=true; e.name=o.name||"AuthApiError"; e.status=o.status; return e; };

    window.__authSubs = window.__authSubs || [];
    window.__fireAuth = function(ev, sess){
      if (ev === "SIGNED_OUT") set("sessionDead","1");
      (window.__authSubs||[]).slice().forEach(function(f){ try { f(ev, sess||null); } catch (e) {} });
    };
    if (S().killAfter) setTimeout(function(){ window.__fireAuth("SIGNED_OUT"); }, S().killAfter);

    return {
      auth: {
        getSession: function(){
          bump("getSession");
          if (ss("sessionDead") === "1") return reply({ data: { session: null }, error: null });
          var m = S().sessionMode || "ok";
          /* 真实形状：读失败时 data.session 是 null，而 error 非空。
             页面只看 data.session 的话，「读不到」就变成了「没登录」。 */
          if (m === "error") return reply({ data: { session: null }, error: authErr({ status: 500, message: "boom" }) });
          if (m === "throw") throw new TypeError("Failed to fetch");
          if (m === "none") return reply({ data: { session: null }, error: null });
          /* 防御性形状：data 整个缺失。2.116.0 的正常路径不会这样返回
             （产物已核，data 永远是对象），但分不清结构时同样是「不知道」，
             不能替它断定成没登录。 */
          if (m === "nodata") return reply({ data: null, error: null });
          return reply({ data: { session: { user:{ id:"u-fixture" }, access_token:"fixture-token" } }, error: null });
        },
        onAuthStateChange: function(cb){
          window.__authSubs.push(cb);
          return { data: { subscription: { unsubscribe: function(){
            var i=window.__authSubs.indexOf(cb); if(i>-1) window.__authSubs.splice(i,1); } } } };
        },
        signOut: function(){ set("sessionDead","1"); window.__fireAuth("SIGNED_OUT"); return reply({}); },
        mfa: {
          getAuthenticatorAssuranceLevel: function(){
            bump("aal");
            return wait("aal").then(function(){
              var m = S().aalMode || "ok";
              if (m === "throw") throw new TypeError("Failed to fetch");
              if (m === "error") return { data: null, error: authErr({ status: 500, message: "boom" }) };
              /* JWT 里没有 aal 声明时 SDK 真实返回的形状：data 在，值是 null */
              if (m === "partial") return { data: { currentLevel: null, nextLevel: null,
                                                    currentAuthenticationMethods: [] }, error: null };
              var a = ss("verified") === "1" ? "aal2" : (S().aal || "aal1");
              return { data: { currentLevel: a, nextLevel: "aal2" }, error: null };
            });
          },
          listFactors: function(){
            bump("listFactors");
            return wait("listFactors").then(function(){
              var raw = S().factors || [];
              var out = { all: [], phone: [], totp: [], webauthn: [], recovery_code: [] };
              raw.forEach(function(f){ out.all.push(f);
                if (f.status === "verified" && Array.isArray(out[f.factor_type])) out[f.factor_type].push(f); });
              return { data: out, error: null };
            });
          },
          enroll: function(){ bump("enroll");
            return reply({ data: { id:"fixture-totp-new", type:"totp",
              totp: { qr_code:"data:image/svg+xml;utf-8,<svg xmlns='http://www.w3.org/2000/svg'/>",
                      secret:"FIXTURE-NOT-A-REAL-SECRET" } }, error: null }); },
          unenroll: function(){ bump("unenroll"); return reply({ data:{}, error:null }); },
          challenge: function(){ bump("challenge");
            return wait("challenge").then(function(){ return { data:{ id:"fixture-challenge" }, error:null }; }); },
          verify: function(){ bump("verify");
            return wait("verify").then(function(){ set("verified","1");
              return { data:{ access_token:"fixture-aal2" }, error:null }; }); }
        }
      },
      from: function(){ var q={ select:function(){return q;}, eq:function(){return q;},
        order:function(){return q;}, range:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
        then:function(r){ return Promise.resolve({data:[],error:null}).then(r); } }; return q; },
      rpc: function(name){
        if (name === "my_roles") return reply({ data:(S().roles||["teacher"]).map(function(r){return {role:r};}), error:null });
        if (name === "my_profile") return reply({ data:{ display_name:"测试用户", email:"a@example.invalid" }, error:null });
        return reply({ data:null, error:null });
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
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

  const navLog = [];
  cdp.on("Page.frameNavigated", (p) => { if (p.frame && !p.frame.parentId) navLog.push(String(p.frame.url||"")); });

  const open = async (page, scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(scen) + ";" });
    await cdp.ev(`(()=>{try{["sessionDead","verified","aalCalls"].forEach(k=>sessionStorage.removeItem(k));}catch(e){} return true;})()`).catch(()=>{});
    navLog.length = 0;
    await cdp.send("Page.navigate", { url: `${BASE}/${page}` });
    await sleep(wait || 2400);
  };
  /* 只取**可见**文本：这些页面靠 hidden 切卡片，textContent 会把隐藏内容
     一起收进来，断言就变成「DOM 里有没有这句话」而不是「用户看到没有」。 */
  const txt = async () => cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template,[hidden]").forEach(n=>n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();})()`);
  const loginHits = () => navLog.filter((u) => /\/login\//.test(u)).length;
  const STU = { roles:["student"], aalMode:"ok", aal:"aal1" };

  // ════════ R requireRole：读不出登录状态 ════════
  console.log("\n=== R requireRole（影响每一个门户页）===");
  for (const [label, mode] of [["返回 error","error"], ["抛出","throw"]]) {
    await open("portal/student/?cat=nt", { ...STU, sessionMode: mode }, 2800);
    const t = await txt();
    ok("R 读不出（" + label + "）→ **不**被当成没登录弹去登录页",
       loginHits() === 0, "登录页出现 " + loginHits() + " 次: " + JSON.stringify(navLog.slice(0,3)));
    ok("R 读不出（" + label + "）→ 停下来说清楚，不静默", /没能确认/.test(t), t.slice(0,140));
    ok("R 读不出（" + label + "）→ 明写这不表示没登录，并给重试",
       /不表示/.test(t) && /重试/.test(t), t.slice(0,180));
    ok("R 读不出（" + label + "）→ **不放行**：学员空间内容没渲染",
       !/课程目录/.test(t), t.slice(0,140));
  }
  await open("portal/student/?cat=nt", { ...STU, sessionMode:"none" }, 2800);
  ok("R5 确实没有会话 → 仍按既有规则去登录页并带 next（没改坏）",
     loginHits() >= 1 && /next=/.test(navLog.find(u=>/\/login\//.test(u))||""),
     JSON.stringify(navLog.slice(0,3)));
  await open("portal/student/", STU, 2800);
  ok("R6 会话正常 → 正常进入学员空间（没改坏）",
     (await cdp.ev(`location.pathname`)) === "/portal/student/" && loginHits() === 0,
     "落点=" + (await cdp.ev(`location.pathname`)));

  // D 防御性边界：data 整个缺失（监督事件 141c 顺带发现）
  await open("portal/student/?cat=nt", { ...STU, sessionMode:"nodata" }, 2800);
  const d1 = await txt();
  ok("D1 连 data 结构都读不出时也算「不知道」，不被当成没登录弹去登录页",
     loginHits() === 0, "登录页出现 " + loginHits() + " 次: " + JSON.stringify(navLog.slice(0,3)));
  ok("D2 停下来说清楚并给重试", /没能确认/.test(d1) && /重试/.test(d1), d1.slice(0,160));

  // ════════ C callFn：请求一次都没发出去，却说「登录状态已失效」 ════════
  console.log("\n=== C callFn 的说法 ===");
  /* C 段自己开一张页面再探。否则它依赖上一段把浏览器留在哪里 ——
     D 段在修前会导航去登录页，那里根本没有 AmasApi，C 就会因为
     「页面不对」而判红，看起来像是另一个缺陷。次序依赖要自己消掉。 */
  await open("portal/student/", STU, 2800);
  const probe = async (mode) => {
    await cdp.ev(`(()=>{window.__SCEN.sessionMode=${JSON.stringify(mode)}; return true;})()`);
    /* 探针自己要接住异常：callFn 对「抛出」这一形态**根本没有 try/catch**，
       异常会一路穿出去。不接的话套件自己先崩，测不出它对用户做了什么。
       抛出本身就是要记录的证据，所以 threw 也进结果。 */
    return cdp.ev(`(async()=>{
      const out = { status:null, code:null, uiCode:null, uiMsg:null, threw:null, uiThrew:null };
      try { const r = await window.AmasAuth.callFn("create-teacher-invitation", {});
            out.status = r.status; out.code = (r.data&&r.data.error)||null; }
      catch (e) { out.threw = String((e && (e.name||e.message)) || e); }
      try { const f = await window.AmasApi.fn("create-teacher-invitation", {});
            out.uiCode = f.error&&f.error.code; out.uiMsg = f.error&&f.error.message; }
      catch (e) { out.uiThrew = String((e && (e.name||e.message)) || e); }
      return out;
    })()`);
  };
  const cErr = await probe("error");
  ok("C1 读不出时不再报成 401/unauthenticated",
     cErr.status !== 401 && cErr.code !== "unauthenticated", JSON.stringify(cErr));
  ok("C2 UI 文案不再说「登录状态已失效」", !/登录状态已失效|登录已失效/.test(cErr.uiMsg||""), JSON.stringify(cErr));
  ok("C3 UI 文案如实说没能确认、且这次没有发出请求",
     /没能确认/.test(cErr.uiMsg||"") && /没有发出|未发出/.test(cErr.uiMsg||""), JSON.stringify(cErr));
  const cThrow = await probe("throw");
  ok("C4 抛出形态不再把异常穿给调用方（六个调用方无一自己 try/catch）",
     cThrow.threw === null && cThrow.uiThrew === null, JSON.stringify(cThrow));
  ok("C4b 抛出形态同样不报成 unauthenticated", cThrow.code !== "unauthenticated", JSON.stringify(cThrow));
  const cNone = await probe("none");
  ok("C5 确实没有会话 → 仍如实报 401 unauthenticated（没改坏）",
     cNone.status === 401 && cNone.code === "unauthenticated", JSON.stringify(cNone));

  // ════════ F faculty/verify：提交时被弹走，表单内容丢掉 ════════
  console.log("\n=== F 教师邀请码提交 ===");
  const submitCode = async () => {
    await cdp.ev(`(()=>{document.getElementById("fCode").value="INV-FIXTURE-CODE"; return true;})()`);
    await cdp.clickReal("#btnCode");
    await sleep(1800);
  };
  await open("faculty/verify/", { roles:[], sessionMode:"error" }, 2400);
  await submitCode();
  ok("F1 读不出时不把人弹去登录页", loginHits() === 0, JSON.stringify(navLog.slice(0,3)));
  const ft = await txt();
  ok("F2 原地说清楚，不谎称登录失效",
     /没能确认/.test(ft) && !/登录已失效|登录状态已失效/.test(ft), ft.slice(0,200));
  /* 取值要 null 安全：修前人已经被弹到登录页，#fCode 根本不存在 ——
     直接读 .value 会让套件自己崩，而不是如实判红。 */
  const fcode = await cdp.ev(`(()=>{const e=document.getElementById("fCode"); return e ? e.value : null;})()`);
  ok("F3 用户填的邀请码还在（没被一次跳转冲掉）", fcode === "INV-FIXTURE-CODE",
     "fCode=" + JSON.stringify(fcode) + " 落点=" + (await cdp.ev(`location.pathname`)));
  await open("faculty/verify/", { roles:[], sessionMode:"none" }, 2400);
  await submitCode();
  const fnav = navLog.find(u=>/\/login\//.test(u))||"";
  ok("F4 确实没有会话 → 仍去登录页，next 带回验证页与邀请码（round2 成果没被改坏）",
     !!fnav && /faculty%2Fverify/i.test(fnav) && /INV-FIXTURE-CODE/.test(decodeURIComponent(fnav)), fnav);

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
console.log("  本地 stub：无真实账号/凭据/服务，无外网请求。");
console.log("  绿灯只证明「读不出登录状态时客户端如实停靠」，不证明真实 Auth 已验收。");
process.exit(fail ? 1 : 0);
