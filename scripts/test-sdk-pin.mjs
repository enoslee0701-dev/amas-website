/* Supabase SDK 的版本钉死（web-gap-review B5）。
   全程离线：只读仓库里的文件，不开浏览器、不联网、不安装任何东西。

   为什么这件事要有检查：
     本仓 push 即发布（GitHub Pages 从 master 直发，无构建、无门禁）。
     22 个公开入口如果吃的是浮动大版本 `@supabase/supabase-js@2`，
     上游发一个小版本就可能**在没有任何提交的情况下**改变线上行为 ——
     而 auth.js 与 portal/mfa 里那些判据（错误类、事件名、qr_code 是 data URI、
     listFactors().totp 只含已验证因子…）都是对着某一个确切版本的产物核出来的。
     代码声称依据的版本，和页面实际加载的版本，必须是同一个。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  ← " + detail : "")); }
};

/** 递归收集 html，跳过不属于站点的目录 */
const SKIP = new Set(["node_modules", ".git", "supabase", "docs", "scripts"]);
function htmlFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) htmlFiles(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

const SDK_RE = /https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@([^/"']+)\/dist\/umd\/supabase\.min\.js/g;
/** 浮动写法：@2、@^2、@latest、@2.x —— 只要不是完整的 x.y.z 就算浮动 */
const isPinned = (v) => /^\d+\.\d+\.\d+$/.test(v);

const files = htmlFiles(ROOT);
const loaders = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const vs = [...text.matchAll(SDK_RE)].map((m) => m[1]);
  if (vs.length) loaders.push({ rel: path.relative(ROOT, f).replace(/\\/g, "/"), text, versions: vs });
}

console.log("\n=== S SDK 版本钉死 ===");
ok("S0 前提：确实扫到了载入 SDK 的页面（不是空跑变绿）", loaders.length > 0, "扫到 " + loaders.length + " 个");

const floating = loaders.filter((l) => l.versions.some((v) => !isPinned(v)));
ok("S1 没有页面吃浮动大版本", floating.length === 0,
   floating.slice(0, 5).map((l) => l.rel + " → @" + l.versions.join("/")).join("；"));

const all = [...new Set(loaders.flatMap((l) => l.versions))];
ok("S2 所有入口钉在**同一个**版本上", all.length === 1, JSON.stringify(all));

/* 代码里声称依据的版本：auth.js 与 portal/mfa 的注释逐条写着是对着哪一版核的。
   这两处目前只出现一个 x.y.z，正好可以当作那个声称值。 */
const claimSrc = ["assets/js/portal/auth.js", "portal/mfa/index.html"]
  .map((r) => fs.readFileSync(path.join(ROOT, r), "utf8")).join("\n");
const claimed = [...new Set([...claimSrc.matchAll(/\b(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]))];
ok("S3-0 前提：代码里声称的依据版本是唯一的", claimed.length === 1, JSON.stringify(claimed));
ok("S3 页面实际加载的版本 == 代码声称核对过的版本",
   claimed.length === 1 && all.length === 1 && claimed[0] === all[0],
   "声称 " + JSON.stringify(claimed) + " / 实际 " + JSON.stringify(all));

/* 顺序：auth.js 在加载时就读 window.supabase 与 window.SUPA 决定 CONFIG_STATE，
   所以 SDK 必须排在它前面。admin.html 不走 auth.js，不在这条约束里。 */
const order = loaders.filter((l) => l.text.includes("portal/auth.js"))
  .filter((l) => {
    const sdk = l.text.search(SDK_RE);
    const auth = l.text.indexOf("portal/auth.js");
    return !(sdk > -1 && auth > -1 && sdk < auth);
  });
ok("S4 每个用 auth.js 的页面，SDK 都排在它前面", order.length === 0,
   order.map((l) => l.rel).join("；"));

/* 对照：把浮动写法喂给同一套判据，必须被认出来 —— 否则上面那几条可能是空转。 */
const probe = `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>`;
const probeV = [...probe.matchAll(SDK_RE)].map((m) => m[1]);
ok("S5 对照：浮动写法能被这套判据认出来", probeV.length === 1 && !isPinned(probeV[0]), JSON.stringify(probeV));

console.log(`\n  PASS ${pass}  FAIL ${fail}`);
console.log("本套件只读仓库文件：未联网、未下载、未安装、未开浏览器。");
console.log("**它验不了的**：被钉的那个 URL 在真实 CDN 上能不能取到 —— 那要一次真实网络请求，不在本套件范围内。");
process.exit(fail ? 1 : 0);
