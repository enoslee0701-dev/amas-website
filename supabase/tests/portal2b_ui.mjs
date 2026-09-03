// PORTAL-2B · 浏览器层验收（资料读写分区 / 课程真实空态 / 当前行动 1+1+1 / 移动端 / console）
// 前置：本地站点 http://127.0.0.1:8090，assets/js/supabase-config.js 临时指向 staging（跑完须还原）
// 运行：node supabase/tests/portal2b_ui.mjs
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

const H = (key, jwt) => ({ apikey: key, Authorization: `Bearer ${jwt || key}`, "Content-Type": "application/json" });
const admin = (p, o = {}) => fetch(`${ENV.URL}${p}`, { ...o, headers: { ...H(ENV.SERVICE), ...(o.headers || {}) } });
const rest = (p, jwt, o = {}) => fetch(`${ENV.URL}/rest/v1${p}`, { ...o, headers: { ...H(ENV.ANON, jwt), ...(o.headers || {}) } });
const rpcC = (n, jwt, b) => rest(`/rpc/${n}`, jwt, { method: "POST", body: JSON.stringify(b || {}) });
const fnc = (n, jwt, b) => fetch(`${ENV.URL}/functions/v1/${n}`, { method: "POST", headers: H(ENV.ANON, jwt), body: JSON.stringify(b || {}) });
function b32decode(s){const A="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let b="",o=[];for(const c of s.replace(/=+$/,"").toUpperCase()){const v=A.indexOf(c);if(v<0)continue;b+=v.toString(2).padStart(5,"0");}for(let i=0;i+8<=b.length;i+=8)o.push(parseInt(b.slice(i,i+8),2));return Buffer.from(o);}
function totp(sec){const k=b32decode(sec);const c=Buffer.alloc(8);c.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const h=createHmac("sha1",k).update(c).digest();const off=h[h.length-1]&0xf;const bin=((h[off]&0x7f)<<24)|(h[off+1]<<16)|(h[off+2]<<8)|h[off+3];return String(bin%1e6).padStart(6,"0");}

const PW = "P2BUi!2026x", tag = Date.now().toString(36);
const E = {
  stu: `p2bui-a-${tag}@amas-test.dev`,   // active 学生
  pre: `p2bui-p-${tag}@amas-test.dev`,   // pre_enrolled 学生
  reg: `p2bui-r-${tag}@amas-test.dev`,   // registrar
};
const ids = {}, jwts = {};
const NUM_A = `UI2B-${tag.toUpperCase()}-A`;
const GOOD = {
  name_zh: "体验测试学生", birth_ym: "1995-06", gender: "male", nationality: "中国",
  phone: "+86 13800000000", address: "广州市", church_name: "测试教会",
  church_role: "小组同工", conversion_date: "2015-03", calling: "愿意接受装备",
  testimony: "见证内容。", declaration_accepted: true,
  programs: ["bth"], languages: ["mandarin"],
  education: [{ school: "某大学", city: "广州", start_ym: "2013-09", end_ym: "2017-06", degree: "本科" }],
};

async function seed() {
  for (const [k, email] of Object.entries(E)) {
    const r = await (await admin("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({
      email, password: PW, email_confirm: true,
      user_metadata: { display_name: k === "reg" ? "界面测试教务" : "体验测试学生" } }) })).json();
    ids[k] = r.id;
  }
  await admin("/rest/v1/user_roles", { method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: ids.reg, role: "registrar", granted_by: ids.reg }) });
  for (const k of Object.keys(E)) {
    const r = await (await fetch(`${ENV.URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: H(ENV.ANON), body: JSON.stringify({ email: E[k], password: PW }) })).json();
    jwts[k] = r.access_token;
  }
  const enr = await (await fetch(`${ENV.URL}/auth/v1/factors`, { method: "POST", headers: H(ENV.ANON, jwts.reg), body: JSON.stringify({ factor_type: "totp", friendly_name: "P2BUI" }) })).json();
  const ch = await (await fetch(`${ENV.URL}/auth/v1/factors/${enr.id}/challenge`, { method: "POST", headers: H(ENV.ANON, jwts.reg), body: "{}" })).json();
  const ver = await (await fetch(`${ENV.URL}/auth/v1/factors/${enr.id}/verify`, { method: "POST", headers: H(ENV.ANON, jwts.reg), body: JSON.stringify({ challenge_id: ch.id, code: totp(enr.totp.secret) }) })).json();
  const regAal2 = ver.access_token;

  const enroll = async (who, num, activate) => {
    const c = await rest("/applications", jwts[who], { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ applicant_id: ids[who], pathway: "bth", status: "draft", form_data: GOOD }) });
    const appId = (await c.json())[0].id;
    await rpcC("submit_application", jwts[who], { p_app: appId });
    await fnc("review-application", regAal2, { application_id: appId, action: "start_review" });
    await fnc("review-application", regAal2, { application_id: appId, action: "accept" });
    await fnc("student-lifecycle", regAal2, { action: "confirm_hq_approval", application_id: appId, hq_status: "approved", approval_reference: "HQ-UI2B", internal_note: "内部备注绝不外泄" });
    const cr = await (await fnc("student-lifecycle", regAal2, { action: "create_student_record", application_id: appId, student_number: num })).json();
    if (activate) await fnc("student-lifecycle", regAal2, { action: "activate_student", student_id: cr.student_id, message: "学籍已正式生效" });
  };
  await enroll("stu", NUM_A, true);
  await enroll("pre", `UI2B-${tag.toUpperCase()}-P`, false);
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.subs = []; }
  static async attach(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pend.has(m.id)) { const { res, rej } = c.pend.get(m.id); c.pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method) c.subs.forEach(f => f(m));
    };
    return c;
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(fn) { this.subs.push(fn); }
  close() { this.ws.close(); }
}

const profile = path.join(os.tmpdir(), "amas-portal2b-chrome");
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9337", "--no-first-run",
  "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

async function browserWs() {
  for (let i = 0; i < 40; i++) {
    try { return (await (await fetch("http://127.0.0.1:9337/json/version")).json()).webSocketDebuggerUrl; }
    catch { await sleep(300); }
  }
  throw new Error("chrome devtools not reachable");
}

async function open(browser, url, { width = 1280, height = 900, mobile = false, wait = 3400 } = {}) {
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

const signIn = (email) => `(async()=>{
  const c = window.supabase.createClient(${JSON.stringify(ENV.URL)}, ${JSON.stringify(ENV.ANON)});
  await c.auth.signOut();
  const r = await c.auth.signInWithPassword({email:${JSON.stringify(email)}, password:${JSON.stringify(PW)}});
  return r.error ? r.error.message : "ok";
})()`;

let browser;
try {
  await seed();
  browser = await CDP.attach(await browserWs());

  // ---------- 未登录守卫 ----------
  for (const [id, name, p] of [["P2B-U01", "课程目录", "/portal/student/courses/"],
                               ["P2B-U02", "我的资料", "/portal/student/profile/"]]) {
    const pg = await open(browser, BASE + p);
    const info = JSON.parse(await pg.eval(`JSON.stringify({href:location.href, text:document.body.innerText.slice(0,300)})`));
    rec(`${id}a`, `${name} 未登录跳转登录页`, /\/login\//.test(info.href), `href=${info.href.replace(BASE, "")}`);
    rec(`${id}b`, `${name} 未登录不渲染学籍数据`, !new RegExp(`${NUM_A}|由教务维护`).test(info.text), "");
    rec(`${id}c`, `${name} 未登录态无 console 错误`, pg.errors.length === 0, pg.errors.slice(0, 2).join(";").slice(0, 140));
    await pg.close();
  }

  // ---------- active 学生 ----------
  const lg = await open(browser, BASE + "/login/");
  await lg.eval(signIn(E.stu));
  await lg.close();

  // 首页：当前行动最多 1+1+1
  const home = await open(browser, BASE + "/portal/student/");
  const h = JSON.parse(await home.eval(`JSON.stringify({
    text: document.body.innerText,
    acts: document.querySelectorAll(".act").length,
    nav: [...document.querySelectorAll(".nv .nv-tx")].map(e=>e.innerText),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
  })`));
  rec("P2B-U03", "首页当前行动不超过 3 条（1 学习+1 实践+1 反馈）", h.acts <= 3 && h.acts >= 1, `items=${h.acts}`);
  rec("P2B-U04", "首页不出现「你有 N 个任务」式假通知", !/你有\s*\d+\s*个任务/.test(h.text), "");
  rec("P2B-U05", "首页如实说明学习记录在 App 中", /App/.test(h.text) && /不显示学习进度|尚未接入/.test(h.text), "");
  rec("P2B-U06", "首页不显示学分/GPA/进度百分比",
    !/\d+\s*学分|GPA|进度\s*\d+%|已完成\s*\d+%/.test(h.text), "");
  rec("P2B-U07", "学员导航含课程目录与我的资料",
    h.nav.includes("课程目录") && h.nav.includes("我的资料"), `nav=${h.nav.join("/")}`);
  rec("P2B-U08", "首页桌面无横向溢出", h.overflow <= 0, `overflow=${h.overflow}px`);
  rec("P2B-U09", "首页无 console 错误", home.errors.length === 0, home.errors.slice(0, 2).join(";").slice(0, 140));
  await home.close();

  // 课程目录页
  const cs = await open(browser, BASE + "/portal/student/courses/");
  const c = JSON.parse(await cs.eval(`JSON.stringify({
    text: document.body.innerText,
    items: document.querySelectorAll(".citem").length,
    pending: document.querySelectorAll(".tag.in_development").length,
    open: document.querySelectorAll(".tag.available").length,
    media: document.querySelectorAll("video, audio, iframe").length,
    itemsText: [...document.querySelectorAll(".citem")].map(e=>e.innerText).join(" "),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
  })`));
  rec("P2B-U10", "课程目录渲染 67 门", c.items === 67, `items=${c.items}`);
  rec("P2B-U11", "内容筹备中 21 门 / 已开放 46 门", c.pending === 21 && c.open === 46, `pending=${c.pending} open=${c.open}`);
  rec("P2B-U12", "筹备中课程给出真实说明",
    c.text.includes("课程已列入 AMAS 正式课程目录，当前线上学习内容尚未开放"), "");
  rec("P2B-U13", "不制造空播放器 / 假课程页", c.media === 0, `media=${c.media}`);
  rec("P2B-U14", "credits=null 显示为「不显示学分信息」且不出现 0 学分",
    c.text.includes("不显示学分信息") && !/\b0\s*学分/.test(c.text), "");
  // 页首那句"与「你是否已注册」是三件不同的事"是刻意的说明文字，不是状态断言；
  // 因此只检查课程条目本身有没有冒充注册/选课状态。
  rec("P2B-U15", "课程条目不冒充「已注册 / 已选课」状态",
    !/已注册|已选课|学习中|已完成/.test(c.itemsText), `sample=${(c.itemsText || "").slice(0, 60)}`);
  rec("P2B-U16", "课程页桌面无横向溢出", c.overflow <= 0, `overflow=${c.overflow}px`);
  rec("P2B-U17", "课程页无 console 错误", cs.errors.length === 0, cs.errors.slice(0, 2).join(";").slice(0, 140));
  await cs.close();

  // 我的资料页
  const pf = await open(browser, BASE + "/portal/student/profile/");
  const p = JSON.parse(await pf.eval(`JSON.stringify({
    text: document.body.innerText,
    locks: document.querySelectorAll(".lock").length,
    inputs: [...document.querySelectorAll("input")].map(i=>i.id),
    labeled: [...document.querySelectorAll("input")].filter(i=>document.querySelector("label[for='"+i.id+"']")).length,
    total: document.querySelectorAll("input").length
  })`));
  rec("P2B-U18", "资料页标注「由教务维护」", p.locks >= 1 && p.text.includes("由教务维护"), `locks=${p.locks}`);
  rec("P2B-U19", "只有联系类字段可编辑，学号/状态不是输入框",
    p.inputs.sort().join(",") === "ct,nm,ph", `inputs=${p.inputs.join(",")}`);
  rec("P2B-U20", "学号与学籍状态以只读形式呈现",
    p.text.includes(NUM_A) && p.text.includes("在读"), "");
  rec("P2B-U21", "HQ 内部备注未泄漏到资料页", !p.text.includes("内部备注绝不外泄"), "");
  rec("P2B-U22", "所有输入均有可及标签", p.total > 0 && p.labeled === p.total, `${p.labeled}/${p.total}`);

  // 真实保存一次并验证服务端确实改了
  await pf.eval(`(()=>{document.getElementById("ph").value="+86 13600000000";
    document.getElementById("f").requestSubmit();return 1;})()`);
  await sleep(2600);
  const saved = await (await rpcC("my_student_profile", jwts.stu)).json();
  rec("P2B-U23", "资料保存真实写入服务端", saved?.self_editable?.phone === "+86 13600000000",
    `phone=${saved?.self_editable?.phone}`);
  rec("P2B-U24", "资料页无 console 错误", pf.errors.length === 0, pf.errors.slice(0, 2).join(";").slice(0, 140));
  await pf.close();

  // 移动端 390px
  for (const [id, name, url] of [["P2B-U25", "课程目录", "/portal/student/courses/"],
                                 ["P2B-U26", "我的资料", "/portal/student/profile/"]]) {
    const m = await open(browser, BASE + url, { width: 390, height: 844, mobile: true });
    const r = JSON.parse(await m.eval(`(()=>{
      const de=document.documentElement;
      const small=[...document.querySelectorAll("button, a.btn, a.link, input, select")]
        .filter(e=>{const b=e.getBoundingClientRect();return b.height>0&&b.height<40;})
        .map(e=>e.tagName+"#"+(e.id||"")+"@"+Math.round(e.getBoundingClientRect().height));
      return JSON.stringify({overflow:de.scrollWidth-de.clientWidth, small});
    })()`));
    rec(`${id}a`, `${name} 移动端 390px 无横向溢出`, r.overflow <= 0, `overflow=${r.overflow}px`);
    rec(`${id}b`, `${name} 触控目标 ≥40px`, r.small.length === 0, `undersized=${r.small.join(",")}`);
    rec(`${id}c`, `${name} 移动端无 console 错误`, m.errors.length === 0, m.errors.slice(0, 2).join(";").slice(0, 140));
    await m.close();
  }

  // ---------- pre_enrolled 学生：能力差异 ----------
  const lg2 = await open(browser, BASE + "/login/");
  await lg2.eval(signIn(E.pre));
  await lg2.close();
  const ph = await open(browser, BASE + "/portal/student/");
  const pt = await ph.eval(`document.body.innerText`);
  rec("P2B-U27", "pre_enrolled 首页显示「待正式注册」", pt.includes("待正式注册"), "");
  rec("P2B-U28", "pre_enrolled 的等待事项说明无需本人操作", /无需你操作/.test(pt), "");
  rec("P2B-U29", "pre_enrolled 首页无 console 错误", ph.errors.length === 0, ph.errors.slice(0, 2).join(";").slice(0, 140));
  await ph.close();

  const pc2 = await open(browser, BASE + "/portal/student/courses/");
  const pct = await pc2.eval(`document.body.innerText`);
  rec("P2B-U30", "pre_enrolled 也能浏览课程目录（目录是公开信息）", /AMAS 正式课程共\s*67\s*门/.test(pct), "");
  await pc2.close();

} catch (e) {
  rec("P2B-UXX", "测试执行异常", false, String(e).slice(0, 250));
} finally {
  if (browser) browser.close();
  chrome.kill();
  for (const id of Object.values(ids)) if (id) await admin(`/auth/v1/admin/users/${id}`, { method: "DELETE" });
  const pass = results.filter(r => r.ok).length;
  fs.writeFileSync("portal2b_ui_results.json", JSON.stringify(results, null, 2));
  console.log(`\n=== PORTAL-2B UI: ${pass}/${results.length} PASSED ===`);
  if (pass !== results.length) process.exitCode = 1;
}
