// 官网学士班课程与可下载的目录 / 手册必须一致。
// 2026-11-27 Enos：官网只展示学士班 B.Th，课程照搬《mdiv课程设置.docx》——必修 35 门 96 学分、选修 13 门、实践训练 11 项，毕业 100 学分；
// 原 68 门收进 <template id="courseArchive"> 暂时隐藏；硕士 / 博士学分不显示。数据源 scripts/data/bth-curriculum.json。
import fs from "node:fs";
import { loadI18n, loadCourses, catalogHtml } from "./build-download-pdfs.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, info = "") => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (info ? " | " + info : "")); };
const I = loadI18n(), C = loadCourses(), D = JSON.parse(fs.readFileSync("scripts/data/bth-curriculum.json", "utf8"));
const html = fs.readFileSync("index.html", "utf8");
const req = C.filter(x => x.kind === "required"), ele = C.filter(x => x.kind === "elective");
ok("D1 官网显示必修 35 + 选修 13", req.length === 35 && ele.length === 13, `${req.length}+${ele.length}`);
ok("D2 必修合计 96 学分", req.reduce((s, x) => s + x.credits, 0) === 96);
ok("D3 每门课的课名、学分、分类与数据源逐条一致",
  [...D.required, ...D.electives].every((c, i) => C[i] && C[i].credits === c.credits && C[i].cat === c.cat && I.zh[C[i].key + ".title"] === c.title.zh));
ok("D3b 电脑应用已换成 AI 课程，且没有「电脑应用」", D.required.some(c => c.title.zh === "人工智能与教牧实践" && c.credits === 2) && !/电脑应用/.test(html));
ok("D3c 旧 68 门只在隐藏的 template 里", (html.match(/data-i18n="courseCards\.\d+\.title"/g) || []).length === 68 &&
  !/data-i18n="courseCards\./.test(html.slice(0, html.indexOf('<template id="courseArchive">'))));
ok("D3d 学位层级筛选整行隐藏", /class="filter-row level-row" hidden/.test(html));
const progs = ["gdip", "mdiv", "dmin"];
for (const l of ["zh", "en", "ko", "th"]) {
  const h = catalogHtml(l, I[l], C);
  ok(`D4 ${l} 目录含全部 48 个课名`, C.every(x => h.includes(I[l][x.key + ".title"].replace(/&/g, "&amp;"))));
  ok(`D5 ${l} 实践训练 11 项、无第 12 项`, [...Array(11).keys()].every(i => h.includes(I[l]["training." + i].replace(/&/g, "&amp;"))) && !I[l]["training.11"]);
  ok(`D8 ${l} 每门课都有简介`, C.every(x => I[l][x.key + ".body"]), C.filter(x => !I[l][x.key + ".body"]).map(x => x.code).join(" "));
  ok(`D9 ${l} 硕士 / 博士不显示学分数`, progs.every(p => !/\d/.test(I[l][`programs.items.${p}.desc`].replace(/M\.Div|D\.Min/g, ""))));
  ok(`D10 ${l} 学士写 100 学分`, /100/.test(I[l]["programs.items.bth.desc"]) && /100/.test(I[l]["courses.note.all"]));
}
const stale = /6[78] ?(门|courses|과목|วิชา)|(?<!\d)77 ?(学分|credits|학점|หน่วยกิต)|5 ?(项|practical trainings|개 실천|รายการ)|11 项实践训练、不计|学习中心|Learning Centre|학습 센터|ศูนย์การเรียนเชียงใหม่/;
for (const l of ["zh", "en", "ko", "th"]) {
  const h = fs.readFileSync(`docs/handbook/handbook-${l}.html`, "utf8");
  ok(`D6 ${l} 手册没有旧数字 / 旧名称`, !stale.test(h), (h.match(stale) || [""])[0]);
  ok(`D7 ${l} 手册写 35 门必修、100 学分`, /35/.test(h) && /100/.test(h) && /96/.test(h));
}
console.log(`\nDOWNLOAD PDFS: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
