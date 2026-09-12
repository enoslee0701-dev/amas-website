#!/usr/bin/env node
/* AMAS Web · 离线验收入口（单一入口，固定 SHA）
   ─────────────────────────────────────────────────────────────────────────
   这支脚本本身**不做任何判断**，它只负责：
     1. 把工作树钉在一个确定的 SHA 上（脏了就拒绝跑，否则「固定 SHA」没有意义）；
     2. 按组、串行地跑各个离线套件（每个套件自己独占动态端口与独立 profile）；
     3. 把每个套件的退出码、用时、汇总行记下来；
     4. 把 NOT_RUN 的边界原样打出来 —— 全绿**不代表可以上线**。

   它不改源码、不写任何真实数据、不连任何真实服务，也不自行安装依赖。
   已登记的既有基线失败（KNOWN_BASELINE_FAIL）会如实列出并计入「基线」一栏，
   既不冒充通过，也不把整轮判红 —— 是否接受由监督决定。

   用法：
     node scripts/acceptance-offline.mjs --list
     node scripts/acceptance-offline.mjs --group smoke
     node scripts/acceptance-offline.mjs --group portal
     node scripts/acceptance-offline.mjs                  # 全部组
     node scripts/acceptance-offline.mjs --allow-dirty    # 明知工作树脏也要跑
   环境：
     CHROME_PATH 或 CHROME 指向浏览器可执行文件（不会去连任何既有浏览器实例）
     OUT=<目录> 落盘每个套件的完整日志与 summary.json
*/
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 组的划分对应「原始需求的哪一块」，不是按文件名凑的。
   suite 名即 scripts/test-<name>.mjs。 */
const GROUPS = {
  smoke: {
    title: "冒烟：入口守卫 + 门户页渲染",
    suites: ["role-guard", "portal-pages"],
  },
  identity: {
    title: "身份与会话（blueprint §角色/会话；收口 c5f3ed6 · b0241ba）",
    suites: ["portal-session", "session-unknown", "aal-unknown", "callback-roles",
             "next-roundtrip", "role-guard", "login-errors", "forgot-password", "recovery-flow"],
  },
  mfa: {
    title: "两步验证客户端流程（真实因子一律 NOT_RUN）",
    suites: ["mfa-enroll"],
  },
  portal: {
    title: "门户页面与降级（读不到 ≠ 没有）",
    suites: ["portal-pages", "portal-degraded", "read-failures", "applicant-home"],
  },
  writes: {
    title: "不可逆写入与结果判据（招生 / 学籍 / 申请 / 资料）",
    suites: ["admin-writes", "admin-overview-writes", "applicant-writes",
             "profile-writes", "application-flow"],
  },
  public: {
    title: "公开站（非门户）",
    suites: ["header-layout", "header-touch", "contact-footer", "course-search", "course-cta",
             "discover-flow", "discover-detail-flow", "discover-back-link", "promo-tab",
             "giving-help-flow", "giving-submit", "register-signup", "announce-a11y",
             "drawer-a11y", "overlay-touch", "pages-touch", "resource-delivery",
             "resource-wait", "upload-flow", "chat-timeout", "touch-targets"],
  },
  harness: {
    title: "测试设施自身（独占端口/独立 profile 的前提）",
    suites: ["chrome-launcher", "local-config-override"],
  },
};

/* 已登记的既有基线失败：不是本轮引入，且**不得为绿而改断言**。
   见 shared-supervision/failures-web.jsonl。 */
const KNOWN_BASELINE_FAIL = {
  "touch-targets": "18/20 —— 黄金值是 Windows 上记录的（64x27 vs macOS 66x25）；" +
                   "启用前需监督决定是否另记一组平台基线",
};

/* 这些事情这支脚本**做不到**，谁也不要把全绿当成做到了。 */
const NOT_RUN = [
  "真实 Supabase Auth / RLS / Edge Function —— 全部用本地 stub 替身",
  "真实两步验证（真实 TOTP 因子、真实二维码、真实一次性码）",
  "真实邮件投递（SMTP 未配置；mailer_autoconfirm 待决，不由实现方决定）",
  "真实申请、审核、建档、撤回、学号纠错等任何写入真实数据的操作",
  "真机与生产环境",
];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : null; };

if (has("--list")) {
  for (const [k, g] of Object.entries(GROUPS)) {
    console.log(`\n${k}  —— ${g.title}`);
    for (const s of g.suites) console.log("    scripts/test-" + s + ".mjs");
  }
  process.exit(0);
}

// ── 1. 把这一轮钉在一个确定的 SHA 上
let head = "(不是 git 仓库)", dirty = "";
try {
  head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
  dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT }).toString().trim();
} catch (e) {}
if (dirty && !has("--allow-dirty")) {
  console.error("工作树有未提交的改动，这一轮就不是「固定 SHA 的验收」了：\n" + dirty);
  console.error("\n要么先提交，要么明确加 --allow-dirty（那样得到的结论不能当作某个 SHA 的验收）。");
  process.exit(2);
}

