#!/usr/bin/env node
/* 探针脚本语法门槛。

   为什么要有这一条：scripts/verify.sh 在本仓库里实际只查一件事 ——
   31 个 HTML 里的内联 <script>。三步里另外两步都是空转：
   没有 pom.xml（Java 那步跳过）、没有 scripts/regress.sh 也没有 package.json（回归那步跳过）。
   于是 73 个 .mjs 探针**一个都没被检查**：某支探针语法坏掉时，
   verify.sh 照样打出 VERIFY OK，而真正跑回归时才会当场炸。
   本季实测撞过的就有 `Identifier 'c1' has already been declared`、
   以及正则转义被模板字符串吃掉导致的 `Invalid regular expression`。
   （写这一条时它自己也犯了同一类错：注释里写出 glob 星斜杠，把块注释提前闭合了。
     正好说明这道门槛不是多余的。）

   这一条只做**语法**检查（node --check），不执行任何探针：
   不开浏览器、不起服务器、不联网、不写任何文件。

   用法：
     node scripts/check-probe-syntax.mjs              # 检查 git 跟踪的 scripts 下所有 .mjs
     node scripts/check-probe-syntax.mjs a.mjs b.mjs  # 只检查指定文件（用于负向对照）
   退出码：0 = 全部通过；1 = 有文件语法错误；2 = 没有可检查的文件（空转即失败，
   免得判据写对了却一个文件都没扫到 —— 那种「绿」没有意义）。 */

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tracked() {
  /* 列目录再按扩展名筛，不用 glob。
     （注：git 的 pathspec 里 `*` 本来就跨 `/`，写 "scripts/*.mjs" 并不会漏子目录 ——
       我一度以为漏了 scripts/lib，那是我把它的 2 个重复计数算错了。
       用列目录这种写法只是判据更直白，不依赖 pathspec 的通配细节。） */
  const out = execFileSync("git", ["ls-files", "scripts"], { cwd: ROOT, encoding: "utf8" });
  return [...new Set(out.split("\n").map((s) => s.trim())
    .filter((f) => f.endsWith(".mjs")))].sort();
}

const args = process.argv.slice(2);
const files = args.length ? args : tracked();

if (!files.length) {
  console.error("  没有找到可检查的 .mjs —— 空转不算通过。");
  process.exit(2);
}

let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    bad++;
    const msg = (r.stderr || "").split("\n").filter(Boolean).slice(0, 3).join(" | ");
    console.log("  FAIL  " + f + "\n        " + msg);
  }
}

console.log("\n──────────────────────────────");
console.log("  检查 " + files.length + " 个 .mjs ｜ 语法错误 " + bad + " 个");
console.log("  只做 node --check：未执行任何探针，未开浏览器、未起服务器、未联网。");
process.exit(bad ? 1 : 0);
