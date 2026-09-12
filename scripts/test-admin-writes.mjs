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
window.supabase = {
  createClient: function(){
    var S = function(){ return window.__SCEN || {}; };
    var reply = function(v){ return Promise.resolve(v); };
    function table(name){
      var q = { select:function(){return q;}, eq:function(){return q;}, in:function(){return q;},
        order:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
        then:function(res, rej){
          var t = (S().tables && S().tables[name]) || { data: [], error: null };
          return Promise.resolve({ data:t.data, error:t.error||null, status:t.error?500:200 }).then(res, rej);
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
