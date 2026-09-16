#!/usr/bin/env node
/* 教务侧两处列表：读不到时不能说「没有」。

   portal/admin/teachers/  教师验证申请列表：`render(data || [])` —— 无结论（error 为空、data 不是数组）时
                           渲染成空列表，页面写「没有符合条件的申请」。
   portal/admin/index.html ② 验证申请审核队列：`const rows = data || []` —— 同上，显示「暂无待处理申请」。
   portal/admin/students/  「待建档」与「在册学生」两个面板：`if (!data || !data.length)` —— 对象形状（{}）
                           也会落进空态，写「没有待建档的申请」「还没有学籍记录」。
   这两句话对教务的后果很具体：真有待审核的申请时，他会以为没有，于是不去处理。
   真的没有（[]）时照旧那样说 —— 不能为了修这个把正常话堵掉。

   做法：从 HTML 取出页面内联脚本放进 node:vm，用桩替换共享层；admin 首页直接用 A.client，桩里给出可链式调用的查询对象。
   不开浏览器、不联网、不写文件。

   运行：node scripts/test-admin-read-boundary.mjs
   退出码：0 全部情形符合预期；1 有情形不符合预期；2 页面脚本没取到（空转不算通过）。 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function pageScript(rel, marker) {
  const html = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const hits = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/(?:^|\s)src\s*=/i.test(m[1]) && m[2].includes(marker));
  if (hits.length !== 1) { console.error(`  ${rel} 里含 ${marker} 的内联脚本应恰有 1 段，实际 ${hits.length} 段。`); process.exit(2); }
  return hits[0][2];
}

const mkEl = (id) => {
  const listeners = {};
  const el = { id, innerHTML: "", textContent: "", value: "", hidden: false, disabled: false, dataset: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (on ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); } },
    setAttribute() {}, removeAttribute() {}, focus() {}, appendChild() {},
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, listeners };
  return el;
};

const REQ = (i) => ({ id: "r" + i, user_id: "u" + i, status: "submitted",
  submitted_data: { name: "教师" + i, organization: "机构", teaching_areas: "旧约", phone: "0800" },
  submitted_at: "2026-09-01T00:00:00Z", reviewed_at: null, applicant_visible_message: null, created_at: "2026-08-20T00:00:00Z",
  profiles: { display_name: "教师" + i, email: "t" + i + "@example.invalid" } });

/* ── portal/admin/teachers/ ───────────────────────────── */
const TEACHERS_REL = "portal/admin/teachers/index.html";
const TEACHERS_CODE = pageScript(TEACHERS_REL, 'Api.select("teacher_verification_requests"');

async function runTeachers(result) {
  const calls = { error: [], empty: [], reload: 0 };
  const main = mkEl("main");
  const listEl = mkEl("list");
  main.querySelector = (sel) => (sel === "#list" ? listEl : null);
  const ctx = { console: { log() {}, error() {}, debug() {} }, Date, Object, Array, JSON, Map, Set, Number, String,
    window: {}, location: { reload: () => { calls.reload++; } }, history: { back() {} },
    document: { getElementById: () => null, createElement: () => mkEl("x"), querySelector: () => null, querySelectorAll: () => [],
      activeElement: null, body: mkEl("body"), addEventListener() {}, removeEventListener() {} } };
  ctx.window.AmasAuth = { ROOT: "/", fetchSession: async () => ({ failed: false, session: { user: { id: "me" } } }) };
  ctx.window.AmasShell = { mount: async () => ({ main, ctx: { session: { user: { id: "me" } } } }) };
  ctx.window.AmasApi = { select: async () => result, rpc: async () => ({ data: null, error: null }),
    fn: async () => ({ data: null, error: null }), msg: (c) => "msg:" + c };
  ctx.window.AmasUI = { loading() {}, esc: (s) => String(s == null ? "" : s), toast() {}, confirmDialog: async () => false,
    box: (i, t, x) => `<div><b>${t}</b><p>${x}</p></div>`,
    empty: (node, opts) => { calls.empty.push(opts); node.innerHTML = `<div><b>${opts.title}</b><p>${opts.text || ""}</p></div>`; },
    error: (node, opts) => { calls.error.push(opts); (node.innerHTML !== undefined) && (node.innerHTML = "[载入失败] " + opts.message); } };
  vm.createContext(ctx);
  let thrown = null;
  try { await vm.runInContext(TEACHERS_CODE, ctx, { filename: TEACHERS_REL }); } catch (e) { thrown = e; }
  return { calls, thrown, text: () => (main.innerHTML + listEl.innerHTML).replace(/<[^>]+>/g, "") };
}

/* ── portal/admin/index.html（② 验证申请审核队列）────────── */
const ADMIN_REL = "portal/admin/index.html";
const ADMIN_CODE = pageScript(ADMIN_REL, 'teacher_verification_requests');

