// 学员中心的真实产品路径：**待办 →「去处理」→ 我的资料 → 完成出口**。
//
// 这一条是 my_action_items() 里唯一「学生自己动手就能完成」的待办：
//   source_type='profile'、title=完善联系方式、reason=你还没有填写联系电话…、
//   target_url='portal/student/profile/'（0019_student_role_gating.sql:158 起）。
//   另两条一条是 waiting（等教务，明说无需操作）、一条指向 discover.html（站外评估）。
// 所以「点进去之后能不能真的完成、完成了知不知道」只在这一条上说得清。
//
// 全程真实 Tab / Enter / 打字；本地合成 student 夹具，无真实账号/服务。
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
/* 跨页累计器。window.__q 每次导航都会被重置 —— 拿它说「全程零写入」
   只能代表最后那一页（监督点名）。所以让页内的每一次查询/RPC 都打一条
   到**测试宿主**这边来，导航冲不掉。仍然是本地合成，不接任何真实服务。 */
const probeLog = [];
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/__probe") {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      try { probeLog.push(JSON.parse(b)); } catch (e) {}
      res.writeHead(204); res.end();
    });
    return;
  }
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-stu-"));
const CHROME = process.env.CHROME_PATH || process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0",
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP *.supabase.co 0.0.0.0, MAP *.supabase.in 0.0.0.0",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
/* 看门狗：挂住时**自己收摊并退出**，而不是无限等下去。
   到点只杀**本进程 spawn 的那一个** Chrome（绝不碰用户的浏览器），
   删掉自己的临时 profile，打印一行 INCOMPLETE 并以非 0 退出。
   它不降低任何断言，也不把挂起算成通过 —— 只是让挂起「响一声」而不是静默挂着。
   缘由见 failures-web.jsonl 的 eventb5c5-combined-timeout：根因仍未结。 */
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS || 600000);
let watchdogDone = false;
const watchdogTimer = setTimeout(() => {
  if (watchdogDone) return;
  console.log("\n  ⏱ INCOMPLETE：跑了 " + Math.round(WATCHDOG_MS / 1000) +
              "s 还没结束，按看门狗约定自行退出（只杀本进程自己的 Chrome）。");
  console.log("  这不是「通过」，也不是产品失败 —— 见 eventb5c5-combined-timeout（根因未结）。");
  watchdogDone = true;
  try { chrome.kill("SIGKILL"); } catch (e) {}
  try { server.close(); } catch (e) {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(3), 300);
}, WATCHDOG_MS);
const stopWatchdog = () => { watchdogDone = true; clearTimeout(watchdogTimer); };
/* 被外部信号结束时也要收摊：否则 finally 根本不会跑，
   每被 kill 一次就在系统临时目录里留下一个 profile（实测已累积数百个）。
   同样只杀自己 spawn 的那个 Chrome。 */
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    stopWatchdog();
    try { chrome.kill("SIGKILL"); } catch (e) {}
    try { server.close(); } catch (e) {}
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
    process.exit(130);
  });
}

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
let pass = 0, fail = 0, externalHits = 0;
/* 写入计数按「我**真的按了几次保存**」算，而不是写死一个数字 ——
   挑着跑分组时那个数字必然对不上（上一版就是）。 */
let savesPressed = 0;
/* 分组开关：ONLY=S,U,R,F,G 就只跑这几组。
   监督的口径是「不要整跑既有 66」——但被这次改动**真正影响到**的那几组必须跑，
   所以要能挑着跑，而不是靠「这次先不跑」蒙混。不设 ONLY 时全跑。 */
const ONLY = String(process.env.ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
const RUN = (g) => !ONLY.length || ONLY.indexOf(g) > -1;
/* **组隔离**（监督口径：不许靠加长 timeout 赌绿）。
   Sf / Se / Sp 这三组都会把页面留在「改过没保存」的状态再离开，
   各自会触发一次 beforeunload 原生对话框。实测：一个浏览器会话里连着跑
   第二个这样的组之后，CDP 的 Input / Runtime / Page.handleJavaScriptDialog
   会**一起**不再响应 —— 连每步都设了 2.5s 上限的诊断都返回不了。
   这是探针/会话层面的问题；**产品侧这三组各自分开跑都是绿的**。
   在定位清楚之前宁可**拒跑**，也不给一个含糊的结果，更不去调长超时。 */
const DIRTY_GROUPS = ["Sf", "Se", "Sp"];
const dirtySelected = ONLY.length ? DIRTY_GROUPS.filter((g) => ONLY.indexOf(g) > -1) : DIRTY_GROUPS;
if (dirtySelected.length > 1) {
  console.error("  拒跑：一个进程里最多只能跑 " + DIRTY_GROUPS.join(" / ") + " 中的**一个**。");
  console.error("  这次选了：" + dirtySelected.join(", "));
  console.error("  请分开跑：ONLY=St,A,G / ONLY=Sf,A,G / ONLY=Se,A,G / ONLY=Sp,A,G");
  console.error("  理由见 web-round111.md「组合态」一节 —— 不是把超时调长能解决的事。");
  process.exit(2);
}
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); } };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';
const CORS = [
  { name: "Access-Control-Allow-Origin", value: "*" },
  { name: "Access-Control-Allow-Headers", value: "authorization,apikey,content-type,x-client-info" },
  { name: "Access-Control-Allow-Methods", value: "POST,OPTIONS" },
];
/* 扣住 / 手动放行。按**到达顺序**发牌，模拟真实服务端：
   第一笔照做，第二笔撞上 invalid_state。放行顺序另算，由测试控制。 */
let edgeHold = false;
let heldEdge = [];
let edgeScript = [];                 // 按到达顺序取；取完用 fallback
let edgeFallback = { status: 200, body: { ok: true } };

