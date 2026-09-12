// 读不出认证级别（AAL）时，三个入口分别会怎样对待用户。
//
// ── 缺陷 ──────────────────────────────────────────────────────────────
// assets/js/portal/auth.js:
//     async function getAal() {
//       const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
//       if (error || !data) return { current: "aal1", next: "aal1" };   // ← 未知冒充明确低级别
//       return { current: data.currentLevel, next: data.nextLevel };
//     }
// 「没读出来」被写成「确定是 aal1」。这与 §84.1 在角色上、第三包在因子表上
// 修过的是同一条纪律：**不确定不能当成确定**。
//
// 还有两种形态同样落进这一支：
//   · getAuthenticatorAssuranceLevel **抛出**（2.116.0 非 AuthError 是 throw 的），
//     getAal 没有 try/catch，异常直接穿出去；
//   · 返回 { data:{ currentLevel:null, nextLevel:null }, error:null } ——
//     这是 JWT 里没有 aal 声明时的真实形状，data 在、值是空的。
//
// ── 三个入口的实际后果 ────────────────────────────────────────────────
//   requireRoleAal2   读不出 → 当 aal1 → 把人 replace 去 /portal/mfa/。
//                     一个**其实已经是 aal2** 的教师被要求再做一次两步验证；
//                     而且做完回来仍然读不出，于是再被送去 —— 每转一圈烧掉一个
//                     一次性动态码。
//   portal/mfa 初始化 读不出 → 当 aal1 → 摆出挑战卡（或注册卡）请他验证。
//   verify 不确定后重试 第三包加的「先问真实 AAL」在读不出时同样退化成 aal1，
//                     于是照发第二次 challenge —— 正是那一条要避免的事。
//
// ── 用的是什么 ────────────────────────────────────────────────────────
// 本地 stub，fixture 因子一律 fixture-*，无真实 MFA/因子/凭据/服务，
// supabase 域名钉 0.0.0.0 并有断言兜底。独占动态端口（DevToolsActivePort）。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-aal-"));
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
      aalMode  "ok" | "error" | "throw" | "partial"（data 在、currentLevel 是 null）
      aal      aalMode==="ok" 时的实际级别
      sessionMode "ok" | "error"（返回 {data:{session:null}, error} —— 真实形状）
      factors  原始因子表；slow/killAfter 同前几套 */
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
          /* 真实形状：读失败时 data.session 是 null，而 error 非空。
             页面只看 data.session 的话，「读不到」就变成了「没登录」。 */
          if (S().sessionMode === "error")
            return reply({ data: { session: null }, error: authErr({ status: 500, message: "boom" }) });
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
        order:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
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
  /* 只取**可见**文本：textContent 连 hidden 子树一起收，而这些页面靠 hidden
     切换卡片（登录页也常驻两条隐藏通知）。不剔掉的话，断言测的是 DOM 里
     有没有这句话，而不是用户有没有看到它 —— 第三包 P2b 吃过同一个亏。 */
  const txt = async () => cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template,[hidden]").forEach(n=>n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();})()`);
  const calls = async () => { const c = (await cdp.ev(`(()=>{try{return JSON.parse(sessionStorage.getItem("aalCalls")||"{}");}catch(e){return{};}})()`))||{};
    return { aal:c.aal||0, listFactors:c.listFactors||0, enroll:c.enroll||0,
             challenge:c.challenge||0, verify:c.verify||0, unenroll:c.unenroll||0 }; };
  const here = async () => cdp.ev(`location.pathname`);
  const mfaHits = () => navLog.filter((u) => /\/portal\/mfa\//.test(u)).length;
  const TEACHER = "portal/teacher/?tab=x";
  const MFA = "portal/mfa/?next=%2Fhelp%2F";
  const VERIFIED = [{ id:"fixture-totp-ok", factor_type:"totp", status:"verified", friendly_name:"AMAS TOTP" }];

  // ════════ U requireRoleAal2 入口 ════════
  console.log("\n=== U requireRoleAal2：读不出 AAL ===");
  for (const [label, scen] of [
    ["返回 error", { aalMode:"error", factors: VERIFIED }],
    ["抛出",       { aalMode:"throw", factors: VERIFIED }],
    ["data 不完整", { aalMode:"partial", factors: VERIFIED }],
  ]) {
    await open(TEACHER, scen, 2600);
    const t = await txt();
    ok("U 读不出（" + label + "）→ 停在「没能确认」的说明页", /没能确认/.test(t), t.slice(0, 120));
    ok("U 读不出（" + label + "）→ **零次**被送去两步验证页（不误导再做 MFA）",
       mfaHits() === 0, "MFA 出现 " + mfaHits() + " 次: " + JSON.stringify(navLog.slice(0,3)));
    ok("U 读不出（" + label + "）→ 明写这不表示没通过，并给重试",
       /不表示/.test(t) && /重试/.test(t), t.slice(0, 160));
    ok("U 读不出（" + label + "）→ **不放行**：教师工作台内容没有渲染",
       !/工作台/.test(t) || /没能确认/.test(t), t.slice(0, 120));
  }
  await open(TEACHER, { aalMode:"ok", aal:"aal1", factors: VERIFIED }, 2600);
  ok("U4 确实 aal1 → 仍按既有规则去两步验证页（没改坏）", mfaHits() >= 1, JSON.stringify(navLog.slice(0,3)));
  await open(TEACHER, { aalMode:"ok", aal:"aal2", factors: VERIFIED }, 2600);
  ok("U5 确实 aal2 → 正常进入教师工作台", (await here()) === "/portal/teacher/" && mfaHits() === 0,
     "落点=" + (await here()));

  // ════════ M portal/mfa 初始化入口 ════════
  console.log("\n=== M portal/mfa 初始化：读不出 AAL ===");
  for (const [label, scen] of [
    ["返回 error", { aalMode:"error", factors: VERIFIED }],
    ["抛出",       { aalMode:"throw", factors: VERIFIED }],
    ["data 不完整", { aalMode:"partial", factors: VERIFIED }],
  ]) {
    await open(MFA, scen, 2600);
    const t = await txt();
    const c = await calls();
    ok("M 读不出（" + label + "）→ 停下来说清楚，不摆出挑战卡请他验证",
       /没能确认/.test(t) && !/请完成两步验证/.test(t), t.slice(0, 140));
    ok("M 读不出（" + label + "）→ 不往下读因子表、不 enroll",
       c.listFactors === 0 && c.enroll === 0, JSON.stringify(c));
    ok("M 读不出（" + label + "）→ 不误称「你还没设置两步验证」",
       !/启用两步验证/.test(t), t.slice(0, 140));
  }
  await open(MFA, { aalMode:"ok", aal:"aal1", factors: VERIFIED }, 2600);
  ok("M4 确实 aal1 且有因子 → 正常停在挑战卡（没改坏）", /请完成两步验证/.test(await txt()));
  await open(MFA, { aalMode:"ok", aal:"aal2", factors: VERIFIED }, 2600);
  ok("M5 确实 aal2 → 正常回跳 next（没改坏）", (await here()) === "/help/", "落点=" + (await here()));

  // ════════ V verify 不确定之后重试 ════════
  console.log("\n=== V 不确定后重试：先问 AAL，读不出时不能照发 challenge ===");
  console.log("  （要等一次 15 秒超时闸）");
  await open(MFA, { aalMode:"ok", aal:"aal1", factors: VERIFIED, slow: { verify: 99000 } }, 2400);
  await cdp.ev(`(()=>{document.getElementById("chCode").value="123456"; return true;})()`);
  await cdp.clickReal("#btnCh");
  await sleep(15800);
  const v0 = await calls();
  ok("V0 前提：第一次已超时，challenge/verify 各一次", v0.challenge === 1 && v0.verify === 1, JSON.stringify(v0));
  // 重试时把 AAL 读坏：第三包的「先问真实 AAL」在读不出时会退化成 aal1
  await cdp.ev(`(()=>{window.__SCEN.aalMode="error"; return true;})()`);
  await cdp.ev(`(()=>{document.getElementById("chCode").value="654321";
                      document.getElementById("chForm").requestSubmit(); return true;})()`);
  await sleep(2600);
  const v1 = await calls();
  ok("V1 AAL 读不出时**不发第二次 challenge**（不拿一次性码去撞第二次）",
     v1.challenge === 1, JSON.stringify(v1));
  const vErr = await cdp.ev(`(()=>{const e=document.getElementById("chErr");
    return { msg:(e.textContent||"").trim(), shown:e.classList.contains("show"),
             btn:!!document.getElementById("btnCh").disabled };})()`);
  ok("V2 如实说没能确认，且不赖到动态码上", vErr.shown === true && !/动态码不正确/.test(vErr.msg), JSON.stringify(vErr));
  ok("V3 按钮恢复可用 —— 可重试", vErr.btn === false, JSON.stringify(vErr));
  ok("V4 人仍留在验证页，没有被放行", (await here()) === "/portal/mfa/", "落点=" + (await here()));

  // ════════ S getSession 返回 error（证据是否成立）════════
  console.log("\n=== S getSession 返回 error ===");
  await open(MFA, { sessionMode:"error", aalMode:"ok", aal:"aal2", factors: VERIFIED }, 2600);
  const st = await txt();
  ok("S1 读不出登录状态时不被当成「没登录」弹去登录页",
     !navLog.some((u) => /\/login\//.test(u)), JSON.stringify(navLog.slice(0,3)));
  ok("S2 而是停下来说清楚并可重试", /没能确认/.test(st) && /重试/.test(st), st.slice(0, 140));

  // ════════ G 闸门与外发 ════════
  console.log("\n=== G 闸门与外发 ===");
  ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");
  ok("G2 全程零次 unenroll（不自动删除因子）", (await calls()).unenroll === 0, JSON.stringify(await calls()));

  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub + 伪造 fixture：无真实 MFA/因子/凭据/服务，无外网请求。");
console.log("  绿灯只证明「读不出 AAL 时客户端如实停靠」，不证明真实 MFA 已验收。");
process.exit(fail ? 1 : 0);
