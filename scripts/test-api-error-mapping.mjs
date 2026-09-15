#!/usr/bin/env node
/* 门户数据访问层（assets/js/portal/api.js）错误归一化的边界检查：
   未知、权限、限流三类错误，都要落到**明确的用户提示**上。

   「明确」的判据：
     · message 是非空字符串，且就是 MESSAGES 里对应那一句（未知 → unknown 那句）；
     · 权限 / 限流不能被压成笼统的「操作未能完成，请稍后再试。」；
     · 不把服务端原文（permission denied / row-level security …）带给用户。

   三个入口都量：
     normalize(error, status)  表查询 / RPC 走这里
     msg(code)                 页面与 fn() 都用它查文案
     fn(name, body)            Edge Function 走这里，按 callFn 返回的 {status, data} 推导

   做法：不开浏览器。把真实的 api.js 放进 node:vm，AmasAuth 用桩（callFn 返回指定的 {status, data}）。
   只读源码，不联网、不写文件。

   运行：node scripts/test-api-error-mapping.mjs
   退出码：0 全部用例符合预期；1 有用例不符合预期。 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "assets/js/portal/api.js"), "utf8");

function load({ callFn, rpc } = {}) {
  const ctx = {
    console: { error() {}, debug() {}, log() {} },
    location: { hostname: "portal.example.invalid" },
    window: {},
  };
  ctx.window.AmasAuth = {
    CONFIGURED: true,
    client: { rpc: rpc || (async () => ({ data: null, error: null, status: 200 })) },
    callFn: callFn || (async () => ({ status: 200, data: {} })),
    getAal: async () => ({ current: "aal2" }),
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "assets/js/portal/api.js" });
  return ctx.window.AmasApi;
}

const base = load();
const M = base.MESSAGES;
const GENERIC = M.unknown;

/* 统一判据：code 对、message 恰为该 code 的文案、是字符串、不带原文 */
function expectMapped(r, code, rawBits = []) {
  const p = [];
  if (!r) return ["返回了空（预期是错误对象）"];
  if (r.code !== code) p.push(`code=${JSON.stringify(r.code)}，预期 ${code}`);
  if (typeof r.message !== "string" || !r.message) p.push(`message 不是非空字符串：${typeof r.message}`);
  else if (r.message !== M[code]) p.push(`message=「${String(r.message).slice(0, 60)}」，预期「${M[code]}」`);
  for (const bit of rawBits) if (typeof r.message === "string" && r.message.includes(bit)) p.push(`把服务端原文「${bit}」带给了用户`);
  return p;
}

