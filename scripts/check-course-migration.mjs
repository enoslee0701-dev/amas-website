#!/usr/bin/env node
/**
 * 0028 迁移里的课程行必须与 App 权威源逐字一致（离线，不连数据库）。
 *
 * 为什么要有这个：0028 把 68 门课写死在 SQL 里，而权威源是 App 仓库的
 * services/catalog.ts。两边一旦漂移，要等到 apply 之后、
 * portal2b_catalog_consistency.mjs 连上真库才会发现，那时已经晚了。
 * 这个脚本把「生成器现在会生成什么」和「迁移文件里写着什么」对一遍。
 *
 * 用法：AMAS_APP_DIR=/path/to/app-repo node scripts/check-course-migration.mjs
 * 退出码：0 一致；1 不一致；2 跑不起来（缺权威源等）
 *
 * 注意：本脚本**不校验 SQL 语法**。0028 属于 NOT_RUN 文件，语法与执行效果
 * 要在非生产环境 apply 时才能验证。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = path.join(ROOT, "supabase", "migrations", "0028_bth_curriculum_v1.sql");
const SEED = path.join(ROOT, "course_seed.sql");

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

if (!fs.existsSync(MIGRATION)) {
  console.error(`找不到迁移文件 ${path.relative(ROOT, MIGRATION)}`);
  process.exit(2);
}

/* 重跑生成器拿到「权威源现在的样子」。生成器自己会校验 68 门 / 27 门计学分。 */
try {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "gen-course-catalog.mjs")], {
    cwd: ROOT, stdio: "pipe", encoding: "utf8",
  });
} catch (e) {
  console.error("生成器跑不起来 —— 先按它的提示设好 AMAS_APP_DIR：");
  console.error((e.stderr || e.stdout || String(e)).trim());
  process.exit(2);
}

const wanted = fs.readFileSync(SEED, "utf8").trim().split("\n").map(l => l.trim().replace(/,$/, ""));
const sql = fs.readFileSync(MIGRATION, "utf8");

/* 迁移里第二个 values 段是「整体对齐」的那一段，应当是完整 68 行。 */
const blocks = [...sql.matchAll(/^values$([\s\S]*?)^on conflict/gm)].map(m => m[1]);
check("迁移里有两段 values（新建 + 整体对齐）", blocks.length === 2, `实际 ${blocks.length} 段`);

const rowsOf = (block) => block.trim().split("\n").map(l => l.trim().replace(/,$/, "")).filter(Boolean);
const aligned = blocks.length === 2 ? rowsOf(blocks[1]) : [];
check("整体对齐段恰好 68 行", aligned.length === 68, `实际 ${aligned.length} 行`);

const diff = [];
for (let i = 0; i < Math.max(wanted.length, aligned.length); i++) {
  if (wanted[i] !== aligned[i]) diff.push(`  第 ${i + 1} 行\n    权威源: ${wanted[i] ?? "（缺）"}\n    迁移里: ${aligned[i] ?? "（缺）"}`);
}
check("逐行与权威源一致", diff.length === 0, diff.length ? `${diff.length} 行不一致` : "");
if (diff.length) console.error(diff.slice(0, 5).join("\n"));

/* 被合并掉的课程不允许出现在对齐段里（它们应当只出现在删除与映射里）。 */
const retired = ["c_1thess", "c_2thess", "c_healing_word", "c_china_theology"];
const stray = retired.filter(c => aligned.some(r => r.startsWith(`('${c}'`)));
check("对齐段不含已合并退役的课程", stray.length === 0, stray.join(", "));

/* 四条合并映射必须都在，否则删课会因外键失败或丢数据。 */
const mapped = retired.filter(c => new RegExp(`\\('${c}'\\s*,`).test(sql.slice(sql.indexOf("_merge_map"))));
check("四条合并映射齐全", mapped.length === 4, `缺 ${retired.filter(c => !mapped.includes(c)).join(", ") || "无"}`);

/* 删课之前必须先搬 progress / files / posts，否则 RESTRICT 会挡、CASCADE 会删讲义。 */
const delAt = sql.indexOf("delete from public.course_catalog c using _merge_map");
for (const [name, needle] of [
  ["讲义改挂在删课之前", "update public.app_course_files"],
  ["帖子关联改挂在删课之前", "update public.app_posts"],
  ["学习进度搬迁在删课之前", "insert into public.app_course_progress"],
]) {
  const at = sql.indexOf(needle);
  check(name, at !== -1 && at < delAt);
}

check("B.Th 毕业学分改成 77", /intake_note_zh\s*=\s*'[^']*77 学分'/.test(sql));
check("闸门仍禁止非学士课程写学分", /level is distinct from 'bth'/.test(sql));
check("文件标注了 NOT_RUN", /NOT_RUN/.test(sql));

console.log(fail ? `\n${fail} 项不通过` : "\n课程迁移与权威源一致");
process.exit(fail ? 1 : 0);
