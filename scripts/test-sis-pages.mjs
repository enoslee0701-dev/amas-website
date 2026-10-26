#!/usr/bin/env node
// 学员管理系统第一期页面的本地功能测试：
//   portal/admin/offerings/（开课与编班）、portal/teacher/classes/、portal/student/classes/、
//   portal/admin/students/ 新增的休学 / 复学 / 退学。
// 做法与 test-portal-pages.mjs 相同：supabase-js 换成本机假客户端，Edge 调用只换最底层 fetch，
// 页面自己的 Shell.mount / Api / callFn 保持真身。不联网、不用真实凭据、不写远端。
// 全绿 ≠ 线上可用：只证明「给定这些返回值时，页面做对了事」。
// 运行：node scripts/test-sis-pages.mjs     退出码：0 全过；1 有失败；2 环境问题
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchOwnChrome } from "./lib/chrome-launcher.mjs";
import { refuseLocalConfig } from "./lib/no-local-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT_DIR = process.argv.includes("--shots") ? (process.env.SHOT_DIR || path.join(os.tmpdir(), "amas-shots")) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (refuseLocalConfig(p, res)) return;
  if (p.endsWith("/")) p += "index.html";
  const abs = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const { chrome, port, profileDir } = await launchOwnChrome({ profilePrefix: "amas-sis-", extraArgs: ["--disable-gpu", "--hide-scrollbars"] });

let ws, seq = 0; const pending = new Map(), handlers = new Map();
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const u = j.find((x) => x.type === "page")?.webSocketDebuggerUrl;
    if (u) ws = await new Promise((ok, no) => { const s = new WebSocket(u); s.onopen = () => ok(s); s.onerror = no; });
  } catch {}
  if (!ws) await sleep(250);
}
if (!ws) { console.log("连不上 Chrome"); process.exit(2); }
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method && handlers.has(m.method)) handlers.get(m.method)(m.params); };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval"); return r.result?.result?.value; };

let pass = 0, fails = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  PASS  " + name); }
  else { fails++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); } };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';

/* 假 supabase：读走 window.__SCEN；Edge 调用由 armFn 换掉的 fetch 处理 */
const STUB = `
window.supabase = { createClient: function(){
  var S = function(){ return window.__SCEN || {}; };
  var reply = function(v){ return Promise.resolve(v); };
  function table(name){ var q = { select:function(){return q;}, eq:function(){return q;}, in:function(){return q;},
    order:function(){return q;}, range:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
    single:function(){return q;},
    then:function(res, rej){ var t = (S().tables && S().tables[name]) || { data: [], error: null };
      return Promise.resolve({ data: t.data, error: t.error || null, status: t.error ? 500 : 200 }).then(res, rej); } };
    return q; }
  return {
    auth: { getSession:function(){ return reply({ data: { session: S().session || null } }); },
      mfa: { getAuthenticatorAssuranceLevel:function(){ return reply({ data: { currentLevel: S().aal || "aal1", nextLevel: S().aal || "aal1" } }); } },
      onAuthStateChange:function(){ return { data: { subscription: { unsubscribe:function(){} } } }; },
      signOut:function(){ return reply({}); } },
    from: table,
    rpc: function(name, args){ window.__rpc = window.__rpc || []; window.__rpc.push({ name: name, args: args });
      var r = S().rpc && S().rpc[name]; if (!r) r = { data: null, error: null };
      return reply({ data: r.data, error: r.error || null, status: r.error ? 500 : 200 }); },
    functions: { invoke:function(){ return reply({ data: null, error: null }); } }
  }; } };`;

await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
let external = 0;
handlers.set("Fetch.requestPaused", async (p) => {
  const u = p.request.url;
  try {
    if (u.includes("supabase-js") && (u.includes("cdn.jsdelivr.net") || u.includes("/assets/vendor/"))) {
      return void await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/javascript" }], body: b64(STUB) });
    }
    if (u.includes("supabase-config.js")) {
      return void await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/javascript" }], body: b64(CFG) });
    }
    if (!u.startsWith(BASE)) external++;
    await send("Fetch.continueRequest", { requestId: p.requestId });
  } catch {}
});

