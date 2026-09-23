// 从 App 的 OFFICIAL_CATALOG（课程权威源）生成 Supabase 只读镜像的播种 SQL。
// 这是镜像不是新权威源：改课程仍然只能改 catalog.ts，本脚本重跑即可同步。
import fs from "node:fs";
import path from "node:path";

/* 课程权威源在 **App 仓库**里（不在本仓库）。原来写死了某台机器上的桌面路径，
   换机器就直接崩在 readFileSync，看不出是路径问题还是文件没了。
   用 AMAS_APP_DIR 指向 App 仓库根目录；没设就说清楚怎么设。 */
const APP_DIR = process.env.AMAS_APP_DIR || "";
const SRC = process.env.AMAS_CATALOG_SRC || (APP_DIR ? path.join(APP_DIR, "services", "catalog.ts") : "");
if (!SRC || !fs.existsSync(SRC)) {
  console.error("找不到课程权威源 services/catalog.ts。");
  console.error("  用 AMAS_APP_DIR 指向 App 仓库根目录，例如：");
  console.error("    AMAS_APP_DIR=/path/to/app-repo node scripts/gen-course-catalog.mjs");
  console.error("  或用 AMAS_CATALOG_SRC 直接指向那个文件。" + (SRC ? `（当前解析为 ${SRC}）` : ""));
  process.exit(2);
}
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
  const cre = /credits:\s*(\d+)/.exec(rest);
  const lessons = les ? +les[1] : 0;
  rows.push({
    code: id, title, category: CAT[cat],
    level: lvl && LVL[lvl[1]] ? LVL[lvl[1]] : null,
    instructor: ins ? ins[1] : null,
    total_lessons: lessons,
    availability: lessons > 0 ? "available" : "in_development",
    /* 学分只有学士的 27 门有值（《课程总表 V1.0》2026-09-23 批准）；
       其余层级的逐课学分未经批准，保持 null —— 不推算、不编造。 */
    credits: cre ? +cre[1] : null,
    sort_order: (rows.length + 1) * 10,
  });
}

const EXPECTED_TOTAL = 68;   // V1.0 起：67 → 68（三处合并 −3、四门新增 +4）
const EXPECTED_CREDITED = 27;
if (rows.length !== EXPECTED_TOTAL) {
  console.error(`FATAL: 解析到 ${rows.length} 门课程，必须恰好 ${EXPECTED_TOTAL} 门。目录结构可能变了，请人工核对后再生成。`);
  process.exit(1);
}
const credited = rows.filter(r => r.credits !== null);
if (credited.length !== EXPECTED_CREDITED || credited.some(r => r.level !== "bth")) {
  console.error(`FATAL: 有学分的应当恰好是学士的 ${EXPECTED_CREDITED} 门，实际 ${credited.length} 门`
    + `（非学士却有学分的：${credited.filter(r => r.level !== "bth").map(r => r.code).join(", ") || "无"}）。`);
  process.exit(1);
}
const q = (v) => v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`;
const values = rows.map(r =>
  `  (${q(r.code)}, ${q(r.title)}, ${q(r.category)}, ${q(r.level)}, ${q(r.instructor)}, ${r.total_lessons}, ${q(r.availability)}, ${r.credits === null ? "null" : r.credits}, ${r.sort_order})`
).join(",\n");

fs.writeFileSync("course_seed.sql", values + "\n", "utf8");
const byCat = rows.reduce((a, r) => (a[r.category] = (a[r.category] || 0) + 1, a), {});
console.log("生成", rows.length, "门 ·", JSON.stringify(byCat));
console.log("内容筹备中:", rows.filter(r => r.availability === "in_development").length, "门");
console.log("学士计学分:", credited.length, "门 ·", credited.reduce((a, r) => a + r.credits, 0), "学分");
