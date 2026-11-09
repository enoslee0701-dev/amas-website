// 官网可下载的目录 / 手册必须与官网一致（Enos 2026-11-05：以官网 68 门 · 5 项实践训练为准）。
import fs from "node:fs";
import { loadI18n, loadCourses, catalogHtml } from "./build-download-pdfs.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, info = "") => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (info ? " | " + info : "")); };
const I = loadI18n(), C = loadCourses();
const by = k => C.filter(x => x.cat === k).length;
ok("D1 官网课程卡片 68 门", C.length === 68, C.length);
ok("D2 七类门数 27/2/3/12/18/3/3", [by("nt"), by("ot"), by("bible"), by("theology"), by("ministry"), by("history"), by("tools")].join("/") === "27/2/3/12/18/3/3");
const bth = C.filter(x => x.level === "bth");
ok("D3 学士 27 门 · 70 学分", bth.length === 27 && bth.reduce((s, x) => s + x.credits, 0) === 70);
for (const l of ["zh", "en", "ko", "th"]) {
  const h = catalogHtml(l, I[l], C);
  const titles = C.every(x => h.includes(I[l][x.key + ".title"].replace(/&/g, "&amp;")));
  ok(`D4 ${l} 目录含全部 68 个课名`, titles);
  ok(`D8 ${l} 每门课都有简介`, C.every(x => I[l][x.key + ".body"]), C.filter(x => !I[l][x.key + ".body"]).map(x => x.code).join(" "));
  ok(`D5 ${l} 目录含 5 项实践训练`, [0, 1, 2, 3, 4].every(i => h.includes(I[l]["training." + i])) && !I[l]["training.5"]);
}
const stale = /67 ?(门|courses|과목|วิชา)|11 ?(项|practical trainings|개 실천|รายการ)|学习中心|Learning Centre|학습 센터|ศูนย์การเรียนเชียงใหม่/;
for (const l of ["zh", "en", "ko", "th"]) {
  const h = fs.readFileSync(`docs/handbook/handbook-${l}.html`, "utf8");
  ok(`D6 ${l} 手册没有旧数字 / 旧名称`, !stale.test(h), (h.match(stale) || [""])[0]);
  ok(`D7 ${l} 手册写 68`, /68/.test(h));
}
console.log(`\nDOWNLOAD PDFS: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
