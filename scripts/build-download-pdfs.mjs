// 官网可下载 PDF 的生成脚本（Enos 2026-11-05：目录与手册一律以官网为准）。
//   课程目录：直接读 index.html 的课程卡片（编号、分类、学位、学分）+ main.js 四语言词典（课名、简介、实践训练），
//             官网改了课程，重跑本脚本即可，不再手工维护第二份清单。
//   学生手册：打印 docs/handbook/handbook-{zh,en,ko,th}.html。
// 用法：CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/build-download-pdfs.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = path.join(ROOT, "assets/files");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amas-pdf-"));

export function loadI18n() {
  const src = fs.readFileSync(path.join(ROOT, "assets/js/main.js"), "utf8");
  const start = src.indexOf("const i18n = {");
  const end = src.indexOf("\n};", start);
  return vm.runInNewContext("(" + src.slice(start + "const i18n = ".length, end + 2) + ")");
}

export function loadCourses() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const re = /<article class="course-card[^"]*" data-category="([a-z]+)" data-level="([a-z]+)"(?: data-credits="(\d+)")?>[\s\S]*?course-code">([^<]+)<\/span><h3 data-i18n="(courseCards\.\d+)\.title"/g;
  const out = []; let m;
  while ((m = re.exec(html))) out.push({ cat: m[1], level: m[2], credits: m[3] ? +m[3] : null, code: m[4], key: m[5] });
  return out;
}

