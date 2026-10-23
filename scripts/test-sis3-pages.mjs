#!/usr/bin/env node
// 学员管理系统补全页面的本地功能测试（本机 stub，见 lib/sis-harness.mjs）：
//   学习记录打印（学员 / 教务）、角色管理、学业总览里的外校转入学分、课程班授课次数、成绩与进度的转入学分与打印入口。
// 运行：node scripts/test-sis3-pages.mjs [--shots]
import { startHarness, sleep } from "./lib/sis-harness.mjs";

const h = await startHarness({ profilePrefix: "amas-sis3-", shotPrefix: "sis3" });
const { ok, open, txt, click, setVal, ev, rpcCalls, armFn, fnCalls, shot, send } = h;
const SID = "22222222-2222-4222-8222-222222222222";
const ADMIN = { session: { user: { id: "u-admin", email: "a@example.invalid" } }, aal: "aal2" };
const SUPER = { session: { user: { id: "u-super", email: "s@example.invalid" } }, aal: "aal2" };
const STU = { session: { user: { id: "s-u1", email: "st@example.invalid" } }, aal: "aal1" };
const TR = { name: "张学一", student_number: "B26-001", program_name: "神学学士", status: "active", activated_at: "2026-10-01T00:00:00Z",
  course_credits: 6, practicum_credits: 2, transfer_credits: 3, credits_earned: 11, credits_required: 77, gpa: 3.15,
  courses: [{ academic_year: "2026-2027", title_zh: "马太福音", credits: 3, grade: "A-", points: 3.7, passing: true },
            { academic_year: "2026-2027", title_zh: "罗马书", credits: 3, grade: "B-", points: 2.7, passing: true }],
  transfers: [{ title_zh: "四福音概论", credits: 3, evidence: "原校成绩单 2024-01" }],
  practicum: [{ title_zh: "祷告训练", credits: 2, done: true, completed_on: "2026-10-10" }, { title_zh: "读经训练", credits: 1, done: false }],
  graduation: null };

