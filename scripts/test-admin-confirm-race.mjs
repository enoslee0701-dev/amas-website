// 走 UI.confirmDialog 的两条路：正式注册（activate_student）与确认纠正
// （approve_student_number_void）。这两条**不经过 modal()**，行内按钮在途期间
// 也不停用 —— 所以要单独查。
//
// 监督的口径：「服务端能拒绝重复**不等于**前端体验已经验收。重点查看
// 第一次成功而重复失败的**乱序回执**是否把成功误报失败、对象身份和反馈是否一致。」
//
// 真实契约（读出来的，不是编的）：
//   activate_student            0012_student_core.sql —— 第二次 s.status <> 'pre_enrolled'
//                               → jsonb {ok:false, error:'invalid_state', status:'active'}
//   approve_student_number_void 0015_student_number_states.sql:385 —— 第二次 r.status <> 'pending'
//                               → jsonb {ok:false, error:'invalid_state', status:<r.status>}
//   两者都是 **RPC 正常返回**，student-lifecycle/index.ts:149 原样透传 **HTTP 200**。
//   所以夹具按到达顺序发牌：第一笔 {ok:true}，第二笔 {ok:false,error:'invalid_state'}，
//   而**放行顺序**由测试决定 —— 这才叫乱序回执。
//
// 全程真实按键（Input.dispatchKeyEvent），不用 element.click()/focus() 替用户走路；
// 判定一律读**状态与结构**（扣住几笔、body 是哪个动作哪个对象、横幅是否 show、
// 表格里那一行的状态文字），不猜文案。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-confirm-"));
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
      if (u.indexOf("/functions/v1/") > -1) {
        const method = (ev.request.method || "").toUpperCase();
        if (method === "OPTIONS") {            // 预检：放行但**不算写入**
          await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 204,
            responseHeaders: CORS });
          return;
        }
        let body = null;
        try { body = ev.request.postData || null; } catch (e) {}
        const card = edgeScript.length ? edgeScript.shift() : edgeFallback;
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
  const active = async () => cdp.ev(`(()=>{const a=document.activeElement;
    if(!a || a===document.body) return { tag:"BODY" };
    return { tag:a.tagName, id:a.id||"",
             attrs:[...a.attributes].map(x=>x.name).filter(n=>/^data-/.test(n)).join(","),
             text:(a.textContent||"").replace(/[ \\t\\n\\r]+/g," ").trim().slice(0,24) };})()`);
  const until = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) { if (await fn()) return true; await sleep(100); }
    return false;
  };
  const modalUp = async () => cdp.ev(`!!document.querySelector(".portal-modal")`);
  const toastText = async () => cdp.ev(`(()=>{const t=document.getElementById("amas-toast");
    return t && t.classList.contains("show") ? (t.textContent||"").trim() : "";})()`);
  /* 页面级红色横幅：只有 show 才算「正在对他说这句话」。 */
  const bannerText = async () => cdp.ev(`(()=>{const e=document.getElementById("err");
    return e && e.classList.contains("show") ? (e.textContent||"").trim() : "";})()`);
  /* 表格里那一名学生此刻显示的状态文字 —— 用来和横幅对质。 */
  const rowStatus = async (sid) => cdp.ev(`(()=>{const b=document.querySelector('[data-activate="${sid}"],[data-fixnum="${sid}"]');
    const tr=b?b.closest("tr"):null; if(!tr) return null;
    const td=tr.querySelector(".st"); return td?(td.textContent||"").trim():null;})()`);
  const bodiesOf = () => heldEdge.map(h => { try { const b = JSON.parse(h.body);
    return b.action + "/" + (b.student_id || b.request_id || b.application_id || "?"); }
    catch (e) { return "?"; } });
  /** 真实 Tab 走到带某个 data 属性且值等于 want 的按钮上，然后按下去。 */
  const tabToData = async (attr, want, max) => {
    for (let i = 1; i <= (max || 90); i++) {
      await press("Tab");
      const v = await cdp.ev(`(()=>{const a=document.activeElement;
        return a && a.dataset ? (a.dataset[${JSON.stringify(attr)}] || "") : "";})()`);
      if (v === want) return { hit: true, steps: i };
    }
    return { hit: false, steps: max || 90, at: await active() };
  };
  /** 确认框：焦点开框时就在「确认」上（ui.js:83），直接 Enter。 */
  const confirmIt = async () => {
    if (!(await modalUp())) return false;
    const onOk = await cdp.ev(`(()=>{const a=document.activeElement;
      return !!(a && a.hasAttribute && a.hasAttribute("data-ok"));})()`);
    if (!onOk) return false;
    await press("Enter"); await sleep(400);
    return (await modalUp()) === false;
  };

  /* ── 本地合成夹具 ─────────────────────────────────────────────────── */
  const mkScen = () => ({
    uid:"u-admin", aal:"aal2", roles:[{ role:"registrar" }],
    tables: {
      program_catalog: { data:[{ code:"bth", name_zh:"神学本科", short_label:"B.Th" }] },
      applications: { data: [] },
      user_roles: { data:[{ user_id:"u-admin", role:"registrar" }] },
      profiles: { data:[
        { id:"u-stu1", display_name:"学生甲", email:"s1@example.invalid" },
        { id:"u-stu2", display_name:"学生乙", email:"s2@example.invalid" } ] },
      application_hq_approvals: { data: [] },
      student_records: { data:[
        { id:"stu-1", user_id:"u-stu1", status:"pre_enrolled", student_number:"B26-0007",
          program_code:"bth", activated_at:null, created_at:"2026-09-01T00:00:00Z" },
        { id:"stu-2", user_id:"u-stu2", status:"pre_enrolled", student_number:"B26-0008",
          program_code:"bth", activated_at:null, created_at:"2026-08-01T00:00:00Z" } ] },
    },
    rpc: {
      admissions_ready_for_enrollment: { data: [] },
      pending_number_void_requests: { data:[
        { id:"req-1", student_id:"stu-1", display_name:"学生甲",
          wrong_original:"B26-0007", replacement_original:"B26-1111",
          reason:"录入手误", evidence_reference:"HQ-9", initiator_name:"另一名管理员",
          initiated_at:"2026-09-10T00:00:00Z", can_i_approve:true },
        { id:"req-2", student_id:"stu-2", display_name:"学生乙",
          wrong_original:"B26-0008", replacement_original:"B26-2222",
          reason:"录入手误", evidence_reference:"HQ-10", initiator_name:"另一名管理员",
          initiated_at:"2026-09-10T00:00:00Z", can_i_approve:true } ] },
    },
    write: { data:[], error:null },
  });
  const openAdmin = async () => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(mkScen()) + ";" });
    await cdp.send("Page.navigate", { url: `${BASE}/portal/admin/students/` });
    await sleep(3000);
  };
  const goTab = async (re) => {
    for (let i = 1; i <= 30; i++) {
      await press("Tab");
      const a = await active();
      if ((a.attrs || "").indexOf("data-tab") > -1 && re.test(a.text || "")) {
        await press("Enter"); await sleep(1200); return true;
      }
    }
    return false;
  };
  /** 服务端真的生效之后，列表重读到的就是新状态 —— 夹具要跟着改，否则对质无从谈起。 */
  const markActivated = async (sid) => cdp.ev(`(()=>{const r=window.__SCEN.tables.student_records.data
    .find(x=>x.id===${JSON.stringify(sid)}); if(!r) return false; r.status="active";
    r.activated_at="2026-09-14T00:00:00Z"; return true;})()`);
  const dropVoidReq = async (id) => cdp.ev(`(()=>{const d=window.__SCEN.rpc.pending_number_void_requests;
    d.data=d.data.filter(x=>x.id!==${JSON.stringify(id)}); return d.data.length;})()`);

  // ════════ Av 正式注册：重复提交 + 乱序回执 ════════
  console.log("\n=== Av 正式注册：在途期间还能再按一次吗？两条回执乱序回来之后他看到什么 ===");
  await openAdmin();
  edgeHold = true; heldEdge = [];
  /* 按**到达顺序**发牌：第一笔照做，第二笔撞上 activate_student 的 invalid_state
     （s.status 已经是 active）。这是契约里写着的，不是编的。 */
  edgeScript = [ { status:200, body:{ ok:true, status:"active" } },
                 { status:200, body:{ ok:false, error:"invalid_state", status:"active" } } ];
  ok("Av0 前提：键盘走得到「在册学生」", (await goTab(/在册学生/)) === true);
  const a1 = await tabToData("activate", "stu-1", 90);
  ok("Av1 前提：真实 Tab 走到第一名学生的「正式注册」", a1.hit === true, JSON.stringify(a1));
  await press("Enter"); await sleep(500);
  ok("Av2 前提：确认框开着，焦点就在「确认注册」上", (await confirmIt()) === true);
  ok("Av3 前提：第一笔 POST 到达并被扣住",
     await until(async () => heldEdge.length === 1, 6000) &&
     /^activate_student\/stu-1$/.test(bodiesOf()[0] || ""), JSON.stringify(bodiesOf()));
  /* 关键：确认框关掉之后焦点回到行内那个按钮（ui.js:84 prev.focus()），
     而那个按钮**没有被停用** —— 于是他可以原地再按一次。 */
  const backOnBtn = await cdp.ev(`(()=>{const a=document.activeElement;
    return { onBtn: !!(a && a.dataset && a.dataset.activate === "stu-1"), disabled: !!(a && a.disabled) };})()`);
  ok("Av4 前提：焦点回到那一行的按钮上", backOnBtn.onBtn === true, JSON.stringify(backOnBtn));
  await press("Enter"); await sleep(500);
  const second = await confirmIt();
  await sleep(900);
  ok("Av5 在途期间**不该**再发出第二笔（重复注册同一名学生）",
     heldEdge.length === 1, "扣住 " + heldEdge.length + " 笔：" + JSON.stringify(bodiesOf()) +
     "；第二次确认框" + (second ? "开得起来" : "没开"));
  ok("Av6 并且要让他知道为什么（可见反馈，不是默默无事发生）",
     heldEdge.length === 1
       ? ((await toastText()).length > 0 || (await bannerText()).length > 0)
       : false,
     JSON.stringify({ toast: await toastText(), banner: await bannerText() }));
  // ── 正序放行：先成功，后失败
  await markActivated("stu-1");
  if (heldEdge[0]) await heldEdge[0].send();
  await until(async () => (await toastText()).length > 0, 8000);
  const okToast = await toastText();
  if (heldEdge[1]) await heldEdge[1].send();
  await sleep(1200);
  const bannerAfter = await bannerText();
  const stAfter = await rowStatus("stu-1");
  ok("Av7 这一次其实是**成功**的（列表重读之后那一行已经是在读）",
     stAfter === "在读", JSON.stringify({ stAfter, okToast }));
  ok("Av8 成功之后**不该**还留着一条「失败」的红横幅（成功被误报为失败）",
     bannerAfter === "", JSON.stringify({ bannerAfter, stAfter }));
  ok("Av9 如果要报错，也得说清楚是对**谁**的操作（两名学生同列时认得出）",
     bannerAfter === "" || /学生甲|B26-0007/.test(bannerAfter), JSON.stringify(bannerAfter));
  edgeHold = false; heldEdge = []; edgeScript = [];
  if (await modalUp()) { await press("Enter"); await sleep(300); }

  // ── 乱序放行：先失败，后成功
  console.log("\n=== Av' 同一件事，回执**倒过来**回：先失败后成功 ===");
  await openAdmin();
  edgeHold = true; heldEdge = [];
  edgeScript = [ { status:200, body:{ ok:true, status:"active" } },
                 { status:200, body:{ ok:false, error:"invalid_state", status:"active" } } ];
  ok("Av10 前提：又到「在册学生」", (await goTab(/在册学生/)) === true);
  const a2 = await tabToData("activate", "stu-1", 90);
  if (a2.hit) { await press("Enter"); await sleep(500); await confirmIt(); }
  ok("Av11 前提：第一笔被扣住", await until(async () => heldEdge.length === 1, 6000));
  await press("Enter"); await sleep(500);
  await confirmIt();
  await sleep(900);
  /* 这一段断言的是**最终状态不自相矛盾**，而不是「有没有第二笔」——
     所以修好前后都可证伪：
       修好之前：在途 2 笔，倒着放行 = 失败先回、成功后回（就是乱序），
                 终局是「行已在读」而屏幕上留着一条失败横幅 → FAIL；
       修好之后：在途只有 1 笔，放行之后终局应当是「行已在读 + 没有失败横幅」→ PASS。
     若一笔都没在途，Av12 会直接 FAIL，后面两条不会空过。 */
  const inflight = heldEdge.length;
  console.log("      · 此刻在途 " + inflight + " 笔：" + JSON.stringify(bodiesOf()));
  ok("Av12 前提：至少有一笔在途（否则后面两条就是空过）", inflight >= 1, "在途 " + inflight + " 笔");
  await markActivated("stu-1");
  for (let i = heldEdge.length - 1; i >= 0; i--) {   // 倒着放行：最后到的先回来
    await heldEdge[i].send();
    await sleep(900);
  }
  await until(async () => (await toastText()).length > 0, 8000);
  await sleep(900);
  const bannerEnd = await bannerText();
  const stEnd = await rowStatus("stu-1");
  ok("Av13 回执都回来之后，这一次其实是成功的（那一行已经是在读）", stEnd === "在读",
     JSON.stringify({ stEnd, inflight }));
  ok("Av14 那就不该在屏幕上留着「失败」（成功被误报为失败）",
     bannerEnd === "", JSON.stringify({ bannerEnd, stEnd, inflight, toast: await toastText() }));
  edgeHold = false; heldEdge = []; edgeScript = [];
  if (await modalUp()) { await press("Enter"); await sleep(300); }

  // ════════ Ap 确认纠正：同一份纠错申请 ════════
  console.log("\n=== Ap 确认纠正：同一份纠错申请会不会被确认两次 ===");
  await openAdmin();
  edgeHold = true; heldEdge = [];
  edgeScript = [ { status:200, body:{ ok:true } },
                 { status:200, body:{ ok:false, error:"invalid_state", status:"approved" } } ];
  ok("Ap0 前提：键盘走得到「学号纠错」，而且有待确认的申请", (await goTab(/学号纠错/)) === true &&
     (await cdp.ev(`!!document.querySelector("[data-approve]")`)) === true);
  const p1 = await tabToData("approve", "req-1", 90);
  ok("Ap1 前提：真实 Tab 走到「确认纠正」", p1.hit === true, JSON.stringify(p1));
  await press("Enter"); await sleep(500);
  ok("Ap2 前提：确认框开着并按下确认", (await confirmIt()) === true);
  ok("Ap3 前提：第一笔 POST 到达并被扣住",
     await until(async () => heldEdge.length === 1, 6000) &&
     /^approve_number_void\/req-1$/.test(bodiesOf()[0] || ""), JSON.stringify(bodiesOf()));
  await press("Enter"); await sleep(500);
  const second2 = await confirmIt();
  await sleep(900);
  ok("Ap4 在途期间**不该**再确认一次同一份申请",
     heldEdge.length === 1, "扣住 " + heldEdge.length + " 笔：" + JSON.stringify(bodiesOf()) +
     "；第二次确认框" + (second2 ? "开得起来" : "没开"));
  ok("Ap5 并且要让他知道为什么（可见反馈）",
     heldEdge.length === 1
       ? ((await toastText()).length > 0 || (await bannerText()).length > 0)
       : false,
     JSON.stringify({ toast: await toastText(), banner: await bannerText() }));
  const apInflight = heldEdge.length;
  console.log("      · 此刻在途 " + apInflight + " 笔：" + JSON.stringify(bodiesOf()));
  ok("Ap6 前提：至少有一笔在途（否则下一条就是空过）", apInflight >= 1, "在途 " + apInflight + " 笔");
  await dropVoidReq("req-1");
  for (let i = heldEdge.length - 1; i >= 0; i--) { await heldEdge[i].send(); await sleep(900); }
  await until(async () => (await toastText()).length > 0, 8000);
  await sleep(900);
  const apBanner = await bannerText();
  ok("Ap7 这一份确认成功之后，不该还留着一条「失败」的红横幅",
     apBanner === "", JSON.stringify({ apBanner, apInflight, toast: await toastText() }));
  edgeHold = false; heldEdge = []; edgeScript = [];
  if (await modalUp()) { await press("Enter"); await sleep(300); }

  /* 只按**一次**就被服务端拒绝 —— 这条路修好之后依然走得到，
     所以「错误说不说得出是对谁的」要在这里查，而不是靠那条自相矛盾的横幅。 */
  console.log("\n=== As 只按一次就被拒：这条错误说得出是对谁的吗 ===");
  await openAdmin();
  edgeHold = false; heldEdge = [];
  edgeScript = [ { status:200, body:{ ok:false, error:"invalid_state", status:"active" } } ];
  ok("As0 前提：到「在册学生」", (await goTab(/在册学生/)) === true);
  const s1 = await tabToData("activate", "stu-1", 90);
  ok("As1 前提：走到第一名学生的「正式注册」并确认", s1.hit === true &&
     (await (async () => { await press("Enter"); await sleep(500); return confirmIt(); })()) === true);
  const asBanner = await until(async () => (await bannerText()).length > 0, 8000)
    ? await bannerText() : "";
  ok("As2 前提：服务端拒了，页面上确实给出了一条错误", asBanner.length > 0, JSON.stringify(asBanner));
  ok("As3 这条错误说得出是对**谁**的操作（列表里两名学生，认不出就等于没说）",
     /学生甲|B26-0007/.test(asBanner), JSON.stringify(asBanner));
  edgeScript = [];

  /* 正控：换一份申请、换一名学生，不能被别人的在途锁误伤。 */
  console.log("\n=== Ai 对象隔离：另一份申请 / 另一名学生不受影响 ===");
  await openAdmin();
  edgeHold = true; heldEdge = [];
  edgeScript = [];
  ok("Ai0 前提：到「学号纠错」", (await goTab(/学号纠错/)) === true);
  const q1 = await tabToData("approve", "req-1", 90);
  if (q1.hit) { await press("Enter"); await sleep(500); await confirmIt(); }
  ok("Ai1 前提：第一份申请那一笔被扣住", await until(async () => heldEdge.length === 1, 6000),
     JSON.stringify(bodiesOf()));
  const q2 = await tabToData("approve", "req-2", 90);
  ok("Ai2 真实 Tab 走得到第二份申请的「确认纠正」", q2.hit === true, JSON.stringify(q2));
  await press("Enter"); await sleep(500);
  const c2 = await confirmIt();
  ok("Ai3 第二份申请的确认框照常开、照常确认", c2 === true);
  ok("Ai4 第二份申请照常发得出自己那一笔（没被别人的锁误伤）",
     await until(async () => heldEdge.length === 2, 6000), JSON.stringify(bodiesOf()));
  for (const hd of heldEdge) await hd.send();
  edgeHold = false; heldEdge = [];
  await sleep(800);

  console.log("\n=== G 外发 ===");
  ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");
  ok("G2 全程没有页面异常", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
  ok("G3 全程没有弹出浏览器原生对话框（键盘用户无处可去）", nativeDialogs.length === 0,
     JSON.stringify(nativeDialogs.slice(0, 2)));
  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。");
process.exit(fail ? 1 : 0);
