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
  const scenSrc = (phone) => "window.__SCEN = " + JSON.stringify({
    uid:"u-stu", aal:"aal1", roles:[{ role:"student" }],
    tables: { program_catalog: { data:[{ code:"bth", name_zh:"神学本科", short_label:"B.Th" }] } },
    rpc: {
      /* 页面取的是 recRows[0]（student/index.html:73）—— 这里必须是**数组**。
         上一次跑我给成了对象，首页直接走「尚未查到学籍记录」那一支，
         St0/St13 的红全是这个原因，不是产品的问题。 */
      my_student_record: { data:[{ id:"stu-1", student_number:"B26-0007", status:"active",
        program_code:"bth", created_at:"2026-09-01T00:00:00Z", activated_at:"2026-09-05T00:00:00Z" }] },
      my_student_timeline: { data: [] },
      my_action_items: { data: phone ? [] : [TODO] },
      my_student_capabilities: { data:{} },
      /* my_learning 也是行集合：页面数的是 learn.length 与 availability。 */
      my_learning: { data: Array.from({ length: 67 }, (_, i) => ({
        code:"C" + i, availability: i < 12 ? "available" : "planned" })) },
      my_student_profile: { data:{ self_editable:{ display_name:"学生甲", phone: phone || null, contact_note:"" },
        registrar_managed:{ email:"s@example.invalid", student_number:"B26-0007", status:"active",
          program_code:"bth", pathway:"degree", created_at:"2026-09-01T00:00:00Z",
          activated_at:"2026-09-05T00:00:00Z" }, has_student_record:true } },
      update_my_contact: { data:{ ok:true } },
    },
    write: { data:[], error:null },
  }) + "; window.__q=[]; window.__rpc=[];";
  const goStudentHome = async (phone) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: scenSrc(phone) });
    await cdp.send("Page.navigate", { url: `${BASE}/portal/student/` });
    await sleep(2800);
  };

  // ════════ St 待办 → 去处理 → 完成 → 出口 ════════
  console.log("\n=== St 待办「完善联系方式」：点进去之后能不能真的完成、完成了知不知道 ===");
  await goStudentHome(null);
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
  const jump = await cdp.ev(`(()=>!!document.querySelector("[data-gophone]"))()`);
  ok("St4 而且给得出一步到那一格的入口（键盘用户不必自己在表单里找）",
     jump === true, JSON.stringify(jump));
  ok("St5 前提：电话这一格现在确实是空的", (await phoneVal()) === "", JSON.stringify(await phoneVal()));

  /* 真实键盘：走到那一格、打进去、保存。 */
  const ph = await tabTo((w) => w.id === "ph", 40);
  ok("St6 Tab 走得到电话那一格", ph.hit === true, JSON.stringify(ph.at));
  await typeText("0123456789");
  ok("St7 打进去了", (await phoneVal()) === "0123456789", JSON.stringify(await phoneVal()));
  const sv = await tabTo((w) => w.id === "save", 20);
  ok("St8 Tab 走得到「保存」", sv.hit === true, JSON.stringify(sv.at));
  await press("Enter");
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

  /* 回到学员中心：待办应当已经不在了（这一条的完成标准就是 phone 不为空）。 */
  await goStudentHome("0123456789");
  ok("St13 回到学员中心，这一条待办已经不在了",
     (await mainText()).indexOf("完善联系方式") < 0 &&
     (await mainText()).indexOf("目前没有需要你处理的事项") > -1,
     JSON.stringify((await mainText()).slice(0, 120)));

  console.log("\n=== A 记账口径自检 ===");
  await sleep(600);
  const rpcs = probeLog.filter(r => r.kind === "rpc");
  const unclassified = rpcs.filter(r => !READONLY_RPC.has(r.name) && !WRITE_RPC.has(r.name));
  ok("A1 出现过的 RPC 都能分类（只读白名单 + 本包**有意**发出的那一笔写入）",
     unclassified.length === 0,
     JSON.stringify({ 出现过: [...new Set(rpcs.map(r => r.name))], 未分类: unclassified.map(r => r.name) }));
  ok("A2 写入只有 update_my_contact 这一笔（学生自己按的那次保存）",
     rpcs.filter(r => WRITE_RPC.has(r.name)).length === 1,
     JSON.stringify(rpcs.filter(r => WRITE_RPC.has(r.name)).map(r => r.name)));
  ok("A3 没有走任何 Edge Function", edgeCalls.length === 0, JSON.stringify(edgeCalls));
  const byVisit = {};
  probeLog.forEach((r) => { (byVisit[r.visit] = byVisit[r.visit] || []).push(r.seq); });
  const gaps = Object.entries(byVisit).filter(([, seqs]) => {
    const a = [...seqs].sort((x, y) => x - y);
    return a[0] !== 1 || a.some((x, i) => x !== i + 1);
  });
  ok("A4 终局对齐：每一次页面载入的记录 seq 连续无缺口", gaps.length === 0, JSON.stringify(gaps.slice(0, 2)));

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
