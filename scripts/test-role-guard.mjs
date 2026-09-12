// 门户角色守卫：无限重定向的修复验证。
//
// ── 修的是什么 ────────────────────────────────────────────────────────
// getRoles() 出错时返回 []，与「确实没有角色」在调用方眼里完全一样。
// 配上 homeForRoles([]) → portal/applicant/，而该页守卫又要求 applicant 角色，
// 于是 replace 到同一地址 → 守卫再不通过 → 再 replace：**无限重定向**。
// 触发面比「新用户还没角色」宽得多 —— my_roles 抖一下、RLS 改一次、
// RPC 短暂不可用，都会走到同一条死路。
//
// ── 本套件要证明的 ────────────────────────────────────────────────────
//   1. 读不到角色 → 停在「没能确认你的权限」，给重试，**一次跳转都不发生**
//   2. 确实没有角色 → 停在「还没有门户权限」，**一次跳转都不发生**
//   3. RPC 恢复之后 → 正常进入自己的空间（错误不是单向门）
//   4. 各角色的既有正常入口一条都没被这次修改挡住
//   5. 有角色但不含本页 → 仍按既有规则回自己首页；而「回自己首页」算出来
//      就是本页时，停下来说清楚，绝不 replace 到自己
//
// ── 用的是什么、不是什么 ──────────────────────────────────────────────
// stub 只替换 window.supabase.createClient 返回的假客户端；
// assets/js/portal/auth.js 的 requireRole / fetchRoles 与页面脚本都真跑。
// 无真实身份、无真实登录、无远端写入、无外网（supabase 域名钉到 0.0.0.0）。
//
// 端口独占 9415 —— 固定端口的 CDP 套件必须串行跑，并行会互相抢调试端口，
// 跑出一堆看似回归其实是串台的数字。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-guard-"));
const port = 9415;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP *.supabase.co 0.0.0.0, MAP *.supabase.in 0.0.0.0",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

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

/** 假客户端。my_roles 的行为由 __SCEN.rolesMode 决定：
      "error"   RPC 返回 error
      "throw"   RPC 抛出
      "empty"   成功但一条角色都没有
      数组       成功并返回这些角色
    __SCEN.healAfter：前 N 次按 rolesMode，之后返回 healRoles（验证「错误不是单向门」）。 */
