#!/usr/bin/env node
/* 缓存戳变更范围审核：一段提交里，被 pre-commit 顺手打戳的文件，是不是**只**动了缓存戳。

   为什么要有这一条：.githooks/pre-commit 每次提交都会让 bump.py 给全站 HTML 的
   本地 assets 引用重打 ?v=<12 位数字>，并自动暂存这些文件。于是每个提交都带着二十几个
   HTML 的改动。任务本身只改了其中一两个页面的内容 —— 其余的**应当**只有戳变了。
   肉眼翻 diff 看不出来哪一个混进了别的改动；check-cache-bust.py 只校验 HEAD 上戳的格式与唯一性，
   不回答「这次改了什么」。

   判据：把新旧两版里的 `?v=<12 位数字>"` 都换成同一个占位符后逐字比较。
     相同 → 只改了缓存戳；不同 → 有内容改动（含畸形戳，如 ?v=abc，不算合法戳）。
   新增、删除、改名的文件一律算内容改动。
   有内容改动的文件必须在 --expect 名单里，否则失败。

   --per-commit：逐个提交各判一次。只看整段区间时，某个提交里加进去、后一个提交又删掉的
   改动会互相抵消，看起来像「只改了戳」；逐个提交判就藏不住。

   只读 git 对象；不写文件、不联网。

   用法：
     node scripts/check-stamp-only-diff.mjs <base> <head> [--per-commit] [--expect <path> ...]
   退出码：0 = 所有内容改动都在预期名单内；1 = 有预期外的内容改动；2 = 区间里没有任何改动（空转不算通过）。 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a === "--per-commit"));
const ei = argv.indexOf("--expect");
const expect = new Set(ei > -1 ? argv.slice(ei + 1).filter((a) => !a.startsWith("--")) : []);
const [base, head] = argv.filter((a, i) => !a.startsWith("--") && (ei < 0 || i < ei));
if (!base || !head) {
  console.error("用法: node scripts/check-stamp-only-diff.mjs <base> <head> [--per-commit] [--expect <path> ...]");
  process.exit(2);
}

const CWD = process.env.CSC_STAMP_DIFF_CWD || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: CWD, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const STAMP = /\?v=\d{12}(?=")/g;
const norm = (s) => s.replace(/\r\n/g, "\n").replace(STAMP, "?v=<STAMP>");

function classify(from, to) {
  const out = git("diff", "--no-renames", "--name-status", "-z", from, to).split("\0").filter(Boolean);
  const stampOnly = [], content = [];
  for (let i = 0; i < out.length; i += 2) {
    const status = out[i], file = out[i + 1];
    if (status !== "M") { content.push(`${file}（${status}）`); continue; }
    const a = git("show", `${from}:${file}`), b = git("show", `${to}:${file}`);
    (norm(a) === norm(b) && a !== b ? stampOnly : content).push(file);
  }
  return { stampOnly, content };
}

const bare = (f) => f.replace(/（.）$/, "");
let unexpected = 0, total = 0;
const report = (label, { stampOnly, content }) => {
  total += stampOnly.length + content.length;
  const bad = content.filter((f) => !expect.has(bare(f)));
  unexpected += bad.length;
  console.log(`\n${label}`);
  console.log(`  只改缓存戳 ${stampOnly.length} 个` + (stampOnly.length ? "（" + stampOnly.filter((f) => f.endsWith(".html")).length + " 个 .html）" : ""));
  console.log(`  有内容改动 ${content.length} 个：` + (content.length ? "" : "（无）"));
  for (const f of content) console.log(`    ${expect.has(bare(f)) ? "预期  " : "预期外"}  ${f}`);
};

if (flags.has("--per-commit")) {
  const commits = git("rev-list", "--reverse", `${base}..${head}`).split("\n").filter(Boolean);
  for (const c of commits) {
    /* 每个提交只看它自己引入的改动；非 HTML 文件（脚本、文档、状态文件）不带缓存戳，
       是任务本身的改动，按提交单独列出但不计入「预期外」—— 它们本来就不是打戳带进来的。 */
    const r = classify(`${c}^`, c);
    const html = { stampOnly: r.stampOnly, content: r.content.filter((f) => bare(f).endsWith(".html")) };
    const other = r.content.filter((f) => !bare(f).endsWith(".html"));
    report(git("log", "-1", "--format=%h %s", c).trim(), html);
    if (other.length) console.log(`  非 HTML（任务本身的文件，不计入判定）：${other.join("、")}`);
  }
} else {
  const r = classify(base, head);
  report(`${base}..${head}（整段区间）`, r);
}

console.log("\n──────────────────────────────");
if (!total) {
  console.log("  区间里没有任何改动 —— 空转不算通过。");
  process.exit(2);
}
console.log(`  预期内容改动名单：${expect.size ? [...expect].join("、") : "（空）"}`);
console.log(unexpected ? `  预期外的内容改动 ${unexpected} 处` : "  所有内容改动都在预期名单内，其余文件只改了缓存戳");
process.exit(unexpected ? 1 : 0);
