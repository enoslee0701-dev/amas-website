#!/usr/bin/env node
/* 探针的「不碰真实后端」防线检查（INCIDENT-0916 之后补）。

   背景：开发机上的 assets/js/supabase-config.local.js 常是真实配置；探针的本机服务器若照常伺服它，
   页面就在 127.0.0.1 上经本地旁路拿到真实 url / anonKey，表单一提交就写进真实 Supabase。
   2026-09-16 实测 test-chat-timeout / test-giving-submit 发出了指向真实项目 /rest/v1/submissions 的请求。

   两道独立防线，这里逐一核对：
     L1  每个带本机 http 服务器的脚本，在读磁盘之前调用 refuseLocalConfig（lib/no-local-config.mjs）
         —— 例外只有下面 ALLOW 里写明理由的三个，且各自的理由也要被核实
     L2  lib/chrome-launcher.mjs 把 *.supabase.co / *.supabase.in 钉到 0.0.0.0，并与已有规则合并成**一个**旗标；
         不走启动器、自己 spawn Chrome 的脚本，必须自带同样的规则（伺服内置页面、不读仓库的除外）
   外加单元与实跑：refuseLocalConfig 的路径判定；withBackendBlock 的合并；
   起一个真服务器、磁盘上**确实放着** local 文件，请求它仍然拿到 404。

   只读源码 + 本机回环上的一次性服务器；不开浏览器、不联网、只写系统临时目录并删除。

   运行：node scripts/test-probe-network-guard.mjs
   退出码：0 全部符合；1 有不符合。 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refuseLocalConfig } from "./lib/no-local-config.mjs";
import { withBackendBlock, BACKEND_BLOCK_RULES } from "./lib/chrome-launcher.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  ← " + d : "")); } };

/* 例外：每一条都写理由，并附一个核实理由成立的判据 */
const ALLOW = {
  "scripts/test-local-config-override.mjs": {
    why: "测的就是旁路规则本身；伺服的是复制出来的镜像目录，里面放的是它自己写的假 local 文件",
    verify: (s) => /const MIRROR = fs\.mkdtempSync/.test(s) && /path\.join\(MIRROR, p\)/.test(s) && !/path\.join\(ROOT, p\)/.test(s),
  },
  "scripts/test-noconfig-degraded.mjs": {
    why: "在读磁盘之前自行接管 local 路径（404 或非秘密占位模板）",
    verify: (s) => { const i = s.indexOf("if (p === LOCAL_CFG_PATH)"), j = s.indexOf("path.join(ROOT, p)"); return i > -1 && j > i; },
  },
  "scripts/diag-dialog-hang.mjs": {
    why: "服务器只回一段内置 HTML，不读仓库文件",
    verify: (s) => /res\.end\(PAGE\)/.test(s) && !/path\.join\(ROOT/.test(s),
  },
};

console.log("=== L1 本机服务器不伺服 supabase-config.local.js ===");
const servers = execFileSync("git", ["ls-files", "--", "scripts/*.mjs"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => /createServer\(/.test(SRC(f)));
ok("L1-0 前提：找到带 http 服务器的脚本（" + servers.length + " 个）", servers.length > 10, String(servers.length));
const missing = [], misplaced = [], allowBad = [];
for (const f of servers) {
  const s = SRC(f);
  if (ALLOW[f]) { if (!ALLOW[f].verify(s)) allowBad.push(f); continue; }
  const call = s.search(/if \(refuseLocalConfig\(\w+, res\)\) return;/);
  if (call < 0 || !/import \{ refuseLocalConfig \} from "\.\/lib\/no-local-config\.mjs";/.test(s)) { missing.push(f); continue; }
  const decode = s.search(/decodeURIComponent\(req\.url/);
  const disk = s.search(/path\.join\((ROOT|MIRROR),\s*p\)/);
  if (!(decode > -1 && call > decode && (disk < 0 || call < disk))) misplaced.push(f);
}
ok("L1-1 每个服务器都在读磁盘之前调用 refuseLocalConfig", missing.length === 0, JSON.stringify(missing));
ok("L1-2 调用位置在解码之后、读磁盘之前", misplaced.length === 0, JSON.stringify(misplaced));
ok("L1-3 例外清单里的每一条理由都核实成立", allowBad.length === 0, JSON.stringify(allowBad.map((f) => f + "：" + ALLOW[f].why)));
const staleAllow = Object.keys(ALLOW).filter((f) => !servers.includes(f));
ok("L1-4 例外清单里没有已经不存在的条目", staleAllow.length === 0, JSON.stringify(staleAllow));

console.log("\n=== L2 后端域名钉死 ===");
const launcher = SRC("scripts/lib/chrome-launcher.mjs");
ok("L2-1 启动器用 withBackendBlock 处理 extraArgs", /\.\.\.withBackendBlock\(opts\.extraArgs\)/.test(launcher));
const cases = [
  ["没有任何规则 → 补一个", [], (o) => o.filter((a) => a.startsWith("--host-resolver-rules=")).length === 1 && o.includes("--host-resolver-rules=" + BACKEND_BLOCK_RULES)],
  ["已有 formsubmit 规则 → 合并进同一个旗标，原规则保留", ["--host-resolver-rules=MAP formsubmit.co 0.0.0.0", "--disable-gpu"],
    (o) => o.filter((a) => a.startsWith("--host-resolver-rules=")).length === 1 && /formsubmit\.co/.test(o[0]) && /supabase\.co/.test(o[0]) && /supabase\.in/.test(o[0]) && o[1] === "--disable-gpu"],
  ["已含两条 supabase 规则 → 原样不动", ["--host-resolver-rules=MAP *.supabase.co 0.0.0.0, MAP *.supabase.in 0.0.0.0"],
    (o) => o.length === 1 && o[0] === "--host-resolver-rules=MAP *.supabase.co 0.0.0.0, MAP *.supabase.in 0.0.0.0"],
  ["不改动调用方传入的数组", null, () => { const a = ["--x"]; withBackendBlock(a); return a.length === 1; }],
];
for (const [name, input, check] of cases) {
  const out = input ? withBackendBlock(input) : null;
  ok("L2-2 " + name, check(out), JSON.stringify(out));
}
const direct = execFileSync("git", ["ls-files", "--", "scripts/*.mjs"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => { const s = SRC(f); return /spawn\(\s*CHROME\b/.test(s) && !/launchOwnChrome/.test(s); });
const directBad = direct.filter((f) => !ALLOW[f] && !/MAP \*\.supabase\.co 0\.0\.0\.0/.test(SRC(f)));
ok("L2-3 自己 spawn Chrome 的脚本（" + direct.length + " 个）都自带 supabase 钉死规则（伺服内置页面的除外）", directBad.length === 0, JSON.stringify(directBad));

console.log("\n=== L3 refuseLocalConfig 判定与实跑 ===");
const fakeRes = () => { const r = { code: 0, body: "" }; r.writeHead = (c) => { r.code = c; }; r.end = (b) => { r.body = b; }; return r; };
for (const [p, want] of [["/assets/js/supabase-config.local.js", true], ["/sub/dir/assets/js/supabase-config.local.js", true],
  ["/assets/js/SUPABASE-CONFIG.LOCAL.JS", true], ["/assets/js/supabase-config.js", false], ["/assets/js/supabase-config.local.example.js", false], ["/", false]]) {
  const r = fakeRes();
  const got = refuseLocalConfig(p, r);
  ok(`L3-1 ${p} → ${want ? "拒绝（404）" : "放行"}`, got === want && (want ? r.code === 404 : r.code === 0), JSON.stringify({ got, code: r.code }));
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csc-guard-"));
  try {
    fs.mkdirSync(path.join(dir, "assets/js"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets/js/supabase-config.local.js"), 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};');
    fs.writeFileSync(path.join(dir, "assets/js/supabase-config.js"), "window.SUPA={url:'',anonKey:''};");
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split("?")[0]);
      if (refuseLocalConfig(p, res)) return;
      const abs = path.join(dir, p);
      if (!fs.existsSync(abs)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200); fs.createReadStream(abs).pipe(res);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const a = await fetch(base + "/assets/js/supabase-config.local.js");
    const b = await fetch(base + "/assets/js/supabase-config.js");
    server.close();
    ok("L3-2 实跑：磁盘上确实有 local 文件，请求它仍是 404、拿不到内容", a.status === 404 && !/abcdefghijklmnopqrst/.test(await a.text()), String(a.status));
    ok("L3-3 对照：同一个服务器照常伺服 supabase-config.js（证明不是整台服务器都坏了）", b.status === 200, String(b.status));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  只读源码 + 本机回环一次性服务器：未开浏览器、未联网。");
process.exit(fail ? 1 : 0);
