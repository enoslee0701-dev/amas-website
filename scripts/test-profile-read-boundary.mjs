#!/usr/bin/env node
/* 学员 / 教师资料页：主读取「网络失败」与「空响应」两种状态的边界检查。
   （申请人资料页由 test-applicant-profile-read-boundary.mjs 负责，这里不重复。）

   两页的主读取：
     portal/student/profile/  Api.rpc("my_student_profile")  -> jsonb { self_editable, registrar_managed, has_student_record }
                              （0017_student_experience.sql:67，找不到 profiles 行时服务端 raise）
     portal/teacher/profile/  Api.rpc("my_profile")          -> profiles 一整行（0003_hardening.sql:57）
   要求：
     网络失败（error.code = network）→ UI.error，提示是归一后的 message，有重试入口，不渲染表单
     空响应（null / undefined / {} / 缺关键字段）→ 同样走「没读到」+ 重试，不渲染空表单，不抛异常
     正常数据 → 渲染表单
   教师页另有次要读取 teacher_profiles（maybeSingle）：失败要说「暂时读不到」，null 是「还没有档案」—— 两者分开。

   做法：不开浏览器。从 HTML 取出页面内联脚本放进 node:vm，用桩替换 AmasShell / AmasApi / AmasUI / document。
   只读页面源码，不联网、不写文件。

   运行：node scripts/test-profile-read-boundary.mjs
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
  if (hits.length !== 1) {
    console.error(`  ${rel} 里含 ${marker} 的内联脚本应恰有 1 段，实际 ${hits.length} 段 —— 空转不算通过。`);
    process.exit(2);
  }
  return hits[0][2];
}
const STUDENT = { rel: "portal/student/profile/index.html", code: pageScript("portal/student/profile/index.html", 'Api.rpc("my_student_profile")'), main: "my_student_profile" };
const TEACHER = { rel: "portal/teacher/profile/index.html", code: pageScript("portal/teacher/profile/index.html", 'Api.rpc("my_profile")'), main: "my_profile" };

function mkEl() {
  const listeners = {};
  return {
    value: "", disabled: false, textContent: "", innerHTML: "", hidden: false, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, focus() {},
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    listeners,
  };
}

async function run(page, { main: mainResult, catalog = { data: [], error: null }, teacherProfile = { data: null, error: null } }) {
  const calls = { error: [], reload: 0 };
  const main = mkEl();
  const byId = {};
  const ctx = {
    console: { log() {}, error() {}, debug() {} }, Date, Object, Array, JSON, Map,
    window: {},
    location: { reload: () => { calls.reload++; }, href: "" },
    history: { back() {} },
    document: { getElementById: (id) => (byId[id] ||= mkEl()), createElement: () => mkEl(), querySelector: () => null },
  };
  ctx.window.AmasAuth = { ROOT: "/" };
  ctx.window.AmasShell = { mount: async () => ({ main, profile: { display_name: "x" }, ctx: { session: { user: { id: "u-1" } } } }) };
  ctx.window.AmasApi = {
    rpc: async (name) => (name === page.main ? mainResult : { data: { ok: true }, error: null }),
    select: async (table) => (table === "teacher_profiles" ? teacherProfile : catalog),
    msg: (code) => "msg:" + code,
  };
  ctx.window.AmasUI = {
    loading() {}, formGuard() {}, toast() {},
    error: (node, opts) => { calls.error.push(opts); },
    esc: (s) => String(s),
  };
  vm.createContext(ctx);
  let thrown = null;
  try { await vm.runInContext(page.code, ctx, { filename: page.rel }); } catch (e) { thrown = e; }
  return { calls, main, thrown };
}

const NET = { data: null, error: { code: "network", message: "网络连接异常，请检查网络后重试。" } };

const unreadable = (wantMsg) => (r) => {
  const p = [];
  if (r.thrown) p.push("页面脚本抛出异常（会卡在骨架屏）：" + r.thrown.message);
  if (r.calls.error.length !== 1) p.push(`UI.error 调用 ${r.calls.error.length} 次，预期 1`);
  const o = r.calls.error[0] || {};
  if (!o.message || (wantMsg && !wantMsg.test(o.message))) p.push(`提示不对：${o.message}`);
  if (typeof o.onRetry !== "function") p.push("没有重试入口");
  else { o.onRetry(); if (r.calls.reload !== 1) p.push("重试没有 reload"); }
  if (/id="save"/.test(r.main.innerHTML)) p.push("仍然渲染了可保存的表单");
  return p;
};
const rendered = (must = []) => (r) => {
  const p = [];
  if (r.thrown) p.push("页面脚本抛出异常：" + r.thrown.message);
  if (r.calls.error.length) p.push("不该调用 UI.error");
  if (!/id="save"/.test(r.main.innerHTML)) p.push("没有渲染表单");
  for (const s of must) if (!r.main.innerHTML.includes(s)) p.push(`页面里没有「${s}」`);
  return p;
};

const STU_OK = {
  self_editable: { display_name: "李学员", phone: "0866", contact_note: "" },
  registrar_managed: { email: "s@example.invalid", student_number: "S-1", status: "active", program_code: "bth", pathway: "bth", created_at: "2026-01-02T00:00:00Z" },
  has_student_record: true,
};
const TEA_OK = { id: "u-1", display_name: "王老师", email: "t@example.invalid", phone: "0877", contact_note: "", timezone: "Asia/Bangkok" };
const EMPTY_MSG = /没有读到你的/;

const CASES = [
  /* ── 学员资料页 ── */
  { page: STUDENT, name: "学员：网络失败 → 报错 + 重试，不渲染表单", setup: { main: NET }, check: unreadable(/网络连接异常/) },
  { page: STUDENT, name: "学员：空响应 null → 没读到 + 重试，不抛异常、不画空表单", setup: { main: { data: null, error: null } }, check: unreadable(EMPTY_MSG) },
  { page: STUDENT, name: "学员：空响应 undefined → 同上", setup: { main: { data: undefined, error: null } }, check: unreadable(EMPTY_MSG) },
  { page: STUDENT, name: "学员：空响应 {} → 同上（不能写成「尚无学籍记录」）", setup: { main: { data: {}, error: null } }, check: unreadable(EMPTY_MSG) },
  { page: STUDENT, name: "学员：缺 registrar_managed → 同上", setup: { main: { data: { self_editable: {} }, error: null } }, check: unreadable(EMPTY_MSG) },
  { page: STUDENT, name: "学员：正常数据 → 渲染表单与学号", setup: { main: { data: STU_OK, error: null } }, check: rendered(["S-1", "李学员"]) },
  { page: STUDENT, name: "学员：确实没有学籍记录（契约形状完整）→ 照常渲染并说尚无学籍记录", setup: { main: { data: { self_editable: { display_name: "新人" }, registrar_managed: { email: "n@example.invalid" }, has_student_record: false }, error: null } }, check: rendered(["尚无学籍记录"]) },
  { page: STUDENT, name: "学员：项目目录网络失败 → 主资料照常渲染，不抛异常", setup: { main: { data: STU_OK, error: null }, catalog: NET }, check: rendered(["S-1"]) },

  /* ── 教师资料页 ── */
  { page: TEACHER, name: "教师：网络失败 → 报错 + 重试，不渲染表单", setup: { main: NET }, check: unreadable(/网络连接异常/) },
  { page: TEACHER, name: "教师：空响应 null → 没读到 + 重试", setup: { main: { data: null, error: null } }, check: unreadable(EMPTY_MSG) },
  { page: TEACHER, name: "教师：空响应 {} → 同上，不画空表单", setup: { main: { data: {}, error: null } }, check: unreadable(EMPTY_MSG) },
  { page: TEACHER, name: "教师：全字段为 null 的行 → 同上", setup: { main: { data: Object.fromEntries(Object.keys(TEA_OK).map((k) => [k, null])), error: null } }, check: unreadable(EMPTY_MSG) },
  { page: TEACHER, name: "教师：正常数据 → 渲染表单", setup: { main: { data: TEA_OK, error: null } }, check: rendered(["王老师", "还没有教职档案记录"]) },
  { page: TEACHER, name: "教师：教职档案网络失败 → 说暂时读不到，不说还没有档案", setup: { main: { data: TEA_OK, error: null }, teacherProfile: NET },
    check: (r) => [...rendered(["暂时读不到教职档案"])(r), ...(r.main.innerHTML.includes("还没有教职档案记录") ? ["读失败却说成还没有档案"] : [])] },
];

let bad = 0;
for (const c of CASES) {
  const p = c.check(await run(c.page, c.setup));
  if (p.length) { bad++; console.log("  FAIL  " + c.name + "\n        " + p.join("；")); }
  else console.log("  ok    " + c.name);
}
console.log("\n──────────────────────────────");
console.log("  学员 / 教师资料页 ｜ 情形 " + CASES.length + " 个 ｜ 不符合预期 " + bad + " 个");
console.log("  node:vm + 桩运行页面内联脚本：未开浏览器、未联网、未写文件。");
process.exit(bad ? 1 : 0);
