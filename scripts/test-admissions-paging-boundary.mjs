#!/usr/bin/env node
/* 申请记录分页的边界检查：首页、尾页、空页（portal/admin/admissions/，招生审核队列）。

   为什么是这一页：仓库里**唯一**做分页的列表就是招生队列 —— 按 PAGE=300 用 range 一页页取
   applications（含已录取 / 已拒绝 / 已撤回这些历史记录）。申请人自己的「历史申请」页一次取全，不分页。

   已有的 test-admin-writes.mjs Pg1~Pg6（要起 Chrome）量了：首页取满出现截断提示与「载入更早」、
   第二页短页合并且去重、短页后收起入口、总数不到上限时不出现截断提示。
   这里补上它没量的边界，而且不开浏览器：
     B1 第一页就是空的          B2 第一页是短页
     B3 第一页正好取满          B4 尾页是短页
     B5 总数恰为整页倍数：尾页取满、再翻一页是**空页** —— 必须改说「没有更多了」、收起入口、不重复
     B6 第一页读失败 → 整块报错，重试要的还是第 0 页
     B7 后续页读失败 → 已读到的照常显示并明说「不代表全部」，重试要的是**同一个区间**（偏移没被推进）
     B8 后续页返回非数组（无结论）→ 同 B7
     B9 翻页期间有人提交，下一页和已读的重叠 → 按 id 去重
   每一项同时核对发给服务端的 range：第 n 页（从 0 起）必须是 { from: 300n, to: 300n+299 }。

   做法：从 HTML 取出页面自己的内联脚本放进 node:vm，Api.select 按脚本化的逐页响应回答，
   其余共享层用桩。只读页面源码，不联网、不写文件。

   运行：node scripts/test-admissions-paging-boundary.mjs
   退出码：0 全部情形符合预期；1 有情形不符合预期；2 页面脚本没取到（空转不算通过）。 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REL = "portal/admin/admissions/index.html";
const html = fs.readFileSync(path.join(ROOT, REL), "utf8");
const hits = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/(?:^|\s)src\s*=/i.test(m[1]) && m[2].includes('Api.select("applications"'));
if (hits.length !== 1) { console.error(`  ${REL} 里含 applications 读取的内联脚本应恰有 1 段，实际 ${hits.length} 段。`); process.exit(2); }
const CODE = hits[0][2];
const PAGE = Number((CODE.match(/const PAGE = (\d+);/) || [])[1]);
if (!PAGE) { console.error("  没找到 const PAGE —— 空转不算通过。"); process.exit(2); }

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const row = (i) => ({ id: "app-" + String(i).padStart(5, "0"), applicant_id: "u" + i, pathway: "bth", status: "submitted",
  form_data: { name_zh: "申请人" + i }, locked_fields: [], submitted_at: new Date(Date.UTC(2026, 0, 1) + (100000 - i) * 60000).toISOString(),
  decided_at: null, updated_at: null, applicant_visible_message: null, assigned_reviewer: null });
const rows = (from, n) => Array.from({ length: n }, (_, k) => row(from + k));

function mkEl(id) {
  const listeners = {};
  return { id, value: "", disabled: false, innerHTML: "", textContent: "", dataset: {}, hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, focus() {}, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, listeners };
}

/* responses：第 k 次 applications 请求的回答（按顺序消费） */
async function mount(responses) {
  const log = { ranges: [], errors: [] };
  const main = mkEl("main");
  const els = {};
  let lastMore = null;
  const rendered = () => main.innerHTML + (els.list ? els.list.innerHTML : "");
  const document = {
    getElementById(id) {
      if (id === "btnMore") {
        /* renderList 每次都重建这个按钮：每次取都给一个新元素，禁用态按当前 HTML 来 */
        const m = (els.list ? els.list.innerHTML : "").match(/<button[^>]*id="btnMore"[^>]*>/);
        if (!m) return null;
        lastMore = mkEl("btnMore"); lastMore.disabled = /\sdisabled/.test(m[0]);
        return lastMore;
      }
      if (!rendered().includes(`id="${id}"`)) return null;
      return (els[id] ||= mkEl(id));
    },
    querySelector: () => null, querySelectorAll: () => [], createElement: () => mkEl("x"),
    addEventListener() {}, removeEventListener() {}, body: mkEl("body"), activeElement: null,
  };
  const queue = [...responses];
  const ctx = { console: { log() {}, error() {}, debug() {} }, Date, Object, Array, JSON, Map, Set, Number, String, Math, CSS: { escape: (s) => s },
    window: {}, document, location: { reload() {} }, history: { back() {} } };
  ctx.window.AmasAuth = { ROOT: "/", fetchSession: async () => ({ failed: false, session: { user: { id: "me" } } }) };
  ctx.window.AmasShell = { mount: async () => ({ main }) };
  ctx.window.AmasAppForm = {};
  ctx.window.AmasApi = {
    select: async (table, build) => {
      if (table !== "applications") return { data: [], error: null };
      log.ranges.push(build && build.range ? { ...build.range } : null);
      const next = queue.length ? queue.shift() : { data: [], error: null };
      return typeof next === "function" ? next() : next;
    },
    rpc: async () => ({ data: null, error: null }), fn: async () => ({ data: null, error: null }), msg: (c) => c,
  };
  const listEl = () => (els.list ||= mkEl("list"));
  ctx.window.AmasUI = {
    esc: (s) => String(s == null ? "" : s), skeleton: () => "[骨架]", toast() {}, confirmDialog: async () => false, timeline: () => "",
    box: (icon, title, text) => `<div class="state"><b>${title}</b><p>${text}</p></div>`,
    loading: (sel) => { if (sel === "#list") listEl().innerHTML = "[骨架]"; },
    render: (sel, h) => { if (sel === "#list") listEl().innerHTML = h; },
    error: (sel, opts) => { log.errors.push(opts); if (sel === "#list") listEl().innerHTML = "[载入失败] " + (opts.message || ""); },
  };
  vm.createContext(ctx);
  await vm.runInContext(CODE, ctx, { filename: REL });
  await flush();
  const view = () => {
    const h = listEl().innerHTML;
    return {
      html: h,
      text: h.replace(/<[^>]+>/g, ""),
      rowIds: [...h.matchAll(/data-open="([^"]+)"/g)].map((m) => m[1]),
      more: /id="btnMore"/.test(h),
      moreDisabled: /<button[^>]*id="btnMore"[^>]*\sdisabled/.test(h),
    };
  };
  /* 页面在 bindMore 里调 getElementById("btnMore") 取按钮并挂监听；lastMore 就是最近一次被页面取走的那个。
     这里**不能**自己再调 getElementById —— 那会换出一个没挂监听的新元素。 */
  const clickMore = async () => {
    const v = view();
    if (!v.more) throw new Error("页面上没有「载入更早」按钮可点");
    if (v.moreDisabled) throw new Error("「载入更早」按钮是禁用的");
    const bound = lastMore && lastMore.listeners.click && lastMore.listeners.click[0];
    if (!bound) throw new Error("按钮没有绑定点击动作");
    bound(); await flush();
  };
  const retryFirst = async () => { const o = log.errors[log.errors.length - 1]; o.onRetry(); await flush(); };
  return { log, view, clickMore, retryFirst };
}

