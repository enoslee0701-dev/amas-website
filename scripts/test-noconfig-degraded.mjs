// 无配置启动：21 个带 auth.js 的页面，在「没有后端配置」时都给出友好的降级提示。
//
// ── 与已有测试的分工 ──────────────────────────────────────────────────
//   test-portal-degraded.mjs  把 supabase-config.js 整个**替换**成合成内容，量 11 个门户页的两种降级态。
//                             没走真实配置文件，也没量登录类页面在「缺配置」下说什么。
//   test-local-config-override.mjs  量旁路文件的加载规则（回环才加载），只看一个页面的状态值。
// 这一套补的是：
//   · **真实启动路径**：页面、supabase-config.js（含本地旁路那段）全部用仓库里的真文件；
//   · **全部 21 个页面**：15 个门户页 + auth/callback、portal/mfa（整页降级），
//     login / register / forgot-password / faculty/verify（页内提示 + 提交键禁用），auth/recovery（失败卡片）；
//   · **两种「没配置」**：
//       absent       没有旁路文件（出厂态）
//       placeholder  旁路文件就是仓库里的 supabase-config.local.example.js 原样照抄 —— 占位符没改
//                    （这是真会发生的：cp 完忘了填）。必须仍判 missing，不能当成已配置去连一个不存在的地址。
//
// ── 稳定复现（本条验收的核心）─────────────────────────────────────────
//   本机上可能真有一份 assets/js/supabase-config.local.js（已 gitignore，可能是真配置）。
//   页面跑在 127.0.0.1，旁路会去读它 —— 那样结果就取决于这台机器有没有那个文件，
//   而且可能真的去连后端。所以测试服务器**接管**这个路径：absent 回 404，placeholder 回示例文件；
//   本机那份文件从头到尾不被读取、不被发送。
//   supabase-js 由桩代替（HAS_SDK 为真），以确认降级只因为缺配置、不是因为 SDK 没加载；
//   桩记录 createClient 调用次数，缺配置时必须为 0。所有非本机请求一律拦截并计数，*.supabase.co 另钉到 0.0.0.0。
//   整套跑两轮，两轮的逐页结果必须逐字一致。
//
// 非秘密：只用仓库里已提交的占位模板与空值；无真实凭据、零外网请求。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchOwnChrome } from "./lib/chrome-launcher.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json" };

const LOCAL_CFG_PATH = "/assets/js/supabase-config.local.js";
const EXAMPLE = fs.readFileSync(path.join(ROOT, "assets/js/supabase-config.local.example.js"), "utf8");
/* 量具自检用：构造的 project ref 与字面占位串，格式像填好了，但不是任何真实凭据 */
const FILLED = 'window.SUPA = { url: "https://abcdefghijklmnopqrst.supabase.co", anonKey: "local-test-not-a-credential" };';
/* 英文模板写法的占位符（auth.js 注释里举的正是这一类）。示例文件里的占位符含中文，
   fetch 设请求头时会直接抛错、碰巧发不出去；ASCII 占位符不会被这样挡住，必须靠判据挡。 */
const PLACEHOLDER_ASCII = 'window.SUPA = { url: "https://your-project.supabase.co", anonKey: "your-anon-key" };';
let scenario = "absent";
let localCfgHits = 0;
let submissionHits = 0;   // 落到本机的 /rest/v1/submissions 请求（占位 url 被当成相对路径时就会这样）

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  /* 先接管旁路文件，**在读磁盘之前** —— 本机那份真文件永远不会被读到 */
  if (p === LOCAL_CFG_PATH) {
    localCfgHits++;
    if (scenario === "placeholder" || scenario === "filled" || scenario === "placeholder-ascii") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(scenario === "filled" ? FILLED : scenario === "placeholder-ascii" ? PLACEHOLDER_ASCII : EXAMPLE);
    } else { res.writeHead(404, { "Cache-Control": "no-store" }); res.end("nf"); }
    return;
  }
  if (p.indexOf("/rest/v1/submissions") > -1) { submissionHits++; res.writeHead(404); res.end("nf"); return; }
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const { chrome, port } = await launchOwnChrome({
  profilePrefix: "amas-noconfig-",
  extraArgs: ["--host-resolver-rules=MAP *.supabase.co 0.0.0.0, MAP *.supabase.in 0.0.0.0", "--disable-gpu", "--hide-scrollbars"],
});

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
    if (!url) throw new Error("连不上自己的调试端口 " + port);
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
}

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  ← " + d : "")); } };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/* SDK 桩：让 HAS_SDK 为真；缺配置时谁都不该调 createClient（计数必须为 0）。
   调了就返回一个惰性客户端（没有会话、什么都不连）—— 不能在这里抛错：
   auth.js 会在加载时建客户端，抛错会让 AmasAuth 整个不存在，N 段的自检就量不出 ready 了。 */
