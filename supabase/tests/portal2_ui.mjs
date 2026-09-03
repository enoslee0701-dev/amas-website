// PORTAL-2 · 浏览器层验收（路由守卫 / console / 移动端 / 可访问性 / 真实空态）
// 前置：本地站点 http://127.0.0.1:8090，assets/js/supabase-config.js 临时指向 staging（跑完须还原）
// 运行：node supabase/tests/portal2_ui.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://127.0.0.1:8090";
const ENV = Object.fromEntries(fs.readFileSync(process.env.AMAS_ENV || "staging.env", "utf8")
  .trim().split(/\r?\n/).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const results = [];
const rec = (id, name, ok, detail = "") => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${detail ? " | " + detail : ""}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 种子：一名 active 学生 + 一名 pre_enrolled 学生 + 一名 registrar ----------
const H = (key, jwt) => ({ apikey: key, Authorization: `Bearer ${jwt || key}`, "Content-Type": "application/json" });
const admin = (p, o = {}) => fetch(`${ENV.URL}${p}`, { ...o, headers: { ...H(ENV.SERVICE), ...(o.headers || {}) } });
const rest = (p, jwt, o = {}) => fetch(`${ENV.URL}/rest/v1${p}`, { ...o, headers: { ...H(ENV.ANON, jwt), ...(o.headers || {}) } });
const rpc = (n, jwt, b) => rest(`/rpc/${n}`, jwt, { method: "POST", body: JSON.stringify(b || {}) });
const fnc = (n, jwt, b) => fetch(`${ENV.URL}/functions/v1/${n}`, { method: "POST", headers: H(ENV.ANON, jwt), body: JSON.stringify(b || {}) });
function b32decode(s){const A="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let b="",o=[];for(const c of s.replace(/=+$/,"").toUpperCase()){const v=A.indexOf(c);if(v<0)continue;b+=v.toString(2).padStart(5,"0");}for(let i=0;i+8<=b.length;i+=8)o.push(parseInt(b.slice(i,i+8),2));return Buffer.from(o);}
function totp(sec){const k=b32decode(sec);const c=Buffer.alloc(8);c.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const h=createHmac("sha1",k).update(c).digest();const off=h[h.length-1]&0xf;const bin=((h[off]&0x7f)<<24)|(h[off+1]<<16)|(h[off+2]<<8)|h[off+3];return String(bin%1e6).padStart(6,"0");}

const PW = "P2Ui!2026x", tag = Date.now().toString(36);
const E = {
  stu:  `p2ui-stu-${tag}@amas-test.dev`,   // → active 学生
  stu2: `p2ui-pre-${tag}@amas-test.dev`,   // → pre_enrolled 学生
  reg:  `p2ui-reg-${tag}@amas-test.dev`,   // registrar
  app:  `p2ui-app-${tag}@amas-test.dev`,   // 仅 applicant（越权测试）
};
const ids = {}, jwts = {};
const GOOD = {
  name_zh: "界面测试学生", birth_ym: "1995-06", gender: "male", nationality: "中国",
  phone: "+86 13800000000", address: "广州市", church_name: "测试教会",
  church_role: "小组同工", conversion_date: "2015-03", calling: "愿意接受装备",
  testimony: "见证内容。", declaration_accepted: true,
  programs: ["bth"], languages: ["mandarin"],
  education: [{ school: "某大学", city: "广州", start_ym: "2013-09", end_ym: "2017-06", degree: "本科" }],
};

async function seed() {
  for (const [k, email] of Object.entries(E)) {
    const r = await (await admin("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password: PW, email_confirm: true, user_metadata: { display_name: k === "reg" ? "界面测试教务" : "界面测试学生" } }) })).json();
    ids[k] = r.id;
  }
  await admin("/rest/v1/user_roles", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: ids.reg, role: "registrar", granted_by: ids.reg }) });
  for (const k of Object.keys(E)) {
    const r = await (await fetch(`${ENV.URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: H(ENV.ANON), body: JSON.stringify({ email: E[k], password: PW }) })).json();
    jwts[k] = r.access_token;
  }
  // registrar 升 aal2
  const enr = await (await fetch(`${ENV.URL}/auth/v1/factors`, { method: "POST", headers: H(ENV.ANON, jwts.reg), body: JSON.stringify({ factor_type: "totp", friendly_name: "P2UI" }) })).json();
  const ch = await (await fetch(`${ENV.URL}/auth/v1/factors/${enr.id}/challenge`, { method: "POST", headers: H(ENV.ANON, jwts.reg), body: "{}" })).json();
  const ver = await (await fetch(`${ENV.URL}/auth/v1/factors/${enr.id}/verify`, { method: "POST", headers: H(ENV.ANON, jwts.reg), body: JSON.stringify({ challenge_id: ch.id, code: totp(enr.totp.secret) }) })).json();
  const regAal2 = ver.access_token;

  const enroll = async (who, num, activate) => {
    const c = await rest("/applications", jwts[who], { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ applicant_id: ids[who], pathway: "bth", status: "draft", form_data: GOOD }) });
    const appId = (await c.json())[0].id;
    await rpc("submit_application", jwts[who], { p_app: appId });
    await fnc("review-application", regAal2, { application_id: appId, action: "start_review" });
    await fnc("review-application", regAal2, { application_id: appId, action: "accept" });
    await fnc("student-lifecycle", regAal2, { action: "confirm_hq_approval", application_id: appId, hq_status: "approved", approval_reference: "HQ-UI-" + num });
    const cr = await (await fnc("student-lifecycle", regAal2, { action: "create_student_record", application_id: appId, student_number: num })).json();
    if (activate) await fnc("student-lifecycle", regAal2, { action: "activate_student", student_id: cr.student_id, message: "学籍已正式生效" });
    return cr.student_id;
  };
  await enroll("stu", `UI-${tag.toUpperCase()}-A`, true);
  await enroll("stu2", `UI-${tag.toUpperCase()}-B`, false);
  // applicant 账号保留一份 draft，使其保有 applicant 角色
  await rest("/applications", jwts.app, { method: "POST", body: JSON.stringify({ applicant_id: ids.app, pathway: "bth", status: "draft", form_data: GOOD }) });
  return { regAal2 };
}

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

const profile = path.join(os.tmpdir(), "amas-portal2-chrome");
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=9335", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

async function browserWs() {
  for (let i = 0; i < 40; i++) {
    try { return (await (await fetch("http://127.0.0.1:9335/json/version")).json()).webSocketDebuggerUrl; }
    catch { await sleep(300); }
  }
  throw new Error("chrome devtools not reachable");
}

async function open(browser, url, { width = 1280, height = 900, mobile = false, wait = 3200 } = {}) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const page = { errors: [] };
  const raw = (method, params = {}) => new Promise((res, rej) => {
    const id = ++browser.id; browser.pend.set(id, { res, rej });
    browser.ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  browser.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") page.errors.push("exception: " + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") page.errors.push("console.error: " + m.params.args.map(a => a.description || a.value).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") page.errors.push("log: " + m.params.entry.text);
  });
  await raw("Runtime.enable"); await raw("Log.enable"); await raw("Page.enable");
  await raw("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await raw("Page.navigate", { url });
  await sleep(wait);
  page.eval = async (expr) => {
    const r = await raw("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
    return r.result.value;
  };
  page.close = () => browser.send("Target.closeTarget", { targetId });
  return page;
}

const signInAs = (email) => `(async()=>{
  const c = window.supabase.createClient(${JSON.stringify(ENV.URL)}, ${JSON.stringify(ENV.ANON)});
  const r = await c.auth.signInWithPassword({email:${JSON.stringify(email)}, password:${JSON.stringify(PW)}});
  return r.error ? r.error.message : "ok";
})()`;

let browser, chromeUp = false;
try {
  await seed();
  browser = await CDP.attach(await browserWs());
  chromeUp = true;

  // ============ 1. 未登录守卫 ============
  for (const [id, name, p] of [["P2-U01", "学员中心", "/portal/student/"], ["P2-U02", "学籍管理", "/portal/admin/students/"]]) {
    const pg = await open(browser, BASE + p);
    const info = JSON.parse(await pg.eval(`JSON.stringify({href:location.href, text:document.body.innerText.slice(0,400)})`));
    rec(`${id}a`, `${name} 未登录跳转登录页`, /\/login\//.test(info.href), `href=${info.href.replace(BASE, "")}`);
    // 注意：登录页本身有「学号 / 邮箱」输入框，"学号"二字不等于数据泄露；
    // 这里检测的是真实学籍内容——本次种子的学号、学籍状态标签、教务列表标题。
    const leaked = new RegExp(`UI-${tag.toUpperCase()}|待正式注册|在册学生|学籍状态`).test(info.text);
    rec(`${id}b`, `${name} 未登录不渲染任何学籍数据`, !leaked, `len=${info.text.length} leaked=${leaked}`);
    rec(`${id}c`, `${name} 未登录态无 console 错误`, pg.errors.length === 0, pg.errors.slice(0, 2).join(" ; ").slice(0, 150));
    await pg.close();
  }

  // ============ 2. active 学生 ============
  const lg = await open(browser, BASE + "/login/");
  await lg.eval(signInAs(E.stu));
  await lg.close();

  const dash = await open(browser, BASE + "/portal/student/");
  const d = JSON.parse(await dash.eval(`JSON.stringify({
    href: location.href,
    text: document.body.innerText,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    skip: !!document.querySelector("a[href='#main'], .skip"),
    tl: document.querySelectorAll(".tl-item").length
  })`));
  rec("P2-U03", "active 学生可进入学员中心", /portal\/student/.test(d.href), `href=${d.href.replace(BASE, "")}`);
  rec("P2-U04", "身份卡显示真实学号", d.text.includes(`UI-${tag.toUpperCase()}-A`), `hasNumber=${d.text.includes("UI-")}`);
  rec("P2-U05", "学籍状态显示「在读」", d.text.includes("在读"), "");
  rec("P2-U06", "学习空态如实说明（不伪造已注册课程）",
    d.text.includes("当前尚无已注册课程"), "");
  rec("P2-U07", "不显示学分 / 进度百分比 / GPA（credits=null 不得显示 0）",
    !/\d+\s*学分|GPA|已完成\s*\d+%|进度\s*\d+%|0\s*学分/.test(d.text), "");
  rec("P2-U08", "最近活动来自真实状态历史", d.tl >= 2, `items=${d.tl}`);
  rec("P2-U09", "桌面 1280px 无横向溢出", d.overflow <= 0, `overflow=${d.overflow}px`);
  rec("P2-U10", "含跳过链接（键盘可达）", d.skip === true, "");
  rec("P2-U11", "学员中心无 console 错误", dash.errors.length === 0, dash.errors.slice(0, 2).join(" ; ").slice(0, 150));
  await dash.close();

  // 移动端 390px
  const mob = await open(browser, BASE + "/portal/student/", { width: 390, height: 844, mobile: true });
  const m = JSON.parse(await mob.eval(`(()=>{
    const de=document.documentElement;
    const small=[...document.querySelectorAll("button, a.btn, a.link, input, select")]
      .filter(e=>{const b=e.getBoundingClientRect();return b.height>0&&b.height<40;})
      .map(e=>e.tagName+"#"+(e.id||"")+"@"+Math.round(e.getBoundingClientRect().height));
    return JSON.stringify({overflow:de.scrollWidth-de.clientWidth, small});
  })()`));
  rec("P2-U12", "学员中心移动端 390px 无横向溢出", m.overflow <= 0, `overflow=${m.overflow}px`);
  rec("P2-U13", "学员中心触控目标 ≥40px", m.small.length === 0, `undersized=${m.small.join(",")}`);
  rec("P2-U14", "学员中心移动端无 console 错误", mob.errors.length === 0, mob.errors.slice(0, 2).join(" ; ").slice(0, 150));
  await mob.close();

  // 越权：学生打开学籍管理
  const deny = await open(browser, BASE + "/portal/admin/students/");
  const dd = JSON.parse(await deny.eval(`JSON.stringify({href:location.href, text:document.body.innerText.slice(0,300)})`));
  rec("P2-U15", "学生访问学籍管理被守卫拒绝",
    !/\/portal\/admin\/students/.test(dd.href) || /无权|没有权限|unauthorized|需要.*验证/i.test(dd.text),
    `href=${dd.href.replace(BASE, "")}`);
  rec("P2-U16", "越权页面不渲染任何学籍列表", !dd.text.includes("在册学生"), "");
  await deny.close();

  // ============ 3. pre_enrolled 学生：状态与提示必须不同 ============
  const lg2 = await open(browser, BASE + "/login/");
  await lg2.eval(`(async()=>{const c=window.supabase.createClient(${JSON.stringify(ENV.URL)},${JSON.stringify(ENV.ANON)});await c.auth.signOut();return 1;})()`);
  await lg2.eval(signInAs(E.stu2));
  await lg2.close();

  const pre = await open(browser, BASE + "/portal/student/");
  const pd = await pre.eval(`document.body.innerText`);
  rec("P2-U17", "pre_enrolled 学生显示「待正式注册」", pd.includes("待正式注册"), "");
  rec("P2-U18", "pre_enrolled 不谎称在读", !pd.includes("学籍状态正常"), "");
  rec("P2-U19", "pre_enrolled 提醒说明由教务执行", pd.includes("等待教务完成"), "");
  rec("P2-U20", "pre_enrolled 页面无 console 错误", pre.errors.length === 0, pre.errors.slice(0, 2).join(" ; ").slice(0, 150));
  await pre.close();

  // ============ 4. applicant 伪造 student route（P2-9 ①）============
  const lg3 = await open(browser, BASE + "/login/");
  await lg3.eval(`(async()=>{const c=window.supabase.createClient(${JSON.stringify(ENV.URL)},${JSON.stringify(ENV.ANON)});await c.auth.signOut();return 1;})()`);
  await lg3.eval(signInAs(E.app));
  await lg3.close();

  const fake = await open(browser, BASE + "/portal/student/");
  const fd = JSON.parse(await fake.eval(`JSON.stringify({href:location.href, text:document.body.innerText.slice(0,300)})`));
  rec("P2-U21", "applicant 伪造 student route 被拒",
    !/\/portal\/student/.test(fd.href) || /无权|没有权限|unauthorized/i.test(fd.text),
    `href=${fd.href.replace(BASE, "")}`);
  rec("P2-U22", "被拒页面不泄露任何学籍字段", !/学号|在读/.test(fd.text), "");

  // 前端伪造角色不得提权
  const forged = await fake.eval(`(async()=>{
    try{
      for (const k of Object.keys(localStorage)) {
        const v = localStorage.getItem(k);
        if (v && v.includes("access_token")) {
          const o = JSON.parse(v);
          o.user = o.user || {}; o.user.app_metadata = { roles: ["student","super_admin"] };
          localStorage.setItem(k, JSON.stringify(o));
        }
      }
      localStorage.setItem("amas_roles", JSON.stringify(["student","super_admin"]));
      const r = await fetch(${JSON.stringify(ENV.URL)} + "/rest/v1/student_records?select=id", {
        headers: { apikey: ${JSON.stringify(ENV.ANON)}, Authorization: "Bearer " + (window.AmasAuth.client ? (await window.AmasAuth.getSession()).access_token : "") }
      });
      const b = await r.json();
      return JSON.stringify({ status: r.status, rows: Array.isArray(b) ? b.length : -1 });
    } catch (e) { return JSON.stringify({ err: String(e) }); }
  })()`);
  const fj = JSON.parse(forged);
  rec("P2-U23", "篡改 localStorage 角色不产生任何提权", fj.rows === 0, `status=${fj.status} rows=${fj.rows}`);
  await fake.close();

  // ============ 5. registrar 学籍管理页 ============
  const lg4 = await open(browser, BASE + "/login/");
  await lg4.eval(`(async()=>{const c=window.supabase.createClient(${JSON.stringify(ENV.URL)},${JSON.stringify(ENV.ANON)});await c.auth.signOut();return 1;})()`);
  await lg4.eval(signInAs(E.reg));
  await lg4.close();

  // AAL1 registrar：页面要求 aal2，应被导向 MFA
  const aal1 = await open(browser, BASE + "/portal/admin/students/");
  const a1 = JSON.parse(await aal1.eval(`JSON.stringify({href:location.href, text:document.body.innerText.slice(0,200)})`));
  rec("P2-U24", "AAL1 教务打开学籍管理被要求先做 MFA",
    /\/portal\/mfa|\/login\//.test(a1.href) || /验证|MFA|两步/i.test(a1.text),
    `href=${a1.href.replace(BASE, "")}`);
  rec("P2-U25", "AAL1 页面不渲染在册学生列表", !a1.text.includes("在册学生"), "");
  rec("P2-U26", "学籍管理页无 console 错误", aal1.errors.length === 0, aal1.errors.slice(0, 2).join(" ; ").slice(0, 150));
  await aal1.close();

} catch (e) {
  rec("P2-UXX", "测试执行异常", false, String(e).slice(0, 250));
} finally {
  if (browser) browser.close();
  chrome.kill();
  for (const id of Object.values(ids)) if (id) await admin(`/auth/v1/admin/users/${id}`, { method: "DELETE" });
  const pass = results.filter(r => r.ok).length;
  fs.writeFileSync("portal2_ui_results.json", JSON.stringify(results, null, 2));
  console.log(`\n=== PORTAL-2 UI: ${pass}/${results.length} PASSED ===`);
  if (pass !== results.length) process.exitCode = 1;
}