try {
  // ═══ P 学习记录 ═══
  console.log("\n=== P 学习记录（成绩单）===");
  await open("portal/student/transcript/", Object.assign({}, STU, { rpc: { my_roles: { data: [{ role: "student" }] }, my_transcript: { data: TR } } }));
  let t = await txt();
  ok("P1 身份、课程、转入、实践训练齐全", t.includes("张学一") && t.includes("B26-001") && t.includes("马太福音") && t.includes("A-") &&
     t.includes("四福音概论") && t.includes("原校成绩单") && t.includes("祷告训练") && !t.includes("读经训练"));
  ok("P2 合计与 GPA", t.includes("11 / 77") && t.includes("3.15"));
  ok("P3 不冒充正式成绩单", t.includes("正式成绩单以 AMAS 出具并盖章的版本为准"));
  await ev(`window.__printed = 0; window.print = function(){ window.__printed++; }; true`);
  await click("#print");
  ok("P4 打印按钮调用浏览器打印", (await ev("window.__printed")) === 1);
  await send("Emulation.setEmulatedMedia", { media: "print" });
  ok("P5 打印时隐藏导航、顶栏与按钮", await ev(`["nav.pn","header.ph",".no-print"].every(s => { const e = document.querySelector(s); return !e || getComputedStyle(e).display === "none"; })`));
  await send("Emulation.setEmulatedMedia", { media: "" });
  await shot("transcript");
  await open("portal/student/transcript/", Object.assign({}, STU, { rpc: { my_roles: { data: [{ role: "student" }] }, my_transcript: { error: { message: "x" } } } }));
  ok("P6 读失败如实说", (await txt()).includes("没能读到你的学习记录"));
  await open("portal/admin/transcript/?id=" + SID, Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] }, admin_transcript: { data: TR } } }));
  const c0 = await rpcCalls("admin_transcript");
  ok("P7 教务打印指定学员", (await txt()).includes("张学一") && c0[0]?.args.p_student === SID);

  // ═══ R 角色管理 ═══
  console.log("\n=== R 角色管理 ===");
  const roleScen = (rpc = {}) => Object.assign({}, SUPER, { rpc: Object.assign({ my_roles: { data: [{ role: "super_admin" }] },
    admin_list_staff: { data: [{ user_id: "u-super", display_name: "我", email: "s@example.invalid", roles: ["super_admin"] },
                               { user_id: "u-reg", display_name: "王教务", email: "w@example.invalid", roles: ["registrar"] }] },
    admin_find_user: { data: [{ user_id: "u-new", display_name: "新同工", email: "n@example.invalid", roles: ["applicant"] }] } }, rpc) });
  await open("portal/admin/roles/", roleScen());
  t = await txt();
  ok("R1 同工名单显示现有身份", t.includes("王教务") && t.includes("教务"));
  ok("R2 自己那一行不给任何按钮", (await ev(`document.querySelectorAll('[data-u="u-super"]').length`)) === 0 && t.includes("（你自己）"));
  ok("R3 已有教务身份的人给「撤销教务」", await ev(`!!document.querySelector('[data-u="u-reg"][data-r="registrar"][data-g="0"]')`));
  ok("R4 不提供授予超级管理员或教授的按钮", (await ev(`document.querySelectorAll('[data-r="super_admin"],[data-r="teacher"]').length`)) === 0);
  await setVal("#em", "not-an-email"); await click("#ff [type=submit]"); await sleep(300);
  ok("R5 邮箱不完整不查询", (await rpcCalls("admin_find_user")).length === 0 && (await txt()).includes("请输入完整的邮箱地址"));
  await setVal("#em", "n@example.invalid"); await click("#ff [type=submit]"); await sleep(500);
  ok("R6 按邮箱查到人", (await rpcCalls("admin_find_user"))[0]?.args.p_email === "n@example.invalid" && (await txt()).includes("新同工"));
  await armFn("ok", { ok: true });
  await click('#hit [data-u="u-new"][data-r="mentor"]'); await sleep(200);
  await click(".portal-modal [data-ok]"); await sleep(200);
  ok("R7 不写原因不发出", (await fnCalls()).length === 0);
  await setVal("#ask-reason", "新任导师"); await click(".portal-modal [data-ok]"); await sleep(700);
  let f = await fnCalls();
  ok("R8 授予导师：动作、对象、原因", f.length === 1 && f[0].body.action === "set_staff_role" && f[0].body.user_id === "u-new" &&
     f[0].body.role === "mentor" && f[0].body.grant === true && f[0].body.reason === "新任导师", JSON.stringify(f));
  await armFn("reject", { error: "cannot_change_self" });
  await click('#staff [data-u="u-reg"][data-r="registrar"]'); await sleep(200);
  await setVal("#ask-reason", "卸任"); await click(".portal-modal [data-ok]"); await sleep(700);
  f = await fnCalls();
  ok("R9 撤销请求 grant=false，服务端拒绝时照实说明", f[0]?.body.grant === false && (await txt()).includes("不能修改自己的身份"));
  await open("portal/admin/roles/", Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] } } }));
  ok("R10 教务进不了角色管理", !(await txt()).includes("按邮箱查找账号"));
  await open("portal/admin/roles/", roleScen({ admin_list_staff: { error: { message: "x" } } }));
  ok("R11 名单读失败不说成没有同工", (await txt()).includes("这不表示没有同工"));
  await shot("roles");

  // ═══ X 外校转入学分 ═══
  console.log("\n=== X 学业总览：外校转入 ===");
  const OVR = { status: "active", program_code: "bth", credits_required: 77, min_gpa: 2.0, credits_earned: 11, course_credits: 6,
    practicum_credits: 2, transfer_credits: 3, gpa: 3.15, eligible: false, practicum: [], mentors: [], graduation: null,
    missing_courses: [{ code: "c_romans", title_zh: "罗马书", credits: 3 }, { code: "c_acts", title_zh: "使徒行传", credits: 3 }],
    transfers: [{ ledger_id: 41, title_zh: "四福音概论", credits: 3, evidence: "原校成绩单", revoked: false },
                { ledger_id: 42, title_zh: null, credits: 5, reason: "证明不符", revoked: true }] };
  const ovScen = Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] }, admin_student_overview: { data: OVR },
    admin_list_students: { data: [{ student_id: SID, display_name: "张学一", student_number: "B26-001", status: "active" }] } } });
  await open("portal/admin/student/?id=" + SID, ovScen);
  t = await txt();
  ok("X1 列出转入记录，已撤回的标出且不给按钮", t.includes("四福音概论") && t.includes("已撤回") &&
     (await ev(`document.querySelectorAll("[data-rv]").length`)) === 1);
  ok("X2 学分说明含外校转入、有打印入口", t.includes("外校转入 3 学分") && (await ev(`!!document.querySelector('a[href*="portal/admin/transcript/?id=${SID}"]')`)));
  await armFn("ok", { ok: true, ledger_id: 43, credits: 3 });
  await click("#tx1"); await sleep(200);
  ok("X3 免修只能从未修必修课里选", (await ev(`[...document.querySelectorAll("#ask-c option")].map(o=>o.value).join()`)) === ",c_romans,c_acts");
  await setVal("#ask-c", "c_acts"); await setVal("#ask-reason", "外校已修"); await setVal("#ask-ev", "原校成绩单 2023"); await click(".portal-modal [data-ok]"); await sleep(700);
  f = await fnCalls();
  ok("X4 免修请求带课程、原因与依据", f.length === 1 && f[0].body.action === "add_transfer" && f[0].body.course_code === "c_acts" &&
     f[0].body.evidence === "原校成绩单 2023" && f[0].body.credits === undefined, JSON.stringify(f));
  await open("portal/admin/student/?id=" + SID, ovScen);
  await armFn("ok", { ok: true, ledger_id: 44, credits: 3 });
  await click("#tx2"); await sleep(200);
  await setVal("#ask-cr", "40"); await setVal("#ask-reason", "外校选修"); await click(".portal-modal [data-ok]"); await sleep(400);
  ok("X5 学分超出范围不发出", (await fnCalls()).length === 0 && (await txt()).includes("学分须在 0 到 30 之间"));
  await click("#tx2"); await sleep(200);
  await setVal("#ask-cr", "3"); await setVal("#ask-reason", "外校选修"); await click(".portal-modal [data-ok]"); await sleep(700);
  f = await fnCalls();
  ok("X6 一般转入带学分数字", f.length === 1 && f[0].body.credits === 3 && !f[0].body.course_code);
  await armFn("ok", { ok: true });
  await click('[data-rv="41"]'); await sleep(200); await setVal("#ask-reason", "证明有误"); await click(".portal-modal [data-ok]"); await sleep(700);
  f = await fnCalls();
  ok("X7 撤回带整数 ledger_id 与原因", f.length === 1 && f[0].body.action === "revoke_transfer" && f[0].body.ledger_id === 41 && f[0].body.reason === "证明有误");

  // ═══ O 授课次数 / 学员页入口 ═══
  console.log("\n=== O 授课次数与入口 ===");
  await open("portal/admin/offerings/", Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] }, admin_list_offerings: { data: [
    { offering_id: "o-1", title_zh: "马太福音", academic_year: "2026-2027", delivery_mode: "online", offering_status: "in_progress", teachers: [],
      enrolled_count: 2, session_count: 5, last_session_on: "2026-11-01" },
    { offering_id: "o-2", title_zh: "罗马书", academic_year: "2026-2027", delivery_mode: "online", offering_status: "planned", teachers: [],
      enrolled_count: 0, session_count: 0, last_session_on: null }] } } }));
  t = await txt();
  ok("O1 上课中的班显示已上课次数与最近日期，未开课的不显示", t.includes("已上课 5 次（最近 2026-11-01）") && (t.match(/已上课/g) || []).length === 1);
  await open("portal/student/records/", Object.assign({}, STU, { rpc: { my_roles: { data: [{ role: "student" }] },
    my_progress: { data: Object.assign({}, OVR, { practicum: [] }) }, my_grades: { data: [] } } }));
  t = await txt();
  ok("O2 成绩与进度显示外校转入学分与打印入口", t.includes("外校转入 3 学分") && (await ev(`!!document.querySelector('a[href*="portal/student/transcript/"]')`)));
  await open("portal/admin/roles/", roleScen());
  ok("O3 后台导航有「角色管理」", await ev(`[...document.querySelectorAll("nav a")].some(a=>a.textContent.includes("角色管理"))`));
  ok("O4 全程没有请求离开本机", h.external() === 0);
} catch (e) {
  h.fail("测试过程抛错：" + e.message);
}
process.exit((await h.close("SIS COMPLETION PAGES")) ? 1 : 0);
