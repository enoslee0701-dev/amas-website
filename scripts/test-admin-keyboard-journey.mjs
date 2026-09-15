// 管理端「队列 → 详情 → 回到原来的队列」的键盘衔接。
//
// **先核实真实结构**：这里的详情**不是另一页** —— 是同一页上的侧栏
// `<aside class="detail" id="detail" tabindex="-1">`（admissions/index.html:116），
// 由表格里的「查看」按钮（`[data-open]`，:332）打开、`#dClose` 那个 × 关闭（:427）。
// 所以这一段验的是**同页上下文切换**，不是跨页导航 —— 报告里也这么写。
//
// 两条量具通则（监督定的，本包起生效）：
//   ① 写入判定**不靠前缀猜**：只读 RPC 要显式白名单，其余一律记为「未分类」，
//      只要出现未分类，「零写入」这个结论就不成立；
//   ② 宿主 beacon 累计是**异步投递**，「每页收到一条」不等于「每条都收到」——
//      每条带 visit + 递增 seq，终局按 seq 连续性对齐，有缺口就判红。
//
// 全程真实 Tab / Enter / 打字。本地合成 admin + aal2 夹具：无真实账号/凭据/服务。
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
/* 跨页累计器。window.__q 每次导航都会被重置 —— 拿它说「全程零写入」
   只能代表最后那一页（监督点名）。所以让页内的每一次查询/RPC 都打一条
   到**测试宿主**这边来，导航冲不掉。仍然是本地合成，不接任何真实服务。 */
const probeLog = [];
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (refuseLocalConfig(p, res)) return;   // 不伺服本机真实配置（INCIDENT-0916）
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-adminj-"));
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

/* ── 量具通则 ①：只读 RPC 显式白名单 ────────────────────────────────
   不靠 update_/insert_ 这种前缀猜。凡是不在白名单里的 RPC 一律「未分类」，
   只要出现未分类，「这一段没有写入」这个结论就**不成立**。
   白名单里的每一个都逐个核对过：它们在迁移里都是 stable / 只 select。 */
