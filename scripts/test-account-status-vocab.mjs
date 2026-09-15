#!/usr/bin/env node
/* check-account-status-vocab.mjs 的正向 / 负向用例 —— 在一次性临时目录里验证，不碰真实仓库。

   一条永远为真的判据不是判据：每一种「对不上」都构造一个应当失败的场景，证明它真会失败；
   再构造合法场景（含后续迁移加值、改名后页面同步）证明它真会通过。
   最后对真实仓库跑一次。

   不开浏览器、不联网；只写系统临时目录，结束即删。

   运行：node scripts/test-account-status-vocab.mjs
   退出码：0 全部用例符合预期；1 有用例不符合预期。 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = path.join(ROOT, "scripts", "check-account-status-vocab.mjs");

const FIVE = ["pending_email", "active", "locked", "suspended", "disabled"];
const enumSql = (vals) => `create type account_status as enum (${vals.map((v) => `'${v}'`).join(",")});\n`;
const page = (accKeys, keyList) =>
  `<script>\n  const ACC = {\n${accKeys.map((k) => `    ${k}: "文案-${k}",`).join("\n")}\n  };\n` +
  `  const ACC_KEYS = [${keyList.map((k) => `"${k}"`).join(", ")}];\n</script>\n`;

const CASES = [
  { name: "三者一致 → 通过", mig: { "0002_identity.sql": enumSql(FIVE) }, page: page(FIVE, FIVE), expect: 0 },
  {
    name: "契约多一个值、页面两处都没有 → 失败",
    mig: { "0002_identity.sql": enumSql([...FIVE, "archived"]) }, page: page(FIVE, FIVE), expect: 1, out: /契约有、ACC_KEYS 没有: archived/,
  },
  {
    name: "ACC_KEYS 放行了、ACC 却没有文案 → 失败（会漏出英文原文）",
    mig: { "0002_identity.sql": enumSql(FIVE) }, page: page(FIVE.filter((k) => k !== "locked"), FIVE), expect: 1, out: /契约有、ACC 没有文案: locked/,
  },
  {
    name: "页面有契约里不存在的状态（closed）→ 失败",
    mig: { "0002_identity.sql": enumSql(FIVE) }, page: page([...FIVE, "closed"], [...FIVE, "closed"]), expect: 1, out: /ACC_KEYS 有、契约没有: closed/,
  },
  {
    name: "后续迁移 alter type ... add value，页面没跟上 → 失败（旧 Ap6 只读 0002 看不见这一类）",
    mig: { "0002_identity.sql": enumSql(FIVE), "0030_more.sql": "alter type public.account_status add value if not exists 'archived' after 'disabled';\n" },
    page: page(FIVE, FIVE), expect: 1, out: /archived/,
  },
  {
    name: "后续迁移加值、页面同步加上 → 通过",
    mig: { "0002_identity.sql": enumSql(FIVE), "0030_more.sql": "alter type account_status add value 'archived';\n" },
    page: page([...FIVE, "archived"], [...FIVE, "archived"]), expect: 0,
  },
  {
    name: "后续迁移 rename value，页面同步改名 → 通过",
    mig: { "0002_identity.sql": enumSql(FIVE), "0031_rename.sql": "alter type account_status rename value 'locked' to 'frozen';\n" },
    page: page(FIVE.map((k) => (k === "locked" ? "frozen" : k)), FIVE.map((k) => (k === "locked" ? "frozen" : k))), expect: 0,
  },
  {
    name: "注释里写的 add value 不算数 → 通过",
    mig: { "0002_identity.sql": enumSql(FIVE) + "-- alter type account_status add value 'archived';\n/* alter type account_status add value 'x'; */\n" },
    page: page(FIVE, FIVE), expect: 0,
  },
  {
    name: "ACC_KEYS 有重复 → 失败",
    mig: { "0002_identity.sql": enumSql(FIVE) }, page: page(FIVE, [...FIVE, "active"]), expect: 1, out: /重复: active/,
  },
  { name: "找不到枚举定义 → 退出码 2（空转不算通过）", mig: { "0002_identity.sql": "select 1;\n" }, page: page(FIVE, FIVE), expect: 2 },
  { name: "页面里找不到 ACC_KEYS → 退出码 2", mig: { "0002_identity.sql": enumSql(FIVE) }, page: "<script>const ACC = { active: 'x' };</script>", expect: 2 },
];

function run(args) {
  const r = spawnSync(process.execPath, [CHECKER, ...args], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

let bad = 0;
const report = (name, problems, out) => {
  if (problems.length) {
    bad++;
    console.log("  FAIL  " + name + "\n        " + problems.join("；"));
    console.log(out.split("\n").filter(Boolean).map((l) => "        | " + l).join("\n"));
  } else console.log("  ok    " + name);
};

for (const c of CASES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csc-acc-vocab-"));
  try {
    fs.mkdirSync(path.join(dir, "supabase/migrations"), { recursive: true });
    for (const [f, s] of Object.entries(c.mig)) fs.writeFileSync(path.join(dir, "supabase/migrations", f), s);
    fs.mkdirSync(path.join(dir, "portal/applicant/profile"), { recursive: true });
    fs.writeFileSync(path.join(dir, "portal/applicant/profile/index.html"), c.page);
    const { status, out } = run(["--root", dir]);
    const p = [];
    if (status !== c.expect) p.push(`退出码 ${status}，预期 ${c.expect}`);
    if (c.out && !c.out.test(out)) p.push(`输出里没有 ${c.out}`);
    report(c.name, p, out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* 负向对照用**真实文件格式**：复制真实页面与真实迁移，只从 ACC_KEYS 里删掉 locked。
   证明解析对得上真页面的写法，而不只是对得上上面手搓的 fixture。 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csc-acc-vocab-real-"));
  try {
    fs.cpSync(path.join(ROOT, "supabase/migrations"), path.join(dir, "supabase/migrations"), { recursive: true });
    const real = fs.readFileSync(path.join(ROOT, "portal/applicant/profile/index.html"), "utf8");
    const mutated = real.replace(/(const\s+ACC_KEYS\s*=\s*\[[^\]]*?)"locked",\s*/, "$1");
    fs.mkdirSync(path.join(dir, "portal/applicant/profile"), { recursive: true });
    fs.writeFileSync(path.join(dir, "portal/applicant/profile/index.html"), mutated);
    const { status, out } = run(["--root", dir]);
    const p = [];
    if (mutated === real) p.push("没能在真实页面的 ACC_KEYS 里删掉 locked（负向对照没构造出来）");
    if (status !== 1) p.push(`退出码 ${status}，预期 1`);
    if (!/契约有、ACC_KEYS 没有: locked/.test(out)) p.push("输出里没有指出 locked");
    report("真实页面格式的负向对照：ACC_KEYS 删掉 locked → 失败", p, out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { status, out } = run([]);
  report("真实仓库：页面 ACC / ACC_KEYS 与迁移重放后的 account_status 完全一致",
    status === 0 ? [] : [`退出码 ${status}，预期 0`], out);
}

console.log("\n──────────────────────────────");
console.log("  用例 " + (CASES.length + 2) + " 个 ｜ 不符合预期 " + bad + " 个");
process.exit(bad ? 1 : 0);
