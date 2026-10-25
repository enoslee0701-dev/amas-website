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
  ok("P3 出具单位为清迈教学中心，留签章栏、不印电子章", t.includes("AMAS 神学院 · 清迈教学中心") && t.includes("教务签章") && t.includes("加盖教务章后为正式成绩单"));
  await ev(`window.__printed = 0; window.print = function(){ window.__printed++; }; true`);
  await click("#print");
  ok("P4 打印按钮调用浏览器打印", (await ev("window.__printed")) === 1);
  await send("Emulation.setEmulatedMedia", { media: "print" });
  ok("P5 打印时隐藏导航、顶栏与按钮", await ev(`["nav.pn","header.ph",".no-print"].every(s => { const e = document.querySelector(s); return !e || getComputedStyle(e).display === "none"; })`));
  await send("Emulation.setEmulatedMedia", { media: "" });
  await shot("transcript");
  await open("portal/student/transcript/", Object.assign({}, STU, { rpc: { my_roles: { data: [{ role: "student" }] }, my_transcript: { error: { message: "x" } } } }));
  ok("P6 读失败如实说", (await txt()).includes("没能读到你的成绩单"));
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
  // ═══ H 学员首页接入学员管理系统 ═══
  console.log("\n=== H 学员首页 ===");
  const homeScen = (status, rpc = {}) => Object.assign({}, STU, { rpc: Object.assign({ my_roles: { data: [{ role: "student" }] },
    my_student_record: { data: [{ id: "sr-1", status, student_number: "B26-001", program_code: "bth", activated_at: "2026-10-01T00:00:00Z" }] },
    my_student_timeline: { data: [] }, my_action_items: { data: [] }, my_student_capabilities: { data: {} }, my_learning: { data: [] },
    my_courses: { data: [{ offering_id: "o-1", offering_status: "in_progress" }, { offering_id: "o-2", offering_status: "completed" }] },
    my_progress: { data: { status, credits_earned: 30, credits_required: 77, gpa: 3.25, eligible: false } } }, rpc),
    tables: { program_catalog: { data: [{ code: "bth", name_zh: "神学学士", short_label: "B.Th" }] } } });
  await open("portal/student/", homeScen("active"));
  t = await txt();
  ok("H1 显示编班数与正在上课数", t.includes("编入 2 个课程班") && t.includes("1 个正在上课"));
  ok("H2 显示学分与 GPA，并有成绩与成绩单入口", t.includes("已得 30 / 77 学分") && t.includes("3.25") &&
     (await ev(`!!document.querySelector('a[href*="portal/student/records/"]') && !!document.querySelector('a[href*="portal/student/transcript/"]')`)));
  ok("H3 不再说「门户尚未接入学习记录」", !t.includes("门户尚未接入学习记录"));
  for (const [st, label] of [["on_leave", "休学中"], ["withdrawn", "已退学"], ["graduated", "已毕业"]]) {
    await open("portal/student/", homeScen(st));
    t = await txt();
    ok(`H4 学籍状态 ${st} 显示为「${label}」，不露出英文代码`, t.includes(label) && !new RegExp("\\b" + st + "\\b").test(t));
  }
  await open("portal/student/", homeScen("active", { my_courses: { error: { message: "x" } }, my_progress: { error: { message: "x" } } }));
  t = await txt();
  ok("H5 编班与学分读不到时如实说，不说成没有", t.includes("没能读到你的课程班") && t.includes("没能读到你的学分进度") && !t.includes("还没有为你编班"));

  // ═══ W 管理后台首页的工作入口 ═══
  console.log("\n=== W 管理后台首页 ===");
  const hubScen = (rpc = {}) => Object.assign({}, ADMIN, { rpc: Object.assign({ my_roles: { data: [{ role: "registrar" }] },
    admin_grade_queue: { data: [{ submitted: 2 }, { submitted: 0 }, { submitted: 1 }] },
    admin_pending_corrections: { data: [{}, {}, {}] }, admissions_ready_for_enrollment: { data: [{}, {}] } }, rpc),
    tables: { teacher_verification_requests: { data: [] } } });
  await open("portal/admin/", hubScen());
  t = await txt();
  ok("W1 显示待发布班数、待审批更正、待建档人数", t.includes("2 个班待发布 · 3 条更正待审批") && t.includes("2 名已录取学员待建档"), t.slice(0, 160));
  const hubLinks = await ev(`[...document.querySelectorAll(".hub a")].map(a => a.href)`);
  const hubOk = [];
  for (const u of hubLinks) hubOk.push((await fetch(u)).status === 200);
  ok("W2 七个入口都指向真实存在的页面（含报名收件箱）", hubLinks.length === 7 && hubOk.every(Boolean), JSON.stringify(hubLinks));
  await open("portal/admin/", hubScen({ admin_grade_queue: { error: { message: "x" } }, admissions_ready_for_enrollment: { error: { message: "x" } } }));
  t = await txt();
  ok("W3 读不到待办时不显示数字、不写 0", !/\d+ 个班待发布/.test(t) && !t.includes("待建档") && t.includes("发布成绩、审批更正"));

  // ═══ M 两步验证开关（0035） ═══
  console.log("\n=== M 两步验证开关 ===");
  const AAL1 = { session: { user: { id: "u-admin", email: "a@example.invalid" } }, aal: "aal1" };
  const offRpc = { my_roles: { data: [{ role: "registrar" }] }, admin_list_offerings: { data: [] } };
  await open("portal/admin/offerings/", Object.assign({}, AAL1, { rpc: offRpc }));
  ok("M1 默认（读不到开关）仍跳去两步验证", (await ev("location.pathname")).includes("/portal/mfa/"));
  await open("portal/admin/offerings/", Object.assign({}, AAL1, { rpc: Object.assign({ mfa_required: { data: true } }, offRpc) }));
  ok("M2 开关开着时跳去两步验证", (await ev("location.pathname")).includes("/portal/mfa/"));
  await open("portal/admin/offerings/", Object.assign({}, AAL1, { rpc: Object.assign({ mfa_required: { data: false } }, offRpc) }));
  ok("M3 开关关闭后账号密码直接进后台", (await ev("location.pathname")).includes("/portal/admin/offerings/") && (await txt()).includes("开课与编班"));
  await armFn("ok", { ok: true, offering_id: "o-x" });
  await ev(`window.AmasApi.fn("sis-admin", { action: "publish_grades", offering_id: "x" }, { requireAal2: true }).then(r => (window.__r = r))`);
  await sleep(300);
  ok("M4 开关关闭后后台操作也能发出", (await fnCalls()).length === 1);
  await open("portal/admin/offerings/", Object.assign({}, AAL1, { rpc: Object.assign({ mfa_required: { data: false } }, { my_roles: { data: [{ role: "student" }] } }) }));
  ok("M5 开关关闭不放松角色：学员仍进不了后台", !(await txt()).includes("开课与编班") || (await ev("location.pathname")).indexOf("/portal/admin/") < 0);

  // ═══ Z 360px 窄屏：所有学员管理页面不出现横向滚动 ═══
  console.log("\n=== Z 360px 窄屏 ===");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  const TEA2 = { session: { user: { id: "t-1", email: "t@example.invalid" } }, aal: "aal2" };
  const SCALE2 = ["A+","A","A-","B+","B","B-","C+","C","C-","D+","D","D-","F"].map((l, i) => ({ letter: l, points: 4 - i * 0.3, passing: l !== "F", sort: i + 1 }));
  const OID2 = "11111111-1111-4111-8111-111111111111";
  const DET = { offering: { id: OID2, title_zh: "旧约救赎预表神学", credits: 3, academic_year: "2026-2027", status: "in_progress",
      starts_on: "2026-10-05", ends_on: "2026-12-20", schedule_note: "每周二、四 19:30–21:00（清迈中心二楼）", delivery_mode: "hybrid" },
    roster: [{ enrollment_id: "e-1", display_name: "很长名字的学员甲乙丙", student_number: "B26-0001234", final_grade: "B+", final_status: "published" }],
    sessions: [{ id: "s1", held_on: "2026-10-06", topic: "第一课：从创世记到启示录的救赎主线", materials_url: "https://example.org/a.pdf", attendance: {} }],
    assignments: [{ id: "a1", title: "读书报告：《基督在旧约中》", due_on: "2026-10-20", weight: 30, scores: {} }] };
  const pages = [
    ["portal/admin/", Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] } } })],
    ["portal/admin/offerings/", Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] }, admin_list_offerings: { data: [
      { offering_id: OID2, title_zh: "旧约救赎预表神学", section_label: "清迈线下 B 班", academic_year: "2026-2027", delivery_mode: "hybrid",
        starts_on: "2026-10-05", ends_on: "2026-12-20", schedule_note: "每周二、四 19:30–21:00（清迈中心二楼）", credits: 3, capacity: 30,
        offering_status: "in_progress", teachers: [{ name: "王约翰教授" }, { name: "李以利亚教授", role: "assistant" }], enrolled_count: 28, session_count: 12, last_session_on: "2026-11-20" }] } } })],
    ["portal/admin/grades/", Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] }, admin_grade_queue: { data: [
      { offering_id: OID2, title_zh: "旧约救赎预表神学", academic_year: "2026-2027", offering_status: "completed", teachers: "王约翰教授、李以利亚教授", enrolled: 28, drafts: 0, submitted: 28, published: 0 }] } } })],
    ["portal/admin/student/?id=" + SID, Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] }, admin_student_overview: { data: OVR },
      admin_list_students: { data: [{ student_id: SID, display_name: "很长名字的学员甲乙丙", student_number: "B26-0001234" }] } } })],
    ["portal/admin/roles/", roleScen()],
    ["portal/admin/transcript/?id=" + SID, Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] }, admin_transcript: { data: TR } } })],
    ["portal/teacher/class/?id=" + OID2, Object.assign({}, TEA2, { rpc: { my_roles: { data: [{ role: "teacher" }] }, teacher_offering_detail: { data: DET } }, tables: { grade_scale: { data: SCALE2 } } })],
    ["portal/student/", homeScen("active")],
    ["portal/student/records/", Object.assign({}, STU, { rpc: { my_roles: { data: [{ role: "student" }] }, my_progress: { data: Object.assign({}, OVR, { practicum: TR.practicum }) },
      my_grades: { data: [{ title_zh: "旧约救赎预表神学", academic_year: "2026-2027", credits: 3, grade: "B+", points: 3.3, passing: true }] } } })],
    ["portal/student/transcript/", Object.assign({}, STU, { rpc: { my_roles: { data: [{ role: "student" }] }, my_transcript: { data: TR } } })],
  ];
  for (const [pg, scen] of pages) {
    await open(pg, scen);
    if (pg.startsWith("portal/teacher/class/")) { for (const tb of ["sessions", "assignments", "grades"]) { await click(`[data-tab="${tb}"]`); await sleep(150); } }
    const sw = await ev("document.documentElement.scrollWidth");
    ok(`Z ${pg.split("?")[0]} 360px 无横向滚动`, sw <= 360, `scrollWidth=${sw}`);
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });

  ok("O4 全程没有请求离开本机", h.external() === 0);
} catch (e) {
  h.fail("测试过程抛错：" + e.message);
}
process.exit((await h.close("SIS COMPLETION PAGES")) ? 1 : 0);
