// PORTAL-2 · HTTP/REST/RPC/Edge 层验收（P2-9 攻击清单 + P2-11 生命周期用例）
// 以真实 JWT 直接打 Supabase，绕过所有前端逻辑。
// 运行：node portal2_http.mjs（需同目录 staging.env：URL / ANON / SERVICE）
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
const jwtPayload = t => JSON.parse(Buffer.from(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
const json = async r => { try { return await r.json(); } catch { return null; } };

function b32decode(s){const A="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let b="",o=[];for(const c of s.replace(/=+$/,"").toUpperCase()){const v=A.indexOf(c);if(v<0)continue;b+=v.toString(2).padStart(5,"0");}for(let i=0;i+8<=b.length;i+=8)o.push(parseInt(b.slice(i,i+8),2));return Buffer.from(o);}
function totp(sec,t=Date.now()){const k=b32decode(sec);const c=Buffer.alloc(8);c.writeBigUInt64BE(BigInt(Math.floor(t/1000/30)));const h=createHmac("sha1",k).update(c).digest();const off=h[h.length-1]&0xf;const bin=((h[off]&0x7f)<<24)|(h[off+1]<<16)|(h[off+2]<<8)|h[off+3];return String(bin%1e6).padStart(6,"0");}

const PW = "P2!Test2026x", tag = Date.now().toString(36);
const E = {
  ap:  `p2-ap-${tag}@amas-test.dev`,     // 申请人 → 学生
  ap2: `p2-ap2-${tag}@amas-test.dev`,    // 另一申请人 → 另一学生
  reg: `p2-reg-${tag}@amas-test.dev`,    // registrar
  fin: `p2-fin-${tag}@amas-test.dev`,    // finance
  tch: `p2-tch-${tag}@amas-test.dev`,    // teacher
  ap3: `p2-ap3-${tag}@amas-test.dev`,    // 学号被误录的申请人（纠错流程）
  sup: `p2-sup-${tag}@amas-test.dev`,    // super_admin —— 纠错流程的第二人
  reg2:`p2-reg2-${tag}@amas-test.dev`,   // 第二个 registrar —— 验证两名教务不足以释放学号
  ap4: `p2-ap4-${tag}@amas-test.dev`,    // 真正应当拿到该学号的人
};
const ids = {}, jwts = {};
let appId = null, app2Id = null, stuId = null, stu2Id = null, regAal2 = null, supAal2 = null, reg2Aal2 = null;
const NUM = `AMAS-${tag.toUpperCase()}-1`;
const NUM2 = `AMAS-${tag.toUpperCase()}-2`;

const GOOD = {
  name_zh: "学籍测试", birth_ym: "1995-06", gender: "male", nationality: "中国",
  phone: "+86 13800000000", address: "广州市", church_name: "测试教会",
  church_role: "小组同工", conversion_date: "2015-03", calling: "愿意接受装备",
  testimony: "见证内容。", declaration_accepted: true,
  programs: ["bth"], languages: ["mandarin"],
  education: [{ school: "某大学", city: "广州", start_ym: "2013-09", end_ym: "2017-06", degree: "本科" }],
};

try {
  // ============ 0. 种子：账号 + 角色 + 两份 accepted 申请 ============
  const mk = async (email) => (await admin("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password: PW, email_confirm: true, user_metadata: { display_name: email.split("@")[0] } }) })).json();
  for (const [k, email] of Object.entries(E)) ids[k] = (await mk(email)).id;
  const grant = (uid, role) => admin("/rest/v1/user_roles", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: uid, role, granted_by: uid }) });
  await grant(ids.reg, "registrar");
  await grant(ids.sup, "super_admin");
  await grant(ids.reg2, "registrar");
  await grant(ids.fin, "finance");
  await grant(ids.tch, "teacher");
  const sign = async (email) => (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: "POST", headers: H(ANON), body: JSON.stringify({ email, password: PW }) })).json();
  for (const k of Object.keys(E)) jwts[k] = (await sign(E[k])).access_token;
  rec("P2-H00", "测试账号建立并登录", Object.values(jwts).every(Boolean));

  // registrar 升 aal2
  const enr = await (await fetch(`${URL_}/auth/v1/factors`, { method: "POST", headers: H(ANON, jwts.reg), body: JSON.stringify({ factor_type: "totp", friendly_name: "P2" }) })).json();
  const ch = await (await fetch(`${URL_}/auth/v1/factors/${enr.id}/challenge`, { method: "POST", headers: H(ANON, jwts.reg), body: "{}" })).json();
  const ver = await (await fetch(`${URL_}/auth/v1/factors/${enr.id}/verify`, { method: "POST", headers: H(ANON, jwts.reg), body: JSON.stringify({ challenge_id: ch.id, code: totp(enr.totp.secret) }) })).json();
  regAal2 = ver.access_token;
  rec("P2-H01", "教务完成 MFA 取得 aal2", jwtPayload(regAal2).aal === "aal2");

  const upgrade = async (who) => {
    const e = await (await fetch(`${URL_}/auth/v1/factors`, { method: "POST", headers: H(ANON, jwts[who]), body: JSON.stringify({ factor_type: "totp", friendly_name: "P2" }) })).json();
    const c = await (await fetch(`${URL_}/auth/v1/factors/${e.id}/challenge`, { method: "POST", headers: H(ANON, jwts[who]), body: "{}" })).json();
    const vv = await (await fetch(`${URL_}/auth/v1/factors/${e.id}/verify`, { method: "POST", headers: H(ANON, jwts[who]), body: JSON.stringify({ challenge_id: c.id, code: totp(e.totp.secret) }) })).json();
    return vv.access_token;
  };
  supAal2 = await upgrade("sup");
  reg2Aal2 = await upgrade("reg2");
  rec("P2-H01b", "super_admin 与第二教务均取得 aal2",
    jwtPayload(supAal2).aal === "aal2" && jwtPayload(reg2Aal2).aal === "aal2");

  // 走真实招生闭环把两份申请推到 accepted
  const mkApp = async (who, pathway) => {
    const c = await rest("/applications", jwts[who], { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ applicant_id: ids[who], pathway, status: "draft", form_data: GOOD }) });
    const id = (await c.json())[0].id;
    await rpc("submit_application", jwts[who], { p_app: id });
    await fn("review-application", regAal2, { application_id: id, action: "start_review" });
    await fn("review-application", regAal2, { application_id: id, action: "accept", message: "录取" });
    return id;
  };
  appId = await mkApp("ap", "bth");
  app2Id = await mkApp("ap2", "common_learning");
  const stAcc = await (await rest(`/applications?select=status&id=eq.${appId}`, jwts.ap)).json();
  rec("P2-H02", "两份申请已推进到 accepted", stAcc[0]?.status === "accepted", `status=${stAcc[0]?.status}`);

  // ============ 1. HQ 审核门禁（P2-2）============
  const noHq = await fn("student-lifecycle", regAal2, { action: "create_student_record", application_id: appId, student_number: NUM });
  const noHqB = await json(noHq);
  rec("P2-H03", "无总校确认不得建档", noHqB?.ok === false && noHqB?.error === "hq_approval_required", JSON.stringify(noHqB).slice(0, 70));

  const stuAny = await (await rest(`/student_records?select=id`, jwts.ap)).json();
  rec("P2-H04", "被拒建档没有留下任何学籍记录", Array.isArray(stuAny) && stuAny.length === 0, `rows=${stuAny.length}`);

  // 申请人自己伪造 HQ 确认
  const fakeHq = await rest("/application_hq_approvals", jwts.ap, { method: "POST", body: JSON.stringify({ application_id: appId, status: "approved" }) });
  rec("P2-H05", "申请人不能直接写 HQ 审核表", fakeHq.status >= 400, `status=${fakeHq.status}`);

  // AAL1 教务
  const aal1 = await fn("student-lifecycle", jwts.reg, { action: "confirm_hq_approval", application_id: appId, hq_status: "approved" });
  const aal1B = await json(aal1);
  rec("P2-H06", "AAL1 教务办学籍动作被拒", aal1.status === 403 && aal1B?.error === "mfa_required", `status=${aal1.status} err=${aal1B?.error}`);

  // 非管理员
  for (const [who, label] of [["ap", "申请人"], ["tch", "教师"], ["fin", "财务"]]) {
    const r = await fn("student-lifecycle", jwts[who], { action: "create_student_record", application_id: appId });
    rec(`P2-H07-${who}`, `${label}调学籍函数被拒`, r.status === 403, `status=${r.status}`);
  }
  const noTok = await fetch(`${URL_}/functions/v1/student-lifecycle`, { method: "POST", headers: H(ANON), body: JSON.stringify({ action: "create_student_record", application_id: appId }) });
  rec("P2-H08", "无用户 JWT 调学籍函数被拒", noTok.status === 401, `status=${noTok.status}`);

  // 直呼特权 RPC
  for (const name of ["create_student_record", "activate_student", "correct_student_number", "confirm_hq_approval"]) {
    const r = await rpc(name, jwts.reg, {});
    rec(`P2-H09-${name}`, `authenticated 直呼 ${name} 被拒`, r.status >= 400, `status=${r.status}`);
  }

  // ============ 2. 建档闭环 ============
  const hq = await fn("student-lifecycle", regAal2, { action: "confirm_hq_approval", application_id: appId, hq_status: "approved", approval_reference: "HQ-TEST-1", visible_note: "总校已确认", internal_note: "内部：批文归档" });
  rec("P2-H10", "aal2 教务可记录总校确认", hq.status === 200, `status=${hq.status}`);

  const cre = await fn("student-lifecycle", regAal2, { action: "create_student_record", application_id: appId, student_number: NUM });
  const creB = await json(cre);
  stuId = creB?.student_id;
  rec("P2-H11", "总校确认后可建档且为 pre_enrolled", creB?.ok === true && creB?.status === "pre_enrolled", JSON.stringify(creB).slice(0, 80));

  const dup = await json(await fn("student-lifecycle", regAal2, { action: "create_student_record", application_id: appId, student_number: NUM2 }));
  rec("P2-H12", "重复建档被拒", dup?.ok === false && dup?.error === "student_already_exists", JSON.stringify(dup).slice(0, 60));

  // ============ 3. 角色转换（P2-4）============
  const meRoles = await (await rpc("my_roles", jwts.ap)).json();
  // 旧 JWT 的角色由 DB 现查，撤销即时生效
  const roleNames = (meRoles || []).map(r => r.role ?? r);
  rec("P2-H13", "建档后取得 student 角色", roleNames.includes("student"), `roles=${roleNames.join(",")}`);
  rec("P2-H14", "无其他活动申请时 applicant 角色被撤销", !roleNames.includes("applicant"), `roles=${roleNames.join(",")}`);

  // ============ 4. 学号规则（P2-3）============
  const hq2 = await fn("student-lifecycle", regAal2, { action: "confirm_hq_approval", application_id: app2Id, hq_status: "approved", approval_reference: "HQ-TEST-2" });
  const dupNum = await json(await fn("student-lifecycle", regAal2, { action: "create_student_record", application_id: app2Id, student_number: ` ${NUM.toLowerCase()} ` }));
  rec("P2-H15", "重复学号被拒（归一化后相同）", dupNum?.ok === false && dupNum?.error === "student_number_taken", JSON.stringify(dupNum).slice(0, 60));

  const cre2 = await json(await fn("student-lifecycle", regAal2, { action: "create_student_record", application_id: app2Id, student_number: NUM2 }));
  stu2Id = cre2?.student_id;
  rec("P2-H16", "第二名学生建档成功", cre2?.ok === true, JSON.stringify(cre2).slice(0, 60));

  // 学生自己改学号
  const selfNum = await rest(`/student_records?id=eq.${stuId}`, jwts.ap, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ student_number: "HACK-1" }) });
  const selfNumB = await json(selfNum);
  const numNow = await (await rest(`/student_records?select=student_number&id=eq.${stuId}`, jwts.ap)).json();
  rec("P2-H17", "学生不能修改自己的学号",
    (!Array.isArray(selfNumB) || selfNumB.length === 0) && numNow[0]?.student_number === NUM,
    `patched=${Array.isArray(selfNumB) ? selfNumB.length : "err"} value=${numNow[0]?.student_number}`);

  // 更正必须给原因
  const noReason = await fn("student-lifecycle", regAal2, { action: "correct_student_number", student_id: stuId, student_number: "AMAS-X-9", reason: "   " });
  rec("P2-H18", "学号更正缺原因被拒", noReason.status === 400, `status=${noReason.status}`);

  const NUM3 = `AMAS-${tag.toUpperCase()}-3`;
  const corr = await json(await fn("student-lifecycle", regAal2, { action: "correct_student_number", student_id: stuId, student_number: NUM3, reason: "总校更正编号" }));
  rec("P2-H19", "教务可更正学号", corr?.ok === true && corr?.student_number === NUM3, JSON.stringify(corr).slice(0, 60));

  const reuse = await json(await fn("student-lifecycle", regAal2, { action: "correct_student_number", student_id: stu2Id, student_number: NUM, reason: "试图回收旧号" }));
  rec("P2-H20", "已释放的旧学号不得回收给他人", reuse?.ok === false && reuse?.error === "student_number_taken", JSON.stringify(reuse).slice(0, 60));

  // ============ 5. 状态机（P2-1）============
  const restAct = await rest(`/student_records?id=eq.${stuId}`, jwts.ap, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "active" }) });
  const restActB = await json(restAct);
  const stNow = await (await rest(`/student_records?select=status&id=eq.${stuId}`, jwts.ap)).json();
  rec("P2-H21", "学生不能直接把自己改成 active",
    (!Array.isArray(restActB) || restActB.length === 0) && stNow[0]?.status === "pre_enrolled",
    `patched=${Array.isArray(restActB) ? restActB.length : "err"} status=${stNow[0]?.status}`);

  const regRest = await rest(`/student_records?id=eq.${stuId}`, regAal2, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "active" }) });
  rec("P2-H22", "教务绕过 RPC 直接 REST 改状态也被拒", regRest.status >= 400, `status=${regRest.status}`);

  const act = await json(await fn("student-lifecycle", regAal2, { action: "activate_student", student_id: stuId, message: "学籍已生效", internal_note: "内部：已通知班主任" }));
  rec("P2-H23", "教务经 RPC 正式激活成功", act?.ok === true && act?.status === "active", JSON.stringify(act).slice(0, 60));

  const reAct = await json(await fn("student-lifecycle", regAal2, { action: "activate_student", student_id: stuId }));
  rec("P2-H24", "已 active 不得重复激活", reAct?.ok === false && reAct?.error === "invalid_state", JSON.stringify(reAct).slice(0, 60));

  // 无学号不得激活
  const noNum = await json(await fn("student-lifecycle", regAal2, { action: "create_student_record", application_id: app2Id }));
  const act2 = await json(await fn("student-lifecycle", regAal2, { action: "activate_student", student_id: stu2Id }));
  rec("P2-H25", "第二名学生有学号，可正常激活", act2?.ok === true, JSON.stringify(act2).slice(0, 60));

  // ============ 6. RLS / 越权读取（P2-9）============
  const cross = await (await rest(`/student_records?select=id,student_number&id=eq.${stu2Id}`, jwts.ap)).json();
  rec("P2-H26", "学生读不到他人学籍记录", Array.isArray(cross) && cross.length === 0, `rows=${cross.length}`);

  const mine = await (await rpc("my_student_record", jwts.ap)).json();
  rec("P2-H27", "学生可读自己的学籍记录", Array.isArray(mine) && mine.length === 1 && mine[0].status === "active", JSON.stringify(mine).slice(0, 80));

  const finRead = await (await rest("/student_records?select=id", jwts.fin)).json();
  rec("P2-H28", "财务读不到学籍记录", Array.isArray(finRead) && finRead.length === 0, `rows=${finRead.length}`);

  const tchRead = await (await rest("/student_records?select=id", jwts.tch)).json();
  rec("P2-H29", "教师读不到未授权学生（占位函数 fail-closed）", Array.isArray(tchRead) && tchRead.length === 0, `rows=${tchRead.length}`);

  const anonRead = await rest("/student_records?select=id");
  const anonBody = await json(anonRead);
  rec("P2-H30", "匿名读不到学籍记录", !Array.isArray(anonBody) || anonBody.length === 0, `status=${anonRead.status}`);

  const regRead = await (await rest("/student_records?select=id,student_number", regAal2)).json();
  rec("P2-H31", "教务可读全部学籍记录", Array.isArray(regRead) && regRead.length >= 2, `rows=${regRead.length}`);

  const registry = await rest("/student_number_registry?select=normalized", regAal2);
  rec("P2-H32", "学号登记簿对任何客户端不可读", registry.status >= 400 || (await json(registry) || []).length === 0, `status=${registry.status}`);

  // 内部备注隔离
  const noteCol = await rest(`/student_status_history?select=internal_note&student_id=eq.${stuId}`, jwts.ap);
  rec("P2-H33", "学生不能选取 internal_note 列", noteCol.status === 403 || noteCol.status === 400, `status=${noteCol.status}`);

  const tl = await (await rpc("my_student_timeline", jwts.ap)).json();
  const tlLeak = JSON.stringify(tl || []).includes("已通知班主任");
  rec("P2-H34", "学生时间线不含内部备注", Array.isArray(tl) && tl.length >= 2 && !tlLeak, `rows=${tl.length} leak=${tlLeak}`);

  const hqInternal = await (await rest(`/hq_approval_internal?select=notes&application_id=eq.${appId}`, jwts.ap)).json();
  rec("P2-H35", "申请人读不到总校内部备注", Array.isArray(hqInternal) && hqInternal.length === 0, `rows=${hqInternal.length}`);

  const hqOwn = await (await rest(`/application_hq_approvals?select=status,applicant_visible_note&application_id=eq.${appId}`, jwts.ap)).json();
  rec("P2-H36", "申请人可见自己的总校结论", Array.isArray(hqOwn) && hqOwn.length === 1 && hqOwn[0].status === "approved", JSON.stringify(hqOwn).slice(0, 70));

  // 历史 append-only
  const histPatch = await rest(`/student_status_history?student_id=eq.${stuId}`, regAal2, { method: "PATCH", body: JSON.stringify({ to_status: "pre_enrolled" }) });
  rec("P2-H37", "状态历史不可改写", histPatch.status >= 400, `status=${histPatch.status}`);

  // 待建档队列
  const queueAdmin = await (await rpc("admissions_ready_for_enrollment", regAal2)).json();
  const queueStudent = await (await rpc("admissions_ready_for_enrollment", jwts.ap)).json();
  rec("P2-H38", "待建档队列：学生看到 0 行", Array.isArray(queueStudent) && queueStudent.length === 0, `rows=${queueStudent.length}`);
  rec("P2-H39", "待建档队列：已建档者不再出现", Array.isArray(queueAdmin) && !queueAdmin.some(q => q.application_id === appId), `rows=${queueAdmin.length}`);

  // ============ 7. 审计（P2-11）============
  const auditStudent = await (await rest(`/audit_logs?select=id&target_id=eq.${stuId}`, jwts.ap)).json();
  rec("P2-H40", "学生读不到审计日志", Array.isArray(auditStudent) && auditStudent.length === 0, `rows=${auditStudent.length}`);

  const auditAdmin = await (await rest(`/audit_logs?select=event_type,old_value,new_value,reason&target_id=eq.${stuId}&order=created_at`, regAal2)).json();
  const evts = (auditAdmin || []).map(a => a.event_type);
  rec("P2-H41", "建档/更正/激活均写入审计",
    evts.includes("student_record_created") && evts.includes("student_number_corrected") && evts.includes("student_activated"),
    `events=${evts.join(",")}`);
  const corrAudit = (auditAdmin || []).find(a => a.event_type === "student_number_corrected");
  rec("P2-H42", "学号更正审计含前后值与原因",
    corrAudit?.old_value?.student_number === NUM && corrAudit?.new_value?.student_number === NUM3 && corrAudit?.reason === "总校更正编号",
    JSON.stringify(corrAudit || {}).slice(0, 100));

  // 敏感值不得进审计
  const auditAll = await (await rest(`/audit_logs?select=old_value,new_value,reason&limit=200&order=created_at.desc`, regAal2)).json();
  const leak = (auditAll || []).filter(a => /secret|otpauth|password/i.test(JSON.stringify(a)));
  rec("P2-H43", "审计中无 MFA secret / 口令等敏感值", leak.length === 0, `hits=${leak.length}`);

  // ============ 7.5 学号纯行政误录纠错：双人控制（0015）============
  // 第三名学生：建档时被"误录"成 VOID_WRONG，真正该拿这个号的是另一个人
  const VOID_WRONG = `AMAS-${tag.toUpperCase()}-W`;
  const VOID_RIGHT = `AMAS-${tag.toUpperCase()}-R`;
  const app3Id = await mkApp("ap3", "bth");
  await fn("student-lifecycle", regAal2, { action: "confirm_hq_approval", application_id: app3Id, hq_status: "approved", approval_reference: "HQ-V" });
  const cre3 = await json(await fn("student-lifecycle", regAal2, { action: "create_student_record", application_id: app3Id, student_number: VOID_WRONG }));
  const stu3Id = cre3?.student_id;
  rec("P2-H47", "第三名学生建档（学号被误录）", cre3?.ok === true, JSON.stringify(cre3).slice(0, 60));

  // 缺依据 / 缺原因
  const noEv = await fn("student-lifecycle", regAal2, { action: "request_number_void", student_id: stu3Id, replacement_number: VOID_RIGHT, reason: "手误" });
  rec("P2-H48", "纠错申请缺 HQ 依据被拒", noEv.status === 400, `status=${noEv.status}`);

  // teacher / finance / applicant 不得发起
  for (const [who, label] of [["ap", "学生"], ["fin", "财务"], ["tch", "教师"]]) {
    const r = await fn("student-lifecycle", jwts[who], { action: "request_number_void", student_id: stu3Id, replacement_number: VOID_RIGHT, reason: "x", evidence_reference: "y" });
    rec(`P2-H49-${who}`, `${label}不得发起学号纠错`, r.status === 403, `status=${r.status}`);
  }

  // registrar 发起
  const vreq = await json(await fn("student-lifecycle", regAal2, { action: "request_number_void", student_id: stu3Id, replacement_number: VOID_RIGHT, reason: "总校实际分配为 R，录入手误", evidence_reference: "HQ-LETTER-2026-09" }));
  rec("P2-H50", "registrar 可发起纠错申请", vreq?.ok === true && vreq?.status === "pending", JSON.stringify(vreq).slice(0, 70));
  const vreqId = vreq?.request_id;

  // 发起人自己确认 → 拒绝
  const selfAppr = await json(await fn("student-lifecycle", regAal2, { action: "approve_number_void", request_id: vreqId }));
  rec("P2-H51", "发起人不得确认自己的申请", selfAppr?.ok === false && selfAppr?.error === "same_actor_not_allowed", JSON.stringify(selfAppr).slice(0, 70));

  // 另一名 registrar 确认 → 拒绝（两人之中必须有 super_admin）
  const reg2Appr = await json(await fn("student-lifecycle", reg2Aal2, { action: "approve_number_void", request_id: vreqId }));
  rec("P2-H52", "两名 registrar 不足以释放学号", reg2Appr?.ok === false && reg2Appr?.error === "super_admin_required", JSON.stringify(reg2Appr).slice(0, 70));

  // 号码在确认前仍被占用：真正的持有人也拿不到（必须是"号被占"，不是别的原因）
  const app4Id = await mkApp("ap4", "bth");
  await fn("student-lifecycle", regAal2, { action: "confirm_hq_approval", application_id: app4Id, hq_status: "approved", approval_reference: "HQ-V4" });
  const takenBefore = await json(await fn("student-lifecycle", regAal2, { action: "create_student_record", application_id: app4Id, student_number: VOID_WRONG }));
  rec("P2-H53", "确认前误录号仍被占用",
    takenBefore?.ok === false && takenBefore?.error === "student_number_taken", JSON.stringify(takenBefore).slice(0, 70));

  // super_admin 确认
  const appr = await json(await fn("student-lifecycle", supAal2, { action: "approve_number_void", request_id: vreqId, note: "已核对总校批文" }));
  rec("P2-H54", "super_admin 确认后完成纠错",
    appr?.ok === true && appr?.student_number === VOID_RIGHT && appr?.voided_number === VOID_WRONG,
    JSON.stringify(appr).slice(0, 90));

  // 重复确认
  const reAppr = await json(await fn("student-lifecycle", supAal2, { action: "approve_number_void", request_id: vreqId }));
  rec("P2-H55", "同一申请不得重复确认", reAppr?.ok === false && reAppr?.error === "invalid_state", JSON.stringify(reAppr).slice(0, 60));

  // 学生看到的是新号
  const stu3Now = await (await rest(`/student_records?select=student_number&id=eq.${stu3Id}`, regAal2)).json();
  rec("P2-H56", "学籍记录已换成正确学号", stu3Now[0]?.student_number === VOID_RIGHT, `value=${stu3Now[0]?.student_number}`);

  // 别名同步
  const al3 = await (await admin(`/rest/v1/login_aliases?select=alias_normalized,revoked_at&user_id=eq.${ids.ap3}`)).json();
  const activeAl = (al3 || []).filter(a => !a.revoked_at).map(a => a.alias_normalized);
  rec("P2-H57", "登录别名同步换成新号",
    activeAl.length === 1 && activeAl[0] === VOID_RIGHT.toUpperCase().replace(/\s+/g, ""),
    `active=${activeAl.join(",")}`);

  // 被 void 的号可以重新分配给真正的持有人
  const reassign = await json(await fn("student-lifecycle", regAal2, { action: "create_student_record", application_id: app4Id, student_number: VOID_WRONG }));
  rec("P2-H58", "voided_clerical_error 的号可重新分配给正确的人", reassign?.ok === true, JSON.stringify(reassign).slice(0, 70));

  // 已 active 的学生不得申请纠错
  const onActive = await json(await fn("student-lifecycle", regAal2, { action: "request_number_void", student_id: stuId, replacement_number: `AMAS-${tag.toUpperCase()}-Z`, reason: "想改", evidence_reference: "X" }));
  rec("P2-H59", "已 active 学生不得申请纠错", onActive?.ok === false && onActive?.error === "student_not_pre_enrolled", JSON.stringify(onActive).slice(0, 70));

  // 客户端不得直接写申请表 / registry
  const patchReq = await rest(`/student_number_void_requests?id=eq.${vreqId}`, supAal2, { method: "PATCH", body: JSON.stringify({ status: "pending" }) });
  rec("P2-H60", "super_admin 也不能直接 PATCH 纠错申请", patchReq.status >= 400, `status=${patchReq.status}`);
  const patchReg = await rest(`/student_number_registry?normalized=eq.${encodeURIComponent(VOID_WRONG)}`, supAal2, { method: "PATCH", body: JSON.stringify({ state: "voided_clerical_error" }) });
  rec("P2-H61", "super_admin 也不能直接 PATCH 学号登记簿", patchReg.status >= 400, `status=${patchReg.status}`);

  // 审计
  const vAudit = await (await rest(`/audit_logs?select=event_type,old_value,new_value,reason&target_id=eq.${stu3Id}&order=created_at`, supAal2)).json();
  const ev = (vAudit || []).map(a => a.event_type);
  const apprAudit = (vAudit || []).find(a => a.event_type === "student_number_void_approved");
  rec("P2-H62", "纠错的发起与确认都写入审计",
    ev.includes("student_number_void_requested") && ev.includes("student_number_void_approved"), `events=${ev.join(",")}`);
  rec("P2-H63", "确认审计含前后值、发起人与依据",
    apprAudit?.old_value?.student_number === VOID_WRONG &&
    apprAudit?.new_value?.student_number === VOID_RIGHT &&
    apprAudit?.new_value?.initiated_by === ids.reg &&
    !!apprAudit?.new_value?.evidence && !!apprAudit?.reason,
    JSON.stringify(apprAudit || {}).slice(0, 120));

  // ============ 8. 即时失权（P2-9 ⑩）============
  const roleRow = await (await admin(`/rest/v1/user_roles?select=id&user_id=eq.${ids.reg}&role=eq.registrar&revoked_at=is.null`)).json();
  await admin(`/rest/v1/user_roles?id=eq.${roleRow[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ revoked_at: new Date().toISOString() }) });
  const afterRevoke = await fn("student-lifecycle", regAal2, { action: "activate_student", student_id: stu2Id });
  rec("P2-H44", "撤销 registrar 后同一 aal2 JWT 立即失权", afterRevoke.status === 403, `status=${afterRevoke.status}`);

  const readAfter = await (await rest("/student_records?select=id", regAal2)).json();
  rec("P2-H45", "失权后旧 JWT 也读不到学籍记录", Array.isArray(readAfter) && readAfter.length === 0, `rows=${readAfter.length}`);

  // ============ 9. 学生角色撤销 → 学号别名同步失权（P2-3）============
  const stuRole = await (await admin(`/rest/v1/user_roles?select=id&user_id=eq.${ids.ap}&role=eq.student&revoked_at=is.null`)).json();
  await admin(`/rest/v1/user_roles?id=eq.${stuRole[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ revoked_at: new Date().toISOString() }) });
  const alias = await (await admin(`/rest/v1/login_aliases?select=alias_normalized,revoked_at&user_id=eq.${ids.ap}`)).json();
  const stillActive = (alias || []).filter(a => !a.revoked_at);
  rec("P2-H46", "撤销 student 角色即撤销学号登录别名", stillActive.length === 0, `active_aliases=${stillActive.length}`);

} catch (e) {
  rec("P2-HXX", "测试执行异常", false, String(e).slice(0, 200));
} finally {
  // 清理测试数据
  for (const id of Object.values(ids)) {
    if (id) await admin(`/auth/v1/admin/users/${id}`, { method: "DELETE" });
  }
  const pass = R.filter(r => r.pass).length;
  writeFileSync("portal2_http_results.json", JSON.stringify(R, null, 2));
  console.log(`\n=== PORTAL-2 HTTP: ${pass}/${R.length} PASSED ===`);
  if (pass !== R.length) process.exitCode = 1;
}
