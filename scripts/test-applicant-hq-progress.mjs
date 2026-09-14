// 申请人页：**总校确认进度**这一段（第一百包）。
//
// 监督批准的范围：本地可逆实现，**不批准上线，也不替甲方决定 P4**。
// 文案一律中性：pending=总校确认处理中 / approved=总校确认已通过 /
// rejected=总校确认未通过（**不推导**取消录取或学籍状态）；
// 未知或读取失败=暂时无法获取总校确认进度，并给「重新读取」。
// 「读成功但没有那一行」与「没读到」必须**分开说**，各自依现有契约解释。
//
// 本探针盯死四件事：
//   ① 请求本身：只发 application_id 这一个条件，列投影**只有三列**
//      （批文编号 approval_reference / 确认人 confirmed_by **连要都不要**）；
//   ② 四种状态 + 空行 + 读取失败各自的呈现；
//   ③ 内部哨兵一个字都不出现在页面上；备注按**文本**呈现，不进 innerHTML；
//   ④ 全程没有任何写入，且「重新读取」真的能重读。
// 全程真实按键。本地合成夹具：无真实账号/凭据/服务，无远端写入，无外网请求。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-hq-"));
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
      insert:function(){ mode="insert"; return q; }, update:function(){ mode="update"; return q; },
      then:function(res, rej){
        var sc = S();
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
      if (u.indexOf("/functions/v1/") > -1) {          // 本页不该有任何 Edge 写入
        edgeCalls.push({ method:(ev.request.method||"").toUpperCase(), url:u });
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: CORS.concat([{ name:"Content-Type", value:"application/json" }]),
          body: b64("{}") });
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

  const KEYS = { Tab:{code:"Tab",key:"Tab",vk:9}, Enter:{code:"Enter",key:"Enter",vk:13} };
  const press = async (name) => {
    const m = KEYS[name];
    await cdp.send("Input.dispatchKeyEvent", { type:"rawKeyDown",
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    if (name === "Enter") await cdp.send("Input.dispatchKeyEvent", { type:"char", text:"\r", key:m.key, code:m.code });
    await cdp.send("Input.dispatchKeyEvent", { type:"keyUp",
      windowsVirtualKeyCode:m.vk, nativeVirtualKeyCode:m.vk, code:m.code, key:m.key });
    await sleep(90);
  };
  const until = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) { if (await fn()) return true; await sleep(100); }
    return false;
  };
  /* 只读**这一段**的文字：别的地方出现「已录取」不算数。 */
  const hqText = async () => cdp.ev(`(()=>{const b=document.getElementById("hqBox");
    return b ? (b.textContent||"").replace(/\\s+/g," ").trim() : null;})()`);
  const hqHtml = async () => cdp.ev(`(()=>{const b=document.getElementById("hqBox");
    return b ? b.innerHTML : null;})()`);
  const pageHtml = async () => cdp.ev(`(()=>document.documentElement.innerHTML)()`);
  const badge = async () => cdp.ev(`(()=>{const e=document.querySelector(".st");
    return e?(e.textContent||"").trim():null;})()`);
  const queries = async () => (await cdp.ev(`(window.__q || [])`)) || [];
  const hqQueries = async () => (await queries()).filter(q => q.name === "application_hq_approvals");
  const writes = async () => (await queries()).filter(q => q.mode !== "select");
  const rpcLog = async () => (await cdp.ev(`(window.__rpc || [])`)) || [];

  const FORM = { name_zh:"申请人甲", programs:["bth"] };
  const APP = (over) => Object.assign({
    id:"app-1", pathway:"degree", status:"accepted", form_data:FORM, form_version:"v1",
    locked_fields:["name_zh"], applicant_visible_message:null,
    submitted_at:"2026-09-01T00:00:00Z", decided_at:"2026-09-06T00:00:00Z",
    updated_at:"2026-09-06T00:00:00Z",
  }, over || {});
  /* 内部哨兵：批文编号与确认人。它们**不该被请求**，更不该出现在页面上。 */
  const SENTINEL_REF = "HQ-SECRET-REF-0001";
  const SENTINEL_BY  = "admin-uuid-SENTINEL";
  const scen = (hqTable, appOver) => ({
    uid:"u-appl", aal:"aal1",
    tables: {
      program_catalog: { data:[{ code:"bth", name_zh:"神学本科", short_label:"B.Th",
        category:"degree", intake_note_zh:"", is_open_for_application:true, sort_order:1 }] },
      application_hq_approvals: hqTable,
      application_requirements: { data: [] },
      application_status_history: { data: [] },
    },
    rpc: {
      my_application: { data:[APP(appOver)] },
      my_application_timeline: { data: [] },
    },
    write: { data:[], error:null },
  });
  const openWith = async (hqTable, appOver) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__SCEN = " + JSON.stringify(scen(hqTable, appOver)) + "; window.__q=[]; window.__rpc=[];" });
    await cdp.send("Page.navigate", { url: `${BASE}/portal/applicant/application/` });
    await sleep(2600);
  };
  const row = (st, over) => Object.assign({
    status: st, confirmed_at: st === "approved" ? "2026-09-08T02:00:00Z" : null,
    applicant_visible_note: null,
    /* 夹具里**放着**这两个字段，正是为了证明产品既没请求、也没显示它们。 */
    approval_reference: SENTINEL_REF, confirmed_by: SENTINEL_BY,
  }, over || {});

  // ════════ Q 请求本身：只要三列，只按 application_id ════════
  if (RUN("Q")) {
    console.log("\n=== Q 请求本身：列投影与查询条件 ===");
    await openWith({ data:[row("pending")] });
    const q1 = await hqQueries();
    ok("Q0 前提：确实向 application_hq_approvals 发了一次读取", q1.length === 1,
       JSON.stringify(q1));
    ok("Q1 列投影**只有这三列**（不是 select *）",
       q1[0] && q1[0].cols === "status,confirmed_at,applicant_visible_note", JSON.stringify(q1[0]));
    ok("Q2 内部编号与确认人**连要都没要**",
       q1[0] && q1[0].cols.indexOf("approval_reference") < 0 && q1[0].cols.indexOf("confirmed_by") < 0,
       JSON.stringify(q1[0] && q1[0].cols));
    ok("Q3 条件就是这一份申请的 application_id",
       q1[0] && JSON.stringify(q1[0].eq) === JSON.stringify({ application_id: "app-1" }),
       JSON.stringify(q1[0] && q1[0].eq));
    ok("Q4 这一段没有产生任何写入", (await writes()).length === 0, JSON.stringify(await writes()));

    // ════════ S 四种状态 + 空行 + 读取失败 ════════
  }
  if (RUN("S")) {
    console.log("\n=== S 四种状态各自怎么说 ===");
    /* 自带前提：原来这一组是接着 Q 组那一页读的，单独跑（ONLY=S）就什么都没有。 */
    await openWith({ data:[row("pending")] });
    ok("S0 pending → 总校确认处理中",
       /总校确认处理中/.test(await hqText() || ""), JSON.stringify(await hqText()));
    ok("S0b pending 时不冒出「已通过 / 未通过」",
       !/确认已通过|确认未通过/.test(await hqText() || ""), JSON.stringify(await hqText()));

    await openWith({ data:[row("approved", { applicant_visible_note: "请按通知办理入学手续" })] });
    ok("S1 approved → 总校确认已通过",
       /总校确认已通过/.test(await hqText() || ""), JSON.stringify(await hqText()));
    ok("S1b 总校说明显示出来了", /请按通知办理入学手续/.test(await hqText() || ""),
       JSON.stringify(await hqText()));

    await openWith({ data:[row("rejected")] });
    const rejText = await hqText();
    ok("S2 rejected → 总校确认未通过", /总校确认未通过/.test(rejText || ""), JSON.stringify(rejText));
    ok("S2b **不推导**录取被取消：上面的状态徽章仍然是「已录取」",
       (await badge()) === "已录取", JSON.stringify(await badge()));
    ok("S2c 这一段里不说「取消 / 作废 / 撤销录取」，也不断言学籍结果",
       !/取消|作废|撤销|学籍已|不予/.test(rejText || ""), JSON.stringify(rejText));

    await openWith({ data: [] });                       // 读成功，而且**确实**是空数组
    const emptyText = await hqText();
    ok("S3 明确的空数组 → 说「当前未查询到总校确认记录」",
       /当前未查询到总校确认记录/.test(emptyText || ""), JSON.stringify(emptyText));
    ok("S3b 不把「没查到」说成「未通过」或「处理中」",
       !/未通过|已通过|处理中/.test(emptyText || ""), JSON.stringify(emptyText));
    /* 不许替服务端断言「从来没有人记录过」—— 真实 RLS 还没验过（B3）。 */
    ok("S3c 也不断言「从未有人记录」这类更强的话",
       !/从未|从来没有|还没有人|没有人记/.test(emptyText || ""), JSON.stringify(emptyText));

    await openWith({ data:null, error:{ message:"boom" }, status:500 });
    const errText = await hqText();
    ok("S4 读取失败 → 暂时无法获取总校确认进度",
       /暂时无法获取总校确认进度/.test(errText || ""), JSON.stringify(errText));
    ok("S4b 失败时不冒充任何一种结论",
       !/已通过|未通过|处理中|还没有总校确认的记录/.test(errText || ""), JSON.stringify(errText));

    // ════════ R 重新读取：真的重读，而且不是整页刷新 ════════
  }
  if (RUN("R")) {
    console.log("\n=== R 「重新读取」这条出口 ===");
    await openWith({ data:null, error:{ message:"boom" }, status:500 });   // 自带前提
    const btnThere = await cdp.ev(`(()=>!!document.querySelector("[data-hqreload]"))()`);
    ok("R0 前提：失败时给得出「重新读取」", btnThere === true);
    await cdp.ev(`(()=>{ window.__stayProbe = 1;
      window.__SCEN.tables.application_hq_approvals = { data:[ ${JSON.stringify(row("approved"))} ] };
      return true; })()`);
    const before = (await hqQueries()).length;
    const hit = await (async () => {                    // 真实 Tab 走到那个按钮再按
      for (let i = 1; i <= 60; i++) {
        await press("Tab");
        const on = await cdp.ev(`(()=>{const a=document.activeElement;
          return !!(a && a.hasAttribute && a.hasAttribute("data-hqreload"));})()`);
        if (on) return true;
      }
      return false;
    })();
    ok("R1 前提：真实 Tab 走得到「重新读取」", hit === true);
    await press("Enter");
    ok("R2 它真的**重读了一次**（不是刷新整页）",
       await until(async () => (await hqQueries()).length === before + 1, 6000) &&
       (await cdp.ev(`(typeof window.__stayProbe !== "undefined")`)) === true,
       "读取次数 " + before + " → " + (await hqQueries()).length);
    ok("R3 重读之后显示的是新结果", /总校确认已通过/.test(await hqText() || ""),
       JSON.stringify(await hqText()));
    ok("R4 重读也没有产生任何写入", (await writes()).length === 0, JSON.stringify(await writes()));

    // ════════ P 内部哨兵 / 文本安全 / 不该请求的状态 ════════
  }
  if (RUN("P")) {
    console.log("\n=== P 内部凭据、文本安全、其它状态 ===");
    await openWith({ data:[row("approved", { applicant_visible_note: "<b>粗体</b>不该被当成标签" })] });
    const html = await pageHtml();
    ok("P0 内部编号一个字都没出现在页面上", html.indexOf(SENTINEL_REF) < 0);
    ok("P1 确认人也没有出现在页面上", html.indexOf(SENTINEL_BY) < 0);
    const noteNode = await cdp.ev(`(()=>{const n=document.querySelector("[data-hqnote]");
      return n ? { text:n.textContent, kids:n.children.length, html:n.innerHTML } : null;})()`);
    ok("P2 备注按**文本**呈现：容器里没有任何元素子节点",
       noteNode && noteNode.kids === 0, JSON.stringify(noteNode));
    ok("P3 而且原文一字不差（<b> 是字面量，不是标签）",
       noteNode && noteNode.text === "<b>粗体</b>不该被当成标签", JSON.stringify(noteNode && noteNode.text));

    await openWith({ data:[row("approved")] }, { status:"submitted", decided_at:null });
    ok("P4 还没录取的状态**完全不请求**这张表", (await hqQueries()).length === 0,
       JSON.stringify(await hqQueries()));
    ok("P5 那时页面上也没有这一段", (await hqText()) === null, JSON.stringify(await hqText()));
  }
  if (RUN("U")) {
    console.log("\n=== U 契约之外的形状：一律算未知，不许当成「没有记录」 ===");
    /* 上一版把 `!Array.isArray(data)` 和 `[]` 并成同一个 empty ——
       「读到的东西不是契约里那张表」被说成了「确实没有记录」。两回事。
       这张表 application_id 是主键（0012:36），所以多行本身就说明读到的不是它。 */
    const unknownShows = async (label) => {
      const t = await hqText();
      const btn = await cdp.ev(`(()=>!!document.querySelector("[data-hqreload]"))()`);
      ok(label + "：说「暂时无法获取总校确认进度」，并给得出「重新读取」",
         /暂时无法获取总校确认进度/.test(t || "") && btn === true, JSON.stringify(t));
      ok(label + "：不说成「未查询到记录」，也不冒充任何一种结论",
         !/未查询到总校确认记录|已通过|未通过|处理中/.test(t || ""), JSON.stringify(t));
    };
    await openWith({ data: null, error: null });        // 200 但 data 是 null
    await unknownShows("U0 data 是 null");
    await openWith({ data: {}, error: null });          // 非数组真值（网关页/被改写的响应体）
    await unknownShows("U1 data 是非数组真值");
    await openWith({ data: [row("approved"), row("pending")] });   // 多行
    await unknownShows("U2 读到两行（主键表不该有第二行）");
    await openWith({ data: [row("weird_status")] });     // 契约之外的 status
    await unknownShows("U3 status 不在契约内");
    await openWith({ data: [{ confirmed_at: "2026-09-08T02:00:00Z" }] });   // 缺 status
    await unknownShows("U4 行里根本没有 status");
    await openWith({ data: [null] });                    // 行不是对象
    await unknownShows("U5 行不是对象");
    /* 反过来：明确的空数组仍然是「空」，不能被这次收紧误伤。 */
    await openWith({ data: [] });
    ok("U6 明确的空数组仍然是「当前未查询到总校确认记录」（没被误伤成未知）",
       /当前未查询到总校确认记录/.test(await hqText() || ""), JSON.stringify(await hqText()));
  }

  if (RUN("C")) {
    console.log("\n=== C 枚举白名单与字段类型：原型上的名字不算合法状态，坏类型不许把页面炸掉 ===");
    /* 上一版的白名单判据是 `HQ_T[String(r.status||"")]` —— 对象字面量的原型上
       挂着 constructor / toString / hasOwnProperty …，它们**都是真值**，
       于是 status:"constructor" 会被当成合法状态放行，
       再到 render 里 `UI.esc(HQ_T[st])` 就把函数源码渲染出去了。
       真值判断不能当枚举白名单。 */
    const protoKeys = ["constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"];
    for (const k of protoKeys) {
      await openWith({ data:[row(k)] });
      const t = await hqText();
      /* 这里要看的是**他眼睛看得见的文字**，不是整页 HTML ——
         整页 HTML 连内联 <script> 一起算，会把源码注释里的例子也匹配上
         （本轮修后第一次跑就是这样假红的，量具的毛病，不是产品的）。 */
      const seen = await cdp.ev(`(()=>{const m=document.getElementById("main");
        return m ? (m.textContent||"") : "";})()`);
      ok("C0 status=\"" + k + "\" 算未知（不是合法状态）",
         /暂时无法获取总校确认进度/.test(t || ""), JSON.stringify(t));
      ok("C0b status=\"" + k + "\" 时他看不到任何函数源码",
         seen.indexOf("native code") < 0 && seen.indexOf("function ") < 0,
         JSON.stringify(seen.slice(0, 80)));
    }
    await openWith({ data:[row(123)] });
    ok("C1 status 不是字符串（数字）→ 未知",
       /暂时无法获取总校确认进度/.test(await hqText() || ""), JSON.stringify(await hqText()));
    await openWith({ data:[row({ pending: true })] });
    ok("C2 status 是对象 → 未知",
       /暂时无法获取总校确认进度/.test(await hqText() || ""), JSON.stringify(await hqText()));

    /* 字段类型错了也不能把整页炸掉：.trim 只能对字符串调。 */
    await openWith({ data:[row("approved", { applicant_visible_note: {} })] });
    const t1 = await hqText();
    ok("C3 备注是对象时，这一段照样渲染得出来（没有把申请页炸掉）",
       /总校确认已通过/.test(t1 || ""), JSON.stringify(t1));
    /* 必须先有这一段，否则「没出现 [object Object]」只是因为整页都没渲染出来（空过）。 */
    ok("C3b 而且不会把它显示成 [object Object]",
       !!t1 && !/\[object Object\]/.test(t1), JSON.stringify(t1));
    ok("C3c 整页也还在（状态徽章仍在）", (await badge()) === "已录取", JSON.stringify(await badge()));
    await openWith({ data:[row("approved", { applicant_visible_note: 123 })] });
    const t2 = await hqText();
    ok("C4 备注是数字时同样不崩，也不把 123 当成总校说明",
       /总校确认已通过/.test(t2 || "") && !/总校说明/.test(t2 || ""), JSON.stringify(t2));
    await openWith({ data:[row("approved", { confirmed_at: {} })] });
    ok("C5 时间字段是对象时不显示时间，也不写出 Invalid Date",
       /总校确认已通过/.test(await hqText() || "") &&
       !/Invalid Date/.test(await hqText() || ""), JSON.stringify(await hqText()));
  }

  if (RUN("F")) {
    console.log("\n=== F 按下重新读取之后他走开了：结果回来不能把焦点抢回去 ===");
    /* 与 teachers 页第九十七包 Ns5 同一条边界：捕获之后还要 await 读取，
       这段时间他完全可以走开。扣住读取，确定性造出「正在等」那一段。 */
    const outsideMain = async () => cdp.ev(`(()=>{const a=document.activeElement;
      const m=document.getElementById("main");
      if(!a || a===document.body) return { out:false, where:"BODY" };
      return { out: !!(m && !m.contains(a)), where:a.tagName,
               cls:(a.className||"").toString().slice(0,20),
               text:(a.textContent||"").replace(/\s+/g," ").trim().slice(0,18) };})()`);
    const tabToReload = async () => {
      for (let i = 1; i <= 60; i++) {
        await press("Tab");
        const on = await cdp.ev(`(()=>{const a=document.activeElement;
          return !!(a && a.hasAttribute && a.hasAttribute("data-hqreload"));})()`);
        if (on) return true;
      }
      return false;
    };
    await openWith({ data:null, error:{ message:"boom" }, status:500 });
    ok("F0 前提：这一次读失败了，页面上有「重新读取」",
       (await cdp.ev(`(()=>!!document.querySelector("[data-hqreload]"))()`)) === true);
    await cdp.ev(`(()=>{ window.__holdSelect = "application_hq_approvals";
      window.__SCEN.tables.application_hq_approvals = { data:[ ${JSON.stringify(row("approved"))} ] };
      return true; })()`);
    ok("F1 前提：真实 Tab 走到「重新读取」并按下", (await tabToReload()) === true);
    await press("Enter");
    ok("F2 前提：这次读取确实被扣住了（不是靠 sleep 赌）",
       await until(async () => cdp.ev(`(()=>!!window.__heldSelect)()`), 6000));
    const outHit = await (async () => {
      for (let i = 1; i <= 20; i++) { await press("Tab");
        const w = await outsideMain(); if (w.out) return w; }
      return null;
    })();
    ok("F3 前提：他趁这段时间真实 Tab 走到了 main 外面", !!outHit, JSON.stringify(outHit));
    await cdp.ev(`(()=>{ if(window.__releaseSelect) window.__releaseSelect(); return true; })()`);
    ok("F4 前提：结果回来了，这一段重画成了新结果",
       await until(async () => /总校确认已通过/.test(await hqText() || ""), 8000),
       JSON.stringify(await hqText()));
    const after = await outsideMain();
    ok("F5 焦点没有被抢回去 —— 他还站在刚才走到的那个地方",
       after.out === true && after.text === (outHit || {}).text, JSON.stringify({ outHit, after }));
    /* 正控：他**没有**走开时，重画之后焦点要回到这一段，不能掉进 body。 */
    await openWith({ data:null, error:{ message:"boom" }, status:500 });
    await cdp.ev(`(()=>{ window.__SCEN.tables.application_hq_approvals =
      { data:[ ${JSON.stringify(row("approved"))} ] }; return true; })()`);
    ok("F6 前提：又走到「重新读取」并按下", (await tabToReload()) === true);
    await press("Enter");
    await until(async () => /总校确认已通过/.test(await hqText() || ""), 8000);
    const stay = await cdp.ev(`(()=>{const a=document.activeElement;
      if(!a || a===document.body) return { where:"BODY" };
      const b=a.closest? a.closest("#hqBox"):null;
      return { where:a.tagName, inHq: !!b };})()`);
    ok("F7 他没走开时，重画之后焦点回到这一段（没掉进 body）",
       stay.where !== "BODY" && stay.inHq === true, JSON.stringify(stay));
  }

  if (RUN("N")) {
    console.log("\n=== N 已读状态也要给得出手动更新的入口（不做自动轮询）===");
    /* 原来只有「未知」那一支有按钮：他在「处理中」或「还没查到记录」时，
       想知道教务那边有没有新进展，只能整页刷新 —— 而整页刷新会把
       这一页上没保存的东西一起带走。这里补的是**手动**入口，不加轮询。 */
    const tabToReload2 = async () => {
      for (let i = 1; i <= 60; i++) {
        await press("Tab");
        const on = await cdp.ev(`(()=>{const a=document.activeElement;
          return !!(a && a.hasAttribute && a.hasAttribute("data-hqreload"));})()`);
        if (on) return true;
      }
      return false;
    };
    const btnLabel = async () => cdp.ev(`(()=>{const b=document.querySelector("[data-hqreload]");
      return b ? (b.textContent||"").trim() : null;})()`);

    // ── pending → approved
    await openWith({ data:[row("pending")] });
    ok("N0 前提：处理中这一状态也给得出入口", (await btnLabel()) === "更新进度",
       JSON.stringify(await btnLabel()));
    await cdp.ev(`(()=>{ window.__stayProbe = 1;
      window.__holdSelect = "application_hq_approvals";
      window.__SCEN.tables.application_hq_approvals = { data:[ ${JSON.stringify(row("approved"))} ] };
      return true; })()`);
    const n1 = await hqQueries();
    ok("N1 前提：真实 Tab 走到「更新进度」", (await tabToReload2()) === true);
    await press("Enter");
    ok("N2 前提：这次读取被扣住了", await until(async () => cdp.ev(`(()=>!!window.__heldSelect)()`), 6000));
    await press("Enter"); await press("Enter");        // 在途期间再按两下
    await sleep(600);
    ok("N3 连按也只发出**一笔**读取（在途锁挡住了后面的）",
       (await hqQueries()).length === n1.length + 1,
       "读取 " + n1.length + " → " + (await hqQueries()).length);
    await cdp.ev(`(()=>{ if(window.__releaseSelect) window.__releaseSelect(); return true; })()`);
    ok("N4 放行之后显示的是新进展：处理中 → 已通过",
       await until(async () => /总校确认已通过/.test(await hqText() || ""), 8000),
       JSON.stringify(await hqText()));
    ok("N5 而且没有整页刷新（页面上那个记号还在）",
       (await cdp.ev(`(typeof window.__stayProbe !== "undefined")`)) === true);
    ok("N6 全程没有任何写入", (await writes()).length === 0, JSON.stringify(await writes()));

    // ── 空记录 → pending
    await openWith({ data: [] });
    ok("N7 前提：「当前未查询到记录」这一状态也给得出入口",
       (await btnLabel()) === "更新进度" &&
       /当前未查询到总校确认记录/.test(await hqText() || ""), JSON.stringify(await hqText()));
    await cdp.ev(`(()=>{ window.__SCEN.tables.application_hq_approvals =
      { data:[ ${JSON.stringify(row("pending"))} ] }; return true; })()`);
    ok("N8 前提：走到入口并按下", (await tabToReload2()) === true);
    await press("Enter");
    ok("N9 空记录 → 处理中，更新得出来",
       await until(async () => /总校确认处理中/.test(await hqText() || ""), 8000),
       JSON.stringify(await hqText()));

    // ── 更新时读失败：诚实说未知，而且还能再试
    await openWith({ data:[row("pending")] });
    await cdp.ev(`(()=>{ window.__SCEN.tables.application_hq_approvals =
      { data:null, error:{ message:"boom" }, status:500 }; return true; })()`);
    ok("N10 前提：走到入口并按下", (await tabToReload2()) === true);
    await press("Enter");
    ok("N11 这一次读失败 → 诚实说「暂时无法获取总校确认进度」，不留在旧结论上",
       await until(async () => /暂时无法获取总校确认进度/.test(await hqText() || ""), 8000) &&
       !/处理中|已通过|未通过/.test(await hqText() || ""), JSON.stringify(await hqText()));
    ok("N12 而且还给得出下一次的入口", (await btnLabel()) === "重新读取",
       JSON.stringify(await btnLabel()));
    await cdp.ev(`(()=>{ window.__SCEN.tables.application_hq_approvals =
      { data:[ ${JSON.stringify(row("rejected"))} ] }; return true; })()`);
    ok("N13 前提：再走到入口按下", (await tabToReload2()) === true);
    await press("Enter");
    ok("N14 再试一次就读到了（失败不是死路）",
       await until(async () => /总校确认未通过/.test(await hqText() || ""), 8000),
       JSON.stringify(await hqText()));
    ok("N15 到这里为止仍然零写入", (await writes()).length === 0, JSON.stringify(await writes()));
  }

  if (RUN("Dc")) {
    // ════════ Dc 把验收清单 3.4 的依据钉到源码上，免得文档再悄悄漂移 ════════
    console.log("\n=== Dc 3.4 的依据：契约与前端说的是不是同一件事 ===");
    /* 这一组是**源码/契约一致性检查**，不是浏览器行为检查 —— 如实标明。
       起因：event7d09-web-acceptance-checklist.md 的 3.4 长期写着
       「🔴 未实现：application_hq_approvals 只有管理员可读，申请人侧没有可读来源；
         要做必须新增服务端读取路径并 apply（同 U7）」。
       按当前源码，这三句话都不成立。把依据钉成断言，下次谁改了哪一边都会当场红。 */
    const SRC = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
    const sql12 = SRC("supabase/migrations/0012_student_core.sql");
    const appSrc = SRC("portal/applicant/application/index.html");

    ok("Dc1 RLS 明确让申请人读**自己那一行**（不是「只有管理员可读」）",
       /create policy hq_appr_select[\s\S]{0,400}?a\.applicant_id = auth\.uid\(\)/.test(sql12));
    ok("Dc2 被 revoke 的只有写（insert/update/delete），select 没被收走",
       /revoke insert, update, delete on public\.application_hq_approvals/.test(sql12) &&
       !/revoke[^\n]*select[^\n]*application_hq_approvals/.test(sql12));
    ok("Dc3 内部备注在**另一张表**，申请人无可读路径",
       /create table if not exists public\.hq_approval_internal/.test(sql12) &&
       /create policy hq_internal_select on public\.hq_approval_internal/.test(sql12));
    ok("Dc4 前端**已经**有读取与渲染（不是「未实现」）",
       /async function loadHq\(/.test(appSrc) && /function renderHq\(/.test(appSrc));

    const sqlEnum = ((sql12.match(/create type hq_approval_status as enum \(([^)]*)\)/) || [])[1] || "");
    const SQLK = [...sqlEnum.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
    const feKeys = ((appSrc.match(/const HQ_KEYS = \[([^\]]*)\]/) || [])[1] || "");
    const FEK = [...feKeys.matchAll(/"([a-z_]+)"/g)].map(m => m[1]).sort();
    ok("Dc5 前提：两边的状态集都读得到（非空过）",
       SQLK.length === 3 && FEK.length === 3, JSON.stringify({ SQLK, FEK }));
    ok("Dc6 前端白名单与契约枚举**一字不差**",
       JSON.stringify(SQLK) === JSON.stringify(FEK), JSON.stringify({ SQLK, FEK }));

    /* 这一条守的是**边界**，不是功能：源码这么写 ≠ 线上授权已验证。
       报告与清单都不得据此写成「已验收」。 */
    ok("Dc7 探针自己也把这条边界打在结果里（B3 未解除）",
       /不等于线上授权已验证/.test(SRC("scripts/test-applicant-hq-progress.mjs")));
  }

  if (RUN("G")) {
    console.log("\n=== G 外发 ===");
    ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");
    ok("G2 全程没有调用任何 Edge Function", edgeCalls.length === 0, JSON.stringify(edgeCalls.slice(0, 2)));
    ok("G3 全程没有页面异常", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
  }
  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。");
console.log("  源码里 RLS 允许申请人读自己那一行，**不等于线上授权已验证**（B3 未解除）。");
process.exit(fail ? 1 : 0);