async function runAdminQueue(result) {
  const main = mkEl("main");
  const ids = {};
  const el = (id) => (ids[id] ||= mkEl(id));
  const q = { select: () => q, order: () => q, limit: () => Promise.resolve(result), eq: () => q,
    then: (res, rej) => Promise.resolve(result).then(res, rej) };
  const ctx = { console: { log() {}, error() {}, debug() {} }, Date, Object, Array, JSON, Map, Set, Number, String,
    window: {}, location: { reload() {}, href: "" }, history: { back() {} }, navigator: { clipboard: { writeText: async () => {} } },
    document: { getElementById: (id) => el(id), createElement: () => mkEl("x"), querySelector: () => null, querySelectorAll: () => [],
      body: mkEl("body"), addEventListener() {}, removeEventListener() {} } };
  ctx.window.AmasAuth = { ROOT: "/", client: { from: () => q }, sessionEnded: () => false,
    watchSession: () => () => {}, signOut: async () => {}, getProfile: async () => ({ data: { display_name: "教务" }, error: null }),
    requireRoleAal: async () => ({ session: { user: { id: "me" } }, roles: ["registrar"] }),
    requireRoleAal2: async () => ({ session: { user: { id: "me" } }, roles: ["registrar"] }),
    requireRole: async () => ({ session: { user: { id: "me" } }, roles: ["registrar"] }),
    getAal: async () => ({ current: "aal2", next: "aal2" }), getRoles: async () => ["registrar"], fetchRoles: async () => ({ failed: false, roles: ["registrar"] }),
    callFn: async () => ({ status: 200, data: { ok: true } }),
    fetchSession: async () => ({ failed: false, session: { user: { id: "me" } } }) };
  ctx.window.AmasShell = { mount: async () => ({ main, ctx: { session: { user: { id: "me" } } } }) };
  ctx.window.AmasApi = { select: async () => ({ data: [], error: null }), rpc: async () => ({ data: null, error: null }),
    fn: async () => ({ data: null, error: null }), msg: (c) => "msg:" + c };
  ctx.window.AmasUI = { loading() {}, esc: (s) => String(s == null ? "" : s), toast() {}, confirmDialog: async () => false,
    box: (i, t, x) => `<div><b>${t}</b><p>${x}</p></div>`, empty() {}, error() {} };
  vm.createContext(ctx);
  let thrown = null;
  try { await vm.runInContext(ADMIN_CODE, ctx, { filename: ADMIN_REL }); } catch (e) { thrown = e; }
  return { thrown, ids,
    qErrShown: () => !!(ids.qErr && ids.qErr.classList.contains("show")),
    qErrText: () => (ids.qErr ? ids.qErr.textContent : ""),
    qEmptyShown: () => !!(ids.qEmpty && ids.qEmpty.classList.contains("show")),
    tableHidden: () => (ids.qTable ? ids.qTable.hidden : null),
    rowCount: () => ((ids.qBody && ids.qBody.innerHTML.match(/<tr/g)) || []).length };
}

/* ── portal/admin/students/（待建档 / 在册学生两个面板）──── */
const STUDENTS_REL = "portal/admin/students/index.html";
const STUDENTS_CODE = pageScript(STUDENTS_REL, 'admissions_ready_for_enrollment');

