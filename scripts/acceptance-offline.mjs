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
  self: {
    title: "入口自己的判定逻辑（全程离线，不开浏览器）",
    suites: ["acceptance-entry"],
  },
};

/* 已登记的既有基线失败：不是本轮引入，且**不得为绿而改断言**。
   见 shared-supervision/failures-web.jsonl。 */
/* 已登记的既有基线失败。
   **登记的是具体哪几条断言**，不是整个套件 —— 否则这个套件里将来新增的任何
   失败都会被一并豁免掉，等于给它开了一张长期免检。
   断言名取自 evidence/web-round17 的原始输出（逐字），只取 `|` 或 `←` 之前
   那一段，后面的实测数值每次都会变。 */
export const KNOWN_BASELINE_FAIL = {
  "touch-targets": {
    why: "18/20 —— 黄金值是 Windows 上记录的（64x27 vs macOS 66x25）；" +
         "启用前需监督决定是否另记一组平台基线。断言未改。",
    assertions: [
      "T0 负向控制：还原本轮 CSS 后，六个入口精确回到修复前实测的 64x27 / 52x25",
      "T5 跳转链接聚焦后出现在屏幕上、完整可见、且合格（>= 44x44）",
    ],
  },
};

/** 断言名的规范化：只做空白归一。
    每次都会变的实测数值在 `|` / `←` 之后，failedAssertions 已经把那一段切掉了；
    断言名里剩下的数字（例如黄金值 64x27）是名字的一部分，**不能抹掉** ——
    抹掉就会让 T0 和 T5 这种只差编号的断言互相冒充。 */
export const normalizeAssertion = (x) => String(x || "").replace(/\s+/g, " ").trim();

/** 从 stdout 里取出失败断言的名字。两种格式都认：
      「FAIL <名字> | <细节>」与「  FAIL  <名字>  ← <细节>」 */
export const failedAssertions = (out) =>
  String(out || "").split(/\r?\n/)
    .filter((l) => /^\s*FAIL\b/.test(l))
    .map((l) => l.replace(/^\s*FAIL\b[:\s]*/, ""))
    .map((l) => normalizeAssertion(l.split("  ← ")[0].split(" | ")[0]))
    .filter(Boolean);

/* 这些事情这支脚本**做不到**，谁也不要把全绿当成做到了。 */
const NOT_RUN = [
  "真实 Supabase Auth / RLS / Edge Function —— 全部用本地 stub 替身",
  "真实两步验证（真实 TOTP 因子、真实二维码、真实一次性码）",
  "真实邮件投递（SMTP 未配置；mailer_autoconfirm 待决，不由实现方决定）",
  "真实申请、审核、建档、撤回、学号纠错等任何写入真实数据的操作",
  "真机与生产环境",
];

/* 一份汇总只有自洽才算数：计数必须是非负整数，通过数加失败数要等于总数，
   而且总数不能是 0（一条断言都没跑过不叫通过）。
   「5/3 通过」这种不可能的总数会算出 fail = -2，`fail > 0` 就拦不住它。 */
const valid = (s) => {
  const int = (n) => Number.isInteger(n) && n >= 0;
  if (!int(s.pass) || !int(s.fail) || !int(s.total))
    return { ...s, valid: false, why: `计数不是非负整数（${s.text}）` };
  if (s.pass + s.fail !== s.total)
    return { ...s, valid: false, why: `通过数与失败数加起来不等于总数（${s.text}）` };
  if (s.total === 0)
    return { ...s, valid: false, why: "一条断言都没跑过" };
  return { ...s, valid: true, why: "" };
};

/* 汇总行两种形状都认：「PASS 33  FAIL 0」与「112/112 通过」。
   认不出来就如实写「未汇总」—— 不猜。 */
export const summarize = (out) => {
  const a = out.match(/PASS\s+(\d+)\s+FAIL\s+(\d+)/g);
  if (a && a.length) {
    const m = a[a.length - 1].match(/PASS\s+(\d+)\s+FAIL\s+(\d+)/);
    return valid({ pass: +m[1], fail: +m[2], total: +m[1] + +m[2],
                   text: `${m[1]}/${+m[1] + +m[2]}`, parsed: true });
  }
  /* 「18/20 通过」与「=== TOUCH TARGETS: 18/20 PASSED ===」是同一个意思。
     后一种有 13 个套件在用（public 整组、application-flow 等），原来两个正则
     都不认它 —— 它们的汇总一直是「未汇总」，只是当时 code===0 就判通过，
     所以没人看见。 */
  const b = out.match(/(\d+)\s*\/\s*(\d+)\s*(?:通过|PASSED)/gi);
  if (b && b.length) {
    const m = b[b.length - 1].match(/(\d+)\s*\/\s*(\d+)/);
    return valid({ pass: +m[1], fail: +m[2] - +m[1], total: +m[2],
                   text: `${m[1]}/${m[2]}`, parsed: true });
  }
  return { pass: null, fail: null, total: null, text: "未汇总", parsed: false,
           valid: false, why: "读不出汇总行" };
};