const CHROME = process.env.CHROME_PATH || process.env.CHROME;
if (!CHROME || !fs.existsSync(CHROME)) {
  console.error("没有可用的浏览器：请把 CHROME_PATH 指向可执行文件。");
  console.error("本入口只使用它自己启动的实例（独占动态端口 + 独立 profile），不会连接任何既有浏览器。");
  process.exit(2);
}

const pickGroups = valOf("--group") ? [valOf("--group")] : Object.keys(GROUPS);
for (const g of pickGroups) if (!GROUPS[g]) { console.error("没有这个组：" + g); process.exit(2); }

const OUT = process.env.OUT || null;
if (OUT) fs.mkdirSync(OUT, { recursive: true });

// 同一个套件被多个组引用时只跑一次
const planned = [];
for (const g of pickGroups) for (const s of GROUPS[g].suites)
  if (!planned.some((p) => p.suite === s)) planned.push({ suite: s, group: g });

console.log("AMAS Web · 离线验收入口");
console.log("  SHA        " + head + (dirty ? "  ⚠ 工作树脏（--allow-dirty）" : ""));
console.log("  组         " + pickGroups.join(", "));
console.log("  套件       " + planned.length + " 个（串行，每个自带独占动态端口与独立 profile）");
console.log("  浏览器     " + CHROME);
console.log("");

const runOne = (suite) => new Promise((resolve) => {
  const file = path.join(ROOT, "scripts", "test-" + suite + ".mjs");
  if (!fs.existsSync(file)) return resolve({ suite, code: 127, out: "", ms: 0, missing: true });
  const t0 = Date.now();
  const p = spawn(process.execPath, [file], {
    cwd: ROOT,
    env: { ...process.env, CHROME_PATH: CHROME, CHROME },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("close", (code) => resolve({ suite, code, out, ms: Date.now() - t0 }));
});

/* 汇总行两种形状都认：「PASS 33  FAIL 0」与「112/112 通过」。
   认不出来就如实写「未汇总」—— 不猜。 */
const summarize = (out) => {
  const a = out.match(/PASS\s+(\d+)\s+FAIL\s+(\d+)/g);
  if (a && a.length) {
    const m = a[a.length - 1].match(/PASS\s+(\d+)\s+FAIL\s+(\d+)/);
    return { pass: +m[1], fail: +m[2], text: `${m[1]}/${+m[1] + +m[2]}` };
  }
  const b = out.match(/(\d+)\/(\d+)\s*通过/g);
  if (b && b.length) {
    const m = b[b.length - 1].match(/(\d+)\/(\d+)/);
    return { pass: +m[1], fail: +m[2] - +m[1], text: `${m[1]}/${m[2]}` };
  }
  return { pass: null, fail: null, text: "未汇总" };
};

const results = [];
for (const { suite, group } of planned) {
  process.stdout.write("  … " + suite.padEnd(26));
  const r = await runOne(suite);
  const s = summarize(r.out);
  const baseline = Object.prototype.hasOwnProperty.call(KNOWN_BASELINE_FAIL, suite);
  const state = r.missing ? "缺文件" : r.code === 0 ? "通过" : baseline ? "既有基线" : "失败";
  results.push({ suite, group, code: r.code, ...s, state, ms: r.ms });
  console.log(state.padEnd(6) + " " + s.text.padStart(8) + "  " + (r.ms / 1000).toFixed(1) + "s");
  if (OUT) fs.writeFileSync(path.join(OUT, suite + ".txt"), r.out);
}

const failed = results.filter((r) => r.state === "失败" || r.state === "缺文件");
const baseline = results.filter((r) => r.state === "既有基线");

console.log("\n──────────────────────────────────────────────");
console.log("  通过      " + results.filter((r) => r.state === "通过").length + " 个套件");
if (baseline.length) {
  console.log("  既有基线  " + baseline.length + " 个（不是本轮引入，断言未改）");
  for (const b of baseline) console.log("      " + b.suite + " —— " + KNOWN_BASELINE_FAIL[b.suite]);
}
if (failed.length) {
  console.log("  失败      " + failed.length + " 个");
  for (const f of failed) console.log("      " + f.suite + "  exit=" + f.code + "  " + f.text);
}

console.log("\n这一轮**没有**验证以下任何一项（全绿也不代表它们可用）：");
for (const n of NOT_RUN) console.log("  · " + n);
console.log("\n以上结论只对 SHA " + head + " 成立" + (dirty ? "（且工作树是脏的）" : "") + "。");

if (OUT) {
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({
    head, dirty: !!dirty, groups: pickGroups, chrome: CHROME,
    at: new Date().toISOString(), results, known_baseline_fail: KNOWN_BASELINE_FAIL, not_run: NOT_RUN,
  }, null, 2) + "\n");
  console.log("完整日志与 summary.json 已落在 " + OUT);
}

process.exit(failed.length ? 1 : 0);
