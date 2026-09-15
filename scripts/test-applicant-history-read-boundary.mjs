#!/usr/bin/env node
/* 申请人历史页（portal/applicant/history/）：「读不到」与「无记录」必须分开显示。

   页面两处读取，各有四种结果：
     列表   Api.select("applications")          error / 非数组（null、{}、undefined）/ [] / 有记录
     时间线 Api.rpc("my_application_timeline")  error / 非数组 / [] / 有记录
   要求是**双向**的：读不到时不许出现「没有」的说法，无记录时也不许出现「没读到」的说法；
   读不到时给出的重试入口要真能重新发请求。

   与 test-read-failures.mjs 的 Hn 段的关系：那一段要起 Chrome，判据多是单向的
   （Hn2 只断言「不说没有」，Hn4 只断言「说了没有」），也没验证重试真的会重新请求。
   这里补齐两向与重试，而且不开浏览器，几百毫秒跑完。

   做法：从 HTML 取出页面自己的内联脚本，放进 node:vm，
   用桩替换 AmasShell / AmasApi / AmasUI / document / location，逐个情形看它渲染了什么、调了什么。
   只读页面源码，不联网、不写文件。

   运行：node scripts/test-applicant-history-read-boundary.mjs
   退出码：0 全部情形符合预期；1 有情形不符合预期；2 页面脚本没取到（空转不算通过）。 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "portal/applicant/history/index.html";

const html = fs.readFileSync(path.join(ROOT, PAGE), "utf8");
const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/(?:^|\s)src\s*=/i.test(m[1]) && m[2].includes('Api.select("applications"'));
if (inline.length !== 1) {
  console.error(`  ${PAGE} 里含 applications 读取的内联脚本应恰有 1 段，实际 ${inline.length} 段 —— 空转不算通过。`);
  process.exit(2);
}
const CODE = inline[0][2];

/* 页面文案（判据对准原句，免得宽泛的正则把另一种说法也吞进来） */
const LIST_UNREAD = "这一次没读到你的历史申请";
const LIST_EMPTY = /还没有历史记录|你目前没有已结束的申请/;
const TL_UNREAD = /没能读到状态变化/;
const TL_EMPTY = "这份申请没有可显示的状态变化记录";

function mkEl(extra = {}) {
  const listeners = {};
  return {
    innerHTML: "", textContent: "", hidden: false, disabled: false, dataset: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    appendChild(c) { this.children = (this.children || []).concat(c); return c; },
    listeners,
    ...extra,
  };
}

const ROW = { id: "a1", pathway: "bth", status: "rejected", applicant_visible_message: "很遗憾",
  submitted_at: "2026-08-01T00:00:00Z", decided_at: "2026-08-10T00:00:00Z", created_at: "2026-07-01T00:00:00Z" };

async function mount({ list, timeline = [] }) {
  const calls = { error: [], empty: [], reload: 0, select: 0, rpc: [] };
  const main = mkEl();
  const byId = {};
  const tlQueue = [...timeline];
  const context = {
    console, Date,
    window: {},
    location: { reload: () => { calls.reload++; }, href: "" },
    history: { back() {} },
    document: {
      /* 页面用 innerHTML 拼出元素再按 id 取：按 id 是否出现在 main 的 HTML 里来决定有没有这个元素。 */
      getElementById: (id) => (main.innerHTML.includes(`id="${id}"`) ? (byId[id] ||= mkEl()) : null),
      createElement: () => mkEl(),
    },
  };
  context.window.AmasAuth = { ROOT: "/" };
  context.window.AmasShell = { mount: async () => ({ main }) };
  context.window.AmasApi = {
    select: async () => { calls.select++; return list; },
    rpc: async (name, args) => { calls.rpc.push({ name, args }); return tlQueue.length ? tlQueue.shift() : { data: [], error: null }; },
    msg: (code) => "msg:" + code,
  };
  context.window.AmasUI = {
    loading() {},
    error: (node, opts) => { calls.error.push(opts); },
    empty: (node, opts) => { calls.empty.push(opts); node.innerHTML = (opts.title || "") + (opts.text || ""); },
    box: (icon, title, text) => `<div class="state">${title}${text}</div>`,
    esc: (s) => String(s),
  };
  vm.createContext(context);
  await vm.runInContext(CODE, context, { filename: PAGE });

  /* 可见文本 = main 自己的 HTML + 追加进去的子节点（空态是 UI.empty 渲染到追加的 slot 里） */
  const text = () => main.innerHTML + (main.children || []).map((c) => c.innerHTML).join("");

  /* 时间线：造一张卡片，把 main 的 click 监听当作用户点了「查看状态变化」 */
  const box = mkEl({ hidden: true });
  const btn = mkEl({ textContent: "查看状态变化" });
  btn.dataset.tl = ROW.id;
  const card = { querySelector: (sel) => (sel === ".tl" ? box : null) };
  btn.closest = (sel) => (sel === ".hitem" ? card : null);
  const clickTimeline = async () => {
    for (const f of main.listeners.click || []) await f({ target: { closest: (sel) => (sel === "[data-tl]" ? btn : null) } });
  };
  return { calls, main, text, byId, box, btn, clickTimeline };
}

