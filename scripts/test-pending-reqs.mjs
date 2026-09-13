// 定向复现：提交被 requirements_pending 挡回来时，那条提示的**数目契约**。
//
// 服务端回的是 { ok:false, error:'requirements_pending', count:N }，
// 而页面手里另有一份自己读到的补件清单。两边可能对不上，四种都要说对：
//   相等 / 本地少于服务端 / 本地多于服务端 / 数目根本不知道（缺失·null·非整数）。
// 判据只有一条：**服务端的数目是准的，这一页的清单不一定是** ——
// 对不上就说清楚，并指向刷新重新读取，不假称完整准确。
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
      getSession: function(){ var u = (window.__SCEN && window.__SCEN.uid) || "u-appl";
        return reply({ data:{ session:{ user:{ id:u }, access_token:"fixture-token" } }, error:null }); },
      signOut: function(){ return reply({}); },
      mfa: { getAuthenticatorAssuranceLevel: function(){ return reply({ data:{ currentLevel:"aal1", nextLevel:"aal1" }, error:null }); } },
      onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; }
    },
    from: table,
    rpc: function(name){
      if (name === "my_roles") return reply({ data:[{ role:"applicant" }], error:null, status:200 });
      if (name === "my_profile") return reply({ data:{ display_name:"测试申请人", email:"a@example.invalid" }, error:null, status:200 });
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
      if (/\/login\//.test(u)) loginHits++;            // 重新载入不会请求 /login/
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });
  let pageErrors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    pageErrors.push(String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || "").slice(0, 200));
  });
  cdp.on("Page.javascriptDialogOpening", async () => {
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

  /* 一份固定的本地清单：2 条未完成 + 1 条已完成。
     服务端的 count 在各用例里变，用来构造四种契约。 */
  const REQS = [
    { id:"rq-1", label:"受洗证明扫描件", detail:"教会盖章那一页", resolved:false, created_at:"2026-09-01T00:00:00Z" },
    { id:"rq-2", label:"最高学历证书", detail:null, resolved:false, created_at:"2026-09-01T00:00:00Z" },
    { id:"rq-3", label:"近期证件照", detail:null, resolved:true, created_at:"2026-09-01T00:00:00Z" },
  ];
  const NEEDS = { ...DRAFT, status:"needs_information",
    locked_fields:["name_zh","birth_ym","gender","nationality","conversion_date","programs"] };
  const openPending = async (count, reqRows) => {
    await open({ write: OKW,
      tables: { ...TABLES, application_requirements: reqRows || { data: REQS } },
      rpc: { my_application: { data:[NEEDS] },
             submit_application: { data: { ok:false, error:"requirements_pending", count } } } });
    await cdp.ev(`(()=>{const b=document.getElementById("btnSubmit"); if(b) b.click(); return !!b;})()`);
    await sleep(1500);
  };
  const errText = async () => cdp.ev(`(()=>{const e=document.getElementById("subErr");
    return e ? (e.textContent||"").replace(/\s+/g," ").trim() : null;})()`);
  const hasReload = async () => cdp.ev(`!!document.querySelector("#subErr [data-reqreload]")`);

  console.log("\n=== Q1 相等：服务端 2、本地 2 条未完成 ===");
  await openPending(2);
  const q1 = await errText();
  ok("Q1a 说 2 项，并逐项列出", /还有\s*2\s*项/.test(q1 || "") &&
     /受洗证明扫描件/.test(q1 || "") && /最高学历证书/.test(q1 || ""), JSON.stringify(q1));
  ok("Q1b 对得上就不要无端说「可能不是最新的」", !/可能不是最新|重新读取/.test(q1 || ""), JSON.stringify(q1));
  ok("Q1c 也不该给刷新按钮（没有不同步）", (await hasReload()) === false);

  console.log("\n=== Q2 本地少于服务端：服务端 3、本地 2 ===");
  await openPending(3);
  const q2 = await errText();
  ok("Q2a 数目以服务端为准（3）", /还有\s*3\s*项/.test(q2 || ""), JSON.stringify(q2));
  ok("Q2b 说清楚还有 1 项没读到，并指向刷新重新读取",
     /还有\s*1\s*项.*没能读到|没能读到.*1\s*项/.test(q2 || "") && /重新读取/.test(q2 || ""), JSON.stringify(q2));
  ok("Q2c 给得出刷新入口", (await hasReload()) === true);

  console.log("\n=== Q3 本地多于服务端：服务端 1、本地 2（监督反例）===");
  await openPending(1);
  const q3 = await errText();
  ok("Q3a 数目仍以服务端为准（1）", /还有\s*1\s*项/.test(q3 || ""), JSON.stringify(q3));
  ok("Q3b 列出的清单标明可能不是最新的",
     /可能不是最新/.test(q3 || ""), JSON.stringify(q3));
  ok("Q3c 说清楚这一页比服务端多 1 项、多出来的可能是旧条目",
     /多\s*1\s*项/.test(q3 || "") && /已经完成|撤下|旧条目/.test(q3 || ""), JSON.stringify(q3));
  ok("Q3d 并指向刷新重新读取", /重新读取/.test(q3 || "") && (await hasReload()) === true, JSON.stringify(q3));

  console.log("\n=== Q4 数目不知道：null / 缺失 / 非整数 ===");
  for (const [tag, c] of [["null", null], ["缺失", undefined], ["小数", 1.5], ["字符串", "2"], ["布尔", true]]) {
    await openPending(c);
    const q4 = await errText();
    ok(`Q4-${tag} 不把读不到的数目说成 0（也不编一个数）`,
       !/还有\s*0\s*项/.test(q4 || "") && !/服务端说还有/.test(q4 || ""), JSON.stringify(q4));
    ok(`Q4-${tag} 如实说不知道还剩几项，并指向刷新重新读取`,
       /没能确认还剩几项/.test(q4 || "") && (await hasReload()) === true, JSON.stringify(q4));
  }

  console.log("\n=== Q5 对照：清单一条也读不到 ===");
  await openPending(2, { data:null, error:{ message:"boom" }, status:500 });
  const q5 = await errText();
  ok("Q5a 数目照说（2），但不编条目",
     /还有\s*2\s*项/.test(q5 || "") && !/受洗证明扫描件/.test(q5 || ""), JSON.stringify(q5));
  ok("Q5b 说清楚没读到具体是哪几项并指向刷新",
     /没能读到具体是哪几项/.test(q5 || "") && (await hasReload()) === true, JSON.stringify(q5));

  console.log("\n=== R 「刷新重新读取」这个入口本身会不会弄丢他的编辑 ===");
  /* 上一包给不同步的情形加了这个按钮，回调直接 location.reload()。
     可他是在**提交被挡回来之后**看到它的 —— 那时候他很可能正接着改。
     共享层 UI.formGuard 只在 beforeunload 弹一句「确定离开？」；
     离开守卫会在 pagehide 暂存，但**存储被拒时那条路是空的** ——
     页面上这一份就是唯一的一份，一重载就没了。 */
  const typeCalling = async (v) => cdp.ev(`(()=>{const el=document.getElementById("fd-calling");
    if(!el) return false; el.focus(); el.value=${JSON.stringify(v)};
    el.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
  const goStep4 = async () => { await cdp.ev(`(()=>{const t=document.querySelector('[data-step="3"]');
    if(t) t.click(); return !!t;})()`); await sleep(350); };
  const clickReload = async () => cdp.ev(`(()=>{const b=document.querySelector("#subErr [data-reqreload]");
    if(b) b.click(); return !!b;})()`);
  const reqCard = async () => cdp.ev(`(()=>{const c=document.querySelector(".rqlist");
    return c ? (c.textContent||"").replace(/\s+/g," ").trim() : null;})()`);

  // 存储被拒 + 未保存编辑 + 点这个刷新入口
  await openPending(1);                                // 多于 → 会出现刷新按钮
  await denyStorage();
  await goStep4();
  await typeCalling("提交被挡之后又写的一段");
  await sleep(150);                                    // 防抖没到，只有他自己手里这一份
  await probeSet();
  ok("R0 前提：刷新入口在", (await clickReload()) === true);
  await sleep(1600);
  ok("R1 页面没有被重载（他那一份是唯一的副本）", (await probeGone()) === false);
  ok("R2 他写的那一段还在", (await callingVal()) === "提交被挡之后又写的一段", JSON.stringify(await callingVal()));

  // 读取成功：清单真的换成新的
  await openPending(1);
  await goStep4();
  await typeCalling("读取成功这一场");
  await cdp.ev(`(()=>{ window.__SCEN.tables.application_requirements =
    { data:[{ id:"rq-9", label:"新读到的条目", detail:null, resolved:false, created_at:"2026-09-02T00:00:00Z" }] };
    return true;})()`);
  await probeSet();
  await clickReload();
  await sleep(1600);
  ok("R3 清单换成了重新读到的那一份",
     /新读到的条目/.test((await reqCard()) || "") && !/受洗证明扫描件/.test((await reqCard()) || ""),
     JSON.stringify(await reqCard()));
  ok("R4 编辑仍在，页面也没重载",
     (await callingVal()) === "读取成功这一场" && (await probeGone()) === false,
     JSON.stringify(await callingVal()));
  ok("R5 说清楚是刚刚重新读到的，且不谎称已保存",
     /重新读(取|到|过)/.test((await errText()) || "") && !/已保存/.test((await errText()) || ""),
     JSON.stringify(await errText()));

  // 读取失败：不许假装是最新的
  await openPending(1);
  await goStep4();
  await typeCalling("读取失败这一场");
  await cdp.ev(`(()=>{ window.__SCEN.tables.application_requirements =
    { data:null, error:{ message:"boom" }, status:500 }; return true;})()`);
  await probeSet();
  await clickReload();
  await sleep(1600);
  ok("R6 读失败时如实说没能重新读到，不假称最新",
     /没能重新读到|没能读到/.test((await errText()) || "") && !/已经是最新|最新的了/.test((await errText()) || ""),
     JSON.stringify(await errText()));
  ok("R7 读失败也不许把他的编辑弄丢，页面也没重载",
     (await callingVal()) === "读取失败这一场" && (await probeGone()) === false,
     JSON.stringify(await callingVal()));

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
