// portal/admin/（总览页）自己带着两条不可逆写入，而完整防护只做在
// portal/admin/teachers/ 那一页 —— 同一个动作，两页待遇不同。
//
//   ① 生成教师邀请 create-teacher-invitation
//        if (r.status !== 200) { … err = "创建失败。" }
//      status 0（回执丢了）或 5xx 时，邀请**可能已经建出来了**（一条 token
//      记录 + 审计）。说成「创建失败」，管理员就会再建一份 —— 两份邀请，
//      而第一份的 token 还活着、没人管。
//      另外成功分支直接读 r.data.link：200 但网关返回 HTML 时 r.data 是 null，
//      这一行直接抛 TypeError。
//
//   ② 教师审核 review-teacher-verification
//        b.disabled = false;                  // ← 先把按钮放开
//        if (r.status !== 200) { alert("操作失败。") }
//      与 ① 同理，而且这是不可逆动作、写审计记录。
//      teachers 页对同一个 Edge Function 早就分好了「确定没执行」与
//      「结果不明」，这里一条都没有。
//
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
  ".css":"text/css; charset=utf-8", ".png":"image/png", ".webp":"image/webp",
  ".svg":"image/svg+xml", ".ico":"image/x-icon", ".woff2":"font/woff2" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
                       "Cache-Control":"no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-adminov-"));
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
  throw new Error("没能从自己的 Chrome 取得独占调试端口；本套件不附着现成 Chrome，退出。");
}