const SDK_STUB = `window.__createClientCalls = 0;
window.supabase = { createClient: function(){
  window.__createClientCalls++;
  var reply = function(v){ return Promise.resolve(v); };
  var q = { select:function(){return q;}, eq:function(){return q;}, in:function(){return q;}, order:function(){return q;},
            range:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
            then:function(res, rej){ return Promise.resolve({ data:null, error:null, status:200 }).then(res, rej); } };
  return {
    auth: { getSession: function(){ return reply({ data:{ session:null }, error:null }); },
            onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
            mfa: { getAuthenticatorAssuranceLevel: function(){ return reply({ data:{ currentLevel:null, nextLevel:null }, error:null }); } },
            signOut: function(){ return reply({}); } },
    from: function(){ return q; },
    rpc: function(){ return reply({ data:null, error:null, status:200 }); },
    functions: { invoke: function(){ return reply({ data:null, error:null }); } }
  };
} };`;

const PORTAL_WHOLE_PAGE = [
  "portal/", "portal/student/", "portal/student/courses/", "portal/student/profile/",
  "portal/applicant/", "portal/applicant/application/", "portal/applicant/profile/", "portal/applicant/history/",
  "portal/teacher/", "portal/teacher/profile/",
  "portal/admin/", "portal/admin/admissions/", "portal/admin/students/", "portal/admin/teachers/",
  "portal/mfa/", "auth/callback/",
];
const INLINE_NOTICE = { "login/": "btnLogin", "register/": "btnReg", "forgot-password/": "btnGo", "faculty/verify/": "btnCode" };
const RECOVERY = "auth/recovery/";
const ALL = [...PORTAL_WHOLE_PAGE, ...Object.keys(INLINE_NOTICE), RECOVERY];

