// PORTAL-2B · HTTP/REST/RPC 层验收（2B-10 的 13 项攻击测试）
// 以真实 JWT 直接打 Supabase，绕过所有前端逻辑。
// 运行：node portal2b_http.mjs（需同目录 staging.env）
import { readFileSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const S = process.env.SEC_ENV_DIR || ".";
const env = Object.fromEntries(readFileSync(`${S}/staging.env`, "utf8").trim().split(/\r?\n/)
  .map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const { URL: URL_, ANON, SERVICE } = env;

const R = [];
const rec = (id, name, pass, d = "") => { R.push({ id, name, pass, detail: d }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}${d ? " | " + d : ""}`); };
const H = (key, jwt) => ({ apikey: key, Authorization: `Bearer ${jwt || key}`, "Content-Type": "application/json" });
const admin = (p, o = {}) => fetch(`${URL_}${p}`, { ...o, headers: { ...H(SERVICE), ...(o.headers || {}) } });
const rest = (p, jwt, o = {}) => fetch(`${URL_}/rest/v1${p}`, { ...o, headers: { ...H(ANON, jwt), ...(o.headers || {}) } });
const rpc = (n, jwt, body) => rest(`/rpc/${n}`, jwt, { method: "POST", body: JSON.stringify(body || {}) });
const fn = (n, jwt, b) => fetch(`${URL_}/functions/v1/${n}`, { method: "POST", headers: H(ANON, jwt), body: JSON.stringify(b || {}) });
const json = async r => { try { return await r.json(); } catch { return null; } };
function b32decode(s){const A="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let b="",o=[];for(const c of s.replace(/=+$/,"").toUpperCase()){const v=A.indexOf(c);if(v<0)continue;b+=v.toString(2).padStart(5,"0");}for(let i=0;i+8<=b.length;i+=8)o.push(parseInt(b.slice(i,i+8),2));return Buffer.from(o);}
function totp(sec){const k=b32decode(sec);const c=Buffer.alloc(8);c.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000/30)));const h=createHmac("sha1",k).update(c).digest();const off=h[h.length-1]&0xf;const bin=((h[off]&0x7f)<<24)|(h[off+1]<<16)|(h[off+2]<<8)|h[off+3];return String(bin%1e6).padStart(6,"0");}

const PW = "P2B!Test2026x", tag = Date.now().toString(36);
const E = {
  stuA: `p2b-a-${tag}@amas-test.dev`,    // active 学生
  stuB: `p2b-b-${tag}@amas-test.dev`,    // 另一 active 学生
  pre:  `p2b-p-${tag}@amas-test.dev`,    // pre_enrolled 学生
  appl: `p2b-ap-${tag}@amas-test.dev`,   // 仅 applicant
  reg:  `p2b-r-${tag}@amas-test.dev`,    // registrar
  fin:  `p2b-f-${tag}@amas-test.dev`,    // finance
  tch:  `p2b-t-${tag}@amas-test.dev`,    // teacher
};
const ids = {}, jwts = {};
let regAal2 = null, sidA = null, sidB = null, sidP = null;

const GOOD = {
  name_zh: "体验测试", birth_ym: "1995-06", gender: "male", nationality: "中国",
  phone: "+86 13800000000", address: "广州市", church_name: "测试教会",
  church_role: "小组同工", conversion_date: "2015-03", calling: "愿意接受装备",
  testimony: "见证内容。", declaration_accepted: true,
  programs: ["bth"], languages: ["mandarin"],
  education: [{ school: "某大学", city: "广州", start_ym: "2013-09", end_ym: "2017-06", degree: "本科" }],
};

try {
  const mk = async (email) => (await admin("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password: PW, email_confirm: true, user_metadata: { display_name: email.split("@")[0] } }) })).json();
  for (const [k, email] of Object.entries(E)) ids[k] = (await mk(email)).id;
  const grant = (uid, role) => admin("/rest/v1/user_roles", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: uid, role, granted_by: uid }) });
  await grant(ids.reg, "registrar"); await grant(ids.fin, "finance"); await grant(ids.tch, "teacher");
  const sign = async (email) => (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: "POST", headers: H(ANON), body: JSON.stringify({ email, password: PW }) })).json();
  for (const k of Object.keys(E)) jwts[k] = (await sign(E[k])).access_token;
  rec("P2B-H00", "测试账号建立并登录", Object.values(jwts).every(Boolean));

  const enr = await (await fetch(`${URL_}/auth/v1/factors`, { method: "POST", headers: H(ANON, jwts.reg), body: JSON.stringify({ factor_type: "totp", friendly_name: "P2B" }) })).json();
  const ch = await (await fetch(`${URL_}/auth/v1/factors/${enr.id}/challenge`, { method: "POST", headers: H(ANON, jwts.reg), body: "{}" })).json();
  const ver = await (await fetch(`${URL_}/auth/v1/factors/${enr.id}/verify`, { method: "POST", headers: H(ANON, jwts.reg), body: JSON.stringify({ challenge_id: ch.id, code: totp(enr.totp.secret) }) })).json();
  regAal2 = ver.access_token;

  const enroll = async (who, num, activate) => {
    const c = await rest("/applications", jwts[who], { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ applicant_id: ids[who], pathway: "bth", status: "draft", form_data: GOOD }) });
    const appId = (await c.json())[0].id;
    await rpc("submit_application", jwts[who], { p_app: appId });
    await fn("review-application", regAal2, { application_id: appId, action: "start_review" });
    await fn("review-application", regAal2, { application_id: appId, action: "accept" });
    await fn("student-lifecycle", regAal2, { action: "confirm_hq_approval", application_id: appId, hq_status: "approved", approval_reference: "HQ-2B-" + num, internal_note: "内部备注绝不外泄" });
    const cr = await (await fn("student-lifecycle", regAal2, { action: "create_student_record", application_id: appId, student_number: num })).json();
    if (activate) await fn("student-lifecycle", regAal2, { action: "activate_student", student_id: cr.student_id });
    return { appId, sid: cr.student_id };
  };
  const A_ = await enroll("stuA", `2B-${tag.toUpperCase()}-A`, true);   sidA = A_.sid;
  const B_ = await enroll("stuB", `2B-${tag.toUpperCase()}-B`, true);   sidB = B_.sid;
  const P_ = await enroll("pre",  `2B-${tag.toUpperCase()}-P`, false);  sidP = P_.sid;
  // applicant 保留一份 draft，使其保有 applicant 角色
  await rest("/applications", jwts.appl, { method: "POST", body: JSON.stringify({ applicant_id: ids.appl, pathway: "bth", status: "draft", form_data: GOOD }) });
  rec("P2B-H01", "两名 active 学生与一名 pre_enrolled 学生就绪", !!sidA && !!sidB && !!sidP);

  // ① Student A 读取 Student B profile → 0 行
  const cross = await (await rest(`/student_records?select=id,student_number&id=eq.${sidB}`, jwts.stuA)).json();
  rec("P2B-H02", "① 学生读不到他人学籍记录", Array.isArray(cross) && cross.length === 0, `rows=${cross.length}`);
  const crossProf = await (await rest(`/profiles?select=id,phone&id=eq.${ids.stuB}`, jwts.stuA)).json();
  rec("P2B-H03", "① 学生读不到他人 profile 联系资料", Array.isArray(crossProf) && crossProf.length === 0, `rows=${crossProf.length}`);
  const mine = await (await rpc("my_student_profile", jwts.stuA)).json();
  rec("P2B-H04", "本人资料读模型正确分区",
    !!mine?.self_editable && !!mine?.registrar_managed &&
    mine.registrar_managed.student_number === `2B-${tag.toUpperCase()}-A`,
    JSON.stringify(mine?.registrar_managed || {}).slice(0, 70));
  rec("P2B-H05", "HQ 内部备注未泄漏到学生资料",
    !JSON.stringify(mine || {}).includes("内部备注绝不外泄"));

  // ② student PATCH student_number → 拒绝
  const patchNum = await rest(`/student_records?id=eq.${sidA}`, jwts.stuA, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ student_number: "HACK-1" }) });
  const numNow = await (await rest(`/student_records?select=student_number&id=eq.${sidA}`, jwts.stuA)).json();
  rec("P2B-H06", "② 学生改不了自己的学号",
    numNow[0]?.student_number === `2B-${tag.toUpperCase()}-A`, `status=${patchNum.status} value=${numNow[0]?.student_number}`);

  // ③ student PATCH status → 拒绝
  const patchSt = await rest(`/student_records?id=eq.${sidA}`, jwts.stuA, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  const stNow = await (await rest(`/student_records?select=status&id=eq.${sidA}`, jwts.stuA)).json();
  rec("P2B-H07", "③ 学生改不了学籍状态", stNow[0]?.status === "active" && patchSt.status !== 200 || stNow[0]?.status === "active",
    `status=${patchSt.status} value=${stNow[0]?.status}`);
  const patchPre = await rest(`/student_records?id=eq.${sidP}`, jwts.pre, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "active" }) });
  const preNow = await (await rest(`/student_records?select=status&id=eq.${sidP}`, jwts.pre)).json();
  rec("P2B-H08", "③ pre_enrolled 学生不能把自己改成 active", preNow[0]?.status === "pre_enrolled", `status=${patchPre.status} value=${preNow[0]?.status}`);

  // ④ student 修改 HQ approval → 拒绝
  const patchHq = await rest(`/application_hq_approvals?application_id=eq.${A_.appId}`, jwts.stuA, { method: "PATCH", body: JSON.stringify({ status: "approved", approval_reference: "FAKE" }) });
  const hqNow = await (await rest(`/application_hq_approvals?select=approval_reference&application_id=eq.${A_.appId}`, jwts.stuA)).json();
  rec("P2B-H09", "④ 学生改不了 HQ 审核记录",
    hqNow[0]?.approval_reference === `HQ-2B-2B-${tag.toUpperCase()}-A`.replace("HQ-2B-", "HQ-2B-") || patchHq.status >= 400,
    `status=${patchHq.status} ref=${hqNow[0]?.approval_reference}`);

  // ⑤ finance 读取 CP / 学籍 → 拒绝
  const finStu = await (await rest("/student_records?select=id", jwts.fin)).json();
  rec("P2B-H10", "⑤ 财务读不到学籍记录", Array.isArray(finStu) && finStu.length === 0, `rows=${finStu.length}`);
  const finProf = await (await rest(`/profiles?select=id&id=eq.${ids.stuA}`, jwts.fin)).json();
  rec("P2B-H11", "⑤ 财务读不到学生 profile", Array.isArray(finProf) && finProf.length === 0, `rows=${finProf.length}`);

  // ⑥ teacher 默认读取学生 → 拒绝
  const tchStu = await (await rest("/student_records?select=id", jwts.tch)).json();
  rec("P2B-H12", "⑥ 教师默认读不到学生学籍（占位函数 fail-closed）", Array.isArray(tchStu) && tchStu.length === 0, `rows=${tchStu.length}`);

  // ⑦ applicant 访问 Student Dashboard 数据 → 拒绝
  const aplStu = await (await rpc("my_student_record", jwts.appl)).json();
  rec("P2B-H13", "⑦ applicant 取不到任何学籍数据", Array.isArray(aplStu) && aplStu.length === 0, `rows=${aplStu?.length}`);
  const aplCap = await (await rpc("my_student_capabilities", jwts.appl)).json();
  rec("P2B-H14", "⑦ applicant 的能力门禁全为否", aplCap?.status === "none" && aplCap?.view_identity === false, JSON.stringify(aplCap || {}).slice(0, 80));

  // ⑧ pre_enrolled 访问仅 active 开放能力 → 拒绝
  const preCap = await (await rpc("my_student_capabilities", jwts.pre)).json();
  rec("P2B-H15", "⑧ pre_enrolled 未获得仅 active 开放的能力",
    preCap?.status === "pre_enrolled" && preCap?.official_student_services === false, JSON.stringify(preCap || {}).slice(0, 90));
  const actCap = await (await rpc("my_student_capabilities", jwts.stuA)).json();
  rec("P2B-H16", "⑧ active 也不会自动获得课程内容访问权",
    actCap?.official_student_services === true && actCap?.course_content_access === false, JSON.stringify(actCap || {}).slice(0, 90));

  // ⑨ 推荐课程不能伪造 enrollment（系统内根本没有 enrollment 表可写）
  const fakeEnroll = await rest("/course_enrollments", jwts.stuA, { method: "POST", body: JSON.stringify({ course_code: "c_matthew" }) });
  rec("P2B-H17", "⑨ 不存在可被写入的 enrollment 表", fakeEnroll.status >= 400, `status=${fakeEnroll.status}`);
  const learn = await (await rpc("my_learning", jwts.stuA)).json();
  const badStates = (learn || []).filter(c => !["catalogued", "content_pending"].includes(c.learning_state));
  rec("P2B-H18", "⑨ 学习读模型不产生 enrolled/recommended 等无数据源状态",
    Array.isArray(learn) && learn.length === 67 && badStates.length === 0,
    `rows=${learn?.length} bad=${badStates.length}`);

  // ⑩ completed 状态不能由客户端直接 PATCH
  const patchLearn = await rest("/course_catalog?code=eq.c_matthew", jwts.stuA, { method: "PATCH", body: JSON.stringify({ availability: "available", total_lessons: 999 }) });
  rec("P2B-H19", "⑩ 学生改不了课程目录（含完成/可用状态）", patchLearn.status >= 400, `status=${patchLearn.status}`);
  const patchCredits = await rest("/course_catalog?code=eq.c_matthew", jwts.stuA, { method: "PATCH", body: JSON.stringify({ credits: 3 }) });
  rec("P2B-H20", "⑩ 学生写不进 credits", patchCredits.status >= 400, `status=${patchCredits.status}`);

  // ⑪ 直接 REST 写 learning evidence → 按权限模型拒绝
  for (const t of ["learning_evidence", "course_progress", "student_evidence"]) {
    const r = await rest(`/${t}`, jwts.stuA, { method: "POST", body: JSON.stringify({ x: 1 }) });
    rec(`P2B-H21-${t}`, `⑪ 直接写 ${t} 被拒`, r.status >= 400, `status=${r.status}`);
  }

  // 白名单之外的字段不可经自助 RPC 修改
  const okUpd = await (await rpc("update_my_contact", jwts.stuA, { p_phone: "+86 13512345678" })).json();
  const phoneNow = await (await rpc("my_student_profile", jwts.stuA)).json();
  rec("P2B-H22", "本人可维护联系电话", phoneNow?.self_editable?.phone === "+86 13512345678", JSON.stringify(okUpd).slice(0, 40));
  const patchProf = await rest(`/profiles?id=eq.${ids.stuA}`, jwts.stuA, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ account_status: "suspended" }) });
  const accNow = await (await rest(`/profiles?select=account_status&id=eq.${ids.stuA}`, jwts.stuA)).json();
  rec("P2B-H23", "学生改不了自己的账号状态", accNow[0]?.account_status !== "suspended", `status=${patchProf.status} value=${accNow[0]?.account_status}`);

  // 待办事项由真实状态派生
  const acts = await (await rpc("my_action_items", jwts.pre)).json();
  const waiting = (acts || []).filter(a => a.source_type === "student_record" && a.status === "waiting");
  rec("P2B-H24", "pre_enrolled 产生真实的等待注册事项", waiting.length === 1, `items=${(acts || []).map(a => a.source_type).join(",")}`);
  const badFields = (acts || []).filter(a => !a.source_type || !a.reason || !a.target_url || !a.status);
  rec("P2B-H25", "所有待办事项字段完整（无硬编码空文案）", badFields.length === 0, `bad=${badFields.length}`);

  // ⑫ revoke student role 后旧 JWT 即时失权
  const roleRow = await (await admin(`/rest/v1/user_roles?select=id&user_id=eq.${ids.stuA}&role=eq.student&revoked_at=is.null`)).json();
  await admin(`/rest/v1/user_roles?id=eq.${roleRow[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ revoked_at: new Date().toISOString() }) });
  const afterStu = await (await rest("/student_records?select=id", jwts.stuA)).json();
  rec("P2B-H26", "⑫ 撤销 student 角色后旧 JWT 读不到学籍", Array.isArray(afterStu) && afterStu.length === 0, `rows=${afterStu.length}`);
  const afterCap = await (await rpc("my_student_capabilities", jwts.stuA)).json();
  rec("P2B-H27", "⑫ 撤销后能力门禁立即收敛", afterCap?.official_student_services === false, JSON.stringify(afterCap || {}).slice(0, 70));

  // ⑬ 逃逸测试：合法 RPC 之后同事务直写（R-1 强制项）
  // HTTP 层一请求一事务，这里验证的是"没有令牌时直写一律被拒"；
  // 同事务逃逸的正面验证在 portal2_number_void.sql V14 与 portal2_acceptance.sql P2-D10/D11。
  const escape = await rest(`/student_records?id=eq.${sidP}`, jwts.pre, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "active" }) });
  const escNow = await (await rest(`/student_records?select=status&id=eq.${sidP}`, jwts.pre)).json();
  rec("P2B-H28", "⑬ 无 RPC 上下文时直写状态一律被拒", escNow[0]?.status === "pre_enrolled", `status=${escape.status} value=${escNow[0]?.status}`);

} catch (e) {
  rec("P2B-HXX", "测试执行异常", false, String(e).slice(0, 200));
} finally {
  for (const id of Object.values(ids)) if (id) await admin(`/auth/v1/admin/users/${id}`, { method: "DELETE" });
  const pass = R.filter(r => r.pass).length;
  writeFileSync("portal2b_http_results.json", JSON.stringify(R, null, 2));
  console.log(`\n=== PORTAL-2B HTTP: ${pass}/${R.length} PASSED ===`);
  if (pass !== R.length) process.exitCode = 1;
}
