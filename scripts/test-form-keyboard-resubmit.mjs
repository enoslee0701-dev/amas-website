// 表单重复提交的键盘路径：回车与 requestSubmit，在途期间再触发一次，只允许发出一次请求。
//
// 资料页的三种来路已由 test-profile-writes.mjs D / D3 段覆盖；这里补其余有提交的表单：
//   index.html 联系表单（main.js，POST formsubmit）   giving.html 奉献表单（本身有在途守卫，作对照）
//   login/  register/  forgot-password/（supabase auth）
// 每个表单四种来路，每种都重新载入页面、单独计数：
//   K1 回车连按两次（不等待）   K2 回车，在途时再按回车
//   R1 同一轮事件循环两次 requestSubmit   R2 requestSubmit，在途时再 requestSubmit
// 判据：请求增量恰为 1。0 = 一下都没发出去（量具失灵），2 = 重复提交。
//
// ★ 认证相关页面（login / register / forgot-password）按 CLAUDE.md 属 RED —— **只测不修**。
//   它们的 R1 / R2 结果如实打印为「RED 发现」并写入 BLOCKED.md，不计入本套件的失败；K1 / K2 照常断言。
//
// 外发：formsubmit 请求由 CDP 接住、延迟后伪造成功，**绝不放出去**（host-resolver 另把 formsubmit 钉到 0.0.0.0）；
// supabase-js 与 supabase-config.js 由桩替换（构造值，非凭据）；本机真实 local 配置由 refuseLocalConfig 拒绝伺服；
// 其余非本机请求一律拦截并计数，最后断言 0 次放行。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchOwnChrome } from "./lib/chrome-launcher.mjs";
import { refuseLocalConfig } from "./lib/no-local-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".json": "application/json", ".mp4": "video/mp4", ".pdf": "application/pdf" };

const hits = {};   // 认证桩打回来的调用计数（服务端计数，页面跳转也冲不掉）
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (refuseLocalConfig(p, res)) return;   // 不伺服本机真实配置（INCIDENT-0916）
  if (p === "/__hit") { const m = new URL(req.url, "http://x").searchParams.get("m"); hits[m] = (hits[m] || 0) + 1; res.writeHead(204); res.end(); return; }
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const { chrome, port } = await launchOwnChrome({
  profilePrefix: "amas-kbresubmit-",
  extraArgs: ["--host-resolver-rules=MAP formsubmit.co 0.0.0.0, MAP *.formsubmit.co 0.0.0.0", "--disable-gpu", "--hide-scrollbars"],
});

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  on(m, f) { this.handlers.set(m, f); }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try { const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
      if (!url) await sleep(200);
    }
    if (!url) throw new Error("连不上自己的调试端口 " + port);
    const s = await new Promise((res, rej) => { const k = new WebSocket(url); k.onopen = () => res(k); k.onerror = rej; });
    const c = new Cdp(s);
    s.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
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
}

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  ← " + d : "")); } };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';
/* 认证桩：每次调用先同步打一次 /__hit 计数，再延迟 1500ms 返回**失败**（避免成功后跳转打断测量） */
const STUB = `(function(){
  function hit(m){ try{ var x=new XMLHttpRequest(); x.open("GET","/__hit?m="+m,false); x.send(); }catch(e){} }
  function later(v){ return new Promise(function(r){ setTimeout(function(){ r(v); }, 1500); }); }
  var reply = function(v){ return Promise.resolve(v); };
  window.supabase = { createClient: function(){ return {
    auth: {
      getSession: function(){ return reply({ data:{ session:null }, error:null }); },
      onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
      mfa: { getAuthenticatorAssuranceLevel: function(){ return reply({ data:{ currentLevel:null, nextLevel:null }, error:null }); } },
      signOut: function(){ return reply({}); },
      signInWithPassword: function(){ hit("signIn"); return later({ data:{ session:null, user:null }, error:{ message:"Invalid login credentials", status:400 } }); },
      signUp: function(){ hit("signUp"); return later({ data:{ user:null, session:null }, error:{ message:"Signups not allowed for this instance", status:400 } }); },
      resetPasswordForEmail: function(){ hit("reset"); return later({ data:{}, error:{ message:"rate limit", status:429 } }); }
    },
    from: function(){ var q={ select:function(){return q;}, eq:function(){return q;}, maybeSingle:function(){return q;},
      then:function(res,rej){ return Promise.resolve({data:null,error:null}).then(res,rej); } }; return q; },
    rpc: function(){ return reply({ data:null, error:null }); },
    functions: { invoke: function(){ return reply({ data:null, error:null }); } }
  }; } };
})();`;

