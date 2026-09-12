// 申请人自己的写入路径：创建草稿 / 自动保存 / 标记补件 / 提交申请。
//
// ── 要证明的 ──────────────────────────────────────────────────────────
// 这四条都是写入，其中「提交」是状态变更且写审核历史，「创建」会产生一份
// 新申请。本仓已经反复确立的判据是：**结果不明不能当成确定**。
//   · 结果不明（连响应都没拿到 / 5xx / 没有可读结论）→ 请求可能已经生效，
//     不能说「失败了，请重试」，更不能把按钮放开让人再来一次；
//   · 明确拒绝（服务端给了错误码）→ 确定没执行，如实说并允许重来；
//   · 重复提交 → 在途期间挡住；
//   · 恢复入口 → 结果不明时要有「刷新核实」这条出路，而不是只留一句话。
//
// ── 修前已知的两处 ────────────────────────────────────────────────────
//   submit()    Api.rpc 返回 {data:null,error:null} 时 `!data.ok` 直接抛
//               TypeError；而且 btn.disabled=false 在判断结果**之前**执行，
//               结果不明时按钮已经放开，页面还显示「请稍后重试」。
//   createDraft() 结果不明时只 toast 一句，创建入口原样留着 —— 再点一次
//               就可能产生第二份申请。
//
// 本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。
// 独占动态端口（DevToolsActivePort）。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-applw-"));
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

/** 表驱动 stub。写入结果由 __SCEN.writes[table] 决定，RPC 由 __SCEN.rpc[name] 决定；
    两者都可以给 status，让 Api.normalize 归一成确定的错误码。 */
