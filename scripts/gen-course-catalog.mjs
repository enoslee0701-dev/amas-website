// 从 App 的 OFFICIAL_CATALOG（课程权威源）生成 Supabase 只读镜像的播种 SQL。
// 这是镜像不是新权威源：改课程仍然只能改 catalog.ts，本脚本重跑即可同步。
import fs from "node:fs";

const SRC = "C:/Users/enosl/Desktop/amas---asian-missionary-theological-seminary/services/catalog.ts";
const src = fs.readFileSync(SRC, "utf8");

const CAT = { NT: "nt", OT: "ot", BB: "bible_basics", TH: "theology", PR: "practical", HI: "history", LA: "language" };
const LVL = { BTH: "bth", MDIV: "mdiv", DMIN: "dmin" };

const body = src.slice(src.indexOf("export const OFFICIAL_CATALOG"));
const rows = [];
const re = /\{\s*id:\s*'([^']+)',\s*title:\s*'([^']+)',\s*category:\s*(\w+)([^}]*)\}/g;
let m;
while ((m = re.exec(body))) {
  const [, id, title, cat, rest] = m;
  if (!CAT[cat]) continue;
  const lvl = /level:\s*(\w+)/.exec(rest);
  const les = /totalLessons:\s*(\d+)/.exec(rest);
  const ins = /instructor:\s*'([^']*)'/.exec(rest);
  const lessons = les ? +les[1] : 0;
  rows.push({
    code: id, title, category: CAT[cat],
    level: lvl && LVL[lvl[1]] ? LVL[lvl[1]] : null,
    instructor: ins ? ins[1] : null,
    total_lessons: lessons,
    availability: lessons > 0 ? "available" : "in_development",
    sort_order: (rows.length + 1) * 10,
  });
}

if (rows.length !== 67) {
  console.error(`FATAL: 解析到 ${rows.length} 门课程，必须恰好 67 门。目录结构可能变了，请人工核对后再生成。`);
  process.exit(1);
}
const q = (v) => v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`;
const values = rows.map(r =>
  `  (${q(r.code)}, ${q(r.title)}, ${q(r.category)}, ${q(r.level)}, ${q(r.instructor)}, ${r.total_lessons}, ${q(r.availability)}, ${r.sort_order})`
).join(",\n");

fs.writeFileSync("course_seed.sql", values + "\n", "utf8");
const byCat = rows.reduce((a, r) => (a[r.category] = (a[r.category] || 0) + 1, a), {});
console.log("生成", rows.length, "门 ·", JSON.stringify(byCat));
console.log("内容筹备中:", rows.filter(r => r.availability === "in_development").length, "门");
