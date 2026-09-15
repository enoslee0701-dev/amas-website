#!/usr/bin/env node
/* 浏览器特性下限检查（基线版）。

   为什么是「基线版」：目标浏览器矩阵还没定（CSC-T-023 的 C1 / CSC-T-028 的 D1，需 Enos 决定）。
   在那之前至少要做到一件事 —— **不悄悄抬高门槛**：
   把站点当前实际用到的特性集合固定成基线，之后出现基线之外、门槛更高的特性就失败，
   由人决定是接受（更新基线并同时更新矩阵）还是换写法。

   扫描范围：git 跟踪的 assets 下的 .js 与 .css，以及所有 HTML（不含 docs 目录）的
   内联 `<script>`、`<style>` 与 `style=""`。**不扫 scripts 与 supabase 两个目录**：那些只在 Node 或验收环境跑，
   不进浏览器（探针语法另有 check-probe-syntax.mjs 管；注释里不要写出星斜杠，会提前闭合块注释）。

   基线文件：`scripts/fixtures/browser-feature-baseline.json`
     features   已接受的特性 → 各引擎的大致最低版本（常识下限，待 caniuse 逐项复核，见 T-023 报告）
     notes      为什么接受 / 有没有回退
   判据：
     · 用到了基线里没有的特性 → 失败，列出特性与文件；
     · 基线里有、现在已经不用了 → 只提示（不失败），由人决定要不要清理；
     · 一个特性都没扫到 → 退出码 2（空转不算通过）。
   **这条检查不判断「某浏览器能不能用」**，只判断「特性集合有没有变大」。真实兼容性要实测（T-028 的 NOT_RUN 清单）。

   只读文件；不开浏览器、不联网、不写文件。

   用法：
     node scripts/check-browser-feature-floor.mjs              检查
     node scripts/check-browser-feature-floor.mjs --print      只打印当前用到的特性与推算下限
     node scripts/check-browser-feature-floor.mjs --root DIR   检查另一棵同结构目录（夹具用）
   退出码：0 = 没有超出基线；1 = 有超出基线的特性；2 = 空转。 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const ri = argv.indexOf("--root");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = ri > -1 ? path.resolve(argv[ri + 1]) : path.resolve(HERE, "..");
const BASELINE = path.join(ROOT, "scripts/fixtures/browser-feature-baseline.json");

/* 特性判据。只放**有版本门槛**的；写法保守，宁可漏也不要误报 —— 误报会逼人改无关的代码。 */
export const JS_FEATURES = {
  "可选链 ?.": /[\w\)\]]\?\.(?!\d)/,
  "空值合并 ??": /\?\?(?!=)/,
  "逻辑赋值 ??= ||= &&=": /(\?\?=|\|\|=|&&=)/,
  "Object.fromEntries": /Object\.fromEntries\(/,
  "Array#at": /\.at\(\s*-?\d/,
  "String#replaceAll": /\.replaceAll\(/,
  "structuredClone": /\bstructuredClone\(/,
  "form.requestSubmit": /\.requestSubmit\(/,
  "AbortSignal.timeout": /AbortSignal\.timeout\(/,
  "AbortController": /\bAbortController\b/,
  "crypto.randomUUID": /\brandomUUID\(/,
  "Promise.allSettled": /Promise\.allSettled\(/,
  "Promise.any": /Promise\.any\(/,
  "dialog.showModal": /\.showModal\(/,
  "Element.replaceChildren": /\.replaceChildren\(/,
  "类私有字段 #x": /this\.#\w/,
  "Object.hasOwn": /Object\.hasOwn\(/,
  "Array#findLast": /\.findLast(Index)?\(/,
  "IntersectionObserver": /\bIntersectionObserver\b/,
  "ResizeObserver": /\bResizeObserver\b/,
  "navigator.clipboard": /navigator\.clipboard/,
  "Intl.RelativeTimeFormat": /RelativeTimeFormat/,
  "focus({preventScroll})": /preventScroll/,
  "scrollIntoView 选项": /scrollIntoView\(\{/,
  "visualViewport": /visualViewport/,
};
export const CSS_FEATURES = {
  ":has()": /:has\(/,
  "dvh/svh/lvh 单位": /\d(dvh|svh|lvh)\b/,
  "flex gap": /(^|[;{\s])gap\s*:/,
  "aspect-ratio": /aspect-ratio\s*:/,
  "inset 简写": /(^|[;{\s])inset\s*:/,
  ":focus-visible": /:focus-visible/,
  "backdrop-filter": /(?<![-\w])backdrop-filter\s*:/,
  "clamp()": /clamp\(/,
  "color-mix()": /color-mix\(/,
  "@container": /@container/,
  "CSS 嵌套 &": /&\s*[:.\[>+~]/,
  ":is()/:where()": /:(is|where)\(/,
  "scroll-behavior": /scroll-behavior\s*:/,
  "text-wrap": /text-wrap\s*:/,
  "overscroll-behavior": /overscroll-behavior/,
  "accent-color": /accent-color\s*:/,
  "@layer": /@layer/,
  "subgrid": /subgrid/,
  "env(safe-area-inset)": /safe-area-inset/,
  "@supports": /@supports/,
  "scroll-snap": /scroll-snap/,
  "::backdrop": /::backdrop/,
};

const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

export function scan(root) {
  const files = execFileSync("git", ["ls-files", "--", "*.html", "assets/*.js", "assets/*.css"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(Boolean).filter((f) => !f.startsWith("docs/"));
  const js = [], css = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    if (rel.endsWith(".js")) { js.push([rel, src]); continue; }
    if (rel.endsWith(".css")) { css.push([rel, src]); continue; }
    for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
      if (!/(?:^|\s)src\s*=/i.test(m[1]) && !/json/i.test(m[1])) js.push([rel, m[2]]);
    for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css.push([rel, m[1]]);
    for (const m of src.matchAll(/\sstyle="([^"]*)"/gi)) css.push([rel, m[1]]);
  }
  const used = {};
  const add = (name, file) => { (used[name] ||= new Set()).add(file); };
  for (const [file, src] of js) { const s = stripJsComments(src); for (const [n, re] of Object.entries(JS_FEATURES)) if (re.test(s)) add(n, file); }
  for (const [file, src] of css) { const s = stripCssComments(src); for (const [n, re] of Object.entries(CSS_FEATURES)) if (re.test(s)) add(n, file); }
  return { used, jsChunks: js.length, cssChunks: css.length };
}

const { used, jsChunks, cssChunks } = scan(ROOT);
const usedNames = Object.keys(used).sort();

if (argv.includes("--print")) {
  console.log(JSON.stringify(Object.fromEntries(usedNames.map((n) => [n, [...used[n]].sort()])), null, 2));
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) { console.error("  找不到基线文件：" + path.relative(ROOT, BASELINE)); process.exit(2); }
const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const accepted = Object.keys(baseline.features || {});

const beyond = usedNames.filter((n) => !accepted.includes(n));
const stale = accepted.filter((n) => !usedNames.includes(n));

console.log(`  扫描 ${jsChunks} 段 JS ｜ ${cssChunks} 段 CSS ｜ 用到有门槛的特性 ${usedNames.length} 个 ｜ 基线 ${accepted.length} 个`);
for (const n of beyond) console.log(`  FAIL  超出基线的特性：${n} —— 出现在 ${[...used[n]].sort().slice(0, 4).join("、")}`);
if (stale.length) console.log(`  提示（不判失败）：基线里已经不再用到 ${stale.length} 个：${stale.join("、")}`);

/* 推算下限：基线里各特性版本的最大值。只作参考，版本号本身待复核。 */
if (!beyond.length) {
  const floor = {};
  for (const n of usedNames) for (const [eng, v] of Object.entries((baseline.features[n] || {}))) {
    const num = parseFloat(v); if (!Number.isFinite(num)) continue;
    if (!floor[eng] || num > floor[eng].num) floor[eng] = { num, v, by: n };
  }
  console.log("  当前推算下限（参考，版本号待 caniuse 复核）：" +
    Object.entries(floor).map(([e, x]) => `${e} ${x.v}（${x.by}）`).join(" ｜ "));
}

if (!usedNames.length) { console.log("  一个有门槛的特性都没扫到 —— 空转不算通过。"); process.exit(2); }
process.exit(beyond.length ? 1 : 0);
