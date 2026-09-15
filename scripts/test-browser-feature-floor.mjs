#!/usr/bin/env node
/* check-browser-feature-floor.mjs 的正向 / 负向用例 —— 一次性临时目录，不碰真实仓库。

   要证明的是：基线之外的特性真的会被拦下，基线之内的不会误报，注释与不扫的目录不算数。
   最后对真实仓库跑一次。

   不开浏览器、不联网；只写系统临时目录，结束即删。
   运行：node scripts/test-browser-feature-floor.mjs   退出码：0 全部符合；1 有不符合。 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = path.join(ROOT, "scripts", "check-browser-feature-floor.mjs");
const BASELINE = { features: { "可选链 ?.": { chrome: "80", safari: "13.1" }, "flex gap": { chrome: "84", safari: "14.1" } }, notes: {} };

const CASES = [
  { name: "只用基线内的特性 → 通过", files: { "assets/js/a.js": "const x = a?.b;", "assets/css/a.css": ".x{gap:8px}" }, expect: 0 },
  { name: "用了基线外的 JS 特性（structuredClone）→ 失败并点名",
    files: { "assets/js/a.js": "const x = a?.b; const y = structuredClone(x);", "assets/css/a.css": ".x{gap:8px}" }, expect: 1, out: /超出基线的特性：structuredClone/ },
  { name: "用了基线外的 CSS 特性（:has()）→ 失败并点名",
    files: { "assets/js/a.js": "const x = a?.b;", "assets/css/a.css": ".x{gap:8px}body:has(.y) .x{color:red}" }, expect: 1, out: /超出基线的特性：:has\(\)/ },
  { name: "HTML 内联 <script> 里的基线外特性也算 → 失败",
    files: { "assets/js/a.js": "const x = a?.b;", "assets/css/a.css": ".x{gap:8px}", "p.html": "<script>const v = document.querySelector('x').replaceChildren();</script>" },
    expect: 1, out: /replaceChildren/ },
  { name: "注释里的特性不算数 → 通过",
    files: { "assets/js/a.js": "const x = a?.b; /* 以前用过 structuredClone(x) */", "assets/css/a.css": ".x{gap:8px}/* body:has(.y){} */" }, expect: 0 },
  { name: "docs 目录不扫 → 通过",
    files: { "assets/js/a.js": "const x = a?.b;", "assets/css/a.css": ".x{gap:8px}", "docs/d.html": "<style>body:has(.y){color:red}</style>" }, expect: 0 },
  { name: "scripts 目录不扫（探针自己用什么不受限）→ 通过",
    files: { "assets/js/a.js": "const x = a?.b;", "assets/css/a.css": ".x{gap:8px}", "scripts/p.mjs": "const v = structuredClone({});" }, expect: 0 },
  { name: "一个有门槛的特性都没有 → 退出码 2（空转不算通过）", files: { "assets/js/a.js": "var x = 1;", "assets/css/a.css": ".x{color:#000}" }, expect: 2 },
  { name: "基线里有、现在不用了 → 只提示，不判失败",
    files: { "assets/js/a.js": "const x = a?.b;", "assets/css/a.css": ".x{color:#000}" }, expect: 0, out: /基线里已经不再用到 1 个：flex gap/ },
];

let bad = 0;
for (const c of CASES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csc-floor-"));
  try {
    fs.mkdirSync(path.join(dir, "scripts/fixtures"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts/fixtures/browser-feature-baseline.json"), JSON.stringify(BASELINE, null, 2));
    for (const [rel, text] of Object.entries(c.files)) {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = spawnSync(process.execPath, [CHECKER, "--root", dir], { encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    const p = [];
    if (r.status !== c.expect) p.push(`退出码 ${r.status}，预期 ${c.expect}`);
    if (c.out && !c.out.test(out)) p.push(`输出里没有 ${c.out}`);
    if (p.length) { bad++; console.log("  FAIL  " + c.name + "\n        " + p.join("；") + "\n        | " + out.trim().split("\n").join("\n        | ")); }
    else console.log("  ok    " + c.name);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
{
  const r = spawnSync(process.execPath, [CHECKER], { encoding: "utf8" });
  if (r.status === 0) console.log("  ok    真实仓库：没有超出基线的特性");
  else { bad++; console.log("  FAIL  真实仓库：退出码 " + r.status + "\n        | " + (r.stdout || "").trim()); }
}
console.log("\n──────────────────────────────");
console.log("  用例 " + (CASES.length + 1) + " 个 ｜ 不符合预期 " + bad + " 个");
process.exit(bad ? 1 : 0);
