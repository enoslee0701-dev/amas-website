// PORTAL-1 · 浏览器层验收：console 错误、移动端 390px 溢出、未登录守卫、键盘可达性
// 用法：node portal1_ui.mjs   （需本地 http.server 在 8090，Chrome 已装）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://127.0.0.1:8090";
// staging.env 只放在本机运行目录，绝不入库（见 supabase/tests/README.md）
const ENV = Object.fromEntries(fs.readFileSync(process.env.AMAS_ENV || "staging.env", "utf8").trim().split("\n").map(l => l.split("=").map(s => s.trim())).map(([k, ...v]) => [k, v.join("=")]));

// 测试自建账号、跑完自删：不依赖任何预先存在的数据，可重复运行
const TAG = Date.now().toString(36);
const UI_EMAIL = `p1ui-${TAG}@amas-test.dev`;
const UI_PW = "P1Ui!2026x";
let uiUserId = null;
const svc = (p, o = {}) => fetch(`${ENV.URL}${p}`, {
  ...o, headers: { apikey: ENV.SERVICE, Authorization: `Bearer ${ENV.SERVICE}`,
                   "Content-Type": "application/json", ...(o.headers || {}) },
});

const results = [];
const rec = (id, name, ok, detail = "") => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${detail ? " | " + detail : ""}`);
};

// ---------- 最小 CDP 客户端 ----------
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.subs = []; }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pend.has(m.id)) {
        const { res, rej } = c.pend.get(m.id); c.pend.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) c.subs.forEach(f => f(m));
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(fn) { this.subs.push(fn); }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 启动 Chrome ----------
const profile = path.join(os.tmpdir(), "amas-portal1-chrome");
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=9333", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

async function browserWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch("http://127.0.0.1:9333/json/version");
      return (await r.json()).webSocketDebuggerUrl;
    } catch { await sleep(300); }
  }
  throw new Error("chrome devtools not reachable");
}

/** 打开一页，收集 console 错误 / 未捕获异常 / 失败请求，返回 page 句柄 */
async function open(browser, url, { width = 1280, height = 900, mobile = false } = {}) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const page = {
    errors: [], reqfail: [],
    send: (m, p = {}) => browser.send(m, p).catch(e => { throw e; }),
  };
  // flatten 模式：直接在 browser 连接上带 sessionId 转发
  const raw = (method, params = {}) => new Promise((res, rej) => {
    const id = ++browser.id;
    browser.pend.set(id, { res, rej });
    browser.ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  page.raw = raw;
  browser.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") {
      page.errors.push("exception: " + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      page.errors.push("console.error: " + m.params.args.map(a => a.description || a.value).join(" "));
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      page.errors.push("log: " + m.params.entry.text + " " + (m.params.entry.url || ""));
    }
    if (m.method === "Network.loadingFailed") page.reqfail.push(m.params.errorText);
  });
  await raw("Runtime.enable"); await raw("Log.enable"); await raw("Network.enable"); await raw("Page.enable");
  await raw("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await raw("Page.navigate", { url });
  await sleep(3200);
  page.eval = async (expr) => {
    const r = await raw("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
    return r.result.value;
  };
  page.close = () => browser.send("Target.closeTarget", { targetId });
  return page;
}

const wsUrl = await browserWs();
const browser = await CDP.attach(wsUrl);

const PAGES = [
  ["P1-U01", "申请者中心", "/portal/applicant/"],
  ["P1-U02", "申请表", "/portal/applicant/application/"],
  ["P1-U03", "招生审核台", "/portal/admin/admissions/"],
];

try {
  // ============ 1. 未登录守卫：三页都必须跳到登录页，且不泄露业务内容 ============
  for (const [id, name, path] of PAGES) {
    const p = await open(browser, BASE + path);
    const info = await p.eval(`JSON.stringify({href:location.href, text:document.body.innerText.slice(0,400)})`);
    const { href, text } = JSON.parse(info);
    const redirected = /\/login\//.test(href);
    rec(`${id}a`, `${name} 未登录跳转登录页`, redirected, `href=${href.replace(BASE, "")}`);
    rec(`${id}b`, `${name} 未登录不渲染业务数据`, !/申请编号|内部备注|审核台列表/.test(text), `len=${text.length}`);
    rec(`${id}c`, `${name} 未登录态无 console 错误`, p.errors.length === 0, p.errors.slice(0, 2).join(" ; ").slice(0, 160));
    await p.close();
  }

  // ============ 2. 登录申请人，跑真实闭环 UI ============
  const seeded = await (await svc("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({
    email: UI_EMAIL, password: UI_PW, email_confirm: true,
    user_metadata: { display_name: "UI 测试申请人" },
  }) })).json();
  uiUserId = seeded.id;

  const login = await open(browser, BASE + "/login/");
  await login.eval(`(async()=>{
    const c = window.supabase.createClient(${JSON.stringify(ENV.URL)}, ${JSON.stringify(ENV.ANON)});
    const r = await c.auth.signInWithPassword({email:${JSON.stringify(UI_EMAIL)}, password:${JSON.stringify(UI_PW)}});
    return r.error ? r.error.message : "ok";
  })()`).catch(() => null);
  const who = await login.eval(`(async()=>{const s=await window.AmasAuth.getSession();return s? s.user.email : "none";})()`);
  rec("P1-U04", "申请人可登录（复用会话）", who !== "none", `user=${who}`);
  await login.close();

  if (who !== "none") {
    // 桌面：申请者中心
    const home = await open(browser, BASE + "/portal/applicant/");
    const h = JSON.parse(await home.eval(`JSON.stringify({
      href: location.href,
      h1: (document.querySelector("h1")||{}).innerText || "",
      hasNav: !!document.querySelector("nav, .pnav, .bottombar"),
      skip: !!document.querySelector("a[href='#main'], .skip"),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    })`));
    rec("P1-U05", "登录后进入申请者中心", /portal\/applicant/.test(h.href) && /欢迎/.test(h.h1), `h1=${h.h1.slice(0, 20)}`);
    rec("P1-U06", "门户外壳含导航与跳过链接", h.hasNav && h.skip, `nav=${h.hasNav} skip=${h.skip}`);
    rec("P1-U07", "桌面 1280px 无横向溢出", h.overflow <= 0, `overflow=${h.overflow}px`);
    rec("P1-U08", "申请者中心无 console 错误", home.errors.length === 0, home.errors.slice(0, 2).join(" ; ").slice(0, 160));
    await home.close();

    // 移动端 390px
    for (const [id, name, path] of PAGES.slice(0, 2)) {
      const m = await open(browser, BASE + path, { width: 390, height: 844, mobile: true });
      const r = JSON.parse(await m.eval(`(()=>{
        const de=document.documentElement;
        const wide=[...document.querySelectorAll("body *")].filter(e=>e.getBoundingClientRect().right>391.5)
          .map(e=>e.tagName+"."+(e.className&&e.className.baseVal===undefined?String(e.className).slice(0,24):"")).slice(0,3);
        const small=[...document.querySelectorAll("button, a.btn, input, select")]
          .filter(e=>{const b=e.getBoundingClientRect();return b.height>0&&b.height<40;})
          .map(e=>e.tagName+"#"+(e.id||"")+"."+String(e.className||"").slice(0,20)+"@"+Math.round(e.getBoundingClientRect().height));
        return JSON.stringify({overflow:de.scrollWidth-de.clientWidth, wide, small});
      })()`));
      rec(`${id}m1`, `${name} 移动端 390px 无横向溢出`, r.overflow <= 0, `overflow=${r.overflow}px ${r.wide.join(",")}`);
      rec(`${id}m2`, `${name} 触控目标 ≥40px`, r.small.length === 0, `undersized=${r.small.join(" , ")}`);
      rec(`${id}m3`, `${name} 移动端无 console 错误`, m.errors.length === 0, m.errors.slice(0, 2).join(" ; ").slice(0, 160));
      await m.close();
    }

    // 申请表：先确保有草稿（空状态 → 点「开始填写正式申请」）
    const form = await open(browser, BASE + "/portal/applicant/application/");
    const startBtn = await form.eval(`(()=>{
      const b=[...document.querySelectorAll("button,a")].find(e=>/开始填写正式申请/.test(e.innerText||""));
      if(b){b.click();return true;} return false;})()`);
    rec("P1-U08b", "无申请时展示空状态并可创建草稿", startBtn === true || (await form.eval(`!!document.getElementById("appForm")`)), `clickedStart=${startBtn}`);
    await sleep(2500);
    const f = JSON.parse(await form.eval(`(()=>{
      const focusables=[...document.querySelectorAll("a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])")];
      const labeled=[...document.querySelectorAll("input,select,textarea")].filter(e=>{
        const id=e.id; return (id&&document.querySelector("label[for='"+CSS.escape(id)+"']"))||e.closest("label")||e.getAttribute("aria-label");
      }).length;
      const total=document.querySelectorAll("input,select,textarea").length;
      const badTab=[...document.querySelectorAll("[tabindex]")].filter(e=>+e.getAttribute("tabindex")>0).length;
      const unlabeled=[...document.querySelectorAll("input,select,textarea")].filter(e=>{
        const id=e.id; return !((id&&document.querySelector("label[for='"+CSS.escape(id)+"']"))||e.closest("label")||e.getAttribute("aria-label"));
      }).map(e=>e.tagName+"["+(e.name||e.dataset.f||e.type||"?")+"]").slice(0,5);
      return JSON.stringify({focusables:focusables.length, labeled, total, badTab, unlabeled,
        hasForm:!!document.getElementById("appForm"), steps:document.querySelectorAll("#stepBar button,[data-step]").length});
    })()`));
    rec("P1-U08c", "草稿建立后渲染分步表单", f.hasForm && f.steps >= 5, `form=${f.hasForm} steps=${f.steps}`);
    rec("P1-U09", "申请表所有输入均有可及标签", f.total > 0 && f.labeled === f.total, `${f.labeled}/${f.total} bad=${(f.unlabeled||[]).join(",")}`);
    rec("P1-U10", "无正数 tabindex 破坏焦点顺序", f.badTab === 0, `positive tabindex=${f.badTab}`);
    rec("P1-U11", "申请表可键盘聚焦元素充足", f.focusables >= 5, `focusables=${f.focusables}`);
    rec("P1-U12", "申请表无 console 错误", form.errors.length === 0, form.errors.slice(0, 2).join(" ; ").slice(0, 160));
    await form.close();

    // 越权：申请人打开审核台必须被拒（不是只藏按钮）
    const deny = await open(browser, BASE + "/portal/admin/admissions/");
    const d = JSON.parse(await deny.eval(`JSON.stringify({href:location.href, text:document.body.innerText.slice(0,300)})`));
    // 守卫可跳登录页、跳回自己的空间、或显示无权提示——但绝不能停留在审核台
    rec("P1-U13", "申请人访问审核台被路由守卫拒绝",
      !/\/portal\/admin\/admissions/.test(d.href) || /无权|没有权限|unauthorized/i.test(d.text),
      `href=${d.href.replace(BASE, "")}`);
    const leak = await deny.eval(`document.body.innerText.includes("内部备注")`);
    rec("P1-U14", "越权页面不渲染任何内部数据", leak === false, `internalNoteVisible=${leak}`);
    await deny.close();
  }
} finally {
  if (uiUserId) await svc(`/auth/v1/admin/users/${uiUserId}`, { method: "DELETE" });
  browser.close();
  chrome.kill();
}

const pass = results.filter(r => r.ok).length;
fs.writeFileSync("portal1_ui_results.json", JSON.stringify(results, null, 2));
console.log(`\n=== PORTAL-1 UI: ${pass}/${results.length} PASSED ===`);
if (pass !== results.length) process.exitCode = 1;
