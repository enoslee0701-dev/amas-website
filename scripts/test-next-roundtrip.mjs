// 回跳（?next=）的往返完整性：带 query/hash 的受限页面 → 登录或 MFA → 回到原处。
//
// ── 修的是什么 ────────────────────────────────────────────────────────
// 门户里生产 ?next= 的地方有四处，口径各不相同：
//
//   auth.js requireRole      encodeURIComponent(location.pathname)        ← 丢 query/hash
//   auth.js requireRoleAal2  encodeURIComponent(location.pathname)        ← 丢 query/hash
//   auth.js watchSession     pathname + search + hash                     ← round1 修对了
//   faculty/verify           手拼 ROOT + "faculty/verify/?code=…"          ← 没经过任何同源校验
//
// 消费 ?next= 的地方有两处（登录页、MFA 页），都走 A.safePath，但：
//
//   login/index.html   「已登录」那一支**整个忽略 next**，直接送 role home
//   portal/mfa/        没有会话时 replace 到 "login/"，**next 整个丢掉**
//
// 结果：学员在 portal/student/courses/?cat=nt#c3 上被要求重新登录，登完回来
// 只剩 /portal/student/courses/ —— 筛选条件和页内定位都没了，得重新找一遍。
// 教师从 portal/teacher/?tab=x#y 被 MFA 闸拦下，过完两步验证同样回到光秃秃的首页。
//
// ── 本套件要证明的 ────────────────────────────────────────────────────
//   1. 四个真实生产入口都保留 pathname + search + hash
//   2. 没有 query/hash 时不多出空的 "?" 或 "#"
//   3. 登录后、MFA 通过后**真的**回到原页面的原状态（端到端，不只看 URL 构造）
//   4. 过期带 next、主动退出不带 next 的区别没有被这次改动弄丢
//   5. 站外 / 协议相对 / 编码绕过的 next 依旧一概拒绝
//   6. next 指回入口自己时不套娃（登录页跳登录页、MFA 跳 MFA 是无限循环）
//   7. 角色与 MFA 要求一点没降低
//
// ── 用的是什么、不是什么 ──────────────────────────────────────────────
// stub 只替换 window.supabase.createClient 返回的假客户端；auth.js 与各页
// 自己的脚本都真跑。无真实身份、无真实登录、无远端写入、无外网
// （supabase 域名钉到 0.0.0.0，并有断言兜底）。
//
// 端口独占 9417 —— 固定端口的 CDP 套件必须串行跑。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { launchOwnChrome } from "./lib/chrome-launcher.mjs";

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

/* 端口与 profile 由本次实例真正拥有（见 lib/chrome-launcher.mjs）：
   端口交给操作系统分配，再从自己那个 Chrome 的 DevToolsActivePort 读回来，
   不写死、不按 pid 猜、不连已经开着的浏览器。 */
const { chrome, port, profileDir: prof } = await launchOwnChrome({
  profilePrefix: "amas-next-",
  extraArgs: [
    "--disable-gpu", "--hide-scrollbars",
    "--host-resolver-rules=MAP *.supabase.co 0.0.0.0, MAP *.supabase.in 0.0.0.0",
  ],
});