const R = (from, to) => ({ from, to });
const eqRanges = (got, want) => JSON.stringify(got) === JSON.stringify(want);
const NOMORE = /没有更多了/;
const MAYBE = /可能还有更早的没读到/;

const CASES = [
  { name: "B1 第一页就是空的 → 说没有符合条件的申请；不出现截断提示、不出现「没有更多了」、没有载入入口",
    run: async () => {
      const m = await mount([{ data: [], error: null }]); const v = m.view(); const p = [];
      if (!/没有符合条件的申请/.test(v.text)) p.push("没说没有符合条件的申请");
      if (MAYBE.test(v.text) || NOMORE.test(v.text) || v.more) p.push("空的第一页出现了截断提示 / 没有更多了 / 载入入口");
      if (m.log.errors.length) p.push("不该报错");
      if (!eqRanges(m.log.ranges, [R(0, PAGE - 1)])) p.push("range 不对：" + JSON.stringify(m.log.ranges));
      return p;
    } },
  { name: "B2 第一页是短页 → 全部显示，不出现任何截断或「没有更多了」提示",
    run: async () => {
      const m = await mount([{ data: rows(0, 5), error: null }]); const v = m.view(); const p = [];
      if (v.rowIds.length !== 5) p.push("行数 " + v.rowIds.length);
      if (MAYBE.test(v.text) || NOMORE.test(v.text) || v.more) p.push("短的第一页出现了分页提示");
      return p;
    } },
  { name: "B3 第一页正好取满 → 明说只读到 N 份、可能还有更早的，并给可用的「载入更早」",
    run: async () => {
      const m = await mount([{ data: rows(0, PAGE), error: null }]); const v = m.view(); const p = [];
      if (v.rowIds.length !== PAGE) p.push("行数 " + v.rowIds.length);
      if (!MAYBE.test(v.text) || !v.text.includes(`目前只读到最新的 ${PAGE} 份`)) p.push("没有截断提示");
      if (!v.more || v.moreDisabled) p.push("没有可用的载入入口");
      if (!eqRanges(m.log.ranges, [R(0, PAGE - 1)])) p.push("range 不对：" + JSON.stringify(m.log.ranges));
      return p;
    } },
  { name: "B4 尾页是短页 → 合并显示，改说「没有更多了」，收起入口；第二页 range 为 [PAGE, 2PAGE-1]",
    run: async () => {
      const m = await mount([{ data: rows(0, PAGE), error: null }, { data: rows(PAGE, 120), error: null }]);
      await m.clickMore(); const v = m.view(); const p = [];
      if (v.rowIds.length !== PAGE + 120) p.push("行数 " + v.rowIds.length);
      if (!NOMORE.test(v.text) || !v.text.includes(`读到 ${PAGE + 120} 份`)) p.push("没有说没有更多了 / 份数不对");
      if (v.more || MAYBE.test(v.text)) p.push("尾页之后仍有载入入口或截断提示");
      if (!eqRanges(m.log.ranges, [R(0, PAGE - 1), R(PAGE, 2 * PAGE - 1)])) p.push("range 不对：" + JSON.stringify(m.log.ranges));
      return p;
    } },
  { name: "B5 总数恰为整页倍数：尾页取满仍给入口；再翻到空页 → 改说「没有更多了」、收起入口、行不重复",
    run: async () => {
      const m = await mount([{ data: rows(0, PAGE), error: null }, { data: rows(PAGE, PAGE), error: null }, { data: [], error: null }]);
      const p = [];
      await m.clickMore();
      let v = m.view();
      if (!v.more || !MAYBE.test(v.text)) p.push("第二页取满后应仍给载入入口");
      await m.clickMore();
      v = m.view();
      if (v.rowIds.length !== 2 * PAGE || new Set(v.rowIds).size !== 2 * PAGE) p.push("行数或去重不对：" + v.rowIds.length);
      if (!NOMORE.test(v.text) || !v.text.includes(`读到 ${2 * PAGE} 份`)) p.push("空的尾页之后没有说没有更多了");
      if (v.more || MAYBE.test(v.text)) p.push("空的尾页之后仍有载入入口或截断提示");
      if (/没有符合条件的申请/.test(v.text)) p.push("空的尾页被当成了「没有符合条件的申请」");
      if (!eqRanges(m.log.ranges, [R(0, PAGE - 1), R(PAGE, 2 * PAGE - 1), R(2 * PAGE, 3 * PAGE - 1)])) p.push("range 不对：" + JSON.stringify(m.log.ranges));
      return p;
    } },
  { name: "B6 第一页读失败 → 整块报错并给重试；重试要的仍是第 0 页",
    run: async () => {
      const m = await mount([{ data: null, error: { code: "network", message: "网络连接异常" } }, { data: rows(0, 3), error: null }]);
      const p = [];
      if (m.log.errors.length !== 1 || typeof m.log.errors[0].onRetry !== "function") p.push("没有报错或没有重试入口");
      else {
        await m.retryFirst();
        const v = m.view();
        if (v.rowIds.length !== 3) p.push("重试后没有显示读到的行");
      }
      if (!eqRanges(m.log.ranges, [R(0, PAGE - 1), R(0, PAGE - 1)])) p.push("range 不对：" + JSON.stringify(m.log.ranges));
      return p;
    } },
  { name: "B7 后续页读失败 → 已读的照常显示并明说不代表全部；入口仍在；重试要同一个区间，成功后到底",
    run: async () => {
      const m = await mount([{ data: rows(0, PAGE), error: null }, { data: null, error: { code: "server_error", message: "服务暂时不可用" } }, { data: rows(PAGE, 7), error: null }]);
      const p = [];
      await m.clickMore();
      let v = m.view();
      if (v.rowIds.length !== PAGE) p.push("失败后已读的行没有保留：" + v.rowIds.length);
      if (!/更早的那一页没能读到/.test(v.text) || !/不代表全部/.test(v.text)) p.push("没有说更早的那一页没读到、不代表全部");
      if (NOMORE.test(v.text)) p.push("读失败被说成了没有更多了");
      if (!v.more || v.moreDisabled) p.push("读失败后没有可用的重试入口");
      await m.clickMore();
      v = m.view();
      if (v.rowIds.length !== PAGE + 7 || !NOMORE.test(v.text) || /不代表全部/.test(v.text)) p.push("重试成功后状态不对");
      if (!eqRanges(m.log.ranges, [R(0, PAGE - 1), R(PAGE, 2 * PAGE - 1), R(PAGE, 2 * PAGE - 1)])) p.push("重试的 range 不是同一个区间：" + JSON.stringify(m.log.ranges));
      return p;
    } },
  { name: "B8 后续页返回非数组（无结论）→ 同读失败处理，不当成空页说到底了",
    run: async () => {
      const m = await mount([{ data: rows(0, PAGE), error: null }, { data: {}, error: null }]);
      await m.clickMore(); const v = m.view(); const p = [];
      if (NOMORE.test(v.text)) p.push("无结论被说成了没有更多了");
      if (!/不代表全部/.test(v.text) || !v.more) p.push("没有说不代表全部或没有重试入口");
      return p;
    } },
  { name: "B9 翻页期间有人提交，下一页与已读重叠 → 按 id 去重，份数按去重后算",
    run: async () => {
      const m = await mount([{ data: rows(0, PAGE), error: null }, { data: rows(PAGE - 2, 10), error: null }]);
      await m.clickMore(); const v = m.view(); const p = [];
      if (v.rowIds.length !== PAGE + 8 || new Set(v.rowIds).size !== v.rowIds.length) p.push("去重不对：" + v.rowIds.length);
      if (!v.text.includes(`读到 ${PAGE + 8} 份`)) p.push("份数没有按去重后计算");
      return p;
    } },
];

let bad = 0;
for (const c of CASES) {
  let p;
  try { p = await c.run(); } catch (e) { p = ["抛出异常：" + (e && e.message)]; }
  if (p.length) { bad++; console.log("  FAIL  " + c.name + "\n        " + p.join("；")); }
  else console.log("  ok    " + c.name);
}
console.log("\n──────────────────────────────");
console.log(`  ${REL}（PAGE=${PAGE}）｜ 情形 ${CASES.length} 个 ｜ 不符合预期 ${bad} 个`);
console.log("  node:vm + 桩运行页面内联脚本：未开浏览器、未联网、未写文件。");
process.exit(bad ? 1 : 0);