/* ── 列表 ─────────────────────────────────────────────── */
const listUnreadable = (label) => async (m) => {
  const p = [];
  const t = m.text();
  if (!t.includes(LIST_UNREAD)) p.push(`没有说「${LIST_UNREAD}」`);
  if (LIST_EMPTY.test(t)) p.push(`${label}时却出现了「没有记录」的说法`);
  if (m.calls.empty.length) p.push("调用了空态 UI.empty");
  const reload = m.byId.btnHistReload;
  if (!reload || !(reload.listeners.click || []).length) p.push("没有可点的「刷新页面」");
  else { reload.listeners.click[0](); if (m.calls.reload !== 1) p.push(`点刷新后 reload ${m.calls.reload} 次，预期 1`); }
  return p;
};

const CASES = [
  {
    name: "列表 error → 报错 + 重试，不出现「没有记录」",
    setup: { list: { data: null, error: { code: "forbidden", message: "你没有权限查看这些内容。" } } },
    check: async (m) => {
      const p = [];
      if (m.calls.error.length !== 1) p.push(`UI.error 调用 ${m.calls.error.length} 次，预期 1`);
      const o = m.calls.error[0] || {};
      if (!/没有权限/.test(o.message || "")) p.push(`提示不是服务端原因：${o.message}`);
      if (typeof o.onRetry !== "function") p.push("没有重试入口");
      else { o.onRetry(); if (m.calls.reload !== 1) p.push("重试没有 reload"); }
      if (m.calls.empty.length || LIST_EMPTY.test(m.text())) p.push("读失败时出现了「没有记录」");
      return p;
    },
  },
  { name: "列表 data = null → 说没读到 + 刷新，不说没有", setup: { list: { data: null, error: null } }, check: listUnreadable("data=null") },
  { name: "列表 data = {} → 同上", setup: { list: { data: {}, error: null } }, check: listUnreadable("data={}") },
  { name: "列表 data = undefined → 同上", setup: { list: { data: undefined, error: null } }, check: listUnreadable("data=undefined") },
  {
    name: "列表 data = [] → 说还没有历史记录，不说没读到",
    setup: { list: { data: [], error: null } },
    check: async (m) => {
      const p = [];
      const t = m.text();
      if (m.calls.empty.length !== 1 || !/还没有历史记录/.test(m.calls.empty[0].title || "")) p.push("没有渲染「还没有历史记录」空态");
      if (t.includes(LIST_UNREAD) || m.byId.btnHistReload) p.push("无记录时却出现了「没读到 / 刷新」");
      if (m.calls.error.length) p.push("无记录时调用了 UI.error");
      return p;
    },
  },
  {
    name: "列表有记录 → 渲染卡片，两种状态说法都不出现",
    setup: { list: { data: [ROW], error: null } },
    check: async (m) => {
      const p = [];
      const t = m.text();
      if (!t.includes(`data-app="${ROW.id}"`)) p.push("没有渲染记录卡片");
      if (t.includes(LIST_UNREAD) || LIST_EMPTY.test(t) || m.calls.empty.length || m.calls.error.length) p.push("出现了读不到或无记录的说法");
      return p;
    },
  },

  /* ── 时间线 ─────────────────────────────────────────── */
  ...[
    ["时间线 error", { data: null, error: { code: "server_error", message: "服务暂时不可用。" } }, /服务暂时不可用/],
    ["时间线 data = null", { data: null, error: null }, TL_UNREAD],
    ["时间线 data = {}", { data: {}, error: null }, TL_UNREAD],
  ].map(([label, first, want]) => ({
    name: `${label} → 说没读到、不说没有记录；**下一次点击就重新请求**`,
    setup: { list: { data: [ROW], error: null }, timeline: [first, { data: [], error: null }] },
    check: async (m) => {
      const p = [];
      await m.clickTimeline();
      if (m.calls.rpc.length !== 1) p.push(`第一次点击请求 ${m.calls.rpc.length} 次，预期 1`);
      if (m.box.hidden) p.push("没有展示结果区");
      if (!want.test(m.box.innerHTML)) p.push(`结果区没有 ${want}：${m.box.innerHTML}`);
      if (m.box.innerHTML.includes(TL_EMPTY)) p.push("读不到时出现了「没有可显示的状态变化记录」");
      if (m.btn.dataset.loaded === "1") p.push("读不到却被标成已加载");
      await m.clickTimeline();
      if (m.calls.rpc.length !== 2) p.push(`读不到之后再点一次，请求累计 ${m.calls.rpc.length} 次，预期 2（没有重试，只是把提示收起来了）`);
      return p;
    },
  })),
  {
    name: "时间线 data = [] → 说没有可显示的记录、不说没读到；标为已加载，再点只收起不重复请求",
    setup: { list: { data: [ROW], error: null }, timeline: [{ data: [], error: null }] },
    check: async (m) => {
      const p = [];
      await m.clickTimeline();
      if (!m.box.innerHTML.includes(TL_EMPTY)) p.push("没有说「这份申请没有可显示的状态变化记录」");
      if (TL_UNREAD.test(m.box.innerHTML)) p.push("无记录时出现了「没能读到」");
      if (m.btn.dataset.loaded !== "1") p.push("没有标为已加载");
      await m.clickTimeline();
      if (!m.box.hidden) p.push("再点一次没有收起");
      if (m.calls.rpc.length !== 1) p.push(`请求累计 ${m.calls.rpc.length} 次，预期 1`);
      return p;
    },
  },
  {
    name: "时间线有记录 → 渲染行，两种状态说法都不出现",
    setup: { list: { data: [ROW], error: null },
      timeline: [{ data: [{ created_at: "2026-08-10T00:00:00Z", to_status: "rejected", applicant_visible_message: "很遗憾" }], error: null }] },
    check: async (m) => {
      const p = [];
      await m.clickTimeline();
      if (!m.box.innerHTML.includes("tl-row")) p.push("没有渲染时间线行");
      if (TL_UNREAD.test(m.box.innerHTML) || m.box.innerHTML.includes(TL_EMPTY)) p.push("出现了读不到或无记录的说法");
      return p;
    },
  },
];

let bad = 0;
for (const c of CASES) {
  let problems;
  try {
    problems = await c.check(await mount(c.setup));
  } catch (e) {
    problems = ["页面脚本或检查抛出异常：" + (e && e.stack || e)];
  }
  if (problems.length) {
    bad++;
    console.log("  FAIL  " + c.name + "\n        " + problems.join("；"));
  } else {
    console.log("  ok    " + c.name);
  }
}

console.log("\n──────────────────────────────");
console.log(`  ${PAGE} ｜ 情形 ${CASES.length} 个 ｜ 不符合预期 ${bad} 个`);
console.log("  node:vm + 桩运行页面内联脚本：未开浏览器、未联网、未写文件。");
process.exit(bad ? 1 : 0);
