// PORTAL-1 · HTTP/REST/Edge 层验收（P1-01…P1-24 中可自动化的部分）
// 运行：node portal1_http.mjs（需同目录 staging.env：URL / ANON / SERVICE）
import { readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";

const S = process.env.SEC_ENV_DIR || ".";
const env = Object.fromEntries(readFileSync(`${S}/staging.env`, "utf8").trim().split(/\r?\n/).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const { URL: URL_, ANON, SERVICE } = env;
const R = [];
const rec = (id, name, pass, d = "") => { R.push({ id, name, pass, detail: d }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}${d ? " | " + d : ""}`); };
const H = (key, jwt) => ({ apikey: key, Authorization: `Bearer ${jwt || key}`, "Content-Type": "application/json" });
const admin = (p, o = {}) => fetch(`${URL_}${p}`, { ...o, headers: { ...H(SERVICE), ...(o.headers || {}) } });
const rest = (p, jwt, o = {}) => fetch(`${URL_}/rest/v1${p}`, { ...o, headers: { ...H(ANON, jwt), ...(o.headers || {}) } });
const rpc = (n, jwt, body) => rest(`/rpc/${n}`, jwt, { method: "POST", body: JSON.stringify(body || {}) });
const fn = (n, jwt, b) => fetch(`${URL_}/functions/v1/${n}`, { method: "POST", headers: H(ANON, jwt), body: JSON.stringify(b || {}) });
const jwtPayload = t => JSON.parse(Buffer.from(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

// TOTP（用于把管理员升到 aal2）
function b32decode(s){const A="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let b="",o=[];for(const c of s.replace(/=+$/,"").toUpperCase()){const v=A.indexOf(c);if(v<0)continue;b+=v.toString(2).padStart(5,"0");}for(let i=0;i+8<=b.length;i+=8)o.push(parseInt(b.slice(i,i+8),2));return Buffer.from(o);}
function totp(sec,t=Date.now()){const k=b32decode(sec);const c=Buffer.alloc(8);c.writeBigUInt64BE(BigInt(Math.floor(t/1000/30)));const h=createHmac("sha1",k).update(c).digest();const off=h[h.length-1]&0xf;const bin=((h[off]&0x7f)<<24)|(h[off+1]<<16)|(h[off+2]<<8)|h[off+3];return String(bin%1e6).padStart(6,"0");}

const PW = "P1!Test2026x", tag = Date.now().toString(36);
const E = {
  ap:  `p1-ap-${tag}@amas-test.dev`,
  ap2: `p1-ap2-${tag}@amas-test.dev`,
  reg: `p1-reg-${tag}@amas-test.dev`,
  tch: `p1-tch-${tag}@amas-test.dev`,
};
const ids = {}, jwts = {};
let appId = null, adminAal2 = null;

const GOOD = {
  name_zh: "测试申请人", birth_ym: "1995-06", gender: "male", nationality: "中国",
  phone: "+86 13800000000", address: "广州市", church_name: "测试教会",
  church_role: "小组同工", conversion_date: "2015-03", calling: "愿意接受装备",
  testimony: "见证内容。", declaration_accepted: true,
  programs: ["bth"], languages: ["mandarin"],
  education: [{ school: "某大学", city: "广州", start_ym: "2013-09", end_ym: "2017-06", degree: "本科" }],
};

try {
  const mk = async (email) => (await admin("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password: PW, email_confirm: true, user_metadata: { display_name: email.split("@")[0] } }) })).json();
  for (const [k, email] of Object.entries(E)) ids[k] = (await mk(email)).id;
  await admin("/rest/v1/user_roles", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: ids.reg, role: "registrar", granted_by: ids.reg }) });
  await admin("/rest/v1/user_roles", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: ids.tch, role: "teacher", granted_by: ids.tch }) });
  const sign = async (email) => (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: "POST", headers: H(ANON), body: JSON.stringify({ email, password: PW }) })).json();
  for (const k of Object.keys(E)) jwts[k] = (await sign(E[k])).access_token;
  rec("P1-H00", "测试账号建立并登录", Object.values(jwts).every(Boolean));

  // ---------- 目录（D-2 canonical）----------
  const pcAnon = await (await rest("/program_catalog?select=code,is_open_for_application")).json();
  rec("P1-H01", "program_catalog 公开可读且含 9 个项目", Array.isArray(pcAnon) && pcAnon.length === 9, `rows=${pcAnon.length}`);
  const pcWrite = await rest("/program_catalog", jwts.ap, { method: "POST", body: JSON.stringify({ code: "hack", name_zh: "x", name_en: "x", category: "degree" }) });
  rec("P1-H02", "普通用户不可写 program_catalog", pcWrite.status >= 400, `status=${pcWrite.status}`);

  // ---------- 建草稿 ----------
  const cr = await rest("/applications", jwts.ap, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ applicant_id: ids.ap, pathway: "bth", status: "draft", form_data: GOOD }) });
  const crBody = await cr.json();
  appId = Array.isArray(crBody) ? crBody[0]?.id : crBody?.id;
  rec("P1-H03", "申请人可创建自己的草稿", cr.status === 201 && !!appId, `status=${cr.status}`);

  // 冒名建档
  const crFake = await rest("/applications", jwts.ap, { method: "POST", body: JSON.stringify({ applicant_id: ids.ap2, pathway: "bth", status: "draft" }) });
  rec("P1-H04", "不能替他人创建申请", crFake.status >= 400, `status=${crFake.status}`);

  // 直接建 submitted
  const crSub = await rest("/applications", jwts.ap2, { method: "POST", body: JSON.stringify({ applicant_id: ids.ap2, pathway: "bth", status: "submitted" }) });
  rec("P1-H05", "不能直接以 submitted 状态创建", crSub.status >= 400, `status=${crSub.status}`);

  // ---------- D-4/5/6 服务端剥离 ----------
  await rest(`/applications?id=eq.${appId}`, jwts.ap, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ form_data: { ...GOOD, church_type: "家庭", health: "高血压", family: [{ name: "母亲" }] } }) });
  const chk = await (await rest(`/applications?id=eq.${appId}&select=form_data`, jwts.ap)).json();
  const fd = chk[0]?.form_data || {};
  rec("P1-H06", "D-4/5/6 禁止字段被服务端剥离（前端篡改无效）", !("church_type" in fd) && !("health" in fd) && !("family" in fd), Object.keys(fd).join(","));

  // ---------- 跨用户读写 ----------
  const cross = await (await rest(`/applications?select=id`, jwts.ap2)).json();
  rec("P1-H07", "跨用户读不到他人申请", Array.isArray(cross) && cross.every(r => r.id !== appId), `rows=${cross.length}`);
  const crossPatch = await rest(`/applications?id=eq.${appId}`, jwts.ap2, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ form_data: { hacked: true } }) });
  const cpBody = await crossPatch.json().catch(() => []);
  rec("P1-H08", "跨用户改他人申请无效", crossPatch.status >= 400 || (Array.isArray(cpBody) && cpBody.length === 0), `status=${crossPatch.status} rows=${Array.isArray(cpBody) ? cpBody.length : "-"}`);

  // 教师也读不到
  const tRead = await (await rest("/applications?select=id", jwts.tch)).json();
  rec("P1-H09", "教师读不到招生申请", Array.isArray(tRead) && tRead.length === 0, `rows=${tRead.length}`);

  // ---------- 直接改状态 ----------
  const selfStatus = await rest(`/applications?id=eq.${appId}`, jwts.ap, { method: "PATCH", body: JSON.stringify({ status: "accepted" }) });
  rec("P1-H10", "申请人直接 REST 改状态被拒", selfStatus.status >= 400, `status=${selfStatus.status}`);

  // ---------- 提交 ----------
  const sub = await (await rpc("submit_application", jwts.ap, { p_app: appId })).json();
  rec("P1-H11", "提交成功并进入 submitted", sub.ok === true && sub.status === "submitted", JSON.stringify(sub).slice(0, 80));

  const dup = await rpc("submit_application", jwts.ap, { p_app: appId });
  rec("P1-H12", "重复提交被拒", dup.status >= 400, `status=${dup.status}`);

  // 提交后：申请人不可编辑（RLS 仅放行 draft / needs_information），且锁定字段实际未变
  const lock = await rest(`/applications?id=eq.${appId}`, jwts.ap, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ form_data: { ...GOOD, name_zh: "改名字" } }) });
  const lockBody = await lock.json().catch(() => []);
  const afterLock = await (await rest(`/applications?id=eq.${appId}&select=form_data`, jwts.ap)).json();
  rec("P1-H13", "提交后申请人编辑被 RLS 阻断（0 行受影响）", (Array.isArray(lockBody) && lockBody.length === 0) || lock.status >= 400, `status=${lock.status} rows=${Array.isArray(lockBody) ? lockBody.length : "-"}`);
  rec("P1-H14", "锁定字段值确实未被修改", afterLock[0]?.form_data?.name_zh === GOOD.name_zh, `name_zh=${afterLock[0]?.form_data?.name_zh}`);

  // ---------- 审核鉴权 ----------
  const byApplicant = await fn("review-application", jwts.ap, { application_id: appId, action: "accept" });
  rec("P1-H15", "申请人调审核函数被拒", byApplicant.status === 403, `status=${byApplicant.status}`);
  const byTeacher = await fn("review-application", jwts.tch, { application_id: appId, action: "accept" });
  rec("P1-H16", "教师调审核函数被拒", byTeacher.status === 403, `status=${byTeacher.status}`);
  const aal1 = await fn("review-application", jwts.reg, { application_id: appId, action: "start_review" });
  const aal1b = await aal1.json().catch(() => ({}));
  rec("P1-H17", "AAL1 教务审核被拒（mfa_required）", aal1.status === 403 && aal1b.error === "mfa_required", `status=${aal1.status} err=${aal1b.error}`);
  const noJwt = await fn("review-application", null, { application_id: appId, action: "accept" });
  rec("P1-H18", "无用户 JWT 调审核函数被拒", [401, 403].includes(noJwt.status), `status=${noJwt.status}`);
  const rpcDirect = await rpc("review_application", jwts.reg, { p_app: appId, p_reviewer: ids.reg, p_action: "accept" });
  rec("P1-H19", "authenticated 直呼 review_application RPC 被拒", rpcDirect.status >= 400, `status=${rpcDirect.status}`);

  // ---------- 管理员升 aal2 ----------
  const enr = await (await fetch(`${URL_}/auth/v1/factors`, { method: "POST", headers: H(ANON, jwts.reg), body: JSON.stringify({ factor_type: "totp", friendly_name: "P1" }) })).json();
  const ch = await (await fetch(`${URL_}/auth/v1/factors/${enr.id}/challenge`, { method: "POST", headers: H(ANON, jwts.reg), body: "{}" })).json();
  const ver = await (await fetch(`${URL_}/auth/v1/factors/${enr.id}/verify`, { method: "POST", headers: H(ANON, jwts.reg), body: JSON.stringify({ challenge_id: ch.id, code: totp(enr.totp.secret) }) })).json();
  adminAal2 = ver.access_token;
  rec("P1-H20", "教务完成 MFA 取得 aal2", jwtPayload(adminAal2).aal === "aal2");

  // ---------- 审核流程 ----------
  const sr = await fn("review-application", adminAal2, { application_id: appId, action: "start_review" });
  rec("P1-H21", "aal2 教务可开始审核", sr.status === 200, `status=${sr.status}`);

  const emptyReq = await fn("review-application", adminAal2, { application_id: appId, action: "needs_information", requirements: [] });
  rec("P1-H22", "要求补充资料必须至少一条", emptyReq.status === 400, `status=${emptyReq.status}`);

  // field: baptism_date —— 审核员要求订正的正是锁定字段，须被精确解锁（migration 0011）
  const ni = await fn("review-application", adminAal2, { application_id: appId, action: "needs_information", message: "请补充受洗日期", requirements: [{ label: "受洗日期", detail: "请填写年月", field: "baptism_date" }], internal_note: "内部：材料不全" });
  rec("P1-H23", "要求补充资料成功并创建条目", ni.status === 200, `status=${ni.status}`);

  const lockRow = await (await rest(`/applications?select=locked_fields&id=eq.${appId}`, jwts.ap)).json();
  const lockNow = (Array.isArray(lockRow) && lockRow[0] && lockRow[0].locked_fields) || [];
  rec("P1-H23b", "被要求补充的字段已从锁定表移除",
    !lockNow.includes("baptism_date") && lockNow.includes("name_zh"), `locked=${lockNow.join(",")}`);

  const reqs = await (await rest(`/application_requirements?select=id,resolved&application_id=eq.${appId}`, jwts.ap)).json();
  rec("P1-H24", "申请人可见补件条目", Array.isArray(reqs) && reqs.length === 1, `rows=${reqs.length}`);

  const blocked = await (await rpc("submit_application", jwts.ap, { p_app: appId })).json();
  rec("P1-H25", "未完成补件不得重新提交", blocked.ok === false && blocked.error === "requirements_pending", JSON.stringify(blocked).slice(0, 60));

  // needs_information 阶段：被解锁字段可改、其余锁定字段仍被拒
  const FIXED = { ...GOOD, baptism_date: "2016-05" };
  const niEdit = await rest(`/applications?id=eq.${appId}`, jwts.ap, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ form_data: FIXED }) });
  const niBody = await niEdit.json().catch(() => []);
  rec("P1-H25b", "被解锁字段可由申请人订正",
    Array.isArray(niBody) && niBody.length === 1 && niBody[0].form_data.baptism_date === "2016-05",
    `rows=${Array.isArray(niBody) ? niBody.length : "-"} body=${JSON.stringify(niBody).slice(0, 80)}`);
  const niLocked = await rest(`/applications?id=eq.${appId}`, jwts.ap, { method: "PATCH", body: JSON.stringify({ form_data: { ...FIXED, name_zh: "又改名" } }) });
  rec("P1-H25c", "未被解锁的锁定字段仍不可改", niLocked.status >= 400, `status=${niLocked.status}`);

  await rpc("resolve_requirement", jwts.ap, { p_req: reqs[0].id });
  const resub = await (await rpc("submit_application", jwts.ap, { p_app: appId })).json();
  rec("P1-H26", "完成补件后可重新提交", resub.ok === true, JSON.stringify(resub).slice(0, 60));

  const relock = await (await rest(`/applications?select=locked_fields&id=eq.${appId}`, jwts.ap)).json();
  const relockNow = (Array.isArray(relock) && relock[0] && relock[0].locked_fields) || [];
  rec("P1-H26b", "重新提交后字段再次全量锁定", relockNow.includes("baptism_date"), `locked=${relockNow.join(",")}`);

  // 他人不能标记补件完成
  const otherResolve = await rpc("resolve_requirement", jwts.ap2, { p_req: reqs[0].id });
  rec("P1-H27", "他人不能标记补件完成", otherResolve.status >= 400, `status=${otherResolve.status}`);

  // ---------- 内部备注隔离 ----------
  const intByApplicant = await (await rest(`/application_internal?select=notes`, jwts.ap)).json();
  rec("P1-H28", "申请人读不到内部备注", Array.isArray(intByApplicant) && intByApplicant.length === 0, `rows=${intByApplicant.length}`);
  const intByAdmin = await (await rest(`/application_internal?select=notes`, adminAal2)).json();
  rec("P1-H29", "管理员可读内部备注", Array.isArray(intByAdmin) && intByAdmin.length >= 1, `rows=${intByAdmin.length}`);

  // 时间线：申请人视图不含 internal_note
  const tl = await (await rpc("my_application_timeline", jwts.ap, { p_app: appId })).json();
  const tlStr = JSON.stringify(tl);
  rec("P1-H30", "申请人时间线不含内部备注", !tlStr.includes("内部：材料不全") && Array.isArray(tl) && tl.length >= 3, `rows=${tl.length}`);
  const colTry = await rest(`/application_status_history?select=internal_note&application_id=eq.${appId}`, jwts.ap);
  rec("P1-H31", "申请人不能选取 internal_note 列", colTry.status >= 400, `status=${colTry.status}`);

  // ---------- 录取 ----------
  const acc = await fn("review-application", adminAal2, { application_id: appId, action: "accept", message: "恭喜录取", internal_note: "内部：通过" });
  rec("P1-H32", "aal2 教务可录取", acc.status === 200, `status=${acc.status}`);

  const after = await (await rest(`/applications?id=eq.${appId}&select=status,decided_at`, adminAal2)).json();
  rec("P1-H33", "录取后状态与 decided_at 正确", after[0]?.status === "accepted" && !!after[0]?.decided_at);

  const term = await fn("review-application", adminAal2, { application_id: appId, action: "start_review" });
  rec("P1-H34", "终态不可再流转", term.status === 409, `status=${term.status}`);

  // 录取后申请人不可再改
  const editAfter = await rest(`/applications?id=eq.${appId}`, jwts.ap, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ form_data: { ...GOOD, gifts: "改" } }) });
  const eaBody = await editAfter.json().catch(() => []);
  rec("P1-H35", "录取后申请人不可再编辑", editAfter.status >= 400 || (Array.isArray(eaBody) && eaBody.length === 0), `status=${editAfter.status}`);

  // ---------- 审计 ----------
  const audits = await (await admin(`/rest/v1/audit_logs?select=event_type,category&target_id=eq.${appId}`)).json();
  const cats = new Set(audits.map(a => a.category));
  rec("P1-H36", "审核动作写入 admissions 类审计", audits.length >= 4 && cats.has("admissions"), `rows=${audits.length}`);
  const auditByApplicant = await (await rest("/audit_logs?select=id", jwts.ap)).json();
  rec("P1-H37", "申请人读不到审计日志", Array.isArray(auditByApplicant) && auditByApplicant.length === 0, `rows=${auditByApplicant.length}`);

  // ---------- 撤回 + 唯一活动申请 ----------
  const app2 = await (await rest("/applications", jwts.ap2, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ applicant_id: ids.ap2, pathway: "common_learning", status: "draft", form_data: GOOD }) })).json();
  const app2Id = app2[0]?.id;
  const dupCreate = await rest("/applications", jwts.ap2, { method: "POST", body: JSON.stringify({ applicant_id: ids.ap2, pathway: "bth", status: "draft" }) });
  rec("P1-H38", "同一用户不能有两个活动申请", dupCreate.status >= 400, `status=${dupCreate.status}`);

  const wd = await (await rpc("withdraw_application", jwts.ap2, { p_app: app2Id, p_reason: "测试撤回" })).json();
  rec("P1-H39", "申请人可撤回申请", wd.ok === true);
  const afterWd = await rest("/applications", jwts.ap2, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ applicant_id: ids.ap2, pathway: "bth", status: "draft", form_data: GOOD }) });
  rec("P1-H40", "撤回后可创建新申请", afterWd.status === 201, `status=${afterWd.status}`);

  // ---------- 撤销角色即时失权 ----------
  await admin(`/rest/v1/user_roles?user_id=eq.${ids.reg}&role=eq.registrar`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ revoked_at: new Date().toISOString() }) });
  const afterRevoke = await fn("review-application", adminAal2, { application_id: app2Id, action: "start_review" });
  rec("P1-H41", "撤销 registrar 后同一 aal2 JWT 立即失权", afterRevoke.status === 403, `status=${afterRevoke.status}`);

} catch (e) {
  rec("P1-HXX", "执行异常", false, String(e).slice(0, 300));
}

const pass = R.filter(r => r.pass).length;
console.log(`\n=== PORTAL-1 HTTP: ${pass}/${R.length} PASSED ===`);
writeFileSync(`${S}/portal1_http_results.json`, JSON.stringify(R, null, 1));