/* 与 git 跟踪的 auth.js 页面清单核对：以后新增页面没进这张表，这里直接报出来 */
{
  const { execFileSync } = await import("node:child_process");
  const tracked = execFileSync("git", ["grep", "-l", "portal/auth.js", "--", "*.html"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean).map((f) => f.replace(/index\.html$/, "")).sort();
  const mine = [...ALL].sort();
  ok("P0 页面清单与仓库里所有引用 auth.js 的页面一致（" + tracked.length + " 个）",
     JSON.stringify(tracked) === JSON.stringify(mine),
     JSON.stringify({ 仓库有表里没有: tracked.filter((x) => !mine.includes(x)), 表里有仓库没有: mine.filter((x) => !tracked.includes(x)) }));
}

let externalBlocked = [];
let exceptions = [];
try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Runtime.exceptionThrown", (p) => exceptions.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "").split("\n")[0]));
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("cdn.jsdelivr.net") > -1 && u.indexOf("supabase-js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" }, { name: "Cache-Control", value: "no-store" }],
          body: b64(SDK_STUB) });
        return;
      }
      if (!u.startsWith(BASE + "/")) {           // 一切非本机请求：不放出去，只记下
        externalBlocked.push(u.split("?")[0]);
        await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" });
        return;
      }
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) { /* 请求可能已终结 */ }
  });

  const probe = (page, btnId) => cdp.ev(`(()=>{
    const A = window.AmasAuth || {};
    const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
    const $ = (id) => document.getElementById(id);
    const out = { state: A.CONFIG_STATE || null, source: window.SUPA_SOURCE || null,
                  urlFilled: !!(window.SUPA && String(window.SUPA.url || "").trim()), sdk: !!window.supabase,
                  createClient: window.__createClientCalls || 0, title: document.title };
    if (${JSON.stringify(PORTAL_WHOLE_PAGE)}.includes(${JSON.stringify(page)})) {
      out.head = ($("portalDisabledTitle") || {}).textContent || null;
      out.retry = !!$("portalRetry");
    } else if (${JSON.stringify(page)} === ${JSON.stringify(RECOVERY)}) {
      out.failCard = vis($("cardFail")); out.failMsg = ($("failMsg") || {}).textContent || null;
      out.formCard = vis($("cardForm"));
    } else {
      out.disabledNotice = vis($("disabledNotice")); out.offlineNotice = vis($("offlineNotice"));
      const b = $(${JSON.stringify(btnId || "")}); out.btnDisabled = !!(b && b.disabled); out.btnFound = !!b;
    }
    out.leaksUndefined = /undefined|\\[object Object\\]|NaN/.test(document.body.innerText || "");
    return out; })()`);

  const signatures = { 1: {}, 2: {} };
  for (const round of [1, 2]) {
    for (const sc of ["absent", "placeholder"]) {
      scenario = sc;
      console.log(`\n=== 第 ${round} 轮 · ${sc === "absent" ? "没有旁路文件（出厂态）" : "旁路文件 = 示例模板原样（占位符没改）"} ===`);
      for (const page of ALL) {
        exceptions = [];
        const hitsBefore = localCfgHits;
        await cdp.send("Page.navigate", { url: `${BASE}/${page}?r=${round}-${sc}` });
        let s = null;
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          s = await probe(page, INLINE_NOTICE[page]).catch(() => null);
          const settled = s && (s.head || s.failCard || s.disabledNotice);
          if (settled) break;
        }
        await sleep(300);
        s = await probe(page, INLINE_NOTICE[page]);
        const tag = `R${round} ${sc} ${page}`;
        const common = s.state === "missing" && s.sdk === true && s.createClient === 0 && exceptions.length === 0 && !s.leaksUndefined &&
          localCfgHits > hitsBefore &&
          (sc === "absent" ? s.source === null && s.urlFilled === false : s.source === "local-override" && s.urlFilled === true);
        let specific;
        if (PORTAL_WHOLE_PAGE.includes(page)) specific = s.head === "门户系统尚未启用" && s.retry === false && s.title === "门户系统尚未启用 | AMAS";
        else if (page === RECOVERY) specific = s.failCard === true && s.formCard === false && s.failMsg === "门户系统尚未启用，无法处理密码重设。";
        else specific = s.disabledNotice === true && s.offlineNotice === false && s.btnFound === true && s.btnDisabled === true;
        ok(`${tag}：判 missing、给出友好提示、不建客户端、无异常`, common && specific,
           JSON.stringify({ ...s, exceptions, localCfgRequested: localCfgHits > hitsBefore }));
        signatures[round][`${sc} ${page}`] = JSON.stringify({ ...s, exceptions: exceptions.length });
      }
    }
  }

  /* ── W：不走 auth.js、但同样读 window.SUPA 的公开页（T-029）──────────────────
     admin.html（旧后台，自己建客户端）、index.html（main.js 的 logToDB）、giving.html（奉献表单成功后写库）。
     占位配置照样得算「没配置」：admin 显示设置提示、不建客户端；logToDB 不发任何请求 ——
     原来三处都只判「非空」，占位串是非空的。 */
  console.log("\n=== W 不走 auth.js 的公开页：没配置 / 占位配置 ===");
  {
    const { execFileSync } = await import("node:child_process");
    const withCfg = execFileSync("git", ["grep", "-l", "supabase-config.js", "--", "*.html"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    const withAuth = new Set(execFileSync("git", ["grep", "-l", "portal/auth.js", "--", "*.html"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean));
    const nonAuth = withCfg.filter((f) => !withAuth.has(f)).sort();
    ok("W0 读 supabase-config.js 却不走 auth.js 的页面清单（admin.html、giving.html、index.html）",
       JSON.stringify(nonAuth) === JSON.stringify(["admin.html", "giving.html", "index.html"]), JSON.stringify(nonAuth));
    const SRC = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
    const naive = [["admin.html", /!S\.url\s*\|\|\s*!S\.anonKey/], ["assets/js/main.js", /!S\.url\s*\|\|\s*!S\.anonKey/], ["giving.html", /S\.url\s*&&\s*S\.anonKey/]]
      .filter(([f, re]) => re.test(SRC(f))).map(([f]) => f);
    ok("W1 三处公开页的配置判据不再只判「非空」（占位串是非空的）", naive.length === 0, "仍只判非空：" + JSON.stringify(naive));
    const reOf = (src) => (src.match(/const PLACEHOLDER = (\/.+\/[a-z]*);/) || [])[1] || null;
    const authRe = reOf(SRC("assets/js/portal/auth.js")), cfgRe = reOf(SRC("assets/js/supabase-config.js"));
    ok("W2 supabase-config.js 与 auth.js 的占位符判据逐字一致（不许两份各自漂移）",
       !!authRe && authRe === cfgRe, JSON.stringify({ authRe, cfgRe }));
  }
  const adminProbe = () => cdp.ev(`(()=>{const v=(el)=>!!el&&!el.hidden&&getComputedStyle(el).display!=="none";
    return { setup: v(document.getElementById("setupHint")), login: v(document.getElementById("loginBox")),
             createClient: window.__createClientCalls || 0 }; })()`);
  const tryLogToDB = async () => {
    const has = await cdp.ev(`typeof window.logToDB === "function"`);
    if (!has) return { has: false };
    const subBefore = submissionHits, extBefore = externalBlocked.filter((u) => /submissions/.test(u)).length;
    await cdp.ev(`(window.logToDB("inquiry", { fullName: "占位测试", email: "t@example.invalid" }), true)`);
    await sleep(900);
    return { has: true, localSubmissions: submissionHits - subBefore,
             externalSubmissions: externalBlocked.filter((u) => /submissions/.test(u)).length - extBefore };
  };
  for (const sc of ["absent", "placeholder", "placeholder-ascii"]) {
    scenario = sc;
    exceptions = [];
    await cdp.send("Page.navigate", { url: `${BASE}/admin.html?w=${sc}` });
    await sleep(1500);
    const a = await adminProbe();
    ok(`W3 ${sc} admin.html：显示设置提示、不显示登录框、不建客户端、无异常`,
       a.setup === true && a.login === false && a.createClient === 0 && exceptions.length === 0, JSON.stringify({ ...a, exceptions }));
    exceptions = [];
    await cdp.send("Page.navigate", { url: `${BASE}/index.html?w=${sc}` });
    await sleep(2000);
    const l = await tryLogToDB();
    ok(`W4 ${sc} index.html：logToDB 不发任何写库请求（本机相对路径与外部都没有）、无异常`,
       l.has === true && l.localSubmissions === 0 && l.externalSubmissions === 0 && exceptions.length === 0, JSON.stringify({ ...l, exceptions }));
    exceptions = [];
    await cdp.send("Page.navigate", { url: `${BASE}/giving.html?w=${sc}` });
    await sleep(1500);
    ok(`W5 ${sc} giving.html：载入无异常`, exceptions.length === 0, JSON.stringify(exceptions));
  }
  const supaBeforeSelfCheck = externalBlocked.length;

  /* N：量具自检。旁路文件换成「填好了」的构造值 —— 页面必须判 ready、不再说「尚未启用」。
     证明上面的绿不是因为这套判据在任何配置下都判 missing。（ready 之后桩会拒绝建客户端，页面报什么不在此量。） */
  console.log("\n=== N 量具自检：填了构造值时必须判 ready ===");
  scenario = "filled";
  for (const page of ["portal/", "login/", RECOVERY]) {
    await cdp.send("Page.navigate", { url: `${BASE}/${page}?r=filled` });
    await sleep(1500);
    const s = await probe(page, INLINE_NOTICE[page]);
    ok(`N1 filled ${page}：判 ready，且不显示「尚未启用」`,
       s.state === "ready" && s.source === "local-override" && s.createClient >= 1 && s.head !== "门户系统尚未启用" && s.disabledNotice !== true &&
       s.failMsg !== "门户系统尚未启用，无法处理密码重设。", JSON.stringify(s));
  }
  /* N2：同样的构造值下，admin 应当去建客户端、logToDB 应当真的去写库（请求被本测试拦下、不放出去）——
     证明 W3 / W4 的「不建 / 不发」是判据在起作用，不是量具瞎了。 */
  await cdp.send("Page.navigate", { url: `${BASE}/admin.html?r=filled` });
  await sleep(1500);
  const na = await adminProbe();
  ok("N2 filled admin.html：不再显示设置提示，且建了客户端", na.setup === false && na.createClient >= 1, JSON.stringify(na));
  await cdp.send("Page.navigate", { url: `${BASE}/index.html?r=filled` });
  await sleep(2000);
  const nl = await tryLogToDB();
  ok("N3 filled index.html：logToDB 确实发出了写库请求（被拦下，未放出）", nl.has === true && nl.externalSubmissions === 1, JSON.stringify(nl));

  console.log("\n=== 稳定性与外发 ===");
  const diff = Object.keys(signatures[1]).filter((k) => signatures[1][k] !== signatures[2][k]);
  ok("S1 两轮逐页结果逐字一致（" + Object.keys(signatures[1]).length + " 项）", diff.length === 0 && Object.keys(signatures[2]).length === Object.keys(signatures[1]).length, JSON.stringify(diff.slice(0, 3)));
  /* 只看 N 量具自检之前：N3 故意让 logToDB 往构造的 supabase 地址发一次（被拦下），那是自检本身 */
  const supaHits = externalBlocked.slice(0, supaBeforeSelfCheck).filter((u) => /supabase\.(co|in)/.test(u));
  ok("S2 没有配置 / 占位配置下，没有任何发往 supabase 后端的请求", supaHits.length === 0, JSON.stringify(supaHits.slice(0, 3)));
  const uniq = [...new Set(externalBlocked.map((u) => new URL(u).host))];
  console.log("      · 被拦下、未放出的非本机请求主机：" + (uniq.length ? uniq.join("、") : "（无）"));
  ok("S3 本机旁路文件确实被页面请求过（" + localCfgHits + " 次，全部由测试接管，未读本机真文件）", localCfgHits >= ALL.length * 4);
  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + (e && e.stack || e));
} finally {
  try { chrome.kill(); } catch (e) {}
  server.close();
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  非秘密占位配置 + SDK 桩 + 非本机请求全部拦截：无真实凭据、零外网请求。");
process.exit(fail ? 1 : 0);