let externalHits = 0;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  on(m, f) { this.handlers.set(m, f); }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try { const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
      if (!url) await sleep(250);
    }
    if (!url) throw new Error("连不上 Chrome 调试端口");
    const s = await new Promise((res, rej) => { const k = new WebSocket(url); k.onopen = () => res(k); k.onerror = rej; });
    const c = new Cdp(s);
    s.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method && c.handlers.has(m.method)) c.handlers.get(m.method)(m.params); };
    return c;
  }
  send(method, params = {}, ms = 25000) {
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
    await sleep(360);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';

/** 假客户端。会话与 AAL 两件事都可以在一次流程里**变化**，否则端到端的往返
    根本构造不出来：
      · signInWithPassword 成功后 getSession 必须真的开始返回会话，
        不然登录页跳回原页面，原页面的守卫又把人踢回登录页。
      · mfa.verify 成功后 AAL 必须真的升到 aal2，
        不然从 MFA 回到教师页，requireRoleAal2 又把人送回 MFA —— 来回弹。
    两个状态都写 sessionStorage，跨导航存活。 */
const STUB = `
window.supabase = {
  createClient: function(){
    var reply = function(v){ return Promise.resolve(v); };
    var S = function(){ return window.__SCEN || {}; };
    var ss = function(k){ try { return sessionStorage.getItem(k); } catch (e) { return null; } };
    var set = function(k,v){ try { sessionStorage.setItem(k,v); } catch (e) {} };

    window.__authSubs = window.__authSubs || [];
    window.__fireAuth = function(ev, sess){
      if (ev === "SIGNED_OUT") set("sessionDead", "1");
      (window.__authSubs || []).slice().forEach(function(f){ try { f(ev, sess || null); } catch (e) {} });
    };

    var liveSession = function(){
      if (ss("sessionDead") === "1") return null;
      if (S().session) return S().session;
      if (ss("loggedIn") === "1") return { user: { id: "u-1", email: "a@example.invalid" }, access_token: "stub" };
      return null;
    };
    var liveAal = function(){
      if (ss("verified") === "1") return "aal2";
      return S().aal || "aal1";
    };

    return {
      auth: {
        getSession: function(){ return reply({ data: { session: liveSession() } }); },
        onAuthStateChange: function(cb){
          window.__authSubs.push(cb);
          return { data: { subscription: { unsubscribe: function(){
            var i = window.__authSubs.indexOf(cb); if (i > -1) window.__authSubs.splice(i, 1);
          } } } };
        },
        signOut: function(){
          set("sessionDead", "1");
          window.__fireAuth("SIGNED_OUT");
          return reply({});
        },
        signInWithPassword: function(){
          set("loggedIn", "1");
          try { sessionStorage.removeItem("sessionDead"); } catch (e) {}
          return reply({ data: { user: { id: "u-1" }, session: { access_token: "stub" } }, error: null });
        },
        mfa: {
          getAuthenticatorAssuranceLevel: function(){
            var a = liveAal();
            return reply({ data: { currentLevel: a, nextLevel: "aal2" }, error: null });
          },
          listFactors: function(){ return reply({ data: { totp: S().factors || [] }, error: null }); },
          enroll: function(){ return reply({ data: { id: "f-new", totp: {
            qr_code: "<svg xmlns='http://www.w3.org/2000/svg' width='190' height='190'></svg>",
            secret: "STUBSECRETNOTREAL" } }, error: null }); },
          challenge: function(){ return reply({ data: { id: "ch-1" }, error: null }); },
          verify: function(){ set("verified", "1"); return reply({ data: {}, error: null }); }
        }
      },
      from: function(){ var q = { select:function(){return q;}, eq:function(){return q;},
        in:function(){return q;}, order:function(){return q;}, limit:function(){return q;},
        maybeSingle:function(){return q;},
        then:function(r){ return Promise.resolve({ data: [], error: null }).then(r); } }; return q; },
      rpc: function(name){
        var sc = S();
        if (name === "my_roles") {
          // 读不到角色的形态：和「确实没有角色」必须分得开
          if (sc.rolesFail) return reply({ data: null, error: { message: "boom" }, status: 500 });
          return reply({ data: (sc.roles || []).map(function(r){ return { role: r }; }), error: null });
        }
        if (name === "my_profile") return reply({ data: { display_name: "测试用户", email: "a@example.invalid" }, error: null });
        var r = (sc.rpc && sc.rpc[name]) || { data: null, error: null };
        return reply({ data: r.data, error: r.error || null });
      },
      functions: { invoke: function(){ return reply({ data: null, error: null }); } }
    };
  }
};`;

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
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" },
                            { name: "Cache-Control", value: "no-store" }], body: b64(STUB) });
        return;
      }
      if (u.indexOf("supabase-config.js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" },
                            { name: "Cache-Control", value: "no-store" }], body: b64(CFG) });
        return;
      }
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });

  const navLog = [];
  cdp.on("Page.frameNavigated", (p) => {
    if (p.frame && !p.frame.parentId) navLog.push(String(p.frame.url || ""));
  });

  const open = async (page, scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__SCEN = " + JSON.stringify(scen) + ";",
    });
    /* 清理用一次性 ev，绝不能写进注入脚本（那是累积的，会抹掉后续用例的状态）。
       三个键都要清：会话死没死、登没登、验没验。 */
    await cdp.ev(`(()=>{try{["sessionDead","loggedIn","verified"].forEach(k=>sessionStorage.removeItem(k));}catch(e){} return true;})()`).catch(() => {});
    navLog.length = 0;
    await cdp.send("Page.navigate", { url: `${BASE}/${page}` });
    await sleep(wait || 2400);
    return navLog.slice();
  };
  /** 当前所在的完整站内位置（含 hash）——frameNavigated 的 URL 不一定带 hash */
  const where = async () => cdp.ev(`location.pathname + location.search + location.hash`);
  const loginNav = () => navLog.find((u) => /\/login\//.test(u)) || "";
  const mfaNav = () => navLog.find((u) => /\/portal\/mfa\//.test(u)) || "";
  const nextOf = (u) => { try { return new URLSearchParams(new URL(u).search).get("next"); } catch (e) { return null; } };
  const login = async (wait) => {
    await cdp.ev(`(()=>{document.getElementById("fId").value="a@example.invalid";
                        document.getElementById("fPw").value="pw";return true;})()`);
    await cdp.clickReal("#btnLogin");
    await sleep(wait || 2200);
  };

  const STU = { roles: ["student"], rpc: { my_learning: { data: [] }, my_student_capabilities: { data: {} } } };
  const TEA = { roles: ["teacher"] };

  // ════════ R requireRole：未登录访问受限页（PORTAL-blueprint P1-01）════════
  console.log("\n=== R 未登录访问受限页 → 登录页 ===");
  await open("portal/student/courses/?cat=nt#c3", STU);
  const r1 = loginNav();
  ok("R1 未登录被送到登录页", !!r1, JSON.stringify(navLog.slice(0, 3)));
  ok("R1 next 保留了 query", (nextOf(r1) || "").indexOf("cat=nt") > -1, "next=" + nextOf(r1));
  ok("R1 next 保留了 hash", (nextOf(r1) || "").indexOf("#c3") > -1, "next=" + nextOf(r1));
  ok("R1 next 指回原页面本身", (nextOf(r1) || "").indexOf("/portal/student/courses/") === 0, "next=" + nextOf(r1));

  await open("portal/student/", STU);
  const r2 = nextOf(loginNav()) || "";
  ok("R2 没有 query/hash 时不多出空的 ? 或 #", r2 === "/portal/student/", "next=" + JSON.stringify(r2));

  // R3 端到端：登录之后真的回到原页面的原状态
  await open("portal/student/courses/?cat=nt#c3", STU);
  await login(2600);
  ok("R3 登录后回到原页面，query 与 hash 都还在",
     (await where()) === "/portal/student/courses/?cat=nt#c3", "落点=" + (await where()));

  // ════════ F requireRoleAal2：MFA 闸 ════════
  console.log("\n=== F MFA 闸 → 两步验证页 ===");
  await open("portal/teacher/?tab=x#y", { ...TEA, session: { user: { id: "u-1" } }, aal: "aal1", factors: [{ id: "f-1" }] });
  const f1 = mfaNav();
  ok("F1 aal1 的教师被送去两步验证（MFA 要求没降低）", !!f1, JSON.stringify(navLog.slice(0, 3)));
  ok("F1 next 保留了 query 与 hash",
     (nextOf(f1) || "").indexOf("tab=x") > -1 && (nextOf(f1) || "").indexOf("#y") > -1, "next=" + nextOf(f1));

  // F2 端到端：过完两步验证真的回到原页面的原状态
  await open("portal/teacher/?tab=x#y", { ...TEA, session: { user: { id: "u-1" } }, aal: "aal1", factors: [{ id: "f-1" }] });
  ok("F2 前提：停在挑战卡", /请完成两步验证/.test(await cdp.ev(`document.body.textContent||""`)));
  await cdp.ev(`(()=>{document.getElementById("chCode").value="123456";return true;})()`);
  await cdp.clickReal("#btnCh");
  await sleep(2800);
  ok("F2 验证通过后回到原页面，query 与 hash 都还在",
     (await where()) === "/portal/teacher/?tab=x#y", "落点=" + (await where()));

  // ════════ M MFA 页没有会话：next 不能丢 ════════
  console.log("\n=== M 两步验证页没有会话 ===");
  await open("portal/mfa/?next=%2Fportal%2Fteacher%2F%3Ftab%3Dx%23y", { ...TEA, aal: "aal1" });
  const m1 = loginNav();
  ok("M1 没有会话时被送到登录页", !!m1, JSON.stringify(navLog.slice(0, 3)));
  ok("M1 原来要去的地方没有被丢掉（next 套一层带上）",
     (nextOf(m1) || "").indexOf("/portal/mfa/") === 0 && decodeURIComponent(nextOf(m1) || "").indexOf("tab=x") > -1,
     "next=" + nextOf(m1));

  // ════════ L 登录页「已经登着」那一支 ════════
  console.log("\n=== L 已登录访问登录页 ===");
  await open("login/?next=%2Fportal%2Fstudent%2Fcourses%2F%3Fcat%3Dnt%23c3",
             { ...STU, session: { user: { id: "u-1" } } }, 2600);
  ok("L1 已登录时也按 next 回原处，而不是一律送 role home",
     (await where()) === "/portal/student/courses/?cat=nt#c3", "落点=" + (await where()));

  await open("login/", { ...STU, session: { user: { id: "u-1" } } }, 2600);
  ok("L2 没有 next 时仍按角色进自己的首页（既有行为没被改坏）",
     /\/portal\/student\//.test(await where()), "落点=" + (await where()));

  /* 登录页「其实还登着」那一支是**身份切换的决策点**：它要决定把人送进哪个空间。
     读不到角色时原来走 A.getRoles()，拿到 [] 就 homeForRoles([]) → portal/applicant/
     —— 一个教师或管理员会被送进申请者空间。而同一页的提交分支早就改用
     fetchRoles，并在读不到时留在登录页如实说（§84.1 定下的纪律）。
     这是 c5f3ed6 那一批里最后一个还用旧签名的入口。 */
  await open("login/", { ...STU, session: { user: { id: "u-1" } }, rolesFail: true }, 3000);
  const l3 = await cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template,[hidden]").forEach(n=>n.remove());
    return { text:(c.textContent||"").replace(/\\s+/g," ").trim(), here: location.pathname };})()`);
  ok("L3 已登录但读不到角色 → 不猜空间，留在登录页", l3.here === "/login/", "落点=" + l3.here);
  ok("L3b 并如实说读不到权限（复用本页既有文案）",
     /读不到你的账号权限|没能确定该进哪个空间/.test(l3.text), l3.text.slice(0, 200));

  // ════════ V faculty/verify：邀请码入口 ════════
  console.log("\n=== V 教师邀请码入口 ===");
  await open("faculty/verify/", { roles: [] });
  await cdp.ev(`(()=>{document.getElementById("fCode").value="INV-TEST-CODE";return true;})()`);
  await cdp.clickReal("#btnCode");
  await sleep(2000);
  const v1 = loginNav();
  ok("V1 未登录输入邀请码 → 登录页", !!v1, JSON.stringify(navLog.slice(0, 3)));
  ok("V1 next 带回验证页并保住邀请码",
     (nextOf(v1) || "").indexOf("/faculty/verify/") === 0 && (nextOf(v1) || "").indexOf("INV-TEST-CODE") > -1,
     "next=" + nextOf(v1));

  // ════════ S 过期与主动退出的区别（round1 成果的最小回归）════════
  console.log("\n=== S 过期 vs 主动退出 ===");
  await open("portal/student/courses/?cat=nt#c3", { ...STU, session: { user: { id: "u-1" } } });
  navLog.length = 0;
  await cdp.ev(`(()=>{window.__fireAuth("SIGNED_OUT");return true;})()`);
  await sleep(2200);
  const s1 = loginNav();
  ok("S1 过期回登录页并带 next（含 query 与 hash）",
     !!s1 && (nextOf(s1) || "").indexOf("cat=nt") > -1 && (nextOf(s1) || "").indexOf("#c3") > -1, "next=" + nextOf(s1));

  await open("portal/student/courses/?cat=nt#c3", { ...STU, session: { user: { id: "u-1" } } });
  navLog.length = 0;
  await cdp.ev(`(()=>{window.AmasAuth.signOut();return true;})()`);
  await sleep(2200);
  const s2 = loginNav();
  ok("S2 主动退出**不带** next（区别没被这次改动弄丢）", !!s2 && !/next=/.test(s2), s2);

  // ════════ X 站外 / 协议相对 / 编码绕过：一概拒绝 ════════
  console.log("\n=== X 恶意 next 依旧拒绝 ===");
  const EVIL = ["//evil.example", "/.//evil.example", "/%2e//evil.example",
                "https://evil.example/x", "/a/../..//evil.example", "\\\\evil.example"];
  for (const v of EVIL) {
    await open("login/?next=" + encodeURIComponent(v), STU);
    await login(2400);
    const w = await cdp.ev(`location.origin`);
    ok("X 站外向量被拒，人留在本站：" + JSON.stringify(v), w === BASE, "origin=" + w + " 落点=" + (await where()));
  }
  await open("portal/mfa/?next=" + encodeURIComponent("//evil.example"),
             { ...TEA, session: { user: { id: "u-1" } }, aal: "aal2", factors: [{ id: "f-1" }] });
  ok("X MFA 页的站外 next 同样被拒", (await cdp.ev(`location.origin`)) === BASE,
     "落点=" + (await where()));

  // ════════ N 不套娃：next 指回入口自己 ════════
  console.log("\n=== N next 指回入口自己 ===");
  await open("login/?next=%2Flogin%2F", { ...STU, session: { user: { id: "u-1" } } }, 2800);
  ok("N1 已登录 + next 指回登录页 → 不自我循环，按角色进首页",
     /\/portal\/student\//.test(await where()), "落点=" + (await where()));
  ok("N1 导航里没有反复出现登录页", navLog.filter((u) => /\/login\//.test(u)).length <= 2,
     "登录页出现 " + navLog.filter((u) => /\/login\//.test(u)).length + " 次: " + JSON.stringify(navLog.slice(0, 5)));

  await open("portal/mfa/?next=%2Fportal%2Fmfa%2F",
             { ...TEA, session: { user: { id: "u-1" } }, aal: "aal2", factors: [{ id: "f-1" }] }, 2800);
  /* 落点不钉死在 /portal/：门户总入口对**单角色**账号本来就会正当地再转发一次
     （portal/ → portal/teacher/）。要证的是「没有卡在 MFA 页上打转」，不是落到哪。 */
  ok("N2 aal2 + next 指回 MFA 页 → 不自我循环，没有卡在 MFA 页",
     !/\/portal\/mfa\//.test(await where()), "落点=" + (await where()));
  ok("N2 导航里没有反复出现 MFA 页", navLog.filter((u) => /\/portal\/mfa\//.test(u)).length <= 2,
     "MFA 页出现 " + navLog.filter((u) => /\/portal\/mfa\//.test(u)).length + " 次: " + JSON.stringify(navLog.slice(0, 5)));

  /* N3 判据层的反向对照：证明「拒绝指回本页」这道闸是承重的，不是摆设。
     没有它，登录页读出来的 next 就是登录页自己——replace 过去，到了又读出
     同一个 next，再 replace……而 L1（已登录也按 next 走）恰恰把这条路接通了，
     所以这道闸是跟着 L1 一起必须存在的，不是可选的洁癖。 */
  await open("login/?next=%2Flogin%2F", STU, 1800);
  const n3 = await cdp.ev(`(() => {
    const A = window.AmasAuth;
    // 旧语义：只做同源收口，不问这个 next 是不是指回本页
    const noSelfCheck = () => A.safePath(new URLSearchParams(location.search).get("next"));
    return { old: noSelfCheck(), now: A.nextFromQuery() };
  })()`);
  ok("N3 没有这道闸时，next 会解析成登录页自己 —— 那就是循环的起点",
     n3.old === "/login/", JSON.stringify(n3));
  ok("N3 真实实现把它判为 null，所以 N1 那条不是空转",
     n3.now === null, JSON.stringify(n3));

  // ════════ G 角色与 MFA 要求没有被降低 ════════
  console.log("\n=== G 闸门没松 ===");
  await open("portal/admin/?tab=q#z", { roles: ["student"], session: { user: { id: "u-1" } }, aal: "aal2" });
  const g1 = await where();
  ok("G1 学员带着 query/hash 也进不去管理后台", !/\/portal\/admin\//.test(g1), "落点=" + g1);
  await open("portal/teacher/?tab=x#y", { ...TEA, session: { user: { id: "u-1" } }, aal: "aal1", factors: [] });
  ok("G2 aal1 的教师仍被 MFA 闸拦下，不因为 next 变长就放行",
     /\/portal\/mfa\//.test(await where()), "落点=" + (await where()));

  // ════════ Z 外发 ════════
  console.log("\n=== Z 外发 ===");
  ok("Z1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");

  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  全程本机 stub：无真实身份、无真实登录、无远端写入、无外网请求。");
console.log("  绿灯只证明「给定这些返回值时回跳做对了事」，不证明线上 Auth/RLS/MFA 已验收。");
process.exit(fail ? 1 : 0);
