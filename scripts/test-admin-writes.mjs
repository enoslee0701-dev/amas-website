// 两个管理页的**不可逆写入**：一个把失败当成功，一个没有在途闸。
//
// ── 缺陷一：学籍页把失败当成功（严重）────────────────────────────────
// portal/admin/students/index.html:
//     const { data, error } = await A.callFn("student-lifecycle", body);
//     if (error) { showErr(error.message); return null; }
// 但 auth.js 的 callFn **根本不返回 error**，它返回的是 { status, data }。
// 于是 `error` 永远是 undefined，那一支永远不执行。接着只判 data.ok === false，
// 而断网（{status:0,data:{error:"network"}}）、5xx、网关 HTML（data 是 null）
// 统统落不进去 —— 直接走到 UI.toast(okMsg) 弹「已建立学籍 / 已完成正式注册 /
// 学号纠错已完成」，再 load() 刷新。**写入根本没发生，却告诉管理员已经完成。**
// 同仓的 portal/admin/teachers/ 用的是 Api.fn（它返回 {data,error}），是对的。
//
// ── 缺陷二：招生审核没有在途闸，也不分「确定没执行」与「结果不明」────
// portal/admin/admissions/index.html 的 act()：按钮不禁用，连点两次就发两次
// review-application；失败时只 `err.textContent = error.message`。
// 而 teachers 页对同一类动作已经做对了：在途禁用全部动作按钮、
// 明确拒绝才解锁、结果不明则锁住该条并明说「无法确认它是否已经生效 ——
// 重复审核会写下两条审批记录」。同一风险，两页待遇不同。
//
// ── 用的是什么 ────────────────────────────────────────────────────────
// 本地 stub（表驱动 + /functions/v1/ 的 fetch 改写），无真实账号/凭据/服务，
// 无外网请求。独占动态端口（DevToolsActivePort）。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-adminw-"));
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

/** 表驱动 stub（沿用 test-portal-pages 的形状）。Edge 调用不走这里 ——
    它们是 fetch("/functions/v1/…")，在页面里改写 fetch 来控制结果。 */