const READONLY_RPC = new Set([
  "my_roles",          // 0006_roles.sql：只读当前用户角色
  "my_profile",        // 0005_profiles.sql：只读自己的档案
]);
const classify = () => {
  const writes = probeLog.filter(r => r.kind === "table" && r.mode !== "select");
  const rpcs = probeLog.filter(r => r.kind === "rpc");
  const unclassified = rpcs.filter(r => !READONLY_RPC.has(r.name));
  return { writes, unclassified, rpcNames: [...new Set(rpcs.map(r => r.name))] };
};

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
    await sleep(200);
  };
  const where = async () => cdp.ev(`(()=>{const a=document.activeElement;
    if(!a || a===document.body) return { tag:"BODY" };
    return { tag:a.tagName, id:a.id||"", cls:(a.className||"").toString().slice(0,18),
             open:(a.dataset&&a.dataset.open)||"",
             inDetail: !!(a.closest && a.closest("#detail")),
             text:(a.textContent||"").replace(/\s+/g," ").trim().slice(0,16) };})()`);
  const until = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 8000)) { try { if (await fn()) return true; } catch (e) {} await sleep(120); }
    return false;
  };
  const tabTo = async (pred, max) => {
    for (let i = 1; i <= (max || 60); i++) {
      await press("Tab");
      const w = await where();
      if (pred(w)) return { hit: true, steps: i, at: w };
    }
    return { hit: false, at: await where() };
  };
  const detailOpen = async () => cdp.ev(`(()=>{const d=document.getElementById("detail");
    return !!(d && d.classList.contains("open"));})()`);
  const detailText = async () => cdp.ev(`(()=>{const d=document.getElementById("detail");
    return d ? (d.textContent||"").replace(/\s+/g," ").trim() : "";})()`);
  const rowsShown = async () => cdp.ev(`(()=>[...document.querySelectorAll("[data-open]")].map(b=>b.dataset.open))()`);
  const searchVal = async () => cdp.ev(`(()=>{const e=document.getElementById("fQ"); return e?e.value:null;})()`);

  const U1 = "甲UNIQ7391", U2 = "乙UNIQ2211", U3 = "丙UNIQ8842";
  const mkApp = (id, nm, ch) => ({ id, applicant_id:"u-"+id, pathway:"degree", status:"submitted",
    form_data:{ name_zh:nm, church_name:ch, programs:["bth"] }, locked_fields:[],
    applicant_visible_message:null, submitted_at:"2026-09-01T00:00:00Z", decided_at:null,
    created_at:"2026-08-20T00:00:00Z", updated_at:"2026-09-01T00:00:00Z", assigned_reviewer:null });
  const SCEN = {
    uid:"u-admin", aal:"aal2", roles:[{ role:"registrar" }],
    tables: {
      program_catalog: { data:[{ code:"bth", name_zh:"神学本科", short_label:"B.Th" }] },
      user_roles: { data:[{ user_id:"u-admin", role:"registrar" }] },
      profiles: { data:[{ id:"u-admin", display_name:"测试管理员", email:"a@example.invalid" }] },
      applications: { data:[ mkApp("app-1", U1, "教会甲"), mkApp("app-2", U2, "教会乙"),
                             mkApp("app-3", U3, "教会丙") ] },
      application_internal: { data:{ notes:"", updated_at:null } },
      application_requirements: { data: [] },
      application_status_history: { data: [] },
    },
    rpc: {},
    write: { data:[], error:null },
  };
  const openAdmin = async () => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__SCEN = " + JSON.stringify(SCEN) + "; window.__q=[]; window.__rpc=[];" });
    await cdp.send("Page.navigate", { url: `${BASE}/portal/admin/admissions/` });
    await sleep(3000);
  };

  // ════════ Qd 队列 → 详情 → 回到原来的队列（同页侧栏）════════
  if (RUN("Qd")) {
    console.log("\n=== Qd 队列 → 详情 → 回到原来的队列（详情是同页侧栏，不是另一页）===");
    await openAdmin();
    ok("Qd0 前提：队列出来了，三份申请都在",
       JSON.stringify(await rowsShown()) === JSON.stringify(["app-1","app-2","app-3"]),
       JSON.stringify(await rowsShown()));
    /* 先用键盘把队列筛到只剩目标那一份 —— 这就是「原来的队列上下文」。
       筛选里的 <select> 在 headless 里驱动不了（一贯记为 INCOMPLETE），
       所以这里用**搜索框**：它是文本输入，键盘真打得进去。 */
    const sq = await tabTo((w) => w.id === "fQ", 30);
    ok("Qd1 前提：Tab 走得到搜索框", sq.hit === true, JSON.stringify(sq.at));
    await typeText(U2);
    const filtered = await rowsShown();
    ok("Qd2 前提：键盘打字真的把队列筛成了一份（上下文建立）",
       JSON.stringify(filtered) === JSON.stringify(["app-2"]), JSON.stringify(filtered));
    const before = probeLog.length;
    const vw = await tabTo((w) => w.open === "app-2", 30);
    ok("Qd3 Tab 走得到那一行的「查看」", vw.hit === true, JSON.stringify(vw.at));
    await press("Enter");
    ok("Qd4 Enter 打开了详情侧栏", await until(async () => detailOpen(), 8000));
    ok("Qd5 打开的确实是**同一份**（详情里是它的唯一标识）",
       (await detailText()).indexOf(U2) > -1 &&
       (await detailText()).indexOf(U1) < 0 && (await detailText()).indexOf(U3) < 0,
       JSON.stringify((await detailText()).slice(0, 60)));
    const corr = probeLog.slice(before).filter(r => r.kind === "table" && r.eq && r.eq.application_id === "app-2");
    ok("Qd6 请求关联：这一次打开发出的读取带的就是它的 id",
       corr.length >= 1, JSON.stringify(probeLog.slice(before).filter(r => r.kind === "table")
         .map(r => ({ n:r.name, eq:r.eq }))));
    const afterOpen = await where();
    ok("Qd7 打开之后焦点进了详情面板（否则他不知道这一下开出了什么）",
       afterOpen.inDetail === true, JSON.stringify(afterOpen));
    const cl = await tabTo((w) => w.id === "dClose", 40);
    ok("Qd8 Tab 走得到详情里的关闭按钮", cl.hit === true, JSON.stringify(cl.at));
    await press("Enter");
    ok("Qd9 Enter 真的把详情收起来了", (await detailOpen()) === false);
    const afterClose = await where();
    ok("Qd10 关掉之后焦点没有掉到 <body>（应当回到他刚才按的那个「查看」）",
       afterClose.tag !== "BODY", JSON.stringify(afterClose));
    ok("Qd11 回到队列之后，**筛选上下文还在**（搜索框里的字还在）",
       (await searchVal()) === U2, JSON.stringify(await searchVal()));
    ok("Qd12 列表也还是筛过的那一份（没有被重置回三份）",
       JSON.stringify(await rowsShown()) === JSON.stringify(["app-2"]),
       JSON.stringify(await rowsShown()));

    // ── 量具两条通则的自检
  }
  if (RUN("Rr")) {
    console.log("\n=== Rr 详情开着时队列重绘：原来那一行没了，关掉之后焦点去哪 ===");
    /* 上一包的兜底是「找不到那一行就不 focus」，报告还写了一句
       「至少不把他扔回页首」—— **那句话没有依据**：× 就在被收起的面板里，
       不 focus 的结果仍然是掉到 <body>（监督点名）。
       这里先按**真实可达的控件路径**复现：详情开着时他还能不能碰到搜索框。
       不强行改 DOM 造缺陷 —— 走不到就如实记「找不到可达触发」。 */
    await openAdmin();
    const v2 = await tabTo((w) => w.open === "app-2", 40);
    ok("Rr0 前提：Tab 走得到 app-2 那一行的「查看」", v2.hit === true, JSON.stringify(v2.at));
    await press("Enter");
    ok("Rr1 前提：详情开着", await until(async () => detailOpen(), 8000));
    let reach = await tabTo((w) => w.id === "fQ", 45);
    if (!reach.hit) {
      for (let i = 1; i <= 45 && !reach.hit; i++) {
        await press("Tab", true);
        const w = await where();
        if (w.id === "fQ") reach = { hit: true, steps: -i, at: w };
      }
    }
    ok("Rr2 前提：详情开着时，键盘**确实走得到**搜索框（走不到就没有这个触发）",
       reach.hit === true, JSON.stringify(reach));
    if (reach.hit) {
      await typeText(U1);
      const left = await rowsShown();
      ok("Rr3 前提：队列重绘了，原来那一行已经不在列表里",
         left.indexOf("app-2") < 0 && left.length >= 1, JSON.stringify(left));
      ok("Rr4 前提：详情**还开着**（筛选没有顺手把它关掉）", (await detailOpen()) === true);
      const cl2 = await tabTo((w) => w.id === "dClose", 45);
      ok("Rr5 前提：Tab 走得回详情里的关闭按钮", cl2.hit === true, JSON.stringify(cl2.at));
      await press("Enter");
      ok("Rr6 前提：详情收起来了", (await detailOpen()) === false);
      const land = await where();
      ok("Rr7 关掉之后焦点**没有掉到 <body>**，而且落在看得见的队列锚点上",
         land.tag !== "BODY" && land.inDetail === false, JSON.stringify(land));
      ok("Rr8 筛选上下文仍在（搜索框里的字没被清掉）", (await searchVal()) === U1,
         JSON.stringify(await searchVal()));
      ok("Rr9 列表也还是筛过的样子（没被重置回三份）",
         (await rowsShown()).indexOf("app-2") < 0, JSON.stringify(await rowsShown()));
    }

    await openAdmin();
    const v3 = await tabTo((w) => w.open === "app-3", 40);
    ok("Rr10 前提：Tab 走得到 app-3 那一行的「查看」", v3.hit === true, JSON.stringify(v3.at));
    await press("Enter");
    await until(async () => detailOpen(), 8000);
    await cdp.ev(`(()=>{const b=document.querySelector('[data-open="app-3"]');
      if(b) b.dataset.probeMark="old"; return !!b;})()`);
    const reach2 = await tabTo((w) => w.id === "fQ", 45);
    ok("Rr11 前提：又走到搜索框", reach2.hit === true, JSON.stringify(reach2.at));
    await typeText(U3);
    ok("Rr12 前提：重绘之后那一行**仍然可见**",
       JSON.stringify(await rowsShown()) === JSON.stringify(["app-3"]),
       JSON.stringify(await rowsShown()));
    const oldGone = await cdp.ev(`(()=>{const b=document.querySelector('[data-open="app-3"]');
      return { markedStill: !!(b && b.dataset && b.dataset.probeMark),
               count: document.querySelectorAll('[data-open="app-3"]').length };})()`);
    ok("Rr13 现在页面上的是**新**节点（旧的那个已经不在文档里了）",
       oldGone.markedStill === false && oldGone.count === 1, JSON.stringify(oldGone));
    const cl3 = await tabTo((w) => w.id === "dClose", 45);
    if (cl3.hit) await press("Enter");
    const land2 = await cdp.ev(`(()=>{const a=document.activeElement;
      if(!a || a===document.body) return { tag:"BODY" };
      return { tag:a.tagName, open:(a.dataset&&a.dataset.open)||"",
               marked: !!(a.dataset && a.dataset.probeMark) };})()`);
    ok("Rr14 关掉之后焦点回到**那一行的新节点**（不是旧的、也不是 body）",
       land2.open === "app-3" && land2.marked === false, JSON.stringify(land2));
  }

  if (RUN("Pg")) {
    console.log("\n=== Pg 队列分页：「载入更早的」这一路（普通按钮，不是原生 select）===");
    /* 上一包把「加载更多换页」和原生 <select> 一并说成 headless 驱动不了 ——
       **说错了，而且当时并没有失败证据**。核过控件：#btnMore 是普通 <button>
       （admissions/index.html:277），键盘完全驱动得了。
       夹具这一次**真正按 range 切片**（PAGE=300）：
       第 1 页 300 份、第 2 页 300 份、第 3 页 2 份，
       否则「翻页没问题」只是因为夹具根本没分页。 */
    const P1 = "第一页那位-P1UNIQ", P2 = "第二页那位-P2UNIQ", P3 = "第三页那位-P3UNIQ";
    const many = [];
    for (let i = 0; i < 602; i++) {
      const nm = i === 0 ? P1 : (i === 300 ? P2 : (i === 600 ? P3 : "申请人" + i));
      many.push(mkApp("ap" + String(i).padStart(4, "0"), nm, "教会" + i));
    }
    const SCEN_MANY = JSON.parse(JSON.stringify(SCEN));
    SCEN_MANY.tables.applications = { data: many };
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__SCEN = " + JSON.stringify(SCEN_MANY) + "; window.__q=[]; window.__rpc=[];" });
    await cdp.send("Page.navigate", { url: `${BASE}/portal/admin/admissions/` });
    await sleep(3500);

    const btn = await cdp.ev(`(()=>{const b=document.getElementById("btnMore");
      return b ? { tag:b.tagName, type:b.type||"", disabled:!!b.disabled,
                   text:(b.textContent||"").trim() } : null;})()`);
    ok("Pg0 先核控件：「载入更早的」是**普通 button**，不是原生 <select>，而且没被禁用",
       !!btn && btn.tag === "BUTTON" && btn.disabled === false, JSON.stringify(btn));
    const first = await rowsShown();
    ok("Pg1 首屏只读到第一页 300 份", first.length === 300, "行数 " + first.length);
    const q1 = probeLog.filter(r => r.kind === "table" && r.name === "applications");
    ok("Pg1b 第一次请求的 range 是 0..299",
       q1.length >= 1 && q1[q1.length - 1].range && q1[q1.length - 1].range.from === 0,
       JSON.stringify(q1.map(r => r.range)));

    const mb = await tabTo((w) => w.id === "btnMore", 30);
    ok("Pg2 真实 Tab 走得到它", mb.hit === true, JSON.stringify(mb.at));
    await press("Enter");
    ok("Pg3 Enter 之后第二页加载进来了（600 份）",
       await until(async () => (await rowsShown()).length === 600, 12000),
       "行数 " + (await rowsShown()).length);
    const ids = await rowsShown();
    ok("Pg4 前一页的记录**还在**（第一页那一份仍然在列表里）",
       ids.indexOf("ap0000") > -1, JSON.stringify(ids.slice(0, 2)));
    ok("Pg5 新页确实出现了（第二页那一份在列表里）", ids.indexOf("ap0300") > -1);
    ok("Pg6 没有重复（600 个 id 互不相同）", new Set(ids).size === ids.length,
       "unique " + new Set(ids).size + " / " + ids.length);
    const q2 = probeLog.filter(r => r.kind === "table" && r.name === "applications");
    ok("Pg7 第二次请求的 range 是 300..599（真的按偏移取下一页）",
       q2.length >= 2 && q2[q2.length - 1].range && q2[q2.length - 1].range.from === 300,
       JSON.stringify(q2.map(r => r.range)));

    /* 用搜索框缩到第二页那一份 —— 既是真实用法，也避免 Tab 过 600 行。
       注意方向：#fQ 在「载入更早的」**之前**，所以要 Shift+Tab 往回走。
       上一次跑我一路正向 Tab，走进了 600 行里再也回不来 ——
       那是**量具方向错了**，不是产品够不到。 */
    const backTo = async (pred, max) => {
      for (let i = 1; i <= (max || 40); i++) {
        await press("Tab", true);
        const w = await where();
        if (pred(w)) return { hit: true, steps: -i, at: w };
      }
      return { hit: false, at: await where() };
    };
    const sb = await backTo((w) => w.id === "fQ", 40);
    ok("Pg8 前提：Shift+Tab 往回走得到搜索框", sb.hit === true, JSON.stringify(sb.at));
    await typeText("P2UNIQ");
    ok("Pg9 前提：筛到只剩第二页那一份",
       JSON.stringify(await rowsShown()) === JSON.stringify(["ap0300"]),
       JSON.stringify(await rowsShown()));
    const beforeOpen = probeLog.length;
    const vw2 = await tabTo((w) => w.open === "ap0300", 30);
    ok("Pg10 前提：Tab 走得到它那一行的「查看」", vw2.hit === true, JSON.stringify(vw2.at));
    await press("Enter");
    ok("Pg11 打开的详情正是**第二页那一份**（唯一标识在详情里）",
       await until(async () => (await detailText()).indexOf("P2UNIQ") > -1, 9000),
       JSON.stringify((await detailText()).slice(0, 50)));
    const corr2 = probeLog.slice(beforeOpen).filter(r => r.kind === "table" && r.eq && r.eq.application_id === "ap0300");
    ok("Pg12 请求关联：这一次打开发出的读取带的就是它的 id", corr2.length >= 1,
       JSON.stringify(probeLog.slice(beforeOpen).filter(r => r.kind === "table").map(r => r.eq)));
    const cl = await tabTo((w) => w.id === "dClose", 45);
    if (cl.hit) await press("Enter");
    const land = await where();
    ok("Pg13 关掉之后回到原来的上下文：焦点落在那一行的「查看」上",
       land.open === "ap0300", JSON.stringify(land));
    ok("Pg14 搜索框里的字也还在", (await searchVal()) === "P2UNIQ", JSON.stringify(await searchVal()));

    /* 失败路径：下一页读失败，已有列表必须保留，而且要能重试。 */
    await cdp.ev(`(()=>{ window.__failFrom = 600; window.__failedOnce = false;
      const e=document.getElementById("fQ"); if(e){ e.value=""; e.dispatchEvent(new Event("input",{bubbles:true})); }
      return true; })()`);
    ok("Pg15 前提：清掉搜索，600 份都回来了",
       await until(async () => (await rowsShown()).length === 600, 8000),
       "行数 " + (await rowsShown()).length);
    const mb2 = await tabTo((w) => w.id === "btnMore", 30);
    ok("Pg16 前提：又走到「载入更早的」", mb2.hit === true, JSON.stringify(mb2.at));
    await press("Enter");
    await sleep(1500);
    ok("Pg17 这一页读失败了，**已经读到的 600 份照常还在**",
       (await rowsShown()).length === 600, "行数 " + (await rowsShown()).length);
    const note = await cdp.ev(`(()=>{const m=document.getElementById("main");
      return m ? (m.textContent||"").replace(/\s+/g," ") : "";})()`);
    ok("Pg18 而且说得出「这一次没读到」，不是装作已经到底了",
       /没能读到|没取到|没读到/.test(note) && !/已经是全部|已到底/.test(note),
       JSON.stringify(note.slice(0, 100)));
    const mb3 = await tabTo((w) => w.id === "btnMore", 30);
    ok("Pg19 失败之后那个按钮还在，能再按一次", mb3.hit === true, JSON.stringify(mb3.at));
    await press("Enter");
    ok("Pg20 重试成功：第三页进来了（602 份），而且仍然没有重复",
       await until(async () => (await rowsShown()).length === 602, 12000) &&
       new Set(await rowsShown()).size === 602,
       "行数 " + (await rowsShown()).length);
    const q3 = probeLog.filter(r => r.kind === "table" && r.name === "applications" && r.range);
    ok("Pg21 重试要的是**同一个 range**（600 起），失败没有把偏移推进",
       q3.filter(r => r.range.from === 600).length === 2,
       JSON.stringify(q3.map(r => r.range.from)));
  }

  if (RUN("A")) {
    console.log("\n=== A 记账口径自检（写入分类 + 终局对齐）===");
    await sleep(700);                                  // 给异步投递一点时间
    const cls = classify();
    ok("A0 这一段没有任何表写入", cls.writes.length === 0, JSON.stringify(cls.writes));
    ok("A1 出现过的 RPC **全部**在已审查的只读白名单里（有未分类就不算零写入）",
       cls.unclassified.length === 0,
       JSON.stringify({ 出现过: cls.rpcNames, 未分类: cls.unclassified.map(r => r.name) }));
    ok("A2 也没有走任何 Edge Function", edgeCalls.length === 0, JSON.stringify(edgeCalls));
    /* 终局对齐：每个 visit 的 seq 必须 1..N 连续；当前这一页的宿主计数
       还要和页内自己数的对得上。有缺口就说明 beacon 丢了，
       那「零写入」只是「没看见」，不能当成「没有」。 */
    const byVisit = {};
    probeLog.forEach((r) => { (byVisit[r.visit] = byVisit[r.visit] || []).push(r.seq); });
    const gaps = Object.entries(byVisit).filter(([, seqs]) => {
      const a = [...seqs].sort((x, y) => x - y);
      return a[0] !== 1 || a.some((x, i) => x !== i + 1);
    });
    ok("A3 终局对齐：每一次页面载入的记录 seq 都是 1..N 连续，没有缺口",
       gaps.length === 0, JSON.stringify(gaps.slice(0, 2)));
    const live = await cdp.ev(`(()=>({ visit: window.__VISIT, sent: window.__sent }))()`);
    ok("A4 当前这一页：宿主收到的条数与页内自己数的一致（不是「收到一条就算数」）",
       !!live && Array.isArray(byVisit[live.visit]) && byVisit[live.visit].length === live.sent,
       JSON.stringify({ live, got: (byVisit[(live||{}).visit] || []).length }));
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

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。");
console.log("  详情是**同页侧栏**，不是另一页；筛选里的 <select> 在 headless 中驱动不了，本探针用搜索框建立上下文。");
process.exit(fail ? 1 : 0);
