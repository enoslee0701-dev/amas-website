// 注册页：按 signUp 的**真实返回状态**分别处理的本地验证。
//
// ── 为什么需要这一套 ──────────────────────────────────────────────────
// 注册页原本只看 `{ error }`：不报错就一律显示「验证邮件已发送至 X，
// 请打开邮件完成验证后再登录」。但 supabase-js v2 的 signUp 返回的是
// `{ data: { user, session }, error }`，成功分支有两种完全不同的结果：
//   · data.session 非空 → 已经登录了，服务端**根本没要求邮箱验证**，没发任何邮件。
//     本项目 staging 正是 `mailer_autoconfirm = true`，走的就是这一支。
//   · data.session 为空、data.user 非空 → 需先完成邮箱验证才能登录。
// 旧文案在前一种情况下是**假话**。这套测试把三种结果（外加 error 与异常）
// 分别喂给真实的调用链，验证页面说的话与实际发生的事对得上。
//
// ── 本套件用的是什么、不是什么 ────────────────────────────────────────
// stub 只替换 `window.supabase.createClient` 返回的假客户端。
// **assets/js/portal/auth.js 里的 signUp 是真跑的**，页面脚本也是真跑的 ——
// 验的是 `页面 → A.signUp → client.auth.signUp` 这条真实链路，
// 不是直接 stub 最终结果对象。
// 没有真实注册、没有发出任何邮件、没有真实凭据、没有一个请求离开本机
// （supabase 域名在浏览器层被钉到 0.0.0.0）。
//
// stub 返回的形状取自 supabase-js 实际实现（当前 CDN 上 `@2` 解析到 2.116.0）：
//   出错/无 data → { data: { user: null, session: null }, error }
//   成功         → { data: { user, session }, error: null }
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-reg-"));
const port = 9413;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
// 浏览器级硬阻断：真域名解析到 0.0.0.0，注册请求不可能真的出去
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP *.supabase.co 0.0.0.0, MAP *.supabase.in 0.0.0.0",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

let externalHits = 0;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  on(m, f) { this.handlers.set(m, f); }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try { const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
      if (!url) await sleep(250);
    }
    if (!url) throw new Error("连不上 Chrome 调试端口");
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
    await sleep(360);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
// fixture：构造的 project ref + 字面占位串。不是凭据，且已被钉死到 0.0.0.0。
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';

/** 本机假客户端。signUp 的返回形状照 supabase-js 实际实现构造。
    window.__SCEN.signup 指定这一轮该返回什么。 */