const STUB = `
window.__failed_ = {};
window.supabase = {
  createClient: function(){
    var S = function(){ return window.__SCEN || {}; };
    var reply = function(v){ return Promise.resolve(v); };
    function table(name){
      /* range 不能是 no-op —— 那样分页测了等于没测。这里**真的按 range 切片**，
         并把每一次请求的 range 记下来，好断言「有没有跳页、重试有没有换页」。
         另外支持按 range 注入一次性失败与延迟，用来造并发与晚回。 */
      var q = { select:function(){return q;}, eq:function(){return q;}, in:function(){return q;},
        order:function(c, o){ (q.__ord = q.__ord || []).push(c + ":" + (o && o.ascending ? "asc" : "desc"));
          try { (window.__orders = window.__orders || {})[name] = q.__ord.slice(); } catch (e) {}
          return q; },
        limit:function(){return q;}, maybeSingle:function(){return q;},
        range:function(a, b){ q.__range = [a, b]; return q; },
        then:function(res, rej){
          var sc = S();
          var t = (sc.tables && sc.tables[name]) || { data: [], error: null };
          var out, key = null;
          if (q.__range) {
            key = q.__range[0] + ".." + q.__range[1];
            try { (window.__ranges = window.__ranges || []).push(name + ":" + key); } catch (e) {}
          }
          if (key && sc.failRangeOnce === key && !window.__failed_[key]) {
            window.__failed_[key] = 1;
            out = { data:null, error:{ message:"boom" }, status:500 };
          } else if (q.__range && Array.isArray(t.data)) {
            out = { data: t.data.slice(q.__range[0], q.__range[1] + 1), error:null, status:200 };
          } else {
            out = { data:t.data, error:t.error||null, status:t.error?500:200 };
          }
          var d = (key && sc.rangeDelay && sc.rangeDelay[key]) || t.delay || 0;
          return (d ? new Promise(function(r){ setTimeout(function(){ r(out); }, d); })
                    : Promise.resolve(out)).then(res, rej);
        } };
      return q;
    }
    return {
      auth: {
        getSession: function(){ return reply({ data:{ session:{ user:{id:"u-fixture"}, access_token:"fixture-token" } }, error:null }); },
        mfa: { getAuthenticatorAssuranceLevel: function(){
          return reply({ data:{ currentLevel:"aal2", nextLevel:"aal2" }, error:null }); } },
        onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
        signOut: function(){ return reply({}); }
      },
      from: table,
      rpc: function(name, args){
        /* 守卫用的两个 RPC 给默认值，否则页面还没进去就被角色闸挡下，
           本套件要测的写入路径根本走不到。 */
        if (name === "my_roles" && !(S().rpc||{}).my_roles)
          return reply({ data:[{ role:"registrar" },{ role:"super_admin" }], error:null, status:200 });
        if (name === "my_profile" && !(S().rpc||{}).my_profile)
          return reply({ data:{ display_name:"测试教务", email:"a@example.invalid" }, error:null, status:200 });
        var r = (S().rpc && S().rpc[name]) || { data:null, error:null };
        return reply({ data:r.data, error:r.error||null, status:r.error?500:200 });
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
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

  const APP = {
    id: "app-fixture-1", applicant_id: "u-appl", pathway: "degree", status: "submitted",
    submitted_at: "2026-09-01T02:00:00Z", decided_at: null, updated_at: "2026-09-01T02:00:00Z",
    applicant_visible_message: null, locked_fields: [],
    form_data: { name_zh: "测试申请人", name_en: "Test", church_name: "测试教会", programs: ["bth"] },
  };
  const TABLES = {
    program_catalog: { data: [{ code:"bth", name_zh:"神学本科", short_label:"B.Th" }] },
    applications: { data: [APP, Object.assign({}, APP, { id:"app-fixture-2",
      form_data:{ name_zh:"第二位申请人", name_en:"Second", church_name:"另一间教会", programs:["bth"] } })] },
    application_internal: { data: { notes: "（fixture 内部备注）" } },
    application_requirements: { data: [] },
    application_status_history: { data: [] },
    application_hq_approvals: { data: [] },
    student_records: { data: [] },
    profiles: { data: [] },
  };

  /** 在页面里改写 /functions/v1/ 的 fetch，控制 Edge 调用的结果并计数。
      kind: ok | throw | http500 | html | refuse */
  const installFetch = async (kind) => cdp.ev(`(()=>{
    window.__fnHits = 0; window.__fnBodies = [];
    const orig = window.fetch;
    window.fetch = function(u){
      if (String(u).indexOf("/functions/v1/") < 0) return orig.apply(this, arguments);
      window.__fnHits++;
      try { const b = JSON.parse((arguments[1] && arguments[1].body) || "{}");
            (window.__fnBodies = window.__fnBodies || []).push(b); } catch (e) {}
      const k = ${JSON.stringify(kind)};
      if (k === "throw")   return Promise.reject(new TypeError("Failed to fetch"));
      if (k === "http500") return Promise.resolve(new Response(JSON.stringify({}), { status:500,
                                headers:{ "Content-Type":"application/json" } }));
      if (k === "html")    return Promise.resolve(new Response("<html>502</html>", { status:502,
                                headers:{ "Content-Type":"text/html" } }));
      if (k === "malformed") return Promise.resolve(new Response(JSON.stringify({}), { status:200,
                                headers:{ "Content-Type":"application/json" } }));
      if (k === "refuse")  return Promise.resolve(new Response(JSON.stringify({ error:"invalid_state" }),
                                { status:409, headers:{ "Content-Type":"application/json" } }));
      return Promise.resolve(new Response(JSON.stringify({ ok:true }), { status:200,
             headers:{ "Content-Type":"application/json" } }));
    };
    return true;})()`);
  const fnHits = async () => cdp.ev(`window.__fnHits || 0`);
  const open = async (page, scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(scen) + ";" });
    await cdp.send("Page.navigate", { url: `${BASE}/${page}` });
    await sleep(wait || 2600);
  };
  const vis = async (sel) => cdp.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
    if(!e) return null; const k=e.cloneNode(true); k.querySelectorAll("[hidden]").forEach(n=>n.remove());
    return (k.textContent||"").replace(/\\s+/g," ").trim();})()`);
  const bodyVis = async () => cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template,[hidden]").forEach(n=>n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();})()`);
  /* 直接看 toast 与错误条本身，而不是在整页文本里碰运气匹配 ——
     「建立学籍」这条的成功文案是「学籍已建立（待正式注册）」，
     正则写歪一个字，S 段就会整段空转变绿。 */
  const outcome = async () => cdp.ev(`(()=>{
    const t = document.getElementById("amas-toast");
    const e = document.querySelector("#panel .msg.err, #lcErr, .msg.err.show");
    return { toast: t ? (t.textContent||"").trim() : null,
             toastShown: !!(t && t.classList.contains("show")),
             err: e ? (e.textContent||"").trim() : null };
  })()`);

  // ════════ A 招生审核（review-application，不可逆且写审计）════════
  console.log("\n=== A 招生审核 ===");
  const openDetail = async () => {
    await cdp.clickReal("[data-open]");
    await sleep(600);
  };
  const confirmDialog = async () => {
    // UI.confirmDialog 的确认按钮
    await cdp.ev(`(()=>{const b=[...document.querySelectorAll("button")]
      .find(x=>/^确认$/.test((x.textContent||"").trim())); if(b) b.click(); return !!b;})()`);
    await sleep(400);
  };

  await open("portal/admin/admissions/", { tables: TABLES }, 3000);
  ok("A0 前提：列表与详情能打开，动作按钮在", !!(await vis("[data-open]")), await bodyVis().then(t=>t.slice(0,90)));
  await openDetail();
  ok("A0b 前提：详情里有「开始审核」动作", !!(await cdp.ev(`!!document.querySelector('[data-a="start_review"]')`)));

  // A1/A2 在途闸
  await installFetch("ok");
  await cdp.ev(`(()=>{const f=window.fetch; window.fetch=function(u){
    if(String(u).indexOf("/functions/v1/")<0) return f.apply(this,arguments);
    return new Promise(r=>setTimeout(()=>r(f.apply(this,arguments)),900));};return true;})()`);
  await cdp.clickReal('[data-a="start_review"]');
  await confirmDialog();
  const inflight = await cdp.ev(`(()=>{const b=document.querySelector('[data-a="start_review"]');
    return { disabled: !!(b && b.disabled), busy: !!(b && b.getAttribute("aria-busy")) };})()`);
  ok("A1 在途期间动作按钮被禁用（不给第二次机会）", inflight.disabled === true, JSON.stringify(inflight));
  await cdp.ev(`(()=>{const b=document.querySelector('[data-a="start_review"]'); if(b) b.click(); return true;})()`);
  await sleep(1600);
  ok("A2 连点两次只发出一次 review-application（审核会写审计记录）",
     (await fnHits()) === 1, "命中 " + (await fnHits()) + " 次");

  // A3 结果不明
  await open("portal/admin/admissions/", { tables: TABLES }, 3000);
  await openDetail();
  await installFetch("throw");
  await cdp.clickReal('[data-a="start_review"]');
  await confirmDialog();
  await sleep(1500);
  const a3 = await vis("#dErr");
  ok("A3 结果不明时明说无法确认是否已生效，不说成「失败了」",
     /无法确认/.test(a3 || ""), JSON.stringify(a3));
  const a3lock = await cdp.ev(`(()=>{const b=document.querySelector('[data-a="start_review"]');
    return !!(b && b.disabled);})()`);
  ok("A3b 并把这一条锁住，不让人顺手再点一次", a3lock === true, "disabled=" + a3lock);

  // A4 明确拒绝
  await open("portal/admin/admissions/", { tables: TABLES }, 3000);
  await openDetail();
  await installFetch("refuse");
  await cdp.clickReal('[data-a="start_review"]');
  await confirmDialog();
  await sleep(1500);
  const a4 = await vis("#dErr");
  ok("A4 明确拒绝时说清楚「这次没有执行」", /这次没有执行/.test(a4 || ""), JSON.stringify(a4));
  ok("A4b 明确拒绝可以重来（按钮解锁）",
     (await cdp.ev(`(()=>{const b=document.querySelector('[data-a="start_review"]'); return !!(b && !b.disabled);})()`)) === true);

  // ════════ R 结果不明的锁只能锁住那一份（event141c 返修）════════
  console.log("\n=== R 不明结果不得锁住别的申请 ===");
  const fnBodies = async () => (await cdp.ev(`window.__fnBodies || []`)) || [];
  const openRow = async (n) => {
    await cdp.ev(`(()=>{const b=document.querySelectorAll("[data-open]")[${n}]; if(b) b.click(); return !!b;})()`);
    await sleep(700);
  };
  const actOn = async (a) => {
    await cdp.ev(`(()=>{const b=document.querySelector('[data-a="${a}"]'); if(b && !b.disabled) b.click(); return true;})()`);
    await sleep(400);
    await confirmDialog();
    await sleep(1400);
  };

  await open("portal/admin/admissions/", { tables: TABLES }, 3000);
  await installFetch("throw");
  await openRow(0);
  await actOn("start_review");
  ok("R0 前提：A 落到结果不明并被锁住",
     /无法确认/.test((await vis("#dErr")) || "") &&
     (await cdp.ev(`(()=>{const b=document.querySelector('[data-a="start_review"]'); return !!(b&&b.disabled);})()`)) === true,
     JSON.stringify(await vis("#dErr")));
  const hitsAfterA = await fnHits();

  await installFetch("ok");
  await cdp.ev(`(()=>{const c=document.getElementById("dClose"); if(c) c.click(); return true;})()`);
  await sleep(300);
  await openRow(1);
  await actOn("start_review");
  const bodies = await fnBodies();
  ok("R1 打开另一份申请 B，动作真的执行了（不再被 A 的锁静默吞掉）",
     (await fnHits()) === 1 && bodies.length === 1, "B 侧命中 " + (await fnHits()) + " 次");
  ok("R1b 发出去的是 B 的 id，不是 A 的",
     bodies.length === 1 && bodies[0].application_id === "app-fixture-2", JSON.stringify(bodies));

  // A 重新打开仍锁着
  await installFetch("ok");
  await openRow(0);
  ok("R2 重新打开 A，仍然锁着并把原话再说一遍",
     /无法确认/.test((await vis("#dErr")) || "") &&
     (await cdp.ev(`(()=>{const b=document.querySelector('[data-a="start_review"]'); return !!(b&&b.disabled);})()`)) === true,
     JSON.stringify(await vis("#dErr")));
  await actOn("start_review");
  ok("R3 在 A 上再点也不会误重试（一次请求都不发）", (await fnHits()) === 0,
     "命中 " + (await fnHits()) + " 次");

  // R4 弹窗开着时切到另一份：动作仍作用于**发起时**的那一份
  await open("portal/admin/admissions/", { tables: TABLES }, 3000);
  await installFetch("ok");
  await openRow(0);
  await cdp.ev(`(()=>{const b=document.querySelector('[data-a="start_review"]'); if(b) b.click(); return true;})()`);
  await sleep(400);
  await cdp.ev(`(()=>{const b=document.querySelectorAll("[data-open]")[1]; if(b) b.click(); return !!b;})()`);
  await sleep(500);
  await confirmDialog();
  await sleep(1500);
  const b4 = await fnBodies();
  ok("R4 确认弹窗期间切到 B，动作仍落在发起时的 A 上，不串到另一份",
     b4.length === 1 && b4[0].application_id === "app-fixture-1", JSON.stringify(b4));

  // ════════ S 学籍写入（student-lifecycle）════════
  console.log("\n=== S 学籍写入 ===");
  const STU_TABLES = Object.assign({}, TABLES, {
    application_hq_approvals: { data: [{ application_id: "app-fixture-1", decision: "approved" }] },
  });
  const openVoidsTab = async () => {
    await cdp.ev(`(()=>{const b=document.querySelector('[data-tab="voids"]'); if(b) b.click(); return !!b;})()`);
    await sleep(800);
  };
  const runLifecycle = async (kind) => {
    await open("portal/admin/students/", { tables: STU_TABLES,
      rpc: { admissions_ready_for_enrollment: { data: [{ application_id:"app-fixture-1",
        display_name:"测试申请人", email:"a@example.invalid", program_code:"bth",
        approval_reference:"HQ-FIXTURE-1", confirmed_at:"2026-09-02T02:00:00Z" }] } } }, 3200);
    await installFetch(kind);
    // 「待建档」是默认 tab；建立学籍的按钮是 [data-create]
    const opened = await cdp.ev(`(()=>{const b=document.querySelector("[data-create]"); if(b) b.click(); return !!b;})()`);
    if (!opened) return { opened: false };
    await sleep(500);
    // 弹窗必填项填上，再点主动作
    const fired = await cdp.ev(`(()=>{document.querySelectorAll("[data-f]").forEach(i=>{ if(!i.value) i.value="FIXTURE-1"; });
      const b=document.querySelector("[data-act]"); if(b) b.click(); return !!b;})()`);
    await sleep(1800);
    return { opened: true, fired };
  };

  const r1 = await runLifecycle("throw");
  ok("S0 前提：确实走到了「建立学籍」这一步（否则下面全是空转）",
     r1.opened === true && r1.fired === true, JSON.stringify(r1));
  ok("S0b 前提：Edge 调用确实发出去过一次", (await fnHits()) === 1, "命中 " + (await fnHits()) + " 次");
  const o1 = await outcome();
  ok("S1 断网时**不能**报成功 —— 写入根本没发生", o1.toastShown !== true, JSON.stringify(o1));
  ok("S1b 而是如实说没能确认这次有没有生效",
     /没能确认|无法确认/.test((o1.err || "") + (o1.toast || "")), JSON.stringify(o1));

  await runLifecycle("http500");
  const o2 = await outcome();
  ok("S2 5xx 时同样不报成功", o2.toastShown !== true, JSON.stringify(o2));
  ok("S2b 5xx 同样说无法确认（服务端回话了，但没说结果）",
     /没能确认|无法确认/.test((o2.err || "") + (o2.toast || "")), JSON.stringify(o2));

  await runLifecycle("html");
  const o3 = await outcome();
  ok("S3 网关返回 HTML（拿不到 JSON）时同样不报成功", o3.toastShown !== true, JSON.stringify(o3));

  await runLifecycle("ok");
  const o4 = await outcome();
  ok("S4 真的成功时照常报「学籍已建立（待正式注册）」（没改坏）",
     o4.toastShown === true && /学籍已建立/.test(o4.toast || ""), JSON.stringify(o4));

  /* 200 但结构对不上契约。这几条写入的服务端契约都是
     jsonb_build_object('ok', true, …)（0004/0008/0012）。只判 ok === false
     或只看 data 真值的话，合成的 200 {} 会被当成成功 —— 监督 event7e06。 */
  console.log("\n=== M 畸形 200 ===");
  await runLifecycle("malformed");
  const om = await outcome();
  ok("M1 学籍写入收到 200 {} → 不报成功（契约是 ok:true）",
     om.toastShown !== true, JSON.stringify(om));
  ok("M1b 而是说无法确认", /没能确认|无法确认/.test((om.err || "") + (om.toast || "")), JSON.stringify(om));

  await open("portal/admin/admissions/", { tables: TABLES }, 3000);
  await openDetail();
  await installFetch("malformed");
  await actOn("start_review");
  const am = await vis("#dErr");
  ok("M2 招生审核收到 200 {} → 不当成成功，说无法确认",
     /无法确认/.test(am || ""), JSON.stringify(am));

  // ════════ E 证据读不到，必须说「未知」，不能当「没有」════════
  console.log("\n=== E 管理详情的缺失要说未知 ===");
  /* 这两页都在做**不可逆且写审计**的决定。几路读取原来只解构 data，
     读不到就当成没有：
       internal 读失败 → 内部备注显示「（暂无）」——上一位管理员写的
         「此人材料存疑」就此隐形；
       reqs 读失败 → 补充资料要求整段省略——看不出这份申请还欠材料；
       hist 读失败 → 时间线显示「暂无记录」；
       hq 读失败 → 每一行总校状态都显示「未记录」——可能重复记录或误判。 */
  const drawer = async () => vis("#detail");

  await open("portal/admin/admissions/", { tables: Object.assign({}, TABLES, {
    application_internal: { data:null, error:{ message:"boom" }, status:500 } }) }, 3000);
  await openDetail();
  const e1 = await drawer();
  ok("E1 内部备注读不到时不显示「（暂无）」", !/（暂无）/.test(e1 || ""), (e1 || "").slice(0, 200));
  ok("E1b 而是明说这一次没读到", /没能读到|没读到|未知/.test(e1 || ""), (e1 || "").slice(0, 200));

  await open("portal/admin/admissions/", { tables: Object.assign({}, TABLES, {
    application_requirements: { data:null, error:{ message:"boom" }, status:500 } }) }, 3000);
  await openDetail();
  const e2 = await drawer();
  ok("E2 补件要求读不到时不静默省略，明确说出来",
     /补充资料要求/.test(e2 || "") && /没能读到|没读到|未知/.test(e2 || ""), (e2 || "").slice(0, 240));

  await open("portal/admin/admissions/", { tables: Object.assign({}, TABLES, {
    application_status_history: { data:null, error:{ message:"boom" }, status:500 } }) }, 3000);
  await openDetail();
  const e3 = await drawer();
  ok("E3 时间线读不到时不显示「暂无记录」", !/暂无记录/.test(e3 || ""), (e3 || "").slice(0, 240));

  await open("portal/admin/students/", { tables: Object.assign({}, TABLES, {
    application_hq_approvals: { data:null, error:{ message:"boom" }, status:500 } }),
    rpc: { admissions_ready_for_enrollment: { data: [] } } }, 3000);
  await cdp.ev(`(()=>{const b=document.querySelector('[data-tab="accepted"]'); if(b) b.click(); return !!b;})()`);
  await sleep(1200);
  const e4 = await cdp.ev(`(()=>{const p=document.getElementById("panel");
    if(!p) return null; const k=p.cloneNode(true); k.querySelectorAll("[hidden]").forEach(n=>n.remove());
    return (k.textContent||"").replace(/\\s+/g," ").trim();})()`);
  ok("E4 总校审核读不到时不把每一行都说成「未记录」", !/未记录/.test(e4 || ""), (e4 || "").slice(0, 240));
  ok("E4b 而是明说这一次没读到总校审核记录",
     /没能读到|没读到|未知/.test(e4 || ""), (e4 || "").slice(0, 240));

  await open("portal/admin/admissions/", { tables: TABLES }, 3000);
  await openDetail();
  const e5 = await drawer();
  ok("E5 读得到时照常显示内部备注（没改坏）", /fixture 内部备注/.test(e5 || ""), (e5 || "").slice(0, 200));

  // ════════ F 返修 56ed794（监督两条）════════
  console.log("\n=== F 返修：未验证数组仍被 .map / 证据不明仍可写 ===");
  /* F1：我加了 hqUnknown = !Array.isArray(hq)，下一行却仍然 (hq || []).map(...)。
         hq 是非数组真值（例如 {}）时，.map 不是函数 —— 先抛 TypeError，
         根本走不到那句「未知」。判据写对了，执行不到就等于没写。
     F2：本包已经查明 confirm_hq_approval 是 on conflict do update，HQ 未知时
         再记一次会覆盖已有结论；却仍然渲染可点的写入口。监督裁定：未知时
         禁用该入口并给重试，读到之后才恢复。 */
  const acceptedTab = async () => {
    await cdp.ev(`(()=>{const b=document.querySelector('[data-tab="accepted"]'); if(b) b.click(); return !!b;})()`);
    await sleep(1200);
  };
  const panelVis = async () => cdp.ev(`(()=>{const p=document.getElementById("panel");
    if(!p) return null; const k=p.cloneNode(true); k.querySelectorAll("[hidden]").forEach(n=>n.remove());
    return (k.textContent||"").replace(/\\s+/g," ").trim();})()`);
  const hqBtn = async () => cdp.ev(`(()=>{const b=document.querySelector("[data-hq]");
    return b ? { disabled: !!b.disabled, text:(b.textContent||"").trim() } : null;})()`);

  await open("portal/admin/students/", { tables: Object.assign({}, TABLES, {
    application_hq_approvals: { data: {} } }),
    rpc: { admissions_ready_for_enrollment: { data: [] } } }, 3000);
  await acceptedTab();
  const f1 = await panelVis();
  ok("F1 hq 是非数组真值时不炸，仍然给出未知提示",
     /没能读到|没读到|未知/.test(f1 || ""), (f1 || "（页面没渲染出内容）").slice(0, 240));
  ok("F1b 并且没有把它当成「一条记录都没有」", !/未记录/.test(f1 || ""), (f1 || "").slice(0, 240));

  await open("portal/admin/students/", { tables: Object.assign({}, TABLES, {
    application_hq_approvals: { data:null, error:{ message:"boom" }, status:500 } }),
    rpc: { admissions_ready_for_enrollment: { data: [] } } }, 3000);
  await acceptedTab();
  await installFetch("ok");
  const f2 = await hqBtn();
  ok("F2 总校结论未知时「记录总校确认」被禁用", !!f2 && f2.disabled === true, JSON.stringify(f2));
  try { await cdp.clickReal("[data-hq]"); } catch (e) {}
  await sleep(500);
  const f3open = await cdp.ev(`!!document.querySelector(".portal-modal")`);
  /* 如果对话框真的开了，就把这条路走完 —— 只有走到「记录为已确认」才真的证明
     「证据不明时覆盖得出去」。停在弹窗前面会让这条断言空转变绿。 */
  await cdp.ev(`(()=>{const b=document.querySelector(".portal-modal [data-act='0']");
    if(b) b.click(); return !!b;})()`);
  await sleep(900);
  const f3hits = await fnHits();
  ok("F3 证据不明时根本走不到写入请求", f3hits === 0, "fnHits=" + f3hits);
  ok("F3b 也不会弹出记录对话框", f3open === false, "modal=" + f3open);
  /* 「刷新」两个字在那条横幅里本来就有，光看文本会空转变绿；
     要的是一个**真的能点**的重试控件。 */
  const f4 = await cdp.ev(`(()=>{const b=document.querySelector("[data-hqretry]");
    return b ? { text:(b.textContent||"").trim(), disabled:!!b.disabled } : null;})()`);
  ok("F4 未知时给得出可点的重试入口", !!f4 && f4.disabled === false, JSON.stringify(f4));

  await open("portal/admin/students/", { tables: TABLES,
    rpc: { admissions_ready_for_enrollment: { data: [] } } }, 3000);
  await acceptedTab();
  const f5 = await hqBtn();
  ok("F5 读得到总校结论时该按钮照常可用（没锁死正常工作）",
     !!f5 && f5.disabled === false, JSON.stringify(f5));

  /* F6：同一文件里同一形状的第二处 —— 学籍列表的 profiles 也是拿未验证的读取
         结果建 Map，读不到时姓名写「—」，而那一行挂着身份级的不可逆动作。 */
  await open("portal/admin/students/", { tables: Object.assign({}, TABLES, {
    student_records: { data: [{ id:"sr-1", user_id:"u-appl", student_number:"2026001",
      program_code:"bth", status:"pre_enrolled", created_at:"2026-09-01T02:00:00Z" }] },
    profiles: { data: {} } }) }, 3000);
  await cdp.ev(`(()=>{const b=document.querySelector('[data-tab="students"]'); if(b) b.click(); return !!b;})()`);
  await sleep(1200);
  const f6 = await panelVis();
  ok("F6 profiles 是非数组真值时不炸，学籍列表照常渲染",
     /2026001/.test(f6 || ""), (f6 || "（页面没渲染出内容）").slice(0, 240));
  ok("F6b 姓名读不到时说未读到，而不是「—」",
     /未读到/.test(f6 || ""), (f6 || "").slice(0, 240));

  // ════════ H 身份级动作：弹窗里得说清楚是对谁（监督在 02cdeda 上追加）════════
  console.log("\n=== H 不可逆的身份级动作，对象要可辨识 ===");
  /* 我在上一包主张「动作对象是已验证的 s.id，所以不必停用」，监督驳回了 ——
     s.id 是内部标识，用户看不到也认不出。实际去读那三个弹窗：
       正式注册   「确认将**该学生**的学籍状态从「待正式注册」改为「在读」？」
       换发学号   「用于学号确实换发的情形…」
       申请纠正误录「仅适用于纯行政误录：该学号从未真正属于**这名学生**…」
     三个都不含姓名、学号、项目中的任何一个。管理员在表格里点错一行，
     弹窗里没有任何东西能让他发现 —— 而换发学号会把旧号 retired **永久占用**。
     另按监督要求覆盖「学号也为空」：那时姓名和学号都没有，就真的无从辨认。 */
  const STU_ROW = { id:"sr-1", user_id:"u-appl", student_number:"2026001",
    program_code:"bth", status:"pre_enrolled", created_at:"2026-09-01T02:00:00Z" };
  const PROFILE_ROW = { id:"u-appl", display_name:"测试学生", email:"s@example.invalid" };
  const openStudents = async (profiles, row) => {
    await open("portal/admin/students/", { tables: Object.assign({}, TABLES, {
      student_records: { data: [row || STU_ROW] }, profiles }) }, 3000);
    await cdp.ev(`(()=>{const b=document.querySelector('[data-tab="students"]'); if(b) b.click(); return !!b;})()`);
    await sleep(1200);
  };
  const dlgText = async () => cdp.ev(`(()=>{const m=document.querySelector(".portal-modal");
    return m ? (m.textContent||"").replace(/\\s+/g," ").trim() : null;})()`);
  const closeDlg = async () => cdp.ev(`(()=>{document.querySelectorAll(".portal-modal").forEach(m=>m.remove());
    return true;})()`);

  await openStudents({ data: [PROFILE_ROW] });
  await cdp.ev(`(()=>{const b=document.querySelector("[data-activate]"); if(b) b.click(); return !!b;})()`);
  await sleep(600);
  const h1 = await dlgText();
  ok("H1 正式注册的确认弹窗里说得出是谁（姓名）", /测试学生/.test(h1 || ""), (h1 || "（没弹出来）").slice(0, 200));
  ok("H1b 也说得出学号", /2026001/.test(h1 || ""), (h1 || "").slice(0, 200));
  await closeDlg();

  await cdp.ev(`(()=>{const b=document.querySelector("[data-fixnum]"); if(b) b.click(); return !!b;})()`);
  await sleep(600);
  const h2 = await dlgText();
  ok("H2 换发学号的弹窗里说得出对象与现学号",
     /测试学生/.test(h2 || "") && /2026001/.test(h2 || ""), (h2 || "（没弹出来）").slice(0, 240));
  await closeDlg();

  await cdp.ev(`(()=>{const b=document.querySelector("[data-void]"); if(b) b.click(); return !!b;})()`);
  await sleep(600);
  const h3 = await dlgText();
  ok("H3 申请纠正误录的弹窗里说得出对象与误录的那个号",
     /测试学生/.test(h3 || "") && /2026001/.test(h3 || ""), (h3 || "（没弹出来）").slice(0, 240));
  await closeDlg();

  /* H4：姓名读不到、但学号在 —— 学号是稳定且可辨识的，按监督的意见不该一概停用。 */
  await openStudents({ data:null, error:{ message:"boom" }, status:500 });
  const h4btn = await cdp.ev(`(()=>{const b=document.querySelector("[data-activate]");
    return b ? { disabled:!!b.disabled } : null;})()`);
  ok("H4 姓名读不到但学号还在时，动作不被一概停用", !!h4btn && h4btn.disabled === false, JSON.stringify(h4btn));
  await cdp.ev(`(()=>{const b=document.querySelector("[data-activate]"); if(b) b.click(); return !!b;})()`);
  await sleep(600);
  const h4 = await dlgText();
  ok("H4b 弹窗用学号把对象认出来", /2026001/.test(h4 || ""), (h4 || "（没弹出来）").slice(0, 240));
  ok("H4c 并且说明姓名这一次没读到，不装作没这回事",
     /没读到|未读到|未知/.test(h4 || ""), (h4 || "").slice(0, 240));
  await closeDlg();

  /* H5：姓名读不到、学号也是空的 —— 这时候真的无从辨认，不能让他盲着写。 */
  await openStudents({ data:null, error:{ message:"boom" }, status:500 },
    Object.assign({}, STU_ROW, { student_number: null }));
  await installFetch("ok");
  const h5btn = await cdp.ev(`(()=>{const b=document.querySelector("[data-activate]");
    return b ? { disabled:!!b.disabled } : null;})()`);
  ok("H5 姓名和学号都没有时，身份级动作停用", !!h5btn && h5btn.disabled === true, JSON.stringify(h5btn));
  try { await cdp.clickReal("[data-activate]"); } catch (e) {}
  await cdp.ev(`(()=>{const b=document.querySelector(".portal-modal [data-ok], .portal-modal [data-act]");
    if(b) b.click(); return !!b;})()`);
  await sleep(900);
  const h5hits = await fnHits();
  ok("H5b 点它也不会写出去", h5hits === 0, "fnHits=" + h5hits);
  const h5panel = await panelVis();
  ok("H5c 并说明为什么停用（认不出是谁）",
     /认不出|无法确认是谁|没读到/.test(h5panel || ""), (h5panel || "").slice(0, 240));

  // ════════ J 招生队列的时间筛选（PORTAL-blueprint §6）════════
  console.log("\n=== J 队列筛选：状态 / 路径 / 时间 ===");
  /* 蓝图 §6 写的是「队列（筛选：状态/路径/**时间**）」，实际只有状态与路径两个
     下拉和一个搜索框 —— 时间这一项从来没做。招生同工要按提交时间分流时无从下手。
     另外这一列有两种「放不进时间轴」的行：草稿没有 submitted_at；
     服务端给回不能解析的时间。它们不能被时间筛选悄悄吞掉。 */
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
  const mkApp = (id, name, submitted, status) => ({
    id, applicant_id: "u-appl", pathway: "degree", status: status || "submitted",
    submitted_at: submitted, decided_at: null, updated_at: "2026-09-01T02:00:00Z",
    applicant_visible_message: null, locked_fields: [],
    form_data: { name_zh: name, name_en: "X", church_name: "测试教会", programs: ["bth"] },
  });
  const QUEUE = Object.assign({}, TABLES, { applications: { data: [
    mkApp("q-new", "三天前的申请", iso(3)),
    mkApp("q-mid", "二十天前的申请", iso(20)),
    mkApp("q-old", "两百天前的申请", iso(200)),
    mkApp("q-draft", "还没提交的草稿", null, "draft"),
    mkApp("q-bad", "时间读不出来的那份", "not-a-timestamp"),
  ] } });

  const listVis = async () => cdp.ev(`(()=>{const e=document.getElementById("list");
    if(!e) return null; const k=e.cloneNode(true); k.querySelectorAll("[hidden]").forEach(n=>n.remove());
    return (k.textContent||"").replace(/\\s+/g," ").trim();})()`);
  const pickTime = async (v) => cdp.ev(`(()=>{const s=document.getElementById("fTm");
    if(!s) return false; s.value=${JSON.stringify(v)};
    s.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);

  await open("portal/admin/admissions/", { tables: QUEUE }, 3000);
  const j0 = await cdp.ev(`(()=>{const s=document.getElementById("fTm");
    return s ? Array.from(s.options).map(o=>o.value) : null;})()`);
  ok("J0 队列上有「时间」这一项筛选", Array.isArray(j0) && j0.length > 1, JSON.stringify(j0));

  const jAll = await listVis();
  ok("J0b 前提：不筛时间时五份都在", /三天前的申请/.test(jAll || "") && /两百天前的申请/.test(jAll || "") &&
     /还没提交的草稿/.test(jAll || ""), (jAll || "").slice(0, 200));

  const got7 = await pickTime("7");
  await sleep(400);
  const j1 = await listVis();
  ok("J1 选「近 7 天」时，二十天前和两百天前的都不在列表里",
     got7 === true && /三天前的申请/.test(j1 || "") &&
     !/二十天前的申请/.test(j1 || "") && !/两百天前的申请/.test(j1 || ""), (j1 || "").slice(0, 240));

  ok("J2 没有提交时间的草稿不被悄悄吞掉，页面说得出有几份放不进时间轴",
     /放不进|没有提交时间|无法按时间/.test(j1 || ""), (j1 || "").slice(0, 240));
  ok("J2b 时间读不出来的那份也算在里面（2 份：草稿 + 读不出时间的）",
     /2 份|2份/.test(j1 || ""), (j1 || "").slice(0, 240));

  await pickTime("30");
  await sleep(400);
  const j3 = await listVis();
  ok("J3 选「近 30 天」时二十天前那份回来了，两百天前那份仍然不在",
     /二十天前的申请/.test(j3 || "") && !/两百天前的申请/.test(j3 || ""), (j3 || "").slice(0, 240));

  await pickTime("");
  await sleep(400);
  const j4 = await listVis();
  ok("J4 对照：切回「全部时间」五份都回来，且不再提那句话",
     /两百天前的申请/.test(j4 || "") && /还没提交的草稿/.test(j4 || "") &&
     !/放不进/.test(j4 || ""), (j4 || "").slice(0, 240));

  // ════════ K 时间筛选的上界与未来时间（返修 b213fbc）════════
  console.log("\n=== K 时间范围要有上界，未来时间单独说 ===");
  /* b213fbc 只比了 `t < since` 就排除，**没有上界** —— 一份提交时间在将来的申请
     （服务端时钟偏了、或数据被改过）会被算进「近 7 天」，看上去像刚刚交的。
     这里把 Date.now 冻死在一个固定时刻，才好验边界：等于下界、等于此刻、
     差 1 秒出界、以及未来。 */
  const NOW = Date.UTC(2026, 8, 13, 6, 0, 0);          // 2026-09-13T06:00:00Z
  const at = (ms) => new Date(ms).toISOString();
  const K_TABLES = Object.assign({}, TABLES, { applications: { data: [
    mkApp("k-now",    "此刻提交的",        at(NOW)),
    mkApp("k-edge",   "正好第七天的",      at(NOW - 7 * 864e5)),
    mkApp("k-out",    "差一秒出界的",      at(NOW - 7 * 864e5 - 1000)),
    mkApp("k-future", "提交时间在将来的",  at(NOW + 3 * 864e5)),
    mkApp("k-draft",  "还没提交的草稿",    null, "draft"),
    mkApp("k-bad",    "时间读不出来的",    "not-a-timestamp"),
  ] } });

  /* 冻结 Date.now 是**测试这一侧**的事，产品代码里不留任何测试钩子。 */
  const frozen = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(function(){ var F = ${NOW}; Date.now = function(){ return F; }; })();`,
  });
  await open("portal/admin/admissions/", { tables: K_TABLES }, 3000);

  const k0 = await cdp.ev(`(()=>{const s=document.getElementById("fTm");
    if(!s) return null; const lab=s.getAttribute("aria-label") ||
      (s.labels && s.labels[0] && s.labels[0].textContent) || "";
    return { name: String(lab).trim() };})()`);
  ok("K0 时间筛选有可访问的名称（aria-label 或 label）",
     !!k0 && k0.name.length > 0, JSON.stringify(k0));

  await pickTime("7");
  await sleep(400);
  const k1 = await listVis();
  ok("K1 下界与上界都含等于：此刻提交的、正好第七天的都在",
     /此刻提交的/.test(k1 || "") && /正好第七天的/.test(k1 || ""), (k1 || "").slice(0, 260));
  ok("K1b 差一秒出界的不在", !/差一秒出界的/.test(k1 || ""), (k1 || "").slice(0, 260));
  ok("K2 提交时间在**将来**的不算作最近提交",
     !/提交时间在将来的/.test(k1 || ""), (k1 || "").slice(0, 260));
  /* 不能用 /将来/ —— 那会命中行名「提交时间在将来的」，是空转绿。
     要的是页面自己那句话。 */
  ok("K3 未来时间单独说明，不和「放不进时间轴」混在一起",
     /比现在还晚/.test(k1 || "") && /放不进/.test(k1 || ""), (k1 || "").slice(0, 300));
  ok("K3b 两边各自计数（放不进 2 份：草稿 + 读不出；将来 1 份）",
     /2 份[^0-9]{0,30}放不进|放不进[^0-9]{0,30}2 份/.test(k1 || "") &&
     /1 份/.test(k1 || ""), (k1 || "").slice(0, 300));

  await pickTime("");
  await sleep(400);
  const k4 = await listVis();
  ok("K4 对照：切回「全部时间」六份都回来，且不再提那两句",
     /差一秒出界的/.test(k4 || "") && /提交时间在将来的/.test(k4 || "") &&
     !/放不进/.test(k4 || "") && !/不算作最近/.test(k4 || ""), (k4 || "").slice(0, 300));

  await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: frozen.identifier });

  // ════════ L 审核人指派（G1，客户端一侧）════════
  console.log("\n=== L 指派审核人 ===");
  /* ⚠ 边界先说清楚：0027 的 assign_application_reviewer 与 review-application 的
     op="assign" 分支**在本轮没有被执行过**（没有 apply、没有 deploy、没有真实库）。
     下面所有断言验的都是**客户端**在给定返回值时的行为；stub 的回应不是 RPC 执行通过。
     服务端行为一律 NOT_RUN。 */
  const AS_ROLES = { data: [
    { user_id: "u-ok1",   role: "registrar",      revoked_at: null, expires_at: null },
    { user_id: "u-ok2",   role: "academic_admin", revoked_at: null,
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString() },
    { user_id: "u-revd",  role: "registrar",      revoked_at: "2026-09-01T00:00:00Z", expires_at: null },
    { user_id: "u-exp",   role: "registrar",      revoked_at: null,
      expires_at: new Date(Date.now() - 864e5).toISOString() },
    { user_id: "u-baddt", role: "registrar",      revoked_at: null, expires_at: "not-a-timestamp" },
  ] };
  const AS_PROFILES = { data: [
    { id: "u-ok1", display_name: "甲教务", email: "a@example.invalid" },
    { id: "u-ok2", display_name: "乙教务", email: "b@example.invalid" },
    { id: "u-revd", display_name: "丙已撤销", email: "c@example.invalid" },
    { id: "u-exp", display_name: "丁已过期", email: "d@example.invalid" },
    { id: "u-baddt", display_name: "戊有效期读不出", email: "e@example.invalid" },
  ] };
  const asApp = (status, assigned) => Object.assign({}, APP, { status,
    assigned_reviewer: assigned === undefined ? null : assigned });
  const asTables = (app, extra) => Object.assign({}, TABLES, {
    applications: { data: [app] }, user_roles: AS_ROLES, profiles: AS_PROFILES }, extra || {});

  /** 让 /functions/v1/ 回一个指定的 JSON body（指派分支要验的是业务性拒绝） */
  const fnBody = async (obj, status) => cdp.ev(`(()=>{
    window.__fnHits = 0; window.__fnBodies = [];
    const orig = window.fetch;
    window.fetch = function(u){
      if (String(u).indexOf("/functions/v1/") < 0) return orig.apply(this, arguments);
      window.__fnHits++;
      try { window.__fnBodies.push(JSON.parse((arguments[1] && arguments[1].body) || "{}")); } catch(e){}
      return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(obj))}, { status:${status || 200},
        headers:{ "Content-Type":"application/json" } }));
    };
    return true;})()`);
  const lastBody = async () => cdp.ev(`(window.__fnBodies||[]).slice(-1)[0] || null`);
  const drawerNow = async () => vis("#detail");
  const saveAssignAs = async (value) => {
    await cdp.ev(`(()=>{const s=document.getElementById("asSel"); if(!s) return false;
      s.value=${JSON.stringify(value)}; return true;})()`);
    await cdp.ev(`(()=>{const b=document.getElementById("asSave"); if(b) b.click(); return !!b;})()`);
    await sleep(400);
    await cdp.ev(`(()=>{const b=document.querySelector(".portal-modal [data-ok]"); if(b) b.click(); return !!b;})()`);
    await sleep(900);
  };

  await open("portal/admin/admissions/", { tables: asTables(asApp("submitted")) }, 3000);
  await openDetail();
  const l0 = await cdp.ev(`(()=>{const s=document.getElementById("asSel");
    return s ? Array.from(s.options).map(o=>({v:o.value,t:(o.textContent||"").trim()})) : null;})()`);
  ok("L0 抽屉里有审核人下拉", Array.isArray(l0) && l0.length > 1, JSON.stringify(l0));

  const vals = (l0 || []).map(o => o.v);
  ok("L1 已撤销的角色不在候选名单里", !vals.includes("u-revd"), JSON.stringify(vals));
  ok("L1b 已过期的角色也不在", !vals.includes("u-exp"), JSON.stringify(vals));
  ok("L1c 有效的两位在", vals.includes("u-ok1") && vals.includes("u-ok2"), JSON.stringify(vals));
  ok("L1d 有效期读不出来的那位不列出（未知不当作有效）", !vals.includes("u-baddt"), JSON.stringify(vals));
  const l1 = await drawerNow();
  ok("L1e 但明说有几位因为有效期读不出来没被列出，不是悄悄少一个",
     /读不出来/.test(l1 || "") && /1 位|1位/.test(l1 || ""), (l1 || "").slice(0, 260));

  ok("L2-0 前提：文案写明指派只记录分工",
     /只记录分工/.test(l1 || "") && /不改变谁能审/.test(l1 || ""), (l1 || "").slice(0, 200));

  // ── 保存时必须显式带上 expected_reviewer
  await fnBody({ ok: true, assigned_reviewer: "u-ok1", changed: true });
  await saveAssignAs("u-ok1");
  const b1 = await lastBody();
  ok("L5 请求里 op=assign，且**显式**带了 expected_reviewer（未指派时是 null）",
     !!b1 && b1.op === "assign" && b1.reviewer_id === "u-ok1" &&
     Object.prototype.hasOwnProperty.call(b1, "expected_reviewer") && b1.expected_reviewer === null,
     JSON.stringify(b1));
  ok("L5b 没有夹带 action（两条分支互斥）",
     !!b1 && !Object.prototype.hasOwnProperty.call(b1, "action"), JSON.stringify(b1));

  // ── 终态：没有下拉，明确解释
  await open("portal/admin/admissions/", { tables: asTables(asApp("accepted", "u-ok1")) }, 3000);
  await openDetail();
  const l2 = await drawerNow();
  ok("L2 终态申请不提供指派控件",
     (await cdp.ev(`!document.getElementById("asSel")`)) === true, (l2 || "").slice(0, 200));
  ok("L2b 并当场解释为什么不能改",
     /终态/.test(l2 || "") && /不能再新指派|不能再/.test(l2 || ""), (l2 || "").slice(0, 260));

  // ── 候选人读不到：不摆空下拉
  await open("portal/admin/admissions/", { tables: Object.assign({}, asTables(asApp("submitted")), {
    user_roles: { data: null, error: { message: "boom" }, status: 500 } }) }, 3000);
  await openDetail();
  const l4 = await drawerNow();
  ok("L4 候选人读不到时不摆一个空下拉",
     (await cdp.ev(`!document.getElementById("asSel")`)) === true, (l4 || "").slice(0, 200));
  ok("L4b 而是明说未知，且不当成「没有人可指派」",
     /没能读到/.test(l4 || "") && /不表示没有/.test(l4 || ""), (l4 || "").slice(0, 260));

  // ── 并发：expected 与库里不符
  await open("portal/admin/admissions/", { tables: asTables(asApp("submitted")) }, 3000);
  await openDetail();
  await fnBody({ ok: false, error: "reassigned", current: "u-ok2" });
  await saveAssignAs("u-ok1");
  const l6 = await vis("#dErr");
  ok("L6 服务端说刚被别人改过时，不盲覆盖并说清楚现在是谁",
     /刚被别人改过/.test(l6 || "") && /乙教务/.test(l6 || ""), JSON.stringify(l6));
  ok("L6b 并且没有自动重发", (await fnHits()) === 1, "fnHits=" + (await fnHits()));

  // ── 结果不明：锁住这一条，再点也不再发
  await open("portal/admin/admissions/", { tables: asTables(asApp("submitted")) }, 3000);
  await openDetail();
  await fnBody({}, 500);
  await saveAssignAs("u-ok1");
  const hits1 = await fnHits();
  const l7 = await vis("#dErr");
  ok("L7 结果不明时如实说无法确认", /无法确认|没能确认/.test(l7 || ""), JSON.stringify(l7));
  await cdp.ev(`(()=>{const b=document.getElementById("asSave"); if(b) b.click(); return !!b;})()`);
  await sleep(700);
  ok("L7b 再点一次不会再发出去（这一条已锁）", (await fnHits()) === hits1, "第一次=" + hits1 + " 现在=" + (await fnHits()));

  // ── 服务端说「这个状态不能指派」（0027 行锁后判 draft 与终态，同一个 not_assignable）
  await open("portal/admin/admissions/", { tables: asTables(asApp("submitted")) }, 3000);
  await openDetail();
  await fnBody({ ok: false, error: "not_assignable", status: "draft" });
  await saveAssignAs("u-ok1");
  const l8 = await vis("#dErr");
  ok("L8 服务端说草稿不可指派时，按它带回的状态说清楚原因",
     /还没有提交/.test(l8 || ""), JSON.stringify(l8));

  await open("portal/admin/admissions/", { tables: asTables(asApp("submitted")) }, 3000);
  await openDetail();
  await fnBody({ ok: false, error: "not_assignable", status: "accepted" });
  await saveAssignAs("u-ok1");
  const l9 = await vis("#dErr");
  ok("L9 终态同理，且说出是哪个状态",
     /已录取/.test(l9 || "") && /不能再/.test(l9 || ""), JSON.stringify(l9));

  console.log("  NOT_RUN  0027 的 assign_application_reviewer 与 Edge 的 op=assign 分支：");
  console.log("           本轮没有 apply、没有 deploy、没有对任何真实数据库执行 —— 上面验的全是客户端行为。");

  // ════════ Pg 队列取数触到上限时，不能把「只读到这些」说成「就这些」════════
  console.log("\n=== M 截断不能冒充全部 ===");
  /* 队列是 limit: 300 的一次性取数，之后所有筛选都在这 300 份之上做。
     申请总数一过 300，更早的那些根本没进浏览器 —— 而页面从头到尾没说过这是个上限。
     筛「待审核」说「没有符合条件的申请」、搜姓名搜不到、「全部时间」其实是「最新 300 份」。
     这是同一条纪律的又一个形态，而且是在做录取/拒绝决定的台子上。 */
  const manyApps = (n, offset) => Array.from({ length: n }, (_, i) => Object.assign({}, APP, {
    id: "app-bulk-" + (offset + i),
    submitted_at: new Date(Date.now() - (offset + i) * 3600e3).toISOString(),
    form_data: { name_zh: "申请人" + (offset + i), name_en: "X", church_name: "教会", programs: ["bth"] },
  }));

  // M1/M2/M3：正好取满一页
  await open("portal/admin/admissions/", { tables: Object.assign({}, TABLES, {
    applications: { data: manyApps(300, 0) } }) }, 3200);
  const m1 = await listVis();
  ok("Pg1 份数触到上限时明说可能还有更早的没读到",
     /还有更早|没有全部读到|只读到/.test(m1 || ""), (m1 || "").slice(0, 220));
  ok("Pg3 给得出一个能用的「载入更早的」入口",
     (await cdp.ev(`(()=>{const b=document.getElementById("btnMore");
       return !!b && !b.disabled;})()`)) === true);

  await cdp.ev(`(()=>{const s=document.getElementById("fSt"); s.value="withdrawn";
    s.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);
  await sleep(400);
  const m2 = await listVis();
  /* 要的不是「不许出现这几个字」，而是**那句断言必须带上限定**：
     「在已读到的 N 份里没有…」可以，光秃秃的「没有符合条件的申请 / 调整筛选条件后再试」不行。 */
  ok("Pg2 截断时的空态必须带上「在已读到的 N 份里」这个限定",
     /在已读到的 \d+ 份里没有符合条件的申请/.test(m2 || ""), (m2 || "").slice(0, 220));
  ok("Pg2b 并且不再出现那句无限定的旧文案",
     !/没有符合条件的申请 调整筛选条件后再试/.test(m2 || ""), (m2 || "").slice(0, 220));
  ok("Pg2c 同时给出出路（先载入更早的，或缩小筛选）",
     /先载入更早的/.test(m2 || ""), (m2 || "").slice(0, 220));

  /* Pg4/Pg5：stub 现在**真的按 range 切片**，所以直接用 340 份的真实分页来验，
     不再靠中途换 fixture 那种把戏 —— 那种写法在 range 生效之后本来就不成立了。 */
  await open("portal/admin/admissions/", { tables: Object.assign({}, TABLES, {
    applications: { data: manyApps(340, 0) } }) }, 3200);
  const p1ids = await cdp.ev(`(()=>Array.from(document.querySelectorAll("[data-open]")).map(b=>b.dataset.open))()`);
  ok("Pg4-0 前提：第一页只有 300 份", (p1ids || []).length === 300, String((p1ids || []).length));
  await cdp.ev(`(()=>{const b=document.getElementById("btnMore"); if(b) b.click(); return !!b;})()`);
  await sleep(1200);
  const m4 = await cdp.ev(`(()=>{const ids=Array.from(document.querySelectorAll("[data-open]")).map(b=>b.dataset.open);
    return { rows: ids.length, uniq: new Set(ids).size,
             has0: ids.includes("app-bulk-0"), has339: ids.includes("app-bulk-339") };})()`);
  ok("Pg4 更早的那一批确实进来了，原来的也还在",
     !!m4 && m4.rows === 340 && m4.has0 === true && m4.has339 === true, JSON.stringify(m4));
  ok("Pg4b 没有重复行", !!m4 && m4.rows === m4.uniq, JSON.stringify(m4));

  const m5 = await listVis();
  /* 文案已按 Od 段的完整性口径改过：不再无条件说「已经是全部」。
     这里验的仍是那个不变量 —— 取不满就收起载入入口，并说明没有更多了。 */
  ok("Pg5 一页没取满就收起载入入口，并说明到这一次为止没有更多了",
     /到这一次为止/.test(m5 || "") && /没有更多了/.test(m5 || "") &&
     (await cdp.ev(`!document.getElementById("btnMore")`)) === true, (m5 || "").slice(0, 220));

  // M6 对照：没到上限时一句截断提示都不该有
  await open("portal/admin/admissions/", { tables: Object.assign({}, TABLES, {
    applications: { data: manyApps(5, 0) } }) }, 3000);
  const m6 = await listVis();
  ok("Pg6 对照：总数没到上限时不出现任何截断提示",
     !/还有更早|已读到|已经是全部/.test(m6 || "") &&
     (await cdp.ev(`!document.getElementById("btnMore")`)) === true, (m6 || "").slice(0, 220));

  // ════════ Pc 分页的并发/重绘/刷新（返修 bdb0e6e）════════
  console.log("\n=== Pc 分页必须单飞且有世代 ===");
  /* 监督的复现：loadPage 既没有请求互斥也没有世代。
     两次并发同页请求 ranges=[0..299, 0..299] 都回 300，去重后 rows 仍是 300，
     但 pagesLoaded 被各推进一次变成 2 —— 下一次直接要 600..899，**漏掉 300..599**。
     真实入口不是「手速快」：旧 btnMore 只禁用了自己，任何一次筛选重绘都会
     重建一个可用的新按钮，点它就并发了。
     所以这一段用**真实的 range 记录**来断言有没有跳页，而不是换 fixture 蒙混。 */
  const ranges = async () => (await cdp.ev(`(window.__ranges||[]).filter(x=>x.indexOf("applications:")===0)`)) || [];
  const resetRanges = async () => cdp.ev(`(()=>{window.__ranges=[]; window.__failed_={}; return true;})()`);
  const clickMore = async () => cdp.ev(`(()=>{const b=document.getElementById("btnMore");
    if(!b || b.disabled) return "disabled-or-missing"; b.click(); return "clicked";})()`);
  const bulk = (n) => Array.from({ length: n }, (_, i) => Object.assign({}, APP, {
    id: "app-p-" + i, submitted_at: new Date(Date.now() - i * 3600e3).toISOString(),
    form_data: { name_zh: "申请人" + i, name_en: "X", church_name: "教会", programs: ["bth"] } }));
  const BIG = { tables: Object.assign({}, TABLES, { applications: { data: bulk(1000) } }) };

  // ── C1 在途时重复点：只允许一个分页请求，偏移只被接受的那一次推进
  await open("portal/admin/admissions/",
    Object.assign({}, BIG, { rangeDelay: { "300..599": 900 } }), 3200);
  await resetRanges();
  await clickMore();                       // 触发 300..599（慢）
  await sleep(120);
  const mid = await cdp.ev(`(()=>{const b=document.getElementById("btnMore");
    return b ? { present:true, disabled:!!b.disabled, text:(b.textContent||"").trim() } : { present:false };})()`);
  ok("Pc1 在途时按钮是禁用的", mid.present === true && mid.disabled === true, JSON.stringify(mid));
  const second = await clickMore();
  ok("Pc1b 在途时再点点不动（不产生第二个请求）", second === "disabled-or-missing", String(second));
  await sleep(1400);
  const pr1 = await ranges();
  /* 计数从 resetRanges() 之后算起 —— 首页那次请求在它之前就发完了。 */
  ok("Pc1c 在途重复点之后，实际只发出了一次 300..599（没有重复、没有跳页）",
     JSON.stringify(pr1) === JSON.stringify(["applications:300..599"]), JSON.stringify(pr1));

  // ── C2 在途时改筛选触发重绘：重建出来的按钮也必须是禁用的
  await open("portal/admin/admissions/",
    Object.assign({}, BIG, { rangeDelay: { "300..599": 1200 } }), 3200);
  await resetRanges();
  await clickMore();
  await sleep(150);
  await cdp.ev(`(()=>{const s=document.getElementById("fPw"); s.value="bth";
    s.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);
  await sleep(200);
  const rebuilt = await cdp.ev(`(()=>{const b=document.getElementById("btnMore");
    return b ? { present:true, disabled:!!b.disabled } : { present:false };})()`);
  ok("Pc2 筛选重绘后新建的按钮**仍然**是禁用的（单飞状态贯穿重绘）",
     rebuilt.present === true && rebuilt.disabled === true, JSON.stringify(rebuilt));
  const again = await clickMore();
  await sleep(1600);
  const pr2 = await ranges();
  ok("Pc2b 重绘后再点也没有多发请求，更没有跳页",
     again === "disabled-or-missing" &&
     JSON.stringify(pr2) === JSON.stringify(["applications:300..599"]),
     again + " / " + JSON.stringify(pr2));

  // ── C3 第二页失败后重试：必须请求**同一个** range，不能跳过去
  await open("portal/admin/admissions/",
    Object.assign({}, BIG, { failRangeOnce: "300..599" }), 3200);
  await resetRanges();
  await clickMore();
  await sleep(900);
  const failTxt = await listVis();
  ok("Pc3 第二页失败时明说更早的那一页没读到、上面这些不代表全部",
     /没能读到/.test(failTxt || "") && /不代表全部/.test(failTxt || ""), (failTxt || "").slice(0, 200));
  await clickMore();
  await sleep(900);
  const pr3 = await ranges();
  ok("Pc3b 重试请求的仍是 300..599（失败没有推进偏移）",
     JSON.stringify(pr3) === JSON.stringify(
       ["applications:300..599", "applications:300..599"]), JSON.stringify(pr3));
  const okTxt = await listVis();
  ok("Pc3c 重试成功后那条失败提示消失", !/不代表全部/.test(okTxt || ""), (okTxt || "").slice(0, 160));

  // ── C4 刷新之后旧页晚回：不许污染新列表，也不许推进新世代的偏移
  await open("portal/admin/admissions/",
    Object.assign({}, BIG, { rangeDelay: { "300..599": 1500 } }), 3200);
  await resetRanges();
  await clickMore();                        // 慢请求在途
  await sleep(150);
  await cdp.ev(`(()=>{const b=document.getElementById("fReload"); if(b) b.click(); return !!b;})()`);
  await sleep(2200);                        // 等旧响应晚回
  const pr4 = await ranges();
  const st4 = await cdp.ev(`(()=>{const ids=Array.from(document.querySelectorAll("[data-open]")).map(b=>b.dataset.open);
    return { rows: ids.length, uniq: new Set(ids).size };})()`);
  ok("Pc4 刷新后旧页晚回不造成重复行", st4.rows === st4.uniq, JSON.stringify(st4));
  await clickMore();
  await sleep(2200);
  const pr5 = await ranges();
  const after = pr5.slice(pr4.length);
  ok("Pc4b 刷新之后再点，要的仍是 300..599（旧响应没有推进偏移）",
     after.length === 1 && after[0] === "applications:300..599", JSON.stringify({ pr4, pr5 }));

  // ── C5 对照：正常一步步点，页码照常前进
  await open("portal/admin/admissions/", BIG, 3200);
  await resetRanges();
  await clickMore(); await sleep(600);
  await clickMore(); await sleep(600);
  const pr6 = await ranges();
  ok("Pc5 对照：顺序点两次，range 依次前进（不是一律拒绝）",
     JSON.stringify(pr6) === JSON.stringify(
       ["applications:300..599", "applications:600..899"]), JSON.stringify(pr6));

  // ════════ Od 分页的完整性：唯一稳定次序 + 不再无条件说「已经是全部」════════
  console.log("\n=== Od 排序键要唯一稳定 ===");
  /* 只按 submitted_at 排时，同一秒提交的、以及草稿（submitted_at 为 null）的那些行
     彼此并列，而数据库对并列行先后不作承诺 —— offset 分页在页边界会重复**和漏**。
     重复被 id 去重盖住，漏掉的那一份没有人会发现。
     算法层面的反例在 scripts/test-paging-model.mjs（纯模型）；
     这里验的是**页面实际发出的查询参数**对不对。 */
  await open("portal/admin/admissions/", { tables: Object.assign({}, TABLES, {
    applications: { data: manyApps(340, 0) } }) }, 3200);
  const ord = await cdp.ev(`((window.__orders||{}).applications)||null`);
  ok("Od1 队列查询带了两个排序键，第二个是 id（唯一且稳定）",
     Array.isArray(ord) && ord.length === 2 && ord[0] === "submitted_at:desc" && ord[1] === "id:desc",
     JSON.stringify(ord));

  await cdp.ev(`(()=>{const b=document.getElementById("btnMore"); if(b) b.click(); return !!b;})()`);
  await sleep(1200);
  const done = await listVis();
  ok("Od2 读完之后不再无条件断言「已经是全部」",
     !/已经是全部/.test(done || ""), (done || "").slice(0, 240));
  ok("Od2b 而是说清楚这是「到这一次为止」，并讲明分页期间增删会有出入",
     /到这一次为止/.test(done || "") && /提交或撤回/.test(done || "") && /刷新/.test(done || ""),
     (done || "").slice(0, 300));

  const ord2 = await cdp.ev(`((window.__orders||{}).applications)||null`);
  ok("Od3 第二页用的是同一套排序键（页与页之间次序一致）",
     JSON.stringify(ord2) === JSON.stringify(ord), JSON.stringify(ord2));

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
console.log("  绿灯只证明「给定这些返回值时两个管理页没有谎报结果」，不证明真实审核/学籍流程已验收。");
process.exit(fail ? 1 : 0);