let externalHits = 0;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  on(m, f) { this.handlers.set(m, f); }
  static async attach(port) {
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
  send(method, params = {}, ms = 30000) {
    return new Promise((res, rej) => { const i = ++this.id;
      const t = setTimeout(() => { if (this.pending.delete(i)) rej(new Error("TIMEOUT " + method)); }, ms);
      this.pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async ev(x) {
    const r = await this.send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval 抛错: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  }
  async clickReal(sel) {
    const pt = await this.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return null; el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,ok:!!hit&&(hit===el||el.contains(hit)||hit.contains(el))};})()`);
    if (!pt) throw new Error("找不到 " + sel);
    if (!pt.ok) throw new Error("点没命中 " + sel);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await sleep(340);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';

const STUB = `
window.supabase = {
  createClient: function(){
    var S = function(){ return window.__SCEN || {}; };
    var reply = function(v){ return Promise.resolve(v); };
    function table(name){
      var q = { select:function(){return q;}, eq:function(){return q;}, in:function(){return q;},
        order:function(){return q;}, range:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
        then:function(res, rej){
          var t = (S().tables && S().tables[name]) || { data: [], error: null };
          return Promise.resolve({ data:t.data, error:t.error||null, status:t.error?500:200 }).then(res, rej);
        } };
      return q;
    }
    return {
      auth: {
        getSession: function(){ return reply({ data:{ session:{ user:{id:"u-admin"}, access_token:"fixture-token" } }, error:null }); },
        mfa: { getAuthenticatorAssuranceLevel: function(){
          return reply({ data:{ currentLevel:"aal2", nextLevel:"aal2" }, error:null }); } },
        onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
        signOut: function(){ return reply({}); }
      },
      from: table,
      rpc: function(name){
        if (name === "my_roles") return reply({ data:[{ role:"super_admin" }], error:null, status:200 });
        if (name === "my_profile") return reply({ data:{ display_name:"测试教务", email:"a@example.invalid" }, error:null, status:200 });
        return reply({ data:null, error:null, status:200 });
      },
      functions: { invoke: function(){ return reply({ data:null, error:null }); } }
    };
  }
};`;

let port;
try { port = await ownDebugPort(); console.log("  独占调试端口（本进程自己的 Chrome）: " + port); }
catch (e) { chrome.kill(); server.close(); console.error("  " + e.message); process.exit(1); }

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("cdn.jsdelivr.net") > -1 && u.indexOf("supabase-js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name:"Content-Type", value:"application/javascript" },
                            { name:"Cache-Control", value:"no-store" }], body: b64(STUB) }); return;
      }
      if (u.indexOf("supabase-config.js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name:"Content-Type", value:"application/javascript" },
                            { name:"Cache-Control", value:"no-store" }], body: b64(CFG) }); return;
      }
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });

  /* 这一页用的是原生 prompt/confirm，全部自动接受，否则导航与点击都会卡住。 */
  /* 审核那一支把错误交给原生 alert()，所以对话框文本要收下来，
     否则自动接受之后什么证据都不剩，断言会读到空字符串变成空转。 */
  let dialogs = [];
  cdp.on("Page.javascriptDialogOpening", async (p) => {
    if (p && p.type === "alert") dialogs.push(String(p.message || ""));
    try { await cdp.send("Page.handleJavaScriptDialog", { accept: true, promptText: "FIXTURE" }); } catch (e) {}
  });

  let pageErrors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    pageErrors.push(String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || ""));
  });

  /** kind: ok | throw | http500 | html | refuse:<code> */
  const installFetch = async (kind) => cdp.ev(`(()=>{
    window.__fnHits = 0;
    const orig = window.fetch;
    window.fetch = function(u){
      if (String(u).indexOf("/functions/v1/") < 0) return orig.apply(this, arguments);
      window.__fnHits++;
      const k = ${JSON.stringify(kind)};
      if (k === "throw")   return Promise.reject(new TypeError("Failed to fetch"));
      if (k === "http500") return Promise.resolve(new Response(JSON.stringify({}), { status:500,
                                headers:{ "Content-Type":"application/json" } }));
      if (k === "html")    return Promise.resolve(new Response("<html>502</html>", { status:200,
                                headers:{ "Content-Type":"text/html" } }));
      if (k === "malformed") return Promise.resolve(new Response(JSON.stringify({}), { status:200,
                                headers:{ "Content-Type":"application/json" } }));
      if (k.indexOf("refuse:") === 0)
        return Promise.resolve(new Response(JSON.stringify({ error:k.slice(7) }),
               { status:403, headers:{ "Content-Type":"application/json" } }));
      return Promise.resolve(new Response(JSON.stringify({ link:"https://example.invalid/fixture",
             token:"FIXTURE-TOKEN", expires_at:"2026-10-01T00:00:00Z" }),
             { status:200, headers:{ "Content-Type":"application/json" } }));
    };
    return true;})()`);
  const fnHits = async () => cdp.ev(`window.__fnHits || 0`);

  const REQ = [{ id:"req-fixture-1", user_id:"u-t1", status:"submitted",
    submitted_data:{ name:"测试教师", organization:"测试机构", teaching_areas:"旧约", phone:"0000" },
    submitted_at:"2026-09-01T00:00:00Z", reviewed_at:null,
    profiles:{ display_name:"测试教师", email:"t@example.invalid" } }];
  const TABLES = { teacher_verification_requests: { data: REQ } };

  let nav = 0;
  const open = async (scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(scen) + ";" });
    pageErrors = []; dialogs = [];
    await cdp.send("Page.navigate", { url: `${BASE}/portal/admin/?r=${++nav}` });
    await sleep(wait || 3000);
  };
  const invState = async () => cdp.ev(`(()=>{
    const e=document.getElementById("ivErr"), b=document.getElementById("btnInv");
    const o=document.getElementById("ivOut");
    return { err:e?(e.textContent||"").trim():null, errShown:!!(e&&e.classList.contains("show")),
             btnDisabled:!!(b&&b.disabled), outHidden:!o||o.hidden };})()`);
  const sendInvite = async () => {
    await cdp.ev(`(()=>{document.getElementById("ivEmail").value="t@example.invalid";
      document.getElementById("ivName").value="测试教师"; return true;})()`);
    await cdp.clickReal("#btnInv");
    await sleep(1600);
  };

  // ════════ I 生成教师邀请 ════════
  console.log("\n=== I 生成教师邀请 ===");
  await open({ tables: TABLES });
  ok("I0 前提：总览页进得去且有邀请表单",
     (await cdp.ev(`!!document.getElementById("btnInv")`)) === true);

  for (const [label, kind] of [["回执丢了","throw"], ["5xx","http500"], ["200 但网关返回 HTML","html"]]) {
    await open({ tables: TABLES });
    await installFetch(kind);
    await sendInvite();
    const r = await invState();
    ok("I 结果不明（" + label + "）→ **不**说「创建失败」", !/创建失败/.test(r.err || ""), JSON.stringify(r));
    ok("I 结果不明（" + label + "）→ 说无法确认邀请是否已创建",
       r.errShown === true && /无法确认|没能确认/.test(r.err || ""), JSON.stringify(r));
    ok("I 结果不明（" + label + "）→ 不把按钮放开让人再建一份",
       r.btnDisabled === true, JSON.stringify(r));
    ok("I 结果不明（" + label + "）→ 页面不抛异常",
       !pageErrors.some(e => /TypeError/.test(e)), JSON.stringify(pageErrors.slice(0,2)));
  }

  /* 200 但结构对不上契约。create-teacher-invitation 成功必带 token 与
     expires_at（见 supabase/functions/…）。只看 data 真值的判据会把 {} 当成功，
     于是页面输出 code=undefined 与 Invalid Date —— 监督 event7e06 就是这么打的。 */
  await open({ tables: TABLES });
  await installFetch("malformed");
  await sendInvite();
  const im = await invState();
  ok("I6 畸形 200（{}）→ 不当成成功，不输出伪链接",
     im.outHidden === true, JSON.stringify(im));
  ok("I6b 说返回内容不完整、结果未明", im.errShown === true && /不完整|看不出/.test(im.err || ""), JSON.stringify(im));
  ok("I6c 按钮不解锁", im.btnDisabled === true, JSON.stringify(im));
  ok("I6d 页面上不出现 undefined / Invalid Date",
     !/undefined|Invalid Date/.test(await cdp.ev(`(document.getElementById("ivLink")||{}).textContent||""`)),
     JSON.stringify(await cdp.ev(`(document.getElementById("ivLink")||{}).textContent||""`)));

  await open({ tables: TABLES });
  await installFetch("refuse:bad_email");
  await sendInvite();
  const ir = await invState();
  ok("I4 明确拒绝 → 保留原文案（没改坏）", /邮箱格式不正确/.test(ir.err || ""), JSON.stringify(ir));
  ok("I4b 明确拒绝 → 按钮放开可重来", ir.btnDisabled === false, JSON.stringify(ir));

  await open({ tables: TABLES });
  await installFetch("ok");
  await sendInvite();
  ok("I5 成功 → 显示邀请链接（没改坏）", (await invState()).outHidden === false, JSON.stringify(await invState()));

  // ════════ V 教师审核 ════════
  console.log("\n=== V 教师审核 ===");
  const review = async (a) => {
    await cdp.ev(`(()=>{const b=document.querySelector('[data-a="${a}"]'); if(b && !b.disabled) b.click(); return true;})()`);
    await sleep(2000);
  };
  const rowBtn = async (a) => cdp.ev(`(()=>{const b=document.querySelector('[data-a="${a}"]');
    return b ? { disabled: !!b.disabled } : null;})()`);
  const qErr = async () => cdp.ev(`(()=>{const e=document.getElementById("qErr");
    return e ? { text:(e.textContent||"").trim(), shown:e.classList.contains("show") } : null;})()`);

  await open({ tables: TABLES });
  ok("V0 前提：队列里有一条待审核，动作按钮在",
     (await cdp.ev(`!!document.querySelector('[data-a="reject"]')`)) === true);

  await open({ tables: TABLES });
  await installFetch("throw");
  await review("reject");
  const v1 = await qErr();
  const v1all = ((v1 && v1.text) || "") + " " + dialogs.join(" ");
  ok("V1 结果不明 → **不**说「操作失败」，说无法确认是否已生效",
     !/操作失败/.test(v1all) && /无法确认|没能确认/.test(v1all),
     JSON.stringify({ qErr: v1, dialogs }));
  ok("V1b 结果不明 → 该行按钮不解锁，避免顺手再点一次",
     ((await rowBtn("reject")) || {}).disabled === true, JSON.stringify(await rowBtn("reject")));
  ok("V1c 只发出一次 review-teacher-verification", (await fnHits()) === 1, "命中 " + (await fnHits()) + " 次");

  await open({ tables: TABLES });
  await installFetch("malformed");
  await review("reject");
  const vm = await qErr();
  const vmall = ((vm && vm.text) || "") + " " + dialogs.join(" ");
  ok("V3 审核收到畸形 200（{}）→ 不当成成功（契约是 ok:true）",
     /不完整|看不出|无法确认/.test(vmall), JSON.stringify({ vm, dialogs }));
  ok("V3b 该行按钮不解锁", ((await rowBtn("reject")) || {}).disabled === true, JSON.stringify(await rowBtn("reject")));

  await open({ tables: TABLES });
  await installFetch("refuse:invalid_state");
  await review("reject");
  const v2all = (((await qErr()) || {}).text || "") + " " + dialogs.join(" ");
  ok("V2 明确拒绝 → 保留原文案并解锁（没改坏）",
     /当前状态不允许/.test(v2all) && ((await rowBtn("reject")) || {}).disabled === false,
     JSON.stringify({ v2all, btn: await rowBtn("reject") }));

  console.log("\n=== G 外发 ===");
  ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");

  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。");
process.exit(fail ? 1 : 0);
