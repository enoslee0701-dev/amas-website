// 三个门户页在**正常路径**下的本地功能测试（profile / history / admin-teachers）。
//
// ── 为什么需要这一套 ──────────────────────────────────────────────────
// test-portal-degraded 121/121 覆盖的全是「拿不到后端时说什么」。
// 它一条也没证明过「拿得到后端时做对了什么」—— 读取、保存、空态、越权、
// 审核成功与失败，全都没测过。
//
// ── 这套测试用的是什么，不是什么 ──────────────────────────────────────
// 本机 stub：`window.supabase.createClient` 被换成一个**本地假客户端**，
// 按用例返回构造数据或构造错误。**没有任何真实凭据、没有任何请求离开本机、
// 没有创建任何真实身份、没有对远端写入一个字节。**
// 所以：全绿 ≠ 线上可用。它只证明「给定这些返回值时，页面做对了事」。
//
// 鉴权边界照旧走页面自己的 Shell.mount / requireRole —— 本套件不绕过守卫，
// 而是通过 stub 返回不同的角色来驱动它。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-pp-"));
const port = 9407;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
// 浏览器级硬阻断：真 supabase 域名解析到 0.0.0.0，任何请求都不可能真的出去
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
    await sleep(320);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
// fixture：构造的 project ref + 字面占位串。不是凭据，且已被 host-resolver 钉死到 0.0.0.0。
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';

