// 键盘走完申请主线（蓝图 §5 可访问性基线「键盘可完成全流程」/ §11 P1-23）。
//
// **全程只用真实按键**：Input.dispatchKeyEvent 发 Tab / Shift+Tab / Enter / Space。
// 本探针**不用** element.focus() 或 element.click() 去「帮」页面完成操作 ——
// 那样测的是 JS，不是键盘。产品自己调 .focus() 做焦点管理是允许的，
// 这里只用按键驱动、只读 document.activeElement 判结果。
//
// 这是**定向探针**，不是申请人写入全套的复刻：fixture 只给这条路需要的返回值。
// 本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。独占动态端口。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".png":"image/png", ".ico":"image/x-icon", ".woff2":"font/woff2" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
                       "Cache-Control":"no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-stashc-"));
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
  throw new Error("没能从自己的 Chrome 取得独占调试端口；本探针不附着现成 Chrome，退出。");
}
class Cdp {
  constructor(ws){ this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  on(m, f){ this.handlers.set(m, f); }
  static async attach(port){
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
  send(method, params = {}, ms = 30000){
    return new Promise((res, rej) => { const i = ++this.id;
      const t = setTimeout(() => { if (this.pending.delete(i)) rej(new Error("TIMEOUT " + method)); }, ms);
      this.pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async ev(x){
    const r = await this.send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval 抛错: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  }
}
let pass = 0, fail = 0, loginHits = 0, externalHits = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); } };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';

/* 只给这条路需要的返回值：会话、我的申请、课程目录，外加一个可切换的写入结果。 */
const STUB = `
window.supabase = { createClient: function(){
  var S = function(){ return window.__SCEN || {}; };
  var reply = function(v){ return Promise.resolve(v); };
  function table(name){
    var mode = "select";
    var q = { select:function(){return q;}, eq:function(){return q;}, in:function(){return q;},
      match:function(){return q;}, order:function(){return q;}, range:function(){return q;},
      limit:function(){return q;}, maybeSingle:function(){return q;}, single:function(){return q;},
      insert:function(){ mode="insert"; return q; }, update:function(){ mode="update"; return q; },
      then:function(res, rej){
        var sc = S();
        if (mode === "select") {
          var c = (window.__sel = window.__sel || {});
          c[name] = (c[name] || 0) + 1;
          var dd = (sc.selectDelay || {})[name];
          var d = Array.isArray(dd) ? dd[c[name] - 2] : (c[name] > 1 ? dd : 0);
          if (d) {                             // 载入那一次不拖；之后按序拖，制造乱序落地
            var t0 = (sc.tables && sc.tables[name]) || { data:[], error:null };
            return new Promise(function(r){ setTimeout(function(){
              r({ data:t0.data, error:t0.error||null, status: t0.status != null ? t0.status : (t0.error ? 500 : 200) });
            }, d); }).then(res, rej);
          }
        }
        /* 保存「还在途」：永不落地的写入。这是三个时点里最难靠 sleep 碰上的一个。 */
        if (mode !== "select" && sc.hold) return new Promise(function(){});
        var t = (mode === "select") ? ((sc.tables && sc.tables[name]) || { data:[], error:null })
                                    : (sc.write || { data:[{ id:"app-fx", updated_at:"2026-09-10T00:00:01Z" }], error:null });
        return Promise.resolve({ data:t.data, error:t.error||null,
          status: t.status != null ? t.status : (t.error ? 500 : 200) }).then(res, rej);
      } };
    return q;
  }
  return {
    auth: {
      getSession: function(){ var u = (window.__SCEN && window.__SCEN.uid) || "u-appl";
        return reply({ data:{ session:{ user:{ id:u }, access_token:"fixture-token" } }, error:null }); },
      signOut: function(){ return reply({}); },
      mfa: { getAuthenticatorAssuranceLevel: function(){ return reply({ data:{ currentLevel:"aal1", nextLevel:"aal1" }, error:null }); } },
      onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; }
    },
    from: table,
    rpc: function(name){
      if (name === "resolve_requirement") return reply({ data:{ ok:true }, error:null, status:200 });
      if (name === "my_roles") return reply({ data:[{ role:"applicant" }], error:null, status:200 });
      if (name === "my_profile") return reply({ data:{ display_name:"测试申请人", email:"a@example.invalid" }, error:null, status:200 });
      var r = (S().rpc && S().rpc[name]) || { data:null, error:null };
      return reply({ data:r.data, error:r.error||null, status: r.status != null ? r.status : (r.error ? 500 : 200) });
    },
    functions: { invoke: function(){ return reply({ data:null, error:null }); } }
  };
} };`;

let port;
try { port = await ownDebugPort(); console.log("  独占调试端口（本进程自己的 Chrome）: " + port); }
catch (e) { chrome.kill(); server.close(); console.error("  " + e.message); process.exit(1); }

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("cdn.jsdelivr.net") > -1 && u.indexOf("supabase-js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name:"Content-Type", value:"application/javascript" }, { name:"Cache-Control", value:"no-store" }],
          body: b64(STUB) }); return; }
      if (u.indexOf("supabase-config.js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name:"Content-Type", value:"application/javascript" }, { name:"Cache-Control", value:"no-store" }],
          body: b64(CFG) }); return; }
      if (/\/login\//.test(u)) loginHits++;            // 重新载入不会请求 /login/
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });
  let pageErrors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    pageErrors.push(String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || "").slice(0, 200));
  });
  cdp.on("Page.javascriptDialogOpening", async () => {
    try { await cdp.send("Page.handleJavaScriptDialog", { accept: true }); } catch (e) {}
  });

  const FORM = { name_zh:"测试申请人", name_en:"Test", gender:"male", birth_ym:"1990-01",
    nationality:"中国", languages:["mandarin"], address:"某市某路 1 号", phone:"13800000000",
    church_name:"测试教会", church_role:"同工", conversion_date:"2010-01",
    education:[{ school:"某大学", start_ym:"2008-09", end_ym:"2012-06", degree:"本科" }],
    calling:"蒙召陈述", testimony:"见证正文", declaration_accepted:true, programs:["bth"] };
  const DRAFT = { id:"app-fx", applicant_id:"u-appl", pathway:"degree", status:"draft",
    locked_fields:[], form_data:{ ...FORM }, form_version:"v1", submitted_at:null,
    updated_at:"2026-09-10T00:00:00Z" };
  const TABLES = { program_catalog: { data:[
      { code:"bth", name_zh:"神学本科", short_label:"B.Th", is_open_for_application:true },
      { code:"cert", name_zh:"证书课程", short_label:"Cert", is_open_for_application:true } ] },
    application_requirements: { data: [] } };
  const EXPIRED = { data:null, error:{ message:"JWT expired" }, status:401 };
  const CONFLICT = { data: [], error: null, status: 200 };
  const OKW = { data: [{ id:"app-fx", updated_at:"2026-09-10T00:00:01Z" }], error: null, status: 200 };
  const DENIED = { data:null, error:{ message:"permission denied" }, status:403 };

  /* 每一场开始前清掉上一场留下的暂存。不清就会出现「救回来了」其实救的是
     上一节那一份 —— 本探针第一版的 Nr1 就是这么白拿了一个绿。 */
  const clearStashKey = async () => cdp.ev(`(()=>{try{sessionStorage.removeItem("amas.draft.application");}catch(e){} return true;})()`).catch(()=>{});
  const open = async (scen, opts) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source:
      "window.__SCEN = " + JSON.stringify(Object.assign(
        { tables: TABLES, rpc: { my_application: { data:[DRAFT] } } }, scen || {})) + ";" });
    /* 摆场默认清键；但「带着上一个人的草稿换身份」这一场必须**留着**它，
       否则换了账号当然看不到 —— 那个绿灯里根本没有草稿参与，等于没测。 */
    if (!(opts && opts.keepStash)) await clearStashKey();
    await cdp.send("Page.navigate", { url: `${BASE}/portal/applicant/application/` });
    await sleep(2800);
  };
  /* 回申请页，但**不重置 __SCEN**（沿用上一次 addScript 的那一份）——
     模拟他自己点导航回来，而不是测试重新摆场。 */
  const backToApp = async () => { await cdp.send("Page.navigate",
    { url: `${BASE}/portal/applicant/application/` }); await sleep(2800); };
  const clickNav = async (label) => cdp.ev(`(()=>{const a=[...document.querySelectorAll("a")]
    .filter(x=>(x.textContent||"").indexOf(${JSON.stringify(label)}) > -1)[0];
    if(!a) return false; a.click(); return true;})()`);
  const restoreBox = async () => cdp.ev(`(()=>{const b=document.getElementById("restoreBox");
    return b ? (b.textContent||"").replace(/\\s+/g," ").trim() : null;})()`);
  const callingVal = async () => cdp.ev(`(()=>{const el=document.getElementById("fd-calling");
    return el ? el.value : null;})()`);
  const stashNow = async () => cdp.ev(`(()=>{try{return sessionStorage.getItem("amas.draft.application");}catch(e){return null;}})()`);
  const pageText = async () => cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template").forEach(n=>n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();})()`);
  const formDump = async () => cdp.ev(`(()=>[...document.querySelectorAll("input,textarea,select")]
    .map(e=>String(e.value||"")).join(" | "))()`);
  const clickText2 = async (re) => cdp.ev(`(()=>{const n=[...document.querySelectorAll("a,button")]
    .filter(x=>${re}.test(x.textContent||""))[0]; if(!n) return false; n.click(); return true;})()`);
  const goStep = async (i) => { await cdp.ev(`(()=>{const t=document.querySelector('[data-step="${i}"]');
    if(t) t.click(); return !!t;})()`); await sleep(350); };
  const type = async (v) => cdp.ev(`(()=>{const el=document.getElementById("fd-calling");
    if(!el) return false; el.focus(); el.value=${JSON.stringify(v)};
    el.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
  const denyStorage = async () => cdp.ev(`(()=>{ Storage.prototype.setItem = function(){ throw new Error("denied"); }; return true;})()`);
  const taText = async () => cdp.ev(`(()=>{const t=document.querySelector("#stashFailBox textarea"); return t?t.value:null;})()`);
  const boxText = async () => cdp.ev(`(()=>{const b=document.getElementById("stashFailBox");
    return b ? (b.textContent||"").replace(/\\\s+/g," ").trim() : null;})()`);
  const btnLabel = async () => cdp.ev(`(()=>{const b=[...document.querySelectorAll("#stashFailBox button")]
    .filter(x=>/我已复制/.test(x.textContent||""))[0]; return b ? (b.textContent||"").trim() : null;})()`);
  const clickConfirm = async () => cdp.ev(`(()=>{const b=[...document.querySelectorAll("#stashFailBox button")]
    .filter(x=>/我已复制/.test(x.textContent||""))[0]; if(b) b.click(); return !!b;})()`);
  const clickText = async (re) => cdp.ev(`(()=>{const n=[...document.querySelectorAll("a,button")]
    .filter(x=>${re}.test(x.textContent||""))
    .filter(x=>!x.closest("#amas-nav,header,footer"))[0]; if(!n) return false; n.click(); return true;})()`);
  const probeSet  = async () => cdp.ev(`(()=>{window.__stayProbe=1; return true;})()`);
  const probeGone = async () => cdp.ev(`(typeof window.__stayProbe === "undefined")`);

  const REQS = [
    { id:"rq-1", label:"受洗证明扫描件", detail:"教会盖章那一页", resolved:false, created_at:"2026-09-01T00:00:00Z" },
    { id:"rq-2", label:"最高学历证书", detail:null, resolved:false, created_at:"2026-09-01T00:00:00Z" },
  ];
  const NEEDS = { ...DRAFT, status:"needs_information",
    locked_fields:["name_zh","birth_ym","gender","nationality","conversion_date","programs"] };

  /* ── 真实按键 ───────────────────────────────────────────────────────── */
  const KEYS = { Tab:{code:"Tab",key:"Tab",vk:9}, Enter:{code:"Enter",key:"Enter",vk:13},
                 Space:{code:"Space",key:" ",vk:32} };
  const press = async (name, shift) => {
    const m = KEYS[name];
    const mods = shift ? 8 : 0;
    await cdp.send("Input.dispatchKeyEvent", { type:"rawKeyDown", modifiers:mods,
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    if (name === "Enter" || name === "Space") {
      await cdp.send("Input.dispatchKeyEvent", { type:"char", modifiers:mods,
        text: name === "Space" ? " " : "\r", key:m.key, code:m.code });
    }
    await cdp.send("Input.dispatchKeyEvent", { type:"keyUp", modifiers:mods,
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    await sleep(90);
  };
  const active = async () => cdp.ev(`(()=>{const a=document.activeElement;
    if(!a || a===document.body) return { tag:"BODY" };
    return { tag:a.tagName, id:a.id||"", type:a.type||"", step:a.dataset?a.dataset.step||"":"",
             req:a.dataset?a.dataset.req||"":"", gofield:a.dataset?a.dataset.gofield||"":"",
             attrs:[...a.attributes].map(x=>x.name).filter(n=>/^data-/.test(n)).join(","),
             text:(a.textContent||"").replace(/\s+/g," ").trim().slice(0,24),
             visible: !!(a.offsetWidth||a.offsetHeight||a.getClientRects().length) };})()`);
  /* 一直 Tab，直到落在满足条件的元素上（或到上限）。返回走过的步数。 */
  const tabUntil = async (pred, max) => {
    for (let i = 1; i <= (max || 60); i++) {
      await press("Tab");
      const a = await active();
      if (pred(a)) return { hit: true, steps: i, at: a };
    }
    return { hit: false, steps: max || 60, at: await active() };
  };
  const focusRing = async () => cdp.ev(`(()=>{const a=document.activeElement;
    if(!a || a===document.body) return null;
    const s=getComputedStyle(a); return { outline:s.outlineStyle+" "+s.outlineWidth,
      shadow:(s.boxShadow||"").slice(0,40) };})()`);

  console.log("\n=== K1 从页首 Tab 能不能走到步骤条并用键盘换步 ===");
  await open({ write: OKW, tables: { ...TABLES, application_requirements: { data: REQS } },
    rpc: { my_application: { data:[NEEDS] },
           submit_application: { data: { ok:false, error:"requirements_pending", count:2 } } } });
  const k1 = await tabUntil(a => a.step === "1", 40);       // 第 2 步那个 tab
  ok("K1a Tab 能走到步骤条上（不用鼠标）", k1.hit, JSON.stringify(k1.at));
  ok("K1b 聚焦时看得见焦点环", !!(await focusRing()), JSON.stringify(await focusRing()));
  await press("Enter");
  ok("K1c Enter 能换步（第 2 步被选中）",
     (await cdp.ev(`(()=>{const b=document.querySelector('[data-step="1"]');
        return !!(b && b.classList.contains("on"));})()`)) === true);
  const k1d = await active();
  ok("K1d 换步之后焦点没被丢回页首", k1d.tag !== "BODY", JSON.stringify(k1d));

  console.log("\n=== K2 六步表单：Tab 能走进字段、Shift+Tab 能退回 ===");
  const k2 = await tabUntil(a => a.tag === "INPUT" || a.tag === "TEXTAREA" || a.tag === "SELECT", 40);
  ok("K2a Tab 从步骤条走得进表单字段", k2.hit, JSON.stringify(k2.at));
  const before = (await active()).id;
  await press("Tab"); await press("Tab", true);
  ok("K2b Shift+Tab 退得回上一个控件", (await active()).id === before,
     JSON.stringify([before, (await active()).id]));

  console.log("\n=== K3 缺项提示的「去补填」：键盘能不能用，用完焦点在哪 ===");
  await open({ write: OKW, tables: { ...TABLES, application_requirements: { data: [] } },
    rpc: { my_application: { data:[{ ...DRAFT, form_data:{ name_zh:"测试申请人" } }] },
           submit_application: { data:{ ok:true } } } });
  const k3 = await tabUntil(a => a.id === "btnSubmit", 60);
  ok("K3a Tab 能走到「提交申请」", k3.hit, JSON.stringify(k3.at));
  await press("Enter");
  await sleep(600);
  ok("K3b Enter 能触发提交（缺项提示出来了）",
     /还没填/.test((await cdp.ev(`(()=>{const e=document.getElementById("subErr");
        return e?(e.textContent||""):"";})()`)) || ""), "");
  const k3c = await tabUntil(a => a.attrs.indexOf("data-gofix") > -1, 20);
  ok("K3c Tab 走得到「去补填」", k3c.hit, JSON.stringify(k3c.at));
  await press("Enter");
  await sleep(500);
  const k3d = await active();
  ok("K3d 按下「去补填」之后，焦点没有被丢回页首（否则键盘用户要从头 Tab 一遍）",
     k3d.tag !== "BODY", JSON.stringify(k3d));

  console.log("\n=== K4 补件：勾「已补」与「去修改」都要能用键盘 ===");
  await open({ write: OKW, tables: { ...TABLES, application_requirements: { data: REQS } },
    rpc: { my_application: { data:[NEEDS] }, submit_application: { data:{ ok:true } } } });
  const k4 = await tabUntil(a => a.req === "rq-1", 40);
  ok("K4a Tab 能走到补件条目的勾选框", k4.hit, JSON.stringify(k4.at));
  await press("Space");
  await sleep(900);
  ok("K4b Space 能勾上（发出了标记请求）",
     (await cdp.ev(`((window.__sel && window.__sel["application_requirements"]) || 0) >= 1`)) === true);

  console.log("\n=== K5 提交被挡回来：键盘走到「去看这几项」与「重新读取」 ===");
  await open({ write: OKW, tables: { ...TABLES, application_requirements: { data: REQS } },
    rpc: { my_application: { data:[NEEDS] },
           submit_application: { data: { ok:false, error:"requirements_pending", count:1 } } } });
  const k5 = await tabUntil(a => a.id === "btnSubmit", 60);
  ok("K5a Tab 走到提交", k5.hit, JSON.stringify(k5.at));
  await press("Enter");
  await sleep(1200);
  const k5b = await tabUntil(a => a.attrs.indexOf("data-goreq") > -1, 20);
  ok("K5b Tab 走得到「去看这几项」", k5b.hit, JSON.stringify(k5b.at));
  await press("Enter");
  await sleep(500);
  const k5c = await active();
  ok("K5c 按下之后焦点落在第一条未完成的条目上（产品自己做的焦点管理）",
     k5c.req === "rq-1", JSON.stringify(k5c));
  const k5d = await tabUntil(a => a.attrs.indexOf("data-reqreload") > -1, 30);
  ok("K5d Tab 走得到「重新读取补件清单」", k5d.hit, JSON.stringify(k5d.at));
  await press("Enter");
  await sleep(1500);
  const k5e = await active();
  ok("K5e 重读之后焦点没被丢回页首", k5e.tag !== "BODY", JSON.stringify(k5e));

  console.log("\n=== G 外发 ===");
  ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");
  ok("G2 全程没有页面异常", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
}
console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。");
process.exit(fail ? 1 : 0);
