// faculty/verify/：管理员写给教师的那段**审核说明**，在教师侧显示得对不对。
//
// 契约：applicant_visible_message 在 teacher_verification_requests
// （0004_teacher_verification.sql:46），由管理员经 review_teacher_verification
// 写入（:146），再由 my_teacher_verification 返回给教师本人（:230）——
// 管理员写、教师读的一段**纯文本**。
//
// 这一页把它 `replace(/</g,"&lt;")` 之后塞进 innerHTML（:104）：只处理了 <，
// **& 没有处理**。本探针只验**显示是否与原文一致**（显示失真），
// 不去断言、也不主张这是已证明的脚本执行漏洞。
// 本地合成夹具：无真实账号/凭据/服务，无外网请求。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-fv-"));
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
/* 写入计数按「我**真的按了几次保存**」算，而不是写死一个数字 ——
   挑着跑分组时那个数字必然对不上（上一版就是）。 */
let savesPressed = 0;
/* 分组开关：ONLY=S,U,R,F,G 就只跑这几组。
   监督的口径是「不要整跑既有 66」——但被这次改动**真正影响到**的那几组必须跑，
   所以要能挑着跑，而不是靠「这次先不跑」蒙混。不设 ONLY 时全跑。 */
const ONLY = String(process.env.ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
const RUN = (g) => !ONLY.length || ONLY.indexOf(g) > -1;
/* 这支探针只有一组，不需要组隔离（那是 student-todo-loop 特有的）。 */
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
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });
  let pageErrors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    pageErrors.push(String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || "").slice(0, 200));
  });

  /* 管理员写的那段说明：含**字面量** &lt; 与 &amp;，以及中文换行。 */
  const MSG = "已收到&lt;资料&gt;，&amp; 请补充：\n1. 按立证明\n2. 推荐信";
  const scen = {
    uid:"u-teacher", aal:"aal1", roles:[{ role:"teacher" }],
    tables: {},
    rpc: {
      my_teacher_verification: { data:[{ status:"needs_information",
        submitted_at:"2026-09-01T00:00:00Z", reviewed_at:"2026-09-05T00:00:00Z",
        applicant_visible_message: MSG }] },
    },
    write: { data:[], error:null },
  };
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__SCEN = " + JSON.stringify(scen) + "; window.__q=[]; window.__rpc=[];" });
  await cdp.send("Page.navigate", { url: `${BASE}/faculty/verify/` });
  await sleep(3000);

  console.log("\n=== Fv 教师侧的审核说明：显示得和管理员写的一样吗 ===");
  /* 读 innerText 而不是只读 textContent：后者连隐藏内容也算进去，
     「文本在 DOM 里」不等于「他看得见」。可见性另外单独断言。 */
  const box = await cdp.ev(`(()=>{const b=[...document.querySelectorAll(".status-line")]
    .find(x=>/审核说明/.test(x.textContent||"")); if(!b) return null;
    const v=b.querySelector("b");
    return v ? { text:v.textContent, shown:v.innerText, kids:v.children.length,
                 ws:getComputedStyle(v).whiteSpace,
                 visible: !!(v.offsetWidth || v.offsetHeight || v.getClientRects().length) } : null;})()`);
  ok("Fv0 前提：教师侧确实显示了这段审核说明", !!box, JSON.stringify(box));
  ok("Fv1 显示的内容与管理员写的**一字不差**（&lt; / &amp; 都还是字面量）",
     !!box && box.text === MSG, JSON.stringify(box && box.text));
  ok("Fv2 这段说明**没有**被解析成任何元素（只是文本）",
     !!box && box.kids === 0, JSON.stringify(box && box.kids));
  ok("Fv3 中文换行**看得见**（innerText 里确实有换行，且这一块是可见的）",
     !!box && box.visible === true && (box.shown || "").indexOf("\n") > -1 &&
     (box.shown || "").indexOf("1. 按立证明") > -1, JSON.stringify(box && { shown: box.shown, visible: box.visible }));

  // ════════ Ad 管理员侧：同一段说明，他自己读到的也该是分项的 ════════
  console.log("\n=== Ad 管理员侧的「已告知对方」：同一段说明，换行看不看得见 ===");
  const ADMIN = {
    uid:"u-admin", aal:"aal2", roles:[{ role:"registrar" }],
    tables: {
      teacher_verification_requests: { data:[{ id:"tvr-1", user_id:"u-t1", status:"needs_information",
        submitted_data:{ name:"教师甲", org:"某神学院", areas:"旧约", country:"马来西亚", phone:"0120000001" },
        submitted_at:"2026-09-10T00:00:00Z", reviewed_at:"2026-09-11T00:00:00Z",
        applicant_visible_message: MSG, created_at:"2026-09-01T00:00:00Z" }] },
      user_roles: { data:[{ user_id:"u-admin", role:"registrar" }] },
      profiles: { data:[] },
    },
    rpc: {},
    write: { data:[], error:null },
  };
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__SCEN = " + JSON.stringify(ADMIN) + "; window.__q=[]; window.__rpc=[];" });
  await cdp.send("Page.navigate", { url: `${BASE}/portal/admin/teachers/` });
  await sleep(3200);
  const adBox = await cdp.ev(`(()=>{const kv=[...document.querySelectorAll(".kv")]
    .find(x=>/已告知对方/.test(x.textContent||"")); if(!kv) return null;
    const v=kv.querySelector("b");
    return v ? { text:v.textContent, shown:v.innerText, kids:v.children.length,
                 visible: !!(v.offsetWidth || v.offsetHeight || v.getClientRects().length) } : null;})()`);
  ok("Ad0 前提：管理员侧确实显示了同一段说明", !!adBox, JSON.stringify(adBox));
  ok("Ad1 内容与管理员写的一字不差（UI.esc 保留，&lt; / &amp; 仍是字面量）",
     !!adBox && adBox.text === MSG, JSON.stringify(adBox && adBox.text));
  ok("Ad2 换行**看得见**（innerText 里有换行，且这一块可见）",
     !!adBox && adBox.visible === true && (adBox.shown || "").indexOf("\n") > -1 &&
     (adBox.shown || "").indexOf("2. 推荐信") > -1,
     JSON.stringify(adBox && { shown: adBox.shown, visible: adBox.visible }));
  ok("Ad3 这一段只是看，没有产生任何审核写入",
     (await cdp.ev(`(()=>((window.__rpc||[]).filter(r=>/review_teacher|submit-teacher/.test(r.name)).length))()`)) === 0 &&
     (await cdp.ev(`(()=>((window.__q||[]).filter(q=>q.mode!=="select").length))()`)) === 0,
     JSON.stringify(await cdp.ev(`(()=>((window.__rpc||[]).map(r=>r.name)))()`)));

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
console.log("  只验显示是否与原文一致；**不**主张这是已证明的脚本执行漏洞。");
process.exit(fail ? 1 : 0);
