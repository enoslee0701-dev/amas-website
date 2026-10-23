#!/usr/bin/env node
// 页面 / Edge 调用的数据库函数 ↔ 迁移里的定义：名字与参数是否对得上。
// 页面测试用的是假客户端、SQL 测试直接调函数，两边各自都能绿而中间对不上 —— 这里把中间那一环钉住：
//   · 每个被调用的函数在迁移里有定义（取最后一次 create or replace）；
//   · 调用里给的每个 p_* 参数，函数都有；
//   · 函数里没有默认值的参数，调用都给了。
// 只看门户页面与 supabase/functions 下的 Edge；纯静态解析，不连库。
// 运行：node scripts/check-sis-rpc-contract.mjs   退出码 0 全对；1 有不一致；2 没扫到东西
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const walk = (d, out = []) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

// 1. 迁移里的函数签名
const defs = {};
for (const f of fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter(x => x.endsWith(".sql")).sort()) {
  const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8");
  const re = /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(sql))) {
    const params = m[2].split(",").map(s => s.trim()).filter(Boolean).map(s => {
      const name = s.split(/\s+/)[0];
      return { name, optional: /\bdefault\b/i.test(s) };
    });
    defs[m[1]] = { params, file: f };
  }
}

// 2. 调用点
const calls = [];
const files = [...walk(path.join(ROOT, "portal")).filter(f => f.endsWith(".html")),
               ...walk(path.join(ROOT, "assets/js/portal")).filter(f => f.endsWith(".js"))];
const argKeys = (s) => s == null ? [] : [...s.matchAll(/\b(p_\w+)\s*:/g)].map(x => x[1]);
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f);
  for (const m of src.matchAll(/Api\.rpc\(\s*"(\w+)"\s*(?:,\s*\{([^}]*)\})?/g)) calls.push({ rel, name: m[1], keys: argKeys(m[2]), complete: true });
  for (const m of src.matchAll(/\brpc:\s*"(\w+)"[^]*?args:\s*\{([^}]*)\}/g)) calls.push({ rel, name: m[1], keys: argKeys(m[2]), complete: true });
}
const edge = fs.readFileSync(path.join(ROOT, "supabase/functions/sis-admin/index.ts"), "utf8");
for (const m of edge.matchAll(/return \["(\w+)", \{([^]*?)\}\];/g)) calls.push({ rel: "functions/sis-admin", name: m[1], keys: argKeys(m[2]), complete: true });

if (calls.length < 20) { console.log(`只扫到 ${calls.length} 个调用点，扫描本身可能失效`); process.exit(2); }

// 3. 对账（只核学员管理系统相关的函数与新页面，旧页面调用的函数也一并核名字）
let bad = 0;
const seen = new Set();
for (const c of calls) {
  const k = c.rel + "|" + c.name + "|" + c.keys.join(",");
  if (seen.has(k)) continue; seen.add(k);
  const d = defs[c.name];
  if (!d) { bad++; console.log(`  FAIL  ${c.rel} 调用 ${c.name}，迁移里没有这个函数`); continue; }
  const names = new Set(d.params.map(p => p.name));
  const extra = c.keys.filter(x => !names.has(x));
  const missing = d.params.filter(p => !p.optional && !c.keys.includes(p.name)).map(p => p.name);
  if (extra.length || missing.length) {
    bad++;
    console.log(`  FAIL  ${c.rel} → ${c.name}(${d.params.map(p => p.name).join(", ")})` +
      (extra.length ? `  多给：${extra.join(",")}` : "") + (missing.length ? `  缺：${missing.join(",")}` : ""));
  }
}
console.log(`\nRPC CONTRACT: 调用点 ${seen.size} 个，不一致 ${bad} 个`);
process.exit(bad ? 1 : 0);