const CATS = ["nt", "ot", "bible", "theology", "ministry", "history", "tools"];
const T = {
  zh: { school: "亚洲宣教神学院", branch: "清迈分院", heading: n => `官方课程目录（${n} 门）`, num: ["一", "二", "三", "四", "五", "六", "七", "八"],
        cols: ["编号", "课程", "简介", "学位", "学分"], sep: "、", footer: "开课批次以学校当期公告为准；学分制、按科修读。" },
  en: { school: "Asia Missionary Association Seminary", branch: "Chiang Mai Branch", heading: n => `Official Curriculum Guide (${n} Courses)`, num: ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"],
        cols: ["No.", "Course", "Description", "Level", "Credits"], sep: ". ", footer: "Course intakes follow the seminary's current announcements; credit-based, taken course by course." },
  ko: { school: "아시아선교신학교", branch: "치앙마이 분원", heading: n => `공식 과목 안내 (${n}과목)`, num: ["一", "二", "三", "四", "五", "六", "七", "八"],
        cols: ["번호", "과목", "소개", "과정", "학점"], sep: ". ", footer: "개설 시기는 학교 공지를 따르며, 학점제·과목별 수강입니다." },
  th: { school: "วิทยาลัยพระคริสตธรรมเอเชียมิชชัน", branch: "สาขาเชียงใหม่", heading: n => `รายวิชาทางการ (${n} วิชา)`, num: ["๑", "๒", "๓", "๔", "๕", "๖", "๗", "๘"],
        cols: ["ที่", "วิชา", "คำอธิบาย", "ระดับ", "หน่วยกิต"], sep: " ", footer: "รอบเปิดสอนตามประกาศของวิทยาลัย ระบบหน่วยกิต เรียนเป็นรายวิชา" },
};
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function catalogHtml(lang, d, courses) {
  const t = T[lang], lv = l => l === "none" ? "—" : d["courses.levels." + l].replace(/^.*?(B\.Th|M\.Div|D\.Min)$/, "$1");
  const sections = CATS.map((c, i) => {
    const rows = courses.filter(x => x.cat === c);
    return `<h2>${t.num[i]}. ${esc(d["courses.filters." + c])} (${rows.length})</h2>
<table><thead><tr><th class=c>${t.cols[0]}</th><th class=t>${t.cols[1]}</th><th>${t.cols[2]}</th><th class=l>${t.cols[3]}</th><th class=r>${t.cols[4]}</th></tr></thead><tbody>
${rows.map(x => `<tr><td class=c>${esc(x.code)}</td><td class=t>${esc(d[x.key + ".title"])}</td><td>${esc(d[x.key + ".body"])}</td><td class=l>${lv(x.level)}</td><td class=r>${x.credits ?? "—"}</td></tr>`).join("\n")}
</tbody></table>`;
  }).join("\n");
  const training = [0, 1, 2, 3, 4].map(i => `<li>${esc(d["training." + i])}</li>`).join("");
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><title>AMAS</title><style>
@page{size:A4;margin:14mm 14mm 16mm}
body{font-family:"PingFang SC","Apple SD Gothic Neo","Thonburi","Helvetica Neue",sans-serif;color:#1d2a44;font-size:9.5pt;margin:0}
header{text-align:center;border-bottom:2px solid #b08a3e;padding-bottom:10px;margin-bottom:6px}
header h1{font-size:22pt;margin:0;color:#13294b;letter-spacing:2px}
header .en{font-size:8pt;letter-spacing:3px;color:#a97c2a;margin-top:4px}
header .h{font-size:13pt;margin-top:8px;letter-spacing:2px}
.lead{background:#f6f1e7;border-radius:6px;padding:8px 12px;margin:10px 0 2px;line-height:1.6}
h2{font-size:12pt;color:#13294b;margin:14px 0 6px;break-after:avoid}
table{width:100%;border-collapse:collapse}
tr{break-inside:avoid}
th{background:#13294b;color:#fff;font-weight:600;text-align:left;padding:4px 6px;font-size:8.5pt}
td{border-bottom:1px solid #e3e6ee;padding:4px 6px;vertical-align:top;line-height:1.45}
td.c{color:#5b6577}.c{width:46px;white-space:nowrap}.t{width:30%;font-weight:600}.l{width:52px;white-space:nowrap}.r{width:36px;text-align:center}
ul{margin:4px 0;padding-left:18px;columns:2}li{margin:2px 0}
.note{color:#5b6577;margin-top:6px;line-height:1.6}
footer{margin-top:16px;border-top:1px solid #d8dce6;padding-top:8px;font-size:8.5pt;color:#5b6577;text-align:center;line-height:1.7}
</style><body>
<header><h1>${esc(t.school)}</h1><div class=en>ASIA MISSIONARY ASSOCIATION SEMINARY · CHIANG MAI BRANCH, THAILAND${lang === "en" ? "" : " · " + esc(t.branch)}</div>
<div class=h>${esc(t.heading(courses.length))}</div></header>
<div class=lead>${esc(d["courses.desc"])}<br><strong>${esc(d["courses.note.all"])}</strong></div>
${sections}
<h2>${t.num[7]}. ${esc(d["training.title"])}</h2>
<p class=note style="margin-top:0">${esc(d["training.note"])}</p>
<ul>${training}</ul>
<footer>${esc(t.footer)}<br>AMAS · amasthai2026@gmail.com | WeChat: L52586222 | Line: enoslee0701</footer>
</body></html>`;
}

function printPdf(htmlFile, pdfFile) {
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=4000",
    "--print-to-pdf=" + pdfFile, "file://" + htmlFile], { stdio: "ignore" });
  if (!fs.existsSync(pdfFile) || fs.statSync(pdfFile).size < 10000) throw new Error("PDF 生成失败: " + pdfFile);
}

if (import.meta.url === "file://" + process.argv[1]) {
  const i18n = loadI18n(), courses = loadCourses();
  if (courses.length !== 68) throw new Error("官网课程卡片数量不是 68，而是 " + courses.length + "，先核对 index.html");
  const suffix = { zh: "", en: "-en", ko: "-ko", th: "-th" };
  for (const lang of ["zh", "en", "ko", "th"]) {
    const f = path.join(TMP, `catalog-${lang}.html`);
    fs.writeFileSync(f, catalogHtml(lang, i18n[lang], courses));
    printPdf(f, path.join(OUT, `AMAS-BTh-curriculum${suffix[lang]}.pdf`));
    printPdf(path.join(ROOT, `docs/handbook/handbook-${lang}.html`), path.join(OUT, `AMAS-student-handbook${suffix[lang]}.pdf`));
    console.log("✓", lang);
  }
}