const STUB = `
var PROBE_URL = "${BASE}/__probe";
/* 每条记录带 visit + 递增 seq：宿主据此做**终局对齐**——
   sendBeacon 是异步投递、并不保证到达，「每页收到一条」不等于「每条都收到」。
   有缺口就说明丢了，那样「零写入」这个结论就**不成立**，必须判红。 */
var VISIT = (Math.random().toString(36).slice(2)) + "-" + Date.now();
var SEQ = 0;
try { window.__VISIT = VISIT; window.__sent = 0; } catch(e){}
function beacon(rec){
  try {
    SEQ += 1; window.__sent = SEQ;
    rec.visit = VISIT; rec.seq = SEQ;
    var s = JSON.stringify(rec);
    if (navigator.sendBeacon) navigator.sendBeacon(PROBE_URL, new Blob([s], { type:"text/plain" }));
    else fetch(PROBE_URL, { method:"POST", body:s, keepalive:true });
  } catch(e){}
}
window.supabase = { createClient: function(){
  var S = function(){ return window.__SCEN || {}; };
  var reply = function(v){ return Promise.resolve(v); };
  function table(name){
    var mode = "select", cols = null, eqs = {};
    var rng = null;
    var q = {
      select:function(c){ cols = (c === undefined ? null : c); return q; },
      eq:function(k,v){ eqs[k]=v; return q; },
      in:function(){return q;}, match:function(){return q;},
      order:function(){return q;},
      /* 真正按 range 切片 —— 夹具不模拟分页的话，「翻页没问题」就是空话。 */
      range:function(a,b){ rng = { from:a, to:b }; return q; },
      limit:function(){return q;},
      maybeSingle:function(){return q;}, single:function(){return q;},
      insert:function(){ mode="insert"; return q; }, update:function(){ mode="update"; return q; },
      then:function(res, rej){
        var sc = S();
        /* 每一次查询都留痕：表、模式、列投影、eq 条件 —— 断言就读这里。 */
        try { (window.__q = window.__q || []).push({ name:name, mode:mode, cols:cols, eq:eqs }); } catch(e){}
        beacon({ kind:"table", name:name, mode:mode, cols:cols, eq:eqs, range:rng, page:location.pathname });
        var t = (mode === "select") ? ((sc.tables && sc.tables[name]) || { data:[], error:null })
                                    : (sc.write || { data:[], error:null });
        var out = { data:t.data, error:t.error||null,
          status: t.status != null ? t.status : (t.error ? 500 : 200) };
        if (mode === "select" && rng && Array.isArray(t.data)) {
          /* 指定 from 的那一页失败一次（用来验「失败保留已有列表且能重试」）。 */
          if (window.__failFrom === rng.from && !window.__failedOnce) {
            window.__failedOnce = true;
            out = { data:null, error:{ message:"这一次没能读到申请列表。" }, status:500 };
          } else {
            out = { data: t.data.slice(rng.from, rng.to + 1), error:null, status:200 };
          }
        }
        /* 按表扣住：确定性地造出「正在等这次读取回来」那一段。 */
        if (mode === "select" && window.__holdSelect === name) {
          return new Promise(function(r){
            window.__heldSelect = true;
            window.__releaseSelect = function(){
              window.__holdSelect = null; window.__heldSelect = false;
              var sc2 = S(); var t2 = (sc2.tables && sc2.tables[name]) || { data:[], error:null };
              r({ data:t2.data, error:t2.error||null,
                  status: t2.status != null ? t2.status : (t2.error ? 500 : 200) });
            };
          }).then(res, rej);
        }
        return Promise.resolve(out).then(res, rej);
      } };
    return q;
  }
  return {
    auth: {
      getSession: function(){ var u = (window.__SCEN && window.__SCEN.uid) || "u-appl";
        return reply({ data:{ session:{ user:{ id:u }, access_token:"fixture-token" } }, error:null }); },
      signOut: function(){ return reply({}); },
      mfa: { getAuthenticatorAssuranceLevel: function(){
        var l = (window.__SCEN && window.__SCEN.aal) || "aal1";
        return reply({ data:{ currentLevel:l, nextLevel:l }, error:null }); } },
      onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; }
    },
    from: table,
    rpc: function(name, args){
      try { (window.__rpc = window.__rpc || []).push({ name:name, args:args||null }); } catch(e){}
      beacon({ kind:"rpc", name:name, args:args||null, page:location.pathname });
      /* 共享状态：两页同源，state 放 localStorage —— 这样「保存」不是换一份夹具，
         而是**真的把 body 里的号码写进去**，首页再读同一份。
         （监督点名：直接注入「已完成」的夹具只能证明两种呈现，证明不了保存这件事。） */
      var _st = function(){ try { return JSON.parse(localStorage.getItem("__stu") || "{}"); }
                            catch(e){ return {}; } };
      var _save = function(o){ try { localStorage.setItem("__stu", JSON.stringify(o)); } catch(e){} };
      if (name === "update_my_contact") {
        var st0 = _st();
        if (st0.holdSave) {                       // 扣住：由测试显式放行
          return new Promise(function(r){
            window.__heldSave = true;
            window.__releaseSave = function(){
              window.__heldSave = false;
              var st1 = _st(); st1.phone = String((args && args.p_phone) || "").trim(); _save(st1);
              r({ data:{ ok:true }, error:null, status:200 });
            };
          });
        }
        if (st0.failSave) {                       // 失败：**什么都不写**
          return reply({ data:null, error:{ code:"server_error", message:"这一次没能保存，请稍后再试。" }, status:500 });
        }
        st0.phone = String((args && args.p_phone) || "").trim();
        _save(st0);
        return reply({ data:{ ok:true }, error:null, status:200 });
      }
      if (name === "my_student_profile") {
        var stp = _st();
        var base = (S().rpc && S().rpc.my_student_profile && S().rpc.my_student_profile.data) || {};
        var cloned = JSON.parse(JSON.stringify(base));
        cloned.self_editable = cloned.self_editable || {};
        cloned.self_editable.phone = stp.phone || null;
        return reply({ data:cloned, error:null, status:200 });
      }
      if (name === "my_action_items") {
        var sta = _st();
        var all = (S().rpc && S().rpc.my_action_items && S().rpc.my_action_items.data) || [];
        return reply({ data: (sta.phone && sta.phone.length) ? [] : all, error:null, status:200 });
      }
      /* 这一行原来是硬编码的 [{role:"applicant"}]（从只测申请人的那支探针抄来的），
         于是合成 admin 夹具根本没生效，页面被守卫弹回申请人首页 ——
         量具自己的毛病，不是产品的。必须读夹具。 */
      if (name === "my_roles") return reply({ data:(window.__SCEN && window.__SCEN.roles) || [{ role:"applicant" }], error:null, status:200 });
      if (name === "my_profile" && !(S().rpc && S().rpc.my_profile))
        return reply({ data:{ display_name:"申请人甲", email:"a@example.invalid" }, error:null, status:200 });
      var r = (S().rpc && S().rpc[name]) || { data:null, error:null };
      return reply({ data:r.data, error:r.error||null, status: r.status != null ? r.status : (r.error ? 500 : 200) });
    },
    functions: { invoke: function(){ return reply({ data:null, error:null }); } }
  };
} };`;






