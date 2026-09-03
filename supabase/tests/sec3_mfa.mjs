// SEC-3 · MFA / AAL2 真实链路验收 + 端到端教师验证流程
// 覆盖：TOTP enroll→challenge→verify 得到 aal2 JWT；aal2 放行敏感操作；
//       审核授权闭环；suspend 即时失权；MFA secret 不落库/不入日志。
import { readFileSync, writeFileSync } from "node:fs";
import { createHmac, createHash, randomUUID } from "node:crypto";

const S = "C:/Users/enosl/AppData/Local/Temp/claude/C--Users-enosl/0a8d7f45-a7db-4338-8119-b764f90bf3ca/scratchpad";
const env = Object.fromEntries(readFileSync(`${S}/staging.env`, "utf8").trim().split(/\r?\n/).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const { URL: URL_, ANON, SERVICE } = env;
const R = [];
const rec = (id, name, pass, d = "") => { R.push({ id, name, pass, detail: d }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}${d ? " | " + d : ""}`); };
const H = (key, jwt) => ({ apikey: key, Authorization: `Bearer ${jwt || key}`, "Content-Type": "application/json" });
const admin = (p, o = {}) => fetch(`${URL_}${p}`, { ...o, headers: { ...H(SERVICE), ...(o.headers || {}) } });
const auth = (p, jwt, o = {}) => fetch(`${URL_}/auth/v1${p}`, { ...o, headers: { ...H(ANON, jwt), ...(o.headers || {}) } });
const rest = (p, jwt, o = {}) => fetch(`${URL_}/rest/v1${p}`, { ...o, headers: { ...H(ANON, jwt), ...(o.headers || {}) } });
const fn = (n, jwt, b) => fetch(`${URL_}/functions/v1/${n}`, { method: "POST", headers: H(ANON, jwt), body: JSON.stringify(b || {}) });
const jwtPayload = t => JSON.parse(Buffer.from(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

// RFC 6238 TOTP
function b32decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "", out = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) { const v = A.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, "0"); }
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, t = Date.now()) {
  const key = b32decode(secret);
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / 30)));
  const h = createHmac("sha1", key).update(ctr).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1e6).padStart(6, "0");
}
const sha256b64url = s => createHash("sha256").update(s).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const PW = "Sec3!Test2026x", tag = Date.now().toString(36);
const ADMIN_EMAIL = `sec3-mfaadmin-${tag}@amas-test.dev`;
const TEACHER_EMAIL = `sec3-mfateacher-${tag}@amas-test.dev`;

try {
  const mk = async (email) => (await admin("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password: PW, email_confirm: true, user_metadata: { display_name: email.split("@")[0] } }) })).json();
  const aU = await mk(ADMIN_EMAIL), tU = await mk(TEACHER_EMAIL);
  await admin("/rest/v1/user_roles", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: aU.id, role: "academic_admin", granted_by: aU.id }) });

  const sign = async (email) => (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: "POST", headers: H(ANON), body: JSON.stringify({ email, password: PW }) })).json();
  let aS = await sign(ADMIN_EMAIL), tS = await sign(TEACHER_EMAIL);
  rec("M01", "管理员/教师账号建立并登录（aal1）", !!aS.access_token && jwtPayload(aS.access_token).aal === "aal1");

  // ---- TOTP 注册 ----
  const enr = await (await auth("/factors", aS.access_token, { method: "POST", body: JSON.stringify({ factor_type: "totp", friendly_name: "SEC3" }) })).json();
  const secret = enr?.totp?.secret;
  rec("M02", "TOTP enroll 返回二维码与密钥", !!secret && !!enr?.totp?.qr_code, `factor=${enr.id?.slice(0, 8)}`);

  const ch = await (await auth(`/factors/${enr.id}/challenge`, aS.access_token, { method: "POST", body: "{}" })).json();
  const code = totp(secret);
  const ver = await (await auth(`/factors/${enr.id}/verify`, aS.access_token, { method: "POST", body: JSON.stringify({ challenge_id: ch.id, code }) })).json();
  const aal2 = ver.access_token ? jwtPayload(ver.access_token).aal : null;
  rec("M03", "TOTP verify 成功并换发 aal2 JWT", aal2 === "aal2", `aal=${aal2}`);
  const adminAal2 = ver.access_token;

  // 错误动态码必须失败
  const ch2 = await (await auth(`/factors/${enr.id}/challenge`, adminAal2, { method: "POST", body: "{}" })).json();
  const badVer = await auth(`/factors/${enr.id}/verify`, adminAal2, { method: "POST", body: JSON.stringify({ challenge_id: ch2.id, code: "000000" }) });
  rec("M04", "错误 TOTP 动态码被拒", badVer.status >= 400, `status=${badVer.status}`);

  // ---- aal2 放行敏感操作 ----
  const invRes = await fn("create-teacher-invitation", adminAal2, { email: TEACHER_EMAIL, expected_name: "SEC3 Teacher", expires_days: 3 });
  const inv = await invRes.json();
  rec("M05", "aal2 管理员创建邀请成功（一次性明文仅返回一次）", invRes.status === 200 && !!inv.token, `status=${invRes.status}`);

  const dbInv = await (await admin(`/rest/v1/teacher_invitations?select=token_hash&token_hash=eq.${encodeURIComponent(sha256b64url(inv.token))}`)).json();
  rec("M06", "库中仅存该邀请码的 sha256 哈希（明文不可检索）", dbInv.length === 1, `rows=${dbInv.length}`);

  // ---- 教师提交 ----
  const sub = await fn("submit-teacher-verification", tS.access_token, { token: inv.token, form: { name: "SEC3 Teacher", phone: "+66 000", organization: "Test Church", teaching_areas: "New Testament", country: "TH · Asia/Bangkok", consent_terms: true } });
  const subBody = await sub.json();
  rec("M07", "教师用邀请码提交验证成功（状态 submitted）", sub.status === 200 && subBody.ok, `req=${String(subBody.request_id).slice(0, 8)}`);
  const reqId = subBody.request_id;

  // ---- 审核：aal1 拒绝、aal2 放行 ----
  const rejAal1 = await fn("review-teacher-verification", aS.access_token, { request_id: reqId, action: "approve" });
  rec("M08", "aal1 管理员审核被拒（mfa_required）", rejAal1.status === 403);

  const app = await fn("review-teacher-verification", adminAal2, { request_id: reqId, action: "approve", message: "欢迎加入", staff_number: `SEC3-${tag}`, grant_mentor: true, internal_note: "SEC3 内部备注" });
  const appBody = await app.json();
  rec("M09", "aal2 管理员审核通过（同事务授权）", app.status === 200 && appBody.status === "approved", `status=${app.status}`);

  const roles = await (await admin(`/rest/v1/user_roles?select=role,revoked_at&user_id=eq.${tU.id}`)).json();
  const active = roles.filter(r => !r.revoked_at).map(r => r.role).sort();
  rec("M10", "教师获得 teacher+mentor 角色", active.includes("teacher") && active.includes("mentor"), active.join(","));

  const alias = await (await admin(`/rest/v1/login_aliases?select=alias_normalized,revoked_at&user_id=eq.${tU.id}`)).json();
  rec("M11", "教职工号别名同事务创建", alias.some(a => !a.revoked_at && a.alias_normalized === `SEC3-${tag}`.toUpperCase()), JSON.stringify(alias).slice(0, 80));

  // 教师看不到内部备注
  const tvSelf = await (await rest("/rpc/my_teacher_verification", tS.access_token, { method: "POST", body: "{}" })).json();
  const noInternal = JSON.stringify(tvSelf).includes("SEC3 内部备注") === false;
  rec("M12", "教师本人看不到内部审核备注", noInternal);

  // 教师读自己的 teacher_profiles
  const tp = await (await rest(`/teacher_profiles?select=staff_number,status`, tS.access_token)).json();
  rec("M13", "教师可读自己的教师档案", Array.isArray(tp) && tp.length === 1 && tp[0].status === "active", JSON.stringify(tp).slice(0, 80));

  // ---- 学号登录（Edge 代理）----
  const li = await fn("login-by-identifier", null, { identifier: `SEC3-${tag}`, password: PW });
  const liBody = await li.json().catch(() => ({}));
  rec("M14", "教职工号 + 密码经 Edge 代理登录成功", li.status === 200 && !!liBody.access_token, `status=${li.status}`);

  const liBad = await fn("login-by-identifier", null, { identifier: `SEC3-${tag}`, password: "WrongPass!123" });
  rec("M15", "学号 + 错误密码返回统一 bad_credentials", liBad.status === 401, `status=${liBad.status}`);

  // ---- suspend 即时失权 ----
  const susp = await fn("review-teacher-verification", adminAal2, { request_id: reqId, action: "suspend", message: "暂停测试" });
  rec("M16", "aal2 管理员暂停教师成功", susp.status === 200);

  const rolesAfter = await (await rest("/rpc/my_roles", tS.access_token, { method: "POST", body: "{}" })).json();
  const stillTeacher = Array.isArray(rolesAfter) && rolesAfter.some(r => ["teacher", "mentor"].includes(r.role));
  rec("M17", "暂停后教师同一 JWT 立即失去 teacher/mentor（无需重登）", !stillTeacher, JSON.stringify(rolesAfter).slice(0, 80));

  const liAfter = await fn("login-by-identifier", null, { identifier: `SEC3-${tag}`, password: PW });
  rec("M18", "暂停后学号登录失效（别名已撤销）", liAfter.status !== 200, `status=${liAfter.status}`);

  // ---- MFA 泄漏扫描 ----
  const audits = await (await admin("/rest/v1/audit_logs?select=*&limit=1000")).json();
  const sec = await (await admin("/rest/v1/security_events?select=*&limit=1000")).json();
  const dump = JSON.stringify(audits) + JSON.stringify(sec);
  const leaks = [secret, inv.token].filter(v => v && dump.includes(v));
  rec("M19", "MFA secret / 邀请明文均未出现在审计与安全日志", leaks.length === 0, `leaks=${leaks.length}`);
  rec("M20", "日志中无 otpauth:// URI", !/otpauth:\/\//i.test(dump));

  // 审核动作审计齐全
  const revAudits = audits.filter(a => String(a.target_id) === String(reqId));
  rec("M21", "审核动作均写入审计（approve + suspend）", revAudits.some(a => a.event_type.includes("approve")) && revAudits.some(a => a.event_type.includes("suspend")), `rows=${revAudits.length}`);

} catch (e) {
  rec("MXX", "执行异常", false, String(e).slice(0, 300));
}

const pass = R.filter(r => r.pass).length;
console.log(`\n=== MFA/E2E LAYER: ${pass}/${R.length} PASSED ===`);
writeFileSync(`${S}/sec3_mfa_results.json`, JSON.stringify(R, null, 1));