let formsubmitHits = 0, externalLeaked = [];
try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("formsubmit.co") > -1) {
        if (ev.request.method === "OPTIONS") {
          await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 204,
            responseHeaders: [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Access-Control-Allow-Headers", value: "*" }, { name: "Access-Control-Allow-Methods", value: "POST" }] });
          return;
        }
        formsubmitHits++;
        await sleep(1500);   // 在途窗口
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }],
          body: b64(JSON.stringify({ success: "true", message: "fixture" })) });
        return;
      }
      if (u.indexOf("cdn.jsdelivr.net") > -1 && u.indexOf("supabase-js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" }], body: b64(STUB) }); return;
      }
      if (u.indexOf("/assets/js/supabase-config.js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" }], body: b64(CFG) }); return;
      }
      if (!u.startsWith(BASE + "/") && !u.startsWith("data:")) {
        externalLeaked.push(u.split("?")[0]);
        await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" }); return;
      }
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) { /* 请求可能已终结 */ }
  });

  /* 聚焦用 el.focus()：首页有吸顶头部与浮动入口，坐标点击可能落在别的元素上、输入框拿不到焦点
     （初版这样量到 0 次 —— 是量具没点中，不是表单没反应）。按键本身仍是真实的 Input.dispatchKeyEvent。 */
  const focusAndEnter = async (sel, times, gapMs) => {
    const focused = await cdp.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false;
      el.scrollIntoView({block:'center'}); el.focus(); return document.activeElement === el;})()`);
    if (!focused) throw new Error("没能聚焦 " + sel);
    await sleep(100);
    for (let i = 0; i < times; i++) {
      if (i && gapMs) await sleep(gapMs);
      for (const type of ["keyDown", "keyUp"])
        await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
    }
  };
  const requestSubmit = async (formSel, times, gapMs) => {
    if (!gapMs) return cdp.ev(`(()=>{const f=document.querySelector(${JSON.stringify(formSel)}); ${"f.requestSubmit();".repeat(times)} return true;})()`);
    for (let i = 0; i < times; i++) { if (i) await sleep(gapMs); await cdp.ev(`(()=>{document.querySelector(${JSON.stringify(formSel)}).requestSubmit(); return true;})()`); }
  };

  const FORMS = [
    { label: "首页联系表单", page: "index.html", form: "#contactForm", focus: '#contactForm input[name="name"]', red: false,
      count: () => formsubmitHits,
      fill: `(()=>{const f=document.querySelector("#contactForm"); f.name.value="键盘测试"; f.contact.value="kb@example.invalid"; f.message.value="重复提交测试"; return true;})()` },
    /* 申请弹窗：四步向导，提交前每一步都要 checkValidity。按控件类型统一填，再打开弹窗到最后一步。 */
    { label: "首页申请表（四步向导）", page: "index.html", form: "#applicationForm", focus: null, red: false,
      /* 第 4 步只有一个确认勾选框，没有可以按回车提交的文本框 —— 回车路径不适用，只量 requestSubmit */
      only: ["R1", "R2"], skipWhy: "第 4 步只有确认勾选框，没有可回车提交的文本框", count: () => formsubmitHits,
      fill: `(()=>{
        if (typeof openApplication === "function") openApplication();
        const f = document.querySelector("#applicationForm");
        [...f.querySelectorAll("input,textarea,select")].forEach((el) => {
          if (el.closest(".honeypot")) return;
          if (el.tagName === "SELECT") { const o = [...el.options].find((x) => x.value); if (o) el.value = o.value; return; }
          if (el.type === "checkbox" || el.type === "radio") { if (el.required) el.checked = true; return; }
          if (el.type === "month") { el.value = "2000-01"; return; }
          if (el.type === "date") { el.value = "2000-01-01"; return; }
          if (el.type === "email") { el.value = "kb@example.invalid"; return; }
          if (el.type === "tel") { el.value = "0800000000"; return; }
          el.value = el.tagName === "TEXTAREA" ? "键盘重复提交测试" : "键盘测试";
        });
        if (typeof showAppStep === "function") showAppStep(4);
        return true;})()` },
    { label: "奉献表单（对照：本身有在途守卫）", page: "giving.html", form: "#gvForm", focus: '#gvForm input[name="name"]', red: false,
      count: () => formsubmitHits,
      fill: `(()=>{const f=document.querySelector("#gvForm"); f.name.value="键盘测试"; f.contact.value="kb@example.invalid"; return true;})()` },
    { label: "登录", page: "login/", form: "#loginForm", focus: "#fPw", red: true, count: () => hits.signIn || 0,
      fill: `(()=>{document.getElementById("fId").value="kb@example.invalid"; document.getElementById("fPw").value="not-a-real-password-1"; return true;})()` },
    { label: "注册", page: "register/", form: "#regForm", focus: "#rPw", red: true, count: () => hits.signUp || 0,
      fill: `(()=>{document.getElementById("rName").value="键盘测试"; document.getElementById("rEmail").value="kb@example.invalid"; document.getElementById("rPw").value="abcd1234efgh"; return true;})()` },
    { label: "找回密码", page: "forgot-password/", form: "#fpForm", focus: "#fEmail", red: true, count: () => hits.reset || 0,
      fill: `(()=>{document.getElementById("fEmail").value="kb@example.invalid"; return true;})()` },
  ];
  const VECTORS = [
    ["K1 回车连按两次（不等待）", (F) => focusAndEnter(F.focus, 2, 0), false],
    ["K2 回车，在途时再按回车", (F) => focusAndEnter(F.focus, 2, 400), false],
    ["R1 同一轮事件循环两次 requestSubmit", (F) => requestSubmit(F.form, 2, 0), true],
    ["R2 requestSubmit，在途时再 requestSubmit", (F) => requestSubmit(F.form, 2, 400), true],
  ];
  const redFindings = [];

  for (const F of FORMS) {
    console.log(`\n=== ${F.label}（${F.page}）===`);
    for (const [vname, fire, isRS] of VECTORS) {
      if (F.only && !F.only.some((k) => vname.startsWith(k))) { console.log(`  skip  ${F.label} · ${vname}（该表单不适用：${F.skipWhy || "见表内说明"}）`); continue; }
      await cdp.send("Page.navigate", { url: `${BASE}/${F.page}?v=${encodeURIComponent(vname)}` });
      await sleep(2200);
      await cdp.ev(F.fill);
      const before = F.count();
      await fire(F);
      await sleep(2600);   // 等在途那一笔回来
      const delta = F.count() - before;
      const name = `${F.label} · ${vname}：请求增量恰为 1`;
      if (F.red && isRS) {
        console.log(`  NOTE  [RED，只测不修] ${name}  → 实测 ${delta}`);
        redFindings.push({ form: F.label, vector: vname, delta });
      } else {
        ok(name, delta === 1, "实测 " + delta);
      }
    }
  }

  console.log("\n=== 外发 ===");
  const uniq = [...new Set(externalLeaked.map((u) => { try { return new URL(u).host; } catch { return u; } }))];
  /* 被拦下的只允许是字体；formsubmit 与 supabase 走的是接管分支，出现在这里说明接管失效 */
  ok("G1 被拦下的非本机请求只有字体（formsubmit / supabase 从未走到放行或拦截分支之外）",
     uniq.every((h) => /^fonts\.(googleapis|gstatic)\.com$/.test(h)), JSON.stringify(uniq));
  console.log("      · 被拦下、未放出的非本机主机：" + (uniq.length ? uniq.join("、") : "（无）"));
  console.log("\n=== RED 发现（认证相关页面，只测不修）===");
  for (const r of redFindings) console.log(`  ${r.delta === 1 ? "ok  " : "GAP "} ${r.form} · ${r.vector} → 请求 ${r.delta} 次`);
  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + (e && e.stack || e));
} finally {
  try { chrome.kill(); } catch (e) {}
  server.close();
}
console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  formsubmit 由 CDP 接管且从未放出；supabase 为桩；非本机请求全部拦截。");
process.exit(fail ? 1 : 0);
