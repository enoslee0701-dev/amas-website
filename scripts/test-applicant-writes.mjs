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
      o[k]=(o[k]||0)+1; sessionStorage.setItem("wCalls", JSON.stringify(o));
      /* 顺序也记下来 —— 「先保存再标记」这种事只看次数看不出来。 */
      var q=JSON.parse(sessionStorage.getItem("wSeq")||"[]"); q.push(k);
      sessionStorage.setItem("wSeq", JSON.stringify(q)); } catch(e){} };
    function table(name){
      var mode = "select";
      /* 这一次调用自己的匹配条件。sessionStorage 里的 lastMatch 是**累积**的，
         两笔写重叠时分不清哪条属于谁 —— 有状态 CAS 要判的正是「这一笔带的是哪一版」。 */
      var matchCond = {};
      var q = {
        select:function(){ return q; },
        eq:function(k, v){
          matchCond[k] = v;
          if (mode === "update") {
            try { var m = JSON.parse(sessionStorage.getItem("lastMatch") || "{}");
                  m[k] = v; sessionStorage.setItem("lastMatch", JSON.stringify(m)); } catch (e) {}
          }
          return q;
        },
        in:function(){ return q; },
        match:function(){ return q; }, order:function(){ return q; }, range:function(){ return q; }, limit:function(){ return q; },
        maybeSingle:function(){ return q; }, single:function(){ return q; },
        insert:function(){ mode = "insert"; bump("insert:" + name); return q; },
        update:function(patch){ mode = "update"; bump("update:" + name);
          /* 把真正写出去的内容记下来 —— 只看页面提示不算数，得看保存载荷。 */
          try { sessionStorage.setItem("lastPatch", JSON.stringify(patch)); } catch (e) {}
          return q; },
        /* 记下每次 update 用的匹配条件 —— 乐观并发要证的就是
           「保存时到底带没带 updated_at」。 */
        then:function(res, rej){
          var sc = S();
          /* 有状态 CAS 夹具：服务端只有**一个**当前版本，命中与否取决于
             判定那一刻它是不是请求带来的那一版。autoVersion 那种「每次都成功」
             验不出乐观并发真正的样子 —— 两笔写带着同一个版本出去，
             真实服务端只会让一笔命中，另一笔回 0 行。
             判定（apply）与回包（deliver）分开，才能分别控制「谁先命中」和「谁先回来」。 */
          if (mode !== "select" && sc.cas && sc.cas[name]) {
            var st = window.__casState();
            var e = { base: matchCond.updated_at, applied:false, done:false, out:null, deliver:null };
            st.q.push(e);
            return new Promise(function(r){ e.deliver = function(){ r(e.out); }; }).then(res, rej);
          }
          var t = (mode === "select")
            ? ((sc.tables && sc.tables[name]) || { data: [], error: null })
            : ((sc.writes && sc.writes[name]) || { data: [{ id: "app-fixture-1", updated_at: "2026-09-11T00:00:00Z" }], error: null });
          /* 每次写入回一个**不同的版本号** —— 否则验不出「旧响应把 updated_at 回写成旧值」。
             版本在**调用时**就定下来（out 在这里算好），与放行顺序无关。 */
          if (mode !== "select" && t.autoVersion) {
            window.__ver = (window.__ver || 0) + 1;
            t = { data: [{ id: "app-fixture-1", updated_at: "2026-09-10T00:00:0" + window.__ver + "Z" }], error: null };
          }
          var out = { data:t.data, error:t.error||null,
            status: t.status != null ? t.status : (t.error ? 500 : 200) };
          /* 可控闸门：写入被扣住，直到测试显式放行。
             只看「谁先被调用」不够 —— 要的是「谁先**完成**」。 */
          if (mode !== "select" && sc.holdWrites) {
            return new Promise(function(r){
              (window.__held = window.__held || []).push(function(){ r(out); });
            }).then(res, rej);
          }
          var d = t.delay || 0;
          return (d ? new Promise(function(r){ setTimeout(function(){ r(out); }, d); })
                    : Promise.resolve(out)).then(res, rej);
        }
      };
      return q;
    }
    return {
      auth: {
        getSession: function(){
          var u = (window.__SCEN && window.__SCEN.uid) || "u-appl";
          return reply({ data:{ session:{ user:{ id:u }, access_token:"fixture-token" } }, error:null });
        },
        signOut: function(){ return reply({}); },
        mfa: { getAuthenticatorAssuranceLevel: function(){
          return reply({ data:{ currentLevel:"aal1", nextLevel:"aal1" }, error:null }); } },
        onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
        signOut: function(){ return reply({}); }
      },
      from: table,
      rpc: function(name, args){
        bump("rpc:" + name);
        if (name === "my_application" && S().failReread) {
          /* 只让**重读**失败：第一次载入照常成功，提交之后那一次才挂。 */
          try { var seen = sessionStorage.getItem("reread"); 
                if (seen) return reply({ data:null, error:{ message:"boom" }, status:500 });
                sessionStorage.setItem("reread","1"); } catch (e) {}
        }
        if (name === "my_roles" && !(S().rpc||{}).my_roles)
          return reply({ data:[{ role:"applicant" }], error:null, status:200 });
        if (name === "my_profile" && !(S().rpc||{}).my_profile)
          return reply({ data:{ display_name:"测试申请人", email:"a@example.invalid" }, error:null, status:200 });
        var r = (S().rpc && S().rpc[name]) || { data:null, error:null };
        if (typeof r === "string") r = { data:null, error:null };
        var out = { data:r.data, error:r.error||null,
          status: r.status != null ? r.status : (r.error ? 500 : 200) };
        var dl = r.delay || 0;
        return dl ? new Promise(function(res){ setTimeout(function(){ res(out); }, dl); })
                  : reply(out);
      },
      functions: { invoke: function(){ return reply({ data:null, error:null }); } }
    };
  }
};
/* CAS 夹具的把手（测试侧显式调用）。索引不做 splice，保持稳定。
   状态**按需建立且可提前建立** —— 第一笔写入之前就要能 __casBump()，
   否则「别处先改过一笔」这种前提根本没设上，用例会假绿。 */
window.__casState = function(){
  var sc = window.__SCEN || {};
  return window.__cas || (window.__cas =
    { ver: sc.casFrom || "2026-09-10T00:00:00Z", n: 0, q: [], log: [] });
};
window.__casApply = function(i){
  var st = window.__cas; if (!st || !st.q[i] || st.q[i].applied) return null;
  var e = st.q[i];
  if (e.base === st.ver) {                       // 命中：版本推进一格
    st.n++; st.ver = "2026-09-10T00:00:0" + st.n + "Z";
    e.out = { data:[{ id:"app-fixture-1", updated_at: st.ver }], error:null, status:200 };
    st.log.push({ base:e.base, hit:true, ver:st.ver });
  } else {                                       // 没命中：0 行，这条记录已经不是那一版了
    e.out = { data:[], error:null, status:200 };
    st.log.push({ base:e.base, hit:false, ver:st.ver });
  }
  e.applied = true; return e.out;
};
/* 让某一笔**不是**正常 0 行/命中，而是错误响应。applyFirst=true 表示
   「服务端其实写成功了，只是响应没回来」—— 版本照推进，页面拿到的却是错误。 */
