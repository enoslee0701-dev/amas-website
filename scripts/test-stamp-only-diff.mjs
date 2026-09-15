#!/usr/bin/env node
/* check-stamp-only-diff.mjs 的正向 / 负向用例 —— 在一次性临时 git 仓库里验证，不碰真实仓库。

   每一种「混进了别的改动」都构造一个应当失败的场景，证明它真会失败；
   再构造「只改了戳」的场景证明它真会通过。

   不开浏览器、不联网；只写系统临时目录，结束即删。

   运行：node scripts/test-stamp-only-diff.mjs
   退出码：0 全部用例符合预期；1 有用例不符合预期。 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-stamp-only-diff.mjs");

const page = (stamp, body = "<p>正文</p>") =>
  `<!doctype html><html><head><link rel="stylesheet" href="assets/css/a.css?v=${stamp}">` +
  `<script src="assets/js/a.js?v=${stamp}"></script></head><body>${body}</body></html>\n`;
const S1 = "202609010000", S2 = "202609020000", S3 = "202609030000";

/* 每个用例：若干次提交（文件 → 内容；null = 删除），以及对第一次到最后一次提交的检查参数 */
const CASES = [
  {
    name: "只改了戳 → 通过，并列为只改缓存戳",
    commits: [{ "a.html": page(S1), "b.html": page(S1) }, { "a.html": page(S2), "b.html": page(S2) }],
    args: [], expect: 0, out: /只改缓存戳 2 个/,
  },
  {
    name: "戳 + 内容改动，且在预期名单里 → 通过",
    commits: [{ "a.html": page(S1), "b.html": page(S1) }, { "a.html": page(S2), "b.html": page(S2, "<p>改过</p>") }],
    args: ["--expect", "b.html"], expect: 0, out: /预期\s+b\.html/,
  },
  {
    name: "戳 + 内容改动，不在预期名单里 → 失败",
    commits: [{ "a.html": page(S1), "b.html": page(S1) }, { "a.html": page(S2, "<p>偷偷改了</p>"), "b.html": page(S2) }],
    args: [], expect: 1, out: /预期外\s+a\.html/,
  },
  {
    name: "戳改成畸形值（?v=abc）不算只改戳 → 失败",
    commits: [{ "a.html": page(S1) }, { "a.html": page(S1).replace(`a.css?v=${S1}`, "a.css?v=abc") }],
    args: [], expect: 1, out: /预期外\s+a\.html/,
  },
  {
    name: "戳位数不对（11 位）不算只改戳 → 失败",
    commits: [{ "a.html": page(S1) }, { "a.html": page("20260902000") }],
    args: [], expect: 1, out: /预期外\s+a\.html/,
  },
  {
    name: "新增的 HTML 不在名单里 → 失败",
    commits: [{ "a.html": page(S1) }, { "a.html": page(S2), "new.html": page(S2) }],
    args: [], expect: 1, out: /预期外\s+new\.html（A）/,
  },
  {
    name: "删除的 HTML 不在名单里 → 失败",
    commits: [{ "a.html": page(S1), "gone.html": page(S1) }, { "a.html": page(S2), "gone.html": null }],
    args: [], expect: 1, out: /预期外\s+gone\.html（D）/,
  },
  {
    name: "整段区间：中途加进内容又删掉 → 看起来只改了戳，通过（这正是要有 --per-commit 的原因）",
    commits: [{ "a.html": page(S1) }, { "a.html": page(S2, "<p>临时</p>") }, { "a.html": page(S3) }],
    args: [], expect: 0, out: /只改缓存戳 1 个/,
  },
  {
    name: "逐个提交：同一场景里那次临时改动藏不住 → 失败",
    commits: [{ "a.html": page(S1) }, { "a.html": page(S2, "<p>临时</p>") }, { "a.html": page(S3) }],
    args: ["--per-commit"], expect: 1, out: /预期外\s+a\.html/,
  },
  {
    name: "逐个提交：非 HTML 文件的改动单独列出、不计入判定 → 通过",
    commits: [{ "a.html": page(S1), "x.mjs": "1\n" }, { "a.html": page(S2), "x.mjs": "2\n" }],
    args: ["--per-commit"], expect: 0, out: /非 HTML（任务本身的文件，不计入判定）：x\.mjs/,
  },
  {
    name: "区间里没有任何改动 → 退出码 2（空转不算通过）",
    commits: [{ "a.html": page(S1) }, { "a.html": page(S1) }],
    args: [], expect: 2,
  },
];

let bad = 0;
for (const c of CASES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csc-stamp-diff-"));
  try {
    const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    g("init", "-q");
    g("config", "user.email", "fixture@example.invalid");
    g("config", "user.name", "fixture");
    g("config", "core.autocrlf", "false");
    g("config", "core.hooksPath", "/dev/null");
    const shas = [];
    for (const files of c.commits) {
      for (const [f, text] of Object.entries(files)) {
        if (text === null) fs.rmSync(path.join(dir, f));
        else fs.writeFileSync(path.join(dir, f), text);
      }
      g("add", "-A");
      g("commit", "-q", "--allow-empty", "-m", "fixture");
      shas.push(g("rev-parse", "HEAD"));
    }
    const r = spawnSync(process.execPath, [CHECKER, shas[0], shas[shas.length - 1], ...c.args],
      { encoding: "utf8", env: { ...process.env, CSC_STAMP_DIFF_CWD: dir } });
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
