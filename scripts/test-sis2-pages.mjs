#!/usr/bin/env node
// 学员管理系统第二至四期页面的本地功能测试（本机 stub，见 lib/sis-harness.mjs）：
//   教授 portal/teacher/class/（上课与出勤、作业、课程总评、更正申请）
//   教务 portal/admin/grades/（发布 / 退回 / 更正审批）、portal/admin/student/（毕业审核、导师）
//   学员 portal/student/records/（成绩、学分、GPA、实践训练自报）、portal/student/classes/ 的出勤与作业
//   导师 portal/teacher/mentees/（所带学员、陪伴记录）
// 全绿 ≠ 线上可用：只证明「给定这些返回值时，页面做对了事」。
// 运行：node scripts/test-sis2-pages.mjs [--shots]
import { startHarness, sleep } from "./lib/sis-harness.mjs";

const h = await startHarness({ profilePrefix: "amas-sis2-", shotPrefix: "sis2" });
const { ok, open, txt, click, setVal, ev, rpcCalls, armFn, fnCalls, shot } = h;
const yes = () => ev(`window.AmasUI.confirmDialog = function(){ return Promise.resolve(true); }; true`);
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

const SCALE = ["A+","A","A-","B+","B","B-","C+","C","C-","D+","D","D-","F"].map((l, i) =>
  ({ letter: l, points: [4,4,3.7,3.3,3,2.7,2.3,2,1.7,1.3,1,0.7,0][i], passing: l !== "F", sort: i + 1 }));
const TEA = { session: { user: { id: "t-1", email: "t@example.invalid" } }, aal: "aal2" };
const ADMIN = { session: { user: { id: "u-admin", email: "a@example.invalid" } }, aal: "aal2" };
const STU = { session: { user: { id: "s-u1", email: "s@example.invalid" } }, aal: "aal1" };
const OID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const DETAIL = (over = {}) => Object.assign({
  offering: { id: OID, title_zh: "马太福音", credits: 3, academic_year: "2026-2027", status: "in_progress",
    starts_on: "2026-10-05", ends_on: "2026-12-20", schedule_note: "每周二、四 19:30", delivery_mode: "online" },
  roster: [
    { enrollment_id: "e-1", display_name: "学员甲", student_number: "B26-001", final_grade: "B+", final_status: "draft" },
    { enrollment_id: "e-2", display_name: "学员乙", student_number: "B26-002", final_grade: null, final_status: null }],
  sessions: [{ id: "ss-1", held_on: "2026-10-06", topic: "福音书导论", materials_url: "https://example.org/s1.pdf",
    attendance: { "e-1": { status: "present" } } }],
  assignments: [{ id: "as-1", title: "读书报告", due_on: "2026-10-20", weight: 30, scores: { "e-1": { grade: "A", comment: "清楚" } } }],
}, over);
const teaScen = (detail, rpc = {}) => Object.assign({}, TEA, {
  rpc: Object.assign({ my_roles: { data: [{ role: "teacher" }] }, teacher_offering_detail: { data: detail } }, rpc),
  tables: { grade_scale: { data: SCALE } } });

