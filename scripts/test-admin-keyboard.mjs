// 键盘走**管理端**主线（蓝图 §5 可访问性基线 / §11 P1-23）——
// 招生队列筛选 → 详情 → 「要求补充资料」对话框 → 取消；
// 学籍页 建档入口 → 对话框 → 取消。
// 本地合成 admin + aal2 夹具，**不碰真实账号、不触发任何生产动作**。
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
      getSession: function(){ var u = (window.__SCEN && window.__SCEN.uid) || "u-admin";
        return reply({ data:{ session:{ user:{ id:u }, access_token:"fixture-token" } }, error:null }); },
      signOut: function(){ return reply({}); },
      mfa: { getAuthenticatorAssuranceLevel: function(){
        var l = (window.__SCEN && window.__SCEN.aal) || "aal1";
        return reply({ data:{ currentLevel:l, nextLevel:l }, error:null }); } },
      onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; }
    },
    from: table,
    rpc: function(name, args){
      try { (window.__rpc = window.__rpc || []).push({ name: name, args: args || null }); } catch(e){}
      if (name === "resolve_requirement") return reply({ data:{ ok:true }, error:null, status:200 });
      if (name === "my_roles") return reply({ data:(window.__SCEN && window.__SCEN.roles) || [{ role:"applicant" }], error:null, status:200 });
      if (name === "my_profile") return reply({ data:{ display_name:"测试管理员", email:"a@example.invalid" }, error:null, status:200 });
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

  /* ── 真实按键 ───────────────────────────────────────────────────────── */
  const KEYS = { Tab:{code:"Tab",key:"Tab",vk:9}, Enter:{code:"Enter",key:"Enter",vk:13},
                 Space:{code:"Space",key:" ",vk:32}, ArrowDown:{code:"ArrowDown",key:"ArrowDown",vk:40} };
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
  /** 真实打字：每个字符走 keyDown → char → keyUp，不用 insertText、不直接赋 value。 */
  /* keyDown **不能带 text** —— 带了就等于连同 char 事件输入两遍，
     实测敲出来的是「键键盘盘填填的的」。这是量具的毛病，不是产品的。 */
  const typeText = async (text) => {
    for (const ch of String(text)) {
      const vk = ch.toUpperCase().charCodeAt(0);
      await cdp.send("Input.dispatchKeyEvent", { type:"keyDown", key: ch,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await cdp.send("Input.dispatchKeyEvent", { type:"char", text: ch, key: ch });
      await cdp.send("Input.dispatchKeyEvent", { type:"keyUp", key: ch,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(16);
    }
    await sleep(60);
  };
  /* 日期/月份输入是分段编辑器：只认 keyDown 的数字键，char 事件对它没用。 */
  const typeDigits = async (digits) => {
    for (const d of String(digits)) {
      const vk = 48 + Number(d);
      await cdp.send("Input.dispatchKeyEvent", { type:"rawKeyDown", key: d, code: "Digit" + d,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await cdp.send("Input.dispatchKeyEvent", { type:"keyUp", key: d, code: "Digit" + d,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(30);
    }
    await sleep(60);
  };
  /* 下拉框：一路 ArrowDown 直到真的选中了东西（占位项的 value 是空的）。 */
  const chooseSelect = async (id) => {
    for (let i = 0; i < 4; i++) {
      await press("ArrowDown");
      /* 有些环境下 ArrowDown 不改选中项，再试一次「首字母跳转」。 */
      const v = await cdp.ev(`(()=>{const e=document.getElementById(${JSON.stringify(id)});
        return e?e.value:null;})()`);
      if (v) return v;
    }
    return null;
  };
  const rpcLog = async () => (await cdp.ev(`(window.__rpc || [])`)) || [];
  const rpcOf = async (n) => (await rpcLog()).filter(r => r.name === n);
  const active = async () => cdp.ev(`(()=>{const a=document.activeElement;
    if(!a || a===document.body) return { tag:"BODY" };
    return { tag:a.tagName, id:a.id||"", type:a.type||"", step:a.dataset?a.dataset.step||"":"",
             req:a.dataset?a.dataset.req||"":"", gofield:a.dataset?a.dataset.gofield||"":"",
             attrs:[...a.attributes].map(x=>x.name).filter(n=>/^data-/.test(n)).join(","),
             inRows: !!a.closest('[data-f="education"], [data-f="experience"]'),
             addrow: (a.dataset && a.dataset.addrow) || "", row: (a.dataset && a.dataset.row) || "",
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


  /* ── 本地合成的 admin + aal2 夹具（无真实账号、无生产动作）────────── */
  const APPS = [{ id:"app-1", applicant_id:"u-appl", pathway:"degree", status:"submitted",
    form_data:{ name_zh:"申请人甲", programs:["bth"] }, locked_fields:["name_zh","programs"],
    applicant_visible_message:null, submitted_at:"2026-09-01T00:00:00Z", decided_at:null,
    created_at:"2026-08-20T00:00:00Z", updated_at:"2026-09-01T00:00:00Z", assigned_reviewer:null }];
  const ADMIN = {
    uid:"u-admin", aal:"aal2", roles:[{ role:"registrar" }],
    tables: {
      program_catalog: { data:[{ code:"bth", name_zh:"神学本科", short_label:"B.Th" }] },
      applications: { data: APPS },
      user_roles: { data:[{ user_id:"u-admin", role:"registrar" }] },
      profiles: { data:[{ id:"u-appl", display_name:"申请人甲", email:"x@example.invalid" }] },
      application_internal: { data:{ notes:"", updated_at:null } },
      application_requirements: { data: [] },
      application_status_history: { data: [] },
      application_hq_approvals: { data: [] },
      student_records: { data: [] },
    },
    rpc: { admissions_ready_for_enrollment: { data:[{ application_id:"app-1", applicant_id:"u-appl",
             display_name:"申请人甲", email:"x@example.invalid", program_code:"bth", pathway:"degree",
             approval_reference:"HQ-1", confirmed_at:"2026-09-05T00:00:00Z" }] },
           pending_number_void_requests: { data: [] } },
    write: OKW };
  const openAdmin = async (path) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(ADMIN) + ";" });
    await cdp.send("Page.navigate", { url: `${BASE}${path}` });
    await sleep(3000);
  };
  const inModal = async () => cdp.ev(`(()=>{const a=document.activeElement;
    return !!(a && a.closest && a.closest(".portal-modal"));})()`);
  const modalUp = async () => cdp.ev(`!!document.querySelector(".portal-modal")`);
  const pressEsc = async () => {
    await cdp.send("Input.dispatchKeyEvent", { type:"rawKeyDown", key:"Escape", code:"Escape",
      windowsVirtualKeyCode:27, nativeVirtualKeyCode:27 });
    await cdp.send("Input.dispatchKeyEvent", { type:"keyUp", key:"Escape", code:"Escape",
      windowsVirtualKeyCode:27, nativeVirtualKeyCode:27 });
    await sleep(300);
  };

  console.log("\n=== Ad 招生台：队列筛选 → 详情 → 补件对话框 → 取消（全程按键）===");
  await openAdmin("/portal/admin/admissions/");
  ok("Ad0 前提：admin+aal2 夹具下页面渲染出来了（不是被守卫挡住）",
     (await cdp.ev(`!!document.getElementById("list") || /申请/.test(document.body.textContent||"")`)) === true,
     (await cdp.ev(`(document.body.textContent||"").replace(/\s+/g," ").trim().slice(0,80)`)));
  const f1 = await tabUntil(a => a.id === "fSt" || a.id === "fPw" || a.id === "fQ", 30);
  ok("Ad1 Tab 走得到队列的筛选控件", f1.hit, JSON.stringify(f1.at));
  const openRow = await tabUntil(a => (a.attrs || "").indexOf("data-open") > -1 ||
    /查看|详情/.test(a.text || ""), 40);
  ok("Ad2 Tab 走得到某一行的「查看」入口", openRow.hit, JSON.stringify(openRow.at));
  await press("Enter");
  await sleep(800);
  ok("Ad3 Enter 打开了详情", (await cdp.ev(`(document.body.textContent||"").indexOf("申请人甲") > -1`)) === true);
  const reqBtn = await tabUntil(a => /要求补充/.test(a.text || ""), 60);
  ok("Ad4 Tab 走得到「要求补充资料」", reqBtn.hit, JSON.stringify(reqBtn.at));
  await press("Enter");
  await sleep(700);
  ok("Ad5 Enter 打开了补件对话框", (await modalUp()) === true);
  ok("Ad6 对话框打开后，焦点进到对话框里（不是留在后面那一页）", (await inModal()) === true,
     JSON.stringify(await active()));
  await pressEsc();
  ok("Ad7 Esc 关得掉这个对话框", (await modalUp()) === false);
  const afterEsc = await active();
  /* 只有在对话框**确实关掉了**的前提下，这一条才说明得了问题；
     否则焦点本来就没动过，是白给的绿。 */
  ok("Ad8 关掉之后焦点回到打开它的那个按钮上（不是掉回页首）",
     (await modalUp()) === false && /要求补充/.test(afterEsc.text || ""), JSON.stringify(afterEsc));

  console.log("\n=== St 学籍页：建档入口 → 对话框 → 取消（全程按键）===");
  await openAdmin("/portal/admin/students/");
  ok("St0 前提：学籍页渲染出来了",
     (await cdp.ev(`/学籍|建档|待建档/.test(document.body.textContent||"")`)) === true,
     (await cdp.ev(`(document.body.textContent||"").replace(/\s+/g," ").trim().slice(0,80)`)));
  /* 上一版用「建档」两个字去找，结果先撞上标签页「待建档」——那是我的定位错。
     真正的入口是每行的 data-create（「建立学籍」）。 */
  const enrol = await tabUntil(a => (a.attrs || "").indexOf("data-create") > -1, 60);
  ok("St1 Tab 走得到那一行的「建立学籍」", enrol.hit, JSON.stringify(enrol.at));
  await press("Enter");
  await sleep(700);
  ok("St2 Enter 打开了建档对话框", (await modalUp()) === true);
  ok("St3 对话框打开后焦点进到里面", (await inModal()) === true, JSON.stringify(await active()));
  /* 这个对话框里**没有**标了 required 的字段（建档的必填由服务端判），
     所以「必填定位」在这里退化成「第一个可填字段就是焦点落点」——
     如实按这个判，不拿一个不存在的 required 去制造失败。 */
  const first = await cdp.ev(`(()=>{const i=document.querySelector(".portal-modal input");
    return i ? { id:i.id, required:i.required, focused: document.activeElement === i } : null;})()`);
  ok("St4 第一个可填字段就是焦点落点（他一上来就能填）",
     !!first && first.focused === true, JSON.stringify(first));
  const stWasUp = await modalUp();
  await pressEsc();
  ok("St5 Esc 关得掉", stWasUp === true && (await modalUp()) === false, "开着=" + stWasUp);
  ok("St6 关掉之后焦点没掉回页首",
     stWasUp === true && (await active()).tag !== "BODY", JSON.stringify(await active()));

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