window.__casFail = function(i, status, message, applyFirst){
  var st = window.__cas; if (!st || !st.q[i] || st.q[i].applied) return null;
  var e = st.q[i];
  if (applyFirst) { window.__casApply(i); st.log.pop(); e.applied = false; }  // 一笔请求只记一行
  e.out = { data:null, error:{ message: message || "boom" }, status: status || 500 };
  e.applied = true;
  st.log.push({ base:e.base, hit:false, failed:true, status:e.out.status,
                landed:!!applyFirst, ver:st.ver });
  return e.out;
};
window.__casDeliver = function(i){
  var st = window.__cas; if (!st || !st.q[i] || st.q[i].done) return 0;
  if (!st.q[i].applied) window.__casApply(i);
  st.q[i].done = true; st.q[i].deliver(); return 1;
};
/* 别处（教务 / 另一个标签页）真的写了一笔：版本变了，但没有经过本页任何请求。 */
window.__casBump = function(){ var st = window.__casState();
  st.n++; st.ver = "2026-09-10T00:00:0" + st.n + "Z"; return st.ver; };`;

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

  /* 提交路径的夹具要像真的：一份**必填项都填好**的草稿。
     原来是 { name_zh:"测试申请人" } —— 缺十几项必填，现实里它根本走不到提交成功，
     而页面新增的「提交前先提示缺什么」正好会把它拦下。夹具不真实，不是产品错。
     字段取自服务端 application_validate_form 的必填清单（0010_program_catalog.sql:71-92）。 */
  const FULL_FORM = {
    name_zh: "测试申请人", name_en: "Test", gender: "male", birth_ym: "1990-01",
    nationality: "中国", languages: ["mandarin"], address: "某市某路 1 号", phone: "13800000000",
    church_name: "测试教会", church_role: "同工", conversion_date: "2010-01",
    education: [{ school: "某大学", start_ym: "2008-09", end_ym: "2012-06", degree: "本科" }],
    calling: "蒙召陈述", testimony: "见证正文", declaration_accepted: true, programs: ["bth"],
  };
  /* 专门留一份**残缺**的，给「提交前提示」那一段用。 */
  const DRAFT_THIN = { id:"app-fixture-1", applicant_id:"u-appl", pathway:"undecided", status:"draft",
    locked_fields:[], form_data:{ name_zh:"测试申请人" }, submitted_at:null, updated_at:"2026-09-10T00:00:00Z" };
  const DRAFT = { ...DRAFT_THIN, pathway:"degree", form_data: { ...FULL_FORM } };
  /* 课程目录的夹具要带上 is_open_for_application —— 页面正是按它过滤可选项的
     （programs = pcRows.filter(p => p.is_open_for_application)）。少了这一列，
     选择器在所有用例里都是空的，等于没测到。 */
  const BASE_TABLES = {
    program_catalog: { data: [
      { code:"bth", name_zh:"神学本科", short_label:"B.Th", is_open_for_application: true },
      { code:"cert", name_zh:"证书课程", short_label:"Cert", is_open_for_application: true },
      { code:"closed", name_zh:"已停招项目", short_label:"Old", is_open_for_application: false },
    ] },
    application_requirements: { data: [] },
  };
  const open = async (scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(scen) + ";" });
    await cdp.ev(`(()=>{try{["wCalls","wSeq","lastMatch","reread","lastPatch"].forEach(k=>sessionStorage.removeItem(k));}catch(e){} return true;})()`).catch(()=>{});
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
  /* 文案已按 N 段的口径改过：不再是一串光秃秃的字段名，而是按步骤分组 + 「去补填」。
     这里验的仍是那个不变量 —— **逐项**说出缺了什么，并且能直接去补。 */
  ok("S3 明确拒绝时仍然逐项说出缺了什么", /英文姓名/.test(s3 || ""), JSON.stringify(s3));
  ok("S3b 并且指出在第几步、给得出去补填的入口",
     /第 *\d+ *步/.test(s3 || "") &&
     (await cdp.ev(`!!document.querySelector("[data-gofix]")`)) === true, JSON.stringify(s3));
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

  // ════════ R 冲突之后，编辑要能救回来 ════════
  console.log("\n=== R 冲突后的可恢复体验 ===");
  /* 第十九包做到了「不自动重载、编辑留在屏幕上」，但用户一旦点「重新载入」，
     他刚填的东西还是全没了 —— 等于让他把一份长表单手抄一遍。
     这一段要的是：**先把他的编辑留住再去取最新版本**，回来能一键恢复；
     而且永远不自动应用、不自动重载，由他决定。 */
  const banner = async (id) => cdp.ev(`(()=>{const b=document.getElementById(${JSON.stringify(id)});
    return b ? { text:(b.textContent||"").trim(), buttons:[...b.querySelectorAll("button")].map(x=>(x.textContent||"").trim()) } : null;})()`);
  const fieldVal = async () => cdp.ev(`(()=>{const i=document.querySelector("#appForm [data-f]"); return i?i.value:null;})()`);
  /* 键名带命名空间（amas.draft.*），别写死成旧名字 —— 上一轮就是这么误红的。 */
  const stash = async () => cdp.ev(`(()=>{try{
    for (var i=0;i<sessionStorage.length;i++){ var k=sessionStorage.key(i);
      if (k && k.indexOf("amas.draft.") === 0) return sessionStorage.getItem(k); }
    return null;}catch(e){return null;}})()`);
  const localKeys = async () => cdp.ev(`(()=>{try{return Object.keys(localStorage);}catch(e){return [];}})()`);

  const DRAFT_T0 = { ...DRAFT, updated_at: "2026-09-10T00:00:00Z" };
  const DRAFT_T1 = { ...DRAFT, updated_at: "2026-09-12T00:00:00Z" };

  await open({ ...withApp,
    writes: { applications: { data:[], error:null } },          // 命中 0 行 = 冲突
    rpc: { my_application:{ data:[DRAFT_T0] } } });
  ok("R0 前提：改一个字段并落到冲突", (await touchForm()) === true);
  await sleep(1600);
  const rb = await banner("conflictBox");
  ok("R1 冲突提示里有「保留我的编辑」这条出路，不是只让他自己抄下来",
     !!rb && rb.buttons.some(t => /保留/.test(t)), JSON.stringify(rb));

  // 换成「服务端已是新版本、写入会成功」的场景，再走保留并重载
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify({
    ...withApp, writes: { applications: { data:[{ id:"app-fixture-1", updated_at:"2026-09-12T00:00:00Z" }], error:null } },
    rpc: { my_application:{ data:[DRAFT_T1] } } }) + ";" });
  await cdp.ev(`(()=>{const b=[...document.querySelectorAll("#conflictBox button")].find(x=>/保留/.test(x.textContent||"")); if(b) b.click(); return !!b;})()`);
  await sleep(3000);
  ok("R2 保留之后确实把编辑暂存下来了", !!(await stash()), JSON.stringify((await stash() || "").slice(0, 80)));
  ok("R2b 暂存只在本标签页（sessionStorage），没有写进 localStorage",
     !(await localKeys()).some(k => /[Dd]raft|amas/.test(k)), JSON.stringify(await localKeys()));
  const rr = await banner("restoreBox");
  ok("R3 重新载入后出现恢复提示，并给出恢复与丢弃两个选择",
     !!rr && rr.buttons.some(t => /恢复/.test(t)) && rr.buttons.some(t => /丢弃/.test(t)), JSON.stringify(rr));
  ok("R3b 但**没有自动应用** —— 此刻表单里还是服务端那一版",
     (await fieldVal()) !== "FIXTURE-EDIT", "当前值=" + JSON.stringify(await fieldVal()));

  await cdp.ev(`(()=>{const b=[...document.querySelectorAll("#restoreBox button")].find(x=>/恢复/.test(x.textContent||"")); if(b) b.click(); return !!b;})()`);
  await sleep(900);
  ok("R4 点「恢复」之后，用户自己填的内容回来了", (await fieldVal()) === "FIXTURE-EDIT",
     "当前值=" + JSON.stringify(await fieldVal()));
  ok("R4b 恢复之后暂存被清掉，不会反复弹", !(await stash()), JSON.stringify(await stash()));

  // 丢弃这条路
  await open({ ...withApp,
    writes: { applications: { data:[], error:null } },
    rpc: { my_application:{ data:[DRAFT_T0] } } });
  await touchForm();
  await sleep(1600);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify({
    ...withApp, writes: { applications: { data:[{ id:"app-fixture-1", updated_at:"2026-09-12T00:00:00Z" }], error:null } },
    rpc: { my_application:{ data:[DRAFT_T1] } } }) + ";" });
  await cdp.ev(`(()=>{const b=[...document.querySelectorAll("#conflictBox button")].find(x=>/保留/.test(x.textContent||"")); if(b) b.click(); return !!b;})()`);
  await sleep(3000);
  await cdp.ev(`(()=>{const b=[...document.querySelectorAll("#restoreBox button")].find(x=>/丢弃/.test(x.textContent||"")); if(b) b.click(); return !!b;})()`);
  await sleep(700);
  ok("R5 选「丢弃」后提示消失、暂存清空，表单保持服务端版本",
     !(await banner("restoreBox")) && !(await stash()) && (await fieldVal()) !== "FIXTURE-EDIT",
     JSON.stringify({ banner: await banner("restoreBox"), stash: await stash(), val: await fieldVal() }));

  // ════════ D 暂存失败不能吞掉（返修 eventd732）════════
  console.log("\n=== D 存不下就不许重载 ===");
  /* 原来 stashDraft 是 catch(e){} 外加一句「存不下就算了」，然后照样 reload
     —— 唯一一份未保存的内容就这么没了（反例实测 reloads=1 / saved=false）。
     配额满、隐私模式、存储被禁用都会走到这条路。 */
  const breakStorage = async (mode) => cdp.ev(`(()=>{
    const k = ${JSON.stringify("mode")};
    if (${JSON.stringify(mode)} === "throw") {
      sessionStorage.setItem = function(){ const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; };
    } else if (${JSON.stringify(mode)} === "stale") {
      /* 键上先留一份**旧**草稿，然后让 setItem 静默失效。
         只判「有没有东西」的读回会拿到旧值，误判成功。 */
      sessionStorage.setItem("amas.draft.application", JSON.stringify({
        id:"app-fixture-1", uid:"u-appl", at:1, form_data:{ name_zh:"OLD-STALE" }, pathway:"undecided" }));
      sessionStorage.setItem = function(){};
    } else {   // 不抛错但也不存（有些隐私模式就是这样）
      sessionStorage.setItem = function(){};
    }
    return true;})()`);
  const navCount = [];
  cdp.on("Page.frameNavigated", (p) => { if (p.frame && !p.frame.parentId) navCount.push(String(p.frame.url||"")); });

  for (const [label, mode] of [["setItem 抛配额错","throw"], ["不抛错但没真的存下","silent"],
                              ["键上留着旧草稿、本次静默没写","stale"]]) {
    await open({ ...withApp, writes: { applications: { data:[], error:null } },
      rpc: { my_application:{ data:[{ ...DRAFT, updated_at:"2026-09-10T00:00:00Z" }] } } });
    await touchForm();
    await sleep(1600);
    await breakStorage(mode);
    navCount.length = 0;
    await cdp.ev(`(()=>{const b=[...document.querySelectorAll("#conflictBox button")].find(x=>/保留/.test(x.textContent||"")); if(b) b.click(); return !!b;})()`);
    await sleep(1800);
    ok("D 暂存失败（" + label + "）→ **不重新载入**",
       navCount.length === 0, "发生了 " + navCount.length + " 次导航");
    ok("D 暂存失败（" + label + "）→ 用户填的内容还在页面上",
       (await cdp.ev(`(()=>{const i=document.querySelector("#appForm [data-f]"); return i?i.value:null;})()`)) === "FIXTURE-EDIT");
    const fb = await cdp.ev(`(()=>{const b=document.getElementById("stashFailBox");
      return b ? { text:(b.textContent||"").trim().slice(0,120),
                   ta: !!b.querySelector("textarea"),
                   taVal: (b.querySelector("textarea")||{}).value || "",
                   buttons:[...b.querySelectorAll("button")].map(x=>(x.textContent||"").trim()) } : null;})()`);
    ok("D 暂存失败（" + label + "）→ 明说存不下、并说明没有重新载入",
       !!fb && /存不下/.test(fb.text) && /没有.*重新载入|没有重新载入/.test(fb.text.replace(/\*/g,"")), JSON.stringify(fb && fb.text));
    ok("D 暂存失败（" + label + "）→ 把内容摊出来让他能复制带走",
       !!fb && fb.ta === true && fb.taVal.indexOf("FIXTURE-EDIT") > -1, JSON.stringify(fb && fb.taVal.slice(0,80)));
    ok("D 暂存失败（" + label + "）→ 重新载入改成由他自己点",
       !!fb && fb.buttons.some(t => /重新载入/.test(t)), JSON.stringify(fb && fb.buttons));
    if (mode === "stale") {
      ok("D 键上那份旧草稿没有被当成「这次存好了」",
         (await stash() || "").indexOf("FIXTURE-EDIT") === -1 &&
         (await stash() || "").indexOf("OLD-STALE") > -1,
         JSON.stringify((await stash() || "").slice(0, 90)));
    }
  }

  // ════════ X 跨账号与不可编辑边界 ════════
  console.log("\n=== X 暂存的跨账号与锁定边界 ===");
  /* 暂存里装的是姓名、教会、见证这些个人资料。它跟着标签页走，
     所以两件事必须成立：
       ① 换一个账号绝不能把上一个人的草稿恢复出来（哪怕 app.id 撞上）；
       ② 主动退出时就该清掉 —— 神学院的公用电脑上，下一个人不该还能
          在这个标签页里翻到前一个人的申请资料。
     另外申请一旦不可编辑（已提交/已录取），「恢复」就写不回去了，
     这时候提供恢复等于骗他一次。 */
  const stashRaw = async () => cdp.ev(`(()=>{try{
    var out=null; for (var i=0;i<sessionStorage.length;i++){ var k=sessionStorage.key(i);
      if (/draft/i.test(k)) out = { key:k, val:sessionStorage.getItem(k) }; }
    return out;}catch(e){return null;}})()`);
  // DRAFT_T0 / DRAFT_T1 已在 R 段声明，这里直接复用
  const conflictAndKeep = async (scen) => {
    await open({ ...scen, writes: { applications: { data:[], error:null } },
      rpc: { my_application:{ data:[DRAFT_T0] } } });
    await touchForm();
    await sleep(1600);
    await cdp.ev(`(()=>{const b=[...document.querySelectorAll("#conflictBox button")].find(x=>/保留/.test(x.textContent||"")); if(b) b.click(); return !!b;})()`);
    await sleep(400);
  };

  // X1 暂存带上用户身份
  await conflictAndKeep({ ...withApp, uid:"user-AAA" });
  const x1 = await stashRaw();
  ok("X1 暂存里带上用户身份（不只是 app.id）",
     !!x1 && /user-AAA/.test(x1.val || ""), JSON.stringify(x1));

  // X2 换一个账号：同一个 app.id 也不许恢复
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify({
    ...withApp, uid:"user-BBB",
    writes: { applications: { data:[{ id:"app-fixture-1", updated_at:"2026-09-12T00:00:00Z" }], error:null } },
    rpc: { my_application:{ data:[DRAFT_T1] } } }) + ";" });
  await cdp.send("Page.navigate", { url: `${BASE}/portal/applicant/application/` });
  await sleep(3000);
  ok("X2 换一个账号后不提供恢复（上一个人的草稿不能露给下一个人）",
     (await cdp.ev(`!document.getElementById("restoreBox")`)) === true);
  ok("X2b 表单里也不含上一个人填的内容",
     (await cdp.ev(`(()=>{const i=document.querySelector("#appForm [data-f]"); return i?i.value:null;})()`)) !== "FIXTURE-EDIT");

  // X3 主动退出要清掉暂存
  await conflictAndKeep({ ...withApp, uid:"user-AAA" });
  await sleep(2600);
  ok("X3 前提：此刻暂存确实在", !!(await stashRaw()));
  await cdp.ev(`(()=>{ window.AmasAuth.signOut(); return true; })()`);
  await sleep(2200);
  ok("X3b 主动退出后暂存被清掉，不留在这个标签页里",
     !(await stashRaw()), JSON.stringify(await stashRaw()));

  // X4 申请已不可编辑时不提供恢复
  await conflictAndKeep({ ...withApp, uid:"user-AAA" });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify({
    ...withApp, uid:"user-AAA",
    rpc: { my_application:{ data:[{ ...DRAFT_T1, status:"submitted" }] } } }) + ";" });
  await cdp.send("Page.navigate", { url: `${BASE}/portal/applicant/application/` });
  await sleep(3000);
  const x4 = await cdp.ev(`(()=>{const b=document.getElementById("restoreBox");
    return b ? { text:(b.textContent||"").trim(), buttons:[...b.querySelectorAll("button")].map(x=>(x.textContent||"").trim()) } : null;})()`);
  ok("X4 申请已不可编辑时**不给**「恢复」（写不回去，给了就是骗他一次）",
     !x4 || !x4.buttons.some(t => /恢复/.test(t)), JSON.stringify(x4));
  ok("X4b 但如实说明这份草稿写不回去了，并让他能丢弃",
     !!x4 && /不能再改|已不可编辑|无法写回/.test(x4.text) && x4.buttons.some(t => /丢弃/.test(t)),
     JSON.stringify(x4));

  // ════════ P2 提交成功之后重读失败，不能把页面弄坏 ════════
  console.log("\n=== P2 提交成功后重读失败 ===");
  /* 提交成功 → UI.toast("申请已提交") → 重读 my_application。
     这一读若失败，rows 是 null，app 被赋成 undefined，
     紧接着 loadRequirements() 对 app.id 取值就抛 TypeError ——
     **申请已经交上去了，页面却当场坏掉**，用户不知道自己到底交没交成。 */
  pageErrors = [];
  await open({ ...withApp, failReread: true,
    writes: { applications: { data:[{ id:"app-fixture-1", updated_at:"2026-09-11T00:00:00Z" }], error:null } },
    rpc: { my_application:{ data:[{ ...DRAFT, updated_at:"2026-09-10T00:00:00Z" }] },
           submit_application:{ data:{ ok:true }, error:null, status:200 } } });
  ok("P2-0 前提：草稿页正常打开", (await cdp.ev(`!!document.getElementById("btnSubmit")`)) === true);
  await clickSubmit();
  await sleep(1200);
  ok("P2-1 提交成功后重读失败，不抛异常把页面弄坏",
     !pageErrors.some(e => /TypeError/.test(e)), JSON.stringify(pageErrors.slice(0,2)));
  const p2 = await cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template,[hidden]").forEach(n=>n.remove());
    const t=document.getElementById("amas-toast");
    return { text:(c.textContent||"").replace(/\\s+/g," ").trim(),
             toast:t?(t.textContent||"").trim():null };})()`);
  ok("P2-2 仍然如实告诉他申请已提交", /申请已提交/.test((p2.toast || "") + p2.text), JSON.stringify(p2.toast));
  ok("P2-3 并说清楚最新状态这一次没读到、请刷新再看",
     /没能读到|没能确认|刷新/.test(p2.text), p2.text.slice(0, 220));

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

  // ════════ U 申请人这一侧：读不到不等于没有 ════════
  console.log("\n=== U 申请人侧的「读不到当没有」===");
  const bodyVis = async () => cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template,[hidden]").forEach(n=>n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();})()`);

  /* U1：loadRequirements() 只解构 data，读失败时 reqs = []，
         而 render() 是 `${reqs.length ? renderRequirements() : ""}` ——
         **整张「需要补充的资料」卡片消失**。申请人看到的是：
         状态「需补充资料 · 请按下方要求补充后重新提交」，下方空无一物；
         点提交又会被服务端 requirements_pending 挡回来
         （0008_applications.sql:243）。他被要求补一份自己看不见的材料。 */
  const NEED_INFO = { ...DRAFT, status: "needs_information" };
  await open({ tables: { ...BASE_TABLES,
      application_requirements: { data:null, error:{ message:"boom" }, status:500 } },
    rpc: { my_application: { data:[NEED_INFO] } } });
  const u1 = await bodyVis();
  ok("U1 前提：状态确实是「需补充资料」", /需补充资料/.test(u1 || ""), (u1 || "").slice(0, 160));
  ok("U1b 补件清单读不到时，不把整块内容静默拿掉",
     /需要补充的资料|补充的资料/.test(u1 || ""), (u1 || "").slice(0, 300));
  ok("U1c 而是明说这一次没读到，别让他以为已经补完了",
     /没能读到|没读到|未知/.test(u1 || ""), (u1 || "").slice(0, 300));

  /* U2：createDraft() 在 insert 成功之后重读 my_application。
         这一读若失败，app 被赋成 undefined，紧接着 render() 取 app.status
         就抛 TypeError —— **草稿已经建出来了，页面却当场坏掉**。 */
  pageErrors = [];
  await open({ ...noApp, failReread: true,
    writes: { applications: { data:[{ id:"app-fixture-1", updated_at:"2026-09-11T00:00:00Z" }], error:null } } });
  ok("U2-0 前提：没有申请时显示创建入口",
     (await cdp.ev(`!!document.querySelector('[data-act="new"]')`)) === true);
  await cdp.clickReal('[data-act="new"]');
  await sleep(1600);
  ok("U2 草稿建好后重读失败，不抛异常把页面弄坏",
     !pageErrors.some(e => /TypeError/.test(e)), JSON.stringify(pageErrors.slice(0, 2)));
  const u2 = await bodyVis();
  ok("U2b 页面不是一片空白", (u2 || "").length > 40, (u2 || "").slice(0, 200));
  ok("U2c 如实告诉他草稿已经建好了", /草稿已创建|已经建好|已创建/.test(u2 || ""), (u2 || "").slice(0, 240));
  ok("U2d 并说清楚这一次没读到最新内容、请刷新",
     /没能读到|没读到|刷新/.test(u2 || ""), (u2 || "").slice(0, 240));

  /* U3：withdraw() —— 撤回是不可逆的。
         (a) 成功判据只看 error，没按契约验 data.ok（0008:283 返回 {'ok':true}）；
         (b) 撤回成功之后重读失败 → renderStart()「还没有正式申请」。 */
  await open({ ...withApp, rpc: { my_application:{ data:[DRAFT] },
    withdraw_application:{ data:null, error:null, status:200 } } });
  ok("U3-0 前提：草稿页有撤回入口",
     (await cdp.ev(`!!document.getElementById("btnWithdraw")`)) === true);
  await cdp.clickReal("#btnWithdraw");
  await sleep(500);
  await cdp.ev(`(()=>{const b=document.querySelector(".portal-modal [data-ok]"); if(b) b.click(); return !!b;})()`);
  await sleep(1400);
  const u3 = await toastNow();
  ok("U3 服务端没给可读结论时，不咬定「申请已撤回」",
     !/已撤回/.test((u3 && u3.text) || ""), JSON.stringify(u3));

  pageErrors = [];
  await open({ ...withApp, failReread: true, rpc: { my_application:{ data:[DRAFT] },
    withdraw_application:{ data:{ ok:true }, error:null, status:200 } } });
  await cdp.clickReal("#btnWithdraw");
  await sleep(500);
  await cdp.ev(`(()=>{const b=document.querySelector(".portal-modal [data-ok]"); if(b) b.click(); return !!b;})()`);
  await sleep(1600);
  const u4 = await bodyVis();
  ok("U4 撤回成功后重读失败时，不说成「还没有正式申请」",
     !/还没有正式申请/.test(u4 || ""), (u4 || "").slice(0, 240));
  ok("U4b 而是说清楚已撤回、但最新状态这一次没读到",
     /没能读到|没读到|刷新/.test(u4 || ""), (u4 || "").slice(0, 240));

  // ════════ V 返修 b915a5e（监督两条）════════
  console.log("\n=== V 返修：重读在途的创建窗口 / error 带 data ===");

  /* V1：监督指出 reqsUnknown 与 reqs 同时成立时，render() 是
         `${reqs.length ? renderRequirements() : (reqsUnknown ? ... : "")}` ——
         reqs 一旦非空就短路，那条「没读到」永远不显示，等于把 error 忽略掉了。
         服务端给了 error 就说明这份清单不能当作完整的。 */
  await open({ tables: { ...BASE_TABLES, application_requirements: {
      data: [{ id:"req-1", label:"补一份受洗证明", detail:"", resolved:false, created_at:"2026-09-10T00:00:00Z" }],
      error: { message:"partial read" }, status: 500 } },
    rpc: { my_application: { data:[{ ...DRAFT, status:"needs_information" }] } } });
  const v1 = await bodyVis();
  ok("V1 读到的那几项照常显示（不丢已经拿到的信息）",
     /补一份受洗证明/.test(v1 || ""), (v1 || "").slice(0, 300));
  ok("V1b 但同时说明这份清单这一次没读全，不当成完整的",
     /没读全|不完整|没能读到|没读到/.test(v1 || ""), (v1 || "").slice(0, 300));

  /* V2：监督指出 createDraft() 在 insert 成功后先 creating=false，再 await
         重读 my_application。那一段窗口里旧的创建入口还在页面上 ——
         若它此刻仍可点，就会 insert 出第二份申请。
         这里把重读拖慢，在窗口正中间再点一次。 */
  await open({ tables: BASE_TABLES,
    rpc: { my_application: { data: [], delay: 2400 } },
    writes: { applications: { data:[{ id:"app-fixture-1", updated_at:"2026-09-11T00:00:00Z" }], error:null } } }, 4200);
  ok("V2-0 前提：创建入口在",
     (await cdp.ev(`!!document.querySelector('[data-act="new"]')`)) === true);
  await cdp.clickReal('[data-act="new"]');
  await sleep(900);                              // 此刻 insert 已回、重读还在途
  const midway = await cdp.ev(`(()=>{const b=document.querySelector('[data-act="new"]');
    return b ? { present:true, disabled:!!b.disabled } : { present:false };})()`);
  ok("V2 重读在途时，旧的创建入口已经封住",
     midway.present === false || midway.disabled === true, JSON.stringify(midway));
  await cdp.ev(`(()=>{const b=document.querySelector('[data-act="new"]'); if(b) b.click(); return !!b;})()`);
  await sleep(2600);
  const v2calls = await calls();
  ok("V2b 那一下没有再建出第二份申请",
     (v2calls["insert:applications"] || 0) === 1, JSON.stringify(v2calls));

  // ════════ A1 指派对申请人必须完全不可见（G1）════════
  console.log("\n=== A1 申请人看不到任何内部人员安排 ===");
  /* 服务端那一侧的保证是：assign_application_reviewer **只写 audit_logs**，
     不写 application_status_history —— 因为 my_application_timeline 会把该申请
     全部 history 行原样返回（0008:211-218）。那条保证属于 0027，本轮 **NOT_RUN**。
     这里能验的是**客户端**这一侧：哪怕 assigned_reviewer 混进了返回给申请人的行里，
     页面也一个字都不能显示出来。 */
  const LEAKY = { ...DRAFT, status: "submitted",
    assigned_reviewer: "u-reviewer-should-never-show",
    applicant_visible_message: null };
  await open({ tables: BASE_TABLES, rpc: { my_application: { data: [LEAKY] },
    my_application_timeline: { data: [
      { to_status: "submitted", applicant_visible_message: "已收到你的申请", created_at: "2026-09-10T00:00:00Z" },
    ] } } });
  const a1 = await bodyVis();
  ok("A1-0 前提：申请页确实渲染出来了", /我的申请/.test(a1 || ""), (a1 || "").slice(0, 120));
  ok("A1 审核人的标识一个字都没出现",
     !/u-reviewer-should-never-show/.test(a1 || ""), (a1 || "").slice(0, 200));
  ok("A1b 页面上没有「审核人／指派」这类字样",
     !/审核人/.test(a1 || "") && !/指派/.test(a1 || ""), (a1 || "").slice(0, 240));
  ok("A1c 对照：时间线里该显示的东西照常显示（不是整页空了才变绿）",
     /已收到你的申请/.test(a1 || ""), (a1 || "").slice(0, 240));

  console.log("  NOT_RUN  「指派不写 application_status_history」是 0027 的保证：");
  console.log("           本轮没有 apply、没有真实数据库执行，这里只验了客户端不显示。");

  // ════════ N 提交前的前端提示（PORTAL-blueprint §6）════════
  console.log("\n=== N 提交之前得先告诉他缺什么、在哪一步 ===");
  /* 蓝图 §6：「提交前校验（必填、格式、一致性）在**前端提示** + RPC 二次校验」。
     实际只做了后一半：application-form.js 里每个字段都标了 required: true，
     但页面只拿它画了一个红星（fieldHtml 里的那个 *），此外**一处都没用**：
       · 「下一步」无条件前进，不看这一步填没填完；
       · 六步的步骤条上看不出哪一步还差东西；
       · 只有点了提交、等服务端 validation_failed 回来，才知道缺了什么，
         而那条消息只给字段名，不说在第几步 —— 四十来个字段、六个步骤，得自己翻。
     数据库仍然是权威（application_validate_form），所以前端只**提示**，不封死：
     他坚持要提交，照样提交，由服务端判。 */
  const stepsOf = async () => cdp.ev(`(()=>{
    const S = window.AmasAppForm && window.AmasAppForm.STEPS;
    if (!S) return null;
    return S.map(s => ({ title: s.title,
      req: s.fields.filter(f => f.required).map(f => ({ name: f.name, type: f.type })) }));})()`);

  await open({ ...withApp, rpc: { my_application: { data: [DRAFT_THIN] } } });
  const STEPS = await stepsOf();
  ok("N0 前提：读得到表单定义里的必填项", Array.isArray(STEPS) && STEPS.some(s => s.req.length),
     JSON.stringify((STEPS || []).map(s => s.req.length)));

  const stepBar = async () => cdp.ev(`(()=>{const b=document.querySelector('[role="tablist"], .steps, #stepbar');
    if (b) return (b.textContent||"").replace(/\\s+/g," ").trim();
    const t=document.querySelectorAll('[data-step]');
    return Array.from(t).map(x=>(x.textContent||"").trim()).join(" | ");})()`);
  const bar0 = await stepBar();
  ok("N1 步骤条上标得出哪几步还缺必填项",
     /还差|未完成|缺/.test(bar0 || ""), (bar0 || "").slice(0, 200));

  await clickSubmit();
  const n2 = await subErr();
  ok("N2 点提交时先在前端说清楚缺了什么",
     /还没填|缺/.test(n2 || ""), JSON.stringify(n2));
  ok("N2b 并且说出在第几步（不是只甩一串字段名）",
     /第 *\d+ *步/.test(n2 || "") || /第[一二三四五六]步/.test(n2 || ""), JSON.stringify(n2));
  const calls2 = await calls();
  ok("N2c 这一次没有白跑一趟服务端（没发 submit_application）",
     !(calls2["rpc:submit_application"] > 0), JSON.stringify(calls2));

  ok("N3 给得出「去补填」的入口",
     (await cdp.ev(`!!document.querySelector("[data-gofix]")`)) === true);
  await cdp.ev(`(()=>{const b=document.querySelector("[data-gofix]"); if(b) b.click(); return !!b;})()`);
  await sleep(500);
  const onStep = await cdp.ev(`(()=>{const on=document.querySelector('[data-step].on, [data-step][aria-selected="true"]');
    return on ? (on.textContent||"").trim() : null;})()`);
  ok("N3b 点了之后确实跳到那一步", !!onStep && onStep.length > 0, String(onStep));

  /* 数据库是权威：前端只提示，不封死。他坚持提交就得真的提交出去。 */
  ok("N4 仍然留有「坚持提交」的出路",
     (await cdp.ev(`!!document.querySelector("[data-submitanyway]")`)) === true);
  await cdp.ev(`(()=>{const b=document.querySelector("[data-submitanyway]"); if(b) b.click(); return !!b;})()`);
  await sleep(1200);
  const calls4 = await calls();
  ok("N4b 选了坚持提交，请求真的发出去了（由服务端判）",
     (calls4["rpc:submit_application"] || 0) >= 1, JSON.stringify(calls4));

  /* 对照：必填项都填好之后，前端不该再拦一道。表单定义取自页面自己的 AmasAppForm。 */
  const full = {};
  for (const st of (STEPS || [])) for (const f of st.req) {
    if (f.name === "__pathway") continue;
    /* programs 的真实形状是「目录里一个开放代码的数组」，不是随便一个字符串 ——
       页面按 0010_program_catalog.sql:55-63 那条规则判它，塞 "x" 会被判成没选。 */
    full[f.name] = f.type === "program" ? ["bth"]
      : f.type === "checkboxes" ? ["x"]
      : f.type === "rows" ? [{ school: "x" }]
      : f.type === "month" ? "2020-01" : "x";
  }
  await open({ ...withApp, rpc: {
    my_application: { data: [{ ...DRAFT, form_data: full, pathway: "degree" }] },
    submit_application: { data: { ok: true }, error: null, status: 200 } } });
  const barFull = await stepBar();
  ok("N5 对照：都填好时步骤条上不再标缺项",
     !/还差|未完成/.test(barFull || ""), (barFull || "").slice(0, 200));
  await clickSubmit();
  const callsFull = await calls();
  ok("N5b 对照：都填好时直接提交，不再多问一句",
     (callsFull["rpc:submit_application"] || 0) >= 1 &&
     (await cdp.ev(`!document.querySelector("[data-submitanyway]")`)) === true,
     JSON.stringify(callsFull));

  /* 服务端仍可能判出前端没料到的缺项（条件必填、格式、一致性）——
     那条消息也要说清楚在第几步。 */
  await open({ ...withApp, rpc: {
    my_application: { data: [{ ...DRAFT, form_data: full, pathway: "degree" }] },
    submit_application: { data: { ok: false, error: "validation_failed", missing: ["phone"] },
      error: null, status: 200 } } });
  await clickSubmit();
  const n6 = await subErr();
  ok("N6 服务端说缺项时，也要指出在第几步",
     /手机/.test(n6 || "") && (/第 *\d+ *步/.test(n6 || "") || /第[一二三四五六]步/.test(n6 || "")),
     JSON.stringify(n6));

  // ════════ Pb 缺项计数要跟着填写走，且不能把焦点弄丢 ════════
  console.log("\n=== Pb 补填之后计数要当场更新 ===");
  /* 上一包在步骤条上加了「还差 N」，但 touch() 里没有刷新它 ——
     填完一项之后那个数字停在旧值上，人会以为自己没填进去。
     而直接调 buildSteps() 又会整段重绘表单，正在打字的输入框当场失焦。 */
  const badge = async (i) => cdp.ev(`(()=>{const b=document.querySelector('[data-step="${i}"]');
    return b ? (b.textContent||"").replace(/\\s+/g," ").trim() : null;})()`);
  await open({ ...withApp, rpc: { my_application: { data: [DRAFT_THIN] } } });
  const b0 = await badge(0);
  ok("Pb0 前提：第 1 步上标着还差几项", /还差 *\d+/.test(b0 || ""), String(b0));
  const n0 = Number((b0 || "").match(/还差 *(\d+)/)[1]);

  await cdp.ev(`(()=>{const el=document.getElementById("fd-nationality");
    if(!el) return false; el.focus(); el.value="中国";
    el.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
  await sleep(300);
  const b1 = await badge(0);
  const n1 = Number(((b1 || "").match(/还差 *(\d+)/) || [0, n0])[1]);
  ok("Pb1 填上一项之后，计数当场少一", n1 === n0 - 1, b0 + " → " + b1);
  ok("Pb2 而且正在打字的那个输入框没有失焦",
     (await cdp.ev(`document.activeElement && document.activeElement.id`)) === "fd-nationality",
     await cdp.ev(`document.activeElement && document.activeElement.id`));

  console.log("\n=== Pr 项目一致性：已不开放的项目不能悄悄变成空白 ===");
  /* 规则是明确的（0010_program_catalog.sql:55-63）：programs 恰好一项、必须在目录里、
     且必须 is_open_for_application。前端按这个过滤了下拉 —— 但草稿里**已经存着**
     一个不在开放目录里的代码时（当初开放、后来停招，或者从 ?program= 带进来的），
     选择器里没有对应的 option，于是显示成「请选择一个项目」的空白，
     而 form_data.programs 里那个代码还在：人看见空白，以为没选；
     提交则被服务端以 missing:['programs'] 退回；新加的「还差」也把它当已填。 */
  const CLOSED_DRAFT = { ...DRAFT, form_data: { ...DRAFT.form_data, programs: ["closed"] } };
  await open({ ...withApp, rpc: { my_application: { data: [CLOSED_DRAFT] } } });
  await cdp.ev(`(()=>{const t=document.querySelector('[data-step="3"]'); if(t) t.click(); return !!t;})()`);
  await sleep(400);
  const pr1 = await cdp.ev(`(()=>{const f=document.getElementById("appForm");
    if(!f) return null; const k=f.cloneNode(true); k.querySelectorAll("[hidden]").forEach(n=>n.remove());
    return (k.textContent||"").replace(/\\s+/g," ").trim();})()`);
  ok("Pr1 已停招的那个选择不被显示成空白，页面说得出它已不开放",
     /不开放|已停招/.test(pr1 || ""), (pr1 || "").slice(0, 240));
  ok("Pr1b 并说清楚这样提交会被退回，要换一个",
     /退回|换一个|重新选/.test(pr1 || ""), (pr1 || "").slice(0, 240));

  const prb = await cdp.ev(`(()=>{const b=document.querySelector('[data-step="3"]');
    return b ? (b.textContent||"").replace(/\\s+/g," ").trim() : null;})()`);
  ok("Pr2 这一步的「还差」把它算进去，不当成已填", /还差 *[1-9]/.test(prb || ""), String(prb));

  /* 对照：选的是开放项目时，一句警告都不该有，也不该算缺项。 */
  await open({ ...withApp, rpc: { my_application: { data: [DRAFT] } } });
  await cdp.ev(`(()=>{const t=document.querySelector('[data-step="3"]'); if(t) t.click(); return !!t;})()`);
  await sleep(400);
  const pr3 = await cdp.ev(`(()=>{const f=document.getElementById("appForm");
    return f ? (f.textContent||"").replace(/\\s+/g," ").trim() : null;})()`);
  ok("Pr3 对照：选的是开放项目时不出现任何警告",
     !/不开放|已停招|退回/.test(pr3 || ""), (pr3 || "").slice(0, 200));
  const prb3 = await cdp.ev(`(()=>{const b=document.querySelector('[data-step="3"]');
    return b ? (b.textContent||"").trim() : null;})()`);
  ok("Pr3b 对照：也不算缺项", !/还差/.test(prb3 || ""), String(prb3));

  /* 课程目录读不到时，不能假装「没有可选项目」，也不能据此说他选的项目无效。 */
  await open({ tables: { ...BASE_TABLES, program_catalog: { data:null, error:{ message:"boom" }, status:500 } },
    rpc: { my_application: { data: [CLOSED_DRAFT] } } });
  await cdp.ev(`(()=>{const t=document.querySelector('[data-step="3"]'); if(t) t.click(); return !!t;})()`);
  await sleep(400);
  const pr4 = await cdp.ev(`(()=>{const f=document.getElementById("appForm");
    return f ? (f.textContent||"").replace(/\\s+/g," ").trim() : null;})()`);
  ok("Pr4 课程目录读不到时明说未知，不假装没有可选项目",
     /没能读到|没读到/.test(pr4 || ""), (pr4 || "").slice(0, 240));
  ok("Pr4b 并且不据此判定他选的项目无效（读不到 ≠ 不开放）",
     !/已停招|不开放/.test(pr4 || ""), (pr4 || "").slice(0, 240));

  // ════════ Ps 选择变了，提示要跟着变（返修 d0b48df）════════
  console.log("\n=== Ps 换成开放项目之后，旧警告不能还挂着 ===");
  /* 那条「已不开放申请…这样提交会被退回」是在 fieldHtml 里渲染的，
     而 fieldHtml 只在 renderStep() 时跑。改了下拉只会走 touch()，
     角标更新了、**警告却原地不动** —— 他明明已经换成开放项目，页面还在说要被退回。
     修的时候不能整段重绘（那会把正在操作的下拉弄失焦），只能换那一块。 */
  const progWarn = async () => cdp.ev(`(()=>{const f=document.getElementById("appForm");
    if(!f) return null; const k=f.cloneNode(true); k.querySelectorAll("[hidden]").forEach(n=>n.remove());
    return (k.textContent||"").replace(/\\s+/g," ").trim();})()`);
  const pickProgram = async (code) => cdp.ev(`(()=>{const el=document.getElementById("fd-programs");
    if(!el) return false; el.focus(); el.value=${JSON.stringify(code)};
    el.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);

  const CLOSED2 = { ...DRAFT, form_data: { ...DRAFT.form_data, programs: ["closed"] } };
  await open({ ...withApp, rpc: { my_application: { data: [CLOSED2] } } });
  await cdp.ev(`(()=>{const t=document.querySelector('[data-step="3"]'); if(t) t.click(); return !!t;})()`);
  await sleep(400);
  ok("Ps0 前提：一开始确实在警告已不开放", /不开放/.test((await progWarn()) || ""));

  ok("Ps0b 前提：换得到一个开放项目", (await pickProgram("bth")) === true);
  await sleep(400);
  const ps1 = await progWarn();
  ok("Ps1 换成开放项目之后，那条警告消失", !/不开放|会被退回/.test(ps1 || ""), (ps1 || "").slice(0, 220));
  ok("Ps1b 而且正在操作的下拉没有失焦",
     (await cdp.ev(`document.activeElement && document.activeElement.id`)) === "fd-programs",
     await cdp.ev(`document.activeElement && document.activeElement.id`));
  const psb = await cdp.ev(`(()=>{const b=document.querySelector('[data-step="3"]');
    return b ? (b.textContent||"").trim() : null;})()`);
  ok("Ps1c 角标也跟着不再算它缺", !/还差/.test(psb || ""), String(psb));

  /* 反过来：清空选择之后，要重新算成缺项，但不能说成「已不开放」。 */
  ok("Ps2-0 前提：清得掉", (await pickProgram("")) === true);
  await sleep(400);
  const ps2 = await progWarn();
  const psb2 = await cdp.ev(`(()=>{const b=document.querySelector('[data-step="3"]');
    return b ? (b.textContent||"").trim() : null;})()`);
  ok("Ps2 清空之后重新算成缺项", /还差 *[1-9]/.test(psb2 || ""), String(psb2));
  ok("Ps2b 但不再说「已不开放」（他现在是没选，不是选了个停招的）",
     !/不开放/.test(ps2 || ""), (ps2 || "").slice(0, 220));

  /* 目录返回非数组真值：判了 !Array.isArray 之后还对原值 .filter 就会当场抛。 */
  pageErrors = [];
  await open({ tables: { ...BASE_TABLES, program_catalog: { data: {}, error: null, status: 200 } },
    rpc: { my_application: { data: [CLOSED2] } } });
  ok("Ps3 课程目录回了非数组真值时，页面不炸",
     !pageErrors.some(e => /TypeError/.test(e)), JSON.stringify(pageErrors.slice(0, 2)));
  /* 那条说明在项目字段旁边，得先翻到第 4 步 —— 页面默认停在第 1 步。 */
  await cdp.ev(`(()=>{const t=document.querySelector('[data-step="3"]'); if(t) t.click(); return !!t;})()`);
  await sleep(400);
  const ps3 = await progWarn();
  ok("Ps3b 并且按「没读到」处理，不假装没有可选项目",
     /没能读到|没读到/.test(ps3 || ""), (ps3 || "").slice(0, 220));

  // ════════ Pm 一份申请只能对应一个项目（0010:55-63 的另一半）════════
  console.log("\n=== Pm 草稿里存了两个项目 ===");
  /* application_validate_program 要求的是三件事：**恰好一项**、在目录里、且开放。
     上一包只做了后两件 —— isBlankField 只看 arr[0] 开不开放。
     于是一份历史草稿 programs=["bth","cert"]：
       · 下拉是单选，只显示 arr[0]，第二个代码**根本看不见**；
       · 数量那一条没人判，这一步显示成已完成；
       · 提交被服务端以 missing:['programs'] 退回，而他看着下拉里明明选着
         一个正常的项目 —— 没有任何东西能解释这次退回。 */
  const MULTI = { ...DRAFT, form_data: { ...DRAFT.form_data, programs: ["bth", "cert"] } };
  await open({ ...withApp, rpc: { my_application: { data: [MULTI] } } });
  await cdp.ev(`(()=>{const t=document.querySelector('[data-step="3"]'); if(t) t.click(); return !!t;})()`);
  await sleep(400);
  const pm0 = await cdp.ev(`(()=>{const el=document.getElementById("fd-programs");
    return el ? el.value : null;})()`);
  ok("Pm0 前提：下拉里只看得见第一个", pm0 === "bth", String(pm0));

  const pmb = await cdp.ev(`(()=>{const b=document.querySelector('[data-step="3"]');
    return b ? (b.textContent||"").trim() : null;})()`);
  ok("Pm1 这一步不能显示成已完成", /还差 *[1-9]/.test(pmb || ""), String(pmb));

  const pm2 = await progWarn();
  ok("Pm2 说清楚存了两个、一份申请只能对应一个",
     /两个|2 个/.test(pm2 || "") && /只能对应一个|只能有一个/.test(pm2 || ""), (pm2 || "").slice(0, 260));
  ok("Pm2b 两个都列出来，不静默丢掉他原来的值",
     /神学本科/.test(pm2 || "") && /证书课程/.test(pm2 || ""), (pm2 || "").slice(0, 260));

  ok("Pm3 给得出一键纠正的入口",
     (await cdp.ev(`!!document.querySelector("[data-progfix]")`)) === true);
  await cdp.ev(`(()=>{const b=document.querySelector("[data-progfix]"); if(b) b.click(); return !!b;})()`);
  await sleep(400);
  const pm3 = await cdp.ev(`(()=>({ n: (window.__lastPrograms||null), warn: (document.querySelector("[data-progwarn]")||{}).textContent||"" }))()`);
  const pm3warn = await progWarn();
  const pmb3 = await cdp.ev(`(()=>{const b=document.querySelector('[data-step="3"]');
    return b ? (b.textContent||"").trim() : null;})()`);
  ok("Pm3b 点了之后警告消失、这一步不再算缺",
     !/只能对应一个/.test(pm3warn || "") && !/还差/.test(pmb3 || ""),
     JSON.stringify({ w: (pm3warn || "").slice(0, 120), b: pmb3 }));

  /* 切换回归：不点那个按钮，直接在下拉里换一个，也要纠正过来。 */
  await open({ ...withApp, rpc: { my_application: { data: [MULTI] } } });
  await cdp.ev(`(()=>{const t=document.querySelector('[data-step="3"]'); if(t) t.click(); return !!t;})()`);
  await sleep(400);
  ok("Pm4-0 前提：一开始仍在警告", /只能对应一个/.test((await progWarn()) || ""));
  await pickProgram("cert");
  await sleep(400);
  const pm4 = await progWarn();
  const pmb4 = await cdp.ev(`(()=>{const b=document.querySelector('[data-step="3"]');
    return b ? (b.textContent||"").trim() : null;})()`);
  ok("Pm4 直接在下拉里换一个，也立刻纠正过来",
     !/只能对应一个/.test(pm4 || "") && !/还差/.test(pmb4 || ""),
     JSON.stringify({ w: (pm4 || "").slice(0, 120), b: pmb4 }));
  ok("Pm4b 而且没有失焦",
     (await cdp.ev(`document.activeElement && document.activeElement.id`)) === "fd-programs");

  /* 对照：正常单个开放项目时，这条警告一句都不该有。 */
  await open({ ...withApp, rpc: { my_application: { data: [DRAFT] } } });
  await cdp.ev(`(()=>{const t=document.querySelector('[data-step="3"]'); if(t) t.click(); return !!t;})()`);
  await sleep(400);
  ok("Pm5 对照：单个开放项目时不出现这条警告",
     !/只能对应一个/.test((await progWarn()) || ""), (await progWarn() || "").slice(0, 160));

  // ════════ Mx 目录成功/失败 × 空/单/多 的小矩阵（返修 1174e62）════════
  console.log("\n=== Mx 数量规则不该被「目录读不到」短路 ===");
  /* programIssue() 把 catalogFailed 放在最前面 return unknown，
     于是两条**根本不需要目录**的规则被一起跳过了：
       · 空数组（他压根没选）—— 这还是相对上一版的退化（上一版是先判空）；
       · 存了多个（一份申请只能对应一个）。
     目录读不到只说明**这一个开不开放无法确认**，不该让数量异常也跟着消失。 */
  const lastPatch = async () => cdp.ev(`(()=>{try{return JSON.parse(sessionStorage.getItem("lastPatch")||"null");}catch(e){return null;}})()`);
  const step4 = async () => {
    await cdp.ev(`(()=>{const t=document.querySelector('[data-step="3"]'); if(t) t.click(); return !!t;})()`);
    await sleep(400);
  };
  const badge4 = async () => cdp.ev(`(()=>{const b=document.querySelector('[data-step="3"]');
    return b ? (b.textContent||"").trim() : null;})()`);
  const CAT_OK = BASE_TABLES;
  const CAT_BAD = { ...BASE_TABLES, program_catalog: { data:null, error:{ message:"boom" }, status:500 } };
  const withPrograms = (arr) => ({ ...DRAFT, form_data: { ...DRAFT.form_data, programs: arr } });

  const cases = [
    ["Mx1 目录成功 × 空",   CAT_OK,  [],              { miss: true,  multi: false, closed: false, unknown: false }],
    ["Mx2 目录成功 × 单",   CAT_OK,  ["bth"],         { miss: false, multi: false, closed: false, unknown: false }],
    ["Mx3 目录成功 × 多",   CAT_OK,  ["bth","cert"],  { miss: true,  multi: true,  closed: false, unknown: false }],
    ["Mx4 目录失败 × 空",   CAT_BAD, [],              { miss: true,  multi: false, closed: false, unknown: true }],
    ["Mx5 目录失败 × 单",   CAT_BAD, ["bth"],         { miss: false, multi: false, closed: false, unknown: true }],
    ["Mx6 目录失败 × 多",   CAT_BAD, ["bth","cert"],  { miss: true,  multi: true,  closed: false, unknown: true }],
  ];
  for (const [name, tables, arr, want] of cases) {
    await open({ tables, rpc: { my_application: { data: [withPrograms(arr)] } } });
    await step4();
    const b = await badge4();
    const t = await progWarn();
    const hasMiss = /还差 *[1-9]/.test(b || "");
    const hasMulti = /只能对应一个/.test(t || "");
    const hasClosed = /不开放|已停招/.test(t || "");
    const hasUnknown = /没能读到|没读到/.test(t || "");
    ok(name, hasMiss === want.miss && hasMulti === want.multi &&
       hasClosed === want.closed && hasUnknown === want.unknown,
       JSON.stringify({ badge: b, miss: hasMiss, multi: hasMulti, closed: hasClosed, unknown: hasUnknown }));
  }

  /* 载荷：光看提示不算数，要看真正写出去的是什么。 */
  await open({ tables: CAT_BAD, rpc: { my_application: { data: [withPrograms(["bth", "cert"])] } } });
  await step4();
  ok("Mx7-0 前提：目录失败 × 多 时给得出纠正入口",
     (await cdp.ev(`!!document.querySelector("[data-progfix]")`)) === true);
  await cdp.ev(`(()=>{const b=document.querySelector("[data-progfix]"); if(b) b.click(); return !!b;})()`);
  await sleep(1400);
  const p7 = await lastPatch();
  ok("Mx7 纠正之后写出去的 programs 是单元素数组",
     !!p7 && p7.form_data && Array.isArray(p7.form_data.programs) &&
     p7.form_data.programs.length === 1, JSON.stringify(p7 && p7.form_data && p7.form_data.programs));

  await open({ tables: CAT_OK, rpc: { my_application: { data: [withPrograms(["bth", "cert"])] } } });
  await step4();
  await pickProgram("cert");
  await sleep(1400);
  const p8 = await lastPatch();
  ok("Mx8 在下拉里改选之后，写出去的就是他选的那一个",
     !!p8 && p8.form_data && JSON.stringify(p8.form_data.programs) === JSON.stringify(["cert"]),
     JSON.stringify(p8 && p8.form_data && p8.form_data.programs));

  // ════════ Rq 补件闭环：找得到要改哪一项（blueprint §6）════════
  console.log("\n=== Rq 收到补件要求之后，得知道改哪个字段 ===");
  /* 0011_requirement_field_unlock：补件条目可以携带 field，review_application 会
     把这些 field 从 locked_fields 里精确移除 —— 也就是「教务专门为这一项给你解了锁」。
     可是申请人这一侧：loadRequirements 连 field 这一列都没取
     （columns: "id,label,detail,resolved,created_at"），renderRequirements 更不会显示。
     于是他看到的只有一行文字，要在六步、四十来个字段里自己找那个「不再是灰的」框。 */
  const NEEDS = { ...DRAFT, status: "needs_information",
    locked_fields: ["name_zh", "birth_ym"] };      // birth_ym 已被这次补件解锁
  const reqRows = (rows) => ({ ...BASE_TABLES, application_requirements: { data: rows } });
  const rqCard = async () => cdp.ev(`(()=>{const c=document.querySelector(".rqlist");
    const box = c && c.closest(".card");
    return box ? (box.textContent||"").replace(/\\s+/g," ").trim() : null;})()`);

  await open({ tables: reqRows([
      { id:"r1", label:"补一份受洗证明", detail:"扫描件即可", field:"baptism_date", resolved:false, created_at:"2026-09-10T00:00:00Z" },
    ]), rpc: { my_application: { data: [{ ...NEEDS, locked_fields: ["name_zh"] }] } } });
  const rq0 = await rqCard();
  ok("Rq0 前提：补件卡片在", /需要补充的资料/.test(rq0 || ""), (rq0 || "").slice(0, 120));
  ok("Rq1 带 field 的条目说得出对应的是哪个字段",
     /受洗日期/.test(rq0 || ""), (rq0 || "").slice(0, 240));
  ok("Rq1b 并说出在第几步",
     /第 *\d+ *步/.test(rq0 || ""), (rq0 || "").slice(0, 240));
  ok("Rq2 给得出「去修改」的入口",
     (await cdp.ev(`!!document.querySelector("[data-gofield]")`)) === true);

  await cdp.ev(`(()=>{const b=document.querySelector("[data-gofield]"); if(b) b.click(); return !!b;})()`);
  await sleep(500);
  const jumped = await cdp.ev(`(()=>{const el=document.getElementById("fd-baptism_date");
    return { there: !!el, disabled: el ? !!el.disabled : null,
             focused: document.activeElement && document.activeElement.id };})()`);
  ok("Rq2b 点了之后确实到了那个字段，而且它是可以改的",
     jumped.there === true && jumped.disabled === false, JSON.stringify(jumped));

  /* 不带 field 的条目（纯文字说明）不该硬造一个字段出来。 */
  await open({ tables: reqRows([
      { id:"r2", label:"请补充一段服事说明", detail:"", field:null, resolved:false, created_at:"2026-09-10T00:00:00Z" },
    ]), rpc: { my_application: { data: [NEEDS] } } });
  const rq3 = await rqCard();
  ok("Rq3 对照：不带 field 的条目不显示字段行，也不给跳转",
     !/对应字段/.test(rq3 || "") &&
     (await cdp.ev(`!document.querySelector("[data-gofield]")`)) === true, (rq3 || "").slice(0, 200));

  /* field 是表单里不认识的名字（表单版本漂移）：照实显示，不瞎猜、不给跳转。 */
  await open({ tables: reqRows([
      { id:"r3", label:"补一项", detail:"", field:"some_unknown_field", resolved:false, created_at:"2026-09-10T00:00:00Z" },
    ]), rpc: { my_application: { data: [NEEDS] } } });
  const rq4 = await rqCard();
  ok("Rq4 字段名在这一版表单里认不出来时，照实说，不乱指一个",
     /some_unknown_field/.test(rq4 || "") && !/第 *\d+ *步/.test(rq4 || ""), (rq4 || "").slice(0, 240));

  /* 该字段仍然锁着：别把人支去点一个灰框。 */
  await open({ tables: reqRows([
      { id:"r5", label:"改一下中文姓名", detail:"", field:"name_zh", resolved:false, created_at:"2026-09-10T00:00:00Z" },
    ]), rpc: { my_application: { data: [{ ...NEEDS, locked_fields: ["name_zh"] }] } } });
  const rq5 = await rqCard();
  ok("Rq5 对应字段仍然锁着时，明说现在改不了、该找谁",
     /锁定|改不了/.test(rq5 || "") && /招生|教务|联系/.test(rq5 || ""), (rq5 || "").slice(0, 240));

  // ════════ Rs 只读状态与非输入框字段（返修 5d02dbe）════════
  console.log("\n=== Rs 只读页不该给「去修改」；非输入框字段要聚焦到真控件 ===");
  /* 提交后真实锁定的就是这七个（0008_applications.sql:251），
     needs_information 时 review_application 只把本次要求的那个 field 摘出去（0011:55-58）。
     用真值，不用我自己编的空锁定表。 */
  const LOCKED_AFTER_SUBMIT = ["name_zh","birth_ym","gender","nationality","conversion_date","baptism_date","programs"];
  const unlockOne = (f) => LOCKED_AFTER_SUBMIT.filter(x => x !== f);
  const reqRows2 = (rows) => ({ ...BASE_TABLES, application_requirements: { data: rows } });
  const appWith = (status, locked) => ({ ...DRAFT, status, locked_fields: locked });
  const REQ_BAPT = [{ id:"rb", label:"补受洗日期", detail:"", field:"baptism_date", resolved:false, created_at:"2026-09-10T00:00:00Z" }];
  const REQ_EDU  = [{ id:"re", label:"补一段学历", detail:"", field:"education", resolved:true, created_at:"2026-09-10T00:00:00Z" }];

  /* ① 只读状态（submitted / accepted）：补件历史要留着，但不能给「去修改」。
     education 不在提交后的锁定表里 —— 上一版正是靠「字段没锁」就发了导航按钮，
     一点就调 buildSteps()，而只读页根本没有 stepBar，当场 TypeError。 */
  for (const st of ["submitted", "accepted"]) {
    pageErrors = [];
    await open({ tables: reqRows2(REQ_EDU),
      rpc: { my_application: { data: [appWith(st, LOCKED_AFTER_SUBMIT)] } } });
    const card = await cdp.ev(`(()=>{const c=document.querySelector(".rqlist");
      const b = c && c.closest(".card"); return b ? (b.textContent||"").replace(/\\s+/g," ").trim() : null;})()`);
    ok("Rs1-" + st + " 只读状态下补件历史仍然看得到", /补一段学历/.test(card || ""), (card || "").slice(0, 160));
    ok("Rs2-" + st + " 但不给「去修改」入口",
       (await cdp.ev(`!document.querySelector("[data-gofield]")`)) === true, String(card).slice(0, 120));
    ok("Rs2b-" + st + " 并说明现在是只读的",
       /只读|不可编辑|已锁定|不能修改/.test(card || ""), (card || "").slice(0, 200));
    /* 就算有人凭空塞一个进来，处理器也不能炸。 */
    await cdp.ev(`(()=>{const c=document.querySelector(".rqlist");
      if(!c) return false; const b=document.createElement("button");
      b.setAttribute("data-gofield","education"); b.textContent="X"; c.appendChild(b); b.click(); return true;})()`);
    await sleep(400);
    ok("Rs3-" + st + " 凭空塞一个 data-gofield 进来点它，也不抛异常",
       !pageErrors.some(e => /TypeError/.test(e)), JSON.stringify(pageErrors.slice(0, 2)));
  }

  /* ② needs_information：真实解锁的那一个可以跳；仍锁的照旧说锁定。 */
  await open({ tables: reqRows2(REQ_BAPT),
    rpc: { my_application: { data: [appWith("needs_information", unlockOne("baptism_date"))] } } });
  ok("Rs4 真实解锁的字段给得出「去修改」",
     (await cdp.ev(`!!document.querySelector('[data-gofield="baptism_date"]')`)) === true);
  await cdp.ev(`(()=>{const b=document.querySelector('[data-gofield="baptism_date"]'); if(b) b.click(); return !!b;})()`);
  await sleep(500);
  ok("Rs4b 跳过去之后那个输入框可编辑且被聚焦",
     (await cdp.ev(`(()=>{const el=document.getElementById("fd-baptism_date");
       return !!el && !el.disabled && document.activeElement === el;})()`)) === true);

  await open({ tables: reqRows2([{ ...REQ_BAPT[0], field:"name_zh" }]),
    rpc: { my_application: { data: [appWith("needs_information", unlockOne("baptism_date"))] } } });
  ok("Rs5 仍在真实锁定表里的字段，照旧说锁定、不给跳转",
     (await cdp.ev(`!document.querySelector("[data-gofield]")`)) === true);

  /* ③ 非输入框的字段：rows / checkboxes / pathway 都没有 fd-<name>，
     承诺了聚焦就得聚焦到**实际可编辑的控件**上。 */
  for (const [f, label] of [["education", "学历"], ["languages", "使用语言"]]) {
    await open({ tables: reqRows2([{ id:"rx", label:"补" + label, detail:"", field:f, resolved:false, created_at:"2026-09-10T00:00:00Z" }]),
      rpc: { my_application: { data: [appWith("needs_information", unlockOne("baptism_date"))] } } });
    ok("Rs6-" + f + " 给得出「去修改」", (await cdp.ev(`!!document.querySelector('[data-gofield="${f}"]')`)) === true);
    await cdp.ev(`(()=>{const b=document.querySelector('[data-gofield="${f}"]'); if(b) b.click(); return !!b;})()`);
    await sleep(500);
    const got = await cdp.ev(`(()=>{const a=document.activeElement;
      if(!a || a===document.body) return null;
      const holder = a.closest && a.closest('[data-f="${f}"]');
      return { tag:a.tagName, inHolder: !!holder, disabled: !!a.disabled };})()`);
    ok("Rs6b-" + f + " 聚焦落在这一组真正能操作的控件上（没有 fd-" + f + " 这种输入框）",
       !!got && got.inHolder === true && got.disabled === false, JSON.stringify(got));
  }

  // ════════ Rc 标记「已补」之前，先把修改落地（blueprint §6 闭环）════════
  console.log("\n=== Rc 勾「已补」不能跑在保存前面 ===");
  /* 补件闭环是「改 → 标记已补 → 重新提交 → 看清结果」。
     可是勾选那一下直接就发 resolve_requirement，**完全不等保存落地**：
     自动保存有 800ms 防抖，他改完马上勾，服务端就把这一项标成已完成了，
     而那次修改可能还没写进去、甚至根本没写成。
     之后他看到的是「已标记完成」，刷新回来却是旧值 —— 这一勾等于替没落地的数据打包票。
     提交那条路早就做了同样的门禁（先 save() 再决定交不交），这里漏了。 */
  const seq = async () => (await cdp.ev(`(()=>{try{return JSON.parse(sessionStorage.getItem("wSeq")||"[]");}catch(e){return [];}})()`)) || [];
  const REQ_ONE = [{ id:"rq1", label:"补受洗日期", detail:"", field:"baptism_date", resolved:false, created_at:"2026-09-10T00:00:00Z" }];
  const NEEDS_ONE = { ...DRAFT, status:"needs_information",
    locked_fields: ["name_zh","birth_ym","gender","nationality","conversion_date","programs"] };
  const editThenTick = async () => {
    /* 走真实闭环：先点那条要求的「去修改」跳过去（baptism_date 在第 2 步，
       页面默认停在第 1 步 —— 不跳过去那个输入框根本不存在）。 */
    await cdp.ev(`(()=>{const b=document.querySelector('[data-gofield="baptism_date"]');
      if(b) b.click(); return !!b;})()`);
    await sleep(400);
    const typed = await cdp.ev(`(()=>{const el=document.getElementById("fd-baptism_date");
      if(!el) return false; el.focus(); el.value="2011-05";
      el.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
    if (!typed) throw new Error("前提不成立：跳过去之后还是找不到 fd-baptism_date");
    await sleep(80);                       // 防抖还没到
    await cdp.ev(`(()=>{const cb=document.querySelector("[data-req]"); if(!cb) return false;
      cb.checked = true; cb.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);
    await sleep(1600);
  };

  // Rc1 保存成功：顺序必须是「先写进去，再标记」
  await open({ tables: { ...BASE_TABLES, application_requirements: { data: REQ_ONE } },
    rpc: { my_application: { data: [NEEDS_ONE] }, resolve_requirement: { data: { ok: true } } } });
  await editThenTick();
  const rcq1 = (await seq()).filter(x => x === "update:applications" || x === "rpc:resolve_requirement");
  ok("Rc1 有未保存的修改时，先把它写进去，再标记已补",
     rcq1.indexOf("update:applications") > -1 &&
     rcq1.indexOf("update:applications") < rcq1.indexOf("rpc:resolve_requirement"), JSON.stringify(rcq1));

  // Rc2 保存明确失败：不能标记
  await open({ tables: { ...BASE_TABLES, application_requirements: { data: REQ_ONE } },
    rpc: { my_application: { data: [NEEDS_ONE] }, resolve_requirement: { data: { ok: true } } },
    writes: { applications: { data:null, error:{ message:"duplicate key value violates unique constraint" }, status:409 } } });
  await editThenTick();
  const rcc2 = await calls();
  ok("Rc2 保存明确失败时，不发标记请求", !(rcc2["rpc:resolve_requirement"] > 0), JSON.stringify(rcc2));
  const rct2 = await cdp.ev(`(()=>{const cb=document.querySelector("[data-req]");
    const t=document.getElementById("amas-toast");
    return { checked: cb ? cb.checked : null, toast: t ? (t.textContent||"").trim() : null };})()`);
  ok("Rc2b 勾回到未勾，并说清楚是因为修改没保存成功",
     rct2.checked === false && /没保存|没有保存|保存/.test(rct2.toast || ""), JSON.stringify(rct2));

  // Rc3 保存结果不明：同样不标记，并如实说不明
  await open({ tables: { ...BASE_TABLES, application_requirements: { data: REQ_ONE } },
    rpc: { my_application: { data: [NEEDS_ONE] }, resolve_requirement: { data: { ok: true } } },
    writes: { applications: { data:null, error:{ message:"Failed to fetch" }, status:0 } } });
  await editThenTick();
  const rcc3 = await calls();
  ok("Rc3 保存结果不明时也不标记", !(rcc3["rpc:resolve_requirement"] > 0), JSON.stringify(rcc3));
  const rct3 = await cdp.ev(`(()=>{const t=document.getElementById("amas-toast");
    return t ? (t.textContent||"").trim() : null;})()`);
  ok("Rc3b 并如实说没能确认", /没能确认|无法确认/.test(rct3 || ""), JSON.stringify(rct3));

  // Rc4 对照：没有未保存修改时，勾选直接标记，不多跑一次保存
  await open({ tables: { ...BASE_TABLES, application_requirements: { data: REQ_ONE } },
    rpc: { my_application: { data: [NEEDS_ONE] }, resolve_requirement: { data: { ok: true } } } });
  await cdp.ev(`(()=>{const cb=document.querySelector("[data-req]"); if(!cb) return false;
    cb.checked = true; cb.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);
  await sleep(1200);
  const rcc4 = await calls();
  ok("Rc4 对照：没有未保存修改时，直接标记（不硬塞一次保存）",
     (rcc4["rpc:resolve_requirement"] || 0) >= 1 && !(rcc4["update:applications"] > 0), JSON.stringify(rcc4));

  // Rc5 委托处理器不能随 render 次数累积
  await open({ tables: { ...BASE_TABLES, application_requirements: { data: REQ_ONE } },
    rpc: { my_application: { data: [NEEDS_ONE] }, resolve_requirement: { data: { ok: true } } } });
  await cdp.ev(`(()=>{ if (window.__renderProbe) return true; return true; })()`);
  /* 勾一次会走 loadRequirements(); render()；再勾不了（已 resolved）。
     改用真实可重复的路径：切步骤不 render，但提交失败会 render。
     这里直接数 main 上的 click 监听器 —— CDP 能拿到真实的监听器表。 */
  const listenerCount = async () => {
    const r = await cdp.send("Runtime.evaluate", { expression: 'document.getElementById("main")', returnByValue: false });
    if (!r.result || !r.result.objectId) return null;
    const l = await cdp.send("DOMDebugger.getEventListeners", { objectId: r.result.objectId });
    return (l.listeners || []).filter(x => x.type === "click").length;
  };
  const before = await listenerCount();
  await cdp.ev(`(()=>{const cb=document.querySelector("[data-req]"); if(!cb) return false;
    cb.checked = true; cb.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);
  await sleep(1400);                       // 这一下会走 render()
  const after = await listenerCount();
  ok("Rc5 render 再跑一次，main 上的 click 监听器没有多出来",
     before !== null && after !== null && after === before, JSON.stringify({ before, after }));

  // ════════ Rd 慢保存期间继续编辑（返修 f161ac9）════════
  console.log("\n=== Rd 标记之前，确认的必须是**最新**那一版 ===");
  /* 上一包加了「勾之前先 await save()」，但 save() 成功时**无条件** dirty = false ——
     保存在途时他又改了一笔，旧响应回来照样清掉 dirty，于是 await 到的是**旧版本**
     的成功，标记却盖在新内容上：新值根本没落地。
     另外 [data-req] 的 change 监听器绑在 bindFieldEvents() 里，而它由 renderStep()
     调用 —— 每切一次步骤就再绑一遍，且用的是全局查询，打在不随步骤重建的补件卡片上。
     所以先点一次「去修改」再勾，一次勾选会发两个 resolve。
     这里用可控闸门按**完成顺序**验，不看调用先后。 */
  const held = async () => cdp.ev(`((window.__held||[]).length)`);
  const release = async (n) => cdp.ev(`(()=>{const q=window.__held||[]; let k=0;
    while (q.length && k < ${n || 1}) { (q.shift())(); k++; } return k;})()`);
  const typeBapt = async (v) => cdp.ev(`(()=>{const el=document.getElementById("fd-baptism_date");
    if(!el) return false; el.focus(); el.value=${JSON.stringify(v)};
    el.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
  const tick = async () => cdp.ev(`(()=>{const cb=document.querySelector("[data-req]"); if(!cb) return false;
    cb.checked = true; cb.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);
  const goFix = async () => { await cdp.ev(`(()=>{const b=document.querySelector('[data-gofield="baptism_date"]');
    if(b) b.click(); return !!b;})()`); await sleep(400); };

  const HOLD_SCEN = { tables: { ...BASE_TABLES, application_requirements: { data: REQ_ONE } },
    rpc: { my_application: { data: [NEEDS_ONE] }, resolve_requirement: { data: { ok: true } } },
    holdWrites: true };

  // Rd1/Rd2/Rd3：闸住保存 → 勾 → 再改 → 放行旧保存 → 仍然不能标记
  await open(HOLD_SCEN);
  await goFix();
  ok("Rd0 前提：改得动那个解锁字段", (await typeBapt("2011-05")) === true);
  /* **不等防抖到点就勾** —— 这样被扣住的写入只有闸门发出的那一次，
     放行谁、等的是谁，才没有歧义。 */
  await sleep(120);
  await tick();
  await sleep(300);
  ok("Rd0b 前提：闸门发出的那一次写入被扣住（且只有这一次）",
     (await held()) === 1, String(await held()));
  const d1 = await calls();
  ok("Rd1 保存还没回来时，标记请求尚未发出", !(d1["rpc:resolve_requirement"] > 0), JSON.stringify(d1));

  await typeBapt("2012-06");                            // 在途期间又改了一笔
  await sleep(200);
  await release(1);                                     // 放行闸门等的那一次（它确认的是旧值）
  await sleep(1200);
  const d2 = await calls();
  ok("Rd2 旧保存回来了，但它确认的不是最新那一版 —— 仍然不标记",
     !(d2["rpc:resolve_requirement"] > 0), JSON.stringify(d2));
  const d3 = await cdp.ev(`(()=>{const cb=document.querySelector("[data-req]");
    const t=document.getElementById("amas-toast");
    return { checked: cb ? cb.checked : null, toast: t ? (t.textContent||"").trim() : null };})()`);
  ok("Rd3 勾回到未勾，并说清楚是「保存没跟上最新修改」",
     d3.checked === false && /最新|又改|还没跟上/.test(d3.toast || ""), JSON.stringify(d3));

  // Rd4：一次勾选只能发一个标记请求（切过步骤也一样）
  await open({ tables: { ...BASE_TABLES, application_requirements: { data: REQ_ONE } },
    rpc: { my_application: { data: [NEEDS_ONE] }, resolve_requirement: { data: { ok: true } } } });
  await goFix();                                        // 切一次步骤（旧代码会重复绑定）
  await cdp.ev(`(()=>{const t=document.querySelector('[data-step="0"]'); if(t) t.click(); return !!t;})()`);
  await sleep(300);
  await tick();
  await sleep(1400);
  const d4 = await calls();
  ok("Rd4 切过步骤之后，一次勾选仍然只发一个标记请求",
     (d4["rpc:resolve_requirement"] || 0) === 1, JSON.stringify(d4));

  // Rd5 对照：闸住 → 勾 → 不再编辑 → 放行 → 正常标记
  await open(HOLD_SCEN);
  await goFix();
  await typeBapt("2013-07");
  await sleep(120);
  await tick();
  await sleep(200);
  await release(1);
  await sleep(1400);
  const d5 = await calls();
  const d5t = await cdp.ev(`(()=>{const t=document.getElementById("amas-toast");
    return t ? (t.textContent||"").trim() : null;})()`);
  ok("Rd5 对照：保存期间没再改的话，放行之后正常标记",
     (d5["rpc:resolve_requirement"] || 0) === 1, JSON.stringify(d5));
  /* 不断言勾还在：夹具里那一行的 resolved 永远是 false，render() 之后必然回到未勾 ——
     那是夹具的静态性质，不是产品行为。看回执文案才是真的。 */
  ok("Rd5b 对照：如实报「已标记完成」", /已标记完成/.test(d5t || ""), JSON.stringify(d5t));

  // ════════ Se 提交这一条路上的同一竞态（blueprint §6 重新提交）════════
  console.log("\n=== Se 提交也得确认「最新那一版」===");
  /* 上一包给 save() 加了 stale，但 submit() 只判 `saved && !saved.ok` ——
     而 stale 那一支是 ok:true。于是同一条竞态在提交上原封不动：
     点提交 → 保存在途 → 他又改了 → 旧保存回来 ok → **照样发 submit_application**，
     交上去的是服务端那份旧的，新改的那一笔还没落地。
     另外自动保存与闸门发出的保存会重叠：旧响应若回写 app.updated_at，版本会**倒退**，
     下一次保存就会被乐观并发判成「别处改过」。 */
  const releaseIdx = async (i) => cdp.ev(`(()=>{const q=window.__held||[];
    if (!q.length) return 0; const f = q.splice(${i}, 1)[0]; if (f) f(); return f ? 1 : 0;})()`);
  const lastMatchOf = async () => cdp.ev(`(()=>{try{return JSON.parse(sessionStorage.getItem("lastMatch")||"null");}catch(e){return null;}})()`);
  const SUB_HOLD = { tables: { ...BASE_TABLES, application_requirements: { data: [] } },
    rpc: { my_application: { data: [{ ...DRAFT, status: "needs_information",
             locked_fields: ["name_zh","birth_ym","gender","nationality","conversion_date","programs"] }] },
           submit_application: { data: { ok: true } } },
    writes: { applications: { autoVersion: true } },
    holdWrites: true };
  const typeCalling = async (v) => cdp.ev(`(()=>{const el=document.getElementById("fd-calling");
    if(!el) return false; el.focus(); el.value=${JSON.stringify(v)};
    el.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
  const goStep = async (i) => { await cdp.ev(`(()=>{const t=document.querySelector('[data-step="${i}"]');
    if(t) t.click(); return !!t;})()`); await sleep(350); };
  const clickSubmitRaw = async () => cdp.ev(`(()=>{const b=document.getElementById("btnSubmit");
    if(b) b.click(); return !!b;})()`);

  await open(SUB_HOLD);
  await goStep(3);                                   // 「异象 / 蒙召」在第 4 步
  ok("Se0 前提：改得动", (await typeCalling("第一版蒙召")) === true);
  await sleep(120);                                  // 不等防抖，直接提交
  await clickSubmitRaw();
  await sleep(300);
  ok("Se0b 前提：提交发出的那一次保存被扣住", (await held()) === 1, String(await held()));
  const se1 = await calls();
  ok("Se1 保存还没回来时，submit_application 尚未发出",
     !(se1["rpc:submit_application"] > 0), JSON.stringify(se1));

  await typeCalling("第二版蒙召");                    // 在途期间又改了
  await sleep(200);
  await release(1);                                  // 只放行那一次旧保存
  await sleep(1400);
  const se2 = await calls();
  ok("Se2 旧保存确认的不是最新那一版 —— 不能就这么交上去",
     !(se2["rpc:submit_application"] > 0), JSON.stringify(se2));
  const se3 = await subErr();
  ok("Se3 并说清楚是「保存没跟上最新修改，这次没有提交」",
     /没有提交|没提交/.test(se3 || "") && /最新|又改|还没跟上/.test(se3 || ""), JSON.stringify(se3));
  ok("Se3b 页面上的新内容还在", (await cdp.ev(`(()=>{const el=document.getElementById("fd-calling");
     return el ? el.value : null;})()`)) === "第二版蒙召");
  ok("Se3c 提交按钮没有被锁死（改完还能再交）",
     (await cdp.ev(`(()=>{const b=document.getElementById("btnSubmit"); return !!b && !b.disabled;})()`)) === true);

  await open(SUB_HOLD);
  await goStep(3);
  await typeCalling("只改这一次");
  await sleep(120);
  await clickSubmitRaw();
  await sleep(300);
  await release(1);
  await sleep(1400);
  const se4 = await calls();
  ok("Se4 对照：没有更新的修改时，放行之后照常提交",
     (se4["rpc:submit_application"] || 0) === 1, JSON.stringify(se4));

  await open(SUB_HOLD);
  await goStep(3);
  await typeCalling("A");
  await sleep(1000);                                 // 防抖 → 保存 A（扣住，版本 1）
  await typeCalling("B");
  await sleep(1000);                                 // 防抖 → 保存 B（扣住，版本 2）
  /* 串行化之后这里只会有**一笔**在途：第二次编辑排在队里，等第一笔落地才发。
     两笔同版本的写入根本不再发生，版本自然也没有倒退的机会。 */
  ok("Se5-0 前提：第一笔写入被扣住", (await held()) === 1, String(await held()));
  ok("Se5-1 上一笔还没回来之前不会再发一笔", (await held()) === 1, String(await held()));
  await release(1);                                  // 放行 A → 接上版本 1
  await sleep(700);
  ok("Se5-2 前一笔落地之后，排队的那一次才发出", (await held()) === 1, String(await held()));
  await release(1);                                  // 放行 B → 版本 2
  await sleep(700);
  await typeCalling("C");
  await sleep(1200);                                 // 防抖 → 保存 C
  const m5 = await lastMatchOf();
  ok("Se5 下一次保存带的是**新**版本号，旧响应没有把它倒退回去",
     !!m5 && m5.updated_at === "2026-09-10T00:00:02Z", JSON.stringify(m5));

  // ════════ Cs 有状态乐观并发：服务端只有一个当前版本 ════════
  console.log("\n=== Cs 同一版本上的两笔保存，服务端只会让一笔命中 ===");
  /* 上一包的 autoVersion 是「每次写入都成功、每次都换个新版本号」——
     那不是乐观并发。真实的 applications 更新带 `updated_at = eq(上次读到的那一版)`，
     命中与否取决于**判定那一刻**服务端上的版本：两笔写带着同一个版本出去，
     只会有一笔命中，另一笔回 0 行。
     这里的夹具把「什么时候判定」和「什么时候把响应交回页面」分开控制，
     所以「谁先命中」与「谁先回来」可以各自摆布。 */
  const CAS = { tables: { ...BASE_TABLES },
    rpc: { my_application: { data: [{ ...DRAFT, status: "needs_information",
             locked_fields: ["name_zh","birth_ym","gender","nationality","conversion_date","programs"] }] },
           submit_application: { data: { ok: true } } },
    cas: { applications: true } };
  const casLen      = async () => cdp.ev(`((window.__cas && window.__cas.q.length) || 0)`);
  const casInflight = async () => cdp.ev(`(()=>{var st=window.__cas; if(!st) return 0; var k=0;
    for (var i=0;i<st.q.length;i++) if(!st.q[i].done) k++; return k;})()`);
  const casBases    = async () => cdp.ev(`(()=>{var st=window.__cas; if(!st) return []; var a=[];
    for (var i=0;i<st.q.length;i++) if(!st.q[i].done) a.push(st.q[i].base); return a;})()`);
  const casApply    = async (i) => cdp.ev(`(window.__casApply ? window.__casApply(${i}) : null)`);
  const casDeliver  = async (i) => cdp.ev(`(window.__casDeliver ? window.__casDeliver(${i}) : 0)`);
  const casLog      = async () => cdp.ev(`((window.__cas && window.__cas.log) || [])`);
  const casVer      = async () => cdp.ev(`((window.__cas && window.__cas.ver) || null)`);
  const casBump     = async () => cdp.ev(`(window.__casBump ? window.__casBump() : null)`);
  /* 把还没回包的都交回去，直到没有新的写入冒出来 —— 串行化之后，
     前一笔落地才会发下一笔，所以要多轮。 */
  const casDrain = async () => { for (let i = 0; i < 8; i++) {
      const n = await cdp.ev(`(()=>{var st=window.__cas; if(!st) return 0; var k=0;
        for (var j=0;j<st.q.length;j++){ if(!st.q[j].done){ window.__casDeliver(j); k++; } } return k;})()`);
      if (!n) break; await sleep(450); } };
  const conflictText = async () => cdp.ev(`(()=>{const b=document.getElementById("conflictBox");
    return b ? (b.textContent||"").replace(/\s+/g," ").trim() : null;})()`);
  const callingVal = async () => cdp.ev(`(()=>{const el=document.getElementById("fd-calling");
    return el ? el.value : null;})()`);

  await open(CAS);
  await goStep(3);
  ok("Cs0 前提：改得动", (await typeCalling("第一版")) === true);
  await sleep(1100);                                  // 防抖 → 第一笔保存发出，卡在服务端
  ok("Cs0b 前提：第一笔保存在途", (await casInflight()) === 1, String(await casLen()));
  await typeCalling("第二版");
  await sleep(1100);
  /* 上一笔还没回来时，app.updated_at 还是老那一版；这时候再发一笔，
     两笔带的是**同一个**基准 —— 服务端必然让其中一笔落空。
     那不是并发冲突，是我们自己造出来的假冲突。 */
  ok("Cs1 上一笔还没落地时，不会拿同一个版本号再发一笔",
     (await casInflight()) === 1, "在途 " + (await casInflight()) + " 笔，基准 " + JSON.stringify(await casBases()));

  /* 让**先发出**的那一笔先命中（版本推进），后发出的那一笔再判定（必然落空）；
     再让落空的那个先回到页面、成功的那个后回。 */
  await casApply(0); await casApply(1);
  await casDeliver(1); await sleep(400);
  await casDeliver(0); await sleep(900);
  await casDrain();
  const csLog = await casLog();
  ok("Cs2 他自己的保存没有一笔在服务端落空",
     csLog.length > 0 && csLog.every(e => e.hit), JSON.stringify(csLog));
  ok("Cs3 没有冒出「在别处被改过」这种假冲突",
     (await conflictText()) === null, JSON.stringify(await conflictText()));
  ok("Cs4 他的第二版还在页面上", (await callingVal()) === "第二版", JSON.stringify(await callingVal()));

  await typeCalling("第三版");
  await sleep(1100);
  const csBase = (await casBases())[0], csVer = await casVer();
  /* 这一条是「已确认的版本被丢掉」的直接判据：成功那一笔确认的新版本如果不接住，
     之后每一次保存都拿着过期版本去比对，会被反复判成「别处改过」——
     用户除了重新载入没有别的出路，而其实根本没有别人改过。 */
  ok("Cs5 下一次保存带的是服务端确认过的最新版本",
     !!csBase && csBase === csVer, "带 " + JSON.stringify(csBase) + "，服务端 " + JSON.stringify(csVer));
  await casDrain();
  ok("Cs6 于是它命中了，页面说的是已保存，而不是叫他重新载入",
     /已保存/.test((await vis("#saveState")) || ""), JSON.stringify(await vis("#saveState")));

  /* 对照一：真的有别处改过时，保护不能被拆掉。 */
  const csVerX = await casBump();
  await typeCalling("第四版");
  await sleep(1100);
  await casDrain();
  const csCf = await conflictText();
  ok("Cs7 对照：别处真的改过时，这一次确定没有保存，并且说清楚了",
     /在别处被改过/.test(csCf || "") && /没有保存/.test(csCf || ""), JSON.stringify(csCf));
  ok("Cs8 对照：冲突时没有把他的编辑冲掉", (await callingVal()) === "第四版", JSON.stringify(await callingVal()));
  ok("Cs9 对照：冲突之后没有自己再写一次（不会拿过期内容盖上去）",
     (await casVer()) === csVerX && (await casLog()).filter(e => !e.hit).length === 1,
     JSON.stringify([await casVer(), csVerX, await casLog()]));

  /* 对照二 / 第二个缺口：迟到的**失败**不能盖掉已经确认的成功。
     这次把判定顺序反过来 —— 后发出的那一笔先命中，先发出的那一笔后判定（落空），
     并且让落空的那个**最后**回到页面。 */
  await open(CAS);
  await goStep(3);
  await typeCalling("甲");
  await sleep(1100);
  await typeCalling("乙");
  await sleep(1100);
  await casApply(1); await casApply(0);
  await casDeliver(1); await sleep(400);
  await casDeliver(0); await sleep(900);
  await casDrain();
  ok("Cs10 迟到的旧响应没有把「已保存」改写成假冲突",
     /已保存/.test((await vis("#saveState")) || "") && (await conflictText()) === null,
     JSON.stringify([await vis("#saveState"), await conflictText()]));
  ok("Cs11 内容也还是他最后改的那一版", (await callingVal()) === "乙", JSON.stringify(await callingVal()));

  // ════════ Cq 前一笔没成功时，排队的那一笔还发不发 ════════
  console.log("\n=== Cq 上一笔没成功，队列不该自己接着写 ===");
  /* 串行化把「排队那次」挂在前一次后面：`saveTail.then(start, start)` ——
     前一笔是 {ok:false} 还是直接 reject，都照样启动下一笔写入。
     于是他在 A 失败**之前**做的那次编辑，会在 A 明确失败（或结果不明）之后
     被自动写出去，中间他没有任何新动作；而 A 的结论对 submit / 已补 这些等待者
     完全不可见 —— 它们拿到的只有后一笔的结论。 */
  const casFail = async (i, status, message, applyFirst) =>
    cdp.ev(`(window.__casFail ? window.__casFail(${i}, ${status}, ${JSON.stringify(message||"boom")}, ${!!applyFirst}) : null)`);
  const saveStateText = async () => vis("#saveState");

  // —— 甲：上一笔**确定**没写进去（别处真的改过 → 0 行冲突）
  await open(CAS);
  await goStep(3);
  ok("Cq0-0 前提：别处那一笔确实改掉了服务端版本",
     (await casBump()) === "2026-09-10T00:00:01Z", JSON.stringify(await casVer()));
  await typeCalling("甲1");
  await sleep(1100);
  ok("Cq0 前提：第一笔在途", (await casInflight()) === 1, String(await casLen()));
  await typeCalling("甲2");                          // 在途期间又改 → 排队
  await sleep(1100);
  await casDeliver(0);                               // A 判定：落空 → 确定没保存
  await sleep(1300);
  ok("Cq1 上一笔确定没保存之后，队列没有在他没做新动作时又写一笔",
     (await casLen()) === 1, "写入 " + (await casLen()) + " 笔，日志 " + JSON.stringify(await casLog()));
  ok("Cq2 冲突的恢复指引还在", /在别处被改过/.test((await conflictText()) || ""), JSON.stringify(await conflictText()));
  ok("Cq3 他最新的编辑还在页面上", (await callingVal()) === "甲2", JSON.stringify(await callingVal()));
  ok("Cq4 并且说清楚这之后的修改也还没保存",
     /还没保存|没有保存/.test((await saveStateText()) || ""), JSON.stringify(await saveStateText()));
  await typeCalling("甲3");                          // **新的**用户动作
  await sleep(1100);
  ok("Cq5 对照：他再改一下，保存还会照常发出（队列没有被卡死）",
     (await casLen()) === 2, "写入 " + (await casLen()) + " 笔");

  // —— 乙：上一笔**结果不明**，而且其实已经写进去了（服务端写成功，响应没回来）
  await open(CAS);
  await goStep(3);
  await typeCalling("乙1");
  await sleep(1100);
  await typeCalling("乙2");                          // 排队
  await sleep(1100);
  await casFail(0, 500, "boom", true);               // 写成功了、版本推进了，但响应是 500
  await casDeliver(0);
  await sleep(1300);
  ok("Cq6 上一笔结果不明时，不自动接着写（未知写入不重试）",
     (await casLen()) === 1, "写入 " + (await casLen()) + " 笔，日志 " + JSON.stringify(await casLog()));
  await casDrain();                                  // 把可能发出的那一笔也放回来，看最终说法
  ok("Cq7 页面说的是「没能确认」，而不是把责任推给「别处被改过」",
     /没能确认/.test((await saveStateText()) || "") &&
     !/在别处被改过/.test(((await saveStateText()) || "") + ((await conflictText()) || "")),
     JSON.stringify([await saveStateText(), await conflictText()]));
  ok("Cq8 他最新的编辑还在页面上", (await callingVal()) === "乙2", JSON.stringify(await callingVal()));

  // —— 丙：等待者（提交）只看得到后一笔的结论
  await open(CAS);
  await goStep(3);
  await typeCalling("丙1");
  await sleep(1100);                                 // A 在途
  await clickSubmitRaw();                            // 提交这一路的 save() 排在 A 后面
  await sleep(400);
  const cq9 = await calls();
  ok("Cq9 前提：保存还没回来时 submit_application 尚未发出",
     !(cq9["rpc:submit_application"] > 0), JSON.stringify(cq9));
  await casFail(0, 500, "boom", true);               // A：结果不明，且其实已落地
  await casDeliver(0);
  await sleep(1000);
  await casDrain();                                  // 后一笔若发出，也让它回来
  await sleep(600);
  ok("Cq10 前一笔结果不明之后，队列没有再写一笔",
     (await casLen()) === 1, "写入 " + (await casLen()) + " 笔，日志 " + JSON.stringify(await casLog()));
  const cq11 = await calls();
  ok("Cq11 没有提交（提交的可能是服务器上那份旧的）",
     !(cq11["rpc:submit_application"] > 0), JSON.stringify(cq11));
  const cq12 = await subErr();
  /* 修前这里说的是「这份申请在别处被改过」—— 那是后一笔落空的结论，
     而改动它的正是他自己那一笔结果不明的写入。等待者要拿到的是**前一笔**的结论。 */
  ok("Cq12 提示是「没能确认、请刷新核实」，不是把责任推给别处",
     /没能确认/.test(cq12 || "") && !/在别处被改过/.test(cq12 || ""), JSON.stringify(cq12));
  ok("Cq13 他填的内容还在", (await callingVal()) === "丙1", JSON.stringify(await callingVal()));

  // —— 丁：上一笔**明确被拒**（权限/校验），确定没写进去
  await open(CAS);
  await goStep(3);
  await typeCalling("丁1");
  await sleep(1100);
  await typeCalling("丁2");                          // 排队
  await sleep(1100);
  await casFail(0, 403, "permission denied");        // 明确拒绝：确定没写进去
  await casDeliver(0);
  await sleep(1300);
  ok("Cq14 前一笔明确被拒之后，队列没有再写一笔",
     (await casLen()) === 1, "写入 " + (await casLen()) + " 笔，日志 " + JSON.stringify(await casLog()));
  ok("Cq15 页面说的是保存失败，且他的编辑还在",
     /保存失败|没有保存|还没保存/.test((await saveStateText()) || "") && (await callingVal()) === "丁2",
     JSON.stringify([await saveStateText(), await callingVal()]));

  // —— 戊：对照，前一笔成功时队列照常继续（串行化本身没有被关掉）
  await open(CAS);
  await goStep(3);
  await typeCalling("戊1");
  await sleep(1100);
  await typeCalling("戊2");
  await sleep(1100);
  await casDeliver(0);                               // A 命中
  await sleep(900);
  ok("Cq16 对照：前一笔成功时，排队那一笔照常发出",
     (await casLen()) === 2, "写入 " + (await casLen()) + " 笔");
  await casDrain();
  ok("Cq17 对照：两笔都命中，页面说已保存",
     (await casLog()).every(e => e.hit) && /已保存/.test((await saveStateText()) || ""),
     JSON.stringify([await casLog(), await saveStateText()]));

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