/** 一个套件跑完之后，凭它的退出码与 stdout 判定成什么状态。
    抽成纯函数是为了能用合成的 stdout/退出码验证判定本身，
    不必为了验一条判定去开六组浏览器。 */
export function classify(r, baselines) {
  const s = summarize(r.out || "");
  if (r.missing) return { ...s, state: "缺文件", reason: "scripts/test-<name>.mjs 不存在" };

  /* **任何分支都先要求一份成立的汇总。**
     跑到一半崩掉、改了输出格式、或者数字自相矛盾，都说明这一轮没有正常跑完 ——
     没正常跑完就什么都不能断言，既不能说通过，更不能拿既有基线去豁免它。 */
  if (!s.valid) {
    return { ...s, state: "未判定",
      reason: "没有一份成立的汇总（" + (s.why || "读不出汇总行") + "），这一轮没有正常跑完" };
  }

  if (r.code !== 0) {
    const reg = (baselines || {})[r.suite];
    if (reg && Array.isArray(reg.assertions)) {
      const known = reg.assertions.map(normalizeAssertion);
      const seen = failedAssertions(r.out);
      /* 规范化之后**整名精确相等**才算数。用前缀放行会让
         「<已登记的名字> NEW regression」这种新回归混进来。 */
      const unknown = seen.filter((a) => !known.includes(a));
      /* 还要对得上数：解析出来的失败条数必须等于汇总里报的失败数，
         否则说明有失败没被打印成我们认得的 FAIL 行，那就不能豁免。 */
      const counted = seen.length === s.fail;
      if (seen.length && unknown.length === 0 && counted) {
        const gone = known.filter((k) => !seen.includes(k));
        return { ...s, state: "既有基线",
          reason: "只复现了登记过的断言" + (gone.length ? "（其中 " + gone.length + " 条这次没有复现）" : "") };
      }
      return { ...s, state: "失败",
        reason: !seen.length ? "退出码非 0，但一条失败断言都解析不出来"
          : unknown.length ? "出现了没有登记的失败断言：" + unknown.slice(0, 3).join("；")
          : "解析到 " + seen.length + " 条失败断言，汇总却说挂了 " + s.fail + " 条，对不上" };
    }
    return { ...s, state: "失败", reason: "退出码 " + r.code };
  }

  /* 退出码 0，汇总也成立，但汇总自己报了失败 —— 两边矛盾，不算通过。 */
  if (s.fail > 0) return { ...s, state: "未判定", reason: "退出码 0，汇总却报了 " + s.fail + " 条失败" };
  return { ...s, state: "通过", reason: "" };
}
/** 哪些状态算这一轮没过。**未判定也算没过** —— 不明不能当成功。 */
export const isFailure = (state) =>
  state === "失败" || state === "缺文件" || state === "未判定";

/** 这一轮的结果能不能归属到某个 SHA：运行前后必须一模一样。
    跑到一半有人改了工作树或切了分支，这批数字就不属于任何一个 SHA。 */
const LOOKS_LIKE_SHA = (x) => /^[0-9a-f]{40}$/.test(String(x || ""));

export function attribution(before, after) {
  if (!before || !after) return { ok: false, reason: "没有可比对的前后状态" };
  if (before.ok === false || after.ok === false) {
    return { ok: false, reason: "读不到 git 状态（" +
      ((before.ok === false ? before.why : after.why) || "") + "），无法把结果归属到任何 SHA" };
  }
  if (!LOOKS_LIKE_SHA(before.head) || !LOOKS_LIKE_SHA(after.head)) {
    return { ok: false, reason: "HEAD 不是一个合法的 40 位 SHA（" + before.head + " / " + after.head +
      "），无法归属 —— 不能拿一个看起来干净的假状态当作某个提交" };
  }
  if (before.head !== after.head) {
    return { ok: false, reason: "运行当中 HEAD 变了（" + before.head + " → " + after.head +
      "），这一轮的结果不归属任何一个 SHA" };
  }
  if ((before.dirty || "") !== (after.dirty || "")) {
    return { ok: false, reason: "运行当中工作树被改动了，这一轮的结果不归属这个 SHA" };
  }
  /* 全程没变，但一直带着未提交的改动：那它对应的是「这个 SHA + 一堆改动」，
     同样不是这个 SHA。--allow-dirty 只是允许你跑，不是允许把结论挂到它头上。 */
  if (after.dirty) {
    return { ok: false, reason: "工作树带着未提交的改动，这一轮对应的是「" + after.head +
      " + 未提交改动」，不是那个 SHA 本身" };
  }
  return { ok: true, reason: "运行前后 HEAD 与工作树一致，且工作树干净" };
}

