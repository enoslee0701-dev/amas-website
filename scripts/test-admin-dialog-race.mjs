// 建档对话框的错误呈现（Ce）与**在途回执的确定性并发**（Dl）。
//
// 监督对上一版 Dl 的判语（DEFERRED，不接受「没有问题」）：
//   2500ms 定时回执 + 键盘多步 + 700/1200ms 等待，**证明不了**
//   「新框先开、旧回执后到」；Dl1 只看 modalUp 不证明 POST 已发出，
//   Dl5 也不证明回执**已被前端消费**。
// 所以这一版换成**扣住 / 手动放行**：
//   POST 真的到达 → 记下 requestId 并**扣住不回**（可断言「确实有一笔待放行」）
//   → 打开新框、把字打进去 → **手动放行**那一笔
//   → **等到前端确实消费了这条回执**（可观察的完成信号，不是 sleep）
//   → 再断言新框的身份 / 输入 / 焦点一个都没变。
// 缺入口就记 FAIL / INCOMPLETE，绝不让套件整体绿过去。
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
/* Edge 调用**不走 SDK**：auth.js 的 callFn 是裸 fetch 打
   SUPA.url + "/functions/v1/<name>"（auth.js:756），页面里的 stub 拦不到它。
   所以要在**拦截层**接住。两件事必须分清，上一版都错了：

   ① 跨域 + 自定义头（apikey / Authorization）会先发 **OPTIONS 预检**。
      上一版把**所有** /functions/v1/ 请求一律计数 —— 于是那个「确认之后 +1」
      数到的其实是**预检**，不是写入；监督拿 body 去核对时 body 是 null，
      直接 TypeError。**预检不算写入。**
   ② 上一版 fulfill 时**没有回 CORS 头**，真正的 POST 会被浏览器拦下 ——
      等于写请求根本没发出去，那个 +1 更加不作数。

   现在：OPTIONS 回 204 + CORS 头且**不计数**；POST 回 200 + CORS 头并**记下
   method / url / body**。只有 POST 才算写入。全程 fulfill，不外发。 */
let edgeCalls = [];
/* 按**真实契约**合成失败，不是随手编一个码：
   0012_student_core.sql 的 create_student_record 返回
   {ok:false, error:'student_number_taken' | 'student_already_exists' | 'hq_approval_required'}，
   而 student-lifecycle/index.ts:149 把 RPC 的 JSON **原样透传**（HTTP 200）。
   上一包我用的是 409 + number_taken —— 码名错、状态码也错，
   于是走的是 Api.fn 的通用错误分支，页面只会说「操作未能完成」。 */
let edgeReject = false;
/* 扣住模式：POST 到达后**不回**，把 requestId 记下来，由测试显式放行。
   这比「延迟 N 毫秒」确定得多 —— 放行之前它一定没回，放行之后才有可能回。 */
