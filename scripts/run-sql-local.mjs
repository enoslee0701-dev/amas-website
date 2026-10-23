#!/usr/bin/env node
// 在一次性的内存 Postgres（PGlite）里装全部迁移，再跑给定的验收 SQL。不连任何真实库、不写磁盘上的库。
// 本机没有 psql 时用它跑 supabase/tests/*_acceptance.sql。
//
// PGlite 不是本仓库的依赖，放在仓库外的临时目录里：
//   mkdir -p /tmp/pglite && cd /tmp/pglite && npm init -y && npm i @electric-sql/pglite@0.3.7
//   PGLITE_DIR=/tmp/pglite node scripts/run-sql-local.mjs supabase/tests/sis1_acceptance.sql supabase/tests/sis2_acceptance.sql
//
// 装库顺序：scripts/verify-g1/prelude.sql（三个角色、auth schema、auth.uid()）→ Supabase 项目自带的默认授权 →
// supabase/migrations/*.sql 按文件名 → 各测试文件。每份测试的 NOTICE 原样打印。
// 退出码：0 全部成功；1 有迁移或测试失败；2 找不到 PGlite。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.PGLITE_DIR;
const entry = dir && path.join(dir, "node_modules/@electric-sql/pglite/dist/index.js");
if (!entry || !fs.existsSync(entry)) {
  console.log("找不到 PGlite。请按文件头的说明装到仓库外，并用 PGLITE_DIR 指向那个目录。");
  process.exit(2);
}
const { PGlite } = await import(pathToFileURL(entry).href);
const db = new PGlite();
const run = async (label, sql, quiet) => {
  const notes = [];
  try {
    await db.exec(sql, { onNotice: (n) => notes.push(n.message) });
    if (!quiet) notes.filter((m) => !/rehashing catalog/.test(m)).forEach((m) => console.log("  " + m));
    return true;
  } catch (e) {
    notes.filter((m) => !/rehashing catalog/.test(m)).forEach((m) => console.log("  " + m));
    console.log(`FAIL ${label}: ${e.message}`);
    return false;
  }
};

let ok = await run("prelude", fs.readFileSync(path.join(ROOT, "scripts/verify-g1/prelude.sql"), "utf8"), true);
ok = ok && await run("supabase-defaults", `
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`, true);
const mdir = path.join(ROOT, "supabase/migrations");
let n = 0;
for (const f of fs.readdirSync(mdir).filter((x) => x.endsWith(".sql")).sort()) {
  if (!ok) break;
  ok = await run(f, fs.readFileSync(path.join(mdir, f), "utf8"), true);
  n++;
}
if (ok) console.log(`迁移 ${n} 个全部装上`);
for (const t of process.argv.slice(2)) {
  if (!ok) break;
  console.log(`== ${t}`);
  ok = await run(path.basename(t), fs.readFileSync(path.resolve(t), "utf8"));
}
process.exit(ok ? 0 : 1);
