#!/usr/bin/env node
/* 申请人资料页（portal/applicant/profile/）读取边界：读失败、空结果、重试入口。

   页面只有一次读取：Api.rpc("my_profile")。契约是返回 public.profiles **一整行**
   （0003_hardening.sql:57，`returns public.profiles`，不是 setof）。
   原来的守卫只有 `if (error)` 与 `if (!prof)`：
     · null / undefined → 报「没有读到你的档案」+ 重试         ✓
     · {} 或全字段为 null 的对象 → `!prof` 为假，照常渲染        ✗
       页面会画出一张空表单、账号信息全是「—」，等于把「读不到」说成「你的资料是空的」，
       还让人在这张空表单上点「保存」。
   为什么全 null 对象是现实的：handle_new_user 触发器吞掉异常（0003_hardening.sql:64 起），
   profiles 行可能根本没建；这时 SQL 函数返回 NULL 复合值，经 PostgREST 序列化可能是
   各字段为 null 的对象而非 null。本条未连库实测，按契约做防御性边界。

   做法：不开浏览器。从 HTML 里取出页面自己的内联脚本，放进 node:vm，
   用桩替换 AmasShell / AmasApi / AmasUI / document / location，逐个情形看它调了什么。
   只读页面源码，不联网、不写任何文件。

   运行：node scripts/test-applicant-profile-read-boundary.mjs
   退出码：0 全部情形符合预期；1 有情形不符合预期；2 页面脚本没取到（空转不算通过）。 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "portal/applicant/profile/index.html";

const html = fs.readFileSync(path.join(ROOT, PAGE), "utf8");
const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/(?:^|\s)src\s*=/i.test(m[1]) && m[2].includes('Api.rpc("my_profile")'));
if (inline.length !== 1) {
  console.error(`  ${PAGE} 里含 my_profile 读取的内联脚本应恰有 1 段，实际 ${inline.length} 段 —— 空转不算通过。`);
  process.exit(2);
}
const CODE = inline[0][2];

function el() {
  const listeners = {};
  return {
    value: "", disabled: false, textContent: "", innerHTML: "",
    classList: { add() {}, remove() {} },
    setAttribute() {}, removeAttribute() {},
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    listeners,
  };
}

async function run(rpcResult) {
  const calls = { error: [], reload: 0, rpc: [] };
  const main = el();
  const byId = {};
  const context = {
    console,
    Date,
    window: {},
    document: { getElementById: (id) => (byId[id] ||= el()) },
    location: { reload: () => { calls.reload++; } },
    history: { back() {} },
  };
  context.window.AmasAuth = {};
  context.window.AmasShell = { mount: async () => ({ main }) };
  context.window.AmasApi = {
    rpc: async (name, args) => { calls.rpc.push(name); return name === "my_profile" ? rpcResult : { data: { ok: true }, error: null }; },
    msg: (code) => "msg:" + code,
  };
  context.window.AmasUI = {
    loading() {},
    error: (node, opts) => { calls.error.push({ node, opts }); },
    esc: (s) => String(s),
    formGuard() {},
  };
  vm.createContext(context);
  /* 页面脚本最后一条语句是 async IIFE 的调用，runInContext 的返回值就是它的 promise。 */
  const done = vm.runInContext(CODE, context, { filename: PAGE });
  await done;
  return { calls, main };
}

const FULL = {
  id: "00000000-0000-0000-0000-000000000001", email: "a@example.org", display_name: "张三",
  phone: "123", contact_note: "", account_status: "active", timezone: "Asia/Bangkok",
  created_at: "2026-09-01T00:00:00Z",
};
const ALL_NULL = Object.fromEntries(Object.keys(FULL).map((k) => [k, null]));

/* 「读不到」类情形的共同要求：走 UI.error、给出可调用的重试入口且重试会刷新页面、
   不渲染表单（main 里不能出现保存按钮）。 */
function expectUnreadable(label, wantMessage) {
  return ({ calls, main }) => {
    const p = [];
    if (calls.error.length !== 1) p.push(`UI.error 调用 ${calls.error.length} 次，预期 1 次`);
    const opts = calls.error[0]?.opts || {};
    if (typeof opts.onRetry !== "function") p.push("没有重试入口 onRetry");
    else {
      opts.onRetry();
      if (calls.reload !== 1) p.push(`重试后 location.reload 调用 ${calls.reload} 次，预期 1 次`);
    }
    if (!opts.message) p.push("错误提示为空");
    else if (wantMessage && !wantMessage.test(opts.message)) p.push(`提示「${opts.message}」不符合 ${wantMessage}`);
    if (/id="save"/.test(main.innerHTML)) p.push(`${label}时仍然渲染了可保存的表单`);
    return p;
  };
}

const EMPTY_MSG = /没有读到你的档案/;
const CASES = [
  {
    name: "读失败（rpc 返回 error）→ 报错 + 重试，提示用服务端归一后的 message",
    result: { data: null, error: { code: "network", message: "网络连接异常，请检查后重试。" } },
    check: expectUnreadable("读失败", /网络连接异常/),
  },
  {
    name: "读失败但 data 也带了东西 → 仍以 error 为准，不渲染",
    result: { data: FULL, error: { code: "server_error", message: "服务暂时不可用。" } },
    check: expectUnreadable("读失败", /服务暂时不可用/),
  },
  { name: "空结果 data = null → 「没有读到你的档案」+ 重试", result: { data: null, error: null }, check: expectUnreadable("空结果", EMPTY_MSG) },
  { name: "空结果 data = undefined → 同上", result: { data: undefined, error: null }, check: expectUnreadable("空结果", EMPTY_MSG) },
  { name: "空对象 data = {} → 同上，不能画出空表单", result: { data: {}, error: null }, check: expectUnreadable("空对象", EMPTY_MSG) },
  { name: "全字段为 null 的行（NULL 复合值）→ 同上，不能画出空表单", result: { data: ALL_NULL, error: null }, check: expectUnreadable("全 null 行", EMPTY_MSG) },
  {
    name: "正常读到整行 → 渲染表单，不报错",
    result: { data: FULL, error: null },
    check: ({ calls, main }) => {
      const p = [];
      if (calls.error.length) p.push(`不该调用 UI.error，实际 ${calls.error.length} 次`);
      if (!/id="save"/.test(main.innerHTML)) p.push("没有渲染保存按钮");
      if (!main.innerHTML.includes("a@example.org")) p.push("没有显示登录邮箱");
      if (!main.innerHTML.includes("正常")) p.push("账号状态没有显示为「正常」");
      return p;
    },
  },
];

let bad = 0;
for (const c of CASES) {
  let problems;
  try {
    problems = c.check(await run(c.result));
  } catch (e) {
    problems = ["页面脚本抛出异常：" + (e && e.message)];
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
