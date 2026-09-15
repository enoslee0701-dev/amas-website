#!/usr/bin/env node
/* check-site-static.mjs 的正向 / 负向用例 —— 在一次性临时 git 仓库里验证，不碰真实仓库。

   先放一套全部合法的 fixture，证明能过；再逐类放进一个坏文件，证明那一步真的会报出来、
   并且点得出文件名。最后证明「某一步一个文件都没有」会以退出码 2 失败（空转不算通过）。

   不开浏览器、不联网；只写系统临时目录，结束即删。

   运行：node scripts/test-check-site-static.mjs
   退出码：0 全部用例符合预期；1 有用例不符合预期。 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLCHAIN = ["scripts/check-site-static.mjs", "scripts/check-inline-scripts.mjs", "scripts/check-internal-links.py"];

const GOOD = {
  "index.html": '<!doctype html><html><head><title>t</title><script src="assets/js/a.js"></script></head>' +
                '<body><a href="about.html">关于</a><script>var ok = 1;</script></body></html>\n',
  "about.html": "<!doctype html><html><head><title>a</title></head><body>about</body></html>\n",
  "assets/js/a.js": "(function(){ var x = 1; })();\n",
  "lib/b.mjs": "export const b = 1;\n",
  "fn/c.ts": "export function c(n: number): number { return n + 1; }\n",
  "tools/d.py": "def d():\n    return 1\n",
  "tools/e.sh": "#!/usr/bin/env bash\nset -e\necho ok\n",
  ".githooks/pre-commit": "#!/bin/sh\nexit 0\n",
};

const CASES = [
  { name: "全部合法 → 通过", files: {}, expect: 0 },
  { name: "站点 JS 语法错误 → 失败并点名", files: { "assets/js/a.js": "(function(){ var = ; })();\n" }, expect: 1, out: /assets\/js\/a\.js/ },
  { name: ".mjs 语法错误 → 失败并点名", files: { "lib/b.mjs": "export const = 1;\n" }, expect: 1, out: /lib\/b\.mjs/ },
  { name: ".ts 语法错误 → 失败并点名", files: { "fn/c.ts": "export function c(n: number { return n; }\n" }, expect: 1, out: /fn\/c\.ts/ },
  { name: "Python 语法错误 → 失败并点名", files: { "tools/d.py": "def d(:\n    return 1\n" }, expect: 1, out: /tools\/d\.py/ },
  { name: "bash 脚本语法错误 → 失败并点名", files: { "tools/e.sh": "#!/usr/bin/env bash\nif then\n" }, expect: 1, out: /tools\/e\.sh/ },
  { name: "sh 钩子语法错误 → 失败并点名", files: { ".githooks/pre-commit": "#!/bin/sh\ncase x in\n" }, expect: 1, out: /\.githooks\/pre-commit/ },
  { name: "HTML 内联脚本语法错误 → 失败并点名", files: { "about.html": "<!doctype html><html><body><script>function (</script></body></html>\n" }, expect: 1, out: /about\.html/ },
  { name: "站内链接指向不存在的页面 → 失败并点名", files: { "about.html": '<!doctype html><html><body><a href="missing/">x</a></body></html>\n' }, expect: 1, out: /missing\// },
  { name: ".ts 里是 JS 层面的错（剥完类型也不是合法模块）→ 失败并点名", files: { "fn/c.ts": "export const = (n: number) => n;\n" }, expect: 1, out: /fn\/c\.ts/ },
  /* 工具链自己带着 .py / .mjs，所以「空转」拿 Shell 这一类来造：把两个 shell 文件都拿掉 */
  { name: "某一类一个文件都没有（没有任何 Shell 脚本）→ 退出码 2", files: { "tools/e.sh": null, ".githooks/pre-commit": null }, expect: 2, out: /没扫到文件的步骤：Shell 语法/ },
];

let bad = 0;
for (const c of CASES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csc-site-static-"));
  try {
    for (const rel of TOOLCHAIN) {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
    }
    for (const [rel, text] of Object.entries({ ...GOOD, ...c.files })) {
      if (text === null) continue;
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = spawnSync(process.execPath, ["scripts/check-site-static.mjs"], { cwd: dir, encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    const p = [];
    if (r.status !== c.expect) p.push(`退出码 ${r.status}，预期 ${c.expect}`);
    if (c.out && !c.out.test(out)) p.push(`输出里没有 ${c.out}`);
    if (p.length) {
      bad++;
      console.log("  FAIL  " + c.name + "\n        " + p.join("；"));
      console.log(out.split("\n").filter(Boolean).map((l) => "        | " + l).join("\n"));
    } else console.log("  ok    " + c.name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log("\n──────────────────────────────");
console.log("  用例 " + CASES.length + " 个 ｜ 不符合预期 " + bad + " 个");
process.exit(bad ? 1 : 0);
