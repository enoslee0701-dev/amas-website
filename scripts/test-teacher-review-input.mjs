// 教师验证审核页：**审核说明**在列表重绘之后还在不在。
//
// 这一页不是自建模态 —— 它是**页内卡片**（每条申请一张卡，卡里一个 textarea
// 加一排动作按钮），确认用的是站内共用的 UI.confirmDialog。
//
// 查的这一项：审核说明是**对方可见**的正式答复，而且
// needs_information / reject / suspend / revoke 四个动作**必须填**
// （portal/admin/teachers/index.html:89）。可是 render() 每次都把
// main.innerHTML 整个换掉（:128），于是只要列表重绘一次 ——
//   ① 在别的卡上执行完动作之后 900ms 的自动刷新（:291）
//   ② 切一下状态筛选
// —— 他写到一半的说明就没了，页面既不提示、也不给任何出口。
//
// 全程真实按键（Input.dispatchKeyEvent），不用 element.click()/focus() 替用户走路；
// 判定读**状态**（textarea 的 value、POST 的 body），不猜文案。
// 本地合成 admin/aal2 夹具：无真实账号/凭据/服务，无远端写入，无外网请求。独占动态端口。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { refuseLocalConfig } from "./lib/no-local-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".png":"image/png", ".ico":"image/x-icon", ".woff2":"font/woff2" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (refuseLocalConfig(p, res)) return;   // 不伺服本机真实配置（INCIDENT-0916）
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-tvr-"));
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
/* 分组开关：ONLY=Lv,Rd,G 就只跑这几组。
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
        var t = (mode === "select") ? ((sc.tables && sc.tables[name]) || { data:[], error:null })
                                    : (sc.write || { data:[], error:null });
        var out = { data:t.data, error:t.error||null,
          status: t.status != null ? t.status : (t.error ? 500 : 200) };
        /* 列表读取可以被扣住：这样才能确定性地制造出「正在 loading」那一段，
           而不是靠 sleep 赌。放行由测试显式调用 window.__releaseSelect()。 */
        if (mode === "select" && window.__holdSelect) {
          return new Promise(function(r){
            window.__heldSelect = true;
            window.__releaseSelect = function(){ window.__holdSelect = false; window.__heldSelect = false; r(out); };
          }).then(res, rej);
        }
        return Promise.resolve(out).then(res, rej);
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
        const method = (ev.request.method || "").toUpperCase();
        if (method === "OPTIONS") {                 // 预检：放行但**不算写入**
          await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 204,
            responseHeaders: CORS });
          return;
        }
        let body = null;
        try { body = ev.request.postData || null; } catch (e) {}
        const card = edgeScript.length ? edgeScript.shift() : edgeFallback;
        edgeCalls.push({ method, url: u, body });
        const send = async () => {
          try {
            await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: card.status,
              responseHeaders: CORS.concat([{ name:"Content-Type", value:"application/json" }]),
              body: b64(JSON.stringify(card.body)) });
          } catch (e) {}
        };
        if (edgeHold) { heldEdge.push({ requestId: ev.requestId, url: u, body, card, send }); return; }
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
  let nativeDialogs = [];
  cdp.on("Page.javascriptDialogOpening", async (p) => {
    nativeDialogs.push({ type: (p && p.type) || "", msg: (p && p.message) || "" });
    try { await cdp.send("Page.handleJavaScriptDialog", { accept: true }); } catch (e) {}
  });

  /* ── 真实按键 ─────────────────────────────────────────────────────── */
  const KEYS = { Tab:{code:"Tab",key:"Tab",vk:9}, Enter:{code:"Enter",key:"Enter",vk:13},
                 ArrowLeft:{code:"ArrowLeft",key:"ArrowLeft",vk:37} };
  const press = async (name, shift) => {
    const m = KEYS[name], mods = shift ? 8 : 0;
    await cdp.send("Input.dispatchKeyEvent", { type:"rawKeyDown", modifiers:mods,
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    if (name === "Enter") await cdp.send("Input.dispatchKeyEvent", { type:"char", modifiers:mods,
      text:"\r", key:m.key, code:m.code });
    await cdp.send("Input.dispatchKeyEvent", { type:"keyUp", modifiers:mods,
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    await sleep(80);
  };
  /* keyDown **不能带 text** —— 带了等于连同 char 再输一遍（量具的老毛病）。 */
  const typeText = async (text) => {
    for (const ch of String(text)) {
      const vk = ch.toUpperCase().charCodeAt(0);
      await cdp.send("Input.dispatchKeyEvent", { type:"keyDown", key: ch,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await cdp.send("Input.dispatchKeyEvent", { type:"char", text: ch, key: ch });
      await cdp.send("Input.dispatchKeyEvent", { type:"keyUp", key: ch,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(14);
    }
    await sleep(60);
  };
  const active = async () => cdp.ev(`(()=>{const a=document.activeElement;
    if(!a || a===document.body) return { tag:"BODY" };
    return { tag:a.tagName, id:a.id||"",
             attrs:[...a.attributes].map(x=>x.name).filter(n=>/^data-/.test(n)).join(","),
             text:(a.textContent||"").replace(/\\s+/g," ").trim().slice(0,20) };})()`);
  const until = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) { if (await fn()) return true; await sleep(100); }
    return false;
  };
  const modalUp = async () => cdp.ev(`!!document.querySelector(".portal-modal")`);
  /** 真实 Tab 走到某个 id 的元素上。 */
  const tabToId = async (id, max) => {
    for (let i = 1; i <= (max || 120); i++) {
      await press("Tab");
      if ((await cdp.ev(`(()=>{const a=document.activeElement; return a?(a.id||""):"";})()`)) === id)
        return { hit: true, steps: i };
    }
    return { hit: false, at: await active() };
  };
  /** 真实 Tab 走到「某一张卡上的某个动作按钮」。 */
  const tabToAct = async (reqId, act, max) => {
    for (let i = 1; i <= (max || 140); i++) {
      await press("Tab");
      const v = await cdp.ev(`(()=>{const a=document.activeElement;
        if(!a || !a.dataset || !a.dataset.act) return "";
        const c=a.closest(".rq"); return (c?c.dataset.id:"") + "/" + a.dataset.act;})()`);
      if (v === reqId + "/" + act) return { hit: true, steps: i };
    }
    return { hit: false, at: await active() };
  };
  /** 真实 Tab 走到某个筛选标签并按下。 */
  /* 点了筛选就返回，不等 —— 要的就是「还在 loading」那一段。 */
  const tabToFilterNoWait = async (f, max) => {
    for (let i = 1; i <= (max || 60); i++) {
      await press("Tab");
      const v = await cdp.ev(`(()=>{const a=document.activeElement;
        return a && a.dataset ? (a.dataset.f || "") : "";})()`);
      if (v === f) { await press("Enter"); return { hit: true, steps: i }; }
    }
    return { hit: false, at: await active() };
  };
  const tabToFilter = async (f, max) => {
    for (let i = 1; i <= (max || 60); i++) {
      await press("Tab");
      const v = await cdp.ev(`(()=>{const a=document.activeElement;
        return a && a.dataset ? (a.dataset.f || "") : "";})()`);
      if (v === f) { await press("Enter"); await sleep(1200); return { hit: true, steps: i }; }
    }
    return { hit: false, at: await active() };
  };
  const tabToData_verify = async (reqId, max) => {
    for (let i = 1; i <= (max || 140); i++) {
      await press("Tab");
      const v = await cdp.ev(`(()=>{const a=document.activeElement;
        return a && a.dataset ? (a.dataset.verify || "") : "";})()`);
      if (v === reqId) return { hit: true, steps: i };
    }
    return { hit: false, at: await active() };
  };
  const confirmIt = async () => {
    if (!(await modalUp())) return false;
    const onOk = await cdp.ev(`(()=>{const a=document.activeElement;
      return !!(a && a.hasAttribute && a.hasAttribute("data-ok"));})()`);
    if (!onOk) return false;
    await press("Enter"); await sleep(400);
    return (await modalUp()) === false;
  };
  const taVal = async (reqId) => cdp.ev(`(()=>{const c=document.querySelector('.rq[data-id="${reqId}"]');
    const t=c?c.querySelector("textarea"):null; return t?t.value:null;})()`);
  const cardIds = async () => cdp.ev(`(()=>[...document.querySelectorAll(".rq")].map(c=>c.dataset.id))()`);
  const taDisabled = async (reqId) => cdp.ev(`(()=>{const c=document.querySelector('.rq[data-id="${reqId}"]');
    const t=c?c.querySelector("textarea"):null; return t?!!t.disabled:null;})()`);
  const cardStatus = async (reqId) => cdp.ev(`(()=>{const c=document.querySelector('.rq[data-id="${reqId}"]');
    return c?(c.dataset.status||""):null;})()`);
  /* 焦点落在哪儿：要能分清「哪一张卡的哪一个控件」，还要读得到光标位置。 */
  const focusWhere = async () => cdp.ev(`(()=>{const a=document.activeElement;
    if(!a || a===document.body) return { where:"BODY" };
    const c=a.closest? a.closest(".rq"):null;
    return { where: a.tagName, id: a.id||"", card: c?c.dataset.id:"",
             act: (a.dataset&&a.dataset.act)||"", f:(a.dataset&&a.dataset.f)||"",
             sel: (a.tagName==="TEXTAREA"? a.selectionStart : null) };})()`);
  const lastPostBody = () => { const p = edgeCalls.filter(c => c.method === "POST").slice(-1)[0];
    if (!p || !p.body) return null; try { return JSON.parse(p.body); } catch (e) { return null; } };
  const postCount = () => edgeCalls.filter(c => c.method === "POST").length;

  /* ── 本地合成夹具（admin + aal2，两条待审核申请）───────────────────── */
  const mkScen = () => ({
    uid:"u-admin", aal:"aal2", roles:[{ role:"registrar" }],
    tables: {
      teacher_verification_requests: { data:[
        { id:"tvr-1", user_id:"u-t1", status:"submitted",
          submitted_data:{ name:"教师甲", org:"某神学院", areas:"旧约", country:"马来西亚", phone:"0120000001" },
          submitted_at:"2026-09-10T00:00:00Z", reviewed_at:null,
          applicant_visible_message:null, created_at:"2026-09-01T00:00:00Z" },
        { id:"tvr-2", user_id:"u-t2", status:"submitted",
          submitted_data:{ name:"教师乙", org:"某教会", areas:"新约", country:"新加坡", phone:"0120000002" },
          submitted_at:"2026-09-09T00:00:00Z", reviewed_at:null,
          applicant_visible_message:null, created_at:"2026-09-02T00:00:00Z" } ] },
      user_roles: { data:[{ user_id:"u-admin", role:"registrar" }] },
      profiles: { data:[] },
    },
    rpc: {},
    write: { data:[], error:null },
  });
  /* 服务端真的执行之后，列表重读到的就是新状态 —— 夹具要跟着改，
     否则测的是一个现实里不存在的局面（approve 之后状态会变成 approved，
     卡上的动作换成 暂停/撤销，说明框仍在）。 */
  const markStatus = async (id, st) => cdp.ev(`(()=>{const r=window.__SCEN.tables.teacher_verification_requests.data
    .find(x=>x.id===${JSON.stringify(id)}); if(!r) return false; r.status=${JSON.stringify(st)};
    r.reviewed_at="2026-09-14T00:00:00Z"; return true;})()`);
  const openPage = async () => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(mkScen()) + ";" });
    await cdp.send("Page.navigate", { url: `${BASE}/portal/admin/teachers/` });
    await sleep(3000);
  };

  const REASON = "资料不全，请补交按立时间的授课证明";      // 他写了一段正经答复

  // ════════ Tk 审核说明在列表重绘之后还在不在 ════════
  if (RUN("Tk")) {
    console.log("\n=== Tk 审核说明：别的卡执行完动作之后，我写到一半的那段话还在吗 ===");
    await openPage();
    edgeScript = [ { status:200, body:{ ok:true, status:"approved" } } ];
    ok("Tk0 前提：两条申请都在，卡里有审核说明框",
       JSON.stringify(await cardIds()) === JSON.stringify(["tvr-1","tvr-2"]) &&
       (await taVal("tvr-2")) === "", JSON.stringify(await cardIds()));
    const t2 = await tabToId("m-tvr-2", 140);
    ok("Tk1 前提：真实 Tab 走到第二条的审核说明框", t2.hit === true, JSON.stringify(t2));
    await typeText(REASON);
    ok("Tk2 前提：那段话确实打进去了", (await taVal("tvr-2")) === REASON, JSON.stringify(await taVal("tvr-2")));
    const a1 = await tabToAct("tvr-1", "approve", 140);
    ok("Tk3 前提：真实 Tab 走到**第一条**的「通过」", a1.hit === true, JSON.stringify(a1));
    await press("Enter"); await sleep(500);
    ok("Tk4 前提：确认框开着并按下确认", (await confirmIt()) === true);
    ok("Tk5 前提：第一条的审核确实发出去了（而且带的是第一条的 id）",
       await until(async () => postCount() >= 1, 8000) &&
       (lastPostBody() || {}).request_id === "tvr-1" && (lastPostBody() || {}).action === "approve",
       JSON.stringify(lastPostBody()));
    /* 执行成功之后 900ms 自动刷新（:291）。等到列表真的重绘完再看。 */
    await sleep(2500);
    ok("Tk6 自动刷新之后，第二条里他写的那段说明还在",
       (await taVal("tvr-2")) === REASON, JSON.stringify(await taVal("tvr-2")));
    ok("Tk7 而第一条自己的说明框应当是空的（那段话如果有，也已经发出去了）",
       (await taVal("tvr-1")) === "" || (await taVal("tvr-1")) === null,
       JSON.stringify(await taVal("tvr-1")));
    const focusAfter = await active();
    console.log("      · 自动刷新之后焦点落在：" + JSON.stringify(focusAfter));

    // ── 第二个触发点：切一下筛选
  }
  if (RUN("Tk2")) {
    console.log("\n=== Tk' 同一个缺口的另一个触发点：切一下状态筛选 ===");
    await openPage();
    edgeScript = []; edgeCalls = [];        // 计数清零：Tk13 数的是**这一段**有没有多发请求
    const t2b = await tabToId("m-tvr-2", 140);
    ok("Tk8 前提：又走到第二条的审核说明框", t2b.hit === true, JSON.stringify(t2b));
    await typeText(REASON);
    ok("Tk9 前提：那段话确实打进去了", (await taVal("tvr-2")) === REASON, JSON.stringify(await taVal("tvr-2")));
    const f1 = await tabToFilter("all", 80);
    ok("Tk10 前提：真实按键切到了「全部」", f1.hit === true, JSON.stringify(f1));
    const f2 = await tabToFilter("submitted", 80);
    ok("Tk11 前提：又切回「待审核」", f2.hit === true, JSON.stringify(f2));
    ok("Tk12 切筛选来回一趟，他写的那段说明也还在",
       (await taVal("tvr-2")) === REASON, JSON.stringify(await taVal("tvr-2")));
    ok("Tk13 全程没有多发出任何一笔审核请求（切筛选不是写入）",
       postCount() === 0, "POST " + postCount() + " 笔");

    // ════════ Dr 在途期间他继续改说明：成功回执会不会把新打的也一并清掉 ════════
  }
  if (RUN("Dr")) {
    console.log("\n=== Dr 提交在途、他继续改说明：成功之后新打的那几个字还在吗 ===");
    /* 上一包成功之后无条件 draftMsg.delete(id)。可是在途期间**说明框并没有被禁用**
       （只禁了 [data-act] 按钮，:256-258）—— 他完全可能一边等一边补字。
       那些字**还没有发出去**，却会被那一句 delete 连坐清掉。
       所以：扣住 POST → 记下这一次**实际发出去**的那一版（snapshot）
       → 再输入新内容 → 放行成功 → 等 900ms 自动刷新落地 → 看新内容还在不在。 */
    const OLD = "先给甲的第一稿";
    const ADD = "，另补一句";
    await openPage();
    edgeHold = true; heldEdge = []; edgeCalls = [];
    edgeScript = [ { status:200, body:{ ok:true, status:"approved" } } ];
    const dr0 = await tabToId("m-tvr-1", 140);
    ok("Dr0 前提：真实 Tab 走到第一条的说明框", dr0.hit === true, JSON.stringify(dr0));
    await typeText(OLD);
    ok("Dr1 前提：第一稿打进去了", (await taVal("tvr-1")) === OLD, JSON.stringify(await taVal("tvr-1")));
    const dr2 = await tabToAct("tvr-1", "approve", 140);
    ok("Dr2 前提：走到第一条的「通过」并确认", dr2.hit === true &&
       (await (async () => { await press("Enter"); await sleep(500); return confirmIt(); })()) === true,
       JSON.stringify(dr2));
    ok("Dr3 前提：POST 到达并被扣住，而且带的就是**当时那一版**（snapshot）",
       await until(async () => heldEdge.length === 1, 8000) &&
       (() => { try { return JSON.parse(heldEdge[0].body).message === OLD; } catch (e) { return false; } })(),
       JSON.stringify(heldEdge.map(h => h.body)));
    /* 先查清楚前提，不凭空造问题：在途期间说明框到底禁没禁用？ */
    const taLive = await taDisabled("tvr-1");
    ok("Dr4 前提：在途期间说明框并没有被禁用（所以他真的能继续打字）",
       taLive === false, "textarea.disabled=" + JSON.stringify(taLive));
    const dr5 = await tabToId("m-tvr-1", 140);
    ok("Dr5 前提：走回说明框，接着补几个字", dr5.hit === true, JSON.stringify(dr5));
    await typeText(ADD);
    ok("Dr6 前提：现在框里是「旧稿+补充」", (await taVal("tvr-1")) === OLD + ADD,
       JSON.stringify(await taVal("tvr-1")));
    await markStatus("tvr-1", "approved");
    await heldEdge[0].send();
    heldEdge = [];
    await until(async () => (await cardStatus("tvr-1")) === "approved", 8000);
    await sleep(1200);
    ok("Dr7 前提：自动刷新确实落地了（那一条已经变成已通过）",
       (await cardStatus("tvr-1")) === "approved", JSON.stringify(await cardStatus("tvr-1")));
    ok("Dr8 他在等待期间补的那几个字**还在**（没被成功回执连坐清掉）",
       (await taVal("tvr-1")) === OLD + ADD, JSON.stringify(await taVal("tvr-1")));
    ok("Dr9 而且没有因此多发一笔（补的字只是留着，不会被重新提交）",
       postCount() === 1, "POST " + postCount() + " 笔");
    edgeHold = false; heldEdge = []; edgeScript = [];

    // ════════ Dc 没改过的那一版：发出去之后应当清掉（补上 Tk7 的空过）════════
  }
  if (RUN("Dc")) {
    console.log("\n=== Dc 发出去之后、期间一个字没改：那一版应当清掉 ===");
    /* 上一包的 Tk7 读的是一张**本来就没输入**的卡，证明不了
       「非空的稿子在提交之后被清掉」。这一组补上。 */
    const SENT = "给乙的正式答复";
    await openPage();
    edgeHold = true; heldEdge = []; edgeCalls = [];
    edgeScript = [ { status:200, body:{ ok:true, status:"approved" } } ];
    const dc0 = await tabToId("m-tvr-2", 140);
    ok("Dc0 前提：走到第二条的说明框并写下一段**非空**答复", dc0.hit === true);
    await typeText(SENT);
    ok("Dc1 前提：那段话确实在框里", (await taVal("tvr-2")) === SENT, JSON.stringify(await taVal("tvr-2")));
    const dc2 = await tabToAct("tvr-2", "approve", 140);
    ok("Dc2 前提：走到第二条的「通过」并确认", dc2.hit === true &&
       (await (async () => { await press("Enter"); await sleep(500); return confirmIt(); })()) === true);
    ok("Dc3 前提：POST 带的就是这段话",
       await until(async () => heldEdge.length === 1, 8000) &&
       (() => { try { return JSON.parse(heldEdge[0].body).message === SENT; } catch (e) { return false; } })(),
       JSON.stringify(heldEdge.map(h => h.body)));
    ok("Dc4 前提：这一次他一个字都没再改", (await taVal("tvr-2")) === SENT);
    await markStatus("tvr-2", "approved");
    await heldEdge[0].send();
    heldEdge = [];
    await until(async () => (await cardStatus("tvr-2")) === "approved", 8000);
    await sleep(1200);
    ok("Dc5 自动刷新之后，这段**已经发出去**的答复被清掉了（框里是空的）",
       (await taVal("tvr-2")) === "", JSON.stringify(await taVal("tvr-2")));
    edgeHold = false; heldEdge = []; edgeScript = [];

    // ════════ Fx 自动刷新之后，焦点在哪儿 ════════
  }
  if (RUN("Fx")) {
    console.log("\n=== Fx 自动刷新之后焦点落在哪儿（原地保留 / 不抢别处）===");
    await openPage();
    edgeHold = true; heldEdge = []; edgeCalls = [];
    edgeScript = [ { status:200, body:{ ok:true, status:"approved" } } ];
    const fx0 = await tabToAct("tvr-1", "approve", 140);
    ok("Fx0 前提：走到第一条的「通过」并确认", fx0.hit === true &&
       (await (async () => { await press("Enter"); await sleep(500); return confirmIt(); })()) === true);
    ok("Fx1 前提：POST 被扣住", await until(async () => heldEdge.length === 1, 8000));
    /* 按下去之后那个按钮被禁用（:258）—— 焦点会立刻掉到 <body>。
       键盘用户此刻等于被扔回页面开头。 */
    const fxDuring = await focusWhere();
    ok("Fx2 在途期间焦点不该掉到 <body>（应当还留在那张卡里）",
       fxDuring.where !== "BODY" && fxDuring.card === "tvr-1", JSON.stringify(fxDuring));
    await markStatus("tvr-1", "approved");
    await heldEdge[0].send();
    heldEdge = [];
    await until(async () => (await cardStatus("tvr-1")) === "approved", 8000);
    await sleep(1200);
    const fxAfter = await focusWhere();
    ok("Fx3 自动刷新之后焦点仍在那一条上（而不是 <body>）",
       fxAfter.where !== "BODY" && fxAfter.card === "tvr-1", JSON.stringify(fxAfter));
    edgeHold = false; heldEdge = []; edgeScript = [];

    /* 他在等待期间把焦点移到**别处**：自动刷新不能把焦点抢回来。 */
  }
  if (RUN("Fx2")) {
    console.log("\n=== Fx' 等待期间他去写另一条：自动刷新不该把焦点抢走 ===");
    await openPage();
    edgeHold = true; heldEdge = []; edgeCalls = [];
    edgeScript = [ { status:200, body:{ ok:true, status:"approved" } } ];
    const fy0 = await tabToAct("tvr-1", "approve", 140);
    ok("Fx4 前提：第一条提交并扣住", fy0.hit === true &&
       (await (async () => { await press("Enter"); await sleep(500); return confirmIt(); })()) === true &&
       await until(async () => heldEdge.length === 1, 8000));
    const fy1 = await tabToId("m-tvr-2", 140);
    ok("Fx5 前提：他走到**第二条**的说明框写起来", fy1.hit === true, JSON.stringify(fy1));
    await typeText("给乙的说明");
    await press("ArrowLeft"); await press("ArrowLeft"); await press("ArrowLeft");
    const selBefore = (await focusWhere()).sel;
    /* 「给乙的说明」5 个字，左移 3 次 = 2。上一版这里写了 3，是**我算错**，不是产品的问题。 */
    const WANT_SEL = "给乙的说明".length - 3;
    ok("Fx6 前提：光标被他移到了中间（不是末尾）",
       typeof selBefore === "number" && selBefore === WANT_SEL,
       JSON.stringify({ selBefore, WANT_SEL }));
    await markStatus("tvr-1", "approved");
    await heldEdge[0].send();
    heldEdge = [];
    await until(async () => (await cardStatus("tvr-1")) === "approved", 8000);
    await sleep(1200);
    const fyAfter = await focusWhere();
    ok("Fx7 自动刷新之后焦点仍在第二条的说明框里（没被抢走）",
       fyAfter.where === "TEXTAREA" && fyAfter.card === "tvr-2", JSON.stringify(fyAfter));
    ok("Fx8 而且光标还停在原处", fyAfter.sel === selBefore, JSON.stringify({ selBefore, now: fyAfter.sel }));
    ok("Fx9 他写给第二条的那段话也还在", (await taVal("tvr-2")) === "给乙的说明",
       JSON.stringify(await taVal("tvr-2")));
    edgeHold = false; heldEdge = []; edgeScript = [];

    // ════════ Lv 未知结果被锁进「待核实」：他写的那段话与焦点去哪了 ════════
  }
  if (RUN("Lv")) {
    console.log("\n=== Lv 拿不到明确结论时：说明还在不在、焦点落在哪儿 ===");
    /* 拿不到明确结论（500 / 非 JSON / 空响应）时，lockUnresolved 会把这一条锁住：
       动作按钮**全部移除**、连 .rsn（那个说明框）也一并 remove（:206-208）。
       所以他写的那段话会**从屏幕上消失**。它到底还在不在，
       要按「刷新核实」走一趟才知道 —— 先核实现状，不预设有缺陷。 */
    const UNK = "这一条我写了很长的说明";
    await openPage();
    edgeHold = false; heldEdge = []; edgeCalls = [];
    edgeScript = [ { status:500, body:{} } ];        // 服务端回话了但没给结构化结论 = 未知
    const lv0 = await tabToId("m-tvr-1", 140);
    ok("Lv0 前提：走到第一条的说明框并写下一段话", lv0.hit === true);
    await typeText(UNK);
    ok("Lv1 前提：那段话在框里", (await taVal("tvr-1")) === UNK, JSON.stringify(await taVal("tvr-1")));
    const lv2 = await tabToAct("tvr-1", "approve", 140);
    ok("Lv2 前提：走到「通过」并确认", lv2.hit === true &&
       (await (async () => { await press("Enter"); await sleep(500); return confirmIt(); })()) === true);
    ok("Lv3 前提：这一条被锁进「待核实」（出现了刷新核实、动作按钮没了）",
       await until(async () => cdp.ev(`(()=>{const c=document.querySelector('.rq[data-id="tvr-1"]');
         return !!(c && c.querySelector("[data-verify]") && !c.querySelector("[data-act]"));})()`), 8000),
       JSON.stringify(await cdp.ev(`(()=>{const c=document.querySelector('.rq[data-id="tvr-1"]');
         return c?c.innerHTML.slice(0,120):null;})()`)));
    /* 第九十六包这里记的是「说明框被整块撤掉、那段话从屏幕上消失」。
       第九十八包按监督要求改成**留一份只读的**，所以这条断言跟着改 ——
       是**产品行为变了**，不是把断言删掉躲开。 */
    ok("Lv4 他刚写的那段话没有从屏幕上消失（留了一份只读的）",
       (await taVal("tvr-1")) === UNK, JSON.stringify(await taVal("tvr-1")));
    const lvFocus = await focusWhere();
    ok("Lv5 锁住之后焦点没有掉到 <body>", lvFocus.where !== "BODY", JSON.stringify(lvFocus));
    /* 现在按「刷新核实」：这一条重新读状态，卡片带着动作回来。 */
    edgeScript = [];
    const lv6 = await tabToData_verify("tvr-1", 140);
    ok("Lv6 前提：真实 Tab 走到「刷新核实」并按下", lv6.hit === true, JSON.stringify(lv6));
    await press("Enter"); await sleep(2000);
    ok("Lv7 核实回来之后，这一条重新带上了动作与说明框",
       (await taVal("tvr-1")) !== null, JSON.stringify(await taVal("tvr-1")));
    ok("Lv8 他写的那段话没有丢（草稿撑过了这一趟）",
       (await taVal("tvr-1")) === UNK, JSON.stringify(await taVal("tvr-1")));
    const lvAfter = await focusWhere();
    ok("Lv9 核实回来之后焦点也没有掉到 <body>", lvAfter.where !== "BODY", JSON.stringify(lvAfter));
    ok("Lv10 全程只发出过那一笔（未知结果不会被自动重发）",
       postCount() === 1, "POST " + postCount() + " 笔");

    // ════════ Ns 等待期间他走开了：重绘不能把焦点抢回来 ════════
  }
  if (RUN("Ns")) {
    console.log("\n=== Ns 读列表的那段时间里他去动导航：数据回来会不会把焦点抢回去 ===");
    /* 上一包只在**捕获那一刻**判断「他在不在这片区域里」。可是捕获之后要 await
       列表读取，这段时间他完全可以走开 —— 数据回来时 putHimBack 是**无条件** focus 的。
       所以把列表读取扣住，确定性地造出「正在 loading」那一段，
       让他真实 Tab 走到 main 外面，再放行数据。 */
    const outsideMain = async () => cdp.ev(`(()=>{const a=document.activeElement;
      const m=document.getElementById("main");
      if(!a || a===document.body) return { out:false, where:"BODY" };
      return { out: !!(m && !m.contains(a)), where:a.tagName, id:a.id||"",
               cls:(a.className||"").toString().slice(0,24),
               text:(a.textContent||"").replace(/\\s+/g," ").trim().slice(0,18) };})()`);
    const tabOutOfMain = async (max) => {
      for (let i = 1; i <= (max || 20); i++) {
        await press("Tab");
        const w = await outsideMain();
        if (w.out) return { hit: true, steps: i, at: w };
      }
      return { hit: false, at: await outsideMain() };
    };
    await openPage();
    edgeScript = []; edgeCalls = [];
    ok("Ns0 前提：两条都在", JSON.stringify(await cardIds()) === JSON.stringify(["tvr-1","tvr-2"]));
    await cdp.ev(`(()=>{ window.__holdSelect = true; return true; })()`);
    const ns1 = await tabToFilterNoWait("all", 80);
    ok("Ns1 前提：真实按键点了「全部」筛选", ns1.hit === true, JSON.stringify(ns1));
    ok("Ns2 前提：列表读取确实被扣住了（页面正卡在 loading）",
       await until(async () => cdp.ev(`(()=>!!window.__heldSelect)()`), 6000));
    const ns3 = await tabOutOfMain(20);
    ok("Ns3 前提：他趁这段时间用真实 Tab 走到了 main 外面（导航）", ns3.hit === true,
       JSON.stringify(ns3));
    const beforeRelease = await outsideMain();
    await cdp.ev(`(()=>{ if(window.__releaseSelect) window.__releaseSelect(); return true; })()`);
    await until(async () => (await cardIds()).length === 2, 8000);
    await sleep(600);
    ok("Ns4 前提：数据回来了，列表确实重绘了（不是因为没渲染才没抢）",
       JSON.stringify(await cardIds()) === JSON.stringify(["tvr-1","tvr-2"]),
       JSON.stringify(await cardIds()));
    const afterRelease = await outsideMain();
    ok("Ns5 焦点没有被抢回去 —— 他还站在刚才走到的那个地方",
       afterRelease.out === true && afterRelease.text === beforeRelease.text,
       JSON.stringify({ beforeRelease, afterRelease }));

    // ════════ Sn 两个快照时点：msg 在确认前取、sentRaw 在确认后取 ════════
  }
  if (RUN("Sn")) {
    console.log("\n=== Sn 确认框开着的时候，他还改得到那个说明框吗 ===");
    /* msg（真正发出去的那一版）是在**确认框之前**取的，
       sentRaw（用来判断草稿该不该清）是在**确认之后**取的。
       两个时点不同 —— 只有「确认框开着时他还能改说明框」才会出问题。
       先查这条路**是不是真的走得到**：走不到就不改，不凭空扩大修复。 */
    await openPage();
    edgeHold = true; heldEdge = []; edgeCalls = [];
    edgeScript = [ { status:200, body:{ ok:true, status:"approved" } } ];
    const sn0 = await tabToId("m-tvr-1", 140);
    ok("Sn0 前提：走到第一条的说明框并写下一段话", sn0.hit === true);
    await typeText("原稿");
    const snBefore = await taVal("tvr-1");
    const sn1 = await tabToAct("tvr-1", "approve", 140);
    ok("Sn1 前提：走到「通过」并按下，确认框开着",
       sn1.hit === true &&
       (await (async () => { await press("Enter"); await sleep(500); return modalUp(); })()) === true);
    /* 键盘：Tab 被圈在对话框里（ui.js:87-92），一路按下去也出不去；顺手打几个字。 */
    for (let i = 0; i < 8; i++) await press("Tab");
    await typeText("XYZ");
    ok("Sn2 确认框开着时，键盘改不到那个说明框（Tab 被圈住了）",
       (await taVal("tvr-1")) === snBefore, JSON.stringify({ snBefore, now: await taVal("tvr-1") }));
    /* 鼠标：说明框那个位置上，命中的是遮罩 / 对话框本身，点不到它。 */
    const hit = await cdp.ev(`(()=>{const c=document.querySelector('.rq[data-id="tvr-1"]');
      const t=c?c.querySelector("textarea"):null; if(!t) return { none:true };
      const r=t.getBoundingClientRect();
      const el=document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2));
      return { inModal: !!(el && el.closest && el.closest(".portal-modal")),
               tag: el?el.tagName:"", cls: el?(el.className||"").toString().slice(0,20):"" };})()`);
    ok("Sn3 鼠标也点不到它（那个位置命中的是遮罩/对话框）", hit.inModal === true, JSON.stringify(hit));
    await confirmIt();
    ok("Sn4 前提：这一笔发出去了，带的就是原稿",
       await until(async () => heldEdge.length === 1, 8000) &&
       (() => { try { return JSON.parse(heldEdge[0].body).message === snBefore; } catch (e) { return false; } })(),
       JSON.stringify(heldEdge.map(h => h.body)));
    await markStatus("tvr-1", "approved");
    await heldEdge[0].send();
    heldEdge = [];
    await until(async () => (await cardStatus("tvr-1")) === "approved", 8000);
    await sleep(1000);
    ok("Sn5 两个快照时点之间没有可达的改动路径，所以结果一致：这一版被正常清掉",
       (await taVal("tvr-1")) === "", JSON.stringify(await taVal("tvr-1")));
    edgeHold = false; heldEdge = []; edgeScript = [];
  }
  if (RUN("Rd")) {
    console.log("\n=== Rd 待核实时：刚写的那段话看得见、改不动、也发不出去 ===");
    /* 监督：「待核实状态目前整块撤掉说明框，用户无法查看刚写的草稿……
       保留清楚标注的只读草稿供查看/选择复制，核实后恢复已有编辑草稿逻辑。」
       只留在内存里，不引入任何持久化，也不碰审批状态。 */
    const RDT = "这一条我写了很长的说明，等着复制出去";
    await openPage();
    edgeHold = false; heldEdge = []; edgeCalls = [];
    edgeScript = [ { status:500, body:{} } ];          // 未知结果
    const rd0 = await tabToId("m-tvr-1", 140);
    ok("Rd0 前提：走到第一条的说明框并写下一段**非空**说明", rd0.hit === true);
    await typeText(RDT);
    ok("Rd1 前提：那段话在框里", (await taVal("tvr-1")) === RDT, JSON.stringify(await taVal("tvr-1")));
    const rd2 = await tabToAct("tvr-1", "approve", 140);
    ok("Rd2 前提：走到「通过」并确认", rd2.hit === true &&
       (await (async () => { await press("Enter"); await sleep(500); return confirmIt(); })()) === true);
    ok("Rd3 前提：这一条被锁进「待核实」",
       await until(async () => cdp.ev(`(()=>{const c=document.querySelector('.rq[data-id="tvr-1"]');
         return !!(c && c.querySelector("[data-verify]"));})()`), 8000));
    ok("Rd4 他刚写的那段话**看得见**（还在卡里，内容一字不差）",
       (await taVal("tvr-1")) === RDT, JSON.stringify(await taVal("tvr-1")));
    const roState = await cdp.ev(`(()=>{const c=document.querySelector('.rq[data-id="tvr-1"]');
      const t=c?c.querySelector("textarea"):null; const box=c?c.querySelector(".rsn"):null;
      return { ro: t?!!t.readOnly : null, aria: t?t.getAttribute("aria-readonly"):null,
               marked: box?box.classList.contains("ro"):null,
               label: box?(box.querySelector("label")||{}).textContent||"":null,
               acts: c?c.querySelectorAll("[data-act]").length:null };})()`);
    ok("Rd5 它被明确标注成只读（readOnly + aria-readonly + 标题说清楚）",
       roState.ro === true && roState.aria === "true" && roState.marked === true &&
       /只读/.test(roState.label || ""), JSON.stringify(roState));
    /* 真的改不动：把焦点送进去、真实打字，内容一个字都不能变。 */
    const rd6 = await tabToId("m-tvr-1", 140);
    if (rd6.hit) await typeText("ABC");
    ok("Rd6 真实按键也改不动它（打字进不去）",
       (await taVal("tvr-1")) === RDT, JSON.stringify({ reached: rd6.hit, now: await taVal("tvr-1") }));
    ok("Rd7 这张卡上一个动作按钮都没有 —— 这段话发不出去", roState.acts === 0,
       JSON.stringify(roState.acts));
    /* 重绘也不能把它弄丢：切一趟筛选再回来。 */
    edgeScript = [];
    await tabToFilter("all", 80);
    await tabToFilter("submitted", 80);
    ok("Rd8 切一趟筛选回来，只读草稿还在，而且仍然是只读",
       (await taVal("tvr-1")) === RDT &&
       (await cdp.ev(`(()=>{const c=document.querySelector('.rq[data-id="tvr-1"]');
         const t=c?c.querySelector("textarea"):null; return t?!!t.readOnly:null;})()`)) === true,
       JSON.stringify(await taVal("tvr-1")));
    ok("Rd9 到这里为止只发出过那一笔（未知结果没有被重发）",
       postCount() === 1, "POST " + postCount() + " 笔");
    /* 核实之后：回到原来的可编辑草稿逻辑。 */
    const rd10 = await tabToData_verify("tvr-1", 140);
    ok("Rd10 前提：真实 Tab 走到「刷新核实」并按下", rd10.hit === true, JSON.stringify(rd10));
    await press("Enter"); await sleep(2000);
    ok("Rd11 核实之后原稿回来了，而且恢复成**可编辑**",
       (await taVal("tvr-1")) === RDT &&
       (await cdp.ev(`(()=>{const c=document.querySelector('.rq[data-id="tvr-1"]');
         const t=c?c.querySelector("textarea"):null; return t?!!t.readOnly:null;})()`)) === false,
       JSON.stringify(await taVal("tvr-1")));
    const rd12 = await tabToId("m-tvr-1", 140);
    if (rd12.hit) await typeText("补");
    ok("Rd12 真的能接着改（打得进去）", (await taVal("tvr-1")) === RDT + "补",
       JSON.stringify(await taVal("tvr-1")));
    ok("Rd13 核实这一趟也没有多发任何审核请求", postCount() === 1, "POST " + postCount() + " 笔");
  }
  if (RUN("G")) {
    console.log("\n=== G 外发 ===");
    ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");
    ok("G2 全程没有页面异常", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
    ok("G3 全程没有弹出浏览器原生对话框", nativeDialogs.length === 0, JSON.stringify(nativeDialogs.slice(0, 2)));
  }
  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。");
process.exit(fail ? 1 : 0);
