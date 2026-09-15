// 定向复现：**普通离开**这条路上的「不丢用户输入」（web-acceptance-path.md §1）。
//
// 共享层已经有 UI.formGuard（beforeunload，dirty 时弹浏览器的「确定离开？」），
// 申请页 bindEditor() 里在用。所以**提醒**这一半是有的。
// 本探针要证的是另一半：他点了「离开」之后，那一份唯一的编辑还在不在 ——
// 三种时点都要看：未到 800ms 防抖 / 保存还在途 / 保存失败。
//
// 这是**定向探针**，不是申请人写入全套的复刻：fixture 只给这条路需要的返回值。
// 本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。独占动态端口。
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

  /* 三个时点 × 「点导航回首页」这条普通离开路径。
     离开之后再回到申请页：他那一份还救得回来吗？ */
  const LEAVE = [
    { tag: "d", name: "未到 800ms 防抖", scen: { write: OKW }, wait: 150 },
    { tag: "f", name: "保存还在途",     scen: { write: OKW, hold: true }, wait: 1000 },
    /* 401 这一格其实早就被「登录过期」那条路覆盖了（showExpired 会暂存）——
       它在修前就是绿的，留着当对照。真正代表「保存失败」的是下面这一格。 */
    { tag: "x", name: "保存失败（401，登录过期已覆盖）", scen: { write: EXPIRED }, wait: 1300 },
    { tag: "z", name: "保存失败（403 明确被拒）", scen: { write: DENIED }, wait: 1300 },
  ];
  for (const L of LEAVE) {
    console.log(`\n=== N${L.tag} ${L.name}：点导航回首页再回来 ===`);
    await open(L.scen);
    await goStep(3);
    ok(`N${L.tag}0 前提：表单渲染出来了`, (await cdp.ev(`!!document.getElementById("fd-calling")`)) === true);
    await type(`唯一的一份：${L.name}`);
    await sleep(L.wait);
    ok(`N${L.tag}1 前提：点到了导航「首页」`, (await clickNav("首页")) === true);
    await sleep(1800);
    ok(`N${L.tag}2 前提：人确实离开了申请页`,
       /\/portal\/applicant\/?$/.test(await cdp.ev(`location.pathname`)), await cdp.ev(`location.pathname`));
    await backToApp();
    ok(`N${L.tag}3 回来之后救得回来（给出「恢复我的编辑」）`,
       /恢复我的编辑/.test((await restoreBox()) || ""), JSON.stringify(await restoreBox()));
    await clickText2("/恢复我的编辑/");
    await sleep(600);
    await goStep(3);
    ok(`N${L.tag}4 恢复出来的就是他最后写的那一份`,
       (await callingVal()) === `唯一的一份：${L.name}`, JSON.stringify(await callingVal()));
  }

  console.log("\n=== Nr 刷新离开 ===");
  await open({ write: OKW });
  await goStep(3);
  await type("刷新前写的");
  await sleep(150);                                    // 防抖还没到
  await cdp.send("Page.reload");
  await sleep(2800);
  ok("Nr1 刷新之后救得回来", /恢复我的编辑/.test((await restoreBox()) || ""), JSON.stringify(await restoreBox()));
  await clickText2("/恢复我的编辑/");
  await sleep(600);
  await goStep(3);
  ok("Nr2 恢复的是最后那一份", (await callingVal()) === "刷新前写的", JSON.stringify(await callingVal()));

  console.log("\n=== Nk 对照：不该救的别救 ===");
  await open({ write: OKW });
  await goStep(3);
  await type("这一笔存成功了");
  await sleep(1400);                                   // 写入成功 → dirty 清掉
  ok("Nk0 前提：确实已保存", /已保存/.test((await cdp.ev(`(()=>{const e=document.getElementById("saveState");
     return e?e.textContent:null;})()`)) || ""), JSON.stringify(await cdp.ev(`(()=>{const e=document.getElementById("saveState"); return e?e.textContent:null;})()`)));
  await clickNav("首页");
  await sleep(1800);
  await backToApp();
  ok("Nk1 已保存的正常导航，回来不该冒出恢复提示", (await restoreBox()) === null, JSON.stringify(await restoreBox()));

  /* 他自己选了「直接重新载入（丢弃我的编辑）」，守卫不能把它又塞回来。 */
  await open({ write: CONFLICT });
  await goStep(3);
  await type("这一笔他要丢掉");
  await sleep(1300);                                   // 0 行 → 冲突框
  ok("Nk2 前提：冲突框出来了", /在别处被改过/.test((await cdp.ev(`(()=>{const b=document.getElementById("conflictBox");
     return b?(b.textContent||""):null;})()`)) || ""));
  await clickText2("/直接重新载入（丢弃我的编辑）/");
  await sleep(2800);
  ok("Nk3 他明确丢弃之后，不该再被恢复出来", (await restoreBox()) === null, JSON.stringify(await restoreBox()));

  /* 身份隔离：**带着上一个人的草稿**切换身份。 */
  await open({ write: EXPIRED });
  await goStep(3);
  await type("张三写的见证");
  await sleep(150);
  await clickNav("首页");
  await sleep(1800);
  const zhang = await stashNow();
  ok("Nk4-0 前提：上一个人的草稿确实躺在这个标签页里",
     !!zhang && zhang.indexOf("张三写的见证") > -1, JSON.stringify(zhang && zhang.slice(0, 70)));
  await open({ write: EXPIRED, uid: "u-someone-else" }, { keepStash: true });
  ok("Nk4 换一个账号不恢复", (await restoreBox()) === null, JSON.stringify(await restoreBox()));
  await goStep(3);
  ok("Nk4b 页面上任何地方都看不到上一个人的内容",
     !/张三写的见证/.test(await pageText()) && !/张三写的见证/.test(await formDump()),
     JSON.stringify((await formDump() || "").slice(0, 120)));
  const still = await stashNow();
  ok("Nk4c 那份草稿的身份字段仍是原主人（新身份没有把它据为己有）",
     !!still && JSON.parse(still).uid === "u-appl", JSON.stringify(still && JSON.parse(still).uid));

  console.log("\n=== Nq 主动退出：清理过的东西不许被离开守卫写回来 ===");
  /* auth.js 的 signOut() 先清掉所有 amas.*，再跳转 —— 而跳转会触发 pagehide。 */
  await open({ write: EXPIRED });
  await goStep(3);
  await type("退出前写的一段");
  await sleep(150);                                    // 防抖还没到：只有离开守卫会写
  ok("Nq0 前提：调得到真实前端的退出（本地 stub 的会话）",
     (await cdp.ev(`(()=>{ if(!window.AmasAuth || !AmasAuth.signOut) return false;
        AmasAuth.signOut(); return true; })()`)) === true);
  await sleep(2200);
  ok("Nq1 退出之后 sessionStorage 里没有申请草稿",
     (await stashNow()) === null, JSON.stringify((await stashNow() || "").slice(0, 90)));

  await open({ write: EXPIRED });
  await goStep(3);
  await type("这一笔已经暂存过了");
  await sleep(1300);                                   // 401 → showExpired 已经暂存
  ok("Nq2-0 前提：退出之前它确实在", !!(await stashNow()));
  await cdp.ev(`(()=>{ AmasAuth.signOut(); return true; })()`);
  await sleep(2200);
  ok("Nq2 退出会把它清掉，且离开守卫不会再写回来",
     (await stashNow()) === null, JSON.stringify((await stashNow() || "").slice(0, 90)));

  /* 存储被拒：救不回来就别装作救得回来。 */
  await open({ write: OKW });
  await goStep(3);
  await denyStorage();
  await type("存不下的那一份");
  await sleep(150);
  await clickNav("首页");
  await sleep(1800);
  await backToApp();
  ok("Nk5 存储被拒时不谎称已暂存（回来没有恢复提示）", (await restoreBox()) === null, JSON.stringify(await restoreBox()));

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