let scriptId = null;
const open = async (page, scen) => {
  if (scriptId) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
  const r = await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN=" + JSON.stringify(scen) + ";window.__rpc=[];" });
  scriptId = r.result.identifier;
  await send("Page.navigate", { url: `${BASE}/${page}` });
  await sleep(1800);
};
const txt = () => ev(`(()=>{const c=document.body.cloneNode(true);c.querySelectorAll("script,style").forEach(n=>n.remove());return (c.textContent||"").replace(/\\s+/g," ").trim();})()`);
/* Edge 调用：记录每次请求体，按 mode 回应。delay 毫秒后才回，用于测在途锁。 */
const armFn = (mode, payload, delay = 0) => ev(`(()=>{ window.__fn = []; const orig = window.fetch;
  window.fetch = function(u, opt){ if (String(u).indexOf("/functions/v1/") < 0) return orig.apply(this, arguments);
    window.__fn.push({ url: String(u), body: JSON.parse(opt.body) });
    const m = ${JSON.stringify(mode)}, p = ${JSON.stringify(payload ?? null)};
    const later = (v) => new Promise(r => setTimeout(() => r(v), ${delay}));
    if (m === "throw") return Promise.reject(new TypeError("Failed to fetch"));
    if (m === "reject") return later(new Response(JSON.stringify(p), { status: 409, headers: { "Content-Type": "application/json" } }));
    return later(new Response(JSON.stringify(p), { status: 200, headers: { "Content-Type": "application/json" } })); };
  return true; })()`);
