#!/usr/bin/env node
/* 学员中心首页（portal/student/）：三处「读不到」不能说成「没有」。

   这一页并排读六路。待办（my_action_items）与课程（my_learning）早就守住了
   （`actsErr || !Array.isArray(...)`，test-read-failures 的 S1/S2 钉着）；剩下三路没有：
     my_student_record   无结论（error 为空、data 不是数组）→ `rec = recRows && recRows[0]` 为空
                         → 页面写「**尚未查到你的学籍记录**」，把「读不到」说成「学校还没给你建档」；
     my_student_timeline error 被整个丢掉，`(tl || [])` → UI.timeline([]) → 「**暂无记录**」；
     program_catalog     error 被整个丢掉 → 修读项目显示「**待确认**」，与「教务还没定项目」无法区分。
   真的没有（[] / 没有 program_code）时，原来的说法要照旧 —— 不能为了修这个把正常话堵掉。

   做法：从 HTML 取出页面内联脚本放进 node:vm，用桩替换共享层。不开浏览器、不联网、不写文件。

   运行：node scripts/test-student-home-read-boundary.mjs
   退出码：0 全部情形符合预期；1 有情形不符合预期；2 页面脚本没取到（空转不算通过）。 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REL = "portal/student/index.html";
const html = fs.readFileSync(path.join(ROOT, REL), "utf8");
const hits = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/(?:^|\s)src\s*=/i.test(m[1]) && m[2].includes('Api.rpc("my_student_record")'));
if (hits.length !== 1) { console.error(`  ${REL} 里含 my_student_record 读取的内联脚本应恰有 1 段，实际 ${hits.length} 段。`); process.exit(2); }
const CODE = hits[0][2];

const mkEl = () => {
  const listeners = {};
  return { innerHTML: "", textContent: "", value: "", dataset: {}, hidden: false,
    classList: { add() {}, remove() {}, contains: () => false }, setAttribute() {}, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], appendChild() {},
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, listeners };
};

const REC = { student_number: "S-1", status: "active", program_code: "bth", created_at: "2026-01-02T00:00:00Z", activated_at: null };
const CATALOG = [{ code: "bth", name_zh: "神学本科", short_label: "B.Th" }];
const TL = [{ to_status: "active", student_visible_message: "已注册", created_at: "2026-02-01T00:00:00Z" }];
const LEARN = [{ code: "C1", availability: "available" }];

async function run({ record = { data: [REC], error: null }, timeline = { data: TL, error: null },
                     catalog = { data: CATALOG, error: null }, acts = { data: [], error: null },
                     learn = { data: LEARN, error: null } } = {}) {
  const calls = { error: [], reload: 0 };
  const main = mkEl();
  const byId = {};
  const ctx = { console: { log() {}, error() {}, debug() {} }, Date, Object, Array, JSON, Map, Set, Number, String,
    window: {}, location: { reload: () => { calls.reload++; }, href: "" }, history: { back() {} },
    document: { getElementById: (id) => (main.innerHTML.includes(`id="${id}"`) ? (byId[id] ||= mkEl()) : null), createElement: () => mkEl(), querySelector: () => null } };
  ctx.window.AmasAuth = { ROOT: "/" };
  ctx.window.AmasShell = { mount: async () => ({ main, profile: { display_name: "李学员", email: "s@example.invalid" } }) };
  ctx.window.AmasApi = {
    rpc: async (n) => ({ my_student_record: record, my_student_timeline: timeline, my_action_items: acts,
                         my_student_capabilities: { data: {}, error: null }, my_learning: learn }[n] || { data: null, error: null }),
    select: async () => catalog, msg: (c) => c,
  };
  ctx.window.AmasUI = { loading() {}, esc: (s) => String(s == null ? "" : s), toast() {},
    box: (icon, title, text) => `<div class="state"><b>${title}</b><p>${text}</p></div>`,
    timeline: (items) => (!items || !items.length ? `<div class="state"><b>暂无记录</b><p>状态变更后会在此显示。</p></div>` : `<ol>${items.length} 条</ol>`),
    error: (node, opts) => { calls.error.push(opts); } };
  vm.createContext(ctx);
  let thrown = null;
  try { await vm.runInContext(CODE, ctx, { filename: REL }); } catch (e) { thrown = e; }
  const text = () => (main.innerHTML + Object.values(byId).map((e) => e.innerHTML).join("")).replace(/<[^>]+>/g, "");
  return { calls, main, thrown, text };
}

const NOREC = "尚未查到你的学籍记录";
const UNREAD = /没能读到|没读到/;

const CASES = [
  /* ── my_student_record ── */
  { name: "学籍记录 error → 整页报错 + 重试（原有行为，钉住）", setup: { record: { data: null, error: { code: "network", message: "网络连接异常" } } },
    check: (r) => { const p = []; if (r.calls.error.length !== 1) p.push("没有整页报错"); const o = r.calls.error[0] || {};
      if (typeof o.onRetry !== "function") p.push("没有重试入口"); if (r.text().includes(NOREC)) p.push("读失败时说成了尚未查到学籍记录"); return p; } },
  { name: "学籍记录无结论 data=null → 不许说「尚未查到你的学籍记录」，要说没读到 + 重试", setup: { record: { data: null, error: null } },
    check: (r) => { const p = []; if (r.thrown) p.push("抛异常：" + r.thrown.message);
      const t = r.text(); if (t.includes(NOREC)) p.push("把读不到说成了尚未建档");
      if (!(r.calls.error.length === 1 || UNREAD.test(t))) p.push("既没报错也没说没读到");
      if (r.calls.error.length === 1) { r.calls.error[0].onRetry && r.calls.error[0].onRetry(); if (r.calls.reload !== 1) p.push("重试没有 reload"); }
      return p; } },
  { name: "学籍记录无结论 data={} → 同上", setup: { record: { data: {}, error: null } },
    check: (r) => { const p = []; const t = r.text(); if (t.includes(NOREC)) p.push("把读不到说成了尚未建档");
      if (!(r.calls.error.length === 1 || UNREAD.test(t))) p.push("既没报错也没说没读到"); return p; } },
  { name: "真的没有学籍记录 data=[] → 照旧说「尚未查到你的学籍记录」并给帮助入口", setup: { record: { data: [], error: null } },
    check: (r) => { const p = []; const t = r.text(); if (!t.includes(NOREC)) p.push("没有说尚未查到学籍记录");
      if (r.calls.error.length) p.push("空数组不该整页报错"); return p; } },

  /* ── my_student_timeline ── */
  { name: "最近活动读失败 → 不许显示「暂无记录」，要说这一次没读到", setup: { timeline: { data: null, error: { code: "server_error", message: "服务暂时不可用" } } },
    check: (r) => { const p = []; const t = r.text(); if (/暂无记录/.test(t)) p.push("读失败被说成了暂无记录");
      if (!UNREAD.test(t)) p.push("没有说这一次没读到"); return p; } },
  { name: "最近活动无结论 data={} → 同上", setup: { timeline: { data: {}, error: null } },
    check: (r) => { const p = []; const t = r.text(); if (/暂无记录/.test(t)) p.push("无结论被说成了暂无记录");
      if (!UNREAD.test(t)) p.push("没有说这一次没读到"); return p; } },
  { name: "真的没有活动 data=[] → 照旧显示「暂无记录」", setup: { timeline: { data: [], error: null } },
    check: (r) => (/暂无记录/.test(r.text()) ? [] : ["空数组时没有显示暂无记录"]) },

  /* ── program_catalog ── */
  { name: "项目目录读失败、而学籍里有 program_code → 修读项目不许显示「待确认」，要说没读到",
    setup: { catalog: { data: null, error: { code: "server_error", message: "x" } } },
    check: (r) => { const p = []; const t = r.text();
      if (/修读项目待确认/.test(t.replace(/\s/g, ""))) p.push("目录读失败被说成了待确认");
      if (!UNREAD.test(t)) p.push("没有说没读到"); return p; } },
  { name: "项目目录读到、但学籍里没有 program_code → 照旧显示「待确认」",
    setup: { record: { data: [{ ...REC, program_code: null }], error: null } },
    check: (r) => (/待确认/.test(r.text()) ? [] : ["没有显示待确认"]) },
  { name: "全部正常 → 显示学号、项目名与时间线，不出现任何「没读到」",
    setup: {},
    check: (r) => { const p = []; const t = r.text();
      if (!t.includes("S-1")) p.push("没有显示学号");
      if (!t.includes("神学本科")) p.push("没有显示项目名");
      if (UNREAD.test(t)) p.push("正常数据下出现了「没读到」");
      if (r.calls.error.length) p.push("不该整页报错"); return p; } },
];

let bad = 0;
for (const c of CASES) {
  let p;
  try { p = c.check(await run(c.setup)); } catch (e) { p = ["检查抛异常：" + (e && e.message)]; }
  if (p.length) { bad++; console.log("  FAIL  " + c.name + "\n        " + p.join("；")); }
  else console.log("  ok    " + c.name);
}
console.log("\n──────────────────────────────");
console.log(`  ${REL} ｜ 情形 ${CASES.length} 个 ｜ 不符合预期 ${bad} 个`);
console.log("  node:vm + 桩运行页面内联脚本：未开浏览器、未联网、未写文件。");
process.exit(bad ? 1 : 0);
