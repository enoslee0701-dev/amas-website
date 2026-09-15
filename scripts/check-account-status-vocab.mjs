#!/usr/bin/env node
/* 账号状态词表 ↔ 契约枚举 一致性检查（不开浏览器）。

   页面 portal/applicant/profile/ 用两处定义账号状态词表：
     const ACC = { pending_email: "待邮箱验证", ... }   ← 显示文案
     const ACC_KEYS = ["pending_email", ...]            ← 白名单（防原型链取值）
   契约是 public.account_status 枚举。三者必须是**同一个集合**：
     · 契约有、页面没有 → 该状态的英文原文直接显示给申请人（曾实测少了 locked / disabled）
     · ACC_KEYS 有、ACC 没有 → 白名单放行却取不到文案，同样漏出英文
     · 页面有、契约没有 → 死词条（曾有过契约里不存在的 closed）

   为什么不沿用 test-profile-writes.mjs 里的 Ap5/Ap6：
     · 那条只读 0002_identity.sql 一个文件，之后的迁移若 `alter type ... add value`，它看不见
     · 只比 ACC_KEYS，不比 ACC 的键
     · 写死「两边都是 5 个」
     · 挂在要起 Chrome 的探针里，想单独跑也得开浏览器
   这里按文件名顺序重放 supabase/migrations/*.sql 里对该枚举的
   create type / alter type add value / rename value / drop type，得出**最终**枚举集合再比。

   只读文件；不开浏览器、不联网、不写文件。

   用法：
     node scripts/check-account-status-vocab.mjs              # 检查本仓库
     node scripts/check-account-status-vocab.mjs --root DIR   # 检查另一棵同结构目录（负向用例用）
   退出码：0 = 三个集合完全一致；1 = 不一致；2 = 任一集合没取到（空转不算通过）。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const ri = argv.indexOf("--root");
const ROOT = ri > -1 ? path.resolve(argv[ri + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "portal/applicant/profile/index.html";
const MIGRATIONS = "supabase/migrations";

const T = String.raw`(?:public\.)?account_status`;
const stripSqlComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

function sqlEnum() {
  const dir = path.join(ROOT, MIGRATIONS);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
  let set = null;
  const trail = [];
  for (const f of files) {
    const sql = stripSqlComments(fs.readFileSync(path.join(dir, f), "utf8"));
    const ops = [];
    for (const m of sql.matchAll(new RegExp(String.raw`create\s+type\s+${T}\s+as\s+enum\s*\(([^)]*)\)`, "gi")))
      ops.push({ at: m.index, run: () => { set = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]); }, what: "create" });
    for (const m of sql.matchAll(new RegExp(String.raw`alter\s+type\s+${T}\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([^']+)'`, "gi")))
      ops.push({ at: m.index, run: () => { if (set && !set.includes(m[1])) set.push(m[1]); }, what: "add " + m[1] });
    for (const m of sql.matchAll(new RegExp(String.raw`alter\s+type\s+${T}\s+rename\s+value\s+'([^']+)'\s+to\s+'([^']+)'`, "gi")))
      ops.push({ at: m.index, run: () => { if (set) set = set.map((v) => (v === m[1] ? m[2] : v)); }, what: `rename ${m[1]}→${m[2]}` });
    for (const m of sql.matchAll(new RegExp(String.raw`drop\s+type\s+(?:if\s+exists\s+)?${T}\b`, "gi")))
      ops.push({ at: m.index, run: () => { set = null; }, what: "drop" });
    for (const op of ops.sort((a, b) => a.at - b.at)) { op.run(); trail.push(`${f}: ${op.what}`); }
  }
  return { set, trail };
}

function pageSets() {
  const file = path.join(ROOT, PAGE);
  if (!fs.existsSync(file)) return { acc: null, keys: null };
  const src = fs.readFileSync(file, "utf8");
  const accBody = (src.match(/const\s+ACC\s*=\s*\{([^}]*)\}/) || [])[1];
  const keysBody = (src.match(/const\s+ACC_KEYS\s*=\s*\[([^\]]*)\]/) || [])[1];
  return {
    acc: accBody == null ? null : [...accBody.matchAll(/(?:^|[,{\s])["']?([A-Za-z_][\w]*)["']?\s*:/g)].map((m) => m[1]),
    keys: keysBody == null ? null : [...keysBody.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]),
  };
}

const norm = (a) => [...new Set(a)].sort();
const { set: sql, trail } = sqlEnum();
const { acc, keys } = pageSets();

console.log("  契约 account_status（重放迁移后）: " + JSON.stringify(sql && norm(sql)));
console.log("    依据: " + (trail.length ? trail.join(" ｜ ") : "（无）"));
console.log("  页面 ACC 的键:                    " + JSON.stringify(acc && norm(acc)));
console.log("  页面 ACC_KEYS:                    " + JSON.stringify(keys && norm(keys)));

const missing = [];
if (!sql || !sql.length) missing.push("契约枚举（" + MIGRATIONS + " 里没找到 account_status 的定义）");
if (!acc || !acc.length) missing.push("页面 ACC（" + PAGE + " 里没找到 const ACC = {...}）");
if (!keys || !keys.length) missing.push("页面 ACC_KEYS（" + PAGE + " 里没找到 const ACC_KEYS = [...]）");
if (missing.length) {
  console.log("  没取到：" + missing.join("；") + " —— 空转不算通过。");
  process.exit(2);
}

const problems = [];
const diff = (a, b) => norm(a).filter((x) => !b.includes(x));
const dup = (a) => a.filter((x, i) => a.indexOf(x) !== i);
if (diff(sql, keys).length) problems.push("契约有、ACC_KEYS 没有: " + diff(sql, keys).join(", "));
if (diff(keys, sql).length) problems.push("ACC_KEYS 有、契约没有: " + diff(keys, sql).join(", "));
if (diff(sql, acc).length) problems.push("契约有、ACC 没有文案: " + diff(sql, acc).join(", "));
if (diff(acc, sql).length) problems.push("ACC 有、契约没有: " + diff(acc, sql).join(", "));
if (dup(keys).length) problems.push("ACC_KEYS 有重复: " + norm(dup(keys)).join(", "));

for (const p of problems) console.log("  FAIL  " + p);
console.log(problems.length ? "  不一致 " + problems.length + " 处" : "  三个集合完全一致");
process.exit(problems.length ? 1 : 0);
