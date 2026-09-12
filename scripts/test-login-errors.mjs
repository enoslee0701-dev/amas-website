// 登录页错误分类的本地验证。
//
// ── 修的是什么 ────────────────────────────────────────────────────────
// `signIn` 的邮箱分支原本是 `if (error) return { error: "bad_credentials" }`：
// 断网、网关 5xx、响应解析不出来 —— 全被说成「账号或密码不正确」。
// 那是在用户什么都没做错的时候指责用户，还会让人去改一个本来没错的密码。
// 页面的 `showErr` 兜底也是 bad_credentials，等于一遇到没见过的状况就先怪密码。
//
// ── 与注册的区别 ──────────────────────────────────────────────────────
// 登录失败**没有副作用**：没建账号、没发信、没写任何东西。
// 所以「结果不明」不必像注册那样锁住按钮 —— 直接重试是安全的。
// 要紧的只有文案说实话：不能把「连不上」说成「密码不对」。
// 而明确被拒时一律统一文案，**不区分账号是否存在**（规范 §5.3）。
//
// ── 本套件用的是什么、不是什么 ────────────────────────────────────────
// stub 只替换 `window.supabase.createClient` 返回的假客户端，
// 学号分支的 Edge Function 由 CDP 直接 fulfill。
// `assets/js/portal/auth.js` 的 signIn 与页面脚本都是真跑的。
// 没有真实登录、没有真实身份、没有发信、没有一个请求离开本机
// （supabase 域名在浏览器层被钉到 0.0.0.0）。
//
// 端口独占 9414：这类固定端口的套件必须**串行**跑，
// 并行会互相抢 CDP 调试端口，跑出一堆看似回归其实是串台的数字。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-login-"));
const port = 9414;
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