/* tab 参数决定初始面板：queue = 待建档（读 rpc），students = 在册学生（读 student_records） */
async function runStudents(tab, result) {
  const calls = { error: [] };
  const main = mkEl("main");
  const panel = mkEl("panel");
  const ids = {};
  /* 页面用 main.querySelectorAll("[data-tab]") 给四个标签挂监听：按它渲染出的 HTML 动态造按钮，
     这样「切到在册学生」这一步才真的走页面自己的那条路。 */
  const tabBtns = [];
  main.querySelectorAll = (sel) => {
    if (sel !== "[data-tab]") return [];
    if (!tabBtns.length) {
      for (const m of String(main.innerHTML).matchAll(/data-tab="([^"]+)"/g)) {
        const b = mkEl("tab-" + m[1]); b.dataset.tab = m[1]; tabBtns.push(b);
      }
    }
    return tabBtns;
  };
  const ctx = { console: { log() {}, error() {}, debug() {} }, Date, Object, Array, JSON, Map, Set, Number, String,
    window: {}, location: { reload() {} }, history: { back() {} },
    document: { getElementById: (id) => (id === "panel" ? panel : (ids[id] ||= mkEl(id))), createElement: () => mkEl("x"),
      querySelector: () => null, querySelectorAll: () => [], body: mkEl("body"), addEventListener() {}, removeEventListener() {} } };
  ctx.window.AmasAuth = { ROOT: "/", client: { from: () => ({}) }, sessionEnded: () => false, watchSession: () => () => {},
    callFn: async () => ({ status: 200, data: { ok: true } }), fetchSession: async () => ({ failed: false, session: { user: { id: "me" } } }) };
  ctx.window.AmasShell = { mount: async () => ({ main, ctx: { session: { user: { id: "me" } } } }) };
  ctx.window.AmasApi = {
    rpc: async (n) => (n === "admissions_ready_for_enrollment" && tab === "queue" ? result : { data: [], error: null }),
    select: async (t) => {
      if (t === "program_catalog") return { data: [{ code: "bth", name_zh: "神学本科", short_label: "B.Th" }], error: null };
      if (t === "student_records" && tab === "students") return result;
      return { data: [], error: null };
    },
    fn: async () => ({ data: null, error: null }), msg: (c) => "msg:" + c };
  ctx.window.AmasUI = { loading() {}, esc: (s) => String(s == null ? "" : s), toast() {}, confirmDialog: async () => false,
    skeleton: () => "[骨架]", timeline: () => "", render: () => {},
    box: (i, t, x) => `<div><b>${t}</b><p>${x}</p></div>`, empty() {},
    error: (node, opts) => { calls.error.push(opts); if (node && node.innerHTML !== undefined) node.innerHTML = "[载入失败] " + opts.message; } };
  vm.createContext(ctx);
  let thrown = null;
  try { await vm.runInContext(STUDENTS_CODE, ctx, { filename: STUDENTS_REL }); } catch (e) { thrown = e; }
  /* 面板渲染发生在 IIFE 之后的异步回合里，要把事件循环放空几轮才量得到 */
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  await flush();
  /* 默认面板是「待建档」；要量在册学生就点那个标签 */
  if (tab === "students") {
    const b = tabBtns.find((x) => x.dataset.tab === "students");
    if (b && b.listeners.click) { b.listeners.click[0](); await flush(); }
  }
  return { calls, thrown, text: () => panel.innerHTML.replace(/<[^>]+>/g, "") };
}

const NET = { data: null, error: { code: "network", message: "网络连接异常，请检查网络后重试。" } };
const UNREAD = /没能读到|没读到/;