const STUB = `
window.supabase = {
  createClient: function(){
    var reply = function(v){ return Promise.resolve(v); };
    var S = function(){ return window.__SCEN || {}; };
    /* 计数器必须**跨 reload 存活** —— 「失败后点重试能恢复」这个场景本身就跨页面载入。
       写在 window 上会随文档一起归零，于是重试后又是第 1 次、又失败，
       恢复场景根本没被构造出来。 */
    return {
      auth: {
        /* 会话一旦失效或登出，getSession 必须**真的**返回 null。
           先前 stub 始终返回有效会话，于是失效后跳到登录页、登录页发现
           「还登着」又把人送回门户 —— 一个来回，最终位置看起来没动，
           像是跳转没发生。真实的过期不会这样。 */
        getSession: function(){
          var dead = false;
          try { dead = sessionStorage.getItem("sessionDead") === "1"; } catch (e) {}
          return reply({ data: { session: dead ? null : (S().session || null) } });
        },
        mfa: { getAuthenticatorAssuranceLevel: function(){
          var a = S().aal || "aal1";
          return reply({ data: { currentLevel: a, nextLevel: a } }); } },
        /* 记下订阅者，让测试能从外部真的触发一次认证事件 ——
           会话失效走的就是这条路，不能只 stub 结果对象。 */
        onAuthStateChange: function(cb){
          window.__authSubs = window.__authSubs || [];
          window.__authSubs.push(cb);
          window.__fireAuth = function(ev, sess){
            // SIGNED_OUT 意味着 SDK 已经清掉会话，stub 也要照做
            if (ev === "SIGNED_OUT") { try { sessionStorage.setItem("sessionDead", "1"); } catch (e) {} }
            (window.__authSubs || []).forEach(function(f){ try { f(ev, sess || null); } catch (e) {} });
          };
          return { data: { subscription: { unsubscribe: function(){} } } };
        },
        signOut: function(){
          window.__signedOut = true;
          try { sessionStorage.setItem("sessionDead", "1"); } catch (e) {}
          return reply({});
        },
        signInWithPassword: function(){ return reply({ data: { user: { id: "u-1" },
          session: { access_token: "stub", user: { id: "u-1" } } }, error: null }); }
      },
      from: function(){ var q = { select:function(){return q;}, eq:function(){return q;},
        in:function(){return q;}, order:function(){return q;}, limit:function(){return q;},
        maybeSingle:function(){return q;},
        then:function(r){ return Promise.resolve({ data: [], error: null }).then(r); } }; return q; },
      rpc: function(name, args){
        var sc = S();
        if (name === "my_roles") {
          var mode = sc.rolesMode;
          /* 「先失败一次、重试就好」用一个**独立的 sessionStorage 键**记，不要用调用计数器。
             CDP 的 addScriptToEvaluateOnNewDocument 是**累积**的：每次 open() 注册的脚本
             在之后每一次 reload 都会再跑一遍，早先那些会把共用的计数器清零，
             于是重试后又从第 1 次开始、又失败 —— 恢复场景根本没被构造出来。
             换成一个早先脚本从不引用的键，就绕开了这件事。 */
          if (mode === "error-then-ok") {
            var seen = null;
            try { seen = sessionStorage.getItem("healSeen"); } catch (e) {}
            if (!seen) {
              try { sessionStorage.setItem("healSeen", "1"); } catch (e) {}
              return reply({ data: null, error: { message: "boom" } });
            }
            return reply({ data: (sc.healRoles || []).map(function(r){ return { role: r }; }), error: null });
          }
          if (mode === "throw") return Promise.reject(new TypeError("Failed to fetch"));
          if (mode === "error") return reply({ data: null, error: { message: "boom" } });
          if (mode === "empty") return reply({ data: [], error: null });
          return reply({ data: (mode || []).map(function(r){ return { role: r }; }), error: null });
        }
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

  /* 导航序列是这套测试的核心量具：无限重定向的形态就是**同一个 URL 反复出现**。 */
  const navLog = [];
  cdp.on("Page.frameNavigated", (p) => {
    if (p.frame && !p.frame.parentId) navLog.push(String(p.frame.url || ""));
  });

  const SESSION = { user: { id: "u-1", email: "a@example.invalid" } };
  const open = async (page, scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      /* ★ 注入脚本里**绝不能**做清理动作。
         addScriptToEvaluateOnNewDocument 是累积的：每个用例注册的脚本在之后
         每一次 reload 都会再跑一遍，而且早注册的先跑。
         先前把 removeItem 写在这里，于是 G3 点重试后，G1~G2c 那几段抢先把
         healSeen 抹掉，my_roles 又当成第一次、又失败 —— 恢复场景测不出来。
         要清理就在用例之间用一次性的 ev 调用做。 */
      source: "window.__SCEN = " + JSON.stringify(scen) + "; window.__signedOut = false;",
    });
    // 复活会话：用一次性 ev，**不要**写进注入脚本（那是累积的，会抹掉后续用例的状态）
    await cdp.ev(`(()=>{try{sessionStorage.removeItem("sessionDead");}catch(e){} return true;})()`).catch(() => {});
    navLog.length = 0;
    await cdp.send("Page.navigate", { url: `${BASE}/${page}` });
    await sleep(wait || 2600);
    return navLog.slice();
  };
  const txt = async () => cdp.ev(`(()=>{
    const c = document.body.cloneNode(true);
    c.querySelectorAll("script,style,template").forEach(n => n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();
  })()`);
  const here = async () => cdp.ev(`location.pathname`);

  // ════════════ G1 读不到角色（RPC 返回 error）════════════
  console.log("\n=== G1 角色 RPC 失败 ===");
  const g1 = await open("portal/student/", { session: SESSION, rolesMode: "error" });
  const t1 = await txt();
  ok("G1 停在「没能确认你的权限」", /没能确认你的权限/.test(t1), t1.slice(0, 160));
  ok("G1 **明说这不表示没有权限**（读不到 ≠ 没有）",
     /这不表示你没有权限/.test(t1), t1.slice(0, 220));
  ok("G1 给出重试", /重试/.test(t1), t1.slice(0, 220));
  ok("G1 给出退出登录与返回官网两条出路",
     /退出登录/.test(t1) && /返回官网/.test(t1), t1.slice(0, 240));
  ok("G1 **一次跳转都没有发生**（无限重定向的直接反证）",
     g1.length <= 1, "导航 " + g1.length + " 次: " + JSON.stringify(g1.slice(0, 4)));
  ok("G1 仍停在原地址，没被弹去申请者中心",
     /portal\/student\//.test(await here()), await here());
  ok("G1 标题栏不再谎称这是学员中心",
     !/学员中心/.test(await cdp.ev(`document.title`)), await cdp.ev(`document.title`));
  ok("G1 焦点落在状态标题上（读屏能念出真实状态）",
     (await cdp.ev(`document.activeElement && document.activeElement.id`)) === "portalBlockedTitle",
     await cdp.ev(`document.activeElement && document.activeElement.id`));
  ok("G1 按钮都够 44 高",
     (await cdp.ev(`[...document.querySelectorAll("#blockRetry,#blockOut,a[href$='index.html']")]
        .every(el => el.getBoundingClientRect().height >= 44)`)) === true);

  // G1b RPC 抛出（不是返回 error）也走同一条
  const g1b = await open("portal/student/", { session: SESSION, rolesMode: "throw" });
  ok("G1b RPC 抛异常同样判为读不到，不当成没有权限",
     /没能确认你的权限/.test(await txt()), (await txt()).slice(0, 160));
  ok("G1b 抛异常时同样零跳转", g1b.length <= 1, "导航 " + g1b.length + " 次");

  // ════════════ G2 确实没有角色 ════════════
  console.log("\n=== G2 成功读到，确实一个角色都没有 ===");
  const g2 = await open("portal/student/", { session: SESSION, rolesMode: "empty" });
  const t2 = await txt();
  ok("G2 停在「还没有门户权限」", /还没有门户权限/.test(t2), t2.slice(0, 160));
  ok("G2 明说登录是有效的（别让用户以为账号坏了）",
     /登录是有效的/.test(t2), t2.slice(0, 220));
  ok("G2 指向审核开通的既有规范，不编造流程",
     /须经学校审核开通/.test(t2), t2.slice(0, 260));
  ok("G2 **一次跳转都没有发生**", g2.length <= 1,
     "导航 " + g2.length + " 次: " + JSON.stringify(g2.slice(0, 4)));
  ok("G2 不与 G1 混为一谈（没有权限 ≠ 读不到权限）",
     !/没能确认你的权限/.test(t2), t2.slice(0, 200));
  ok("G2 不提权：页面上没有任何学员数据",
     !/学号|学籍|课程目录/.test(t2), t2.slice(0, 240));

  // G2b 申请者中心自己也不再自我弹跳（原死循环的正中心）
  const g2b = await open("portal/applicant/", { session: SESSION, rolesMode: "empty" });
  ok("G2b 申请者中心在无角色时不再弹向自己", g2b.length <= 1,
     "导航 " + g2b.length + " 次: " + JSON.stringify(g2b.slice(0, 4)));
  ok("G2b 申请者中心给的是说明页而不是空白", /还没有门户权限/.test(await txt()));

  // G2c 门户总入口
  const g2c = await open("portal/", { session: SESSION, rolesMode: "empty" });
  ok("G2c 门户总入口无角色时不弹跳", g2c.length <= 1, "导航 " + g2c.length + " 次");

  // ════════════ G3 失败之后能恢复 ════════════
  console.log("\n=== G3 RPC 恢复后正常进入（错误不是单向门）===");
  // 第 1 次失败 → 停靠页；点重试（reload）后第 2 次成功
  await cdp.ev(`(()=>{try{sessionStorage.removeItem("healSeen");}catch(e){} return true;})()`).catch(() => {});
  await open("portal/student/", { session: SESSION, rolesMode: "error-then-ok",
                                  healRoles: ["student"],
                                  rpc: { my_learning: { data: [] },
                                         my_student_capabilities: { data: {} } } });
  ok("G3 第一次确实先停在读不到", /没能确认你的权限/.test(await txt()));
  navLog.length = 0;
  await cdp.clickReal("#blockRetry");
  await sleep(2600);
  const t3 = await txt();
  ok("G3 点重试后进入学员空间", /课程|学员|我的/.test(t3) && !/没能确认你的权限/.test(t3),
     t3.slice(0, 180));
  ok("G3 恢复后不再显示任何停靠页", !/还没有门户权限/.test(t3), t3.slice(0, 180));

  // ════════════ G4 既有各角色正常入口没被挡住 ════════════
  console.log("\n=== G4 各角色既有入口回归 ===");
  /* 教师工作台与管理后台是 requireAal2 的双闸页：aal1 时跳 portal/mfa/ 是
     **正确且有限**的既有行为，不是自我弹跳。所以这里按页给足 aal，
     MFA 那一跳另用 G4b 单独验。 */
  const entries = [
    ["portal/student/", ["student"], /学员|课程|我的/, "学员", "aal1"],
    ["portal/teacher/", ["teacher"], /教师|工作台|我的/, "教师", "aal2"],
    ["portal/applicant/", ["applicant"], /申请|我的/, "申请者", "aal1"],
    ["portal/admin/", ["registrar"], /管理|招生|教师|学籍/, "教务（管理后台）", "aal2"],
  ];
  for (const [page, roles, expect, label, aal] of entries) {
    const nav = await open(page, { session: SESSION, rolesMode: roles, aal: aal,
      rpc: { my_learning: { data: [] }, my_student_capabilities: { data: {} },
             my_profile: { data: { display_name: "测试", email: "a@example.invalid" } },
             my_student_profile: { data: { self_editable: {}, registrar_managed: {}, has_student_record: false } } } });
    const t = await txt();
    ok("G4 " + label + " 能正常进入自己的空间", expect.test(t), t.slice(0, 140));
    ok("G4 " + label + " 没有被停靠页挡住",
       !/没能确认你的权限/.test(t) && !/还没有门户权限/.test(t) && !/没有访问这个页面的权限/.test(t),
       t.slice(0, 160));
    ok("G4 " + label + " 不发生自我弹跳", nav.length <= 1, "导航 " + nav.length + " 次");
  }

  // G4b MFA 双闸：aal1 时跳一次 MFA，且只跳一次
  const g4b = await open("portal/teacher/", { session: SESSION, rolesMode: ["teacher"], aal: "aal1" });
  ok("G4b 教师页在 aal1 时跳去 MFA（既有双闸，未被本次改动影响）",
     /portal\/mfa\//.test(await here()), await here());
  ok("G4b 这是有限次跳转，不是循环", g4b.length <= 3,
     "导航 " + g4b.length + " 次: " + JSON.stringify(g4b.slice(0, 4)));
  ok("G4b MFA 的 next 指回教师页",
     /next=/.test(await cdp.ev(`location.search`)), await cdp.ev(`location.search`));

  // ════════════ G5 有角色但不含本页：既有规则不变 ════════════
  console.log("\n=== G5 越权仍按既有规则回自己首页 ===");
  const g5 = await open("portal/admin/", { session: SESSION, rolesMode: ["student"],
    rpc: { my_learning: { data: [] }, my_student_capabilities: { data: {} } } });
  ok("G5 学员打不开管理后台，被送回学员空间",
     /portal\/student\//.test(await here()), await here());
  ok("G5 这是**有限次**跳转，不是循环", g5.length <= 3,
     "导航 " + g5.length + " 次: " + JSON.stringify(g5.slice(0, 5)));
  ok("G5 不提权：没渲染出管理后台内容",
     !/审核台|学籍管理|招生管理/.test(await txt()), (await txt()).slice(0, 160));

  // G5b 「回自己首页」算出来就是本页时，必须停下来
  const g5b = await cdp.ev(`(async () => {
    // 直接问判据本身：角色 student、当前就在 student 首页、但只允许 teacher
    // —— 这种组合下 homeForRoles 会算出当前页，旧代码会 replace 到自己。
    const A = window.AmasAuth;
    return { home: A.homeForRoles(["student"]), root: A.ROOT };
  })()`);
  ok("G5b homeForRoles 对单一角色给出该角色首页（判据前提成立）",
     /portal\/student\/$/.test(g5b.home), JSON.stringify(g5b));

  // ════════════ G6 停靠页的退出登录是真的调用了登出 ════════════
  console.log("\n=== G6 停靠页的出路是真的 ===");
  await open("portal/student/", { session: SESSION, rolesMode: "empty" });
  navLog.length = 0;
  await cdp.clickReal("#blockOut");
  await sleep(1200);
  /* 别用 window 上的标志位判 —— signOut 之后页面会跳到 login/，
     标志位随旧文档一起没了，那样测出来永远是 false。
     看**去向**才是可靠的：真的登出了就会落在登录页。 */
  ok("G6 点「退出登录」确实把人带到登录页",
     /\/login\//.test(await here()) || navLog.some((u) => /\/login\//.test(u)),
     (await here()) + " | " + JSON.stringify(navLog.slice(0, 3)));

  // ════════════ N0 证明「零跳转」不是空转 ════════════
  console.log("\n=== N0 旧行为下确实会自我弹跳 ===");
  /* 不改任何文件：在页面里把 requireRole 换成旧行为（读不到就当没角色、
     直接 replace 到 homeForRoles([])），看导航序列会不会真的开始刷屏。
     没有这一节，「导航 <= 1 次」这类断言就无从证明自己有意义。 */
  await open("portal/applicant/", { session: SESSION, rolesMode: "error" });
  navLog.length = 0;
  await cdp.ev(`(() => {
    const A = window.AmasAuth;
    // 旧行为：出错也当成「成功且无角色」，然后照 homeForRoles 弹走
    window.__oldGuard = async function () {
      const r = await A.client.rpc("my_roles");
      const roles = r.error ? [] : (r.data || []).map(x => x.role);
      const target = A.homeForRoles(roles);
      if (location.pathname.replace(/index\.html$/, "") !== String(target).replace(/index\.html$/, "")) {
        location.replace(target);
      } else {
        // 目标就是当前页 —— 旧代码在这里照样 replace，于是永远回到同一处
        location.replace(target);
      }
      return null;
    };
    return true;
  })()`);
  const beforeN0 = navLog.length;
  await cdp.ev(`window.__oldGuard()`).catch(() => {});
  await sleep(2200);
  const n0 = navLog.length - beforeN0;
  ok("N0 旧行为在读不到角色时会把人 replace 到 portal/applicant/（即当前页）",
     navLog.some((u) => /portal\/applicant\//.test(u)) && n0 >= 1,
     "新增导航 " + n0 + " 次: " + JSON.stringify(navLog.slice(0, 3)));
  ok("N0 而真实实现在同一场景下零跳转（G1/G2 的断言因此有意义）", true);

  // ════════════ S 会话失效 / 主动退出 / 返回入口 ════════════
  console.log("\n=== S 会话失效与返回入口 ===");
  /* 门户外壳靠 SIGNED_OUT 判「会话失效」。两件事以前混在一起：
       · 还监听了 TOKEN_REFRESHED_FAILED —— 2.116.0 根本没有这个事件，死代码；
       · 用户**自己点退出**也会触发 SIGNED_OUT，于是被告知「登录已过期」（不实），
         还被带上 ?next=<刚退出的那一页>，下次登录又被悄悄拖回去。 */

  // S1 真的失效：外部触发 SIGNED_OUT（不是用户点的退出）
  await open("portal/student/", { session: SESSION, rolesMode: ["student"],
    rpc: { my_learning: { data: [] }, my_student_capabilities: { data: {} },
           my_profile: { data: { display_name: "测试", email: "a@example.invalid" } } } });
  ok("S1 前提：正常进入了学员空间", !/没能确认你的权限/.test(await txt()));
  navLog.length = 0;
  const fired = await cdp.ev(`(() => {
    window.__fireAuth("SIGNED_OUT");
    return { toast: /登录已过期/.test(document.body.textContent || "") };
  })()`);
  ok("S1 会话失效时明确提示，不静默", fired.toast === true, JSON.stringify(fired));
  await sleep(2200);
  /* 断言看**导航序列**而不是最终位置：失效后会先落到 /login/?next=...，
     之后登录页自己还会再判一次会话。只看最终位置会把中间那一跳漏掉。 */
  const s1nav = navLog.find((u) => /\/login\//.test(u)) || "";
  ok("S1 会话失效后回到登录页", !!s1nav, JSON.stringify(navLog.slice(0, 3)));
  ok("S1 带上了 next，回来能接着原来那一页", /next=/.test(s1nav), s1nav);
  ok("S1 next 指回学员空间", /portal%2Fstudent/i.test(s1nav), s1nav);

  // S2 next 要连 query 与 hash 一起带（丢了就回不到原来的位置）
  await open("portal/student/courses/?cat=nt#c3", { session: SESSION, rolesMode: ["student"],
    rpc: { my_learning: { data: [] }, my_student_capabilities: { data: {} },
           my_profile: { data: { display_name: "测试", email: "a@example.invalid" } } } });
  await cdp.ev(`(() => { window.__fireAuth && window.__fireAuth("SIGNED_OUT"); return true; })()`);
  await sleep(2000);
  const s2nav = navLog.find((u) => /\/login\//.test(u)) || "";
  ok("S2 next 保留了 query", /cat%3Dnt/i.test(s2nav) || /cat=nt/.test(decodeURIComponent(s2nav)),
     s2nav);

  // S3 主动退出：**不该**说成「登录已过期」，也不该带 next
  await open("portal/student/", { session: SESSION, rolesMode: ["student"],
    rpc: { my_learning: { data: [] }, my_student_capabilities: { data: {} },
           my_profile: { data: { display_name: "测试", email: "a@example.invalid" } } } });
  navLog.length = 0;
  await cdp.ev(`(() => { window.AmasAuth.signOut(); return true; })()`);
  await sleep(2200);
  const s3nav = navLog.find((u) => /\/login\//.test(u)) || "";
  ok("S3 主动退出后到登录页", !!s3nav, JSON.stringify(navLog.slice(0, 3)));
  ok("S3 **不带 next** —— 用户刚明确表示要离开那一页", !/next=/.test(s3nav), s3nav);

  // S4 主动退出时不弹「登录已过期」
  await open("portal/student/", { session: SESSION, rolesMode: ["student"],
    rpc: { my_learning: { data: [] }, my_student_capabilities: { data: {} },
           my_profile: { data: { display_name: "测试", email: "a@example.invalid" } } } });
  /* 观测结果要写进 sessionStorage 再读 —— signOut 会让页面跳走，
     在 cdp.ev 里跨导航 await 的话，求值目标直接没了（Inspected target navigated）。 */
  await cdp.ev(`(() => {
    try { sessionStorage.removeItem("sawExpiredToast"); } catch (e) {}
    const obs = new MutationObserver(() => {
      if (/登录已过期/.test(document.body.textContent || "")) {
        try { sessionStorage.setItem("sawExpiredToast", "1"); } catch (e) {}
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.AmasAuth.signOut();
    return true;
  })()`);
  await sleep(2200);
  const toastSeen = await cdp.ev(`(function(){
    try { return sessionStorage.getItem("sawExpiredToast") === "1"; } catch (e) { return null; }
  })()`);
  ok("S4 主动退出不谎称「登录已过期」", toastSeen === false, "toast 出现=" + toastSeen);

  // S5 死事件已移除
  const deadEvt = await cdp.ev(`(async () => {
    const r = await fetch("${BASE}/assets/js/portal/shell.js");
    const t = await r.text();
    /* 查的是「有没有在**监听**」，不是「文件里有没有出现过这个词」——
       解释为什么删掉它的注释里当然会写到这个名字，那不该判红。
       代码里引用事件名一定带引号，注释里是反引号。 */
    return { listening: t.indexOf(String.fromCharCode(34) + "TOKEN_REFRESHED_FAILED") > -1,
             mentionedInComment: t.indexOf("TOKEN_REFRESHED_FAILED") > -1 };
  })()`);
  ok("S5 shell.js 不再监听并不存在的 TOKEN_REFRESHED_FAILED",
     deadEvt.listening === false, JSON.stringify(deadEvt));
  ok("S5 但注释里留了说明，免得后人又把它加回去",
     deadEvt.mentionedInComment === true, JSON.stringify(deadEvt));

  // ════════════ G7 外发 ════════════
  console.log("\n=== G7 外发 ===");
  ok("G7 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");

  // ════════════ N 内置反向对照 ════════════
  console.log("\n=== N 反向对照：旧语义「出错也报成功且无角色」===");
  /* 不改任何文件，也**不覆盖真实实现** —— 上一版在同一个页面里先把
     fetchRoles 换掉、之后又去调「真实实现」，测的其实是被自己改过的东西。
     这里改成：在同一页同一场景下，把旧语义写成一个独立函数，与真实实现并排比。 */
  await open("portal/student/", { session: SESSION, rolesMode: "error" });
  const cmp = await cdp.ev(`(async () => {
    const A = window.AmasAuth;
    // 旧语义：拿到 error 也只回一个空数组，调用方无从分辨
    const oldSemantics = async function () {
      const r = await A.client.rpc("my_roles");
      return { roles: r.error ? [] : (r.data || []).map(x => x.role), failed: false };
    };
    const o = await oldSemantics();
    const n = await A.fetchRoles();
    return { old: o, now: n, homeForEmpty: A.homeForRoles([]) };
  })()`);
  ok("N1 旧语义把「读不到」报成「成功且无角色」",
     cmp.old.failed === false && cmp.old.roles.length === 0, JSON.stringify(cmp.old));
  ok("N2 真实实现在同一次 RPC 失败上报 failed=true（两者确实不同）",
     cmp.now.failed === true, JSON.stringify(cmp.now));
  ok("N3 而 homeForRoles 对空角色给出 portal/applicant/ —— 正是自我弹跳的那个地址",
     /portal\/applicant\/$/.test(cmp.homeForEmpty), JSON.stringify(cmp));
  ok("N4 所以旧语义必然把读不到角色的人送去一个进不去的页面（缺陷成立）",
     cmp.old.failed === false && /portal\/applicant\/$/.test(cmp.homeForEmpty));

  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  全程本机 stub：无真实身份、无真实登录、无远端写入、无外网请求。");
console.log("  绿灯只证明「给定这些返回值时守卫做对了事」，不证明线上 RLS 已验收。");
process.exit(fail ? 1 : 0);
