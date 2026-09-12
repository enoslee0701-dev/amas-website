// 门户「无外壳三页」的会话失效监听：修复验证。
//
// ── 修的是什么 ────────────────────────────────────────────────────────
// 会话失效的提示与回跳，一直只长在 assets/js/portal/shell.js 的 Shell.mount 里。
// 而门户下有三页**不走 Shell.mount**：
//     portal/index.html          选择工作空间
//     portal/mfa/index.html      两步验证
//     portal/admin/index.html    管理总览（交接文档只列了前两页，这一页是本轮新查出来的）
// 这三页没有任何 onAuthStateChange 订阅，于是会话失效在它们身上是**完全静默**的：
// 令牌刷新失败 → SDK 经 _removeSession 发出 SIGNED_OUT → 没有人听 →
// 页面继续显示身份、继续显示入口、点下去才一路 401，用户不知道自己已经被登出。
//
// 更要命的是**晚返回的 async**：这三页都是 `await` 之后才渲染或跳转。
// 会话在 await 期间断掉，返回的那一刻代码照样把人送进受保护区域
// （portal/index.html 单空间账号直接 location.replace 进去；
//   portal/mfa 验证通过后 goBack 进去）—— 等于用一个已经死掉的会话做导航决策。
//
// ── 本套件要证明的 ────────────────────────────────────────────────────
//   1. 三页在会话失效时都**明确提示**，不静默
//   2. 都回到登录页，且 next 连 query 与 hash 一起带上（回来才是原来那一处）
//   3. 主动退出与过期**分开**：退出不带 next、不谎称「登录已过期」
//   4. await 期间会话断掉时，晚返回的渲染与导航**让位**，不拿死会话往里走
//   5. 只订阅一次（watchSession 调多少次都一样）
//   6. MFA 与角色要求**没有被降低**：aal1 无因子仍停在注册卡，aal2 才回跳
//
// ── 用的是什么、不是什么 ──────────────────────────────────────────────
// stub 只替换 window.supabase.createClient 返回的假客户端；
// assets/js/portal/auth.js 与三页自己的页面脚本都真跑。
// 无真实身份、无真实登录、无远端写入、无外网（supabase 域名钉到 0.0.0.0）。
// 绿灯只证明「给定这些返回值时客户端做对了事」，**不证明**线上 Auth/RLS 已验收。
//
// 端口独占 9416 —— 固定端口的 CDP 套件必须串行跑，并行会互相抢调试端口，
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-session-"));
const port = 9416;
const CHROME = process.env.CHROME_PATH || process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
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

/** 假客户端。场景由 window.__SCEN 决定：
      roles       my_roles 返回的角色数组
      aal         getAuthenticatorAssuranceLevel 的 currentLevel
      factors     listFactors 返回的 totp 数组（空 = 还没注册）
      slow        { 键: 毫秒 } 给指定调用加延迟，用来构造「await 期间会话断掉」
      killAfter   毫秒；到点由 stub 自己发一次 SIGNED_OUT

    两处是刻意跟真实 SDK 对齐、而先前 stub 没做的：
      ① signOut() **会**发 SIGNED_OUT。真实 SDK 经 _removeSession 就是这么发的，
         「主动退出」和「过期」撞在同一个事件上正是要区分的原因。stub 不发的话，
         「主动退出不谎称过期」这类断言会空转通过 —— 根本没有事件走到监听器。
      ② __fireAuth 在 createClient 时就定义好，**不依赖有没有人订阅**。
         事件照常发出，没有监听者的页面就是静默 —— 那正是本轮要量的缺陷。
      ③ unsubscribe() 真的把回调摘掉，N 段的反向对照才做得出来。 */
