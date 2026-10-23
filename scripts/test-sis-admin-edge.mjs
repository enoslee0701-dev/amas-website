#!/usr/bin/env node
// sis-admin Edge Function 入口测试：真函数体（supabase/functions/sis-admin/index.ts）跑在 Node 里。
// 只把 `npm:@supabase/supabase-js` 换成假客户端、给一个最小的 Deno 垫片（env / serve）；
// 用真 Request 打进去，验证身份 / aal2 / 角色门禁、每个动作的参数形状、actor 只取自令牌、错误码映射。
// 依赖 Node 22.18+ 的 TypeScript 类型擦除（本机 Node 24 默认开启）。不联网、不连库。
// 运行：node scripts/test-sis-admin-edge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "supabase/functions/sis-admin/index.ts"), "utf8");
const IMPORT = 'import { createClient } from "npm:@supabase/supabase-js@2";';
if (!src.includes(IMPORT)) { console.log("index.ts 的 import 行变了，测试需要同步"); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amas-edge-"));
const file = path.join(tmp, "index.ts");
fs.writeFileSync(file, src.replace(IMPORT, "const createClient = (globalThis as any).__createClient;"));

// ---------- 假环境 ----------
let handler = null;
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "https://x.invalid", SUPABASE_SERVICE_ROLE_KEY: "test" }[k]) },
                    serve: (fn) => { handler = fn; } };
const USERS = { "tok-admin": { id: "aaaaaaaa-0000-4000-8000-000000000001", roles: ["registrar"] },
                "tok-super": { id: "aaaaaaaa-0000-4000-8000-000000000002", roles: ["super_admin"] },
                "tok-teacher": { id: "aaaaaaaa-0000-4000-8000-000000000003", roles: ["teacher"] } };
let rpcLog = [], rpcReply = { data: { ok: true }, error: null };
globalThis.__createClient = () => ({
  auth: { getUser: async (jwt) => {
    const tok = (() => { try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).tok; } catch { return null; } })();
    const u = USERS[tok];
    return u ? { data: { user: { id: u.id } }, error: null } : { data: { user: null }, error: { message: "bad jwt" } };
  } },
  from: () => { let uid = null; const q = { select: () => q, eq: (_k, v) => { uid = v; return q; },
    is: async () => ({ data: (Object.values(USERS).find(u => u.id === uid)?.roles || []).map(role => ({ role })), error: null }) }; return q; },
  rpc: async (name, args) => { rpcLog.push({ name, args }); return rpcReply; },
});
await import(pathToFileURL(file).href);
if (!handler) { console.log("Deno.serve 没被调用"); process.exit(2); }

const jwt = (tok, aal = "aal2") => ["e30", Buffer.from(JSON.stringify({ tok, aal })).toString("base64url"), "sig"].join(".");
const call = async (body, { tok = "tok-admin", aal = "aal2", method = "POST", auth = true } = {}) => {
  rpcLog = [];
  const res = await handler(new Request("https://x.invalid/functions/v1/sis-admin", {
    method, headers: auth ? { Authorization: "Bearer " + jwt(tok, aal), "Content-Type": "application/json" } : {},
    body: method === "POST" ? JSON.stringify(body) : undefined }));
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, rpc: rpcLog };
};

let pass = 0, fails = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); } else { fails++; console.log("  FAIL  " + n + (d ? "  ← " + d : "")); } };
const U = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN_ID = USERS["tok-admin"].id;