/* 被 import 时**什么都不跑** —— 上面那几个纯函数是给合成用例用的。
   整个命令行部分包在下面这个块里，import 时一行都不执行。 */
const AS_CLI = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (AS_CLI) {

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
/* 读不到就说读不到。原来失败时返回 { head:"(不是 git 仓库)", dirty:"" } ——
   一个**看起来干净**的假状态，attribution 会照单全收，把结果挂到一个
   根本不存在的 SHA 上。 */
const readGit = () => {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT }).toString().trim();
    if (!/^[0-9a-f]{40}$/.test(head)) {
      return { ok: false, head: null, dirty: null, why: "git rev-parse 没给出合法的 HEAD：" + head };
    }
    return { ok: true, head, dirty };
  } catch (e) {
    return { ok: false, head: null, dirty: null, why: "读不到 git 状态：" + ((e && e.message) || "") };
  }
};
const before = readGit();
if (!before.ok) {
  console.error(before.why);
  console.error("这支入口的全部意义就是把结论钉在一个确定的 SHA 上；读不到 HEAD 就没有可钉的东西。");
  process.exit(2);
}
const head = before.head, dirty = before.dirty;
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



const results = [];
for (const { suite, group } of planned) {
  process.stdout.write("  … " + suite.padEnd(26));
  const r = await runOne(suite);
  const c = classify({ suite, code: r.code, out: r.out, missing: r.missing }, KNOWN_BASELINE_FAIL);
  const s = { pass: c.pass, fail: c.fail, text: c.text };
  const state = c.state;
  results.push({ suite, group, code: r.code, ...s, state, ms: r.ms });
  console.log(state.padEnd(6) + " " + s.text.padStart(8) + "  " + (r.ms / 1000).toFixed(1) + "s");
  if (OUT) fs.writeFileSync(path.join(OUT, suite + ".txt"), r.out);
}

const failed = results.filter((r) => isFailure(r.state));
const baseline = results.filter((r) => r.state === "既有基线");
const undecided = results.filter((r) => r.state === "未判定");

/* 跑完再看一次：中途有人改了工作树或切了分支，这批数字就不属于那个 SHA。 */
const attr = attribution(before, readGit());

console.log("\n──────────────────────────────────────────────");
console.log("  通过      " + results.filter((r) => r.state === "通过").length + " 个套件");
if (baseline.length) {
  console.log("  既有基线  " + baseline.length + " 个（不是本轮引入，断言未改）");
  for (const b of baseline) {
    console.log("      " + b.suite + " —— " + (KNOWN_BASELINE_FAIL[b.suite] || {}).why);
    if (b.reason) console.log("        " + b.reason);
  }
}
if (undecided.length) {
  console.log("  未判定    " + undecided.length + " 个（**不算通过**）");
  for (const u of undecided) console.log("      " + u.suite + "  " + u.reason);
}
if (failed.length) {
  console.log("  没过      " + failed.length + " 个");
  for (const f of failed) console.log("      " + f.suite + "  exit=" + f.code + "  " + f.text +
    (f.reason ? "  —— " + f.reason : ""));
}

console.log("\n这一轮**没有**验证以下任何一项（全绿也不代表它们可用）：");
for (const n of NOT_RUN) console.log("  · " + n);

if (attr.ok) {
  console.log("\n以上结论只对 SHA " + head + " 成立。");
} else {
  console.log("\n⚠ 这一轮的结果**不归属任何 SHA**：" + attr.reason);
  console.log("  上面这些数字可以看，但不能当作某个提交的验收结论。请在干净的树上重跑。");
}

if (OUT) {
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({
    head, dirty: !!dirty, attribution: attr, groups: pickGroups, chrome: CHROME,
    at: new Date().toISOString(), results, known_baseline_fail: KNOWN_BASELINE_FAIL, not_run: NOT_RUN,
  }, null, 2) + "\n");
  console.log("完整日志与 summary.json 已落在 " + OUT);
}

process.exit(failed.length || !attr.ok ? 1 : 0);

}   // ← if (AS_CLI)
