// 三个「我的资料」页写的是同一个 RPC update_my_contact，处理却不一致。
//
// ── 已核的服务端契约 ──────────────────────────────────────────────────
// migrations/0017_student_experience.sql: 字段白名单函数，成功返回
//   return jsonb_build_object('ok', true);
//
// ── 查出来的 ──────────────────────────────────────────────────────────
//   portal/applicant/profile/  把**错误对象**传给了 Api.msg，而
//     `const msg = (code) => MESSAGES[code] || MESSAGES.unknown` 只收 code 字符串
//     —— 对象做键必然落空，于是 forbidden / rate_limited / validation_failed
//     统统被压成一句笼统的「操作未能完成，请稍后再试。」。
//     教师资料页的注释里恰好记着这个坑（"Api.msg 收的是 code 字符串，不是 error
//     对象 —— 传对象会一律落到 unknown"），同一个坑没有在这一页填上。
//   三页都只凭「没有 error」就报「已保存」，没有按契约验 ok === true。
//     这一条是**防御性边界**，不声称真实服务上已经发生过。
//
// 本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchOwnChrome } from "./lib/chrome-launcher.mjs";

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
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control":"no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const { chrome, port } = await launchOwnChrome({
  profilePrefix: "amas-prof-",
  extraArgs: ["--host-resolver-rules=MAP *.supabase.co 0.0.0.0, MAP *.supabase.in 0.0.0.0", "--disable-gpu", "--hide-scrollbars"],
});

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
    if (!url) throw new Error("连不上自己的调试端口 " + port);
    const s = await new Promise((res, rej) => { const k = new WebSocket(url); k.onopen = () => res(k); k.onerror = rej; });
    const c = new Cdp(s);
    s.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method && c.handlers.has(m.method)) c.handlers.get(m.method)(m.params); };
    return c;
  }
  send(method, params = {}, ms = 25000) {
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
  /* 真实鼠标点击：beforeunload 只有在页面有过用户交互（sticky activation）之后
     才会真的弹出来，纯脚本改值不算。 */
  async clickReal(sel) {
    const pt = await this.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return null; el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,ok:!!hit&&(hit===el||el.contains(hit)||hit.contains(el))};})()`);
    if (!pt || !pt.ok) throw new Error("点不到 " + sel);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await sleep(200);
  }
}
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d ? "  ← " + d : "")); } };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';

const STUB = `
window.supabase = {
  createClient: function(){
    var S = function(){ return window.__SCEN || {}; };
    var reply = function(v){ return Promise.resolve(v); };
    function table(name){
      var q = { select:function(){return q;}, eq:function(){return q;}, in:function(){return q;},
        order:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
        then:function(res, rej){
          var t = (S().tables && S().tables[name]) || { data: [], error: null };
          return Promise.resolve({ data:t.data, error:t.error||null, status:t.error?500:200 }).then(res, rej);
        } };
      return q;
    }
    var PROF = { id:"u-fx", display_name:"测试用户", email:"a@example.invalid",
                 phone:"0800000000", contact_note:"微信 fixture" };
    return {
      auth: {
        getSession: function(){ return reply({ data:{ session:{ user:{id:"u-fx"}, access_token:"fx" } }, error:null }); },
        mfa: { getAuthenticatorAssuranceLevel: function(){
          var a = S().aal || "aal2"; return reply({ data:{ currentLevel:a, nextLevel:"aal2" }, error:null }); } },
        onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
        signOut: function(){ return reply({}); }
      },
      from: table,
      rpc: function(name){
        var sc = S();
        if (name === "my_roles") return reply({ data:(sc.roles||["applicant"]).map(function(r){return {role:r};}), error:null, status:200 });
        if (name === "my_profile") return reply({ data:PROF, error:null, status:200 });
        if (name === "my_student_profile") return reply({ data:{ profile:PROF, student:{ student_number:"S-FX", status:"active", program_code:"bth" } }, error:null, status:200 });
        if (name === "update_my_contact") {
          var w = sc.write || { data:{ ok:true }, error:null, status:200 };
          return reply({ data:w.data, error:w.error||null, status:w.status!=null?w.status:(w.error?500:200) });
        }
        var r = (sc.rpc && sc.rpc[name]) || { data:null, error:null };
        return reply({ data:r.data, error:r.error||null, status:200 });
      },
      functions: { invoke: function(){ return reply({ data:null, error:null }); } }
    };
  }
};`;

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("cdn.jsdelivr.net") > -1 && u.indexOf("supabase-js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name:"Content-Type", value:"application/javascript" }, { name:"Cache-Control", value:"no-store" }], body: b64(STUB) }); return; }
      if (u.indexOf("supabase-config.js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name:"Content-Type", value:"application/javascript" }, { name:"Cache-Control", value:"no-store" }], body: b64(CFG) }); return; }
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });

  let dialogs = [];
  cdp.on("Page.javascriptDialogOpening", async (p) => {
    dialogs.push(String(p && p.type || ""));
    try { await cdp.send("Page.handleJavaScriptDialog", { accept: true }); } catch (e) {}
  });

  let nav = 0;
  const open = async (page, scen, wait) => {
    dialogs = [];
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(scen) + ";" });
    await cdp.send("Page.navigate", { url: `${BASE}/${page}?r=${++nav}` });
    await sleep(wait || 3000);
  };
  const state = async () => cdp.ev(`(()=>{
    const e=document.getElementById("err"), o=document.getElementById("ok"), b=document.getElementById("btnSave")||document.querySelector("#f button[type=submit], form button[type=submit]");
    const t=document.getElementById("amas-toast");
    return { err:e?(e.textContent||"").trim():null, errShown:!!(e&&e.classList.contains("show")),
             ok:o?(o.textContent||"").trim():null, okShown:!!(o&&o.classList.contains("show")),
             toast:t?(t.textContent||"").trim():null, toastShown:!!(t&&t.classList.contains("show")),
             btnDisabled:!!(b&&b.disabled) };})()`);
  const submitForm = async () => {
    await cdp.ev(`(()=>{const i=document.getElementById("ph"); if(i) i.value="0899999999";
      const f=document.querySelector("form"); if(f) f.requestSubmit(); return !!f;})()`);
    await sleep(1600);
  };

  const PAGES = [
    ["申请者", "portal/applicant/profile/", { roles:["applicant"], aal:"aal1" }],
    ["学员",   "portal/student/profile/",   { roles:["student"],   aal:"aal1" }],
    ["教师",   "portal/teacher/profile/",   { roles:["teacher"],   aal:"aal2" }],
  ];

  console.log("\n=== M 明确拒绝时要说得出具体原因 ===");
  for (const [label, page, base] of PAGES) {
    await open(page, { ...base, write: { data:null, error:{ message:"permission denied" }, status:403 } });
    ok("M0 前提：" + label + "资料页渲染出表单", (await cdp.ev(`!!document.getElementById("ph")`)) === true);
    await submitForm();
    const r = await state();
    ok("M1 " + label + "：明确拒绝显示具体原因，不是笼统的「操作未能完成」",
       r.errShown === true && !/操作未能完成/.test(r.err || ""), JSON.stringify(r.err));
    ok("M1b " + label + "：并且不报「已保存」",
       !/已保存/.test((r.ok || "") + (r.toast || "")), JSON.stringify(r));
  }

  console.log("\n=== C 成功要按契约验（ok:true）===");
  for (const [label, page, base] of PAGES) {
    await open(page, { ...base, write: { data:{ ok:true }, error:null, status:200 } });
    await submitForm();
    const r = await state();
    ok("C1 " + label + "：契约成立时照常报已保存（没改坏）",
       /已保存/.test((r.ok || "") + (r.toast || "")), JSON.stringify(r));

    await open(page, { ...base, write: { data:{}, error:null, status:200 } });
    await submitForm();
    const r2 = await state();
    ok("C2 " + label + "：200 但结构对不上契约时**不报**已保存",
       !/已保存/.test((r2.ok || "") + (r2.toast || "")), JSON.stringify(r2));
    ok("C2b " + label + "：而是说没能确认", /没能确认|无法确认/.test((r2.err || "")), JSON.stringify(r2.err));
  }

  // ════════ U 改了还没保存就离开，不能一声不响地丢掉 ════════
  console.log("\n=== U 未保存输入的保留 ===");
  /* 共享层早就有 UI.formGuard（申请表单在用），三个资料页一个都没挂。
     用户改了手机号或联系方式，顺手点一下导航里的「首页 / 我的申请 / 帮助 / 退出」，
     输入就没了，连一句提醒都没有。 */
  const leave = async () => {
    dialogs = [];
    await cdp.send("Page.navigate", { url: `${BASE}/help/?leave=${++nav}` });
    await sleep(1500);
    return dialogs.slice();
  };
  for (const [label, page, base] of PAGES) {
    await open(page, { ...base, write: { data:{ ok:true }, error:null, status:200 } });
    await cdp.clickReal("#ph");                    // 先有真实交互，beforeunload 才会生效
    await cdp.ev(`(()=>{const i=document.getElementById("ph"); i.value="0866666666";
      i.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
    const d1 = await leave();
    ok("U1 " + label + "：改了还没保存就离开会被拦下",
       d1.some(t => /beforeunload/i.test(t)), JSON.stringify(d1));

    // 保存成功之后离开就不该再打扰
    await open(page, { ...base, write: { data:{ ok:true }, error:null, status:200 } });
    await cdp.clickReal("#ph");
    await cdp.ev(`(()=>{const i=document.getElementById("ph"); i.value="0866666666";
      i.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
    await submitForm();
    const d2 = await leave();
    ok("U2 " + label + "：保存成功之后离开不再打扰",
       !d2.some(t => /beforeunload/i.test(t)), JSON.stringify(d2));

    // 什么都没改就离开，也不该打扰
    await open(page, { ...base, write: { data:{ ok:true }, error:null, status:200 } });
    await cdp.clickReal("#ph");
    const d3 = await leave();
    ok("U3 " + label + "：什么都没改就离开，不打扰",
       !d3.some(t => /beforeunload/i.test(t)), JSON.stringify(d3));
  }

  console.log("\n=== G 外发 ===");
  ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");
  cdp.ws.close();
} finally {
  try { chrome.kill(); } catch (e) {}
  server.close();
}
console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。");
process.exit(fail ? 1 : 0);
