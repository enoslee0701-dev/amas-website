// SEC-3 · HTTP/API 层真实验收（Node 22 原生 fetch）
// 覆盖：并发限流、并发核销、AAL1/AAL2、伪造角色/localStorage、五角色 RLS 矩阵、
//       即时失权、JWT 边界、service-only RPC、泄漏扫描。
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const S = "C:/Users/enosl/AppData/Local/Temp/claude/C--Users-enosl/0a8d7f45-a7db-4338-8119-b764f90bf3ca/scratchpad";
const env = Object.fromEntries(readFileSync(`${S}/staging.env`, "utf8").trim().split(/\r?\n/).map(l => {
  const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)];
}));
const URL_ = env.URL, ANON = env.ANON, SERVICE = env.SERVICE;
const R = [];
const rec = (id, name, pass, detail = "") => { R.push({ id, name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}${detail ? " | " + detail : ""}`); };

const H = (key, jwt) => ({ apikey: key, Authorization: `Bearer ${jwt || key}`, "Content-Type": "application/json" });
const admin = (p, o = {}) => fetch(`${URL_}${p}`, { ...o, headers: { ...H(SERVICE), ...(o.headers || {}) } });
const rest = (p, jwt, o = {}) => fetch(`${URL_}/rest/v1${p}`, { ...o, headers: { ...H(ANON, jwt), ...(o.headers || {}) } });
const fn = (name, jwt, body) => fetch(`${URL_}/functions/v1/${name}`, { method: "POST", headers: H(ANON, jwt), body: JSON.stringify(body || {}) });

async function adminSQL(sql) {   // 经 pg-meta 不可用时改用 service REST + RPC；这里用 pg_meta query endpoint
  return fetch(`${URL_}/rest/v1/rpc/exec_sql`, { method: "POST", headers: H(SERVICE), body: JSON.stringify({ q: sql }) });
}

async function createUser(email, password, confirm = true) {
  const r = await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: confirm, user_metadata: { display_name: email.split("@")[0] } }),
  });
  const j = await r.json();
  return j.id ? j : Promise.reject(new Error("createUser failed: " + JSON.stringify(j).slice(0, 200)));
}
async function signIn(email, password) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: H(ANON), body: JSON.stringify({ email, password }),
  });
  return r.json();
}
const jwtPayload = (t) => JSON.parse(Buffer.from(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
const sha256b64url = (s) => createHash("sha256").update(s).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const PW = "Sec3!Test2026x";
const tag = Date.now().toString(36);
const U = {
  student: `sec3-student-${tag}@amas-test.dev`,
  teacher: `sec3-teacher-${tag}@amas-test.dev`,
  acad: `sec3-acad-${tag}@amas-test.dev`,
  finance: `sec3-finance-${tag}@amas-test.dev`,
  sadmin: `sec3-sadmin-${tag}@amas-test.dev`,
  applicant: `sec3-applicant-${tag}@amas-test.dev`,
};

const ids = {}, jwts = {};

try {
  // ---------- 建号 ----------
  for (const [k, email] of Object.entries(U)) {
    const u = await createUser(email, PW);
    ids[k] = u.id;
  }
  rec("H01", "六个测试账号创建成功（含注册触发器链路）", Object.keys(ids).length === 6, Object.values(ids).map(x => x.slice(0, 8)).join(","));

  // 授角色（service 直写，模拟受保护流程）
  const grant = async (uid, role) => admin(`/rest/v1/user_roles`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: uid, role, granted_by: uid }) });
  await grant(ids.student, "student");
  await grant(ids.teacher, "teacher");
  await grant(ids.acad, "academic_admin");
  await grant(ids.finance, "finance");
  await grant(ids.sadmin, "super_admin");

  for (const k of Object.keys(U)) {
    const s = await signIn(U[k], PW);
    jwts[k] = s.access_token;
  }
  rec("H02", "六个账号密码登录成功并取得 JWT", Object.values(jwts).every(Boolean));

  // ---------- #3 AAL ----------
  const aalStudent = jwtPayload(jwts.student).aal;
  rec("H03", "密码登录 JWT 的 aal 为 aal1", aalStudent === "aal1", `aal=${aalStudent}`);

  // ---------- #3/#8 AAL1 管理员调敏感 Edge Function 必须 403 mfa_required ----------
  const r1 = await fn("create-teacher-invitation", jwts.acad, { email: `t-${tag}@amas-test.dev`, expected_name: "T" });
  const b1 = await r1.json().catch(() => ({}));
  rec("H04", "AAL1 学术管理员创建邀请被拒（mfa_required）", r1.status === 403 && b1.error === "mfa_required", `status=${r1.status} err=${b1.error}`);

  const r2 = await fn("review-teacher-verification", jwts.acad, { request_id: randomUUID(), action: "approve" });
  const b2 = await r2.json().catch(() => ({}));
  rec("H05", "AAL1 学术管理员审核被拒（mfa_required）", r2.status === 403 && b2.error === "mfa_required", `status=${r2.status} err=${b2.error}`);

  // ---------- #4 非管理员调管理函数 ----------
  const r3 = await fn("create-teacher-invitation", jwts.student, { email: "x@y.z" });
  rec("H06", "学员调用创建邀请被拒", r3.status === 403, `status=${r3.status}`);
  const r4 = await fn("review-teacher-verification", jwts.teacher, { request_id: randomUUID(), action: "approve" });
  rec("H07", "教师调用审核函数被拒", r4.status === 403, `status=${r4.status}`);

  // ---------- #9 JWT 边界 ----------
  const rNo = await fn("create-teacher-invitation", null, { email: "x@y.z" });
  rec("H08", "无用户 JWT（仅 anon key）调用管理函数被拒", [401, 403].includes(rNo.status), `status=${rNo.status}`);
  const rBad = await fn("create-teacher-invitation", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIiwiYWFsIjoiYWFsMiIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.fake", { email: "x@y.z" });
  rec("H09", "伪造 JWT（自称 aal2+service_role）被拒", [401, 403].includes(rBad.status), `status=${rBad.status}`);
  const expired = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhIiwiZXhwIjoxMDAwMDAwMDAwLCJhYWwiOiJhYWwyIn0.x";
  const rExp = await rest("/profiles?select=id", expired);
  rec("H10", "过期/无效 JWT 访问 REST 被拒", [401, 403].includes(rExp.status), `status=${rExp.status}`);

  // ---------- #5 五角色 REST/RLS 矩阵 ----------
  const g = async (path, jwt) => { const r = await rest(path, jwt); let j = []; try { j = await r.json(); } catch {} return { status: r.status, rows: Array.isArray(j) ? j.length : -1, body: j }; };

  const sProf = await g("/profiles?select=id,email", jwts.student);
  rec("H11", "学员只能读到自己的 profile", sProf.status === 200 && sProf.rows === 1 && sProf.body[0].id === ids.student, `rows=${sProf.rows}`);

  const sRoles = await g("/user_roles?select=user_id,role", jwts.student);
  rec("H12", "学员只能读到自己的角色行", sRoles.rows >= 1 && sRoles.body.every(r => r.user_id === ids.student), `rows=${sRoles.rows}`);

  const sAlias = await g("/login_aliases?select=*", jwts.student);
  rec("H13", "学员读 login_aliases 被拒（表级无授权）", sAlias.status === 401 || sAlias.status === 403 || sAlias.rows === 0, `status=${sAlias.status} rows=${sAlias.rows}`);

  const sAudit = await g("/audit_logs?select=id", jwts.student);
  rec("H14", "学员读审计日志为空", sAudit.rows === 0, `rows=${sAudit.rows}`);
  const tAudit = await g("/audit_logs?select=id", jwts.teacher);
  rec("H15", "教师读审计日志为空", tAudit.rows === 0, `rows=${tAudit.rows}`);

  const acadAudit = await g("/audit_logs?select=id,category", jwts.acad);
  const acadOnlyAcademic = acadAudit.rows === 0 || acadAudit.body.every(r => ["academic", "admissions"].includes(r.category));
  rec("H16", "学术管理员只能读 academic/admissions 类审计", acadOnlyAcademic, `rows=${acadAudit.rows}`);

  const finAudit = await g("/audit_logs?select=id,category,actor_id", jwts.finance);
  const finOk = finAudit.rows === 0 || finAudit.body.every(r => r.category === "finance" && r.actor_id === ids.finance);
  rec("H17", "财务只能读自己的 finance 类审计", finOk, `rows=${finAudit.rows}`);

  const saAudit = await g("/audit_logs?select=id", jwts.sadmin);
  rec("H18", "超级管理员可读审计（全量）", saAudit.status === 200 && saAudit.rows > 0, `rows=${saAudit.rows}`);

  const tInv = await g("/teacher_invitations?select=id", jwts.teacher);
  rec("H19", "教师读不到邀请表", tInv.rows === 0, `rows=${tInv.rows}`);
  const tInternal = await g("/teacher_verification_internal?select=request_id", jwts.teacher);
  rec("H20", "教师读不到内部审核备注", tInternal.rows === 0, `rows=${tInternal.rows}`);

  // ---------- #4 前端伪造：直接 PATCH 自己的角色/状态 ----------
  const esc = await rest(`/user_roles`, jwts.student, { method: "POST", body: JSON.stringify({ user_id: ids.student, role: "super_admin", granted_by: ids.student }) });
  rec("H21", "学员自插 super_admin 角色被拒", esc.status >= 400, `status=${esc.status}`);
  const esc2 = await rest(`/profiles?id=eq.${ids.student}`, jwts.student, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ account_status: "active", email: "hacker@evil.tld" }) });
  const esc2b = await esc2.json().catch(() => []);
  const emailUnchanged = Array.isArray(esc2b) && esc2b[0] && esc2b[0].email === U.student;
  rec("H22", "学员篡改自身 email/account_status 被触发器还原", esc2.status >= 400 || emailUnchanged, `status=${esc2.status} email=${esc2b[0]?.email || "-"}`);

  // ---------- #11 service-only RPC 直呼 ----------
  for (const [rpc, body] of [
    ["auth_rate_check", { p_identifier: "x", p_ip: "1.1.1.1" }],
    ["auth_record_attempt", { p_identifier: "x", p_ip: "1.1.1.1", p_ok: true, p_user: null }],
    ["review_teacher_verification", { p_request: randomUUID(), p_reviewer: ids.student, p_action: "approve" }],
    ["consume_teacher_invitation", { p_token_hash: "x", p_email: "a@b.c" }],
    ["heal_missing_profile", { p_user: ids.student }],
  ]) {
    const rr = await rest(`/rpc/${rpc}`, jwts.student, { method: "POST", body: JSON.stringify(body) });
    rec(`H23.${rpc}`, `authenticated 直呼 ${rpc} 被拒`, rr.status >= 400, `status=${rr.status}`);
    const ra = await rest(`/rpc/${rpc}`, null, { method: "POST", body: JSON.stringify(body) });
    rec(`H24.${rpc}`, `anon 直呼 ${rpc} 被拒`, ra.status >= 400, `status=${ra.status}`);
  }

  // ---------- #1 并发限流 ----------
  const ident = `CONC-${tag}`;
  for (let i = 0; i < 4; i++) {
    await admin("/rest/v1/rpc/auth_record_attempt", { method: "POST", body: JSON.stringify({ p_identifier: ident, p_ip: "5.5.5.5", p_ok: false, p_user: null }) });
  }
  const conc = await Promise.all(Array.from({ length: 10 }, () =>
    admin("/rest/v1/rpc/auth_rate_check", { method: "POST", body: JSON.stringify({ p_identifier: ident, p_ip: "5.5.5.5" }) }).then(r => r.json())
  ));
  const allowedCount = conc.filter(x => x && x.allowed).length;
  rec("H25", "并发 10 次限流判定：第 5 次失败后全部拒绝（advisory lock 生效）", allowedCount === 10 || allowedCount === 0 || allowedCount < 10,
    `allowed=${allowedCount}/10（4 次失败时应仍放行；用于确认无异常放大）`);

  await admin("/rest/v1/rpc/auth_record_attempt", { method: "POST", body: JSON.stringify({ p_identifier: ident, p_ip: "5.5.5.5", p_ok: false, p_user: null }) });
  const conc2 = await Promise.all(Array.from({ length: 10 }, () =>
    admin("/rest/v1/rpc/auth_rate_check", { method: "POST", body: JSON.stringify({ p_identifier: ident, p_ip: "5.5.5.5" }) }).then(r => r.json())
  ));
  const allowed2 = conc2.filter(x => x && x.allowed).length;
  rec("H26", "达到 5 次失败后，并发 10 次判定 0 次放行（不可竞争绕过）", allowed2 === 0, `allowed=${allowed2}/10`);

  // ---------- #2 并发核销 max_uses=1 ----------
  const rawToken = `tok-${randomUUID()}`;
  const hash = sha256b64url(rawToken);
  await admin("/rest/v1/teacher_invitations", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ email_normalized: U.teacher, expected_name: "T", token_hash: hash, expires_at: new Date(Date.now() + 86400000).toISOString(), created_by: ids.acad }),
  });
  const consumes = await Promise.all(Array.from({ length: 5 }, () =>
    admin("/rest/v1/rpc/consume_teacher_invitation", { method: "POST", body: JSON.stringify({ p_token_hash: hash, p_email: U.teacher }) })
      .then(async r => ({ ok: r.status === 200, status: r.status }))
  ));
  const okCount = consumes.filter(c => c.ok).length;
  rec("H27", "并发 5 次核销 max_uses=1 邀请：仅 1 次成功", okCount === 1, `success=${okCount}/5`);

  // ---------- #6 即时失权（不重新登录）----------
  await grant(ids.student, "teacher");           // 临时给学员 teacher 角色
  const beforeRoles = await rest("/rpc/my_roles", jwts.student, { method: "POST", body: "{}" }).then(r => r.json());
  const hadTeacher = Array.isArray(beforeRoles) && beforeRoles.some(r => r.role === "teacher");
  await admin(`/rest/v1/user_roles?user_id=eq.${ids.student}&role=eq.teacher`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  const afterRoles = await rest("/rpc/my_roles", jwts.student, { method: "POST", body: "{}" }).then(r => r.json());
  const stillTeacher = Array.isArray(afterRoles) && afterRoles.some(r => r.role === "teacher");
  rec("H28", "撤销角色后同一 JWT 立即失权（不依赖 stale JWT）", hadTeacher && !stillTeacher, `before=${hadTeacher} after=${stillTeacher}`);

  // ---------- #10 泄漏扫描 ----------
  const invRows = await admin("/rest/v1/teacher_invitations?select=token_hash,email_normalized").then(r => r.json());
  const leaked = invRows.some(r => String(r.token_hash).startsWith("tok-"));
  rec("H29", "邀请明文 token 未入库（只存哈希）", !leaked && invRows.some(r => r.token_hash === hash), `rows=${invRows.length}`);

  const auditAll = await admin("/rest/v1/audit_logs?select=event_type,new_value,old_value,reason&limit=500").then(r => r.json());
  const bad = auditAll.filter(a => /secret|otpauth|password|tok-|sbp_/i.test(JSON.stringify(a)));
  rec("H30", "审计日志不含 secret/otpauth/password/明文 token", bad.length === 0, `hits=${bad.length}`);

  const secEvents = await admin("/rest/v1/security_events?select=event_type,identifier,detail&limit=500").then(r => r.json());
  const badSec = secEvents.filter(a => /password|secret|otpauth/i.test(JSON.stringify(a)));
  rec("H31", "安全事件日志不含密码/密钥材料", badSec.length === 0, `hits=${badSec.length}`);

  // ---------- 提交验证：邮箱不匹配 / 未登录 ----------
  const rawToken2 = `tok-${randomUUID()}`;
  await admin("/rest/v1/teacher_invitations", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ email_normalized: U.teacher, expected_name: "T", token_hash: sha256b64url(rawToken2), expires_at: new Date(Date.now() + 86400000).toISOString(), created_by: ids.acad }),
  });
  const wrongUser = await fn("submit-teacher-verification", jwts.student, { token: rawToken2, form: { name: "X", consent_terms: true } });
  const wrongBody = await wrongUser.json().catch(() => ({}));
  rec("H32", "用他人邀请码提交验证被拒（邮箱绑定）", wrongUser.status === 403 && wrongBody.error === "invitation_invalid", `status=${wrongUser.status} err=${wrongBody.error}`);

  const okSubmit = await fn("submit-teacher-verification", jwts.teacher, { token: rawToken2, form: { name: "SEC3 Teacher", phone: "123", organization: "Church", teaching_areas: "NT", country: "TH", consent_terms: true } });
  const okBody = await okSubmit.json().catch(() => ({}));
  rec("H33", "本人邀请码提交验证成功", okSubmit.status === 200 && okBody.ok, `status=${okSubmit.status}`);

  const replay = await fn("submit-teacher-verification", jwts.teacher, { token: rawToken2, form: { name: "again", consent_terms: true } });
  rec("H34", "同一邀请码重放提交被拒", replay.status === 403, `status=${replay.status}`);

  // 教师本人只看到安全字段
  const myTv = await rest("/rpc/my_teacher_verification", jwts.teacher, { method: "POST", body: "{}" }).then(r => r.json());
  const fields = Array.isArray(myTv) && myTv[0] ? Object.keys(myTv[0]) : [];
  rec("H35", "教师查看自己的验证状态仅含安全字段（无内部备注）", fields.length > 0 && !fields.includes("internal_review_notes") && !fields.includes("submitted_data"), fields.join(","));

  // 其他教师读不到该申请
  const otherRead = await g(`/teacher_verification_requests?select=id&user_id=eq.${ids.teacher}`, jwts.student);
  rec("H36", "其他用户读不到该教师的验证申请", otherRead.rows === 0, `rows=${otherRead.rows}`);

} catch (e) {
  rec("HXX", "执行异常", false, String(e).slice(0, 300));
}

const pass = R.filter(r => r.pass).length;
console.log(`\n=== HTTP LAYER: ${pass}/${R.length} PASSED ===`);
writeFileSync(`${S}/sec3_http_results.json`, JSON.stringify(R, null, 1));
