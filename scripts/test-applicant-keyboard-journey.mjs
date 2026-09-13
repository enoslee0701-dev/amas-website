// 申请人主线的**跨页那一段**：用真实键盘从门户首页走到「我的申请」，
// 再走回来，看两页之间的状态衔接对不对。
//
// 为什么是这一段：第七十七包起的 test-keyboard-flow.mjs（47 条）**全部在
// 「我的申请」这一页之内**（步骤条 / 字段 / 提交 / 补件 / 动态行），
// 每一页各自的键盘可用性也都有单页探针 —— 唯独**页与页之间**没有用键盘贯通过：
//   · 每一页的「跳到主要内容」到底管不管用（不管用的话，他每翻一页
//     都得把导航整条 Tab 一遍才碰得到正文）；
//   · 首页那个「下一步」入口能不能用键盘真的**走过去**；
//   · 走过去之后是不是同一份申请；走回来之后首页的下一步会不会**跟着变**。
//
// 全程真实按键（Tab / Enter），不用 element.focus()/.click() 代替用户。
// 不重跑任何已覆盖的单页探针。本地合成夹具：无真实账号/凭据/服务，无外网请求。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-journey-"));
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
let pass = 0, fail = 0, externalHits = 0;
/* 分组开关：ONLY=S,U,R,F,G 就只跑这几组。
   监督的口径是「不要整跑既有 66」——但被这次改动**真正影响到**的那几组必须跑，
   所以要能挑着跑，而不是靠「这次先不跑」蒙混。不设 ONLY 时全跑。 */
