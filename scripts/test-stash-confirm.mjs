// 定向复现：存不下草稿时那个「我已复制，…」的确认按钮。
//
// 要证明的一条：**确认的是他复制走的那一份**。
// 他在复制之后、点确认之前完全可能又改一笔（自动保存 800ms 防抖还没到点），
// 那一笔既没存下、也不在他复制走的文本里 —— 就这么放行，等于让他拿一份
// 过期的导出确认离开。两个入口都要覆盖：登录过期（去重新登录）与冲突（重新载入）。
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
        var t = (mode === "select") ? ((sc.tables && sc.tables[name]) || { data:[], error:null })
                                    : (sc.write || { data:[{ id:"app-fx", updated_at:"2026-09-10T00:00:01Z" }], error:null });
        return Promise.resolve({ data:t.data, error:t.error||null,
          status: t.status != null ? t.status : (t.error ? 500 : 200) }).then(res, rej);
      } };
    return q;
  }
  return {
    auth: {
      getSession: function(){ return reply({ data:{ session:{ user:{ id:"u-appl" }, access_token:"fixture-token" } }, error:null }); },
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

  const open = async (write) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source:
      "window.__SCEN = " + JSON.stringify({ tables: TABLES, rpc: { my_application: { data:[DRAFT] } }, write }) + ";" });
    await cdp.send("Page.navigate", { url: `${BASE}/portal/applicant/application/` });
    await sleep(2800);
  };
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

  /* 最小矩阵：两个时序（立即确认 / 等自动保存失败重画之后）× 两个入口
     （登录过期 → 去重新登录；冲突 → 重新载入）＋「没改就正常离开」。
     再加一格 pathway —— 它不在 form_data 里，必须也算进「改了没有」。 */
  const ENTRIES = [
    { name: "登录过期", write: EXPIRED, act: "我已复制，去重新登录", login: true,
      toBox: async () => {} },                       // 401 自己就会弹出来
    { name: "冲突重载", write: CONFLICT, act: "我已复制，重新载入", login: false,
      toBox: async () => { await clickText("/保留我的编辑并重新载入/"); await sleep(600); } },
  ];

  for (const E of ENTRIES) {
    const tag = E.login ? "L" : "C";
    console.log(`\n=== ${tag} ${E.name}：确认的必须是他复制走的那一份 ===`);

    for (const mode of ["立即", "等自动保存失败重画之后"]) {
      const m = mode === "立即" ? "i" : "w";
      await open(E.write);
      await goStep(3);
      ok(`${tag}${m}0 前提：表单渲染出来了（不是停在降级页上）`,
         (await cdp.ev(`!!document.getElementById("fd-calling")`)) === true);
      await denyStorage();
      await type("第一版");
      await sleep(1300);
      await E.toBox();
      ok(`${tag}${m}1 前提：复制框在，动作是「${E.act}」`,
         (await btnLabel()) === E.act, JSON.stringify(await btnLabel()));

      await type("第二版：复制之后又改的");
      /* 立即 = 防抖还没到点；等待 = 让自动保存失败一次、把框重画一遍。
         重画那一次**不能**把确认基准推到最新 —— 那正是上一版的绕过口。 */
      await sleep(mode === "立即" ? 150 : 1400);
      if (mode !== "立即") {
        ok(`${tag}${m}2 重画之后导出已是最新，并提示要重新复制`,
           (await taText() || "").indexOf("第二版：复制之后又改的") > -1 &&
           /又改了内容|重新复制/.test((await boxText()) || ""),
           JSON.stringify([(await taText() || "").slice(0, 40), (await boxText() || "").slice(0, 60)]));
      }
      await probeSet();
      const lh = loginHits;
      await clickConfirm();                          // 他**没有**重新复制
      await sleep(900);
      ok(`${tag}${m}3 没重新复制就确认 —— 不放行，留在这一页`,
         (await probeGone()) === false);
      ok(`${tag}${m}4 也确实没有走掉（登录那条路没被请求）`,
         loginHits === lh, "loginHits " + lh + " → " + loginHits);
      ok(`${tag}${m}5 导出是最新那一份，并明确请他重新复制`,
         (await taText() || "").indexOf("第二版：复制之后又改的") > -1 &&
         /又改了内容|重新复制/.test((await boxText()) || ""),
         JSON.stringify((await boxText() || "").slice(0, 80)));
      await clickConfirm();                          // 复制过了，期间没再改 → 该放行
      await sleep(1400);
      ok(`${tag}${m}6 再确认一次（期间没再改）才允许离开`, (await probeGone()) === true);
      ok(`${tag}${m}7 走的是这条路自己的动作`,
         E.login ? loginHits > lh : loginHits === lh, "loginHits " + lh + " → " + loginHits);
    }

    // 对照：没改过就正常离开，别把人锁在页面上
    await open(E.write);
    await goStep(3);
    await denyStorage();
    await type("只写这一次");
    await sleep(1300);
    await E.toBox();
    await probeSet();
    const lh2 = loginHits;
    await clickConfirm();
    await sleep(1400);
    ok(`${tag}n1 对照：没改过的时候，确认一次就能正常离开`, (await probeGone()) === true);
    ok(`${tag}n2 对照：走的还是这条路自己的动作`,
       E.login ? loginHits > lh2 : loginHits === lh2, "loginHits " + lh2 + " → " + loginHits);
  }

  // ════════ P 学习路径不在 form_data 里，也得算「改了」 ════════
  console.log("\n=== P pathway 也算 ===");
  await open(EXPIRED);
  await goStep(3);
  await denyStorage();
  await type("路径这一组");
  await sleep(1300);
  ok("P0 前提：复制框在", !!(await taText()));
  const flipped = await cdp.ev(`(()=>{const r=[...document.querySelectorAll('input[name="pathway"]')]
    .filter(x=>!x.disabled && !x.checked)[0]; if(!r) return null; r.click(); return r.value;})()`);
  if (flipped === null) {
    console.log("  SKIP  P1 这一版表单里没有可切换的学习路径选项（未断言）");
  } else {
    await sleep(200);
    await probeSet();
    const lhP = loginHits;
    await clickConfirm();
    await sleep(900);
    ok("P1 只改了学习路径，同样不放行", (await probeGone()) === false && loginHits === lhP, "flipped=" + flipped);
    ok("P2 导出里带上了新的 pathway",
       (await taText() || "").indexOf("pathway: " + flipped) > -1,
       JSON.stringify((await taText() || "").slice(-60)));
  }

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
