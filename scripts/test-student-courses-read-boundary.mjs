#!/usr/bin/env node
/* 学员课程目录页（portal/student/courses/）：读不到课程时不能说成「共 0 门」。

   契约：public.my_learning() returns table（0019_student_role_gating.sql:103），正常是数组。
   原来只判 `if (error)`，随后 `const list = rows || []`：
     · 服务端没给出结论（error 为空、data 为 null）→ 页面写「AMAS 正式课程共 **0** 门」
       「当前 0 门已有线上学习内容，0 门内容筹备中」。学校有 67 门课，这是一句平白的假话；
     · data 是对象（{}）→ `list.filter` 抛 TypeError，页面**一直停在骨架屏**，既没有提示也没有出路。
   学员首页（portal/student/）早就按 `learnErr || !Array.isArray(learn)` 守住了，这一页没有。
   真的没有课程（data: []）时照旧说 0 门 —— 那是事实，不能为了修这个把正常话堵掉。

   做法：从 HTML 取出页面内联脚本放进 node:vm，用桩替换共享层。不开浏览器、不联网、不写文件。

   运行：node scripts/test-student-courses-read-boundary.mjs
   退出码：0 全部情形符合预期；1 有情形不符合预期；2 页面脚本没取到（空转不算通过）。 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REL = "portal/student/courses/index.html";
const html = fs.readFileSync(path.join(ROOT, REL), "utf8");
const hits = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/(?:^|\s)src\s*=/i.test(m[1]) && m[2].includes('Api.rpc("my_learning")'));
if (hits.length !== 1) { console.error(`  ${REL} 里含 my_learning 读取的内联脚本应恰有 1 段，实际 ${hits.length} 段。`); process.exit(2); }
const CODE = hits[0][2];

const mkEl = () => {
  const listeners = {};
  return { innerHTML: "", textContent: "", value: "", dataset: {}, hidden: false,
    classList: { add() {}, remove() {}, contains: () => false }, setAttribute() {}, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], addEventListener(t, f) { (listeners[t] ||= []).push(f); }, listeners };
};

const COURSE = (i, availability) => ({ code: "C" + i, title_zh: "课程" + i, category: "nt", level: "intro",
  total_lessons: 10, availability, credits: null, learning_state: "content_pending" });

async function run(learning, cap = { data: { course_content_access: false }, error: null }) {
  const calls = { error: [], reload: 0 };
  const main = mkEl();
  const byId = {};
  const ctx = { console: { log() {}, error() {}, debug() {} }, Date, Object, Array, JSON, Set, Number, String,
    window: {}, location: { reload: () => { calls.reload++; } }, history: { back() {} },
    document: { getElementById: (id) => (main.innerHTML.includes(`id="${id}"`) ? (byId[id] ||= mkEl()) : null), createElement: () => mkEl(), querySelector: () => null } };
  ctx.window.AmasAuth = { ROOT: "/" };
  ctx.window.AmasShell = { mount: async () => ({ main }) };
  ctx.window.AmasApi = { rpc: async (n) => (n === "my_learning" ? learning : cap), msg: (c) => c };
  ctx.window.AmasUI = { loading() {}, esc: (s) => String(s == null ? "" : s),
    box: (icon, title, text) => `<div class="state"><b>${title}</b><p>${text}</p></div>`,
    error: (node, opts) => { calls.error.push(opts); } };
  vm.createContext(ctx);
  let thrown = null;
  try { await vm.runInContext(CODE, ctx, { filename: REL }); } catch (e) { thrown = e; }
  const text = () => (main.innerHTML + Object.values(byId).map((e) => e.innerHTML).join("")).replace(/<[^>]+>/g, "");
  return { calls, main, thrown, text };
}

const unreadable = (label) => (r) => {
  const p = [];
  if (r.thrown) p.push("页面脚本抛出异常（会卡在骨架屏）：" + r.thrown.message);
  if (r.calls.error.length !== 1) p.push(`UI.error 调用 ${r.calls.error.length} 次，预期 1`);
  const o = r.calls.error[0] || {};
  if (!o.message) p.push("没有提示文案");
  if (typeof o.onRetry !== "function") p.push("没有重试入口");
  else { o.onRetry(); if (r.calls.reload !== 1) p.push("重试没有 reload"); }
  if (/共\s*<?b?>?0<?\/?b?>?\s*门|共 0 门/.test(r.text())) p.push(`${label}时仍写「共 0 门」`);
  return p;
};

const CASES = [
  { name: "读失败（error）→ 报错 + 重试（原有行为，钉住）", learning: { data: null, error: { code: "network", message: "网络连接异常，请检查网络后重试。" } }, check: unreadable("读失败") },
  { name: "无结论 data = null → 不许写「共 0 门」，要报错 + 重试", learning: { data: null, error: null }, check: unreadable("data=null") },
  { name: "无结论 data = undefined → 同上", learning: { data: undefined, error: null }, check: unreadable("data=undefined") },
  { name: "无结论 data = {} → 同上，且不能抛异常卡在骨架屏", learning: { data: {}, error: null }, check: unreadable("data={}") },
  {
    name: "真的没有课程 data = [] → 照旧说共 0 门，不报错（不能为了修上面把正常话堵掉）",
    learning: { data: [], error: null },
    check: (r) => {
      const p = [];
      if (r.thrown) p.push("抛异常：" + r.thrown.message);
      if (r.calls.error.length) p.push("不该调用 UI.error");
      if (!/共 0 门/.test(r.text())) p.push("没有说共 0 门");
      return p;
    },
  },
  {
    name: "正常读到课程 → 按 availability 分别计数",
    learning: { data: [COURSE(1, "available"), COURSE(2, "in_development"), COURSE(3, "in_development")], error: null },
    check: (r) => {
      const p = [];
      if (r.thrown) p.push("抛异常：" + r.thrown.message);
      if (r.calls.error.length) p.push("不该调用 UI.error");
      const t = r.text();
      if (!/共 3 门/.test(t)) p.push("总数不对");
      if (!/当前 1 门已有线上学习内容，2 门内容筹备中/.test(t)) p.push("分项计数不对：" + t.slice(0, 120));
      return p;
    },
  },
  {
    name: "课程读到、能力读不到（cap 无结论）→ 课程照常显示，不抛异常",
    learning: { data: [COURSE(1, "available")], error: null }, cap: { data: null, error: { code: "server_error", message: "x" } },
    check: (r) => {
      const p = [];
      if (r.thrown) p.push("抛异常：" + r.thrown.message);
      if (r.calls.error.length) p.push("次要读取失败不该整页报错");
      if (!/共 1 门/.test(r.text())) p.push("没有显示课程数");
      return p;
    },
  },
];

let bad = 0;
for (const c of CASES) {
  const p = c.check(await run(c.learning, c.cap));
  if (p.length) { bad++; console.log("  FAIL  " + c.name + "\n        " + p.join("；")); }
  else console.log("  ok    " + c.name);
}
console.log("\n──────────────────────────────");
console.log(`  ${REL} ｜ 情形 ${CASES.length} 个 ｜ 不符合预期 ${bad} 个`);
console.log("  node:vm + 桩运行页面内联脚本：未开浏览器、未联网、未写文件。");
process.exit(bad ? 1 : 0);