/** 生成本机假 supabase 客户端。SCEN 由每个用例注入到 window.__SCEN。 */
const STUB = `
window.supabase = {
  createClient: function(){
    var S = function(){ return window.__SCEN || {}; };
    var reply = function(v){ return Promise.resolve(v); };
    function table(name){
      var q = {
        select: function(){ return q; },
        eq: function(){ return q; },
        in: function(){ return q; },
        order: function(){ return q; },
        limit: function(){ return q; },
        maybeSingle: function(){ return q; },
        then: function(res, rej){
          var sc = S();
          var t = (sc.tables && sc.tables[name]) || { data: [], error: null };
          window.__calls = window.__calls || [];
          window.__calls.push({ kind: "select", table: name });
          return Promise.resolve({ data: t.data, error: t.error, status: t.error ? 500 : 200 }).then(res, rej);
        }
      };
      return q;
    }
    return {
      auth: {
        getSession: function(){ return reply({ data: { session: S().session || null } }); },
        mfa: { getAuthenticatorAssuranceLevel: function(){
          return reply({ data: { currentLevel: S().aal || "aal1", nextLevel: S().aal || "aal1" } }); } },
        onAuthStateChange: function(){ return { data: { subscription: { unsubscribe: function(){} } } }; },
        signOut: function(){ return reply({}); }
      },
      from: table,
      rpc: function(name, args){
        window.__calls = window.__calls || [];
        window.__calls.push({ kind: "rpc", name: name, args: args });
        var sc = S();
        var r = (sc.rpc && sc.rpc[name]);
        if (typeof r === "function") r = r(args);
        if (!r) r = { data: null, error: null };
        return reply({ data: r.data, error: r.error || null, status: r.error ? 500 : 200 });
      },
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

  /** 载入某页并注入场景。scen 在**页面脚本跑之前**就位。 */
  const open = async (page, scen) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__SCEN = " + JSON.stringify(scen) + "; window.__calls = [];",
    });
    await cdp.send("Page.navigate", { url: `${BASE}/${page}` });
    await sleep(2300);
  };
  /* 只取**渲染出来**的文字。
     早先用的是 document.body.textContent —— 它把内联 <script> 的源码也算了进去，
     于是「页面上不该出现 X」这类断言会命中源码里的注释或字符串常量而误判。
     这一轮就被它咬了两次（"内部备注" 命中的是注释，"已保存" 命中的是赋值语句）。
     红的是量具不是页面。 */
  const txt = async () => cdp.ev(`(()=>{
    const c = document.body.cloneNode(true);
    c.querySelectorAll("script,style,template").forEach(n => n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();
  })()`);
  const calls = async () => cdp.ev(`window.__calls || []`);

  const SESSION = { user: { id: "u-1", email: "a@example.invalid" } };
  const PROFILE = { id: "u-1", display_name: "测试申请者", legal_name: null,
    email: "a@example.invalid", phone: "0800000000", contact_note: "line: test",
    country_code: "TH", timezone: "Asia/Bangkok", locale: "zh-CN",
    account_status: "active", created_at: "2026-01-05T02:00:00Z" };

  // ════════════ A profile 正常读取 ════════════
  console.log("\n=== A 申请者资料页：正常读取 ===");
  await open("portal/applicant/profile/", {
    session: SESSION, aal: "aal1",
    rpc: { my_roles: { data: [{ role: "applicant" }] },
           my_profile: { data: PROFILE } },
  });
  const a = await txt();
  ok("页面渲染出资料页而不是降级页", /个人资料/.test(a) && !/尚未启用/.test(a), a.slice(0, 60));
  ok("读到的姓名填进了输入框",
     (await cdp.ev(`document.getElementById("nm").value`)) === "测试申请者");
  ok("电话与备用联系方式都填进去了",
     (await cdp.ev(`document.getElementById("ph").value`)) === "0800000000" &&
     (await cdp.ev(`document.getElementById("ct").value`)) === "line: test");
  ok("登录邮箱以只读方式显示", /a@example\.invalid/.test(a));
  ok("账号状态翻译成中文", /正常/.test(a), a.slice(0, 80));
  ok("确实调用了 my_profile",
     (await calls()).some((c) => c.kind === "rpc" && c.name === "my_profile"));

  // ════════════ B profile 保存走白名单 ════════════
  console.log("\n=== B 申请者资料页：保存只经 update_my_contact 白名单 ===");
  await cdp.ev(`(()=>{document.getElementById("nm").value="改过的名字";
    document.getElementById("ph").value="0899999999";
    document.getElementById("ct").value="wechat: x"; return true;})()`);
  await cdp.clickReal("#save");
  await sleep(500);
  const saveCall = (await calls()).filter((c) => c.kind === "rpc" && c.name === "update_my_contact").pop();
  ok("保存调用的是 update_my_contact", !!saveCall, JSON.stringify(await calls()));
  ok("只传了白名单里的三个参数",
     !!saveCall && Object.keys(saveCall.args).sort().join(",") === "p_contact_note,p_display_name,p_phone",
     saveCall ? JSON.stringify(saveCall.args) : "");
  ok("传的是用户改后的值",
     !!saveCall && saveCall.args.p_display_name === "改过的名字" &&
     saveCall.args.p_phone === "0899999999" && saveCall.args.p_contact_note === "wechat: x");
  ok("没有夹带 email / account_status 这类被冻结的列",
     !!saveCall && !("p_email" in saveCall.args) && !("email" in saveCall.args) &&
     !("account_status" in saveCall.args));
  ok("成功后显示已保存", /已保存/.test(await txt()));

  // ════════════ C profile 保存失败 ════════════
  console.log("\n=== C 申请者资料页：保存失败如实报出 ===");
  await open("portal/applicant/profile/", {
    session: SESSION, aal: "aal1",
    rpc: { my_roles: { data: [{ role: "applicant" }] },
           my_profile: { data: PROFILE },
           update_my_contact: { error: { message: "boom" } } },
  });
  await cdp.clickReal("#save");
  await sleep(500);
  const c = await txt();
  ok("失败时不显示「已保存」", !/已保存/.test(c), c.slice(-80));
  ok("失败时给出可见错误", (await cdp.ev(
    `(()=>{const e=document.getElementById("err"); return !!e && e.classList.contains("show") && e.textContent.trim().length>0;})()`)) === true);
  ok("失败后输入内容仍在（没被清掉）",
     (await cdp.ev(`document.getElementById("nm").value`)).length > 0);

  // ════════════ D profile 读取失败 ════════════
  console.log("\n=== D 申请者资料页：读取失败给重试 ===");
  await open("portal/applicant/profile/", {
    session: SESSION, aal: "aal1",
    rpc: { my_roles: { data: [{ role: "applicant" }] },
           my_profile: { error: { message: "读取失败" } } },
  });
  const d = await txt();
  ok("显示载入失败而不是空白页", /载入失败|重试/.test(d), d.slice(0, 80));

  // ════════════ E history 正常列出 ════════════
  console.log("\n=== E 历史申请：只列已结束的，且只有自己的 ===");
  const HIST = [
    { id: "app-1", pathway: "bth", status: "rejected", applicant_visible_message: "材料不完整",
      submitted_at: "2026-02-01T03:00:00Z", decided_at: "2026-02-10T03:00:00Z", created_at: "2026-01-20T03:00:00Z" },
    { id: "app-2", pathway: "common_learning", status: "withdrawn", applicant_visible_message: null,
      submitted_at: "2025-11-01T03:00:00Z", decided_at: "2025-11-05T03:00:00Z", created_at: "2025-10-20T03:00:00Z" },
  ];
  await open("portal/applicant/history/", {
    session: SESSION, aal: "aal1",
    rpc: { my_roles: { data: [{ role: "applicant" }] } },
    tables: { applications: { data: HIST } },
  });
  const e = await txt();
  ok("两条历史都列出来了", /正式 B\.Th/.test(e) && /共同学习/.test(e), e.slice(0, 100));
  ok("未通过与已撤回分别标出", /未通过/.test(e) && /已撤回/.test(e));
  ok("显示了给申请人看的说明", /材料不完整/.test(e));
  ok("查询的是 applications 表",
     (await calls()).some((c) => c.kind === "select" && c.table === "applications"));
  ok("页面未调用 my_application（那个刻意排除了历史）",
     !(await calls()).some((c) => c.kind === "rpc" && c.name === "my_application"));

  // ════════════ F history 时间线按 id 取 ════════════
  console.log("\n=== F 历史申请：时间线按**该份**申请的 id 取 ===");
  await cdp.ev(`(()=>{window.__SCEN.rpc.my_application_timeline = { data: [
      { to_status:"submitted", applicant_visible_message:null, created_at:"2026-02-01T03:00:00Z" },
      { to_status:"rejected", applicant_visible_message:"材料不完整", created_at:"2026-02-10T03:00:00Z" }]};
    return true;})()`);
  await cdp.clickReal('[data-tl="app-1"]');
  await sleep(500);
  const tlCall = (await calls()).filter((x) => x.kind === "rpc" && x.name === "my_application_timeline").pop();
  ok("调用了 my_application_timeline", !!tlCall);
  ok("传的是被点开那一份的 id（不是当前申请）",
     !!tlCall && tlCall.args && tlCall.args.p_app === "app-1", JSON.stringify(tlCall && tlCall.args));
  ok("时间线内容显示出来了", /未通过/.test(await txt()));

  // ════════════ G history 时间线失败 ════════════
  console.log("\n=== G 历史申请：时间线取不到时如实报错、可重试 ===");
  await open("portal/applicant/history/", {
    session: SESSION, aal: "aal1",
    rpc: { my_roles: { data: [{ role: "applicant" }] },
           my_application_timeline: { error: { message: "timeline down" } } },
    tables: { applications: { data: HIST } },
  });
  await cdp.clickReal('[data-tl="app-1"]');
  await sleep(500);
  ok("失败时显示错误而不是空的时间线",
     (await cdp.ev(`(()=>{const b=document.querySelector('[data-app="app-1"] .tl');
       return !!b && !b.hidden && /err/.test(b.innerHTML);})()`)) === true);
  ok("失败后按钮仍可再点（没标成已加载）",
     (await cdp.ev(`document.querySelector('[data-tl="app-1"]').dataset.loaded !== "1"`)) === true);

  // ════════════ H history 空态 ════════════
  console.log("\n=== H 历史申请：空态给出去处 ===");
  await open("portal/applicant/history/", {
    session: SESSION, aal: "aal1",
    rpc: { my_roles: { data: [{ role: "applicant" }] } },
    tables: { applications: { data: [] } },
  });
  const h = await txt();
  ok("空态说清楚没有历史", /还没有历史记录/.test(h), h.slice(0, 80));
  ok("空态给出「去我的申请」的出口", /去我的申请/.test(h));

  // ════════════ I 越权：学生打不开申请者页 ════════════
  console.log("\n=== I 越权：角色不符时被守卫拦下 ===");
  await open("portal/applicant/history/", {
    session: SESSION, aal: "aal1",
    rpc: { my_roles: { data: [{ role: "student" }] } },
    tables: { applications: { data: HIST } },
  });
  await sleep(700);
  const i = await cdp.ev(`({ path: location.pathname, body: (document.body.textContent||"").slice(0,60) })`);
  ok("学生角色不会停在申请者历史页",
     !/applicant\/history/.test(i.path) || !/历史申请/.test(i.body),
     JSON.stringify(i));
  ok("越权时没有把历史数据渲染出来", !/材料不完整/.test(i.body), i.body);

  // ════════════ J 审核台：aal1 被 MFA 闸拦下 ════════════
  console.log("\n=== J 审核台：未完成 MFA 时不放行 ===");
  await open("portal/admin/teachers/", {
    session: SESSION, aal: "aal1",
    rpc: { my_roles: { data: [{ role: "super_admin" }] } },
    tables: { teacher_verification_requests: { data: [] } },
  });
  await sleep(700);
  const j = await cdp.ev(`({ path: location.pathname + location.search, body:(document.body.textContent||"").slice(0,60) })`);
  ok("aal1 的管理员不会停在审核台", /mfa/.test(j.path) || !/教师验证审核/.test(j.body), JSON.stringify(j));

  // ════════════ K 审核台：正常列出待审 ════════════
  console.log("\n=== K 审核台：列出待审申请 ===");
  const TVR = [{ id: "tv-1", user_id: "u-9", status: "submitted",
    submitted_data: { name: "王教师", org: "某教会", areas: "新约", country: "泰国 · Asia/Bangkok", phone: "0811111111" },
    submitted_at: "2026-03-01T03:00:00Z", reviewed_at: null,
    applicant_visible_message: null, created_at: "2026-02-25T03:00:00Z" }];
  await open("portal/admin/teachers/", {
    session: SESSION, aal: "aal2",
    rpc: { my_roles: { data: [{ role: "super_admin" }] } },
    tables: { teacher_verification_requests: { data: TVR } },
  });
  const k = await txt();
  ok("进入了审核台", /教师验证审核/.test(k), k.slice(0, 60));
  ok("列出了待审记录", /王教师/.test(k) && /某教会/.test(k));
  ok("待审状态下给出三个动作", (await cdp.ev(
    `[...document.querySelectorAll('[data-act]')].map(b=>b.dataset.act).sort().join(",")`)) === "approve,needs_information,reject");
  ok("不显示内部备注字段", !/内部备注/.test(k));

  // ════════════ L 审核台：改变身份的动作必须填理由 ════════════
  console.log("\n=== L 审核台：不通过必须填理由 ===");
  await cdp.clickReal('[data-act="reject"]');
  await sleep(400);
  ok("没填理由时不发起审核",
     !(await calls()).some((x) => x.kind === "fn"), JSON.stringify(await calls()));
  ok("提示先填写审核说明", /请先填写审核说明/.test(await txt()));

  // ════════════ M 审核台：成功 / 失败 / 不自动重发 ════════════
  // 审核是**不可逆**动作：拿不到确认时绝不能说成功，更不能替用户重发。
  console.log("");
  console.log("=== M 审核台：审核成功与失败的处理 ===");

  /* callFn 是 auth.js 上的方法，stub 覆盖不到，这里直接替换它并记账。
     每个用例自己设定它的返回，模拟 Edge 的各种回应。 */
  const armFn = async (result) => cdp.ev(`(()=>{
    window.__fnCalls = [];
    window.AmasAuth.callFn = function(name, body){
      window.__fnCalls.push({ name: name, body: body });
      return Promise.resolve(${JSON.stringify(result)});
    };
    return true;})()`);
  const fnCalls = async () => cdp.ev(`window.__fnCalls || []`);
  const reject = async (reason) => {
    await cdp.ev(`(()=>{const t=document.querySelector(".rq textarea"); t.value=${JSON.stringify(reason)};
      t.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
    // confirmDialog 会弹确认框，自动确认掉（这是站内既有组件，不是被测对象）
    await cdp.ev(`window.AmasUI.confirmDialog = function(){ return Promise.resolve(true); };`);
    await cdp.clickReal('[data-act="reject"]');
    await sleep(600);
  };

  // M1 成功
  await open("portal/admin/teachers/", {
    session: SESSION, aal: "aal2",
    rpc: { my_roles: { data: [{ role: "super_admin" }] } },
    tables: { teacher_verification_requests: { data: TVR } },
  });
  await armFn({ status: 200, data: { ok: true } });
  await reject("材料与邀请信息不符");
  const m1 = await fnCalls();
  ok("M1 调用的是 review-teacher-verification",
     m1.length === 1 && m1[0].name === "review-teacher-verification", JSON.stringify(m1));
  ok("M1 传了 request_id / action / message",
     m1.length === 1 && m1[0].body.request_id === "tv-1" &&
     m1[0].body.action === "reject" && m1[0].body.message === "材料与邀请信息不符",
     JSON.stringify(m1[0] && m1[0].body));
  /* 查 toast 而不是卡内提示：卡内那条 900ms 后会被 load() 重渲染抹掉，
     断言时机会踩竞态。toast 挂在 body 上，是真正活得住的那个回执。 */
  ok("M1 成功后给出活得住的回执（toast）",
     /审核已执行/.test(await cdp.ev(`(document.getElementById("amas-toast")||{}).textContent||""`)),
     await txt());

  // M2 服务端出错：不能说成功，也不能自动重发
  await open("portal/admin/teachers/", {
    session: SESSION, aal: "aal2",
    rpc: { my_roles: { data: [{ role: "super_admin" }] } },
    tables: { teacher_verification_requests: { data: TVR } },
  });
  await armFn({ status: 500, data: { error: "server_error" } });
  await reject("材料不符");
  const m2 = await fnCalls();
  const t2 = await txt();
  ok("M2 服务端出错时**只发了一次**，没有自动重发", m2.length === 1, `发了 ${m2.length} 次`);
  ok("M2 不显示「已执行」", !/已执行/.test(t2), t2.slice(-90));
  ok("M2 明说无法确认是否已生效", /无法确认/.test(t2), t2.slice(-110));
  ok("M2 提示去刷新查看而不是直接重试", /刷新/.test(t2), t2.slice(-110));

  // M3 状态已变（409）：如实说，别人可能刚处理过
  await open("portal/admin/teachers/", {
    session: SESSION, aal: "aal2",
    rpc: { my_roles: { data: [{ role: "super_admin" }] } },
    tables: { teacher_verification_requests: { data: TVR } },
  });
  await armFn({ status: 409, data: { error: "invalid_state" } });
  await reject("材料不符");
  const t3 = await txt();
  ok("M3 状态冲突时不说成功", !/已执行/.test(t3));
  ok("M3 说明状态已变、请刷新", /状态已经变了|刷新/.test(t3), t3.slice(-110));
  ok("M3 同样只发一次", (await fnCalls()).length === 1);

  // M4 权限不足（403）
  await open("portal/admin/teachers/", {
    session: SESSION, aal: "aal2",
    rpc: { my_roles: { data: [{ role: "super_admin" }] } },
    tables: { teacher_verification_requests: { data: TVR } },
  });
  await armFn({ status: 403, data: { error: "forbidden" } });
  await reject("材料不符");
  const t4 = await txt();
  ok("M4 服务端拒绝时如实转达没有权限", /没有审核权限/.test(t4), t4.slice(-90));
  ok("M4 不显示「已执行」", !/已执行/.test(t4));

  // M5 外发审计
  ok("M5 全程零真实外发", externalHits === 0, `externalHits=${externalHits}`);

  /* ════════════ T 教师空间：工作台与我的资料 ════════════
     教师空间原来是四个空间里唯一**没有导航条**的（工作台直接用 requireRoleAal2，
     没走 Shell），于是新页面根本无从进入。本段同时验证迁移后的工作台与新资料页。 */
  console.log("");
  console.log("=== T 教师空间 ===");

  const TEACHER = { session: SESSION, aal: "aal2",
    rpc: { my_roles: { data: [{ role: "teacher" }] },
           my_profile: { data: Object.assign({}, PROFILE, { display_name: "王教师" }) } } };
  const TP_ROW = { staff_number: "T-0007", public_name: "王教师", public_bio: "新约与讲道学",
    status: "active", verified_at: "2026-01-10T02:00:00Z", verification_expires_at: null };

  // T1 工作台：有档案
  await open("portal/teacher/", Object.assign({}, TEACHER, {
    tables: { teacher_profiles: { data: TP_ROW } } }));
  const tc_t1 = await txt();
  ok("T1 工作台进得去", /教师工作台/.test(tc_t1), tc_t1.slice(0, 50));
  ok("T1 显示工号与在职状态", /T-0007/.test(tc_t1) && /在职/.test(tc_t1), tc_t1.slice(0, 120));
  ok("T1 工作台现在有导航条（Shell 已接管）",
     (await cdp.ev(`!!document.querySelector(".portal-shell .pn")`)) === true);
  ok("T1 导航里有「我的资料」",
     (await cdp.ev(`[...document.querySelectorAll(".pn a")].some(a=>/我的资料/.test(a.textContent||""))`)) === true);
  ok("T1 未开通的四项不是可点链接（点进去空无一物比看见「即将开通」更糟）",
     (await cdp.ev(`document.querySelectorAll(".spaces a").length`)) === 0);

  // T2 工作台：还没有档案 —— 与「读取出错」必须分开说
  await open("portal/teacher/", Object.assign({}, TEACHER, {
    tables: { teacher_profiles: { data: null } } }));
  const tc_t2 = await txt();
  ok("T2 没有档案时说「还没有」而不是「读取失败」",
     /还没有教职档案/.test(tc_t2) && !/读不到/.test(tc_t2), tc_t2.slice(0, 120));

  // T3 工作台：读取出错
  await open("portal/teacher/", Object.assign({}, TEACHER, {
    tables: { teacher_profiles: { error: { message: "boom" } } } }));
  const tc_t3 = await txt();
  ok("T3 读取出错时说读不到并提示刷新（不谎称没有档案）",
     /读不到教职档案/.test(tc_t3) && !/还没有教职档案/.test(tc_t3), tc_t3.slice(0, 120));

  // T4 资料页：正常读取
  await open("portal/teacher/profile/", Object.assign({}, TEACHER, {
    tables: { teacher_profiles: { data: TP_ROW } } }));
  const tc_t4 = await txt();
  ok("T4 资料页进得去", /我的资料/.test(tc_t4), tc_t4.slice(0, 50));
  ok("T4 联系字段填进了输入框",
     (await cdp.ev(`document.getElementById("nm").value`)) === "王教师");
  ok("T4 教职档案只读显示（工号/状态/对外姓名）",
     /T-0007/.test(tc_t4) && /在职/.test(tc_t4) && /新约与讲道学/.test(tc_t4), tc_t4.slice(0, 160));
  ok("T4 明确标注由教务维护", /由教务维护/.test(tc_t4));
  ok("T4 教职档案**不给**编辑控件（该表对 authenticated 已撤销写权限）",
     (await cdp.ev(`(()=>{const f=document.getElementById("f");
       const all=[...document.querySelectorAll("input,textarea")];
       return all.every(el => f.contains(el));})()`)) === true,
     "教职档案区出现了可编辑控件");

  // T5 资料页：保存只经白名单
  await cdp.ev(`(()=>{document.getElementById("ph").value="0812345678";
    document.getElementById("ph").dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
  await cdp.clickReal("#save");
  await sleep(500);
  const tc_t5 = (await calls()).filter((c) => c.kind === "rpc" && c.name === "update_my_contact").pop();
  ok("T5 保存走 update_my_contact", !!tc_t5);
  ok("T5 只传白名单三参数",
     !!tc_t5 && Object.keys(tc_t5.args).sort().join(",") === "p_contact_note,p_display_name,p_phone",
     tc_t5 ? JSON.stringify(tc_t5.args) : "");
  ok("T5 成功后显示已保存", /已保存/.test(await txt()));

  // T6 资料页：教职档案取不到时，联系方式仍可用
  await open("portal/teacher/profile/", Object.assign({}, TEACHER, {
    tables: { teacher_profiles: { error: { message: "boom" } } } }));
  const tc_t6 = await txt();
  ok("T6 教职档案读不到时页面照常可用（不整页报错）",
     /我的资料/.test(tc_t6) && !!(await cdp.ev(`!!document.getElementById("nm")`)), tc_t6.slice(0, 80));
  ok("T6 教职档案区如实说读不到", /读不到教职档案/.test(tc_t6), tc_t6.slice(0, 140));

  // T7 权限：学生打不开教师页
  await open("portal/teacher/profile/", {
    session: SESSION, aal: "aal2",
    rpc: { my_roles: { data: [{ role: "student" }] }, my_profile: { data: PROFILE } },
    tables: { teacher_profiles: { data: TP_ROW } },
  });
  await sleep(700);
  const tc_t7 = await cdp.ev(`({ path: location.pathname, body:(document.body.textContent||"").slice(0,60) })`);
  ok("T7 学生角色不会停在教师资料页", !/teacher\/profile/.test(tc_t7.path), JSON.stringify(tc_t7));
  ok("T7 越权时不渲染教职档案", !/T-0007/.test(tc_t7.body), tc_t7.body);

  // T8 MFA：aal1 的教师被挡
  await open("portal/teacher/profile/", {
    session: SESSION, aal: "aal1",
    rpc: { my_roles: { data: [{ role: "teacher" }] }, my_profile: { data: PROFILE } },
    tables: { teacher_profiles: { data: TP_ROW } },
  });
  await sleep(700);
  const tc_t8 = await cdp.ev(`location.pathname + location.search`);
  ok("T8 aal1 的教师被 MFA 闸拦下", /mfa/.test(tc_t8) || !/teacher\/profile/.test(tc_t8), tc_t8);

  /* ════════════ P 沿**真实链路**验证未知结果 ════════════
     前面 M 段是直接 stub A.callFn 的返回值 —— 那只测了页面对 error 对象的反应，
     跳过了 auth.js 的 callFn 与 api.js 的 fn 两层。真正的坑恰恰在那两层：
       · callFn 的 fetch 原本**没有 try/catch**，网络异常会一路抛穿页面的 await，
         按钮卡在禁用态、一句提示都没有；
       · 非 JSON 响应（网关 HTML）会让 data 为 null，走到 unknown 「请稍后再试」——
         对不可逆的审核动作，这是错误建议。
     这一段把真实 callFn 留在链路里，只替换最底层的 window.fetch 来造夹具。 */
  console.log("");
  console.log("=== P 真实链路 callFn → Api.fn → 页面（网络异常 / 非 JSON / 未知状态）===");

  /** 只换最底层 fetch，callFn 与 Api.fn 都保持真身。kind 决定这次 fetch 怎么失败。 */
  const armFetch = async (kind) => cdp.ev(`(()=>{
    window.__fetchHits = 0;
    const orig = window.fetch;
    window.fetch = function(u, opt){
      if (String(u).indexOf("/functions/v1/") < 0) return orig.apply(this, arguments);
      window.__fetchHits++;
      const k = ${JSON.stringify(kind)};
      if (k === "throw")  return Promise.reject(new TypeError("Failed to fetch"));
      if (k === "html")   return Promise.resolve(new Response("<html>502 Bad Gateway</html>",
                              { status: 502, headers: { "Content-Type": "text/html" } }));
      if (k === "empty")  return Promise.resolve(new Response("", { status: 200 }));
      if (k === "ok")     return Promise.resolve(new Response(JSON.stringify({ ok: true }),
                              { status: 200, headers: { "Content-Type": "application/json" } }));
      if (k === "refuse") return Promise.resolve(new Response(JSON.stringify({ error: "forbidden" }),
                              { status: 403, headers: { "Content-Type": "application/json" } }));
      return orig.apply(this, arguments);
    };
    return true;})()`);
  const fetchHits = async () => cdp.ev(`window.__fetchHits || 0`);
  const cardState = async () => cdp.ev(`(()=>{
    const c = document.querySelector(".rq");
    if (!c) return { 无卡片: true };
    return {
      动作按钮数: c.querySelectorAll("[data-act]").length,
      有刷新核实: !!c.querySelector("[data-verify]"),
      有理由框: !!c.querySelector("textarea"),
      提示: (c.querySelector(".msg.err, .msg.warn") || {}).textContent || "",
    };})()`);

  const openReview = async () => {
    await open("portal/admin/teachers/", {
      session: SESSION, aal: "aal2",
      rpc: { my_roles: { data: [{ role: "super_admin" }] } },
      tables: { teacher_verification_requests: { data: TVR } },
    });
    await cdp.ev(`window.AmasUI.confirmDialog = function(){ return Promise.resolve(true); };`);
  };
  const doReject = async () => {
    await cdp.ev(`(()=>{const t=document.querySelector(".rq textarea");
      if(t){ t.value="材料与邀请信息不符"; t.dispatchEvent(new Event("input",{bubbles:true})); }
      return true;})()`);
    await cdp.clickReal('[data-act="reject"]');
    await sleep(700);
  };

  // P1 网络异常：fetch 直接抛
  await openReview();
  await armFetch("throw");
  await doReject();
  const p1 = await cardState();
  ok("P1 网络异常时页面没有僵死（给出了结论）", p1.提示.length > 0, JSON.stringify(p1));
  ok("P1 明说无法确认是否已生效", /无法确认/.test(p1.提示), p1.提示.slice(0, 50));
  ok("P1 不再是「请稍后再试」那句通用文案",
     !/请稍后再试/.test(p1.提示), p1.提示.slice(0, 50));
  ok("P1 动作按钮已撤掉（不能直接重复同一审核）", p1.动作按钮数 === 0, JSON.stringify(p1));
  ok("P1 给出「刷新核实」入口", p1.有刷新核实 === true);
  ok("P1 只发了一次请求", (await fetchHits()) === 1, `发了 ${await fetchHits()} 次`);

  // P2 非 JSON 响应（网关 HTML）
  await openReview();
  await armFetch("html");
  await doReject();
  const p2 = await cardState();
  ok("P2 非 JSON 响应同样归为无法确认", /无法确认/.test(p2.提示), p2.提示.slice(0, 50));
  ok("P2 动作按钮已撤掉", p2.动作按钮数 === 0);
  ok("P2 给出「刷新核实」入口", p2.有刷新核实 === true);

  // P3 200 但空响应
  await openReview();
  await armFetch("empty");
  await doReject();
  const p3 = await cardState();
  ok("P3 200 空响应不当成成功", !/已执行/.test(p3.提示) && p3.提示.length > 0, p3.提示.slice(0, 50));
  ok("P3 同样锁住并给核实入口", p3.动作按钮数 === 0 && p3.有刷新核实 === true, JSON.stringify(p3));

  // P4 锁住之后：核实前不能再对同一条执行审核
  const beforeVerify = await fetchHits();
  await cdp.ev(`(()=>{const b=document.querySelector(".rq [data-act]"); if(b) b.click(); return true;})()`);
  await sleep(400);
  ok("P4 核实前无法再触发同一条审核", (await fetchHits()) === beforeVerify,
     `又发了 ${(await fetchHits()) - beforeVerify} 次`);

  // P5 点「刷新核实」后重新按真实状态渲染，解除锁定
  await cdp.clickReal("[data-verify]");
  await sleep(700);
  const p5 = await cardState();
  ok("P5 核实后恢复按状态给出的动作", p5.动作按钮数 > 0 && p5.有刷新核实 === false, JSON.stringify(p5));

  // P6 明确拒绝（403）：这是能证明「没执行」的，允许直接重来
  await openReview();
  await armFetch("refuse");
  await doReject();
  const p6 = await cardState();
  ok("P6 403 如实说没有权限且未执行", /没有审核权限/.test(p6.提示), p6.提示.slice(0, 50));
  ok("P6 明确拒绝不锁死（可以改条件再来）", p6.动作按钮数 > 0 && p6.有刷新核实 === false, JSON.stringify(p6));

  // P7 真实链路下的成功
  await openReview();
  await armFetch("ok");
  await doReject();
  ok("P7 真实链路成功时给出 toast 回执",
     /审核已执行/.test(await cdp.ev(`(document.getElementById("amas-toast")||{}).textContent||""`)));

  // P8 在途竞态：审核在途时切筛选，旧结果不得盖掉新列表
  console.log("");
  console.log("=== P8 切筛选的在途竞态 ===");
  await open("portal/admin/teachers/", {
    session: SESSION, aal: "aal2",
    rpc: { my_roles: { data: [{ role: "super_admin" }] } },
    tables: { teacher_verification_requests: { data: TVR } },
  });
  // 让 select 变慢，然后在它回来之前切筛选
  await cdp.ev(`(()=>{
    window.__slow = true;
    const c = window.AmasApi;
    const origSelect = c.select;
    c.select = function(t, b){
      if (window.__slow) {
        window.__slow = false;                       // 只慢第一次
        return new Promise(res => setTimeout(() => res(origSelect(t, b)), 1200));
      }
      return origSelect(t, b);
    };
    return true;})()`);
  await cdp.ev(`(()=>{const b=document.querySelector('[data-f="approved"]'); if(b) b.click(); return true;})()`);
  await sleep(2200);
  const p8 = await cdp.ev(`(()=>{
    const on = document.querySelector('.tab[aria-pressed="true"]');
    return { 选中的筛选: on ? on.dataset.f : "", 卡片数: document.querySelectorAll(".rq").length };})()`);
  ok("P8 慢响应回来后，显示的筛选与选中的一致（旧结果没盖新的）",
     p8.选中的筛选 === "approved", JSON.stringify(p8));

  // ════════════ N 负向控制 ════════════
  console.log("");
  console.log("=== N 负向控制：绿必须能转红 ===");
  ok("N1 txt() 确实剥掉了脚本源码（否则 K/M 的断言会命中注释而假绿）",
     !/teacher_verification_internal/.test(await txt()),
     "剥离没生效，页面文字里混进了脚本源码");
  await open("portal/applicant/history/", {
    session: SESSION, aal: "aal1",
    rpc: { my_roles: { data: [{ role: "applicant" }] } },
    tables: { applications: { data: [] } },
  });
  ok("N2 没有数据时确实不会凭空渲染出条目",
     !/正式 B\.Th 申请/.test(await txt()));

  /* N3 把 callFn 的 try/catch 还原成「不兜住」，网络异常就会抛穿页面的 await——
     按钮停在禁用态、没有任何提示。这条证明 P1 的绿来自共享层那个修复，
     而不是别的什么东西顺手救了场。 */
  await open("portal/admin/teachers/", {
    session: SESSION, aal: "aal2",
    rpc: { my_roles: { data: [{ role: "super_admin" }] } },
    tables: { teacher_verification_requests: { data: TVR } },
  });
  await cdp.ev(`window.AmasUI.confirmDialog = function(){ return Promise.resolve(true); };`);
  await cdp.ev(`(()=>{
    // 还原成「抛出去」的老行为
    window.AmasAuth.callFn = function(){ return Promise.reject(new TypeError("Failed to fetch")); };
    return true;})()`);
  await cdp.ev(`(()=>{const t=document.querySelector(".rq textarea");
    if(t){ t.value="x"; t.dispatchEvent(new Event("input",{bubbles:true})); } return true;})()`);
  await cdp.clickReal('[data-act="reject"]');
  await sleep(700);
  const n3 = await cdp.ev(`(()=>{const c=document.querySelector(".rq");
    const b=c.querySelector('[data-act="reject"]');
    return { 按钮仍禁用: !!b && b.disabled,
             无任何提示: !(c.querySelector(".msg.err,.msg.warn")||{}).textContent };})()`);
  ok("N3 还原成抛异常后，页面确实僵死（证明 P1 的绿来自 callFn 的修复）",
     n3.按钮仍禁用 === true && n3.无任何提示 === true, JSON.stringify(n3));

  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + e.message);
} finally { chrome.kill(); server.close(); }

console.log(`\n${pass}/${pass + fail} 通过`);
console.log("本套件全程本地 stub：无真实凭据、无真实身份、未对远端写入、未发起任何外网请求。");
console.log("全绿只证明「给定这些返回值时页面做对了事」，**不代表线上可用**。");
process.exit(fail ? 1 : 0);
