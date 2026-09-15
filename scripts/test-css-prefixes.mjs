#!/usr/bin/env node
/* check-css-prefixes.mjs 的正向 / 负向用例 —— 一次性临时 git 仓库，不碰真实仓库。

   一条永远为真的判据不是判据：每种「缺前缀」都构造一个应当失败的场景，证明它真会失败；
   再构造配齐的场景证明它真会通过；最后对真实仓库跑一次。

   不开浏览器、不联网；只写系统临时目录，结束即删。
   运行：node scripts/test-css-prefixes.mjs   退出码：0 全部符合；1 有不符合。 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = path.join(ROOT, "scripts", "check-css-prefixes.mjs");
const PAIR = "-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)";

const CASES = [
  { name: "配齐前缀（css 文件）→ 通过", files: { "a.css": `.x{${PAIR};color:#000}` }, expect: 0 },
  { name: "缺前缀（css 文件）→ 失败并点名", files: { "a.css": ".x{backdrop-filter:blur(8px)}" }, expect: 1, out: /a\.css：backdrop-filter/ },
  { name: "前缀值不一致 → 失败（blur(4px) 配 blur(8px) 不算配齐）",
    files: { "a.css": ".x{-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(8px)}" }, expect: 1, out: /缺同值/ },
  { name: "前缀在另一条规则里 → 失败（必须同一段声明）",
    files: { "a.css": ".y{-webkit-backdrop-filter:blur(8px)}.x{backdrop-filter:blur(8px)}" }, expect: 1, out: /backdrop-filter/ },
  { name: "HTML 内联 <style> 里缺前缀 → 失败并点名",
    files: { "a.css": `.x{${PAIR}}`, "p.html": "<style>.z{backdrop-filter:blur(2px)}</style>" }, expect: 1, out: /p\.html <style>/ },
  { name: "HTML style=\"\" 里配齐 → 通过", files: { "a.css": `.x{${PAIR}}`, "p.html": `<div style="${PAIR}"></div>` }, expect: 0 },
  { name: "注释里的声明不算数 → 通过", files: { "a.css": `.x{${PAIR}}/* .old{backdrop-filter:blur(9px)} */` }, expect: 0 },
  { name: "docs/ 下的文件不扫 → 通过", files: { "a.css": `.x{${PAIR}}`, "docs/d.html": "<style>.z{backdrop-filter:blur(2px)}</style>" }, expect: 0 },
  { name: "一个需要前缀的声明都没有 → 退出码 2（空转不算通过）", files: { "a.css": ".x{color:#000}" }, expect: 2 },
];

let bad = 0;
for (const c of CASES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csc-cssprefix-"));
  try {
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
  if (r.status === 0) { console.log("  ok    真实仓库：所有 backdrop-filter 都配齐了同值前缀"); }
  else { bad++; console.log("  FAIL  真实仓库：退出码 " + r.status + "\n        | " + (r.stdout || "").trim()); }
}
console.log("\n──────────────────────────────");
console.log("  用例 " + (CASES.length + 1) + " 个 ｜ 不符合预期 " + bad + " 个");
process.exit(bad ? 1 : 0);