// ---------- 入口门禁 ----------
ok("E01 OPTIONS 预检 200", (await handler(new Request("https://x.invalid", { method: "OPTIONS" }))).status === 200);
ok("E02 GET 405", (await call(null, { method: "GET" })).status === 405);
let r = await call({ action: "create_offering" }, { auth: false });
ok("E03 没有令牌 401", r.status === 401 && r.rpc.length === 0);
r = await call({ action: "create_offering", course_code: "c", academic_year: "2026-2027" }, { aal: "aal1" });
ok("E04 未两步验证 403 mfa_required 且不调库", r.status === 403 && r.json?.error === "mfa_required" && r.rpc.length === 0);
r = await call({ action: "create_offering", course_code: "c", academic_year: "2026-2027" }, { tok: "tok-teacher" });
ok("E05 教授调教务接口 403", r.status === 403 && r.rpc.length === 0);
r = await call({ action: "drop_database" });
ok("E06 未知动作 400", r.status === 400 && r.rpc.length === 0);

// ---------- 每个动作：合法形状 → 对应 RPC，actor 只取自令牌 ----------
const VALID = {
  create_offering: [{ course_code: "c_matthew", academic_year: "2026-2027", starts_on: "2026-10-05", capacity: "30" }, "sis_create_offering"],
  update_offering: [{ offering_id: U(1), schedule_note: "周二", capacity: null }, "sis_update_offering"],
  set_offering_status: [{ offering_id: U(1), status: "in_progress" }, "sis_set_offering_status"],
  assign_teacher: [{ offering_id: U(1), teacher_id: U(2), role: "assistant" }, "sis_assign_teacher"],
  remove_teacher: [{ offering_id: U(1), teacher_id: U(2) }, "sis_remove_teacher"],
  enroll_students: [{ offering_id: U(1), student_ids: [U(3), U(4)] }, "sis_enroll_students"],
  drop_enrollment: [{ enrollment_id: U(5), reason: "转班" }, "sis_drop_enrollment"],
  change_student_status: [{ student_id: U(6), to: "on_leave", reason: "家庭原因" }, "sis_change_student_status"],
  publish_grades: [{ offering_id: U(1) }, "sis_publish_grades"],
  return_grades: [{ offering_id: U(1), reason: "请核对" }, "sis_return_grades"],
  decide_correction: [{ correction_id: U(7), approve: true }, "sis_decide_correction"],
  graduate: [{ student_id: U(6), graduated_on: "2027-06-30" }, "sis_graduate"],
  assign_mentor: [{ student_id: U(6), mentor_id: U(8) }, "sis_assign_mentor"],
  end_mentor: [{ assignment_id: U(9) }, "sis_end_mentor"],
  add_transfer: [{ student_id: U(6), course_code: "c_matthew", reason: "外校已修" }, "sis_add_transfer_credit"],
  revoke_transfer: [{ ledger_id: 12, reason: "证明不符" }, "sis_revoke_transfer"],
};
for (const [action, [body, rpcName]] of Object.entries(VALID)) {
  r = await call(Object.assign({ action, p_actor: U(99), actor: U(99) }, body));
  ok(`E10 ${action} → ${rpcName}，actor = 令牌里的人`, r.status === 200 && r.rpc.length === 1 && r.rpc[0].name === rpcName && r.rpc[0].args.p_actor === ADMIN_ID,
     `${r.status} ${JSON.stringify(r.rpc)}`);
}
const srcActions = [...src.matchAll(/^\s{2}(\w+): \(b, actor\) =>/gm)].map(m => m[1]);
ok("E11 每个动作都有合法路径用例", srcActions.every(a => VALID[a] || a === "set_staff_role") && srcActions.length >= 17,
   srcActions.filter(a => !VALID[a]).join(","));
r = await call({ action: "create_offering", course_code: "c", academic_year: "2026-2027", capacity: "30" });
ok("E12 人数上限字符串转成整数", r.rpc[0]?.args.p_capacity === 30);