const CASES = [
  { name: "教务·教师验证列表：读失败 → 整块报错 + 重试（原有行为，钉住）",
    run: async () => { const r = await runTeachers(NET); const p = [];
      if (r.calls.error.length !== 1) p.push("没有报错"); if (typeof (r.calls.error[0] || {}).onRetry !== "function") p.push("没有重试入口");
      if (/换一个状态筛选/.test(r.text())) p.push("读失败被说成了没有申请（空态原文出现了）"); return p; } },
  { name: "教务·教师验证列表：无结论 data=null → 不许说「没有符合条件的申请」",
    run: async () => { const r = await runTeachers({ data: null, error: null }); const p = [];
      if (r.thrown) p.push("抛异常：" + r.thrown.message);
      if (/换一个状态筛选/.test(r.text())) p.push("把读不到说成了没有申请（空态原文出现了）");
      if (!(r.calls.error.length === 1 || UNREAD.test(r.text()))) p.push("既没报错也没说没读到"); return p; } },
  { name: "教务·教师验证列表：无结论 data={} → 同上",
    run: async () => { const r = await runTeachers({ data: {}, error: null }); const p = [];
      if (/换一个状态筛选/.test(r.text())) p.push("把读不到说成了没有申请（空态原文出现了）");
      if (!(r.calls.error.length === 1 || UNREAD.test(r.text()))) p.push("既没报错也没说没读到"); return p; } },
  { name: "教务·教师验证列表：真的没有 data=[] → 照旧说「没有符合条件的申请」",
    run: async () => { const r = await runTeachers({ data: [], error: null }); const p = [];
      if (!/换一个状态筛选/.test(r.text())) p.push("空数组时没有显示空态");
      if (r.calls.error.length) p.push("空数组不该整块报错"); return p; } },
  { name: "教务·教师验证列表：有申请 → 列出来，不出现空态",
    run: async () => { const r = await runTeachers({ data: [REQ(1), REQ(2)], error: null }); const p = [];
      const t = r.text(); if (!t.includes("教师1")) p.push("没有列出申请");
      if (/换一个状态筛选/.test(t) || UNREAD.test(t)) p.push("有数据时出现了空态或没读到"); return p; } },

  { name: "教务首页·审核队列：读失败 → 显示读取失败（原有行为，钉住）",
    run: async () => { const r = await runAdminQueue(NET); const p = [];
      if (!r.qErrShown()) p.push("没有显示错误"); if (r.qEmptyShown()) p.push("读失败时显示了「暂无待处理申请」"); return p; } },
  { name: "教务首页·审核队列：无结论 data=null → 不许显示「暂无待处理申请」",
    run: async () => { const r = await runAdminQueue({ data: null, error: null }); const p = [];
      if (r.thrown) p.push("抛异常：" + r.thrown.message);
      if (r.qEmptyShown()) p.push("把读不到显示成了「暂无待处理申请」");
      if (!(r.qErrShown() && UNREAD.test(r.qErrText()))) p.push(`没有说没读到（qErr=「${r.qErrText()}」）`); return p; } },
  { name: "教务首页·审核队列：无结论 data={} → 同上",
    run: async () => { const r = await runAdminQueue({ data: {}, error: null }); const p = [];
      if (r.qEmptyShown()) p.push("把读不到显示成了「暂无待处理申请」");
      if (!(r.qErrShown() && UNREAD.test(r.qErrText()))) p.push("没有说没读到"); return p; } },
  { name: "教务首页·审核队列：真的没有 data=[] → 照旧显示「暂无待处理申请」、表格隐藏",
    run: async () => { const r = await runAdminQueue({ data: [], error: null }); const p = [];
      if (!r.qEmptyShown()) p.push("空数组时没有显示空态"); if (r.tableHidden() !== true) p.push("空数组时表格没有隐藏");
      if (r.qErrShown()) p.push("空数组时显示了错误"); return p; } },
  { name: "教务首页·审核队列：有申请 → 表格显示且有行",
    run: async () => { const r = await runAdminQueue({ data: [REQ(1), REQ(2)], error: null }); const p = [];
      if (r.tableHidden() !== false) p.push("有数据时表格仍隐藏"); if (r.rowCount() !== 2) p.push("行数 " + r.rowCount());
      if (r.qEmptyShown()) p.push("有数据时显示了空态"); return p; } },

  { name: "教务·待建档面板：读失败 → 报错 + 重试（原有行为，钉住）",
    run: async () => { const r = await runStudents("queue", NET); const p = [];
      if (r.calls.error.length !== 1) p.push("没有报错"); if (/只有「已录取/.test(r.text())) p.push("读失败被说成了没有待建档（空态原文出现了）"); return p; } },
  { name: "教务·待建档面板：无结论 data=null → 不许说「没有待建档的申请」",
    run: async () => { const r = await runStudents("queue", { data: null, error: null }); const p = [];
      if (/只有「已录取/.test(r.text())) p.push("把读不到说成了没有待建档（空态原文出现了）");
      if (!(r.calls.error.length === 1 || UNREAD.test(r.text()))) p.push("既没报错也没说没读到"); return p; } },
  { name: "教务·待建档面板：无结论 data={} → 同上",
    run: async () => { const r = await runStudents("queue", { data: {}, error: null }); const p = [];
      if (/只有「已录取/.test(r.text())) p.push("把读不到说成了没有待建档（空态原文出现了）");
      if (!(r.calls.error.length === 1 || UNREAD.test(r.text()))) p.push("既没报错也没说没读到"); return p; } },
  { name: "教务·待建档面板：真的没有 data=[] → 照旧说「没有待建档的申请」",
    run: async () => { const r = await runStudents("queue", { data: [], error: null }); const p = [];
      if (!/只有「已录取/.test(r.text())) p.push("空数组时没有显示空态"); if (r.calls.error.length) p.push("空数组不该报错"); return p; } },
  { name: "教务·在册学生面板：无结论 data={} → 不许说「还没有学籍记录」",
    run: async () => { const r = await runStudents("students", { data: {}, error: null }); const p = [];
      if (/完成建档后，学生会出现在这里/.test(r.text())) p.push("把读不到说成了还没有学籍记录（空态原文出现了）");
      if (!(r.calls.error.length >= 1 || UNREAD.test(r.text()))) p.push("既没报错也没说没读到"); return p; } },
  { name: "教务·在册学生面板：真的没有 data=[] → 照旧说「还没有学籍记录」",
    run: async () => { const r = await runStudents("students", { data: [], error: null }); const p = [];
      if (!/完成建档后，学生会出现在这里/.test(r.text())) p.push("空数组时没有显示空态"); return p; } },
];

let bad = 0;
for (const c of CASES) {
  let p;
  try { p = await c.run(); } catch (e) { p = ["抛出异常：" + (e && e.message)]; }
  if (p.length) { bad++; console.log("  FAIL  " + c.name + "\n        " + p.join("；")); }
  else console.log("  ok    " + c.name);
}
console.log("\n──────────────────────────────");
console.log(`  教务侧两处列表 ｜ 情形 ${CASES.length} 个 ｜ 不符合预期 ${bad} 个`);
console.log("  node:vm + 桩运行页面内联脚本：未开浏览器、未联网、未写文件。");
process.exit(bad ? 1 : 0);