const fnCalls = () => ev(`window.__fn || []`);
const shot = async (name) => {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  fs.writeFileSync(path.join(SHOT_DIR, `sis-${name}.png`), Buffer.from(r.result.data, "base64"));
};
const click = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true;})()`);
const setVal = (sel, v) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.value=${JSON.stringify(v)};
  e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);

const ADMIN = { session: { user: { id: "u-admin", email: "a@example.invalid" } }, aal: "aal2" };
const OFF = [
  { offering_id: "o-1", course_code: "c_matthew", title_zh: "马太福音", level: "bth", credits: 3, academic_year: "2026-2027",
    section_label: null, delivery_mode: "online", starts_on: "2026-10-05", ends_on: "2026-12-20", schedule_note: "每周二、四 19:30",
    capacity: 30, offering_status: "in_progress", teachers: [{ teacher_id: "t-1", role: "lead", name: "王教授" }], enrolled_count: 2 },
  { offering_id: "o-2", course_code: "c_romans", title_zh: "罗马书", level: "bth", credits: 3, academic_year: "2026-2027",
    section_label: "B 班", delivery_mode: "onsite", starts_on: null, ends_on: null, schedule_note: null,
    capacity: null, offering_status: "planned", teachers: [], enrolled_count: 0 },
];
const ROSTER = [{ enrollment_id: "e-1", student_id: "s-1", display_name: "学员甲", student_number: "B26-001", student_status: "active", enrollment_status: "enrolled" },
                { enrollment_id: "e-9", student_id: "s-9", display_name: "已退选者", student_number: "B26-009", student_status: "active", enrollment_status: "dropped" }];
const STUDENTS = [
  { student_id: "s-1", display_name: "学员甲", student_number: "B26-001", status: "active" },
  { student_id: "s-2", display_name: "学员乙", student_number: "B26-002", status: "active" },
  { student_id: "s-3", display_name: "休学者", student_number: "B26-003", status: "on_leave" },
];
const adminScen = (extra = {}) => Object.assign({}, ADMIN, {
  rpc: Object.assign({ my_roles: { data: [{ role: "registrar" }] }, admin_list_offerings: { data: OFF },
    offering_roster: { data: ROSTER }, admin_list_teachers: { data: [{ user_id: "t-1", name: "王教授" }, { user_id: "t-2", name: "李教授", staff_number: "T-02" }] },
    admin_list_students: { data: STUDENTS } }, extra.rpc || {}),
  tables: Object.assign({ course_catalog: { data: [
    { code: "c_matthew", title_zh: "马太福音", level: "bth", credits: 3, sort_order: 1 },
    { code: "c_mark", title_zh: "马可福音", level: "dmin", credits: null, sort_order: 2 }] } }, extra.tables || {}),
});

try {
  // ═══ A 开课与编班：列表 ═══
  console.log("\n=== A 开课与编班：列表 ===");
  await open("portal/admin/offerings/", adminScen());
  let t = await txt();
  ok("A1 列出两个课程班", t.includes("马太福音") && t.includes("罗马书 · B 班"), t.slice(0, 120));
  ok("A2 显示任课教授与在班人数/上限", t.includes("王教授") && /在班 2 \/ 30 人/.test(t));
  ok("A3 未排教授的班标出「未排」", t.includes("未排"));
  ok("A4 状态译成中文", t.includes("上课中") && t.includes("未开课"));
  ok("A4b 没填日期的班写「日期待定」而不是「— 至 —」", t.includes("日期待定") && !t.includes("— 至 —"));
  ok("A5 390px 无横向滚动", (await ev("document.documentElement.scrollWidth")) <= 390);
  await shot("offerings-list");

  await open("portal/admin/offerings/", adminScen({ rpc: { admin_list_offerings: { error: { message: "boom" } } } }));
  t = await txt();
  ok("A6 读失败不说「还没有课程班」", !t.includes("还没有课程班") && t.includes("这不表示没有课程班"), t.slice(0, 120));
  await open("portal/admin/offerings/", adminScen({ rpc: { admin_list_offerings: { data: [] } } }));
  ok("A7 真为空时说还没有课程班", (await txt()).includes("还没有课程班"));

  await open("portal/admin/offerings/", Object.assign(adminScen(), { rpc: { my_roles: { data: [{ role: "teacher" }] } } }));
  t = await txt();
  ok("A8 教授进不了开课页", !t.includes("开新课程班"), t.slice(0, 80));

  // ═══ B 开课 ═══
  console.log("\n=== B 开新课程班 ===");
  await open("portal/admin/offerings/", adminScen());
  await click("#new"); await sleep(400);
  await setVal("#c-course", "c_matthew"); await setVal("#c-s", "2027-01-04"); await setVal("#c-note", "每周一 19:30");
  await armFn("ok", { ok: true, offering_id: "o-1" });
  await click("#cf [type=submit]"); await sleep(900);
  let calls = await fnCalls();
  ok("B1 发出一次 create_offering 到 sis-admin", calls.length === 1 && calls[0].url.endsWith("/functions/v1/sis-admin") && calls[0].body.action === "create_offering", JSON.stringify(calls));
  ok("B2 带上课程、默认学年与日期", calls[0]?.body.course_code === "c_matthew" && /^\d{4}-\d{4}$/.test(calls[0]?.body.academic_year) && calls[0]?.body.starts_on === "2027-01-04");
  ok("B3 成功后进入该班详情", (await txt()).includes("返回课程班列表"));

  await open("portal/admin/offerings/", adminScen());
  await click("#new"); await sleep(400);
  await armFn("reject", { error: "offering_exists" });
  await setVal("#c-course", "c_matthew"); await click("#cf [type=submit]"); await sleep(700);
  ok("B4 重复开课给出中文说明", (await txt()).includes("同一学年已有这门课的同名班级"));

  await armFn("throw");
  await click("#cf [type=submit]"); await sleep(700);
  t = await txt();
  ok("B5 断网时说无法确认是否生效、不劝重试", t.includes("无法确认它是否已经生效") && t.includes("不要重复提交"));
  ok("B6 断网时只发了一次", (await fnCalls()).length === 1);

  await open("portal/admin/offerings/", adminScen());
  await click("#new"); await sleep(300);
  await armFn("ok", { ok: true, offering_id: "o-1" });
  await click("#cf [type=submit]"); await sleep(300);
  ok("B7 没选课程不发请求", (await fnCalls()).length === 0 && (await txt()).includes("请选择课程"));

  // ═══ C 课程班详情：排教授 / 编班 / 退选 ═══
  console.log("\n=== C 课程班详情 ===");
  await open("portal/admin/offerings/", adminScen());
  await click('[data-open="o-1"]'); await sleep(700);
  t = await txt();
  ok("C1 名单只列在班学员，不列已退选的", t.includes("学员甲") && !t.includes("已退选者"));
  await shot("offering-detail");
  ok("C2 名单人数 1 / 30", t.includes("班级名单（1 / 30 人）"));
  ok("C3 已在本班的教授不再出现在下拉里", await ev(`[...document.querySelectorAll("#t-pick option")].map(o=>o.textContent).join("|")`) === "选择教授|李教授（T-02）");

  await armFn("ok", { ok: true, assignment_id: "a-1" }, 600);
  await setVal("#t-pick", "t-2"); await click("#t-add"); await click("#t-add"); await sleep(900);
  calls = await fnCalls();
  ok("C4 连点两次「排入」只发一次", calls.length === 1 && calls[0].body.action === "assign_teacher" && calls[0].body.teacher_id === "t-2", JSON.stringify(calls));

  await open("portal/admin/offerings/", adminScen());
  await click('[data-open="o-1"]'); await sleep(700);
  await click("#addstu"); await sleep(500);
  const cands = await ev(`[...document.querySelectorAll(".picks input")].map(i=>i.value)`);
  ok("C5 候选只含在读且未在班的学员", JSON.stringify(cands) === JSON.stringify(["s-2"]), JSON.stringify(cands));
  await armFn("ok", { ok: true, enrolled: 1, skipped: [] });
  await ev(`document.querySelector(".picks input").checked = true`);
  await click("#go"); await sleep(700);
  calls = await fnCalls();
  ok("C6 编班请求带上勾选的学员", calls.length === 1 && calls[0].body.action === "enroll_students" && JSON.stringify(calls[0].body.student_ids) === '["s-2"]', JSON.stringify(calls));

  await open("portal/admin/offerings/", adminScen());
  await click('[data-open="o-1"]'); await sleep(700);
  await armFn("ok", { ok: true });
  await click('[data-drop="e-1"]'); await sleep(300);
  ok("C7 退选弹出原因框，写明对象", (await txt()).includes("让「学员甲」退出本班"));
  await click(".portal-modal [data-ok]"); await sleep(300);
  ok("C8 不写原因不发请求", (await fnCalls()).length === 0 && (await txt()).includes("请填写原因"));
  await setVal("#ar-in", "转到 B 班"); await click(".portal-modal [data-ok]"); await sleep(700);
  calls = await fnCalls();
  ok("C9 写了原因才发出退选", calls.length === 1 && calls[0].body.action === "drop_enrollment" && calls[0].body.reason === "转到 B 班", JSON.stringify(calls));

  await open("portal/admin/offerings/", adminScen({ rpc: { offering_roster: { error: { message: "boom" } } } }));
  await click('[data-open="o-1"]'); await sleep(700);
  t = await txt();
  ok("C10 名单读失败不说「班里还没有学员」，也不给编班入口",
     t.includes("这不表示班里没人") && !t.includes("班里还没有学员") && !(await ev(`!!document.querySelector("#addstu")`)));
  ok("C11 详情页 390px 无横向滚动", (await ev("document.documentElement.scrollWidth")) <= 390);

  // ═══ D 教授：我的课程 ═══
  console.log("\n=== D 教授：我的课程 ===");
  const TEA = { session: { user: { id: "t-1", email: "t@example.invalid" } }, aal: "aal2" };
  await open("portal/teacher/classes/", Object.assign({}, TEA, { rpc: { my_roles: { data: [{ role: "teacher" }] },
    my_teaching: { data: [{ offering_id: "o-1", title_zh: "马太福音", academic_year: "2026-2027", delivery_mode: "online",
      starts_on: "2026-10-05", ends_on: "2026-12-20", schedule_note: "每周二、四 19:30", offering_status: "in_progress", my_role: "lead", enrolled_count: 2 }] },
    offering_roster: { data: [{ display_name: "学员甲", student_number: "B26-001" }, { display_name: "学员乙", student_number: "B26-002" }] } } }));
  t = await txt();
  ok("D1 列出任教课程班与上课安排", t.includes("马太福音") && t.includes("每周二、四 19:30") && t.includes("主讲"));
  await click("[data-roster]"); await sleep(500);
  t = await txt();
  ok("D2 展开名单显示姓名与学号", t.includes("学员乙") && t.includes("B26-002"));
  await shot("teacher-classes");
  ok("D3 名单请求带着本班 id", (await ev(`window.__rpc.filter(r=>r.name==="offering_roster").map(r=>r.args.p_offering).join()`)) === "o-1");
  await open("portal/teacher/classes/", Object.assign({}, TEA, { rpc: { my_roles: { data: [{ role: "teacher" }] }, my_teaching: { error: { message: "boom" } } } }));
  t = await txt();
  ok("D4 读失败不说「还没有排给你的课程班」", !t.includes("还没有排给你的课程班") && t.includes("这不表示没有排课"));
  await open("portal/teacher/classes/", Object.assign({}, TEA, { rpc: { my_roles: { data: [{ role: "teacher" }] }, my_teaching: { data: [] } } }));
  ok("D5 真为空时如实说明", (await txt()).includes("还没有排给你的课程班"));

  // ═══ E 学员：我的课程 ═══
  console.log("\n=== E 学员：我的课程 ===");
  const STU = { session: { user: { id: "s-u1", email: "s@example.invalid" } }, aal: "aal1" };
  await open("portal/student/classes/", Object.assign({}, STU, { rpc: { my_roles: { data: [{ role: "student" }] },
    my_courses: { data: [{ offering_id: "o-1", title_zh: "马太福音", credits: 3, academic_year: "2026-2027", delivery_mode: "hybrid",
      starts_on: "2026-10-05", ends_on: null, schedule_note: "每周二、四 19:30", offering_status: "in_progress", teachers: "王教授" }] } } }));
  t = await txt();
  ok("E1 显示课程、学分、任课教授与上课安排", t.includes("马太福音") && t.includes("3 学分") && t.includes("王教授") && t.includes("每周二、四"));
  ok("E2 结课日未定写「待定」", t.includes("2026-10-05 至 待定"));
  await shot("student-classes");
  await open("portal/student/classes/", Object.assign({}, STU, { rpc: { my_roles: { data: [{ role: "student" }] }, my_courses: { error: { message: "boom" } } } }));
  t = await txt();
  ok("E3 读失败不说「还没有为你编入课程班」", !t.includes("还没有为你编入课程班") && t.includes("这不表示你没有课程"));
  await open("portal/student/classes/", Object.assign({}, STU, { rpc: { my_roles: { data: [{ role: "student" }] }, my_courses: { data: [] } } }));
  ok("E4 真为空时如实说明", (await txt()).includes("还没有为你编入课程班"));
  ok("E5 学员导航里有「我的课程」", await ev(`[...document.querySelectorAll("nav a")].some(a=>a.textContent.includes("我的课程"))`));

  // ═══ F 学籍管理：休学 / 退学 ═══
  console.log("\n=== F 学籍管理：休学 / 复学 / 退学 ===");
  const stuScen = Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] } },
    tables: { program_catalog: { data: [] },
      student_records: { data: [
        { id: "sr-1", user_id: "u-1", status: "active", student_number: "B26-001", program_code: null },
        { id: "sr-2", user_id: "u-2", status: "on_leave", student_number: "B26-002", program_code: null },
        { id: "sr-3", user_id: "u-3", status: "withdrawn", student_number: "B26-003", program_code: null }] },
      profiles: { data: [{ id: "u-1", display_name: "学员甲" }, { id: "u-2", display_name: "学员乙" }, { id: "u-3", display_name: "学员丙" }] } } });
  await open("portal/admin/students/", stuScen);
  await click('[data-tab="students"]'); await sleep(700);
  t = await txt();
  ok("F1 状态译成中文", t.includes("休学中") && t.includes("已退学"));
  ok("F2 在读给休学与退学、休学给复学、已退学不给任何状态按钮",
     await ev(`JSON.stringify([...document.querySelectorAll("[data-to]")].map(b=>b.dataset.sid+":"+b.dataset.to))`) ===
       JSON.stringify(["sr-1:on_leave", "sr-1:withdrawn", "sr-2:active", "sr-2:withdrawn"]));
  await armFn("ok", { ok: true, status: "on_leave" });
  await click('[data-to="on_leave"][data-sid="sr-1"]'); await sleep(300);
  ok("F3 弹窗写明对象", (await txt()).includes("对象：学员甲"));
  await ev(`window.alert = function(){ window.__alerted = true; }`);
  await click(".portal-modal [data-act]"); await sleep(300);
  ok("F4 不写原因不发请求", (await fnCalls()).length === 0 && (await ev("!!window.__alerted")));
  await setVal('.portal-modal [data-f="reason"]', "家庭原因"); await click(".portal-modal [data-act]"); await sleep(800);
  calls = await fnCalls();
  ok("F5 休学请求发到 sis-admin 且带原因", calls.length === 1 && calls[0].url.endsWith("/functions/v1/sis-admin") &&
     calls[0].body.action === "change_student_status" && calls[0].body.to === "on_leave" && calls[0].body.reason === "家庭原因", JSON.stringify(calls));

  await open("portal/admin/students/", stuScen);
  await click('[data-tab="students"]'); await sleep(700);
  await armFn("reject", { error: "invalid_state" });
  await click('[data-to="withdrawn"][data-sid="sr-2"]'); await sleep(300);
  await setVal('.portal-modal [data-f="reason"]', "本人申请"); await click(".portal-modal [data-act]"); await sleep(800);
  ok("F6 服务端拒绝时框里说明原因、框不关", (await ev(`!!document.querySelector(".portal-modal")`)) && (await txt()).includes("当前状态不允许该操作"));

  // ═══ G 导航 ═══
  await open("portal/admin/offerings/", adminScen());
  ok("G1 后台导航里有「开课与编班」", await ev(`[...document.querySelectorAll("nav a")].some(a=>a.textContent.includes("开课与编班"))`));
  ok("G2 全程没有请求离开本机", external === 0, `外部请求 ${external} 次`);
} catch (e) {
  fails++; console.log("  FAIL  测试过程抛错：" + e.message);
} finally {
  try { ws.close(); } catch {}
  chrome.kill(); server.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
console.log(`\nSIS PAGES: ${pass} PASS / ${fails} FAIL`);
process.exit(fails ? 1 : 0);
