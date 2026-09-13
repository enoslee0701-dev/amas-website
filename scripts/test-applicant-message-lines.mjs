// 申请人侧同一段「招生同工留言」（applications.applicant_visible_message）
// 在四个真实节点上的呈现：申请页（:454）、首页（:78）、历史页卡片（:117）、
// 历史页时间线（:158）。
//
// 转义四处都用 UI.esc，本探针**不动转义**；查的是**分项补件说明的换行会不会被折掉**
// —— 折掉了他就读不清「第 1 项、第 2 项」分别要补什么。
// 读 innerText + 可见性（textContent 连隐藏内容也算），并核四处是不是同一段。
// 本地合成申请人夹具，无写入、无外网请求。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-msg-"));
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
      insert:function(){ mode="insert"; return q; },
      update:function(patch){ mode="update"; try { window.__lastPatch = patch; } catch(e){} return q; },
      then:function(res, rej){
        var sc = S();
        /* 草稿保存要**真的落下去**，否则「刷新后继续」只是换了一份夹具。
           同源 localStorage 当共享状态，update 写进去、my_application 读回来。 */
        if (mode === "update" && name === "applications") {
          try {
            var cur = JSON.parse(localStorage.getItem("__draft") || "null") || {};
            var merged = Object.assign({}, cur, (window.__lastPatch || {}));
            localStorage.setItem("__draft", JSON.stringify(merged));
          } catch(e){}
        }
        /* 每一次查询都留痕：表、模式、列投影、eq 条件 —— 断言就读这里。 */
        try { (window.__q = window.__q || []).push({ name:name, mode:mode, cols:cols, eq:eqs }); } catch(e){}
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
      if (name === "my_application") {
        var st = null;
        try { st = JSON.parse(localStorage.getItem("__draft") || "null"); } catch(e){}
        var base = (S().rpc && S().rpc.my_application && S().rpc.my_application.data) || [];
        var row = base[0] ? JSON.parse(JSON.stringify(base[0])) : null;
        if (row && st && st.form_data) row.form_data = st.form_data;
        try { (window.__rpc = window.__rpc || []).push({ name:name, args:args||null }); } catch(e){}
        return reply({ data: row ? [row] : [], error:null, status:200 });
      }
      try { (window.__rpc = window.__rpc || []).push({ name:name, args:args||null }); } catch(e){}
      if (name === "my_roles") return reply({ data:[{ role:"applicant" }], error:null, status:200 });
      if (name === "my_profile") return reply({ data:{ display_name:"申请人甲", email:"a@example.invalid" }, error:null, status:200 });
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
  /* 改过没保存的那一版会触发 UI.formGuard 的 beforeunload；
     探针要接住原生对话框，否则下一次 Page.navigate 会一直卡到超时。 */
  cdp.on("Page.javascriptDialogOpening", async () => {
    try { await cdp.send("Page.handleJavaScriptDialog", { accept: true }); } catch (e) {}
  });
  let pageErrors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    pageErrors.push(String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || "").slice(0, 200));
  });

  /* 教务写的分项补件说明：三项，一项一行。 */
  const MSG = "请补以下三项：\n1. 受洗证明扫描件\n2. 教会推荐信（需负责人签名）\n3. 最高学历证书";
  const APP = { id:"app-1", pathway:"degree", status:"needs_information",
    form_data:{ name_zh:"申请人甲", programs:["bth"] }, form_version:"v1",
    locked_fields:[], applicant_visible_message: MSG,
    submitted_at:"2026-09-01T00:00:00Z", decided_at:null, updated_at:"2026-09-06T00:00:00Z" };
  const scen = {
    uid:"u-appl", aal:"aal1",
    tables: {
      program_catalog: { data:[{ code:"bth", name_zh:"神学本科", short_label:"B.Th",
        category:"degree", intake_note_zh:"", is_open_for_application:true, sort_order:1 }] },
      application_requirements: { data:[{ id:"rq-1", label:"受洗证明", detail:"", field:null,
        resolved:false, created_at:"2026-09-02T00:00:00Z" }] },
      application_status_history: { data: [] },
      application_hq_approvals: { data: [] },
      /* 历史页读的是 applications 表（已结束那两种状态）。 */
      applications: { data:[{ id:"app-old", pathway:"bth", status:"rejected",
        applicant_visible_message: MSG, submitted_at:"2025-09-01T00:00:00Z",
        decided_at:"2025-09-20T00:00:00Z", created_at:"2025-08-01T00:00:00Z" }] },
    },
    rpc: { my_application: { data:[APP] },
           my_application_timeline: { data:[{ to_status:"needs_information",
             created_at:"2026-09-06T00:00:00Z", applicant_visible_message: MSG }] } },
    write: { data:[], error:null },
  };
  const open = async (path) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__SCEN = " + JSON.stringify(scen) + "; window.__q=[]; window.__rpc=[];" });
    await cdp.send("Page.navigate", { url: `${BASE}${path}` });
    await sleep(2800);
  };
  /* 只认**看得见**的那一份：innerText + 可见性。 */
  const nodeOf = async (sel, needle) => cdp.ev(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(sel)})]
    .find(x=>(x.textContent||"").indexOf(${JSON.stringify(needle)}) > -1);
    return n ? { shown:n.innerText, text:n.textContent,
                 visible: !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length) } : null;})()`);
  const wrote = async () => cdp.ev(`(()=>((window.__q||[]).filter(q=>q.mode!=="select").length +
    (window.__rpc||[]).filter(r=>/^(submit_|review_|resolve_|withdraw_|update_)/.test(r.name)).length))()`);
  const lines = (t) => String(t || "").split("\n").map(x => x.trim()).filter(Boolean);
  const okNode = (name, n) => {
    const L = lines(n && n.shown);
    ok(name, !!n && n.visible === true && L.length >= 4 &&
       L.indexOf("1. 受洗证明扫描件") > -1 && L.indexOf("3. 最高学历证书") > -1,
       JSON.stringify(n && { shown: n.shown, visible: n.visible }));
  };

  console.log("\n=== Ms 同一段分项补件说明，在申请人侧四个节点上读不读得清 ===");
  await open("/portal/applicant/application/");
  const a1 = await nodeOf(".msg.info", "招生同工留言");
  ok("Ms0 前提：申请页显示了这段留言", !!a1, JSON.stringify(a1 && a1.shown));
  okNode("Ms1 申请页：三项分行看得见（不是挤成一行）", a1);
  ok("Ms2 申请页：内容与教务写的一字不差", !!a1 && a1.text.indexOf(MSG) > -1,
     JSON.stringify(a1 && a1.text));
  ok("Ms3 申请页：没有产生任何写入", (await wrote()) === 0);

  await open("/portal/applicant/");
  const h1 = await nodeOf(".msg.info", "招生同工留言");
  ok("Ms4 前提：首页也显示了同一段", !!h1, JSON.stringify(h1 && h1.shown));
  okNode("Ms5 首页：三项分行看得见", h1);

  await open("/portal/applicant/history/");
  const s1 = await nodeOf(".said", "请补以下三项");
  ok("Ms6 前提：历史页卡片里也有这一段", !!s1, JSON.stringify(s1 && s1.shown));
  okNode("Ms7 历史页卡片：三项分行看得见", s1);
  /* 时间线要先展开（键盘按下「查看状态变化」）。 */
  const btn = await cdp.ev(`(()=>{const b=[...document.querySelectorAll("[data-tl]")][0];
    if(!b) return false; b.focus(); return true;})()`);
  if (btn) {
    await cdp.send("Input.dispatchKeyEvent", { type:"rawKeyDown", key:"Enter", code:"Enter",
      windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
    await cdp.send("Input.dispatchKeyEvent", { type:"char", text:"\r", key:"Enter", code:"Enter" });
    await cdp.send("Input.dispatchKeyEvent", { type:"keyUp", key:"Enter", code:"Enter",
      windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
    await sleep(1200);
  }
  const t1 = await nodeOf(".tl-row em", "请补以下三项");
  ok("Ms8 前提：时间线展开后也有这一段", !!t1, JSON.stringify(t1 && t1.shown));
  okNode("Ms9 历史页时间线：三项分行看得见", t1);
  /* 说清楚范围：历史页那条是**另一份已结束的申请**（app-old），
     与当前这份（app-1）不是同一申请；这里比的是**同一段文本**在四处的呈现是否一致。
     比的也是**全文**，不再只挑第一/第三项。 */
  ok("Ms10 四处呈现的是**同一段全文**（历史页那条属另一份申请，只比文本）",
     !!a1 && !!h1 && !!s1 && !!t1 &&
     [a1, h1, s1, t1].every(n => n.text.indexOf(MSG) > -1), "");
  /* 导航会把页内的 __q/__rpc 清零，所以这一条只能说**历史页这一程**没有写入，
     不能说「全程」。申请页那一程由 Ms3 单独断言。 */
  ok("Ms11 历史页这一程没有提交或审核写入", (await wrote()) === 0);

  // ════════ Rf 收到分项补件 → 找到字段 → 存草稿 → **真刷新**后继续 ════════
  console.log("\n=== Rf 补件→改字段→存草稿→刷新后继续 ===");
  /* 前面几环此前已绿，不在这里重跑：
       字段定位与「去修改」焦点落位 —— 第七十七包 K5c / F7；
       自动保存与串行化 —— applicant-writes 287；
       离开时的暂存/恢复 —— Ex / Rl 两组。
     这一段只补**真刷新**这一环：服务端草稿回来之后他接着改的那一版还在不在。 */
  const KEY = { Tab:{code:"Tab",key:"Tab",vk:9}, Enter:{code:"Enter",key:"Enter",vk:13},
                End:{code:"End",key:"End",vk:35} };
  const press = async (k) => {
    const m = KEY[k];
    await cdp.send("Input.dispatchKeyEvent", { type:"rawKeyDown",
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    if (k === "Enter") await cdp.send("Input.dispatchKeyEvent", { type:"char", text:"\r", key:m.key, code:m.code });
    await cdp.send("Input.dispatchKeyEvent", { type:"keyUp",
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    await sleep(90);
  };
  const typeText = async (t) => {
    for (const ch of String(t)) {
      const vk = ch.toUpperCase().charCodeAt(0);
      await cdp.send("Input.dispatchKeyEvent", { type:"keyDown", key:ch, windowsVirtualKeyCode:vk, nativeVirtualKeyCode:vk });
      await cdp.send("Input.dispatchKeyEvent", { type:"char", text:ch, key:ch });
      await cdp.send("Input.dispatchKeyEvent", { type:"keyUp", key:ch, windowsVirtualKeyCode:vk, nativeVirtualKeyCode:vk });
      await sleep(16);
    }
    await sleep(120);
  };
  const until = async (fn, ms) => { const t0 = Date.now();
    while (Date.now() - t0 < (ms || 9000)) { try { if (await fn()) return true; } catch(e){} await sleep(120); } return false; };
  /* 表单字段的 id 是 fd-<name>（focusFormField 用的就是它），不是 name 属性。 */
  const phone = async () => cdp.ev(`(()=>{const e=document.getElementById("fd-phone"); return e?e.value:null;})()`);

  /* 这一份处于 needs_information，补件条目指向 phone（不在锁定表里）。 */
  scen.tables.application_requirements = { data:[{ id:"rq-1", label:"补填联系电话",
    detail:"教务需要能联系到你", field:"phone", resolved:false, created_at:"2026-09-02T00:00:00Z" }] };
  scen.rpc.my_application.data[0].locked_fields = ["name_zh"];
  scen.rpc.my_application.data[0].form_data = { name_zh:"申请人甲", programs:["bth"], phone:"" };
  await cdp.ev(`(()=>{ try{ localStorage.removeItem("__draft"); }catch(e){} return true; })()`).catch(() => {});
  await open("/portal/applicant/application/");
  ok("Rf0 前提：补件条目在，并给得出「去修改」（字段未锁）",
     (await cdp.ev(`(()=>{const b=document.querySelector('[data-gofield="phone"]');
       return !!b && /去修改/.test(b.textContent||"");})()`)) === true);
  const hit = await (async () => { for (let i = 1; i <= 40; i++) { await press("Tab");
    const on = await cdp.ev(`(()=>{const a=document.activeElement;
      return !!(a && a.dataset && a.dataset.gofield === "phone");})()`); if (on) return true; } return false; })();
  ok("Rf1 前提：键盘走得到「去修改」", hit === true);
  await press("Enter"); await sleep(600);
  ok("Rf2 前提：焦点落在那个字段上（此前 K5c/F7 已绿，这里只作前提）",
     (await cdp.ev(`(()=>{const a=document.activeElement; return a ? a.id : "";})()`)) === "fd-phone",
     JSON.stringify(await cdp.ev(`(()=>{const a=document.activeElement; return a?{id:a.id,tag:a.tagName}:null;})()`)));
  await press("End");
  await typeText("0123456789");
  ok("Rf3 草稿真的存下去了（服务端收到的那一版带着新号码）",
     await until(async () => cdp.ev(`(()=>{ try { const d=JSON.parse(localStorage.getItem("__draft")||"null");
       return !!(d && d.form_data && d.form_data.phone === "0123456789"); } catch(e){ return false; } })()`), 12000),
     JSON.stringify(await cdp.ev(`(()=>localStorage.getItem("__draft"))()`)));
  /* 刷新**之前**先把这一程的账算清：这时 __rpc 还没被导航清零。 */
  ok("Rf3b 刷新**之前**这一程也没有提交 / 标记补件（此时计数尚未被导航清零）",
     (await cdp.ev(`(()=>((window.__rpc||[]).filter(r=>/^(submit_|resolve_|review_)/.test(r.name)).length))()`)) === 0,
     JSON.stringify(await cdp.ev(`(()=>((window.__rpc||[]).map(r=>r.name)))()`)));
  /* 排除另一个来源：页内暂存（sessionStorage）也能把值放回输入框。
     先把它清掉，这样 Rf4 读回来的那一版只可能来自**服务端草稿**（本夹具里即共享状态）。 */
  await cdp.ev(`(()=>{ try{ sessionStorage.clear(); }catch(e){} return true; })()`);
  ok("Rf3c 前提：页内暂存已清空（排除它作为刷新后取值的来源）",
     (await cdp.ev(`(()=>{ try{ return sessionStorage.length; }catch(e){ return -1; } })()`)) === 0);
  /* **真刷新**：重新载入这一页，看他接着改的那一版还在不在。 */
  await cdp.send("Page.navigate", { url: `${BASE}/portal/applicant/application/` });
  await sleep(3000);
  ok("Rf4 刷新之后那一版还在（服务端草稿读回来了）", (await phone()) === "0123456789",
     JSON.stringify(await phone()));
  ok("Rf5 补件条目仍然列着、仍是未完成（没有被谁悄悄标成已补）",
     (await cdp.ev(`(()=>{const m=document.getElementById("main");
       return /未完成 1 项/.test((m&&m.textContent)||"");})()`)) === true,
     JSON.stringify(await cdp.ev(`(()=>{const m=document.getElementById("main");
       return ((m&&m.textContent)||"").slice(0,80);})()`)));
  ok("Rf6 刷新**之后**这一程同样没有提交 / 标记补件（与 Rf3b 合起来才覆盖前后两程）",
     (await cdp.ev(`(()=>((window.__rpc||[]).filter(r=>/^(submit_|resolve_|review_)/.test(r.name)).length))()`)) === 0,
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
console.log("  Rf 组里的共享 localStorage 只是**模拟服务端草稿**：它证明的是页面行为，");
console.log("  **不证明**真实 Supabase 上的草稿往返已验（那要等 B3 受控演练）。");
process.exit(fail ? 1 : 0);
