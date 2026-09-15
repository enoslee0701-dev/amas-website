#!/usr/bin/env node
/* 全站静态检查汇总：脚本语法 + 站内链接一致性。一条命令、一个退出码。

   为什么要有这一条：各项检查散在不同地方，而且各管一段 ——
     verify.sh 第 2 步只查 HTML 内联 <script>；check-probe-syntax.mjs 只查 scripts/ 下的 .mjs；
     assets/js 下的 8 个站点脚本、supabase 下的 .mjs / .ts、scripts 下的 .py 与 .sh、.githooks/pre-commit
     **没有任何一条在查语法**；check-internal-links.py 要单独想起来跑。
   这里把它们串起来，每一步都报「查了几个、错了几个」，任一步一个文件都没扫到就算失败（空转不算通过）。

   步骤：
     1 JS / MJS / CJS 语法      git 跟踪的全部文件，node --check
     2 TypeScript 语法          git 跟踪的 .ts：module.stripTypeScriptTypes 剥类型（TS 语法错在这一步抛），
                                再用 vm.SourceTextModule 按 ES 模块解析剥完的 JS
                                ★ 不用 node --check：实测它对 .ts 会放过 `function c(n: number {` 这种 TS 语法错
                                  （退出码 0），只有连 JS 都不像的乱码才报 —— 那是空过。
     3 HTML 内联 <script>        node scripts/check-inline-scripts.mjs
     4 Python 语法              git 跟踪的 .py，ast.parse（不用 py_compile，不写 __pycache__）
     5 Shell 语法               git 跟踪的 .sh 与 .githooks/*，按 shebang 用 sh -n / bash -n
     6 站内链接                 python3 scripts/check-internal-links.py

   只读文件、只做解析：不执行被检查的脚本、不开浏览器、不联网、不写文件。
   「不联网」可以用 macOS 沙箱实测：
     sandbox-exec -p '(version 1)(allow default)(deny network*)' node scripts/check-site-static.mjs

   用法：node scripts/check-site-static.mjs
   退出码：0 = 全部通过；1 = 有错误；2 = 某一步没有扫到任何文件。 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = (...specs) =>
  execFileSync("git", ["ls-files", "-z", "--", ...specs], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
const firstLines = (s, n = 3) => (s || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, n).join(" | ");

const steps = [];
const step = (name, scanned, errors, note = "") => {
  steps.push({ name, scanned, errors, note });
  const mark = scanned === 0 ? "EMPTY" : errors.length ? "FAIL " : "ok   ";
  console.log(`  ${mark} ${name}：检查 ${scanned} 个，错误 ${errors.length} 个${note ? "（" + note + "）" : ""}`);
  for (const e of errors) console.log("        " + e);
};

/* 1 JS / MJS / CJS */
{
  const files = tracked("*.js", "*.mjs", "*.cjs");
  const errors = [];
  for (const f of files) {
    const r = run(process.execPath, ["--check", f]);
    if (r.status !== 0) errors.push(`${f}：${firstLines(r.stderr)}`);
  }
  step("JS / MJS / CJS 语法", files.length, errors, "node --check");
}

/* 2 TypeScript（见文件头：不用 node --check） */
{
  const files = tracked("*.ts");
  const errors = [];
  if (files.length) {
    const code = [
      "const fs = require('fs'), vm = require('vm'), { stripTypeScriptTypes } = require('module');",
      "let bad = 0;",
      "for (const f of process.argv.slice(1)) {",
      "  try {",
      "    const js = stripTypeScriptTypes(fs.readFileSync(f, 'utf8'), { mode: 'strip' });",
      "    new vm.SourceTextModule(js, { identifier: f });",
      "  } catch (e) { bad++; console.log(f + '：' + (e.code || e.name) + ' ' + String(e.message).split('\\n')[0]); }",
      "}",
      "process.exit(bad ? 1 : 0);",
    ].join("\n");
    const r = run(process.execPath, ["--experimental-vm-modules", "--no-warnings", "-e", code, ...files]);
    if (r.status !== 0) {
      const lines = (r.stdout || "").split("\n").filter(Boolean);
      errors.push(...(lines.length ? lines : [`TypeScript 检查进程退出码 ${r.status}：${firstLines(r.stderr)}`]));
    }
  }
  step("TypeScript 语法", files.length, errors, "stripTypeScriptTypes + vm.SourceTextModule");
}

/* 3 HTML 内联 <script> */
{
  const html = tracked("*.html");
  const r = run(process.execPath, ["scripts/check-inline-scripts.mjs"]);
  const errors = r.status === 0 ? [] : (r.stdout || "").split("\n").filter((l) => /语法错误|第 \d+ 行/.test(l)).map((l) => l.trim());
  if (r.status !== 0 && !errors.length) errors.push(`check-inline-scripts.mjs 退出码 ${r.status}：${firstLines(r.stdout + r.stderr)}`);
  step("HTML 内联 <script>", html.length, errors, "check-inline-scripts.mjs");
}

/* 4 Python */
{
  const files = tracked("*.py");
  const errors = [];
  if (files.length) {
    const code = [
      "import ast, sys",
      "bad = 0",
      "for f in sys.argv[1:]:",
      "    try:",
      "        ast.parse(open(f, encoding='utf-8').read(), filename=f)",
      "    except SyntaxError as e:",
      "        bad += 1",
      "        print('%s:%s: %s' % (f, e.lineno, e.msg))",
      "sys.exit(1 if bad else 0)",
    ].join("\n");
    const r = run("python3", ["-c", code, ...files]);
    if (r.error) errors.push("python3 不可用：" + r.error.message);
    else if (r.status !== 0) errors.push(...(r.stdout || "").split("\n").filter(Boolean));
  }
  step("Python 语法", files.length, errors, "ast.parse，不写 __pycache__");
}

/* 5 Shell */
{
  const files = tracked("*.sh", ".githooks/*");
  const errors = [];
  for (const f of files) {
    const head = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n")[0];
    const shell = /\bbash\b/.test(head) ? "bash" : "sh";
    const r = run(shell, ["-n", f]);
    if (r.status !== 0) errors.push(`${f}（${shell} -n）：${firstLines(r.stderr)}`);
  }
  step("Shell 语法", files.length, errors, "按 shebang 用 sh -n / bash -n");
}

/* 6 站内链接 */
{
  const r = run("python3", ["scripts/check-internal-links.py"]);
  const m = (r.stdout || "").match(/检查了 (\d+) 个站内引用/);
  const scanned = m ? Number(m[1]) : 0;
  const errors = r.status === 0 ? [] : (r.stdout || "").split("\n").filter((l) => /\s->\s/.test(l)).map((l) => l.trim().replace(/\s+/g, " "));
  if (r.status !== 0 && !errors.length) errors.push(`check-internal-links.py 退出码 ${r.status}：${firstLines(r.stdout + r.stderr)}`);
  step("站内链接", scanned, errors, "check-internal-links.py");
}

const empty = steps.filter((s) => s.scanned === 0);
const bad = steps.filter((s) => s.errors.length);
console.log("\n──────────────────────────────");
if (empty.length) console.log("  没扫到文件的步骤：" + empty.map((s) => s.name).join("、") + " —— 空转不算通过。");
console.log(`  ${steps.length} 步 ｜ 有错误 ${bad.length} 步 ｜ 空转 ${empty.length} 步`);
console.log("  只做解析：未执行被检查的脚本、未开浏览器、未联网、未写文件。");
process.exit(bad.length ? 1 : empty.length ? 2 : 0);