let edgeHold = false;
let heldEdge = [];
let nativeDialogs = [];   // 浏览器原生 alert/confirm（阻塞式，键盘用户无处可去）
const CORS = [
  { name: "Access-Control-Allow-Origin", value: "*" },
  { name: "Access-Control-Allow-Headers", value: "authorization,apikey,content-type,x-client-info" },
  { name: "Access-Control-Allow-Methods", value: "POST,OPTIONS" },
];
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
    functions: { invoke: function(name, opts){
      try { (window.__rpc = window.__rpc || []).push({ name: "fn:" + name, args: (opts && opts.body) || null }); } catch(e){}
      return reply({ data:null, error:null }); } }
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
      if (u.indexOf("/functions/v1/") > -1) {
        const method = (ev.request.method || "").toUpperCase();
        if (method === "OPTIONS") {                 // 预检：放行，但**不算写入**
          await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 204,
            responseHeaders: CORS });
          return;
        }
        let body = null;
        try { body = ev.request.postData || null; } catch (e) {}
        edgeCalls.push({ method, url: u, body });    // 只有真正的 POST 才记账
        const payload = edgeReject ? { ok: false, error: "student_number_taken" } : { ok: true };
        const send = async () => {
          try {
            await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
              responseHeaders: CORS.concat([{ name:"Content-Type", value:"application/json" }]),
              body: b64(JSON.stringify(payload)) });
          } catch (e) {}
        };
        if (edgeHold) { heldEdge.push({ requestId: ev.requestId, url: u, body, send }); return; }
        await send();
        return;
      }
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });
  let pageErrors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    pageErrors.push(String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || "").slice(0, 200));
  });
  cdp.on("Page.javascriptDialogOpening", async (p) => {
    nativeDialogs.push({ type: (p && p.type) || "", msg: (p && p.message) || "" });
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
      applications: { data: APPS },   // 「待记录总校确认」那一栏也用它
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


  /* ── 通用小工具 ─────────────────────────────────────────────────────── */
  const postCount = () => edgeCalls.filter(c => c.method === "POST").length;
  const lastPost = () => edgeCalls.filter(c => c.method === "POST").slice(-1)[0] || null;
  const numVal = async () => cdp.ev(`(()=>{const i=document.querySelector('.portal-modal [data-f="num"]');
    return i ? i.value : null;})()`);
  const dialogTitle = async () => cdp.ev(`(()=>{const h=document.querySelector(".portal-modal .pm-card h3");
    return h ? (h.textContent||"").trim() : null;})()`);
  /* 给这一个对话框实例打个记号：新旧框是不是同一个，靠它，不靠「看起来还开着」。 */
  const markDialog = async (tag) => cdp.ev(`(()=>{const c=document.querySelector(".portal-modal .pm-card");
    if(!c) return null; c.dataset.probe=${JSON.stringify(tag)}; return c.dataset.probe;})()`);
  const dialogMark = async () => cdp.ev(`(()=>{const c=document.querySelector(".portal-modal .pm-card");
    return c ? (c.dataset.probe || "") : null;})()`);
  const toastText = async () => cdp.ev(`(()=>{const t=document.getElementById("amas-toast");
    return t && t.classList.contains("show") ? (t.textContent||"").trim() : "";})()`);
  /* 等一个条件成立；到点还不成立就返回 false，由断言判 FAIL —— 不靠拉长 sleep 赌。 */
  const until = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) {
      if (await fn()) return true;
      await sleep(100);
    }
    return false;
  };
  const openCreate = async () => {
    const e = await tabUntil(a => (a.attrs || "").indexOf("data-create") > -1, 60);
    if (!e.hit) return false;
    await press("Enter"); await sleep(500);
    return (await modalUp()) === true;
  };

  // ════════ Ce 建档：空格=留空；服务端按真实契约拒绝时的呈现 ════════
  console.log("\n=== Ce 建档对话框：空格=留空；拒绝时的具体原因与输入保留 ===");
  await openAdmin("/portal/admin/students/");
  ok("Ce0 前提：建档对话框开着", (await openCreate()) === true);
  const nf = await tabUntil(a => (a.attrs || "").indexOf("data-f") > -1, 10);
  ok("Ce1 前提：焦点在学号那一格", nf.hit, JSON.stringify(nf.at));
  await typeText("   ");
  await tabUntil(a => /建立学籍/.test(a.text || ""), 10);
  await press("Enter");
  ok("Ce2 请求发出去了", await until(async () => postCount() >= 1, 6000), "POST=" + postCount());
  const b1 = (() => { const p = lastPost(); try { return p && p.body ? JSON.parse(p.body) : null; } catch (e) { return null; } })();
  ok("Ce3 只打空格 = 留空，发出去的是 null", !!b1 && b1.action === "create_student_record" &&
     b1.student_number === null, JSON.stringify(b1));

  await openAdmin("/portal/admin/students/");
  edgeReject = true;
  const cBase = postCount();
  ok("Ce4 前提：建档对话框开着", (await openCreate()) === true);
  const nf2 = await tabUntil(a => (a.attrs || "").indexOf("data-f") > -1, 10);
  if (nf2.hit) await typeText("B26-0001");
  await tabUntil(a => /建立学籍/.test(a.text || ""), 10);
  await press("Enter");
  ok("Ce5 请求发出去了（这一次服务端拒绝）",
     await until(async () => postCount() === cBase + 1, 6000), "POST " + cBase + " → " + postCount());
  ok("Ce6 被拒之后他填的学号还在",
     await until(async () => (await numVal()) === "B26-0001", 6000), JSON.stringify(await numVal()));
  ok("Ce7 对话框里给的是**映射后的具体原因**（只读 .pm-err）",
     await until(async () => {
       const t = await cdp.ev(`(()=>{const e=document.querySelector(".portal-modal .pm-err");
         return e ? (e.textContent||"").trim() : "";})()`);
       return /已被使用过|不能重复分配/.test(t) && !/操作未能完成/.test(t);
     }, 6000),
     JSON.stringify(await cdp.ev(`(()=>{const e=document.querySelector(".portal-modal .pm-err");
       return e ? (e.textContent||"").trim() : null;})()`)));
  ok("Ce8 焦点回到学号那一格", ((await active()).attrs || "").indexOf("data-f") > -1,
     JSON.stringify(await active()));
  edgeReject = false;
  await pressEsc();

  // ════════ Dl 在途回执：扣住 → 开新框 → 手动放行 → 等它被消费 ════════
  console.log("\n=== Dl 在途回执的确定性并发（扣住 / 手动放行）===");

  /* —— 同一个动作：建档 → Esc → 再开建档 —— */
  await openAdmin("/portal/admin/students/");
  edgeHold = true; heldEdge = [];
  ok("Dl0 前提：第一个建档框开着", (await openCreate()) === true);
  await markDialog("first");
  const d1 = await tabUntil(a => (a.attrs || "").indexOf("data-f") > -1, 10);
  if (d1.hit) await typeText("B26-9001");
  await tabUntil(a => /建立学籍/.test(a.text || ""), 10);
  await press("Enter");
  ok("Dl1 POST **确实到达**并被扣住（不是靠看框还开着）",
     await until(async () => heldEdge.length === 1, 6000), "扣住 " + heldEdge.length + " 笔");
  ok("Dl2 在途期间 Esc 退得出去", (await (async () => { await pressEsc(); return modalUp(); })()) === false);
  ok("Dl3 前提：又开了一个建档框", (await openCreate()) === true);
  await markDialog("second");
  const d2 = await tabUntil(a => (a.attrs || "").indexOf("data-f") > -1, 10);
  if (d2.hit) await typeText("B26-9002");
  ok("Dl4 前提：新框是新的实例、装着新学号",
     (await dialogMark()) === "second" && (await numVal()) === "B26-9002",
     JSON.stringify([await dialogMark(), await numVal()]));
  // 手动放行那一笔旧的，并**等到前端真的消费了它**
  const beforeToast = await toastText();
  await heldEdge[0].send();
  const consumed = await until(async () => {
    const t = await toastText();
    return t && t !== beforeToast && /学籍已建立|建立/.test(t);
  }, 8000);
  ok("Dl5 旧回执**已被前端消费**（看到了它触发的回执提示，不是等够了时间）",
     consumed === true, JSON.stringify(await toastText()));
  ok("Dl6 新框还是原来那一个实例（没被旧回执关掉/换掉）",
     (await modalUp()) === true && (await dialogMark()) === "second",
     JSON.stringify([await modalUp(), await dialogMark()]));
  ok("Dl7 新框里他打的还在", (await numVal()) === "B26-9002", JSON.stringify(await numVal()));
  ok("Dl8 焦点还在新框里", (await inModal()) === true, JSON.stringify(await active()));
  edgeHold = false; heldEdge = [];
  if (await modalUp()) await pressEsc();

  /* —— 切换动作：建档在途 → Esc → 打开「记录总校确认」—— */
  await openAdmin("/portal/admin/students/");
  edgeHold = true; heldEdge = [];
  ok("Dl9 前提：建档框开着", (await openCreate()) === true);
  const d3 = await tabUntil(a => (a.attrs || "").indexOf("data-f") > -1, 10);
  if (d3.hit) await typeText("B26-9003");
  await tabUntil(a => /建立学籍/.test(a.text || ""), 10);
  await press("Enter");
  ok("Dl10 POST 确实到达并被扣住", await until(async () => heldEdge.length === 1, 6000),
     "扣住 " + heldEdge.length + " 笔");
  await pressEsc();
  await cdp.ev(`(()=>{ window.__SCEN.tables.applications = { data: [
      { id:"app-1", applicant_id:"u-appl", pathway:"degree", status:"accepted",
        form_data:{ name_zh:"申请人甲", programs:["bth"] }, locked_fields:[],
        applicant_visible_message:null, submitted_at:"2026-09-01T00:00:00Z",
        decided_at:"2026-09-06T00:00:00Z", created_at:"2026-08-20T00:00:00Z",
        updated_at:"2026-09-06T00:00:00Z", assigned_reviewer:null } ] };
    return true; })()`);
  const tabA = await tabUntil(a => (a.attrs || "").indexOf("data-tab") > -1 &&
    /待总校确认/.test(a.text || ""), 30);
  ok("Dl11 前提：键盘切得到「待总校确认」标签页", tabA.hit, JSON.stringify(tabA.at));
  if (tabA.hit) { await press("Enter"); await sleep(900); }
  const hq = await tabUntil(a => (a.attrs || "").indexOf("data-hq") > -1, 60);
  ok("Dl12 前提：走得到「记录总校确认」入口（走不到就是 FAIL，不放过）", hq.hit, JSON.stringify(hq.at));
  if (hq.hit) {
    await press("Enter"); await sleep(600);
    ok("Dl13 前提：换成了另一个动作的对话框", (await modalUp()) === true, JSON.stringify(await dialogTitle()));
    await markDialog("hq");
    /* 注意：tabUntil 是**先按 Tab 再判**，所以它会从「打开时已聚焦的第一格」
       走到第二格。要断言的是**我真的打进去的那一格**，不是「第一个 [data-f]」——
       上一版就是这么判错的（打在第二格、去读第一格）。 */
    const f2 = await tabUntil(a => (a.attrs || "").indexOf("data-f") > -1, 10);
    if (f2.hit) await typeText("HQ-9");
    const typedId = (await active()).id || "";
    const t0 = await toastText();
    await heldEdge[0].send();
    const consumed2 = await until(async () => {
      const t = await toastText();
      return t && t !== t0 && /学籍已建立|建立/.test(t);
    }, 8000);
    ok("Dl14 旧动作的回执已被前端消费", consumed2 === true, JSON.stringify(await toastText()));
    ok("Dl15 另一个动作的框还是它自己（没被关掉/换掉）",
       (await modalUp()) === true && (await dialogMark()) === "hq",
       JSON.stringify([await modalUp(), await dialogMark()]));
    const typedBack = await cdp.ev(`(()=>{const i=document.getElementById(${JSON.stringify(typedId)});
       return i ? i.value : null;})()`);
    ok("Dl16 它里面打的还在（读的是我真的打进去的那一格）",
       typedBack === "HQ-9", JSON.stringify({ typedId, typedBack }));
    ok("Dl17 焦点也没被抢走", (await inModal()) === true, JSON.stringify(await active()));
  }
  edgeHold = false; heldEdge = [];

  console.log("\n=== Mu 同一个对话框的两个动作：一个在途时，另一个还能不能按下去 ===");
  /* 「记录总校确认」这个框有**两个**动作：记录为已确认 / 记录为未通过。
     modal() 只把**被点的那一个**设 disabled —— 另一个还是活的。
     在途期间再按另一个，就会对同一份申请同时发出两笔互相冲突的写入。 */
  const openHq = async () => {
    await cdp.ev(`(()=>{ window.__SCEN.tables.applications = { data: [
        { id:"app-1", applicant_id:"u-appl", pathway:"degree", status:"accepted",
          form_data:{ name_zh:"申请人甲", programs:["bth"] }, locked_fields:[],
          applicant_visible_message:null, submitted_at:"2026-09-01T00:00:00Z",
          decided_at:"2026-09-06T00:00:00Z", created_at:"2026-08-20T00:00:00Z",
          updated_at:"2026-09-06T00:00:00Z", assigned_reviewer:null } ] };
      return true; })()`);
    const t = await tabUntil(a => (a.attrs || "").indexOf("data-tab") > -1 &&
      /待总校确认/.test(a.text || ""), 30);
    if (t.hit) { await press("Enter"); await sleep(900); }
    const h = await tabUntil(a => (a.attrs || "").indexOf("data-hq") > -1, 60);
    if (!h.hit) return false;
    await press("Enter"); await sleep(600);
    return (await modalUp()) === true;
  };

  await openAdmin("/portal/admin/students/");
  edgeHold = true; heldEdge = [];
  ok("Mu0 前提：「记录总校确认」框开着（走不到就是 FAIL）", (await openHq()) === true);
  const actA = await tabUntil(a => /记录为已确认/.test(a.text || ""), 20);
  ok("Mu1 前提：Tab 走得到「记录为已确认」", actA.hit, JSON.stringify(actA.at));
  await press("Enter");
  ok("Mu2 前提：第一笔 POST 到达并被扣住", await until(async () => heldEdge.length === 1, 6000),
     "扣住 " + heldEdge.length + " 笔");
  /* 期望的行为是「在途期间另一个动作按不动」，所以这里不能再断言「Tab 走得到它」——
     那是**修好之前**的样子。改为直接读它的 disabled，并确认 Tab 确实走不到。 */
  const actBState = await cdp.ev(`(()=>{const b=[...document.querySelectorAll(".portal-modal [data-act]")]
    .find(x => /记录为未通过/.test(x.textContent||""));
    return b ? { found:true, disabled:b.disabled } : { found:false };})()`);
  ok("Mu3 在途期间，另一个动作是禁用的", actBState.found === true && actBState.disabled === true,
     JSON.stringify(actBState));
  const reachB = await tabUntil(a => /记录为未通过/.test(a.text || ""), 20);
  ok("Mu3b 因此键盘也走不到它", reachB.hit === false, JSON.stringify(reachB.at));
  await press("Enter");                                  // 焦点此刻在别处，按下去也不该发出第二笔
  await sleep(800);
  ok("Mu4 前一笔还在途时，另一个动作**不该**再发一笔（同一份申请不能同时发两个相反的结论）",
     heldEdge.length === 1, "扣住 " + heldEdge.length + " 笔：" +
     JSON.stringify(heldEdge.map(h => { try { return JSON.parse(h.body).action; } catch (e) { return "?"; } })));
  // 放行第一笔，确认前端消费了它
  const mt0 = await toastText();
  await heldEdge[0].send();
  ok("Mu5 第一笔的回执被前端消费了",
     await until(async () => { const t = await toastText(); return t && t !== mt0; }, 8000),
     JSON.stringify(await toastText()));
  edgeHold = false; heldEdge = [];

  /* 失败之后要能再来一次 —— 两个动作都得重新能按。 */
  await openAdmin("/portal/admin/students/");
  edgeHold = true; edgeReject = true; heldEdge = [];
  ok("Mu6 前提：框开着", (await openHq()) === true);
  const actA2 = await tabUntil(a => /记录为已确认/.test(a.text || ""), 20);
  if (actA2.hit) await press("Enter");
  ok("Mu6b 前提：这一笔被扣住", await until(async () => heldEdge.length === 1, 6000));
  await heldEdge[0].send();                              // 放行 —— 服务端这一次拒绝
  const backOn = await until(async () => cdp.ev(`(()=>{const bs=[...document.querySelectorAll(".portal-modal [data-act]")];
      return bs.length >= 2 && bs.every(b => !b.disabled);})()`), 8000);
  ok("Mu7 失败之后两个动作都重新能按（不是只解禁被点的那一个）", backOn === true,
     JSON.stringify(await cdp.ev(`(()=>[...document.querySelectorAll(".portal-modal [data-act]")]
        .map(b => ({ t:(b.textContent||"").trim(), d:b.disabled })))()`)));
  edgeHold = false; edgeReject = false; heldEdge = [];
  if (await modalUp()) await pressEsc();

  console.log("\n=== Xl 关掉再重开：在途互斥会不会被绕过（同一份申请、相反结论）===");
  /* 上一包的互斥是挂在**那一个 wrap** 上的。他按 Esc 关掉、再打开同一份申请的
     确认框，按钮是新的、当然是活的 —— 于是同一份申请照样能发出第二笔相反结论。 */
  const hqAgain = async () => {                        // 已经在「待总校确认」那一页上了
    const h = await tabUntil(a => (a.attrs || "").indexOf("data-hq") > -1, 60);
    if (!h.hit) return false;
    await press("Enter"); await sleep(600);
    return (await modalUp()) === true;
  };
  const clickAct = async (re) => {
    const r = await tabUntil(a => re.test(a.text || ""), 25);
    if (!r.hit) return false;
    await press("Enter");
    return true;
  };

  await openAdmin("/portal/admin/students/");
  edgeHold = true; heldEdge = [];
  ok("Xl0 前提：同一份申请的确认框开着", (await openHq()) === true);
  ok("Xl1 前提：按下「记录为已确认」", (await clickAct(/记录为已确认/)) === true);
  ok("Xl2 前提：这一笔被扣住", await until(async () => heldEdge.length === 1, 6000),
     "扣住 " + heldEdge.length + " 笔");
  await pressEsc();
  ok("Xl3 前提：框关掉了（但请求还在路上，没有被取消）", (await modalUp()) === false);
  ok("Xl4 前提：同一份申请的框又开起来了", (await hqAgain()) === true);
  const opp = await clickAct(/记录为未通过/);
  await sleep(800);
  ok("Xl5 同一份申请**不该**再发出一笔相反的结论",
     heldEdge.length === 1, "扣住 " + heldEdge.length + " 笔：" +
     JSON.stringify(heldEdge.map(h => { try { const b = JSON.parse(h.body);
       return b.action + "/" + (b.status || b.decision || ""); } catch (e) { return "?"; } })));
  ok("Xl6 并且要让他知道为什么按不动（框里说得出「上一次还没回来」）",
     await until(async () => {
       const t = await cdp.ev(`(()=>{const c=document.querySelector(".portal-modal .pm-card");
         return c ? (c.textContent||"") : "";})()`);
       return /还没回来|还在处理|上一次/.test(t);
     }, 4000),
     JSON.stringify(await cdp.ev(`(()=>{const e=document.querySelector(".portal-modal .pm-err");
       return e ? (e.textContent||"").trim() : null;})()`)));
  // 放行那一笔，锁要解开，之后还能再来
  const xt0 = await toastText();
  await heldEdge[0].send();
  ok("Xl7 放行之后回执被消费", await until(async () => {
       const t = await toastText(); return t && t !== xt0; }, 8000), JSON.stringify(await toastText()));
  edgeHold = false; heldEdge = [];
  if (await modalUp()) await pressEsc();

  /* 锁必须按对象分：另一份申请不能被误伤。 */
  await openAdmin("/portal/admin/students/");
  edgeHold = true; heldEdge = [];
  await cdp.ev(`(()=>{ const mk = (id, nm) => ({ id, applicant_id:"u-"+id, pathway:"degree",
      status:"accepted", form_data:{ name_zh:nm, programs:["bth"] }, locked_fields:[],
      applicant_visible_message:null, submitted_at:"2026-09-01T00:00:00Z",
      decided_at:"2026-09-06T00:00:00Z", created_at:"2026-08-20T00:00:00Z",
      updated_at:"2026-09-06T00:00:00Z", assigned_reviewer:null });
    window.__SCEN.tables.applications = { data: [ mk("app-1","申请人甲"), mk("app-2","申请人乙") ] };
    window.__SCEN.tables.profiles = { data: [
      { id:"u-app-1", display_name:"申请人甲", email:"a@example.invalid" },
      { id:"u-app-2", display_name:"申请人乙", email:"b@example.invalid" } ] };
    return true; })()`);
  const tabX = await tabUntil(a => (a.attrs || "").indexOf("data-tab") > -1 &&
    /待总校确认/.test(a.text || ""), 30);
  if (tabX.hit) { await press("Enter"); await sleep(900); }
  const hqButtons = await cdp.ev(`(()=>[...document.querySelectorAll("[data-hq]")].map(b => b.dataset.hq))()`);
  ok("Xl8-0 前提：列表里确实有两份申请", Array.isArray(hqButtons) && hqButtons.length === 2,
     JSON.stringify(hqButtons));
  // 第一份：发出并扣住
  const h1 = await tabUntil(a => (a.attrs || "").indexOf("data-hq") > -1, 60);
  if (h1.hit) { await press("Enter"); await sleep(600); }
  await clickAct(/记录为已确认/);
  ok("Xl8-1 前提：第一份的那一笔被扣住", await until(async () => heldEdge.length === 1, 6000));
  await pressEsc();
  // 第二份：应当照常可用
  const h2 = await cdp.ev(`(()=>{const bs=[...document.querySelectorAll("[data-hq]")];
    const b=bs[1]; if(!b) return null; b.focus(); return b.dataset.hq;})()`);
  ok("Xl8-2 前提：聚焦到第二份申请的入口", h2 === hqButtons[1], JSON.stringify([h2, hqButtons]));
  await press("Enter"); await sleep(600);
  ok("Xl8-3 第二份申请的框正常打开", (await modalUp()) === true);
  const busyShown = await cdp.ev(`(()=>{const e=document.querySelector(".portal-modal .pm-err");
    return e ? (e.textContent||"") : "";})()`);
  ok("Xl8-4 没有被第一份的在途锁误伤（没有「还没回来」那句）",
     !/还没回来/.test(busyShown), JSON.stringify(busyShown));
  await clickAct(/记录为已确认/);
  ok("Xl8-5 第二份能照常发出自己的那一笔",
     await until(async () => heldEdge.length === 2, 6000), "扣住 " + heldEdge.length + " 笔");
  for (const hd of heldEdge) await hd.send();
  edgeHold = false; heldEdge = [];
  await sleep(800);
  if (await modalUp()) await pressEsc();

  /* 失败之后同一个对象还能再来（锁在响应回来时解开，不管成败）。 */
  await openAdmin("/portal/admin/students/");
  edgeHold = true; edgeReject = true; heldEdge = [];
  ok("Xl9-0 前提：框开着", (await openHq()) === true);
  await clickAct(/记录为已确认/);
  ok("Xl9-1 前提：扣住一笔", await until(async () => heldEdge.length === 1, 6000));
  await heldEdge[0].send();                            // 放行 —— 这一次被拒
  heldEdge = [];
  const canRetry = await until(async () => cdp.ev(`(()=>{const bs=[...document.querySelectorAll(".portal-modal [data-act]")];
      return bs.length >= 2 && bs.every(b => !b.disabled);})()`), 8000);
  ok("Xl9-2 失败之后按钮重新解禁（锁跟着响应解开）", canRetry === true);
  await clickAct(/记录为未通过/);
  ok("Xl9-3 失败之后可以重试，新的那一笔发得出去",
     await until(async () => heldEdge.length === 1, 6000), "扣住 " + heldEdge.length + " 笔");
  edgeHold = false; edgeReject = false;
  for (const hd of heldEdge) await hd.send();
  heldEdge = [];
  await sleep(600);
  if (await modalUp()) await pressEsc();

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