const ONLY = String(process.env.ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
const RUN = (g) => !ONLY.length || ONLY.indexOf(g) > -1;
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
function beacon(rec){
  try {
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
    var q = {
      select:function(c){ cols = (c === undefined ? null : c); return q; },
      eq:function(k,v){ eqs[k]=v; return q; },
      in:function(){return q;}, match:function(){return q;},
      order:function(){return q;}, range:function(){return q;}, limit:function(){return q;},
      maybeSingle:function(){return q;}, single:function(){return q;},
      insert:function(){ mode="insert"; return q; }, update:function(){ mode="update"; return q; },
      then:function(res, rej){
        var sc = S();
        /* 每一次查询都留痕：表、模式、列投影、eq 条件 —— 断言就读这里。 */
        try { (window.__q = window.__q || []).push({ name:name, mode:mode, cols:cols, eq:eqs }); } catch(e){}
        beacon({ kind:"table", name:name, mode:mode, cols:cols, eq:eqs, page:location.pathname });
        var t = (mode === "select") ? ((sc.tables && sc.tables[name]) || { data:[], error:null })
                                    : (sc.write || { data:[], error:null });
        var out = { data:t.data, error:t.error||null,
          status: t.status != null ? t.status : (t.error ? 500 : 200) };
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
      if (name === "my_roles") return reply({ data:[{ role:"applicant" }], error:null, status:200 });
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
  let pageErrors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    pageErrors.push(String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || "").slice(0, 200));
  });

  const KEYS = { Tab:{code:"Tab",key:"Tab",vk:9}, Enter:{code:"Enter",key:"Enter",vk:13} };
  const press = async (name, shift) => {
    const m = KEYS[name], mods = shift ? 8 : 0;
    await cdp.send("Input.dispatchKeyEvent", { type:"rawKeyDown", modifiers:mods,
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    if (name === "Enter") await cdp.send("Input.dispatchKeyEvent", { type:"char", modifiers:mods,
      text:"\r", key:m.key, code:m.code });
    await cdp.send("Input.dispatchKeyEvent", { type:"keyUp", modifiers:mods,
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    await sleep(90);
  };
  const until = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 8000)) { try { if (await fn()) return true; } catch (e) {} await sleep(120); }
    return false;
  };
  const where = async () => cdp.ev(`(()=>{const a=document.activeElement;
    if(!a || a===document.body) return { tag:"BODY" };
    return { tag:a.tagName, id:a.id||"", cls:(a.className||"").toString().slice(0,20),
             href:(a.getAttribute && a.getAttribute("href")) || "",
             text:(a.textContent||"").replace(/\s+/g," ").trim().slice(0,20) };})()`);
  const path_ = async () => cdp.ev(`location.pathname`);
  const inMain = async () => cdp.ev(`(()=>{const a=document.activeElement, m=document.getElementById("main");
    return !!(a && m && (a === m || m.contains(a)));})()`);
  const badge = async () => cdp.ev(`(()=>{const e=document.querySelector(".st");
    return e?(e.textContent||"").trim():null;})()`);
  const mainText = async () => cdp.ev(`(()=>{const m=document.getElementById("main");
    return m ? (m.textContent||"").replace(/\s+/g," ").trim() : "";})()`);
  const queries = async () => (await cdp.ev(`(window.__q || [])`)) || [];
  const writes = async () => (await queries()).filter(q => q.mode !== "select");
  /* 一路 Tab 直到落在满足条件的元素上 —— 只按键，不代劳。 */
  const tabTo = async (pred, max) => {
    for (let i = 1; i <= (max || 40); i++) {
      await press("Tab");
      const w = await where();
      if (pred(w)) return { hit: true, steps: i, at: w };
    }
    return { hit: false, at: await where() };
  };

  /* 唯一标识：光看「草稿」这个徽章证明不了走到的是同一份申请
     （监督点名）。所以给这一份配一个**只属于它**的可见特征，
     再配上「请求里带的就是这个 id」的关联证据。 */
  const UNIQ = "申请人甲-UNIQ-7391";
  const APP = (over) => Object.assign({
    id:"app-1", pathway:"degree", status:"draft",
    form_data:{ name_zh:UNIQ, programs:["bth"] }, form_version:"v1",
    locked_fields:[], applicant_visible_message:null,
    submitted_at:null, decided_at:null, updated_at:"2026-09-06T00:00:00Z",
  }, over || {});
  const scenSrc = (appOver) => "window.__SCEN = " + JSON.stringify({
    uid:"u-appl", aal:"aal1",
    tables: {
      program_catalog: { data:[{ code:"bth", name_zh:"神学本科", short_label:"B.Th",
        category:"degree", intake_note_zh:"", is_open_for_application:true, sort_order:1 }] },
      application_requirements: { data: [] },
      application_status_history: { data: [] },
      application_hq_approvals: { data: [] },
      /* 历史申请页读的是 applications 表（my_application 刻意排除了这两种状态）。 */
      applications: { data:[
        { id:"app-old-1", pathway:"common_learning", status:"withdrawn",
          applicant_visible_message:"这一份由我自己撤回-UNIQ-A", submitted_at:"2025-09-01T00:00:00Z",
          decided_at:"2025-09-20T00:00:00Z", created_at:"2025-08-01T00:00:00Z" },
        { id:"app-old-2", pathway:"bth", status:"rejected",
          applicant_visible_message:"这一份未通过-UNIQ-B", submitted_at:"2024-09-01T00:00:00Z",
          decided_at:"2024-09-20T00:00:00Z", created_at:"2024-08-01T00:00:00Z" } ] },
    },
    rpc: { my_application: { data:[APP(appOver)] },
           my_application_timeline: { data:[
             { to_status:"withdrawn", created_at:"2025-09-20T00:00:00Z",
               applicant_visible_message:"时间线里这一条-UNIQ-T" } ] },
           my_profile: { data:{ display_name:UNIQ, email:"uniq7391@example.invalid" } } },
    write: { data:[], error:null },
  }) + "; window.__q=[]; window.__rpc=[];";
  const goHome = async (appOver) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: scenSrc(appOver) });
    await cdp.send("Page.navigate", { url: `${BASE}/portal/applicant/` });
    await sleep(2600);
  };

  // ════════ J 跨页那一段：首页 →「我的申请」→ 回首页 ════════
  console.log("\n=== J 用键盘走完跨页那一段（首页 → 我的申请 → 回首页）===");
  await goHome();
  ok("J0 前提：门户首页出来了（草稿状态）", (await path_()).indexOf("/portal/applicant/") === 0 &&
     (await mainText()).length > 0, JSON.stringify(await path_()));

  /* 每一页的第一条键盘出口：跳到主要内容。不管用的话，他每翻一页
     都得把整条导航 Tab 一遍才碰得到正文。 */
  const s1 = await tabTo((w) => /skip/.test(w.cls || "") || /跳到主要内容/.test(w.text || ""), 6);
  /* 「碰得到」不等于「第一下就碰得到」—— 必须是 steps === 1（监督点名）。 */
  ok("J1 首页上**第一次** Tab 就落在「跳到主要内容」上",
     s1.hit === true && s1.steps === 1, JSON.stringify(s1));
  await press("Enter");
  await sleep(400);
  ok("J2 按下之后焦点真的进了正文（不必把导航整条 Tab 一遍）",
     (await inMain()) === true, JSON.stringify(await where()));

  const go = await tabTo((w) => w.tag === "A" && /application\/$/.test(w.href || ""), 40);
  ok("J3 从正文里 Tab 走得到「下一步」那个入口", go.hit === true, JSON.stringify(go.at));
  const label = (go.at || {}).text || "";
  await press("Enter");
  ok("J4 Enter 真的**走过去**了（地址变成我的申请页）",
     await until(async () => /\/portal\/applicant\/application\/$/.test(await path_()), 9000),
     JSON.stringify({ label, path: await path_() }));
  await sleep(2200);

  const s2 = await tabTo((w) => /skip/.test(w.cls || "") || /跳到主要内容/.test(w.text || ""), 6);
  ok("J5 新页面上同样是**第一下** Tab 就落在它上面（跨页一致）",
     s2.hit === true && s2.steps === 1, JSON.stringify(s2));
  await press("Enter"); await sleep(400);
  ok("J6 按下之后焦点也进了正文", (await inMain()) === true, JSON.stringify(await where()));
  /* 同一份申请要有**证据**：① 页面上出现只属于它的那个标识；
     ② 这一页发出的请求里带的就是它的 id（application_requirements 的
     eq.application_id，见 application/index.html:365）。徽章只说明状态。 */
  const seenUniq = await cdp.ev(`(()=>{const m=document.getElementById("main");
    const t=(m?m.textContent:"")||""; const v=[...document.querySelectorAll("input")]
      .map(i=>i.value||"").join(" "); return (t+" "+v).indexOf(${JSON.stringify(UNIQ)}) > -1;})()`);
  const corr = probeLog.filter(r => r.kind === "table" && r.name === "application_requirements" &&
    r.page.indexOf("/application/") > -1 && r.eq && r.eq.application_id === "app-1");
  ok("J7 走到的确实是**同一份申请**：页面上有只属于它的标识",
     seenUniq === true, JSON.stringify({ seenUniq, badge: await badge() }));
  ok("J7b 而且这一页发出的请求带的就是它的 id（请求关联证据）",
     corr.length >= 1, JSON.stringify(probeLog.filter(r => r.kind === "table").slice(-3)));

  /* 走回首页：用导航里的「首页」链接，全程键盘。 */
  const back = await tabTo((w) => w.tag === "A" && /portal\/applicant\/$/.test(w.href || ""), 40);
  ok("J8 Tab 走得到导航里的「首页」", back.hit === true, JSON.stringify(back.at));
  await press("Enter");
  ok("J9 Enter 真的走回了首页",
     await until(async () => /\/portal\/applicant\/$/.test(await path_()), 9000),
     JSON.stringify(await path_()));
  await sleep(2200);

  /* 状态衔接：教务那边把它变成「已提交」之后，首页的下一步要跟着变。 */
  const homeDraft = await mainText();
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: scenSrc({ status:"submitted",
    submitted_at:"2026-09-07T00:00:00Z" }) });
  const back2 = await tabTo((w) => w.tag === "A" && /application\/$/.test(w.href || ""), 40);
  if (back2.hit) { await press("Enter");
    await until(async () => /\/portal\/applicant\/application\/$/.test(await path_()), 9000);
    await sleep(1800); }
  ok("J10 前提：再走一趟我的申请页，这一次状态已经是「已提交」",
     (await badge()) === "已提交", JSON.stringify(await badge()));
  const back3 = await tabTo((w) => w.tag === "A" && /portal\/applicant\/$/.test(w.href || ""), 40);
  ok("J11 前提：再用键盘走回首页", back3.hit === true &&
     (await (async () => { await press("Enter");
       return until(async () => /\/portal\/applicant\/$/.test(await path_()), 9000); })()) === true,
     JSON.stringify(await path_()));
  await sleep(2200);
  const homeSubmitted = await mainText();
  ok("J12 首页的下一步**跟着状态变了**（不是还停在草稿那一套说法）",
     homeSubmitted !== homeDraft && /已提交|等待|查看申请/.test(homeSubmitted),
     JSON.stringify({ draftHead: homeDraft.slice(0, 60), nowHead: homeSubmitted.slice(0, 60) }));
  /* 跨页累计：window.__q 每次导航都清零，只能代表最后一页 ——
     这里读的是**宿主**收到的全部记录（每一页都打过来了）。 */
  const hostWrites = probeLog.filter(r => r.kind === "table" && r.mode !== "select");
  const hostRpcWrites = probeLog.filter(r => r.kind === "rpc" &&
    /^(update_|insert_|submit_|withdraw_|resolve_|review_|confirm_|create_|activate_|correct_|request_|approve_|reject_)/.test(r.name || ""));
  const pagesSeen = [...new Set(probeLog.map(r => r.page))];
  ok("J13 这一整段（**每一页都算上**）全是导航与读取，没有任何写入",
     hostWrites.length === 0 && hostRpcWrites.length === 0 && edgeCalls.length === 0,
     JSON.stringify({ hostWrites, hostRpcWrites, edgeCalls }));
  ok("J13b 而且累计器确实覆盖了走过的每一页（不是只剩最后一页）",
     pagesSeen.filter(x => /\/portal\/applicant\/$/.test(x)).length >= 1 &&
     pagesSeen.filter(x => /\/application\/$/.test(x)).length >= 1,
     JSON.stringify({ pagesSeen, records: probeLog.length }));

  // ════════ H 历史申请：主线之外的那一页，键盘走得过去也回得来 ════════
  console.log("\n=== H 跨页：主线 → 历史申请 → 回主线 ===");
  const hs = await tabTo((w) => w.tag === "A" && /portal\/applicant\/history\/$/.test(w.href || ""), 40);
  ok("H0 Tab 走得到导航里的「历史申请」", hs.hit === true, JSON.stringify(hs.at));
  await press("Enter");
  ok("H1 Enter 真的走过去了",
     await until(async () => /\/portal\/applicant\/history\/$/.test(await path_()), 9000),
     JSON.stringify(await path_()));
  await sleep(2200);
  const hsk = await tabTo((w) => /skip/.test(w.cls || "") || /跳到主要内容/.test(w.text || ""), 6);
  ok("H2 这一页也是**第一下** Tab 就落在「跳到主要内容」上",
     hsk.hit === true && hsk.steps === 1, JSON.stringify(hsk));
  await press("Enter"); await sleep(400);
  ok("H3 按下之后焦点进了正文", (await inMain()) === true, JSON.stringify(await where()));
  const htext = await mainText();
  ok("H4 列出的是**已结束**的那两份（各自的唯一标识都在）",
     htext.indexOf("这一份由我自己撤回-UNIQ-A") > -1 && htext.indexOf("这一份未通过-UNIQ-B") > -1,
     JSON.stringify(htext.slice(0, 120)));
  ok("H4b 而且没有把主线上**进行中**的那一份混进来",
     htext.indexOf(UNIQ) < 0, JSON.stringify(htext.slice(0, 120)));
  const tl = await tabTo((w) => /查看状态变化/.test(w.text || ""), 30);
  ok("H5 Tab 走得到「查看状态变化」", tl.hit === true, JSON.stringify(tl.at));
  await press("Enter");
  ok("H6 Enter 真的展开了时间线（而且是这一份自己的那条记录）",
     await until(async () => (await mainText()).indexOf("时间线里这一条-UNIQ-T") > -1, 9000),
     JSON.stringify((await mainText()).slice(0, 140)));
  const afterTl = await where();
  ok("H7 展开之后焦点没有掉回页首（还在那个按钮上）",
     afterTl.tag === "BUTTON" && /收起状态变化|查看状态变化/.test(afterTl.text || ""),
     JSON.stringify(afterTl));
  ok("H8 展开时间线走的是读取，不是写入",
     probeLog.filter(r => r.kind === "rpc" && r.name === "my_application_timeline").length >= 1 &&
     probeLog.filter(r => r.kind === "table" && r.mode !== "select").length === 0,
     JSON.stringify(probeLog.filter(r => r.kind === "rpc").slice(-2)));
  const backApp = await tabTo((w) => w.tag === "A" && /portal\/applicant\/application\/$/.test(w.href || ""), 40);
  ok("H9 从这一页用键盘回得到主线「我的申请」", backApp.hit === true &&
     (await (async () => { await press("Enter");
       return until(async () => /\/application\/$/.test(await path_()), 9000); })()) === true,
     JSON.stringify(await path_()));
  await sleep(2000);
  const backUniq = await cdp.ev(`(()=>{const m=document.getElementById("main");
    const t=(m?m.textContent:"")||""; const v=[...document.querySelectorAll("input")]
      .map(i=>i.value||"").join(" "); return (t+" "+v).indexOf(${JSON.stringify(UNIQ)}) > -1;})()`);
  ok("H10 回来的还是那一份进行中的申请（唯一标识还在）", backUniq === true);

  // ════════ P 个人资料：同一个人，走得过去也回得来 ════════
  console.log("\n=== P 跨页：主线 → 个人资料 → 回首页 ===");
  const pf = await tabTo((w) => w.tag === "A" && /portal\/applicant\/profile\/$/.test(w.href || ""), 40);
  ok("P0 Tab 走得到导航里的「个人资料」", pf.hit === true, JSON.stringify(pf.at));
  await press("Enter");
  ok("P1 Enter 真的走过去了",
     await until(async () => /\/portal\/applicant\/profile\/$/.test(await path_()), 9000),
     JSON.stringify(await path_()));
  await sleep(2200);
  const psk = await tabTo((w) => /skip/.test(w.cls || "") || /跳到主要内容/.test(w.text || ""), 6);
  ok("P2 这一页也是**第一下** Tab 就落在「跳到主要内容」上",
     psk.hit === true && psk.steps === 1, JSON.stringify(psk));
  await press("Enter"); await sleep(400);
  ok("P3 按下之后焦点进了正文", (await inMain()) === true, JSON.stringify(await where()));
  const ptext = await cdp.ev(`(()=>{const m=document.getElementById("main");
    const t=(m?m.textContent:"")||""; const v=[...document.querySelectorAll("input")]
      .map(i=>i.value||"").join(" "); return t+" "+v;})()`);
  ok("P4 显示的确实是**同一个人**（唯一标识在页面上）",
     ptext.indexOf(UNIQ) > -1 || ptext.indexOf("uniq7391@example.invalid") > -1,
     JSON.stringify(ptext.slice(0, 120)));
  const home2 = await tabTo((w) => w.tag === "A" && /portal\/applicant\/$/.test(w.href || ""), 40);
  ok("P5 从这一页用键盘回得到首页", home2.hit === true &&
     (await (async () => { await press("Enter");
       return until(async () => /\/portal\/applicant\/$/.test(await path_()), 9000); })()) === true,
     JSON.stringify(await path_()));
  await sleep(2000);
  const wEnd = probeLog.filter(r => r.kind === "table" && r.mode !== "select");
  const rEnd = probeLog.filter(r => r.kind === "rpc" &&
    /^(update_|insert_|submit_|withdraw_|resolve_|review_|confirm_|create_|activate_|correct_|request_|approve_|reject_)/.test(r.name || ""));
  ok("P6 这四页走下来（宿主累计），一次写入都没有",
     wEnd.length === 0 && rEnd.length === 0 && edgeCalls.length === 0,
     JSON.stringify({ wEnd, rEnd, edgeCalls }));
  const pages = [...new Set(probeLog.map(r => r.page))];
  ok("P7 累计器确实覆盖到四页（首页 / 我的申请 / 历史申请 / 个人资料）",
     pages.filter(x => /\/portal\/applicant\/$/.test(x)).length >= 1 &&
     pages.filter(x => /\/application\/$/.test(x)).length >= 1 &&
     pages.filter(x => /\/history\/$/.test(x)).length >= 1 &&
     pages.filter(x => /\/profile\/$/.test(x)).length >= 1,
     JSON.stringify({ pages, records: probeLog.length }));

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
console.log("  本探针只覆盖**跨页那一段**；单页内部的键盘可用性见 test-keyboard-flow 等，未在此重跑。");
process.exit(fail ? 1 : 0);
