#!/usr/bin/env node
/* CSS 厂商前缀检查：需要前缀才生效的属性，必须**同值**配上前缀版本。

   目前只管一条：`backdrop-filter`。
   Safari 直到 18 才支持不带前缀的写法，`-webkit-backdrop-filter` 从 Safari 9 起就有。
   站点的毛玻璃用在吸顶头部、门户头部与底栏、弹窗遮罩上 —— 少了前缀，iOS 18 以下一律没有模糊效果。
   （背景本身是 .82~.97 的半透明色，可读性不受影响，所以这是观感问题，不是功能问题。）
   来源：CSC-T-023 报告的 C3、CSC-T-028 的 D7。

   判据：每出现一次 `backdrop-filter: <值>`，同一段声明里必须有 `-webkit-backdrop-filter: <相同的值>`。
   扫描范围：git 跟踪的 *.css，以及 HTML 里的 <style> 与 style="" （不含 docs/）。

   只读文件；不开浏览器、不联网、不写文件。

   用法：node scripts/check-css-prefixes.mjs [--root DIR]
   退出码：0 = 全部配齐；1 = 有缺前缀；2 = 一个声明都没扫到（空转不算通过）。 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const ri = argv.indexOf("--root");
const ROOT = ri > -1 ? path.resolve(argv[ri + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 需要前缀的属性：属性名 → 前缀名 */
const NEEDS_PREFIX = { "backdrop-filter": "-webkit-backdrop-filter" };

const tracked = execFileSync("git", ["ls-files", "--", "*.css", "*.html"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => !f.startsWith("docs/"));

const chunks = [];   // { file, css }
for (const rel of tracked) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  if (rel.endsWith(".css")) { chunks.push({ file: rel, css: src }); continue; }
  for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) chunks.push({ file: rel + " <style>", css: m[1] });
  for (const m of src.matchAll(/\sstyle="([^"]*)"/gi)) chunks.push({ file: rel + ' style=""', css: m[1] });
}

let seen = 0;
const missing = [];
for (const { file, css } of chunks) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [prop, prefixed] of Object.entries(NEEDS_PREFIX)) {
    const re = new RegExp(String.raw`(?<![-\w])${prop}\s*:\s*([^;}]+)`, "g");
    for (const m of clean.matchAll(re)) {
      seen++;
      const value = m[1].trim();
      /* 同一段声明里必须有同值的前缀版本。声明块用 { } 粗略切分；style="" 整体算一段。 */
      const start = clean.lastIndexOf("{", m.index) + 1;
      const end = clean.indexOf("}", m.index);
      const block = clean.slice(start === 0 ? 0 : start, end < 0 ? clean.length : end);
      const hasPrefixed = new RegExp(String.raw`${prefixed}\s*:\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*(;|$)`).test(block);
      if (!hasPrefixed) missing.push(`${file}：${prop}: ${value} —— 缺同值的 ${prefixed}`);
    }
  }
}

for (const m of missing) console.log("  FAIL  " + m);
console.log(`  扫描 ${chunks.length} 段样式 ｜ 需要前缀的声明 ${seen} 处 ｜ 缺前缀 ${missing.length} 处`);
if (!seen) { console.log("  一个需要前缀的声明都没扫到 —— 空转不算通过。"); process.exit(2); }
process.exit(missing.length ? 1 : 0);