const CASES = [
  /* ── normalize ─────────────────────────────── */
  { name: "normalize：认不出的错误 → unknown 那一句（明确，不是空）", run: async () =>
      expectMapped(base.normalize({ message: "something odd happened" }, 400), "unknown", ["something odd"]) },
  { name: "normalize：HTTP 403 → 权限提示", run: async () =>
      expectMapped(base.normalize({ message: "denied" }, 403), "forbidden") },
  { name: "normalize：无状态码但原文是 permission denied → 权限提示，不带原文", run: async () =>
      expectMapped(base.normalize({ message: "permission denied for function review_application" }), "forbidden", ["permission denied", "review_application"]) },
  { name: "normalize：RLS 拒绝 → 权限提示，不带原文", run: async () =>
      expectMapped(base.normalize({ message: 'new row violates row-level security policy for table "applications"' }, 400), "forbidden", ["row-level security", "applications"]) },
  { name: "normalize：HTTP 429 → 限流提示", run: async () =>
      expectMapped(base.normalize({ message: "Too Many Requests" }, 429), "rate_limited") },
  { name: "normalize：429 的原文里恰好有 required，也仍是限流（状态码优先）", run: async () =>
      expectMapped(base.normalize({ message: "rate limit: retry-after required" }, 429), "rate_limited") },
  { name: "normalize：403 的原文里恰好有 missing，也仍是权限（状态码优先）", run: async () =>
      expectMapped(base.normalize({ message: "missing grant" }, 403), "forbidden") },
  { name: "normalize：没有错误 → null", run: async () =>
      base.normalize(null, 200) === null ? [] : ["没有错误时应返回 null"] },

  /* ── msg ───────────────────────────────────── */
  { name: "msg：forbidden / rate_limited / unknown 各是自己那一句", run: async () => {
      const p = [];
      for (const c of ["forbidden", "rate_limited", "unknown"]) if (base.msg(c) !== M[c]) p.push(`msg(${c}) 不对`);
      if (base.msg("forbidden") === GENERIC || base.msg("rate_limited") === GENERIC) p.push("权限/限流被压成了笼统文案");
      return p;
    } },
  { name: "msg：没登记的错误码 → unknown 那一句", run: async () =>
      base.msg("no_such_code") === GENERIC ? [] : [`msg(no_such_code)=${String(base.msg("no_such_code"))}`] },
  { name: "msg：对象原型上的名字（constructor / toString / __proto__ / hasOwnProperty）→ 仍是 unknown 那一句，不是函数源码", run: async () => {
      const p = [];
      for (const c of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
        const v = base.msg(c);
        if (v !== GENERIC) p.push(`msg(${c}) 返回 ${typeof v}：${String(v).slice(0, 40)}`);
      }
      return p;
    } },

  /* ── fn（Edge Function）────────────────────── */
  { name: "fn：403 且 body 带 forbidden → 权限提示", run: async () =>
      expectMapped((await load({ callFn: async () => ({ status: 403, data: { error: "forbidden" } }) }).fn("x", {})).error, "forbidden") },
  { name: "fn：429 且 body 带 rate_limited → 限流提示", run: async () =>
      expectMapped((await load({ callFn: async () => ({ status: 429, data: { error: "rate_limited" } }) }).fn("x", {})).error, "rate_limited") },
  { name: "fn：403 但 body 不是 JSON（网关页 / 空）→ 仍是权限提示，不压成笼统文案", run: async () =>
      expectMapped((await load({ callFn: async () => ({ status: 403, data: null }) }).fn("x", {})).error, "forbidden") },
  { name: "fn：429 但 body 不是 JSON（网关限流）→ 仍是限流提示，不压成笼统文案", run: async () =>
      expectMapped((await load({ callFn: async () => ({ status: 429, data: null }) }).fn("x", {})).error, "rate_limited") },
  { name: "fn：429 且 body 是网关自己的形状（没有 error 字段）→ 限流提示", run: async () =>
      expectMapped((await load({ callFn: async () => ({ status: 429, data: { message: "Too many requests", code: 429 } }) }).fn("x", {})).error, "rate_limited", ["Too many requests"]) },
  { name: "fn：认不出的状态（418）且无 body → unknown 那一句", run: async () =>
      expectMapped((await load({ callFn: async () => ({ status: 418, data: null }) }).fn("x", {})).error, "unknown") },
  { name: "fn：body 的 error 是原型上的名字（constructor）→ message 仍是字符串文案，不是函数源码", run: async () => {
      const e = (await load({ callFn: async () => ({ status: 403, data: { error: "constructor" } }) }).fn("x", {})).error;
      return typeof e.message === "string" && !/native code|function/.test(e.message) ? [] : [`message=${typeof e.message}：${String(e.message).slice(0, 50)}`];
    } },

  /* ── rpc（端到端经过 normalize）─────────────── */
  { name: "rpc：返回 429 → 限流提示", run: async () =>
      expectMapped((await load({ rpc: async () => ({ data: null, error: { message: "Too Many Requests" }, status: 429 }) }).rpc("x")).error, "rate_limited") },
  { name: "rpc：返回 403 permission denied → 权限提示，不带原文", run: async () =>
      expectMapped((await load({ rpc: async () => ({ data: null, error: { message: "permission denied for function my_x" }, status: 403 }) }).rpc("x")).error, "forbidden", ["permission denied", "my_x"]) },
];

let bad = 0;
for (const c of CASES) {
  let p;
  try { p = await c.run(); } catch (e) { p = ["抛出异常：" + (e && e.message)]; }
  if (p.length) { bad++; console.log("  FAIL  " + c.name + "\n        " + p.join("；")); }
  else console.log("  ok    " + c.name);
}
console.log("\n──────────────────────────────");
console.log("  assets/js/portal/api.js ｜ 用例 " + CASES.length + " 个 ｜ 不符合预期 " + bad + " 个");
console.log("  node:vm 加载真实 api.js，AmasAuth 用桩：未开浏览器、未联网、未写文件。");
process.exit(bad ? 1 : 0);
