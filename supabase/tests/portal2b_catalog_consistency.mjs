// PORTAL-2B · 课程目录三方一致性守卫
//
// 67 门正式课程在三个地方出现：
//   1. App  services/catalog.ts → OFFICIAL_CATALOG   ← 唯一权威源
//   2. 官网 index.html 的 67 张课程卡                ← 展示副本
//   3. Supabase course_catalog                        ← 门户只读镜像
// 任一侧漂移，这里立刻失败。改课程只能改 (1)，再重新生成 (3)。
//
// 运行：AMAS_ENV=<path>/staging.env node supabase/tests/portal2b_catalog_consistency.mjs
// 可用 AMAS_APP_DIR 覆盖 App 仓库路径。

import fs from "node:fs";
import path from "node:path";

const ENV = Object.fromEntries(fs.readFileSync(process.env.AMAS_ENV || "staging.env", "utf8")
  .trim().split(/\r?\n/).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const APP_DIR = process.env.AMAS_APP_DIR
  || "C:/Users/enosl/Desktop/amas---asian-missionary-theological-seminary";
const SITE_DIR = process.env.AMAS_SITE_DIR || ".";

const R = [];
const rec = (id, name, ok, d = "") => { R.push({ id, name, ok, d }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${d ? " | " + d : ""}`); };

// ---- 1. 权威源：App OFFICIAL_CATALOG ----
const catPath = path.join(APP_DIR, "services/catalog.ts");
if (!fs.existsSync(catPath)) {
  rec("C00", "找到 App 课程权威源", false, `缺少 ${catPath}（可用 AMAS_APP_DIR 指定）`);
  console.log(`\n=== 目录一致性: 0/1 PASSED ===`);
  process.exit(1);
}
const catSrc = fs.readFileSync(catPath, "utf8");
const body = catSrc.slice(catSrc.indexOf("export const OFFICIAL_CATALOG"));
const app = [...body.matchAll(/\{\s*id:\s*'([^']+)',\s*title:\s*'([^']+)',\s*category:\s*(\w+)([^}]*)\}/g)]
  .map(m => ({
    id: m[1], title: m[2], cat: m[3],
    lessons: /totalLessons:\s*(\d+)/.exec(m[4]) ? +/totalLessons:\s*(\d+)/.exec(m[4])[1] : 0,
  }));
rec("C01", "App 权威目录恰好 67 门", app.length === 67, `count=${app.length}`);

// ---- 2. Supabase 镜像 ----
const res = await fetch(`${ENV.URL}/rest/v1/course_catalog?select=code,title_zh,category,total_lessons,availability,credits&order=sort_order`,
  { headers: { apikey: ENV.ANON, Authorization: `Bearer ${ENV.ANON}` } });
const mirror = await res.json();
rec("C02", "Supabase 镜像可匿名读取且为 67 门",
  Array.isArray(mirror) && mirror.length === 67, `count=${Array.isArray(mirror) ? mirror.length : "err"}`);

// ---- 3. code 与顺序完全一致 ----
const appIds = app.map(a => a.id);
const mirIds = (mirror || []).map(m => m.code);
rec("C03", "镜像的 code 与顺序同权威源完全一致",
  JSON.stringify(appIds) === JSON.stringify(mirIds),
  JSON.stringify(appIds) === JSON.stringify(mirIds) ? "" :
    `first-diff=${appIds.findIndex((v, i) => v !== mirIds[i])}`);

// ---- 4. 标题一致 ----
const titleDiff = app.filter((a, i) => (mirror[i] || {}).title_zh !== a.title)
  .map(a => a.id);
rec("C04", "镜像标题与权威源一致", titleDiff.length === 0, `diff=${titleDiff.join(",")}`);

// ---- 5. availability 由 totalLessons 推导且一致 ----
const availDiff = app.filter((a, i) => {
  const want = a.lessons > 0 ? "available" : "in_development";
  return (mirror[i] || {}).availability !== want;
}).map(a => a.id);
rec("C05", "内容可用性与权威源一致", availDiff.length === 0, `diff=${availDiff.join(",")}`);

// ---- 6. credits 必须全 null ----
const withCredits = (mirror || []).filter(m => m.credits !== null);
rec("C06", "镜像 credits 全为 null（未推算学分）", withCredits.length === 0,
  `hits=${withCredits.map(m => m.code).join(",")}`);

// ---- 7. 官网课程卡数量与标题 ----
const html = fs.readFileSync(path.join(SITE_DIR, "index.html"), "utf8");
const cards = [...html.matchAll(/<span class="course-code">([^<]+)<\/span><h3 data-i18n="courseCards\.(\d+)\.title">([^<]+)<\/h3>/g)]
  .map(m => ({ code: m[1].trim(), title: m[3].trim() }));
rec("C07", "官网课程卡恰好 67 张", cards.length === 67, `count=${cards.length}`);

const appTitles = new Set(app.map(a => a.title));
const siteOnly = cards.map(c => c.title).filter(t => !appTitles.has(t));
// D-2B-2 已拍板：canonical 名称为「世界观」，官网的「世界观理解」是漂移、已修复。
// 因此这里不再保留任何例外——今后官网与权威源的任何差异都直接失败。
rec("C08", "官网课程名称与权威源完全一致（无例外）", siteOnly.length === 0,
  `drift=${siteOnly.join(" / ") || "—"}`);

// ---- 8. 分类计数 ----
const catCount = (mirror || []).reduce((a, m) => (a[m.category] = (a[m.category] || 0) + 1, a), {});
const EXPECT = { nt: 27, ot: 2, bible_basics: 3, theology: 11, practical: 18, history: 3, language: 3 };
const catOk = Object.entries(EXPECT).every(([k, v]) => catCount[k] === v);
rec("C09", "七大类计数 27/2/3/11/18/3/3", catOk, JSON.stringify(catCount));

// ---- 9. 匿名不可写 ----
const w = await fetch(`${ENV.URL}/rest/v1/course_catalog`, {
  method: "POST",
  headers: { apikey: ENV.ANON, Authorization: `Bearer ${ENV.ANON}`, "Content-Type": "application/json" },
  body: JSON.stringify({ code: "c_hack", title_zh: "伪造", category: "nt" }),
});
rec("C10", "匿名不可写课程目录", w.status >= 400, `status=${w.status}`);

const pass = R.filter(r => r.ok).length;
console.log(`\n=== 目录一致性: ${pass}/${R.length} PASSED ===`);
if (pass !== R.length) process.exitCode = 1;
