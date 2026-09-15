#!/usr/bin/env node
/* regress-profile-pages.mjs 的汇总逻辑用例：用必过 / 必败 / 被信号终止的替身脚本，
   验证退出码与报告内容，而不去真的起 Chrome。

   只写系统临时目录，结束即删；不联网。

   运行：node scripts/test-regress-profile-pages.mjs
   退出码：0 全部用例符合预期；1 有用例不符合预期。 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "regress-profile-pages.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csc-regress-"));
const stub = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
const PASS = stub("pass.mjs", 'console.log("  PASS 3  FAIL 0");\n');
const FAIL = stub("fail.mjs", 'console.log("  FAIL  X1 某条断言");\nconsole.log("  PASS 2  FAIL 1");\nprocess.exit(1);\n');
const KILL = stub("kill.mjs", 'process.kill(process.pid, "SIGTERM");\nsetTimeout(() => {}, 5000);\n');

const CASES = [
  {
    name: "全部通过 → 退出码 0，报告写「全部通过」",
    targets: [[PASS, "替身 A"], [PASS, "替身 B"]], expect: 0,
    report: [/全部通过\*\*（2\/2）/, /PASS 3  FAIL 0/, /## 失败项\n\n（无）/],
  },
  {
    name: "有一支失败 → 退出码 1，报告仍写出并列出 FAIL 行",
    targets: [[PASS, "替身 A"], [FAIL, "替身 B"]], expect: 1,
    report: [/有失败\*\*（1\/2）/, /\| 1 \|/, /- FAIL  X1 某条断言/],
  },
  {
    name: "被信号终止（退出码为 null）→ 算失败，不能当成通过",
    targets: [[KILL, "替身 C"]], expect: 1,
    report: [/被信号终止/, /有失败\*\*（0\/1）/],
  },
  {
    name: "每支可带自己的环境变量（todo-loop 分组靠它），且报告里写明",
    targets: [[stub("env.mjs", 'process.exit(process.env.ONLY === "Sf,A,G" && process.env.CHROME_PATH ? 0 : 1);\n'), "替身 D", { ONLY: "Sf,A,G" }]],
    expect: 0, report: [/`ONLY=Sf,A,G node /, /全部通过\*\*（1\/1）/],
  },
  { name: "没有要跑的检查 → 退出码 2，不写报告", targets: [], expect: 2, noReport: true },
];

let bad = 0;
try {
  for (const [i, c] of CASES.entries()) {
    const out = path.join(dir, `report-${i}.md`);
    const r = spawnSync(process.execPath, [RUNNER, "--out", out],
      { encoding: "utf8", env: { ...process.env, CSC_REGRESS_TARGETS: JSON.stringify(c.targets) } });
    const p = [];
    if (r.status !== c.expect) p.push(`退出码 ${r.status}，预期 ${c.expect}`);
    const exists = fs.existsSync(out);
    if (c.noReport) { if (exists) p.push("不该写出报告"); }
    else if (!exists) p.push("没有写出报告");
    else {
      const md = fs.readFileSync(out, "utf8");
      for (const re of c.report) if (!re.test(md)) p.push(`报告里没有 ${re}`);
    }
    if (p.length) {
      bad++;
      console.log("  FAIL  " + c.name + "\n        " + p.join("；"));
      console.log(((r.stdout || "") + (r.stderr || "")).split("\n").filter(Boolean).map((l) => "        | " + l).join("\n"));
    } else console.log("  ok    " + c.name);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n──────────────────────────────");
console.log("  用例 " + CASES.length + " 个 ｜ 不符合预期 " + bad + " 个");
process.exit(bad ? 1 : 0);