try {
  // ═══ T 教授课程班页 ═══
  console.log("\n=== T 教授：课程班页 ===");
  await open("portal/teacher/class/?id=" + OID, teaScen(DETAIL(), {
    teacher_save_session: { data: { ok: true, session_id: "ss-new" } },
    teacher_set_attendance: { data: { ok: true, saved: 2, rejected: 0 } } }));
  let t = await txt();
  ok("T1 标题、在班人数、上课安排", t.includes("马太福音") && t.includes("在班 2 人") && t.includes("每周二、四 19:30"));
  ok("T2 上课记录显示点名汇总", t.includes("福音书导论") && t.includes("出席 1"));
  await shot("teacher-class");
  await click("#sf [type=submit]"); await sleep(300);
  ok("T3 没填主题不发请求", (await rpcCalls("teacher_save_session")).length === 0 && (await txt()).includes("请填写上课日期和主题"));
  await setVal("#s-t", "登山宝训"); await click("#sf [type=submit]"); await sleep(600);
  let c = await rpcCalls("teacher_save_session");
  ok("T4 登记上课：带本班、今天、主题", c.length === 1 && c[0].args.p_offering === OID && c[0].args.p_held_on === today && c[0].args.p_topic === "登山宝训", JSON.stringify(c));
  await open("portal/teacher/class/?id=" + OID, teaScen(DETAIL(), { teacher_set_attendance: { data: { ok: true, saved: 2, rejected: 0 } } }));
  await click('[data-roll="ss-1"]'); await sleep(200);
  ok("T5 点名表预填已有出勤", (await ev(`document.querySelector('select[data-e="e-1"]').value`)) === "present");
  await click("#allp"); await click("#rf [type=submit]"); await sleep(600);
  c = await rpcCalls("teacher_set_attendance");
  ok("T6 全部出席后保存两人", c.length === 1 && c[0].args.p_session === "ss-1" && c[0].args.p_entries.length === 2 &&
     c[0].args.p_entries.every(x => x.status === "present"), JSON.stringify(c));

  await open("portal/teacher/class/?id=" + OID, teaScen(DETAIL(), { teacher_save_session: { data: { ok: false, error: "mfa_required" } } }));
  await setVal("#s-t", "x"); await click("#sf [type=submit]"); await sleep(500);
  ok("T7 服务端拒绝（未两步验证）照实说明", (await txt()).includes("需要先完成两步验证"));
  await open("portal/teacher/class/?id=" + OID, teaScen(DETAIL(), { teacher_save_session: { error: { message: "Failed to fetch" } } }));
  await setVal("#s-t", "x"); await click("#sf [type=submit]"); await sleep(500);
  ok("T8 结果不明时不劝重试", (await txt()).includes("无法确认它是否已经生效"));

  await open("portal/teacher/class/?id=" + OID, teaScen(null));
  t = await txt();
  ok("T9 非任课教授：看不到班，标签页收起", t.includes("看不到这个课程班") && (await ev(`document.querySelector(".tabs").hidden`)));
  await open("portal/teacher/class/?id=" + OID, Object.assign(teaScen(DETAIL()), { rpc: { my_roles: { data: [{ role: "teacher" }] }, teacher_offering_detail: { error: { message: "boom" } } } }));
  ok("T10 读失败如实说", (await txt()).includes("没能读到这个课程班"));

  // 作业
  await open("portal/teacher/class/?id=" + OID, teaScen(DETAIL(), {
    teacher_set_scores: { data: { ok: true, saved: 2, rejected: 0 } }, teacher_save_assignment: { data: { ok: true, assignment_id: "as-2" } } }));
  await click('[data-tab="assignments"]'); await sleep(200);
  ok("T11 作业显示已评人数与比重", (await txt()).includes("已评 1 / 2") && (await txt()).includes("比重 30%"));
  await click('[data-score="as-1"]'); await sleep(200);
  ok("T12 等级下拉为 A+ 至 F 共 13 级", (await ev(`[...document.querySelectorAll('select[data-g="e-2"] option')].length`)) === 14);
  await setVal('select[data-g="e-2"]', "B"); await click("#scf [type=submit]"); await sleep(600);
  c = await rpcCalls("teacher_set_scores");
  ok("T13 评分保存全班（含原有 A 与新给的 B）", c.length === 1 && c[0].args.p_entries.find(x => x.enrollment_id === "e-1").grade === "A" &&
     c[0].args.p_entries.find(x => x.enrollment_id === "e-2").grade === "B", JSON.stringify(c));
  await setVal("#a-t", "期末论文"); await setVal("#a-w", "40"); await click("#af [type=submit]"); await sleep(500);
  c = await rpcCalls("teacher_save_assignment");
  ok("T14 布置作业带名称与比重", c.length === 1 && c[0].args.p_title === "期末论文" && c[0].args.p_weight === 40, JSON.stringify(c));

  // 总评
  await open("portal/teacher/class/?id=" + OID, teaScen(DETAIL(), {
    teacher_save_grades: { data: { ok: true, saved: 2, locked: 0, rejected: 0 } }, teacher_submit_grades: { data: { ok: true, submitted: 2 } } }));
  await click('[data-tab="grades"]'); await sleep(200);
  await yes();
  await click("#submitg"); await sleep(400);
  ok("T15 有人没录等级时不提交", (await rpcCalls("teacher_submit_grades")).length === 0 && (await txt()).includes("还有 1 位学员没有选等级"));
  await setVal('select[data-g="e-2"]', "C"); await click("#submitg"); await sleep(800);
  const sv = await rpcCalls("teacher_save_grades"), sb = await rpcCalls("teacher_submit_grades");
  ok("T16 提交前先保存草稿，再提交", sv.length === 1 && sb.length === 1 && sv[0].args.p_entries.find(x => x.enrollment_id === "e-2").grade === "C");
  await shot("teacher-grades");

  const pubDetail = DETAIL({ roster: [
    { enrollment_id: "e-1", display_name: "学员甲", final_grade: "B+", final_status: "published" },
    { enrollment_id: "e-2", display_name: "学员乙", final_grade: "F", final_status: "draft", returned_reason: "请核对学员乙" }] });
  await open("portal/teacher/class/?id=" + OID, teaScen(pubDetail, { teacher_request_correction: { data: { ok: true, correction_id: "gc-1" } } }));
  await click('[data-tab="grades"]'); await sleep(200);
  t = await txt();
  ok("T17 显示教务退回原因", t.includes("教务退回了这批成绩") && t.includes("请核对学员乙"));
  ok("T18 已发布的不能直接改，只给「申请更正」", !(await ev(`!!document.querySelector('select[data-g="e-1"]')`)) && (await ev(`!!document.querySelector('[data-corr="e-1"]')`)));
  await click('[data-corr="e-1"]'); await sleep(200);
  await click(".portal-modal [data-ok]"); await sleep(200);
  ok("T19 更正不写原因不发出", (await rpcCalls("teacher_request_correction")).length === 0 && (await txt()).includes("请填写"));
  await setVal("#ask-to", "A-"); await setVal("#ask-reason", "期末报告漏登"); await click(".portal-modal [data-ok]"); await sleep(600);
  c = await rpcCalls("teacher_request_correction");
  ok("T20 更正申请带新等级与原因", c.length === 1 && c[0].args.p_to_grade === "A-" && c[0].args.p_reason === "期末报告漏登", JSON.stringify(c));
  await open("portal/teacher/class/?id=" + OID, teaScen(DETAIL({ offering: Object.assign(DETAIL().offering, { status: "planned" }) })));
  await click('[data-tab="grades"]'); await sleep(200);
  ok("T21 未开课不能录总评", (await txt()).includes("还不能录总评"));
  await open("portal/teacher/class/?id=" + OID, Object.assign(teaScen(DETAIL()), { tables: { grade_scale: { error: { message: "x" } } } }));
  await click('[data-tab="assignments"]'); await sleep(200);
  ok("T22 等级表读不到时不让评分（不自己编等级）", (await txt()).includes("没能读到等级表"));
  ok("T23 页面 390px 无横向滚动", (await ev("document.documentElement.scrollWidth")) <= 390);

  // ═══ G 教务成绩审核 ═══
  console.log("\n=== G 教务：成绩审核 ===");
  const QUEUE = [
    { offering_id: OID, title_zh: "马太福音", academic_year: "2026-2027", offering_status: "completed", teachers: "王教授", enrolled: 2, drafts: 0, submitted: 2, published: 0 },
    { offering_id: "o-2", title_zh: "罗马书", academic_year: "2026-2027", offering_status: "in_progress", teachers: "李教授", enrolled: 3, drafts: 3, submitted: 0, published: 0 }];
  const admScen = (rpc = {}) => Object.assign({}, ADMIN, { rpc: Object.assign({ my_roles: { data: [{ role: "registrar" }] },
    admin_grade_queue: { data: QUEUE },
    admin_offering_grades: { data: [{ enrollment_id: "e-1", display_name: "学员甲", student_number: "B26-001", grade: "B+", status: "submitted" }] },
    admin_pending_corrections: { data: [{ correction_id: "gc-1", title_zh: "马太福音", academic_year: "2026-2027", display_name: "学员甲",
      student_number: "B26-001", from_grade: "B+", to_grade: "A-", reason: "期末报告漏登", requested_by_name: "王教授", requested_at: "2026-12-21T00:00:00Z" }] } }, rpc) });
  await open("portal/admin/grades/", admScen());
  t = await txt();
  ok("G1 待发布的班有「发布」，没提交的没有", t.includes("待发布 2") && (await ev(`document.querySelectorAll("[data-pub]").length`)) === 1);
  await click(`[data-open="${OID}"]`); await sleep(600);
  ok("G2 展开看到逐个成绩", (await txt()).includes("学员甲") && (await txt()).includes("待教务发布"));
  await yes(); await armFn("ok", { ok: true, published: 2, credits_added: 3 });
  await click("[data-pub]"); await sleep(700);
  let f = await fnCalls();
  ok("G3 发布请求带课程班", f.length === 1 && f[0].body.action === "publish_grades" && f[0].body.offering_id === OID, JSON.stringify(f));
  ok("G4 告诉教务入账学分数", (await txt()).includes("入账 3 学分"));
  await open("portal/admin/grades/", admScen());
  await armFn("ok", { ok: true, returned: 2 });
  await click("[data-ret]"); await sleep(200); await click(".portal-modal [data-ok]"); await sleep(200);
  ok("G5 退回不写原因不发出", (await fnCalls()).length === 0);
  await setVal("#ask-reason", "学员乙成绩有误"); await click(".portal-modal [data-ok]"); await sleep(600);
  f = await fnCalls();
  ok("G6 退回带原因", f.length === 1 && f[0].body.action === "return_grades" && f[0].body.reason === "学员乙成绩有误");
  await click('[data-tab="corr"]'); await sleep(600);
  t = await txt();
  ok("G7 更正申请列出前后等级与原因", t.includes("B+") && t.includes("A-") && t.includes("期末报告漏登") && t.includes("王教授"));
  await armFn("reject", { error: "same_actor_not_allowed" });
  await click('[data-ok="gc-1"]'); await sleep(200); await click(".portal-modal [data-ok]"); await sleep(600);
  ok("G8 同一人审批被拒时照实说明", (await txt()).includes("不能审批自己发起的更正"));
  await armFn("ok", { ok: true, approved: false });
  await click('[data-no="gc-1"]'); await sleep(200); await click(".portal-modal [data-ok]"); await sleep(200);
  ok("G9 驳回不写理由不发出", (await fnCalls()).length === 0);
  await setVal("#ask-note", "无依据"); await click(".portal-modal [data-ok]"); await sleep(600);
  f = await fnCalls();
  ok("G10 驳回带理由、approve=false", f.length === 1 && f[0].body.approve === false && f[0].body.note === "无依据");
  await open("portal/admin/grades/", admScen({ admin_grade_queue: { error: { message: "x" } } }));
  ok("G11 队列读失败不说成没有", (await txt()).includes("这不表示没有待发布的成绩"));

  // ═══ R 学员成绩与进度 ═══
  console.log("\n=== R 学员：成绩与进度 ===");
  const PROG = (over = {}) => Object.assign({ status: "active", program_code: "bth", credits_required: 77, min_gpa: 2.0,
    credits_earned: 30, course_credits: 28, practicum_credits: 2, gpa: 3.25, eligible: false,
    missing_courses: [{ code: "c_romans", title_zh: "罗马书", credits: 3 }],
    practicum: [{ code: "p_reading", title_zh: "读经训练", credits: 1, done: false },
                { code: "p_prayer", title_zh: "祷告训练", credits: 2, done: true, completed_on: "2026-10-10" }] }, over);
  const stuScen = (prog, rpc = {}) => Object.assign({}, STU, { rpc: Object.assign({ my_roles: { data: [{ role: "student" }] },
    my_progress: { data: prog }, my_grades: { data: [
      { title_zh: "马太福音", academic_year: "2026-2027", credits: 3, grade: "B+", points: 3.3, passing: true },
      { title_zh: "罗马书", academic_year: "2026-2027", credits: 3, grade: "F", points: 0, passing: false }] } }, rpc) });
  await open("portal/student/records/", stuScen(PROG(), { report_practicum: { data: { ok: true, credits_added: 1 } }, retract_practicum: { data: { ok: true } } }));
  t = await txt();
  ok("R1 学分 30 / 77、GPA 3.25、未修 1 门", t.includes("30 / 77") && t.includes("3.25") && t.includes("尚未修过的必修课（1）"));
  ok("R2 不及格标出须重修", t.includes("须重修"));
  ok("R3 说明正式成绩单由清迈教学中心出具", t.includes("正式成绩单由 AMAS 神学院·清迈教学中心出具"));
  await shot("student-records");
  await click('[data-rep="p_reading"]'); await sleep(200);
  ok("R4 填报日期默认今天", (await ev(`document.querySelector("#ask-on").value`)) === today);
  await click(".portal-modal [data-ok]"); await sleep(600);
  c = await rpcCalls("report_practicum");
  ok("R5 填报带项目与日期", c.length === 1 && c[0].args.p_item === "p_reading" && c[0].args.p_completed_on === today);
  await yes(); await click('[data-undo="p_prayer"]'); await sleep(600);
  c = await rpcCalls("retract_practicum");
  ok("R6 撤回已填报的项目", c.length === 1 && c[0].args.p_item === "p_prayer");
  await open("portal/student/records/", stuScen(PROG({ status: "graduated", credits_earned: 77 })));
  t = await txt();
  ok("R7 已毕业：不再给填报 / 撤回按钮", t.includes("已毕业") && (await ev(`document.querySelectorAll("[data-rep],[data-undo]").length`)) === 0);
  await open("portal/student/records/", stuScen(PROG(), { my_progress: { error: { message: "x" } } }));
  ok("R8 读失败不说成没有记录", (await txt()).includes("这不表示你没有记录"));

  await open("portal/student/classes/", Object.assign({}, STU, { rpc: { my_roles: { data: [{ role: "student" }] },
    my_courses: { data: [{ offering_id: OID, title_zh: "马太福音", academic_year: "2026-2027", delivery_mode: "online", offering_status: "in_progress", teachers: "王教授" }] },
    my_course_detail: { data: { final_grade: "B+",
      attendance: [{ held_on: "2026-10-08", topic: "第二课", status: "absent" }, { held_on: "2026-10-06", topic: "第一课", status: "present", materials_url: "https://example.org/a.pdf" }],
      assignments: [{ title: "读书报告", due_on: "2026-10-20", grade: "A", comment: "结构清楚" }] } } } }));
  await click(`[data-more="${OID}"]`); await sleep(600);
  t = await txt();
  ok("R9 课程详情：总评、出勤汇总、作业评语", /课程总评\s*B\+/.test(t) && t.includes("出席 1") && t.includes("缺席 1") && t.includes("结构清楚"), t.slice(-220));

  // ═══ A 教务：学员学业总览 ═══
  console.log("\n=== A 教务：学员学业总览 ===");
  const OVR = (over = {}) => Object.assign(PROG({ credits_earned: 77, course_credits: 70, practicum_credits: 7, gpa: 3.1, eligible: true, missing_courses: [] }),
    { mentors: [], graduation: null }, over);
  const ovScen = (o, rpc = {}) => Object.assign({}, ADMIN, { rpc: Object.assign({ my_roles: { data: [{ role: "registrar" }] },
    admin_student_overview: { data: o }, admin_list_students: { data: [{ student_id: SID, display_name: "学员甲", student_number: "B26-001", status: "active" }] },
    admin_list_mentors: { data: [{ user_id: "33333333-3333-4333-8333-333333333333", name: "陈导师" }] } }, rpc) });
  await open("portal/admin/student/?id=" + SID, ovScen(OVR()));
  ok("A1 满足条件时给「登记毕业」", (await txt()).includes("已满足全部毕业条件") && (await ev(`!!document.querySelector("#grad")`)));
  await armFn("ok", { ok: true, status: "graduated" });
  await click("#grad"); await sleep(200); await click(".portal-modal [data-ok]"); await sleep(600);
  f = await fnCalls();
  ok("A2 毕业请求带学员与日期", f.length === 1 && f[0].body.action === "graduate" && f[0].body.student_id === SID && f[0].body.graduated_on === today);
  await open("portal/admin/student/?id=" + SID, ovScen(OVR({ credits_earned: 30, eligible: false, missing_courses: [{ title_zh: "罗马书", credits: 3 }] })));
  t = await txt();
  ok("A3 不满足时列出差什么，不给毕业按钮", t.includes("学分还差 47") && t.includes("还有 1 门必修课") && !(await ev(`!!document.querySelector("#grad")`)));
  await armFn("ok", { ok: true, assignment_id: "ma-1" });
  await click("#addm"); await sleep(600);
  await setVal("#ask-m", "33333333-3333-4333-8333-333333333333"); await click(".portal-modal [data-ok]"); await sleep(600);
  f = await fnCalls();
  ok("A4 指派导师", f.length === 1 && f[0].body.action === "assign_mentor" && f[0].body.mentor_id === "33333333-3333-4333-8333-333333333333");
  await open("portal/admin/student/?id=" + SID, ovScen(OVR({ status: "graduated", eligible: false, graduation: { graduated_on: "2027-06-30", total_credits: 77, gpa: 3.1 } })));
  ok("A5 已毕业显示登记信息", (await txt()).includes("已于 2027-06-30 登记毕业"));

  // ═══ M 导师 ═══
  console.log("\n=== M 导师：我带的学员 ===");
  const MEN = { session: { user: { id: "m-1", email: "m@example.invalid" } }, aal: "aal2" };
  await open("portal/teacher/mentees/", Object.assign({}, MEN, { rpc: { my_roles: { data: [{ role: "mentor" }] },
    my_mentees: { data: [{ student_id: SID, display_name: "学员乙", student_number: "B26-002", status: "active", credits_earned: 12, credits_required: 77, gpa: 2.8 }] },
    mentee_detail: { data: { course_credits: 10, practicum_credits: 2, missing_courses: [], courses: [{ title_zh: "马太福音", academic_year: "2026-2027", offering_status: "in_progress" }],
      notes: [{ body: "上周谈了服事方向", created_at: "2026-10-20T00:00:00Z" }] } },
    mentor_add_note: { data: { ok: true, note_id: "n-2" } } } }));
  ok("M1 列出所带学员与学分", (await txt()).includes("学员乙") && (await txt()).includes("学分 12 / 77"));
  await click(`[data-open="${SID}"]`); await sleep(700);
  ok("M2 展开看到在修课程与旧记录", (await txt()).includes("马太福音") && (await txt()).includes("上周谈了服事方向"));
  await click("#nf [type=submit]"); await sleep(200);
  ok("M3 空记录不发出", (await rpcCalls("mentor_add_note")).length === 0);
  await setVal("#nb", "代祷：家人健康"); await click("#nf [type=submit]"); await sleep(600);
  c = await rpcCalls("mentor_add_note");
  ok("M4 写陪伴记录带学员与内容", c.length === 1 && c[0].args.p_student === SID && c[0].args.p_body === "代祷：家人健康");
  await open("portal/teacher/mentees/", Object.assign({}, TEA, { rpc: { my_roles: { data: [{ role: "teacher" }] } } }));
  ok("M5 没有导师身份进不了", !(await txt()).includes("陪伴记录写下后不能修改"));

  // ═══ N 导航 ═══
  await open("portal/student/records/", stuScen(PROG()));
  ok("N1 学员导航有「成绩与进度」", await ev(`[...document.querySelectorAll("nav a")].some(a=>a.textContent.includes("成绩与进度"))`));
  await open("portal/admin/grades/", admScen());
  ok("N2 后台导航有「成绩审核」", await ev(`[...document.querySelectorAll("nav a")].some(a=>a.textContent.includes("成绩审核"))`));
  ok("N3 全程没有请求离开本机", h.external() === 0, "外部请求 " + h.external());
} catch (e) {
  h.fail("测试过程抛错：" + e.message);
}
process.exit((await h.close("SIS 2-4 PAGES")) ? 1 : 0);