const STUB = `
window.supabase = {
  createClient: function(){
    var S = function(){ return window.__SCEN || {}; };
    var reply = function(v){ return Promise.resolve(v); };
    var bump = function(k){ try { var o=JSON.parse(sessionStorage.getItem("wCalls")||"{}");
      o[k]=(o[k]||0)+1; sessionStorage.setItem("wCalls", JSON.stringify(o)); } catch(e){} };
    function table(name){
      var mode = "select";
      var q = {
        select:function(){ return q; },
        eq:function(k, v){
          if (mode === "update") {
            try { var m = JSON.parse(sessionStorage.getItem("lastMatch") || "{}");
                  m[k] = v; sessionStorage.setItem("lastMatch", JSON.stringify(m)); } catch (e) {}
          }
          return q;
        },
        in:function(){ return q; },
        match:function(){ return q; }, order:function(){ return q; }, limit:function(){ return q; },
        maybeSingle:function(){ return q; }, single:function(){ return q; },
        insert:function(){ mode = "insert"; bump("insert:" + name); return q; },
        update:function(){ mode = "update"; bump("update:" + name); return q; },
        /* 记下每次 update 用的匹配条件 —— 乐观并发要证的就是
           「保存时到底带没带 updated_at」。 */
        then:function(res, rej){
          var sc = S();
          var t = (mode === "select")
            ? ((sc.tables && sc.tables[name]) || { data: [], error: null })
            : ((sc.writes && sc.writes[name]) || { data: [{ id: "app-fixture-1", updated_at: "2026-09-11T00:00:00Z" }], error: null });
          var out = { data:t.data, error:t.error||null,
            status: t.status != null ? t.status : (t.error ? 500 : 200) };
          var d = t.delay || 0;
          return (d ? new Promise(function(r){ setTimeout(function(){ r(out); }, d); })
                    : Promise.resolve(out)).then(res, rej);
        }
      };
      return q;
    }
    return {
      auth: {
        getSession: function(){ return reply({ data:{ session:{ user:{id:"u-appl"}, access_token:"fixture-token" } }, error:null }); },
        mfa: { getAuthenticatorAssuranceLevel: function(){
          return reply({ data:{ currentLevel:"aal1", nextLevel:"aal1" }, error:null }); } },
        onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
        signOut: function(){ return reply({}); }
      },
      from: table,
      rpc: function(name, args){
        bump("rpc:" + name);
        if (name === "my_roles" && !(S().rpc||{}).my_roles)
          return reply({ data:[{ role:"applicant" }], error:null, status:200 });
        if (name === "my_profile" && !(S().rpc||{}).my_profile)
          return reply({ data:{ display_name:"测试申请人", email:"a@example.invalid" }, error:null, status:200 });
        var r = (S().rpc && S().rpc[name]) || { data:null, error:null };
        if (typeof r === "string") r = { data:null, error:null };
        return reply({ data:r.data, error:r.error||null,
          status: r.status != null ? r.status : (r.error ? 500 : 200) });
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

  /* 表单一变脏，UI.formGuard 会挂 beforeunload —— 这是正确的产品行为，
     但它会把 Page.navigate 卡住等用户确认。量具要接住这个对话框，
     否则套件自己超时退出，看起来像是产品挂了。 */
  cdp.on("Page.javascriptDialogOpening", async () => {
    try { await cdp.send("Page.handleJavaScriptDialog", { accept: true }); } catch (e) {}
  });

  let pageErrors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    pageErrors.push(String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || ""));
  });

  const DRAFT = { id:"app-fixture-1", applicant_id:"u-appl", pathway:"undecided", status:"draft",
    locked_fields:[], form_data:{ name_zh:"测试申请人" }, submitted_at:null, updated_at:"2026-09-10T00:00:00Z" };
  const BASE_TABLES = {
    program_catalog: { data: [{ code:"bth", name_zh:"神学本科", short_label:"B.Th" }] },
    application_requirements: { data: [] },
  };
  const open = async (scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(scen) + ";" });
    await cdp.ev(`(()=>{try{["wCalls","lastMatch"].forEach(k=>sessionStorage.removeItem(k));}catch(e){} return true;})()`).catch(()=>{});
    pageErrors = [];
    await cdp.send("Page.navigate", { url: `${BASE}/portal/applicant/application/` });
    await sleep(wait || 2800);
  };
  const calls = async () => (await cdp.ev(`(()=>{try{return JSON.parse(sessionStorage.getItem("wCalls")||"{}");}catch(e){return{};}})()`)) || {};
  const vis = async (sel) => cdp.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
    if(!e) return null; const k=e.cloneNode(true); k.querySelectorAll("[hidden]").forEach(n=>n.remove());
    return (k.textContent||"").replace(/\\s+/g," ").trim();})()`);
  const toastNow = async () => cdp.ev(`(()=>{const t=document.getElementById("amas-toast");
    return t ? { text:(t.textContent||"").trim(), shown:t.classList.contains("show") } : null;})()`);

  // ════════ C 创建草稿 ════════
  console.log("\n=== C 创建草稿 ===");
  const withApp = { tables: BASE_TABLES, rpc: { my_application: { data: [DRAFT] } } };
  const noApp = { tables: BASE_TABLES, rpc: { my_application: { data: [] } } };

  await open(noApp);
  ok("C0 前提：没有申请时显示创建入口",
     (await cdp.ev(`!!document.querySelector('[data-act="new"]')`)) === true, await vis("#main"));

  // C1 结果不明：insert 没有可读结论
  await open({ ...noApp, writes: { applications: { data:null, error:{ message:"Failed to fetch" }, status:0 } } });
  await cdp.clickReal('[data-act="new"]');
  await sleep(1400);
  const c1 = await cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template,[hidden]").forEach(n=>n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();})()`);
  ok("C1 结果不明时明说无法确认是否已创建，不说成「失败请重试」",
     /无法确认|没能确认/.test(c1), c1.slice(0, 200));
  ok("C1b 并且不再摆着一个点一下就可能建出第二份申请的按钮",
     (await cdp.ev(`(()=>{const b=document.querySelector('[data-act="new"]'); return !b || !!b.disabled;})()`)) === true);
  ok("C1c 给出刷新核实的出路", /刷新|核实/.test(c1), c1.slice(0, 200));

  // C2 明确拒绝：服务端说已存在
  await open({ ...noApp, writes: { applications: { data:null,
    error:{ message:"duplicate key value violates unique constraint" }, status:409 } } });
  await cdp.clickReal('[data-act="new"]');
  await sleep(1200);
  const c2 = await toastNow();
  ok("C2 明确拒绝时如实说已存在（既有文案没被改坏）",
     /已存在/.test((c2 && c2.text) || ""), JSON.stringify(c2));

  // ════════ S 提交申请 ════════
  console.log("\n=== S 提交申请 ===");
  const subErr = async () => vis("#subErr");
  const clickSubmit = async () => { await cdp.clickReal("#btnSubmit"); await sleep(1400); };

  // S1 RPC 返回空（200 但没有可读结论）
  await open({ ...withApp, rpc: { my_application:{ data:[DRAFT] }, submit_application:{ data:null, error:null, status:200 } } });
  ok("S0 前提：草稿页有提交按钮", (await cdp.ev(`!!document.getElementById("btnSubmit")`)) === true);
  await clickSubmit();
  ok("S1 RPC 没给可读结论时不抛异常（原来 `!data.ok` 直接 TypeError）",
     !pageErrors.some(e => /TypeError/.test(e)), JSON.stringify(pageErrors.slice(0,2)));
  ok("S1b 而是如实说无法确认是否已提交", /无法确认|没能确认/.test((await subErr()) || ""), JSON.stringify(await subErr()));

  // S2 结果不明（网络）
  await open({ ...withApp, rpc: { my_application:{ data:[DRAFT] },
    submit_application:{ data:null, error:{ message:"Failed to fetch" }, status:0 } } });
  await clickSubmit();
  const s2 = await subErr();
  ok("S2 结果不明时明说无法确认是否已提交，不说成「请稍后重试」",
     /无法确认|没能确认/.test(s2 || ""), JSON.stringify(s2));
  ok("S2b 并且不把提交按钮放开让人再提交一次",
     (await cdp.ev(`(()=>{const b=document.getElementById("btnSubmit"); return !b || !!b.disabled;})()`)) === true);
  ok("S2c 给出刷新核实的出路", /刷新|核实/.test(s2 || ""), JSON.stringify(s2));

  // S3 明确拒绝：缺必填项
  await open({ ...withApp, rpc: { my_application:{ data:[DRAFT] },
    submit_application:{ data:{ ok:false, error:"validation_failed", missing:["name_en"] }, error:null, status:200 } } });
  await clickSubmit();
  const s3 = await subErr();
  ok("S3 明确拒绝时保留逐项提示（既有行为没被改坏）", /请完成以下必填项/.test(s3 || ""), JSON.stringify(s3));
  ok("S3b 明确拒绝后按钮可以再用",
     (await cdp.ev(`(()=>{const b=document.getElementById("btnSubmit"); return !!b && !b.disabled;})()`)) === true);

  // S4 真成功
  await open({ ...withApp, rpc: { my_application:{ data:[DRAFT] },
    submit_application:{ data:{ ok:true }, error:null, status:200 } } });
  await clickSubmit();
  const s4 = await toastNow();
  ok("S4 真成功时照常报「申请已提交」（没改坏）", /申请已提交/.test((s4 && s4.text) || ""), JSON.stringify(s4));

  // S5 在途连点只发一次
  /* 两次**真实点击**，中间隔 400ms —— 落在 submit() 先做的那次自动保存
     （一次网络往返，这里构造成 1200ms）还没回来的窗口里。
     原代码的 btn.disabled 是在 `await save()` 之后才设的，所以这段时间
     按钮是活的，真人双击同样打得进来。 */
  await open({ ...withApp,
    writes: { applications: { data:[{ id:"app-fixture-1", updated_at:"2026-09-11T00:00:00Z" }], error:null, delay:1200 } },
    rpc: { my_application:{ data:[DRAFT] },
           submit_application:{ data:{ ok:true }, error:null, status:200 } } });
  await cdp.clickReal("#btnSubmit");
  await cdp.clickReal("#btnSubmit");
  await sleep(2600);
  const s5 = await calls();
  ok("S5 自动保存还没回来的那段窗口里，两次真实点击只发出一次 submit_application",
     (s5["rpc:submit_application"] || 0) === 1, JSON.stringify(s5));

  // ════════ W 保存 → 提交这条链路（event9dbe 返修）════════
  console.log("\n=== W 没保存成功就不能提交 ===");
  /* submit() 会先做一次 save()。原来 save() 什么都不返回，submit() 于是
     直接往下走 —— 保存被明确拒绝之后照样发 submit_application 并弹
     「申请已提交」，交上去的是服务端那份**旧表单**。 */
  /* 编辑器容器是 #appForm，字段带 data-f。选错选择器的话 touchForm 返回 false，
     「用户编辑」这个前提根本没构造出来，W1d/W2d 就变成读 null 的空转。 */
  const touchForm = async () => cdp.ev(`(()=>{
    const i = document.querySelector("#appForm [data-f]");
    if (!i || i.tagName === "DIV") return false;
    i.value = "FIXTURE-EDIT";
    i.dispatchEvent(new Event("input", { bubbles: true }));
    i.dispatchEvent(new Event("change", { bubbles: true }));
    return true;})()`);
  const subState = async () => cdp.ev(`(()=>{
    const e=document.getElementById("subErr"), b=document.getElementById("btnSubmit");
    const t=document.getElementById("amas-toast");
    const i=document.querySelector("#appForm [data-f]");
    return { err:e?(e.textContent||"").trim():null, shown:!!(e&&e.classList.contains("show")),
             btnDisabled:!!(b&&b.disabled),
             toast:t?(t.textContent||"").trim():null, toastShown:!!(t&&t.classList.contains("show")),
             kept: i ? i.value : null };})()`);

  // W1 明确拒绝（42501 权限不足）
  await open({ ...withApp,
    writes: { applications: { data:null, error:{ message:"permission denied for table applications", code:"42501" }, status:403 } },
    rpc: { my_application:{ data:[DRAFT] }, submit_application:{ data:{ ok:true }, error:null, status:200 } } });
  ok("W0 前提：确实在表单里改了一个字段（否则 W1d/W2d 是空转）",
     (await touchForm()) === true);
  await clickSubmit();
  const w1 = await calls();
  ok("W1 保存被明确拒绝后，**一次 submit_application 都不发**",
     (w1["rpc:submit_application"] || 0) === 0, JSON.stringify(w1));
  const w1s = await subState();
  ok("W1b 不弹「申请已提交」", !/申请已提交/.test((w1s.toast || "")), JSON.stringify(w1s));
  ok("W1c 说清楚是「没保存成功所以没提交」", /没有保存成功/.test(w1s.err || ""), JSON.stringify(w1s));
  ok("W1d 用户填的内容还留在页面上", w1s.kept === "FIXTURE-EDIT", JSON.stringify(w1s));
  ok("W1e 按钮放开，改完可以再交", w1s.btnDisabled === false, JSON.stringify(w1s));

  // W2 保存结果不明
  await open({ ...withApp,
    writes: { applications: { data:null, error:{ message:"Failed to fetch" }, status:0 } },
    rpc: { my_application:{ data:[DRAFT] }, submit_application:{ data:{ ok:true }, error:null, status:200 } } });
  await touchForm();
  await clickSubmit();
  const w2 = await calls();
  ok("W2 保存结果不明时同样不提交（可能交的是旧版本）",
     (w2["rpc:submit_application"] || 0) === 0, JSON.stringify(w2));
  const w2s = await subState();
  ok("W2b 如实说没能确认，并给刷新核实的出路",
     /没能确认/.test(w2s.err || "") && /刷新|核实/.test(w2s.err || ""), JSON.stringify(w2s));
  ok("W2c 不劝他一直点（按钮不放开）", w2s.btnDisabled === true, JSON.stringify(w2s));
  ok("W2d 用户填的内容还在", w2s.kept === "FIXTURE-EDIT", JSON.stringify(w2s));

  // W3 保存正常 → 照常提交
  await open({ ...withApp,
    writes: { applications: { data:[{ id:"app-fixture-1", updated_at:"2026-09-11T00:00:00Z" }], error:null } },
    rpc: { my_application:{ data:[DRAFT] }, submit_application:{ data:{ ok:true }, error:null, status:200 } } });
  await touchForm();
  await clickSubmit();
  const w3 = await calls();
  ok("W3 保存成功时照常提交（没改坏）", (w3["rpc:submit_application"] || 0) === 1, JSON.stringify(w3));
  ok("W3b 并且报「申请已提交」", /申请已提交/.test(((await subState()).toast) || ""), JSON.stringify(await subState()));

  // W4 保存被拒之后重复点击：仍然一次都不发
  await open({ ...withApp,
    writes: { applications: { data:null, error:{ message:"permission denied", code:"42501" }, status:403 } },
    rpc: { my_application:{ data:[DRAFT] }, submit_application:{ data:{ ok:true }, error:null, status:200 } } });
  await touchForm();
  await clickSubmit();
  await cdp.clickReal("#btnSubmit");
  await sleep(1400);
  ok("W4 保存被拒后连点两次，仍然一次 submit_application 都不发",
     ((await calls())["rpc:submit_application"] || 0) === 0, JSON.stringify(await calls()));

  // ════════ K 乐观并发（blueprint §6「服务端 updated_at 乐观并发」）════════
  console.log("\n=== K 乐观并发 ===");
  const lastMatch = async () => (await cdp.ev(`(()=>{try{return JSON.parse(sessionStorage.getItem("lastMatch")||"{}");}catch(e){return{};}})()`)) || {};
  const conflictBox = async () => cdp.ev(`(()=>{const b=document.getElementById("conflictBox");
    return b ? { text:(b.textContent||"").trim(), hasReload: !!b.querySelector("button") } : null;})()`);
  const DRAFT_TS = { ...DRAFT, updated_at: "2026-09-10T00:00:00Z" };

  await open({ ...withApp,
    writes: { applications: { data:[{ id:"app-fixture-1", updated_at:"2026-09-11T00:00:00Z" }], error:null } },
    rpc: { my_application:{ data:[DRAFT_TS] } } });
  ok("K0 前提：确实在表单里改了一个字段", (await touchForm()) === true);
  await sleep(1500);
  const k0 = await lastMatch();
  ok("K1 保存时带上 updated_at 作为匹配条件（不再只按 id 覆盖）",
     k0.id === "app-fixture-1" && k0.updated_at === "2026-09-10T00:00:00Z", JSON.stringify(k0));

  // 命中 0 行 = 这条记录在别处被改过
  await open({ ...withApp,
    writes: { applications: { data:[], error:null } },
    rpc: { my_application:{ data:[DRAFT_TS] } } });
  await touchForm();
  await sleep(1600);
  const kc = await conflictBox();
  const ks = await cdp.ev(`(document.getElementById("saveState")||{}).textContent||""`);
  ok("K2 命中 0 行时不报「已保存」", !/已保存/.test(ks), JSON.stringify(ks));
  ok("K3 明说这份申请在别处被改过", /别处被改过/.test(ks) || /别处被改过/.test((kc && kc.text) || ""), JSON.stringify({ ks, kc }));
  ok("K4 给「重新载入」出口，且**不自动重载**（不冲掉当前编辑）",
     !!kc && kc.hasReload === true, JSON.stringify(kc));
  ok("K5 用户填的内容还在页面上",
     (await cdp.ev(`(()=>{const i=document.querySelector("#appForm [data-f]"); return i?i.value:null;})()`)) === "FIXTURE-EDIT");

  // 冲突之后不许提交（提交的会是过期版本）
  await cdp.ev(`(()=>{try{sessionStorage.removeItem("wCalls");}catch(e){} return true;})()`);
  await clickSubmit();
  const k6 = await calls();
  ok("K6 冲突之后点提交，一次 submit_application 都不发",
     (k6["rpc:submit_application"] || 0) === 0, JSON.stringify(k6));
  ok("K7 并说清楚是没保存成功所以没提交",
     /没有保存成功/.test((await subState()).err || ""), JSON.stringify(await subState()));

  // ════════ F 失败要朝安全那边关（返修 eventf982）════════
  console.log("\n=== F 拿不到证据就不宣布成功 ===");
  const saveState = async () => cdp.ev(`(document.getElementById("saveState")||{}).textContent||""`);
  const isDirty = async () => cdp.ev(`(()=>{const b=document.getElementById("btnSubmit"); return !!b;})()`);

  // F1 Api.update 返回 {data:null,error:null}：没有任何记录证明写进去了
  await open({ ...withApp,
    writes: { applications: { data:null, error:null } },
    rpc: { my_application:{ data:[{ ...DRAFT, updated_at:"2026-09-10T00:00:00Z" }] } } });
  ok("F0 前提：改了一个字段", (await touchForm()) === true);
  await sleep(1600);
  ok("F1 拿不到写入记录时**不**显示「已保存」", !/已保存/.test(await saveState()), JSON.stringify(await saveState()));
  ok("F1b 而是说没能确认", /没能确认/.test(await saveState()), JSON.stringify(await saveState()));
  await cdp.ev(`(()=>{try{sessionStorage.removeItem("wCalls");}catch(e){} return true;})()`);
  await clickSubmit();
  ok("F1c 提交被拦住（结果不明不能提交）",
     ((await calls())["rpc:submit_application"] || 0) === 0, JSON.stringify(await calls()));

  // F2 有记录但没有新 updated_at：没法继续做并发比对
  await open({ ...withApp,
    writes: { applications: { data:[{ id:"app-fixture-1" }], error:null } },
    rpc: { my_application:{ data:[{ ...DRAFT, updated_at:"2026-09-10T00:00:00Z" }] } } });
  await touchForm();
  await sleep(1600);
  ok("F2 有记录但没有新版本号时也不宣布成功",
     !/已保存/.test(await saveState()) && /没能确认/.test(await saveState()), JSON.stringify(await saveState()));

  // F3 基准缺失：绝不发无条件覆盖
  await open({ ...withApp,
    writes: { applications: { data:[{ id:"app-fixture-1", updated_at:"2026-09-12T00:00:00Z" }], error:null } },
    rpc: { my_application:{ data:[{ ...DRAFT, updated_at: null }] } } });
  await touchForm();
  await sleep(1600);
  const f3m = await lastMatch();
  ok("F3 没有版本基准时**一次写入都不发**（不做无条件覆盖）",
     Object.keys(f3m).length === 0, JSON.stringify(f3m));
  ok("F3b 并如实说这一次没有保存", /没有保存|没能确认/.test(await saveState()), JSON.stringify(await saveState()));

  // ════════ Q 标记补件完成 ════════
  console.log("\n=== Q 标记补件完成 ===");
  const REQ_APP = { ...DRAFT, status: "needs_information" };
  await open({ tables: { ...BASE_TABLES,
      application_requirements: { data: [{ id:"req-1", label:"补一份受洗证明", detail:"", resolved:false, created_at:"2026-09-10T00:00:00Z" }] } },
    rpc: { my_application:{ data:[REQ_APP] },
           resolve_requirement:{ data:null, error:{ message:"Failed to fetch" }, status:0 } } });
  const hasCb = await cdp.ev(`!!document.querySelector("[data-req]")`);
  ok("Q0 前提：补件清单里有可勾的项", hasCb === true);
  await cdp.ev(`(()=>{const cb=document.querySelector("[data-req]"); cb.checked=true;
    cb.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);
  await sleep(1400);
  const q1 = await cdp.ev(`(()=>{const cb=document.querySelector("[data-req]");
    const t=document.getElementById("amas-toast");
    return { checked: cb ? cb.checked : null, toast: t ? (t.textContent||"").trim() : null };})()`);
  ok("Q1 结果不明时不把勾去掉（去掉等于断言「没生效」）", q1.checked === true, JSON.stringify(q1));
  ok("Q1b 并如实说没能确认", /无法确认|没能确认/.test(q1.toast || ""), JSON.stringify(q1));

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
console.log("  绿灯只证明「给定这些返回值时申请页没有谎报结果」，不证明真实申请流程已验收。");
process.exit(fail ? 1 : 0);
