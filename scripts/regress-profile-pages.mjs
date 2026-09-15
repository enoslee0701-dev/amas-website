#!/usr/bin/env node
/* 资料页最小本地回归：逐支运行受影响的检查，汇总成一份报告。

   「受影响」指本分支改过的资料页及其契约：
     T-009 portal/applicant/profile/ 读取边界      T-010 账号状态词表 ↔ account_status 枚举
     T-011 portal/student/profile/ 在途重复提交
   选入的检查（都只用本地 stub / 临时目录，不连真实服务、不外发）：
     test-applicant-profile-read-boundary.mjs  node:vm，申请人资料页读失败 / 空对象 / 重试
     test-account-status-vocab.mjs             临时目录用例 + 真实仓库词表一致性
     test-profile-writes.mjs                   自带 Chrome，三个资料页的写入、未保存守卫、在途防重
     test-portal-pages.mjs                     自带 Chrome，含三个资料页的读取与渲染
     test-student-todo-loop.mjs                自带 Chrome，学员待办 → 资料页补电话 → 回学员中心
       ↑ 这一支按它自己的「组隔离」规则**分四次跑**：ONLY=St,A,G / Sf,A,G / Se,A,G / Sp,A,G。
         Sf / Se / Sp 放进同一个进程它会直接拒跑（退出码 2）—— 那是它的设计，不是故障。
   刻意没放进来的：test-portal-degraded.mjs（未配置时的降级外壳，与本分支改动无关）。

   Chrome 路径：test-student-todo-loop.mjs 自己不走 lib/chrome-launcher，没设 CHROME_PATH / CHROME 时
   默认的是 Windows 路径，在 Mac 上起不来。所以这里在两个变量都没设时，
   把 lib/chrome-launcher.mjs 的 chromeBinary() 作为 CHROME_PATH 传给每一支 —— 与其他探针同一个来源。

   故意不叫 scripts/regress.sh：verify.sh 第 3 步见到那个名字就会执行，
   等于让每次 verify 都起 Chrome —— 那是改门槛，不是本条要做的事。

   用法：
     node scripts/regress-profile-pages.mjs [--out <报告路径>]
   默认报告：docs/operations/CSC-T-016-PROFILE-REGRESSION-REPORT.md
   退出码：0 = 全部通过且报告已写出；1 = 有检查失败（报告照样写出）；2 = 没有要跑的检查。 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromeBinary } from "./lib/chrome-launcher.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const oi = argv.indexOf("--out");
const OUT = path.resolve(ROOT, oi > -1 ? argv[oi + 1] : "docs/operations/CSC-T-016-PROFILE-REGRESSION-REPORT.md");

const DEFAULT_TARGETS = [
  ["scripts/test-applicant-profile-read-boundary.mjs", "T-009 申请人资料页读取边界（node:vm）"],
  ["scripts/test-account-status-vocab.mjs", "T-010 账号状态词表契约（临时目录 + 真实仓库）"],
  ["scripts/test-profile-writes.mjs", "T-011 三个资料页写入与在途防重（自带 Chrome）"],
  ["scripts/test-portal-pages.mjs", "资料页读取与渲染（自带 Chrome）"],
  ...["St", "Sf", "Se", "Sp"].map((g) =>
    ["scripts/test-student-todo-loop.mjs", `学员待办 → 资料页补电话闭环 · ${g} 组（自带 Chrome，组隔离单独一趟）`, { ONLY: `${g},A,G` }]),
];
/* 测试钩子：test-regress-profile-pages.mjs 用它换成必过 / 必败的替身脚本，验证汇总与退出码。 */
const TARGETS = process.env.CSC_REGRESS_TARGETS ? JSON.parse(process.env.CSC_REGRESS_TARGETS) : DEFAULT_TARGETS;
if (!TARGETS.length) {
  console.error("  没有要跑的检查 —— 空转不算通过。");
  process.exit(2);
}

const gitOut = (...a) => { try { return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "（不可用）"; } };
const results = [];
const BASE_ENV = { ...process.env };
if (!BASE_ENV.CHROME_PATH && !BASE_ENV.CHROME) BASE_ENV.CHROME_PATH = chromeBinary();
for (const [script, why, extraEnv = {}] of TARGETS) {
  const envNote = Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`).join(" ");
  const label = (envNote ? envNote + " " : "") + "node " + script;
  process.stdout.write(`  … ${label}\n`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...BASE_ENV, ...extraEnv } });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const lines = ((r.stdout || "") + (r.stderr || "")).split("\n").map((l) => l.trimEnd()).filter(Boolean);
  /* 摘要：各脚本收尾那几行（PASS n FAIL m / n/m 通过 / 用例 n 个 ｜ 不符合预期 m 个 / INCOMPLETE）+ 全部 FAIL 行 */
  const summary = lines.filter((l) => /PASS\s+\d+\s+FAIL\s+\d+|^\s*\d+\/\d+ 通过|用例 \d+ 个|情形 \d+ 个|INCOMPLETE/.test(l)).slice(-2).map((l) => l.trim());
  const fails = lines.filter((l) => /^\s*FAIL\b/.test(l));
  const status = r.status === null ? `被信号终止（${r.signal}）` : String(r.status);
  results.push({ script: label, why, status, ok: r.status === 0, secs, summary, fails });
  console.log(`  ${r.status === 0 ? "ok  " : "FAIL"}  ${label}  退出码 ${status}  ${secs}s  ${summary.join(" / ")}`);
}

const allOk = results.every((x) => x.ok);
const md = [
  "# 资料页最小本地回归报告（T-016）",
  "",
  "读者：Luna / Enos。由 `node scripts/regress-profile-pages.mjs` 生成，别手改；要更新就重跑。",
  "",
  `- 生成时间：${new Date().toISOString()}`,
  `- 分支 / 提交：\`${gitOut("branch", "--show-current")}\` / \`${gitOut("rev-parse", "--short", "HEAD")}\``,
  `- 工作区未提交改动：${gitOut("status", "--porcelain").split("\n").filter(Boolean).length} 项（运行时的状态，含尚未提交的本脚本与报告本身）`,
  `- 结论：**${allOk ? "全部通过" : "有失败"}**（${results.filter((x) => x.ok).length}/${results.length}）`,
  "- 范围：只用本地 stub、临时目录和自带的 Chrome；外网请求由各脚本拦截，没有连接真实账号、服务或数据库。",
  `- Chrome：${BASE_ENV.CHROME_PATH || BASE_ENV.CHROME}${process.env.CHROME_PATH || process.env.CHROME ? "（来自环境变量）" : "（未设环境变量，取 lib/chrome-launcher.mjs 的 chromeBinary()）"}`,
  "",
  "| 检查 | 为什么在这里 | 退出码 | 耗时 | 摘要 |",
  "|---|---|---|---|---|",
  ...results.map((x) => `| \`${x.script}\` | ${x.why} | ${x.status} | ${x.secs}s | ${x.summary.join(" / ").replace(/\|/g, "\\|") || "—"} |`),
  "",
  "## 失败项",
  "",
  ...(results.some((x) => x.fails.length)
    ? results.filter((x) => x.fails.length).flatMap((x) => [`### ${x.script}`, "", ...x.fails.map((l) => "- " + l.trim()), ""])
    : ["（无）", ""]),
].join("\n");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md);
console.log(`\n  报告：${path.relative(ROOT, OUT)}`);
console.log(`  ${allOk ? "全部通过" : "有失败"}（${results.filter((x) => x.ok).length}/${results.length}）`);
process.exit(allOk ? 0 : 1);