let port;
try { port = await ownDebugPort(); console.log("  独占调试端口（本进程自己的 Chrome）: " + port); }
catch (e) { chrome.kill(); server.close(); console.error("  " + e.message); process.exit(1); }

const READONLY_RPC = new Set([
  "my_roles", "my_profile", "my_student_record", "my_student_timeline",
  "my_action_items", "my_student_capabilities", "my_learning", "my_student_profile",
]);
const WRITE_RPC = new Set(["update_my_contact"]);     // 这一条是**有意**要发的写入

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  let edgeCalls = [];
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
      if (u.indexOf("/functions/v1/") > -1) {
        edgeCalls.push({ method:(ev.request.method||"").toUpperCase(), url:u });
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: CORS.concat([{ name:"Content-Type", value:"application/json" }]), body: b64("{}") });
        return; }
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });
  /* 保存没成 → 页面是 dirty 的 → 离开时 UI.formGuard 会弹 beforeunload。
     那是产品**该做**的事（申请表单一直如此）；探针要接住它，否则
     原生对话框会把后面的按键整个卡住（上一次跑就是这么超时的）。 */
  const leaveGuards = [];
  cdp.on("Page.javascriptDialogOpening", async (p) => {
    leaveGuards.push({ type: (p && p.type) || "", url: (p && p.url) || "" }); dialogSeen += 1;
    try { await cdp.send("Page.handleJavaScriptDialog", { accept: true }); } catch (e) {}
  });
  let pageErrors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    pageErrors.push(String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || "").slice(0, 200));
  });

  const KEYS = { Tab:{code:"Tab",key:"Tab",vk:9}, Enter:{code:"Enter",key:"Enter",vk:13},
                 End:{code:"End",key:"End",vk:35} };
  /* 原生对话框开着的时候渲染进程是阻塞的，按键会一直卡到超时。
     接住这种情况：把对话框收掉再补一次，而不是让整支探针挂掉。 */
  let dialogSeen = 0;
  const dispatch = async (params) => {
    try { await cdp.send("Input.dispatchKeyEvent", params, 3000); }
    catch (e) {
      /* 只有确实弹过对话框才去收它；否则不要把每一次按键都拖成好几秒。 */
      if (dialogSeen > 0) {
        try { await cdp.send("Page.handleJavaScriptDialog", { accept: true }); } catch (e2) {}
        try { await cdp.send("Input.dispatchKeyEvent", params, 3000); } catch (e3) {}
      }
    }
  };
  const press = async (name, shift) => {
    const m = KEYS[name], mods = shift ? 8 : 0;
    await dispatch({ type:"rawKeyDown", modifiers:mods,
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    if (name === "Enter") await dispatch({ type:"char", modifiers:mods,
      text:"\r", key:m.key, code:m.code });
    await dispatch({ type:"keyUp", modifiers:mods,
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    await sleep(90);
  };
  const typeText = async (text) => {
    for (const ch of String(text)) {
      const vk = ch.toUpperCase().charCodeAt(0);
      await dispatch({ type:"keyDown", key: ch,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await dispatch({ type:"char", text: ch, key: ch });
      await dispatch({ type:"keyUp", key: ch,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(16);
    }
    await sleep(150);
  };
  const where = async () => cdp.ev(`(()=>{const a=document.activeElement;
    if(!a || a===document.body) return { tag:"BODY" };
    return { tag:a.tagName, id:a.id||"", href:(a.getAttribute&&a.getAttribute("href"))||"",
             text:(a.textContent||"").replace(/\s+/g," ").trim().slice(0,18) };})()`);
  const until = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 9000)) { try { if (await fn()) return true; } catch (e) {} await sleep(120); }
    return false;
  };
  const tabTo = async (pred, max) => {
    for (let i = 1; i <= (max || 40); i++) {
      await press("Tab");
      const w = await where();
      if (pred(w)) return { hit: true, steps: i, at: w };
    }
    return { hit: false, at: await where() };
  };
  const path_ = async () => cdp.ev(`location.pathname`);
  const mainText = async () => cdp.ev(`(()=>{const m=document.getElementById("main");
    return m ? (m.textContent||"").replace(/\s+/g," ").trim() : "";})()`);
  const phoneVal = async () => cdp.ev(`(()=>{const e=document.getElementById("ph"); return e?e.value:null;})()`);
  const toastText = async () => cdp.ev(`(()=>{const t=document.getElementById("amas-toast");
    return t && t.classList.contains("show") ? (t.textContent||"").trim() : "";})()`);

  const TODO = { source_type:"profile", source_id:"u-stu", title:"完善联系方式",
    reason:"你还没有填写联系电话，教务在需要时无法联系到你。",
    target_url:"portal/student/profile/", status:"open", priority:20 };
  /* my_action_items 的第三条：建立信仰成长档案，target_url 是**站外**的 discover.html
     （0019_student_role_gating.sql 那一段 union）。入口完整性就要查它。 */
  const TODO_CP = { source_type:"christian_profile", source_id:"u-stu", title:"建立你的信仰成长档案",
    reason:"完成评估后可以看到自己的成长画像与学习建议。评估在「AMAS 神学院」App 中进行。",
    target_url:"discover.html", status:"open", priority:30 };
  const scenSrc = () => "window.__SCEN = " + JSON.stringify({
    uid:"u-stu", aal:"aal1", roles:[{ role:"student" }],
    tables: { program_catalog: { data:[{ code:"bth", name_zh:"神学本科", short_label:"B.Th" }] } },
    rpc: {
      /* 页面取的是 recRows[0]（student/index.html:73）—— 这里必须是**数组**。
         上一次跑我给成了对象，首页直接走「尚未查到学籍记录」那一支，
         St0/St13 的红全是这个原因，不是产品的问题。 */
      my_student_record: { data:[{ id:"stu-1", student_number:"B26-0007", status:"active",
        program_code:"bth", created_at:"2026-09-01T00:00:00Z", activated_at:"2026-09-05T00:00:00Z" }] },
      my_student_timeline: { data: [] },
      my_action_items: { data: [TODO, TODO_CP] },   // profile 那条是否还剩由共享状态决定
      my_student_capabilities: { data:{} },
      /* my_learning 也是行集合：页面数的是 learn.length 与 availability。 */
      my_learning: { data: Array.from({ length: 67 }, (_, i) => ({
        code:"C" + i, availability: i < 12 ? "available" : "planned" })) },
      my_student_profile: { data:{ self_editable:{ display_name:"学生甲", phone: null, contact_note:"" },
        registrar_managed:{ email:"s@example.invalid", student_number:"B26-0007", status:"active",
          program_code:"bth", pathway:"degree", created_at:"2026-09-01T00:00:00Z",
          activated_at:"2026-09-05T00:00:00Z" }, has_student_record:true } },
      update_my_contact: { data:{ ok:true } },
    },
    write: { data:[], error:null },
  }) + "; window.__q=[]; window.__rpc=[];";
  /* 一次导航搞定：把「清掉共享状态」写进注入脚本，别连着导航两次
     （连navigate 会让渲染进程卡在半路，按键随后一路超时 —— 上一次就是这么挂的）。 */
  let scenInjected = false;
  const goStudentHome = async (reset) => {
    /* 注入脚本只放一次，而且**不含清状态的动作** ——
       它对**每一次**导航都生效，用户自己按「回到学员中心」时也会跑，
       那样会把刚保存进去的号码一并擦掉（上一次跑 St13c/St13d 就是这么红的）。
       清状态改成在**当前这一页**上做一次（同源，同一份 localStorage），然后只导航一次。 */
    if (!scenInjected) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: scenSrc() });
      scenInjected = true;
    }
    if (reset !== false) {
      try { await cdp.ev(`(()=>{ try{ localStorage.removeItem("__stu"); }catch(e){} return true; })()`); } catch (e) {}
    }
    await cdp.send("Page.navigate", { url: `${BASE}/portal/student/` });
    await sleep(2800);
  };

  // ════════ St 待办 → 去处理 → 完成 → 出口 ════════
  if (RUN("St")) {
    console.log("\n=== St 待办「完善联系方式」：点进去之后能不能真的完成、完成了知不知道 ===");
    await goStudentHome();
    ok("St0 前提：待办里出现了「完善联系方式」，并说明了原因",
       (await mainText()).indexOf("完善联系方式") > -1 &&
       (await mainText()).indexOf("你还没有填写联系电话") > -1,
       JSON.stringify((await mainText()).slice(0, 80)));
    /* 导航里也有一条指向 profile/ 的链接 —— 只按 href 匹配会**空过**（上一次就是）。
       必须落在待办卡片里那一条「去处理 →」上。 */
    const go = await tabTo((w) => w.tag === "A" && /student\/profile\/$/.test(w.href || "") &&
      /去处理/.test(w.text || ""), 40);
    ok("St1 Tab 走得到待办里那一条的「去处理 →」（不是导航里的同址链接）",
       go.hit === true, JSON.stringify(go.at));
    await press("Enter");
    ok("St2 Enter 真的走到了我的资料页",
       await until(async () => /\/portal\/student\/profile\/$/.test(await path_()), 9000),
       JSON.stringify(await path_()));
    await sleep(2200);

    /* 到了之后：他是被一条「你还没有填写联系电话」的待办送过来的。
       这一页有没有接住这件事？ */
    const landedText = await mainText();
    ok("St3 到了资料页，页面上说得出他是来补什么的（电话还空着这件事）",
       /还没有填写联系电话|还没有填联系电话|请补上联系电话|需要你补/.test(landedText),
       JSON.stringify(landedText.slice(0, 100)));
    /* 只看「按钮在不在」不算数（监督点名）：真的 Tab 过去、Enter 按下，
       然后断言焦点**确实**落在电话那一格上。 */
    const jump = await tabTo((w) => w.tag === "BUTTON" && /去填联系电话/.test(w.text || ""), 30);
    ok("St4 Tab 走得到「去填联系电话」", jump.hit === true, JSON.stringify(jump.at));
    await press("Enter");
    await sleep(200);
    ok("St4b 按下之后焦点**确实**落在电话那一格上",
       (await where()).id === "ph", JSON.stringify(await where()));
    ok("St5 前提：电话这一格现在确实是空的", (await phoneVal()) === "", JSON.stringify(await phoneVal()));

    /* 真实键盘：走到那一格、打进去、保存。 */
    ok("St6 焦点已经在那一格上，直接就能打（这正是那个按钮承诺的事）",
       (await where()).id === "ph", JSON.stringify(await where()));
    await typeText("0123456789");
    ok("St7 打进去了", (await phoneVal()) === "0123456789", JSON.stringify(await phoneVal()));
    const sv = await tabTo((w) => w.id === "save", 20);
    ok("St8 Tab 走得到「保存」", sv.hit === true, JSON.stringify(sv.at));
    await press("Enter"); savesPressed += 1;
    ok("St9 保存成功（页面给了回执）",
       await until(async () => (await toastText()).indexOf("已保存") > -1, 9000),
       JSON.stringify(await toastText()));
    const w = await cdp.ev(`(window.__rpc||[]).filter(r=>r.name==="update_my_contact").length`);
    ok("St10 而且确实只发了一笔写入", w === 1, "update_my_contact × " + w);

    /* 完成出口：他做完了，回不回得去？页面认不认这件事已经完成？ */
    const doneText = await mainText();
    ok("St11 完成之后，这一页给得出回到学员中心的出口",
       (await cdp.ev(`(()=>[...document.querySelectorAll("a")]
          .some(a=>/portal\\/student\\/$/.test(a.getAttribute("href")||"") &&
                   /学员中心|回到|返回/.test(a.textContent||"")))()`)) === true,
       JSON.stringify(doneText.slice(-120)));
    /* 不能只断言「那句话没了」——根本没有提示块时它也成立（空过）。
       要断言**确实换成了**已经填好的说法。 */
    ok("St12 而且那条「还没填」的提示换成了「已经填好」的说法",
       /已经填好|已填好|已经填了/.test(await mainText()) &&
       !/还没有填写联系电话|还没有填联系电话/.test(await mainText()),
       JSON.stringify((await mainText()).slice(0, 120)));

    /* 完成出口要**真的走一遍**：Tab 到那条「回到学员中心 →」按下去，
       首页读的是同一份共享状态（刚才那一笔 update_my_contact 真写进去的号码），
       而不是我另外注入一份「已完成」的夹具。 */
    const exit1 = await tabTo((w) => w.tag === "A" && /portal\/student\/$/.test(w.href || "") &&
      /回到学员中心/.test(w.text || ""), 40);
    ok("St13 Tab 走得到「回到学员中心 →」", exit1.hit === true, JSON.stringify(exit1.at));
    await press("Enter");
    ok("St13b Enter 真的走回了学员中心",
       await until(async () => /\/portal\/student\/$/.test(await path_()), 9000),
       JSON.stringify(await path_()));
    await sleep(2400);
    ok("St13c 首页读同一份状态：这一条待办已经不在了",
       (await mainText()).indexOf("完善联系方式") < 0 &&
       (await mainText()).indexOf("目前没有需要你处理的事项") > -1,
       JSON.stringify((await mainText()).slice(0, 120)));
    const stored = await cdp.ev(`(()=>{ try { return JSON.parse(localStorage.getItem("__stu")||"{}").phone||null; }
      catch(e){ return null; } })()`);
    ok("St13d 而且消失的依据是**真的写进去的那个号码**（不是换了一份夹具）",
       stored === "0123456789", JSON.stringify(stored));

    // ════════ Sf 保存失败：待办不能消失 ════════
  }
  if (RUN("Sf")) {
    console.log("\n=== Sf 保存失败时：待办不能跟着消失 ===");
    await goStudentHome();
    await cdp.ev(`(()=>{ const o={}; o.failSave=true; localStorage.setItem("__stu", JSON.stringify(o)); return true; })()`);
    const go2 = await tabTo((w) => w.tag === "A" && /student\/profile\/$/.test(w.href || "") &&
      /去处理/.test(w.text || ""), 40);
    ok("Sf0 前提：又从待办走到资料页", go2.hit === true &&
       (await (async () => { await press("Enter");
         return until(async () => /\/portal\/student\/profile\/$/.test(await path_()), 9000); })()) === true);
    await sleep(2200);
    const j2 = await tabTo((w) => w.tag === "BUTTON" && /去填联系电话/.test(w.text || ""), 30);
    if (j2.hit) { await press("Enter"); await sleep(200); }
    await typeText("0999888777");
    const sv2 = await tabTo((w) => w.id === "save", 20);
    ok("Sf1 前提：填好并按保存", sv2.hit === true, JSON.stringify(sv2.at));
    await press("Enter"); savesPressed += 1;
    ok("Sf2 这一次保存失败，页面说得出来",
       await until(async () => cdp.ev(`(()=>{const e=document.getElementById("err");
         return !!(e && e.classList.contains("show") && (e.textContent||"").trim());})()`), 9000),
       JSON.stringify(await cdp.ev(`(()=>{const e=document.getElementById("err"); return e?e.textContent:null;})()`)));
    ok("Sf3 失败之后**不能**说「已经填好了」",
       !/已经填好|已填好/.test(await mainText()), JSON.stringify((await mainText()).slice(0, 120)));
    const guardsBefore = leaveGuards.length;
    const nav2 = await tabTo((w) => w.tag === "A" && /portal\/student\/$/.test(w.href || ""), 40);
    ok("Sf4 前提：用导航走回学员中心", nav2.hit === true &&
       (await (async () => { await press("Enter");
         return until(async () => /\/portal\/student\/$/.test(await path_()), 9000); })()) === true);
    await sleep(2400);
    ok("Sf4b 而且保存没成就离开时，页面拦了一下（beforeunload 提醒，没让他悄悄走）",
       leaveGuards.length > guardsBefore, JSON.stringify(leaveGuards.slice(-2)));
    ok("Sf5 保存没成，这一条待办**还在**（没有跟着消失）",
       (await mainText()).indexOf("完善联系方式") > -1,
       JSON.stringify((await mainText()).slice(0, 120)));

    // ════════ Se 存好之后又接着改：不能把这一版说成已保存 ════════
  }
  if (RUN("Se")) {
    console.log("\n=== Se 存好之后又接着改号码：提示不能误称当前这一版已保存 ===");
    /* 进这一组之前先确认页面是活的：原生对话框开着时 Runtime.evaluate 也会卡，
       卡住的话先把它收掉，免得后面每一次按键都拖成好几秒。 */
    try { await cdp.send("Runtime.evaluate", { expression: "1", returnByValue: true }, 4000); }
    catch (e) {
      console.log("      · 页面没响应，先收掉可能开着的对话框：" + JSON.stringify(leaveGuards.slice(-2)));
      try { await cdp.send("Page.handleJavaScriptDialog", { accept: true }); } catch (e2) {}
    }
    await goStudentHome();
    const go3 = await tabTo((w) => w.tag === "A" && /student\/profile\/$/.test(w.href || "") &&
      /去处理/.test(w.text || ""), 40);
    if (go3.hit) { await press("Enter");
      await until(async () => /\/portal\/student\/profile\/$/.test(await path_()), 9000); }
    await sleep(2200);
    const j3 = await tabTo((w) => w.tag === "BUTTON" && /去填联系电话/.test(w.text || ""), 30);
    if (j3.hit) { await press("Enter"); await sleep(200); }
    await typeText("0111222333");
    const sv3 = await tabTo((w) => w.id === "save", 20);
    if (sv3.hit) { await press("Enter"); savesPressed += 1; }
    ok("Se0 前提：这一版存好了，页面说「已经填好了」",
       await until(async () => /已经填好/.test(await mainText()), 9000),
       JSON.stringify((await mainText()).slice(0, 100)));
    /* 他接着又改了号码 —— 这一版**还没保存**。 */
    const ph3 = await tabTo((w) => w.id === "ph", 30);
    ok("Se1 前提：回到那一格接着改", ph3.hit === true, JSON.stringify(ph3.at));
    await typeText("444");
    ok("Se2 改完之后，页面**不能**还说「已经填好了」（那说的是上一版）",
       !/已经填好|已填好/.test(await mainText()), JSON.stringify((await mainText()).slice(0, 140)));
    ok("Se3 而且要说清楚这一版还没保存",
       /还没保存|尚未保存/.test(await mainText()), JSON.stringify((await mainText()).slice(0, 140)));
    ok("Se4 这一段没有偷偷再发一笔写入",
       (await cdp.ev(`(window.__rpc||[]).filter(r=>r.name==="update_my_contact").length`)) === 1,
       JSON.stringify(await cdp.ev(`(window.__rpc||[]).map(r=>r.name)`)));
  }
  if (RUN("Sp")) {
    console.log("\n=== Sp 首次为空 → 填上 → 在途又改 → 旧版成功：提示说的是哪一版 ===");
    /* 监督点名的那条路：sameVersion=false 时我原来**什么都没做**，
       phState 还停在 empty，于是提示仍说「你还没有填写联系电话」——
       既否认了刚存进去的那一版，也没说眼前这一版还没保存。
       这里把本地 RPC **确定性扣住**再放行，不靠 sleep 赌。 */
    await goStudentHome();
    const g = await tabTo((w) => w.tag === "A" && /student\/profile\/$/.test(w.href || "") &&
      /去处理/.test(w.text || ""), 40);
    ok("Sp0 前提：从待办走到资料页", g.hit === true &&
       (await (async () => { await press("Enter");
         return until(async () => /\/portal\/student\/profile\/$/.test(await path_()), 9000); })()) === true);
    await sleep(2200);
    await cdp.ev(`(()=>{ const o = JSON.parse(localStorage.getItem("__stu")||"{}");
      o.holdSave = true; localStorage.setItem("__stu", JSON.stringify(o)); return true; })()`);
    const j = await tabTo((w) => w.tag === "BUTTON" && /去填联系电话/.test(w.text || ""), 30);
    ok("Sp1 前提：按「去填联系电话」，焦点进那一格", j.hit === true &&
       (await (async () => { await press("Enter"); await sleep(200);
         return (await where()).id === "ph"; })()) === true);
    await typeText("0123456789");
    const sv = await tabTo((w) => w.id === "save", 20);
    ok("Sp2 前提：按下保存", sv.hit === true, JSON.stringify(sv.at));
    await press("Enter"); savesPressed += 1;
    ok("Sp3 前提：这一笔被扣住了（还没回来）",
       await until(async () => cdp.ev(`(()=>!!window.__heldSave)()`), 8000));
    /* 在途期间他又接着改 —— 这一版还没发出去。 */
    const ph2 = await tabTo((w) => w.id === "ph", 25);
    /* Tab 进输入框时浏览器**会把已有内容全选**，直接打字就替换掉了
       （上一次跑读回来是 "999"，不是接着打的）—— 先按 End 收掉选中。
       这是量具的事，不是产品的。 */
    await press("End");
    ok("Sp4 前提：回到那一格接着改（先 End 取消全选）", ph2.hit === true, JSON.stringify(ph2.at));
    await typeText("999");
    ok("Sp5 前提：现在框里是他改过的那一版", (await phoneVal()) === "0123456789999",
       JSON.stringify(await phoneVal()));
    await cdp.ev(`(()=>{ if (window.__releaseSave) window.__releaseSave(); return true; })()`);
    ok("Sp6 前提：旧那一版回来了（成功）",
       await until(async () => (await toastText()).length > 0, 9000), JSON.stringify(await toastText()));
    await sleep(400);
    const note = await mainText();
    ok("Sp7 不能再说「你还没有填写联系电话」（明明存进去了一版）",
       !/你还没有填写联系电话/.test(note), JSON.stringify(note.slice(0, 160)));
    ok("Sp8 要说清楚**已保存的是提交出去的那一版**",
       /刚才提交的那一版/.test(note) && /0123456789/.test(note), JSON.stringify(note.slice(0, 160)));
    ok("Sp9 也要说清楚**眼前这一版还没保存**", /还没保存/.test(note), JSON.stringify(note.slice(0, 160)));
    ok("Sp10 他改的那一版一个字都没丢", (await phoneVal()) === "0123456789999",
       JSON.stringify(await phoneVal()));
    ok("Sp11 这种时候不给「回到学员中心」那条出口（不邀请他带着没保存的改动离开）",
       (await cdp.ev(`(()=>{const b=document.getElementById("phNote");
         return b ? !/回到学员中心/.test(b.textContent||"") : null;})()`)) === true,
       JSON.stringify(await cdp.ev(`(()=>{const b=document.getElementById("phNote");
         return b?(b.textContent||"").trim():null;})()`)));
    ok("Sp12 提示里不会冒出 Markdown 星号（HTML 字符串里写 ** 会原样显示）",
       (await cdp.ev(`(()=>{const b=document.getElementById("phNote");
         return b ? (b.textContent||"").indexOf("**") < 0 : null;})()`)) === true,
       JSON.stringify(await cdp.ev(`(()=>{const b=document.getElementById("phNote");
         return b?(b.textContent||"").trim():null;})()`)));
    ok("Sp13 全程只发了这一笔写入（在途期间的改动没有偷偷再发）",
       (await cdp.ev(`(window.__rpc||[]).filter(r=>r.name==="update_my_contact").length`)) === 1,
       JSON.stringify(await cdp.ev(`(window.__rpc||[]).map(r=>r.name)`)));
  }

  if (RUN("Cp")) {
    console.log("\n=== Cp 待办「建立你的信仰成长档案」：点进去之后回不回得来 ===");
    /* 入口完整性三问：① 那个 target_url 真有页面吗？② 这个角色到得了吗？
       ③ 做完之后有没有一条明确的出口？
       前两问 discover.html 都过（它是公开页，没有守卫）；第三问是这一包要查的。 */
    await goStudentHome();
    ok("Cp0 前提：待办里确实有这一条", (await mainText()).indexOf("建立你的信仰成长档案") > -1,
       JSON.stringify((await mainText()).slice(0, 140)));
    const cp = await tabTo((w) => w.tag === "A" && /discover\.html/.test(w.href || "") &&
      /去处理|去查看/.test(w.text || ""), 40);
    ok("Cp1 Tab 走得到它的「去处理 →」", cp.hit === true, JSON.stringify(cp.at));
    /* 入口文案不能承诺这一页做不到的事：那边只是 3 分钟快速探索，不建档案。 */
    const cardLink = await cdp.ev(`(()=>{const a=[...document.querySelectorAll("a")]
      .filter(x=>/discover\.html/.test(x.getAttribute("href")||"") && !/去处理|去查看/.test(x.textContent||""))[0];
      return a ? (a.textContent||"").replace(/\s+/g," ").trim() : null;})()`);
    ok("Cp1b 首页那条入口的文案说的是「快速探索」，不是「建立档案」",
       !!cardLink && /快速探索/.test(cardLink) && !/建立你的信仰成长档案/.test(cardLink),
       JSON.stringify(cardLink));
    /* 待办那条动作链接也不该说「去处理」—— 那一页处理不了任何事。
       （待办的**标题**来自 SQL，本地改不了，只能如实记，见报告。） */
    ok("Cp1c 待办里那条站外动作链接不说「去处理」",
       !/去处理/.test((cp.at || {}).text || ""), JSON.stringify((cp.at || {}).text));
    await press("Enter");
    ok("Cp2 ① 那个 target_url 真的有页面（走过去了，不是 404）",
       await until(async () => /\/discover\.html$/.test(await path_()), 9000),
       JSON.stringify(await path_()));
    await sleep(1200);
    ok("Cp3 ② 学员这个身份到得了（公开页，没有被守卫挡回去）",
       (await cdp.ev(`(()=>document.querySelectorAll("h1").length > 0)()`)) === true);
    /* ②b 这一页到底做不做「建立档案」这件事 —— 用它自己的代码说话。 */
    /* 说得准一点：这一页**唯一**碰到的本地存储是 goApp() 里记「你从哪个按钮跳去 App」
       的 amas_discover_src —— 那不是档案，也不是答题结果。
       上一版我把断言写成「没有任何本地存储」，太宽了（实测 store=true）。
       正则不用反斜杠转义：模板字面量会把 \( 吃成 (，正则会变成未闭合分组。 */
    const persists = await cdp.ev(`(()=>{const t=document.documentElement.innerHTML;
      const keys = (t.match(/(?:localStorage|sessionStorage)[.]setItem[(]\s*['"]([^'"]+)/g) || []);
      return { storageCalls: keys.length,
               onlySrcKey: /amas_discover_src/.test(t) && !/setItem[(]\s*['"](?!amas_discover_src)/.test(t),
               net: /fetch[(]|supabase/.test(t),
               saysQuick: /只是一次快速探索|不是完整的/.test(document.body.textContent||"") };})()`);
    ok("Cp3b 这一页**不保存档案、也不往服务端写**（唯一的本地存储是跳 App 的来源标记）",
       persists && persists.net === false && persists.onlySrcKey === true &&
       persists.saysQuick === true, JSON.stringify(persists));
    /* 真实路径要走完：开始 → 逐题作答 → 看到结果，再谈回程。
       只开一页就返回证明不了「做完之后回得来」。 */
    const startBtn = await tabTo((w) => /开始快速探索/.test(w.text || ""), 40);
    ok("Cp3c 键盘走得到「开始快速探索」", startBtn.hit === true, JSON.stringify(startBtn.at));
    await press("Enter");
    ok("Cp3d 题目出来了", await until(async () => cdp.ev(`(()=>{const q=document.getElementById("quiz");
      return !!(q && !q.classList.contains("hidden"));})()`), 8000));
    /* 逐题作答：每次 Tab 到一个选项按下，直到结果出现（上限足够 10 题）。 */
    let answered = 0;
    for (let i = 0; i < 60; i++) {
      const done = await cdp.ev(`(()=>{const r=document.getElementById("result");
        return !!(r && !r.classList.contains("hidden"));})()`);
      if (done) break;
      await press("Tab");
      const onOpt = await cdp.ev(`(()=>{const a=document.activeElement;
        return !!(a && a.classList && a.classList.contains("opt"));})()`);
      if (onOpt) { await press("Enter"); answered += 1; await sleep(160); }
    }
    ok("Cp3e 十道题用键盘答完了，结果页出来了（答了 " + answered + " 题）",
       (await cdp.ev(`(()=>{const r=document.getElementById("result");
         return !!(r && !r.classList.contains("hidden"));})()`)) === true &&
       answered >= 10, "answered=" + answered);
    ok("Cp3f 结果页自己也写明这**不是**完整档案",
       /不代表完整信仰成长档案|不是完整的/.test(await cdp.ev(`(()=>document.body.textContent||"")()`)),
       "");

    /* ③ 出口：这一页有没有任何一条能回门户的路。 */
    const outs = await cdp.ev(`(()=>[...document.querySelectorAll("a")]
      .map(a=>({ href:a.getAttribute("href")||"", text:(a.textContent||"").replace(/\s+/g," ").trim().slice(0,14) }))
      .filter(x=>/portal/.test(x.href)))()`);
    ok("Cp4 ③ 做完之后回得到门户（页面上有一条通往 portal 的出口）",
       Array.isArray(outs) && outs.length >= 1, JSON.stringify(outs));
    if (Array.isArray(outs) && outs.length) {
      const back = await tabTo((w) => w.tag === "A" && /portal\/student\/$/.test(w.href || ""), 40);
      ok("Cp5 而且那条出口用键盘走得到、按下去真的回到了学员中心",
         back.hit === true &&
         (await (async () => { await press("Enter");
           return until(async () => /\/portal\/student\/$/.test(await path_()), 9000); })()) === true,
         JSON.stringify(await path_()));
      await sleep(2200);
      /* 回来之后**不许**谎称这件事做完了：这一页什么都没保存，
         而 my_action_items 里 christian_profile 那条本来就是无条件出现的。 */
      ok("Cp5b 回到学员中心之后，这条待办**还在**（没有被谎称已完成）",
         (await mainText()).indexOf("建立你的信仰成长档案") > -1,
         JSON.stringify((await mainText()).slice(0, 140)));
      ok("Cp5c 而且首页没有冒出任何「已完成 / 已建立档案」的说法",
         !/已建立档案|档案已完成|已完成信仰成长档案/.test(await mainText()),
         JSON.stringify((await mainText()).slice(0, 140)));
    }
    /* 反控：**不是**从门户过来的普通访客，这一页不该多出门户入口。 */
    await cdp.send("Page.navigate", { url: `${BASE}/discover.html` });
    await sleep(1500);
    const outsPlain = await cdp.ev(`(()=>[...document.querySelectorAll("a")]
      .map(a=>a.getAttribute("href")||"").filter(h=>/portal/.test(h)))()`);
    ok("Cp6 反控：普通访客直接打开这一页时，**不**多出任何门户入口",
       Array.isArray(outsPlain) && outsPlain.length === 0, JSON.stringify(outsPlain));
  }

  if (RUN("Cn")) {
    console.log("\n=== Cn 站外那条待办：动作旁边说不说得清「这一页做得到什么」 ===");
    /* 服务端的标题与状态原样不动（my_action_items 的契约不改）；
       只在**这一个已知的站外参考目标**旁边补一句说明。
       门户内的待办不受影响 —— 不按「非 portal 就算参考」一刀切。 */
    await goStudentHome();
    const cpCard = await cdp.ev(`(()=>{const d=[...document.querySelectorAll(".act")]
      .find(x=>/建立你的信仰成长档案/.test(x.textContent||""));
      return d ? (d.textContent||"").replace(/\s+/g," ").trim() : null;})()`);
    ok("Cn0 前提：服务端给的标题**原样**还在（没有被前端改写）",
       !!cpCard && cpCard.indexOf("建立你的信仰成长档案") > -1, JSON.stringify(cpCard));
    ok("Cn1 这条待办旁边说清楚了「这一页只作快速探索、不会完成这条待办」",
       !!cpCard && /仅作快速探索/.test(cpCard) && /不会建立档案或完成此待办/.test(cpCard),
       JSON.stringify(cpCard));
    ok("Cn2 也指明了正式评估在哪里做（不编造安装链接）",
       !!cpCard && /App 中进行/.test(cpCard) &&
       (await cdp.ev(`(()=>[...document.querySelectorAll("a")]
          .some(a=>/apps\.apple|play\.google|download/i.test(a.getAttribute("href")||"")))()`)) === false,
       JSON.stringify(cpCard));
    const phCard = await cdp.ev(`(()=>{const d=[...document.querySelectorAll(".act")]
      .find(x=>/完善联系方式/.test(x.textContent||""));
      return d ? (d.textContent||"").replace(/\s+/g," ").trim() : null;})()`);
    ok("Cn3 门户内那条「完善联系方式」**没有**被误加这句说明",
       !!phCard && !/仅作快速探索|不会建立档案/.test(phCard), JSON.stringify(phCard));
    ok("Cn4 而且它的动作仍然是「去处理」（没有被泛化成不能处理）",
       !!phCard && /去处理/.test(phCard), JSON.stringify(phCard));

    /* 最小对照：登记表必须只认**自己登记过**的那一条。
       普通对象的 constructor / toString 等继承属性都是真值 ——
       拿它做索引会把未登记目标当成已登记。只测这一对照，不铺畸形输入大套件。 */
    const extraId = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source:
      `(function(){ try { var t = setInterval(function(){
         if (!window.__SCEN || !window.__SCEN.rpc) return;
         clearInterval(t);
         window.__SCEN.rpc.my_action_items = { data: [
           { source_type:"christian_profile", source_id:"x", title:"未登记的站外目标",
             reason:"对照用", target_url:"constructor", status:"open", priority:10 },
           { source_type:"profile", source_id:"y", title:"另一个未登记目标",
             reason:"对照用", target_url:"help/", status:"open", priority:20 } ] };
       }, 0); } catch(e){} })();` });
    await cdp.send("Page.navigate", { url: `${BASE}/portal/student/` });
    await sleep(2800);
    const cards = await cdp.ev(`(()=>[...document.querySelectorAll(".act")]
      .map(x=>(x.textContent||"").replace(/\s+/g," ").trim()))()`);
    ok("Cn5 前提：两条**未登记**的目标都渲染出来了", Array.isArray(cards) && cards.length === 2,
       JSON.stringify(cards));
    ok("Cn6 target_url=\"constructor\" 不算已登记：没有那句说明，动作仍是「去处理」",
       Array.isArray(cards) && cards.some(c => /未登记的站外目标/.test(c) &&
         !/仅作快速探索/.test(c) && /去处理/.test(c)), JSON.stringify(cards));
    ok("Cn7 另一个未登记目标同样默认「去处理」",
       Array.isArray(cards) && cards.some(c => /另一个未登记目标/.test(c) &&
         !/仅作快速探索/.test(c) && /去处理/.test(c)), JSON.stringify(cards));
    if (extraId && extraId.identifier) {
      try { await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: extraId.identifier }); } catch (e) {}
    }
  }

  if (RUN("A")) {
    console.log("\n=== A 记账口径自检 ===");
    await sleep(600);
    const rpcs = probeLog.filter(r => r.kind === "rpc");
    const unclassified = rpcs.filter(r => !READONLY_RPC.has(r.name) && !WRITE_RPC.has(r.name));
    ok("A1 出现过的 RPC 都能分类（只读白名单 + 本包**有意**发出的那一笔写入）",
       unclassified.length === 0,
       JSON.stringify({ 出现过: [...new Set(rpcs.map(r => r.name))], 未分类: unclassified.map(r => r.name) }));
    /* 全程一共**三次有意**的保存：St 成功、Sf 失败、Se 成功。
       （上一版这里写死成 1，是我的计数没跟上新加的两组。） */
    ok("A2 写入次数正好等于**我按下保存的次数**，没有别的写入",
       rpcs.filter(r => WRITE_RPC.has(r.name)).length === savesPressed &&
       rpcs.filter(r => !READONLY_RPC.has(r.name) && !WRITE_RPC.has(r.name)).length === 0,
       JSON.stringify(rpcs.filter(r => WRITE_RPC.has(r.name)).map(r => r.name)));
    ok("A3 没有走任何 Edge Function", edgeCalls.length === 0, JSON.stringify(edgeCalls));
    const byVisit = {};
    probeLog.forEach((r) => { (byVisit[r.visit] = byVisit[r.visit] || []).push(r.seq); });
    const gaps = Object.entries(byVisit).filter(([, seqs]) => {
      const a = [...seqs].sort((x, y) => x - y);
      return a[0] !== 1 || a.some((x, i) => x !== i + 1);
    });
    ok("A4 终局对齐：每一次页面载入的记录 seq 连续无缺口", gaps.length === 0, JSON.stringify(gaps.slice(0, 2)));
  }
  if (RUN("G")) {
    console.log("\n=== G 外发 ===");
    ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");
    ok("G2 全程没有页面异常", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
  }
  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
}

stopWatchdog();
console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。");
process.exit(fail ? 1 : 0);