const STUB = `
window.supabase = {
  createClient: function(){
    var reply = function(v){ return Promise.resolve(v); };
    var S = function(){ return window.__SCEN || {}; };
    var delay = function(key, v){
      var ms = (S().slow || {})[key] || 0;
      if (!ms) return reply(v);
      return new Promise(function(r){ setTimeout(function(){ r(v); }, ms); });
    };
    var isDead = function(){ try { return sessionStorage.getItem("sessionDead") === "1"; } catch (e) { return false; } };

    window.__authSubs = window.__authSubs || [];
    window.__authFired = window.__authFired || 0;
    window.__fireAuth = function(ev, sess){
      if (ev === "SIGNED_OUT") { try { sessionStorage.setItem("sessionDead", "1"); } catch (e) {} }
      window.__authFired++;
      (window.__authSubs || []).slice().forEach(function(f){ try { f(ev, sess || null); } catch (e) {} });
    };
    if (S().killAfter) setTimeout(function(){ window.__fireAuth("SIGNED_OUT"); }, S().killAfter);

    return {
      auth: {
        getSession: function(){
          return reply({ data: { session: isDead() ? null : (S().session || null) } });
        },
        onAuthStateChange: function(cb){
          window.__authSubs.push(cb);
          return { data: { subscription: { unsubscribe: function(){
            var i = window.__authSubs.indexOf(cb);
            if (i > -1) window.__authSubs.splice(i, 1);
          } } } };
        },
        signOut: function(){
          window.__signedOut = true;
          try { sessionStorage.setItem("sessionDead", "1"); } catch (e) {}
          window.__fireAuth("SIGNED_OUT");
          return reply({});
        },
        mfa: {
          getAuthenticatorAssuranceLevel: function(){
            var a = S().aal || "aal1";
            return delay("aal", { data: { currentLevel: a, nextLevel: S().aalNext || a }, error: null });
          },
          listFactors: function(){
            return delay("listFactors", { data: { totp: S().factors || [] }, error: null });
          },
          enroll: function(){
            return delay("enroll", { data: { id: "f-new", totp: {
              qr_code: "<svg xmlns='http://www.w3.org/2000/svg' width='190' height='190'></svg>",
              secret: "STUBSECRETNOTREAL" } }, error: null });
          },
          challenge: function(){ return delay("challenge", { data: { id: "ch-1" }, error: null }); },
          verify: function(){ return delay("verify", { data: {}, error: S().verifyError || null }); }
        }
      },
      from: function(){ var q = { select:function(){return q;}, eq:function(){return q;},
        in:function(){return q;}, order:function(){return q;}, limit:function(){return q;},
        maybeSingle:function(){return q;},
        then:function(r){ return Promise.resolve({ data: [], error: null }).then(r); } }; return q; },
      rpc: function(name){
        var sc = S();
        if (name === "my_roles") return delay("my_roles",
          { data: (sc.roles || []).map(function(r){ return { role: r }; }), error: null });
        if (name === "my_profile") return delay("my_profile",
          { data: { display_name: "测试用户", email: "a@example.invalid" }, error: null });
        var r = (sc.rpc && sc.rpc[name]) || { data: null, error: null };
        return delay(name, { data: r.data, error: r.error || null });
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

  /* 导航序列是核心量具：「晚返回的导航把人送进受保护区」这件事，
     只看最终位置是看不见的 —— 进去之后那一页自己也会把人踢到登录页，
     最终位置两种实现下一模一样。要看的是**中间那一跳有没有发生**。 */
  const navLog = [];
  cdp.on("Page.frameNavigated", (p) => {
    if (p.frame && !p.frame.parentId) navLog.push(String(p.frame.url || ""));
  });

  const SESSION = { user: { id: "u-1", email: "a@example.invalid" }, access_token: "stub" };
  const open = async (page, scen, wait) => {
    /* ★ 注入脚本里绝不能做清理动作：addScriptToEvaluateOnNewDocument 是**累积**的，
       每个用例注册的脚本在之后每一次载入都会再跑一遍，而且早注册的先跑。
       要清理就在用例之间用一次性的 ev 调用做。 */
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__SCEN = " + JSON.stringify(scen) + "; window.__signedOut = false;",
    });
    await cdp.ev(`(()=>{try{sessionStorage.removeItem("sessionDead");sessionStorage.removeItem("sawExpired");}catch(e){} return true;})()`).catch(() => {});
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
  const loginNav = () => navLog.find((u) => /\/login\//.test(u)) || "";
  /** 触发一次真实的失效事件，并立刻回报页面有没有说话（提示是同步渲染的） */
  const expire = async () => cdp.ev(`(() => {
    window.__fireAuth("SIGNED_OUT");
    return { fired: window.__authFired, subs: (window.__authSubs||[]).length,
             said: /登录已过期/.test(document.body.textContent || "") };
  })()`);

  // ════════════ P portal/index.html · 选择工作空间 ════════════
  console.log("\n=== P 选择工作空间（portal/index.html）===");
  const MULTI = { session: SESSION, roles: ["student", "teacher"] };

  await open("portal/?from=mail#top", MULTI);
  const p0 = await txt();
  ok("P0 前提：多身份账号正常渲染出选择页", /选择工作空间/.test(p0) && /学员中心/.test(p0), p0.slice(0, 140));
  ok("P0 前提：这一页确实挂上了会话监听",
     (await cdp.ev(`(window.__authSubs||[]).length`)) === 1,
     "订阅数=" + (await cdp.ev(`(window.__authSubs||[]).length`)));

  navLog.length = 0;
  const p1 = await expire();
  ok("P1 会话失效时明确提示，不静默", p1.said === true, JSON.stringify(p1));
  await sleep(2200);
  const p1nav = loginNav();
  ok("P2 会话失效后回到登录页", !!p1nav, JSON.stringify(navLog.slice(0, 3)));
  ok("P3 带上了 next", /next=/.test(p1nav), p1nav);
  ok("P4 next 保留了 query 与 hash（回来才是原来那一处）",
     /from%3Dmail/i.test(p1nav) && /%23top/i.test(p1nav), p1nav);

  // P5 主动退出：与过期分开
  await open("portal/", MULTI);
  navLog.length = 0;
  await cdp.ev(`(() => {
    try { sessionStorage.removeItem("sawExpired"); } catch (e) {}
    const obs = new MutationObserver(() => {
      if (/登录已过期/.test(document.body.textContent || "")) {
        try { sessionStorage.setItem("sawExpired", "1"); } catch (e) {}
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    return true;
  })()`);
  await cdp.clickReal("#btnOut");
  await sleep(2000);
  const p5nav = loginNav();
  const p5toast = await cdp.ev(`(function(){ try { return sessionStorage.getItem("sawExpired") === "1"; } catch (e) { return null; } })()`);
  ok("P5 主动退出到登录页", !!p5nav, JSON.stringify(navLog.slice(0, 3)));
  ok("P5 主动退出**不带 next** —— 用户刚明确表示要离开那一页", !/next=/.test(p5nav), p5nav);
  ok("P5 主动退出不谎称「登录已过期」", p5toast === false, "toast 出现=" + p5toast);

  // P6 加载中失效 · 单空间账号：晚返回的导航不许拿死会话往里走
  await open("portal/", { session: SESSION, roles: ["student"], slow: { my_profile: 1100 }, killAfter: 350 }, 3400);
  ok("P6 会话在 my_profile 返回前断掉时，**不再**把人 replace 进学员空间",
     !navLog.some((u) => /portal\/student\//.test(u)),
     "导航序列: " + JSON.stringify(navLog.slice(0, 4)));
  ok("P6 而是回到登录页", !!loginNav(), JSON.stringify(navLog.slice(0, 4)));

  // P6b 加载中失效 · 多空间账号：晚返回的渲染也不许把死会话演成还在
  await open("portal/", { session: SESSION, roles: ["student", "teacher"], slow: { my_profile: 1100 }, killAfter: 350 }, 1400);
  const p6b = await cdp.ev(`(()=>{ const b=document.getElementById("spaces");
    return { cards: b ? b.children.length : -1, who: (document.getElementById("who")||{}).textContent || "" }; })()`);
  ok("P6b 会话已断，晚返回的渲染让位：不再画出可点的空间入口",
     p6b.cards === 0, JSON.stringify(p6b));
  ok("P6b 也不再把已经失效的身份写进页眉", p6b.who === "", JSON.stringify(p6b));

  // P7 只订阅一次
  await open("portal/", MULTI);
  const p7 = await cdp.ev(`(() => {
    const A = window.AmasAuth;
    const before = (window.__authSubs || []).length;
    const h1 = typeof A.watchSession === "function" ? A.watchSession() : null;
    const h2 = typeof A.watchSession === "function" ? A.watchSession() : null;
    return { before, after: (window.__authSubs || []).length, same: !!h1 && h1 === h2 };
  })()`);
  ok("P7 页面自己已订阅一次", p7.before === 1, JSON.stringify(p7));
  ok("P7 再调 watchSession 不会重复订阅", p7.after === 1, JSON.stringify(p7));
  ok("P7 重复调用拿到的是同一个订阅句柄", p7.same === true, JSON.stringify(p7));

  // ════════════ M portal/mfa/ · 两步验证 ════════════
  console.log("\n=== M 两步验证（portal/mfa/）===");

  await open("portal/mfa/?next=%2Fhelp%2F", { session: SESSION, roles: ["teacher"], aal: "aal1", factors: [] });
  const m0 = await txt();
  ok("M0 前提：aal1 且未注册因子 → 停在启用两步验证（要求没被降低）",
     /启用两步验证/.test(m0) && !navLog.some((u) => /\/help\//.test(u)), m0.slice(0, 140));
  ok("M0 前提：这一页确实挂上了会话监听",
     (await cdp.ev(`(window.__authSubs||[]).length`)) === 1,
     "订阅数=" + (await cdp.ev(`(window.__authSubs||[]).length`)));

  await open("portal/mfa/?next=%2Fhelp%2F&src=nav#sec", { session: SESSION, roles: ["teacher"], aal: "aal1", factors: [] });
  navLog.length = 0;
  const m1 = await expire();
  ok("M1 会话失效时明确提示，不静默", m1.said === true, JSON.stringify(m1));
  await sleep(2200);
  const m1nav = loginNav();
  ok("M2 会话失效后回到登录页", !!m1nav, JSON.stringify(navLog.slice(0, 3)));
  ok("M3 next 保留了 query 与 hash",
     /src%3Dnav/i.test(m1nav) && /%23sec/i.test(m1nav), m1nav);

  // M4 既有最短路径：已有 aal2 直接回跳（回归，不能被本次改动挡住）
  await open("portal/mfa/?next=%2Fhelp%2F", { session: SESSION, roles: ["teacher"], aal: "aal2", factors: [{ id: "f-1" }] });
  ok("M4 已有 aal2 时照常回跳到 next", navLog.some((u) => /\/help\//.test(u)),
     JSON.stringify(navLog.slice(0, 4)));

  // M5 加载中失效 · aal2 回跳这条路：会话在 getAal 返回前断掉
  await open("portal/mfa/?next=%2Fhelp%2F", { session: SESSION, roles: ["teacher"], aal: "aal2",
    factors: [{ id: "f-1" }], slow: { aal: 1100 }, killAfter: 350 }, 3400);
  ok("M5 会话在 getAal 返回前断掉时，**不再**回跳进受保护区",
     !navLog.some((u) => /\/help\//.test(u)), "导航序列: " + JSON.stringify(navLog.slice(0, 4)));
  ok("M5 而是回到登录页", !!loginNav(), JSON.stringify(navLog.slice(0, 4)));

  // M6 验证通过、但会话在 verify 期间断掉：回跳同样要让位
  await open("portal/mfa/?next=%2Fhelp%2F", { session: SESSION, roles: ["teacher"], aal: "aal1",
    factors: [{ id: "f-1" }], slow: { verify: 1200 } });
  const m6ready = await txt();
  ok("M6 前提：已注册因子 → 停在挑战卡", /请完成两步验证/.test(m6ready), m6ready.slice(0, 120));
  navLog.length = 0;
  await cdp.ev(`(()=>{ document.getElementById("chCode").value = "123456"; return true; })()`);
  await cdp.clickReal("#btnCh");
  await cdp.ev(`(()=>{ window.__fireAuth("SIGNED_OUT"); return true; })()`);
  await sleep(3000);
  ok("M6 verify 期间会话断掉 → 晚返回的 goBack 让位，不进受保护区",
     !navLog.some((u) => /\/help\//.test(u)), "导航序列: " + JSON.stringify(navLog.slice(0, 4)));
  ok("M6 而是回到登录页", !!loginNav(), JSON.stringify(navLog.slice(0, 4)));

  // M7 主动退出
  await open("portal/mfa/?next=%2Fhelp%2F", { session: SESSION, roles: ["teacher"], aal: "aal1", factors: [] });
  navLog.length = 0;
  await cdp.ev(`(() => {
    try { sessionStorage.removeItem("sawExpired"); } catch (e) {}
    const obs = new MutationObserver(() => {
      if (/登录已过期/.test(document.body.textContent || "")) {
        try { sessionStorage.setItem("sawExpired", "1"); } catch (e) {}
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    return true;
  })()`);
  await cdp.clickReal("#btnOut");
  await sleep(2000);
  const m7nav = loginNav();
  const m7toast = await cdp.ev(`(function(){ try { return sessionStorage.getItem("sawExpired") === "1"; } catch (e) { return null; } })()`);
  ok("M7 主动退出到登录页且不带 next", !!m7nav && !/next=/.test(m7nav), m7nav);
  ok("M7 主动退出不谎称「登录已过期」", m7toast === false, "toast 出现=" + m7toast);

  // ════════════ A portal/admin/index.html · 本轮新查出来的第三页 ════════════
  console.log("\n=== A 管理总览（portal/admin/index.html）===");
  const ADMIN = { session: SESSION, roles: ["super_admin"], aal: "aal2" };

  await open("portal/admin/?tab=queue#q", ADMIN);
  const a0 = await txt();
  ok("A0 前提：super_admin + aal2 正常进入管理总览", /教师邀请/.test(a0) || /审核/.test(a0), a0.slice(0, 140));
  ok("A0 前提：这一页确实挂上了会话监听",
     (await cdp.ev(`(window.__authSubs||[]).length`)) === 1,
     "订阅数=" + (await cdp.ev(`(window.__authSubs||[]).length`)));
  navLog.length = 0;
  const a1 = await expire();
  ok("A1 会话失效时明确提示，不静默", a1.said === true, JSON.stringify(a1));
  await sleep(2200);
  const a1nav = loginNav();
  ok("A2 会话失效后回到登录页", !!a1nav, JSON.stringify(navLog.slice(0, 3)));
  ok("A3 next 保留了 query 与 hash", /tab%3Dqueue/i.test(a1nav) && /%23q/i.test(a1nav), a1nav);

  // ════════════ N 反向对照 ════════════
  console.log("\n=== N 反向对照 ===");
  /* 没有这一节，「会话失效时页面会说话」这类断言就无从证明自己有意义 ——
     可能只是 stub 的事件根本没发出去。 */
  await open("portal/", MULTI);
  const n1 = await cdp.ev(`(() => {
    const A = window.AmasAuth;
    const h = typeof A.watchSession === "function" ? A.watchSession() : null;
    if (h && h.unsubscribe) h.unsubscribe();          // 退回到「这一页没有监听」的旧状态
    const subsAfter = (window.__authSubs || []).length;
    window.__fireAuth("SIGNED_OUT");
    return { subsAfter, said: /登录已过期/.test(document.body.textContent || "") };
  })()`);
  const n1navBefore = navLog.length;
  await sleep(2000);
  ok("N1 摘掉监听后，同一次失效事件**确实**是静默的（旧行为复现）",
     n1.subsAfter === 0 && n1.said === false, JSON.stringify(n1));
  ok("N1 而且没有任何回跳发生 —— 人就留在一个已经登出的门户页上",
     !navLog.slice(n1navBefore).some((u) => /\/login\//.test(u)),
     JSON.stringify(navLog.slice(n1navBefore, n1navBefore + 3)));

  const n2 = await cdp.ev(`(async () => {
    const out = {};
    for (const p of ["portal/index.html", "portal/mfa/index.html", "portal/admin/index.html"]) {
      const t = await (await fetch("${BASE}/" + p)).text();
      out[p] = { shell: t.indexOf("portal/shell.js") > -1, watch: t.indexOf("watchSession") > -1 };
    }
    return out;
  })()`);
  ok("N2 这三页确实都不加载 shell.js —— 外壳里的监听它们一行都拿不到",
     Object.values(n2).every((v) => v.shell === false), JSON.stringify(n2));
  ok("N2 所以它们必须各自挂监听（这是本轮的改法）",
     Object.values(n2).every((v) => v.watch === true), JSON.stringify(n2));

  const n3 = await cdp.ev(`(async () => {
    const t = await (await fetch("${BASE}/assets/js/portal/shell.js")).text();
    return { delegates: t.indexOf("watchSession") > -1,
             ownListener: t.indexOf("onAuthStateChange") > -1 };
  })()`);
  ok("N3 外壳改为复用同一份监听，不再各写一遍",
     n3.delegates === true && n3.ownListener === false, JSON.stringify(n3));

  // ════════════ X 外发 ════════════
  console.log("\n=== X 外发 ===");
  ok("X1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");

  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  全程本机 stub：无真实身份、无真实登录、无远端写入、无外网请求。");
console.log("  绿灯只证明「给定这些返回值时客户端做对了事」，不证明线上 Auth/RLS/MFA 已验收。");
process.exit(fail ? 1 : 0);
