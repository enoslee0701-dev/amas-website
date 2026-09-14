#!/usr/bin/env node
/* HTML 内联 <script> 语法门槛（scripts/verify.sh 第 2 步）。

   原来这一步写在 verify.sh 里：把每段没有 src 的 <script> 一律塞进 new Function。
   两个问题：
   1. <script type="application/ld+json"> 是 JSON 数据，不是 JS。合法 JSON 对象在语句位置
      不是合法 JS，所以 index.html 的两段结构化数据**必然**误报，verify.sh 在本仓库永远红。
   2. 判断外链用的是 /src=/，`data-src=` 也会命中，于是带 data-src 的内联脚本整段漏检。

   现在按 type 分流，每一类都有明确处理，没有「不认识就跳过」：
     无 type / JS MIME           → new Function 做语法检查（不执行）
     JSON 类型（ld+json、json、importmap）→ JSON.parse
     其他 type（含 module）       → 直接报错，要求在这里明确加上处理方式
   外链脚本（有 src 属性）只看属性名是否恰为 src，不检查内容。

   不执行任何脚本、不开浏览器、不联网、不写文件。

   用法：
     node scripts/check-inline-scripts.mjs            # 检查 git 跟踪的所有 .html
     node scripts/check-inline-scripts.mjs a.html     # 只检查指定文件
   退出码：0 = 全部通过；1 = 有错误；2 = 没有可检查的文件（空转不算通过）。 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const JS_TYPES = new Set([
  "", "text/javascript", "application/javascript", "application/x-javascript",
  "text/ecmascript", "application/ecmascript",
]);
const JSON_TYPES = new Set(["application/ld+json", "application/json", "importmap"]);

/* 取开始标签里的属性名 → 值（值可带双引号、单引号或不带引号）。 */
function attrs(openTag) {
  const inner = openTag.replace(/^<script/i, "").replace(/>$/, "");
  const out = new Map();
  for (const m of inner.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function checkFile(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const errors = [];
  let n = 0;
  for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const a = attrs(m[1]);
    if (a.has("src")) continue;
    n++;
    const line = text.slice(0, m.index).split("\n").length;
    const type = (a.get("type") || "").trim().toLowerCase();
    try {
      if (JS_TYPES.has(type)) new Function(m[2]);
      else if (JSON_TYPES.has(type)) JSON.parse(m[2]);
      else throw new Error(`未处理的 script type "${type}"：请在 scripts/check-inline-scripts.mjs 里明确它该怎么检查`);
    } catch (e) {
      errors.push(`第 ${line} 行 <script${type ? ` type="${type}"` : ""}>：${e.message}`);
    }
  }
  return { n, errors };
}

const args = process.argv.slice(2);
const files = args.length
  ? args
  : execFileSync("git", ["ls-files", "*.html"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean);

if (!files.length) {
  console.error("  没有找到可检查的 .html —— 空转不算通过。");
  process.exit(2);
}

let bad = 0;
let blocks = 0;
for (const f of files) {
  const { n, errors } = checkFile(f);
  blocks += n;
  if (errors.length) {
    bad++;
    console.log("  语法错误: " + f);
    for (const e of errors) console.log("        " + e);
  }
}

console.log(`  检查 ${files.length} 个 .html ｜ 内联 <script> ${blocks} 段 ｜ 有错误的文件 ${bad} 个`);
process.exit(bad ? 1 : 0);