// ---------- 不合格形状 → 400 且不调库 ----------
const BAD = [
  ["create_offering 日期格式不对", { action: "create_offering", course_code: "c", academic_year: "2026-2027", starts_on: "2026/10/05" }],
  ["create_offering 上限为负", { action: "create_offering", course_code: "c", academic_year: "2026-2027", capacity: -3 }],
  ["create_offering 上课安排超 200 字", { action: "create_offering", course_code: "c", academic_year: "2026-2027", schedule_note: "x".repeat(201) }],
  ["update_offering id 不是 uuid", { action: "update_offering", offering_id: "1; drop table" }],
  ["enroll_students 超过 200 人", { action: "enroll_students", offering_id: U(1), student_ids: Array.from({ length: 201 }, (_, i) => U(i + 10)) }],
  ["enroll_students 空名单", { action: "enroll_students", offering_id: U(1), student_ids: [] }],
  ["enroll_students 名单里有非 uuid", { action: "enroll_students", offering_id: U(1), student_ids: [U(3), "x"] }],
  ["drop_enrollment 原因空白", { action: "drop_enrollment", enrollment_id: U(5), reason: "   " }],
  ["change_student_status 目标状态非法", { action: "change_student_status", student_id: U(6), to: "graduated", reason: "x" }],
  ["return_grades 无原因", { action: "return_grades", offering_id: U(1) }],
  ["decide_correction 驳回无理由", { action: "decide_correction", correction_id: U(7), approve: false }],
  ["decide_correction approve 不是布尔", { action: "decide_correction", correction_id: U(7), approve: "true" }],
  ["graduate 日期格式不对", { action: "graduate", student_id: U(6), graduated_on: "30/06/2027" }],
  ["add_transfer 既无课程也无学分", { action: "add_transfer", student_id: U(6), reason: "x" }],
  ["add_transfer 学分为负", { action: "add_transfer", student_id: U(6), credits: -2, reason: "x" }],
  ["revoke_transfer ledger_id 不是整数", { action: "revoke_transfer", ledger_id: "12", reason: "x" }],
  ["set_staff_role 角色不在白名单", { action: "set_staff_role", user_id: U(8), role: "super_admin", grant: true, reason: "x" }],
];
for (const [name, body] of BAD) {
  r = await call(body, { tok: "tok-super" });
  ok("E20 " + name + " → 400 不调库", r.status === 400 && r.rpc.length === 0, `${r.status} ${JSON.stringify(r.rpc)}`);
}

// ---------- 角色管理只给超管 ----------
const roleBody = { action: "set_staff_role", user_id: U(8), role: "mentor", grant: true, reason: "新任导师" };
r = await call(roleBody, { tok: "tok-admin" });
ok("E30 教务调角色管理 403", r.status === 403 && r.rpc.length === 0);
r = await call(roleBody, { tok: "tok-super" });
ok("E31 超管调角色管理 → sis_set_staff_role", r.status === 200 && r.rpc[0]?.name === "sis_set_staff_role" && r.rpc[0].args.p_actor === USERS["tok-super"].id);

// ---------- 错误码映射 ----------
const body = { action: "publish_grades", offering_id: U(1) };
rpcReply = { data: { ok: false, error: "nothing_to_publish" }, error: null };
r = await call(body);
ok("E40 业务拒绝 → 409 + 错误码", r.status === 409 && r.json?.error === "nothing_to_publish");
rpcReply = { data: null, error: { message: "actor lacks admin role" } };
ok("E41 库里判定非教务 → 403", (await call(body)).status === 403);
rpcReply = { data: null, error: { message: "not_found" } };
ok("E42 找不到 → 404", (await call(body)).status === 404);
rpcReply = { data: null, error: { message: "invalid_state" } };
ok("E43 状态冲突 → 409", (await call(body)).status === 409);
rpcReply = { data: null, error: { message: "deadlock detected" } };
r = await call(body);
ok("E44 其他错误 → 500 且不外泄库内报错", r.status === 500 && !JSON.stringify(r.json).includes("deadlock"));
rpcReply = { data: { ok: true }, error: null };

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nSIS-ADMIN EDGE: ${pass} PASS / ${fails} FAIL`);
process.exit(fails ? 1 : 0);
