#!/usr/bin/env node
/* verify.sh 第 2 步（HTML 内联 <script> 语法）的正向 / 负向用例。

   为什么要有这一条：首轮跑 ./scripts/verify.sh 退出码 1，报「语法错误: index.html」。
   实际原因不是页面坏了，而是 index.html 里两段 <script type="application/ld+json">
   是结构化数据（JSON），verify.sh 却把它们当 JS 塞进 new Function —— 合法 JSON 对象字面量
   `{ "@context": ... }` 在语句位置本来就不是合法 JS，于是必然误报。
   这个误报会让 verify.sh 在本仓库**永远**红，门槛等于失效。

   本脚本不碰真实仓库：每个用例在一次性临时目录里 git init，放入 fixture 页面，
   复制当前的 scripts/verify.sh（及其依赖的检查脚本）进去，按真实方式运行，看退出码。
   正向用例证明合法页面能过；负向用例证明坏页面真的会被拦 —— 一条永远为真的判据不是判据。

   不开浏览器、不起服务器、不联网；只写系统临时目录，结束即删。

   运行：node scripts/test-inline-script-check.mjs
   退出码：0 全部用例符合预期；1 有用例不符合预期。 */

import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/* verify.sh 运行时需要的脚本。缺哪个就不复制 —— 那样 verify.sh 自己会失败，
   正向用例随之失败，不会被悄悄放过。 */
const TOOLCHAIN = ["scripts/verify.sh", "scripts/check-inline-scripts.mjs"];

const page = (head, body = "") =>
  `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>\n`;

const LD_JSON = `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "CollegeOrUniversity",
  "name": "fixture"
}
</script>`;

const CASES = [
  {
    name: "合法 JSON-LD + 合法内联 JS → 通过（首轮误报的复现）",
    files: { "index.html": page(LD_JSON, "<script>var a = 1; if (a) { a++; }</script>") },
    expect: 0,
  },
  {
    name: "type 大小写 / 单引号 / 不加引号的 JSON 类型 → 通过",
    files: {
      "a.html": page(`<script type='APPLICATION/LD+JSON'>{"a": 1}</script>`),
      "b.html": page(`<script type=application/json>[1, 2, {"x": null}]</script>`),
    },
    expect: 0,
  },
  {
    name: "显式 JS 类型（text/javascript）照常按 JS 检查 → 通过",
    files: { "index.html": page(`<script type="text/javascript">function f(){ return 1 }</script>`) },
    expect: 0,
  },
  {
    name: "内联 JS 语法错误 → 必须失败",
    files: { "index.html": page(LD_JSON, "<script>function (</script>") },
    expect: 1,
    stdout: /index\.html/,
  },
  {
    name: "JSON-LD 本身不是合法 JSON（尾逗号）→ 必须失败，不能因为跳过 JS 检查就放过",
    files: { "index.html": page(`<script type="application/ld+json">{"a": 1,}</script>`) },
    expect: 1,
    stdout: /index\.html/,
  },
  {
    name: "带 data-src 的内联脚本仍是内联脚本，语法错误必须失败",
    files: { "index.html": page(`<script data-src="x.js">var = ;</script>`) },
    expect: 1,
    stdout: /index\.html/,
  },
  {
    name: "外链脚本（src=）不检查内容 → 通过",
    files: { "index.html": page(`<script src="x.js"></script>`) },
    expect: 0,
  },
  {
    name: "未声明处理方式的 script type → 必须失败（不许静默跳过）",
    files: { "index.html": page(`<script type="text/x-template"><div>{{ a }}</div></script>`) },
    expect: 1,
    stdout: /index\.html/,
  },
];

function runCase(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csc-inline-script-"));
  try {
    for (const rel of TOOLCHAIN) {
      const src = path.join(ROOT, rel);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.copyFileSync(src, path.join(dir, rel));
    }
    for (const [rel, text] of Object.entries(c.files)) {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    const r = spawnSync("bash", ["scripts/verify.sh"], {
      cwd: dir,
      encoding: "utf8",
      /* 嵌套运行标记：verify.sh 见到它就不再跑回归脚本，避免本测试递归调用自己。 */
      env: { ...process.env, CSC_VERIFY_NESTED: "1" },
    });
    const out = (r.stdout || "") + (r.stderr || "");
    const problems = [];
    if (r.status !== c.expect) problems.push(`退出码 ${r.status}，预期 ${c.expect}`);
    if (c.stdout && !c.stdout.test(out)) problems.push(`输出里没有 ${c.stdout}`);
    return { problems, out };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let bad = 0;
for (const c of CASES) {
  const { problems, out } = runCase(c);
  if (problems.length) {
    bad++;
    console.log("  FAIL  " + c.name + "\n        " + problems.join("；"));
    console.log(out.split("\n").filter(Boolean).slice(-6).map((l) => "        | " + l).join("\n"));
  } else {
    console.log("  ok    " + c.name);
  }
}

console.log("\n──────────────────────────────");
console.log("  用例 " + CASES.length + " 个 ｜ 不符合预期 " + bad + " 个");
process.exit(bad ? 1 : 0);