const STUB = `
window.supabase = {
  createClient: function(){
    var reply = function(v){ return Promise.resolve(v); };
    return {
      auth: {
        getSession: function(){ return reply({ data: { session: null } }); },
        onAuthStateChange: function(){ return { data: { subscription: { unsubscribe: function(){} } } }; },
        signOut: function(){ return reply({}); },
        signUp: function(args){
          window.__calls = window.__calls || [];
          window.__calls.push({ kind: "signUp", args: args });
          var sc = (window.__SCEN || {}).signup || {};
          /* 错误对象照 2.116.0 的错误类形状构造：
             AuthError 一律带 __isAuthError、name、status、code。
             AuthRetryableFetchError 的 status：fetch 自身失败为 0，服务端 5xx 为该状态码。
             signUp 的 catch 只在 __isAuthError 时把错误当返回值，其余重新抛出。 */
          var mkErr = function(spec){
            var e = new Error(spec.message || "boom");
            e.name = spec.name || "AuthApiError";
            if (spec.authError !== false) e.__isAuthError = true;
            if (spec.status !== undefined) e.status = spec.status;
            if (spec.code !== undefined) e.code = spec.code;
            return e;
          };
          if (sc.mode === "throw") {
            // 非 AuthError 的抛出物：SDK 自己都不认，会直接重新抛出来
            return Promise.reject(sc.err ? mkErr(sc.err) : new TypeError("Failed to fetch"));
          }
          if (sc.mode === "error") {
            return reply({ data: { user: null, session: null }, error: mkErr(sc.err || {}) });
          }
          if (sc.mode === "session") {
            return reply({ data: {
              user: { id: "u-new", email: args.email, identities: [{ id: "i-1" }] },
              session: { access_token: "stub", user: { id: "u-new" } } }, error: null });
          }
          if (sc.mode === "pending") {
            // 确认邮箱开启时的典型返回：有 user、无 session。
            // identities 为空数组就是 GoTrue 对「邮箱已注册」的防枚举返回 —— 客户端不该区分。
            return reply({ data: {
              user: { id: "u-new", email: args.email,
                      identities: sc.emptyIdentities ? [] : [{ id: "i-1" }] },
              session: null }, error: null });
          }
          // mode === "blank"：没报错，却既没 session 也没 user
          return reply({ data: { user: null, session: null }, error: null });
        }
      },
      from: function(){ var q = { select:function(){return q;}, eq:function(){return q;},
        then:function(r){ return Promise.resolve({ data: [], error: null }).then(r); } }; return q; },
      rpc: function(){ return reply({ data: null, error: null }); },
      functions: { invoke: function(){ return reply({ data: null, error: null }); } }
    };
  }
};`;

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("cdn.jsdelivr.net") > -1 && u.indexOf("supabase-js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" },
                            { name: "Cache-Control", value: "no-store" }], body: b64(STUB) });
        return;
      }
      if (u.indexOf("supabase-config.js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" },
                            { name: "Cache-Control", value: "no-store" }], body: b64(CFG) });
        return;
      }
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });

  const openReg = async (scen) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__SCEN = " + JSON.stringify(scen) + "; window.__calls = [];",
    });
    await cdp.send("Page.navigate", { url: `${BASE}/register/` });
    await sleep(1800);
  };
  /* 只取**渲染出来**的文字：body.textContent 会把内联 <script> 的源码也算进去，
     而这个页面的注释里恰好写着旧文案「验证邮件已发送至 X」——
     不剥掉 script 的话，「页面上不该出现旧文案」这条断言会被自己的注释咬到。 */
  const txt = async () => cdp.ev(`(()=>{
    const c = document.body.cloneNode(true);
    c.querySelectorAll("script,style,template").forEach(n => n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();
  })()`);
  const calls = async () => cdp.ev(`window.__calls || []`);
  const btnState = async () => cdp.ev(`(()=>{const b=document.getElementById("btnReg");
    return { disabled: b.disabled, label: b.textContent, formHidden: document.getElementById("regForm").hidden };})()`);

  /** 真实填表 + 真实点提交。不直接调 A.signUp。 */
  const submit = async (mail, pw, name) => {
    await cdp.ev(`(()=>{
      const set=(id,v)=>{const el=document.getElementById(id); el.value=v;
        el.dispatchEvent(new Event("input",{bubbles:true}));};
      set("rName", ${JSON.stringify(name || "陈同学")});
      set("rEmail", ${JSON.stringify(mail)});
      set("rPw", ${JSON.stringify(pw || "abcd1234")});
      return true;})()`);
    await cdp.clickReal("#btnReg");
    await sleep(700);
  };

  // ════════════ R0 载入与基本前提 ════════════
  console.log("\n=== R0 前提：配置就绪、按钮文案不预先承诺发邮件 ===");
  await openReg({ signup: { mode: "session" } });
  const st0 = await cdp.ev(`({ state: (window.AmasAuth && window.AmasAuth.CONFIG_STATE) || "(未加载)",
                               configured: !!(window.AmasAuth && window.AmasAuth.CONFIGURED) })`);
  ok("R0 页面拿到配置且判定 ready", st0.state === "ready" && st0.configured === true, JSON.stringify(st0));
  const b0 = await btnState();
  ok("R0 提交按钮可用", b0.disabled === false, JSON.stringify(b0));
  ok("R0 按钮文案不再是「注册并发送验证邮件」", !/发送验证邮件/.test(b0.label), b0.label);
  const t0 = await txt();
  ok("R0 初始页面不预先声称会发验证邮件", !/验证邮件已发送/.test(t0), t0.slice(0, 160));

  // ════════════ R1 有 session：已登录，没发邮件 ════════════
  console.log("\n=== R1 signUp 返回 session（当前 staging 的 autoconfirm 走这一支）===");
  await openReg({ signup: { mode: "session" } });
  await submit("  NewUser@Example.Invalid  ", "abcd1234", "  陈同学  ");
  const t1 = await txt();
  ok("R1 明说账号已创建且已登录", /账号已创建/.test(t1) && /已登录/.test(t1), t1.slice(0, 200));
  ok("R1 **明说没有发送验证邮件**", /没有发送验证邮件/.test(t1), t1.slice(0, 260));
  ok("R1 不再谎称「验证邮件已发送至」", !/验证邮件已发送/.test(t1), t1.slice(0, 260));
  ok("R1 不让用户去等一封不存在的邮件", !/请打开邮件完成验证/.test(t1), t1.slice(0, 260));
  ok("R1 不把 session 等同于已获身份或申请通过",
     /不代表已获得学员或教师身份/.test(t1) && /不代表入学申请已通过/.test(t1), t1.slice(0, 300));
  const link1 = await cdp.ev(`(()=>{const a=[...document.querySelectorAll("#ok a")]
      .find(x=>/进入门户/.test(x.textContent)); return a ? a.getAttribute("href") : null;})()`);
  ok("R1 给出进入门户的入口", !!link1, String(link1));
  ok("R1 入口指向门户总入口（由守卫判角色），不直接深链某个角色空间",
     link1 === "../portal/", String(link1));
  const b1 = await btnState();
  ok("R1 成功后表单收起", b1.formHidden === true, JSON.stringify(b1));

  // R1b 传给 SDK 的参数：邮箱规范化、display_name、回跳地址
  const c1 = (await calls()).filter((c) => c.kind === "signUp");
  ok("R1b 只调用了一次 signUp，没有自动重发", c1.length === 1, "次数=" + c1.length);
  ok("R1b 邮箱已去空白并转小写",
     !!c1[0] && c1[0].args.email === "newuser@example.invalid", c1[0] && c1[0].args.email);
  ok("R1b display_name 已去空白并传入",
     !!c1[0] && c1[0].args.options.data.display_name === "陈同学",
     c1[0] && JSON.stringify(c1[0].args.options.data));
  ok("R1b emailRedirectTo 指向 auth/callback/",
     !!c1[0] && /\/auth\/callback\/$/.test(c1[0].args.options.emailRedirectTo || ""),
     c1[0] && c1[0].args.options.emailRedirectTo);

  // ════════════ R2 无 session、有 user：待验证 ════════════
  console.log("\n=== R2 signUp 返回 user 但无 session（需邮箱验证）===");
  await openReg({ signup: { mode: "pending" } });
  await submit("pending@example.invalid", "abcd1234");
  const t2 = await txt();
  ok("R2 说「注册请求已受理」，需先完成邮箱验证",
     /注册请求已受理/.test(t2) && /完成邮箱验证/.test(t2), t2.slice(0, 220));
  ok("R2 措辞是「验证邮件应发往」而非断言已送达",
     /验证邮件应发往/.test(t2) && !/验证邮件已发送/.test(t2), t2.slice(0, 260));
  ok("R2 回显了收件邮箱", /pending@example\.invalid/.test(t2), t2.slice(0, 260));
  ok("R2 收不到时引导联系同工而不是反复提交",
     /不要反复提交/.test(t2) && /联系招生同工/.test(t2), t2.slice(-260));
  ok("R2 **不断言「新账号已创建」**（防枚举下无法区分已注册邮箱）",
     !/账号已创建/.test(t2), t2.slice(0, 260));
  ok("R2 给出已注册时的出口（登录 / 找回密码）",
     /登录/.test(t2) && /找回密码/.test(t2), t2.slice(-200));

  // R2b identities 为空（GoTrue 对已注册邮箱的防枚举返回）→ 措辞必须与 R2 一致
  await openReg({ signup: { mode: "pending", emptyIdentities: true } });
  await submit("taken@example.invalid", "abcd1234");
  const t2b = await txt();
  ok("R2b identities 为空时措辞与新注册完全一致（不泄露该邮箱是否已注册）",
     /注册请求已受理/.test(t2b) && !/账号已创建/.test(t2b) && !/已注册，请直接登录/.test(t2b),
     t2b.slice(0, 220));

  // ════════════ R3 结果不明 ════════════
  console.log("\n=== R3 signUp 没报错，却既没 session 也没 user ===");
  await openReg({ signup: { mode: "blank" } });
  await submit("blank@example.invalid", "abcd1234");
  const t3 = await txt();
  ok("R3 明说结果未能确认，不判定成败",
     /注册结果未能确认/.test(t3) && /无法判定账号是否已创建/.test(t3), t3.slice(0, 240));
  ok("R3 不报成功", !/账号已创建，并且已登录/.test(t3) && !/注册请求已受理/.test(t3), t3.slice(0, 240));
  ok("R3 不报失败", !/注册失败/.test(t3), t3.slice(0, 240));
  ok("R3 给出明确的核实入口", /去登录页确认/.test(t3), t3.slice(0, 300));
  ok("R3 明确要求不要直接重复提交", /不要直接重复提交/.test(t3), t3.slice(0, 300));
  const b3 = await btnState();
  ok("R3 **提交按钮保持禁用**：未核实前不让它被再点一次", b3.disabled === true, JSON.stringify(b3));
  ok("R3 按钮文案已从「提交中…」复位，不假装还在跑", !/提交中/.test(b3.label), b3.label);
  ok("R3 表单仍在页面上（用户填的内容不丢）", b3.formHidden === false, JSON.stringify(b3));
  const keep3 = await cdp.ev(`({ name: document.getElementById("rName").value,
                                 mail: document.getElementById("rEmail").value })`);
  ok("R3 输入内容确实保留", keep3.mail === "blank@example.invalid" && !!keep3.name, JSON.stringify(keep3));
  // 再点一次按钮：被禁用就不该再发一次注册
  await cdp.ev(`(()=>{const b=document.getElementById("btnReg");
    b.dispatchEvent(new MouseEvent("click",{bubbles:true})); return true;})()`);
  await sleep(500);
  ok("R3 未核实前不会再发出第二次注册请求",
     (await calls()).filter((c) => c.kind === "signUp").length === 1,
     "次数=" + (await calls()).filter((c) => c.kind === "signUp").length);

  // ════════════ R4 明确拒绝（4xx）：账号确实没建，可以直接重试 ════════════
  console.log("\n=== R4 服务器明确拒绝（4xx）===");
  const rejected = async (err, expect, label) => {
    await openReg({ signup: { mode: "error", err } });
    await submit("e@example.invalid", "abcd1234");
    const t = await txt();
    const b = await btnState();
    ok(label + "：文案正确", expect.test(t), t.slice(0, 220));
    ok(label + "：不误报成功", !/账号已创建/.test(t) && !/注册请求已受理/.test(t), t.slice(0, 220));
    ok(label + "：**不走「结果未能确认」**（这是确定的拒绝）",
       !/注册结果未能确认/.test(t), t.slice(0, 220));
    ok(label + "：按钮恢复可点 —— 改完可以直接重新提交",
       b.disabled === false && !/提交中/.test(b.label), JSON.stringify(b));
    ok(label + "：表单仍在，输入未丢", b.formHidden === false, JSON.stringify(b));
  };
  await rejected({ name: "AuthApiError", status: 400, code: "user_already_exists",
                   message: "User already registered" }, /该邮箱已注册/, "R4a 已注册 400");
  await rejected({ name: "AuthWeakPasswordError", status: 422, code: "weak_password",
                   message: "Password is too weak" },
                 /密码强度不足/, "R4b 弱密码 422");
  await rejected({ name: "AuthApiError", status: 429, code: "over_request_rate_limit",
                   message: "Request rate limit reached" },
                 /服务器拒绝了这次注册/, "R4c 限流 429");
  await rejected({ name: "AuthApiError", status: 400, code: "validation_failed",
                   message: "Unable to validate email address" },
                 /服务器拒绝了这次注册/, "R4d 校验失败 400");

  // R4e 弱密码要明说可以改了再来
  await openReg({ signup: { mode: "error", err: { name: "AuthWeakPasswordError", status: 422,
                                                  code: "weak_password", message: "too weak" } } });
  await submit("e@example.invalid", "abcd1234");
  ok("R4e 弱密码明说改好后可直接重新提交", /改好后可以直接重新提交/.test(await txt()));
  ok("R4e 弱密码靠 code 判定，不依赖消息文案里有没有 password",
     /密码强度不足/.test(await txt()));

  // R4f 明确拒绝也走 catch 路径时（防御性）：仍应按拒绝处理
  await openReg({ signup: { mode: "throw", err: { name: "AuthApiError", status: 400,
                                                  message: "User already registered" } } });
  await submit("e@example.invalid", "abcd1234");
  const t4f = await txt();
  ok("R4f 抛出的 4xx AuthError 仍判为明确拒绝",
     /该邮箱已注册/.test(t4f) && !/注册结果未能确认/.test(t4f), t4f.slice(0, 220));
  ok("R4f 该情形按钮恢复可点", (await btnState()).disabled === false);

  // ════════════ R5 结果不明：不能据此判定注册失败 ════════════
  console.log("\n=== R5 结果不明（网络 / 5xx / 无法解析 / 抛出异常）===");
  /* 这一组是本轮的核心。以前它们全被归进「注册失败，请稍后再试」并把按钮放开，
     等于告诉用户「没注册成功，再点一次」—— 而注册很可能已经在服务器完成了，
     只是回执丢了。让用户直接再点一次，下一次多半撞上「该邮箱已注册」。 */
  const unsureCase = async (scen, why, label) => {
    await openReg({ signup: scen });
    await submit("u@example.invalid", "abcd1234", "赵同学");
    const t = await txt();
    const b = await btnState();
    ok(label + "：判为「注册结果未能确认」", /注册结果未能确认/.test(t), t.slice(0, 260));
    ok(label + "：给出的原因是「" + why + "」", t.indexOf(why) > -1, t.slice(0, 260));
    ok(label + "：**明说注册可能已经在服务器完成**",
       /已经在服务器完成/.test(t), t.slice(0, 300));
    ok(label + "：不报失败", !/注册失败/.test(t) && !/服务器拒绝了这次注册/.test(t), t.slice(0, 260));
    ok(label + "：不报成功", !/账号已创建/.test(t) && !/注册请求已受理/.test(t), t.slice(0, 260));
    ok(label + "：**按钮保持禁用**，不诱导直接再注册一次", b.disabled === true, JSON.stringify(b));
    ok(label + "：按钮文案从「提交中…」复位", !/提交中/.test(b.label), b.label);
    ok(label + "：表单与输入保留", b.formHidden === false, JSON.stringify(b));
    const keep = await cdp.ev(`({ name: document.getElementById("rName").value,
                                  mail: document.getElementById("rEmail").value })`);
    ok(label + "：填过的内容确实还在",
       keep.mail === "u@example.invalid" && keep.name === "赵同学", JSON.stringify(keep));
    ok(label + "：引导去登录页核实", /去登录页试一次|去登录页确认/.test(t), t.slice(0, 320));
    await cdp.ev(`(()=>{document.getElementById("btnReg")
      .dispatchEvent(new MouseEvent("click",{bubbles:true})); return true;})()`);
    await sleep(450);
    const n = (await calls()).filter((c) => c.kind === "signUp").length;
    ok(label + "：再点一次也不会发出第二次注册请求", n === 1, "次数=" + n);
  };

  await unsureCase({ mode: "error", err: { name: "AuthRetryableFetchError", status: 0,
                                           message: "Failed to fetch" } },
                   "网络中断", "R5a 网络中断（status 0）");
  await unsureCase({ mode: "error", err: { name: "AuthRetryableFetchError", status: 503,
                                           message: "Service Unavailable" } },
                   "写入之后才失败", "R5b 服务端 503");
  await unsureCase({ mode: "error", err: { name: "AuthUnknownError",
                                           message: "<html>502 Bad Gateway</html>" } },
                   "响应无法解析", "R5c 响应无法解析");
  await unsureCase({ mode: "error", err: { name: "AuthApiError", status: 408,
                                           message: "Request Timeout" } },
                   "写入之后才失败", "R5d 408 超时（是 4xx 但语义是超时）");
  await unsureCase({ mode: "throw" },
                   "无法归类的异常", "R5e SDK 直接抛出非 AuthError");
  await unsureCase({ mode: "blank" },
                   "没有返回可确认的结果", "R5f 无 error 也无 user/session");

  // R5g 分类是按错误类和状态码判的，不是按消息文案
  await openReg({ signup: { mode: "error", err: { name: "AuthRetryableFetchError", status: 0,
                                                  message: "User already registered" } } });
  await submit("u@example.invalid", "abcd1234");
  const t5g = await txt();
  /* 注意断言别用 /该邮箱已注册/ —— 未知分支的正文里就写着
     「（重复提交可能撞上「该邮箱已注册」）」，那样命中的是自己的提示语而非错误消息。
     这里改判两件确凿的事：错误框没被显示，未知框被显示。 */
  const box5g = await cdp.ev(`({ err: document.getElementById("err").classList.contains("show"),
                                 unsure: document.getElementById("unsure").classList.contains("show") })`);
  ok("R5g 消息里写着 already registered，但类是可重试类 → 仍判为结果不明",
     /注册结果未能确认/.test(t5g) && box5g.unsure === true && box5g.err === false,
     JSON.stringify(box5g) + " | " + t5g.slice(-220));
  ok("R5g 该情形按钮保持禁用", (await btnState()).disabled === true);

  // ════════════ R6 一处也没真的出去 ════════════
  console.log("\n=== R6 外发 ===");
  ok("R6 全程没有一个请求到达真实 supabase 域名（也就没有真注册、没有真发信）",
     externalHits === 0, "命中 " + externalHits + " 次");

  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  全程本机 stub：没有真实注册、没有发出任何邮件、没有真实凭据、没有远端写入。");
console.log("  绿灯只证明「给定这些返回值时页面说对了话」，不证明线上邮件通道可用 ——");
console.log("  SMTP 上线配置仍是独立阻塞（见 STAGING-0 §15 BLOCKER-02），改文案不解除它。");
process.exit(fail ? 1 : 0);