/** 本机假客户端。错误对象照 supabase-js 2.116.0 的错误类形状构造。 */
const STUB = `
window.supabase = {
  createClient: function(){
    var reply = function(v){ return Promise.resolve(v); };
    var S = function(){ return window.__SCEN || {}; };
    var mkErr = function(spec){
      var e = new Error(spec.message || "boom");
      e.name = spec.name || "AuthApiError";
      if (spec.authError !== false) e.__isAuthError = true;
      if (spec.status !== undefined) e.status = spec.status;
      if (spec.code !== undefined) e.code = spec.code;
      return e;
    };
    return {
      auth: {
        getSession: function(){ return reply({ data: { session: S().session || null } }); },
        onAuthStateChange: function(){ return { data: { subscription: { unsubscribe: function(){} } } }; },
        signOut: function(){ return reply({}); },
        setSession: function(){ return reply({ error: null }); },
        signInWithPassword: function(args){
          window.__calls = window.__calls || [];
          window.__calls.push({ kind: "signIn", email: args && args.email });
          var sc = S().login || {};
          if (sc.mode === "throw") {
            return Promise.reject(sc.err ? mkErr(sc.err) : new TypeError("Failed to fetch"));
          }
          if (sc.mode === "error") {
            return reply({ data: { user: null, session: null }, error: mkErr(sc.err || {}) });
          }
          return reply({ data: { user: { id: "u-1" },
            session: { access_token: "stub", user: { id: "u-1" } } }, error: null });
        }
      },
      from: function(){ var q = { select:function(){return q;}, eq:function(){return q;},
        then:function(r){ return Promise.resolve({ data: [], error: null }).then(r); } }; return q; },
      rpc: function(name){
        window.__calls = window.__calls || [];
        window.__calls.push({ kind: "rpc", name: name });
        var r = (S().rpc && S().rpc[name]) || { data: null, error: null };
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

  // 学号登录走的是 Edge Function，不经过 SDK —— 由 CDP 按场景直接回它的状态码
  let aliasPlan = null;
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("login-by-identifier") > -1) {
        /* 这是跨域 POST（带 Content-Type/apikey/Authorization），浏览器会先发 CORS 预检。
           预检必须单独回 204 + 完整 CORS 头 —— 早先把预检也当正式请求回了 404/429，
           预检失败后 fetch 直接抛错，于是每个用例都变成「网络连不上」。
           那是量具没答对预检，不是页面把状态码判错了。 */
        if (ev.request.method === "OPTIONS") {
          await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 204,
            responseHeaders: [{ name: "Access-Control-Allow-Origin", value: "*" },
                              { name: "Access-Control-Allow-Methods", value: "POST, OPTIONS" },
                              { name: "Access-Control-Allow-Headers",
                                value: "content-type, apikey, authorization" },
                              { name: "Access-Control-Max-Age", value: "0" }], body: "" });
          return;
        }
        if (aliasPlan && aliasPlan.fail) {
          await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "ConnectionFailed" });
          return;
        }
        const plan = aliasPlan || { status: 200, body: '{"access_token":"a","refresh_token":"r"}' };
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: plan.status,
          responseHeaders: [{ name: "Content-Type", value: plan.ct || "application/json" },
                            { name: "Access-Control-Allow-Origin", value: "*" },
                            { name: "Cache-Control", value: "no-store" }],
          body: b64(plan.body === undefined ? '{"error":"x"}' : plan.body) });
        return;
      }
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

  /* 登录成功会跳到角色首页，而那一页自己的守卫在 stub 没有 session 时会把人弹回
     /login/。所以「900ms 后停在哪」问的是错的问题 —— 要看的是**跳去过哪**。 */
  const navLog = [];
  cdp.on("Page.frameNavigated", (p2) => {
    if (p2.frame && !p2.frame.parentId) navLog.push(String(p2.frame.url || ""));
  });
  const openLogin = async (scen) => {
    navLog.length = 0;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__SCEN = " + JSON.stringify(scen) + "; window.__calls = [];",
    });
    await cdp.send("Page.navigate", { url: `${BASE}/login/` });
    await sleep(1700);
  };
  const errText = async () => cdp.ev(`(()=>{const e=document.getElementById("err");
    return { shown: e.classList.contains("show"), text: e.textContent || "" };})()`);
  const btnState = async () => cdp.ev(`(()=>{const b=document.getElementById("btnLogin");
    return { disabled: b.disabled, label: b.textContent };})()`);
  const here = async () => cdp.ev(`location.pathname`);

  const login = async (id, pw) => {
    await cdp.ev(`(()=>{
      const set=(i,v)=>{const el=document.getElementById(i); el.value=v;
        el.dispatchEvent(new Event("input",{bubbles:true}));};
      set("fId", ${JSON.stringify(id)}); set("fPw", ${JSON.stringify(pw || "pw12345678")});
      return true;})()`);
    await cdp.clickReal("#btnLogin");
    await sleep(700);
  };

  // ════════════ L0 前提 ════════════
  console.log("\n=== L0 前提 ===");
  await openLogin({ login: { mode: "error", err: { name: "AuthApiError", status: 400,
                                                   message: "Invalid login credentials" } } });
  const st0 = await cdp.ev(`({ state: (window.AmasAuth && window.AmasAuth.CONFIG_STATE) || "(未加载)" })`);
  ok("L0 页面配置就绪", st0.state === "ready", JSON.stringify(st0));
  ok("L0 登录按钮可用", (await btnState()).disabled === false);

  // ════════════ L1 明确凭据错误 ════════════
  console.log("\n=== L1 服务器明确拒绝凭据（4xx）===");
  await login("a@example.invalid");
  const e1 = await errText();
  ok("L1 显示「账号或密码不正确」", /账号或密码不正确/.test(e1.text), JSON.stringify(e1));
  ok("L1 不停在页面之外（没有跳转）", /\/login\//.test(await here()), await here());
  ok("L1 按钮恢复可点", (await btnState()).disabled === false);
  ok("L1 按钮文案复位", !/登录中/.test((await btnState()).label), (await btnState()).label);

  // ════════════ L2 不泄露账号是否存在 ════════════
  console.log("\n=== L2 不泄露用户存在性 ===");
  /* GoTrue 对「密码错」「账号不存在」「邮箱未验证」会给出不同的 code。
     页面**必须**对这几种给出完全一样的一句话，否则就成了账号枚举的探针。 */
  const sameCopy = [];
  for (const err of [
    { name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
    { name: "AuthApiError", status: 400, code: "email_not_confirmed", message: "Email not confirmed" },
    { name: "AuthApiError", status: 400, code: "user_not_found", message: "User not found" },
  ]) {
    await openLogin({ login: { mode: "error", err } });
    await login("probe@example.invalid");
    sameCopy.push((await errText()).text);
  }
  ok("L2 三种 4xx（密码错 / 邮箱未验证 / 账号不存在）文案完全一致",
     sameCopy[0] === sameCopy[1] && sameCopy[1] === sameCopy[2], JSON.stringify(sameCopy));
  ok("L2 文案里不出现「不存在」「未注册」这类存在性线索",
     !/不存在|未注册|没有该账号/.test(sameCopy.join(" ")), sameCopy[0]);
  ok("L2 文案里不出现「未验证」这类账号状态线索",
     !/未验证|未确认/.test(sameCopy.join(" ")), sameCopy[0]);

  // ════════════ L3 限流 ════════════
  console.log("\n=== L3 限流 429 ===");
  await openLogin({ login: { mode: "error", err: { name: "AuthApiError", status: 429,
                                                   message: "Request rate limit reached" } } });
  await login("a@example.invalid");
  const e3 = await errText();
  ok("L3 如实说尝试次数过多（429 不涉及账号是否存在）", /尝试次数过多/.test(e3.text), e3.text);
  ok("L3 不谎称密码不对", !/账号或密码不正确/.test(e3.text), e3.text);

  // ════════════ L4-L7 不是凭据问题的失败 ════════════
  console.log("\n=== L4-L7 连不上 / 服务器出错 / 结果不明 ===");
  /* 这一组是本轮要修的。以前它们全显示「账号或密码不正确」——
     用户会去改一个本来没错的密码，甚至以为账号被盗。 */
  const notCredential = async (scen, expect, label) => {
    await openLogin({ login: scen });
    await login("a@example.invalid");
    const e = await errText();
    const b = await btnState();
    ok(label + "：文案正确", expect.test(e.text), e.text);
    ok(label + "：**不谎称账号或密码不正确**", !/账号或密码不正确/.test(e.text), e.text);
    ok(label + "：明写这不是账号或密码的问题", /这不是账号或密码的问题/.test(e.text), e.text);
    ok(label + "：按钮恢复可点（登录失败无副作用，可以直接重试）",
       b.disabled === false && !/登录中/.test(b.label), JSON.stringify(b));
    ok(label + "：没有误跳进门户", /\/login\//.test(await here()), await here());
  };
  await notCredential({ mode: "error", err: { name: "AuthRetryableFetchError", status: 0,
                                              message: "Failed to fetch" } },
                      /网络连不上/, "L4 网络中断（status 0）");
  await notCredential({ mode: "error", err: { name: "AuthRetryableFetchError", status: 503,
                                              message: "Service Unavailable" } },
                      /服务器暂时出错/, "L5 服务端 503");
  await notCredential({ mode: "error", err: { name: "AuthApiError", status: 408,
                                              message: "Request Timeout" } },
                      /服务器暂时出错/, "L6 408 超时（是 4xx 但语义是超时）");
  await notCredential({ mode: "error", err: { name: "AuthUnknownError",
                                              message: "<html>502</html>" } },
                      /没能确认登录结果/, "L7 响应无法解析");
  await notCredential({ mode: "throw" },
                      /网络连不上/, "L7b SDK 抛出非 AuthError");

  // L7c 兜底不再指责密码：给一个页面没见过的 code
  await openLogin({ login: { mode: "error", err: { name: "AuthApiError", status: 0,
                                                   message: "weird" } } });
  await login("a@example.invalid");
  const e7c = await errText();
  ok("L7c 认不出来的状况兜底到「没能确认」，而不是先怪密码",
     /没能确认登录结果/.test(e7c.text) && !/账号或密码不正确/.test(e7c.text), e7c.text);

  // ════════════ L8 成功路径与守卫 ════════════
  console.log("\n=== L8 登录成功后的角色守卫 ===");
  const afterLogin = async (roles) => {
    await openLogin({ login: { mode: "ok" }, rpc: { my_roles: { data: roles } } });
    await login("a@example.invalid");
    await sleep(1100);
    // 去掉登录页自己，留下它把人送去的地方
    return navLog.filter((u) => !/\/login\/?(\?|$)/.test(u));
  };
  const n8a = await afterLogin([{ role: "student" }]);
  ok("L8a 单一角色直达学员中心", n8a.some((u) => /portal\/student\//.test(u)), JSON.stringify(n8a));
  const n8b = await afterLogin([{ role: "student" }, { role: "teacher" }]);
  ok("L8b 跨空间多角色进门户选择页，不替用户选",
     n8b.some((u) => /\/portal\/(index\.html)?$/.test(u.split("?")[0])), JSON.stringify(n8b));
  const n8c = await afterLogin([]);
  ok("L8c 没有任何角色时落到申请者中心，不停在登录页假装成功",
     n8c.some((u) => /portal\/applicant\//.test(u)), JSON.stringify(n8c));
  ok("L8d 登录失败时不会发生任何跳转",
     (await (async () => { await openLogin({ login: { mode: "error",
         err: { name: "AuthApiError", status: 400, message: "Invalid login credentials" } } });
       await login("a@example.invalid"); await sleep(700);
       return navLog.filter((u) => !/\/login\/?(\?|$)/.test(u)); })()).length === 0);

  // ════════════ L9 学号分支（Edge Function）════════════
  console.log("\n=== L9 学号登录分支 ===");
  const aliasCase = async (plan, expect, label) => {
    aliasPlan = plan;
    await openLogin({ login: { mode: "ok" } });
    await login("S-2026-001");
    const e = await errText();
    ok(label, expect.test(e.text), e.text);
  };
  await aliasCase({ status: 404, body: '{"error":"nf"}' }, /学号登录暂未开通/, "L9a 404 → 暂未开通");
  await aliasCase({ status: 429, body: '{"error":"rl"}' }, /尝试次数过多/, "L9b 429 → 限流");
  await aliasCase({ status: 401, body: '{"error":"bad"}' }, /账号或密码不正确/, "L9c 401 → 凭据错误");
  await aliasCase({ status: 503, body: '{"error":"down"}' }, /服务器暂时出错/,
                  "L9d **503 不再说成密码不对**");
  await aliasCase({ status: 200, body: "<html>gateway</html>", ct: "text/html" },
                  /没能确认登录结果/, "L9e 网关返回 HTML → 结果不明，不是凭据错");
  await aliasCase({ fail: true }, /网络连不上/, "L9f 连接失败 → 网络");
  aliasPlan = null;

  // ════════════ L10 外发 ════════════
  console.log("\n=== L10 外发 ===");
  ok("L10 全程没有一个请求到达真实 supabase 域名（没有真实登录）",
     externalHits === 0, "命中 " + externalHits + " 次");

  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  全程本机 stub：没有真实登录、没有真实身份、没有发信、没有远端写入。");
console.log("  绿灯只证明「给定这些返回值时页面说对了话」，不证明线上 Auth 已验收。");
process.exit(fail ? 1 : 0);
