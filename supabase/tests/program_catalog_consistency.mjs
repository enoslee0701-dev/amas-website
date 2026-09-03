// D-2 一致性守卫：官网 Quick Apply 的项目下拉必须与 program_catalog 完全一致。
//
// 背景：招生项目清单曾在官网 index.html、Portal 申请表、Word 申请表三处各自 hard-code。
// 现以 program_catalog 表为唯一权威清单（优先级阶梯级别 2）；Portal 申请表已改为从该表读取，
// 官网首页是纯静态营销页、不引入 Supabase 运行时依赖，故改用本测试把它钉在权威清单上——
// 任何一侧改动而另一侧没跟上，测试立刻失败。
//
// 运行：AMAS_ENV=staging.env node supabase/tests/program_catalog_consistency.mjs

import fs from "node:fs";

const ENV = Object.fromEntries(fs.readFileSync(process.env.AMAS_ENV || "staging.env", "utf8")
  .trim().split("\n").map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const results = [];
const rec = (id, name, ok, detail = "") => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${detail ? " | " + detail : ""}`);
};

// ---- 1. 权威清单 ----
const r = await fetch(`${ENV.URL}/rest/v1/program_catalog?select=code,name_zh,is_open_for_application,sort_order&order=sort_order`,
  { headers: { apikey: ENV.ANON, Authorization: `Bearer ${ENV.ANON}` } });
const catalog = await r.json();
rec("D2-01", "program_catalog 可匿名读取", Array.isArray(catalog) && catalog.length > 0, `rows=${catalog.length}`);

const active = catalog.filter(p => p.is_open_for_application !== false);
const catCodes = active.map(p => p.code);

// ---- 2. 官网 Quick Apply 下拉 ----
const html = fs.readFileSync("index.html", "utf8");
const sel = html.match(/<select name="program"[\s\S]*?<\/select>/);
rec("D2-02", "官网 Quick Apply 存在项目下拉", !!sel);

const siteCodes = sel ? [...sel[0].matchAll(/<option value="([^"]+)"/g)].map(m => m[1]).filter(Boolean) : [];
rec("D2-03", "官网项目清单与 program_catalog 开放项目完全一致（含顺序）",
  JSON.stringify(siteCodes) === JSON.stringify(catCodes),
  `site=[${siteCodes.join(",")}] catalog=[${catCodes.join(",")}]`);

// ---- 3. Portal 申请表不得再 hard-code 项目 ----
// 注意：学习路径（PATHWAYS）的取值之一也叫 "bth"，与项目代码同名但是不同概念，
// 故先剔除 PATHWAYS 声明再检查，避免把路径误判成 hard-code 的项目清单。
const formJs = fs.readFileSync("assets/js/portal/application-form.js", "utf8")
  .replace(/const PATHWAYS\s*=\s*\[[\s\S]*?\];/, "");
const hard = catCodes.filter(c => new RegExp(`["']${c}["']`).test(formJs));
rec("D2-04", "Portal 申请表不再 hard-code 项目代码", hard.length === 0, `found=[${hard.join(",")}]`);

// ---- 4. 每个项目都有四语言文案（官网 i18n）----
const main = fs.readFileSync("assets/js/main.js", "utf8");
const missing = catCodes.filter(c => (main.match(new RegExp(`"application\\.programs\\.${c}"`, "g")) || []).length < 4);
rec("D2-05", "每个项目均有四语言文案", missing.length === 0, `missing=[${missing.join(",")}]`);

// ---- 5. 招生项目目录不得混入 67 门课程 ----
const looksLikeCourse = active.filter(p => /^(BT|CH|TH|MI|PT|BS|SF)\d/i.test(p.code));
rec("D2-06", "项目目录未混入课程代码", looksLikeCourse.length === 0, `suspects=[${looksLikeCourse.map(p => p.code).join(",")}]`);

const pass = results.filter(x => x.ok).length;
console.log(`\n=== D-2 一致性: ${pass}/${results.length} PASSED ===`);
if (pass !== results.length) process.exitCode = 1;
