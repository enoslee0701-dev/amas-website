#!/usr/bin/env node
// 费用管理（0042）、公告与课堂（0041）后台页，以及学员端的公告 / 出勤 / 费用（本机 stub，见 lib/sis-harness.mjs）。
// 运行：node scripts/test-finance-board.mjs [--shots]
import { startHarness, sleep } from "./lib/sis-harness.mjs";

const h = await startHarness({ profilePrefix: "amas-finboard-", shotPrefix: "finboard" });
const { ok, open, txt, click, setVal, ev, shot, send } = h;
const ADMIN = { session: { user: { id: "u-a", email: "a@example.invalid" } }, aal: "aal2", rpc: { my_roles: { data: [{ role: "super_admin" }] } } };
const PEOPLE = [{ id: 11, name: "腓力", cohort: "10月班", student_user_id: "s1" }, { id: 12, name: "姜莹", cohort: "10月班", student_user_id: "s2" },
                { id: 13, name: "翟金丽", cohort: "11月班", student_user_id: "s3" }];
const ENTRIES = [
  { id: "e1", submission_id: 11, kind: "charge", category: "学费", amount: 3000, currency: "THB", occurred_on: "2026-10-01", method: "", reference: "", note: "", created_at: "2026-10-01T00:00:00Z" },
  { id: "e2", submission_id: 11, kind: "payment", category: "学费", amount: 1000, currency: "THB", occurred_on: "2026-10-05", method: "bank", reference: "TX-1", note: "", created_at: "2026-10-05T00:00:00Z" },
  { id: "e3", submission_id: 12, kind: "payment", category: "学费", amount: 500, currency: "THB", occurred_on: "2026-10-06", method: "cash", reference: "", note: "", created_at: "2026-10-06T00:00:00Z",
    voided_at: "2026-10-07T00:00:00Z", void_reason: "重复录入" }];
const fscen = (t = {}) => Object.assign({}, ADMIN, { tables: Object.assign({ submissions: { data: PEOPLE }, finance_entries: { data: JSON.parse(JSON.stringify(ENTRIES)) } }, t) });
const upd = () => ev("JSON.stringify(window.__upd || [])").then(JSON.parse);

try {
  console.log("\n=== F 费用管理 ===");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await open("portal/admin/finance/", fscen());
  let t = await txt();
  ok("F1 合计：应收 3000、已收 1000、欠款 2000（作废的不算）", t.includes("฿3,000") && t.includes("฿1,000") && /฿2,000\s*未收/.test(t), t.slice(0, 300));
  ok("F2 每位学员一行，欠款标出", /腓力\s*10月班\s*฿3,000\s*฿1,000\s*฿2,000/.test(t));
  ok("F3 作废的那笔在明细里划掉并写原因", (await ev(`!!document.querySelector("tr.void")`)) && t.includes("已作废：重复录入"));
  await setVal("#who", "11"); await setVal("#kind", "payment"); await setVal("#amt", "500"); await setVal("#ref", "TX-2"); await setVal("#met", "promptpay");
  await ev(`window.__SCEN.tables["finance_entries:insert"] = { data: [{ id: "e4", submission_id: 11, kind: "payment", category: "学费", amount: 500, currency: "THB",
            occurred_on: new Date().toISOString().slice(0,10), method: "promptpay", reference: "TX-2", note: "", created_at: new Date().toISOString() }] }; true`);
  await click("#add"); await sleep(400);
  let u = await upd(); const ins = u.find((x) => x.table === "finance_entries" && x.insert);
  ok("F4 记一笔：只写这一行，带上记账人", ins && ins.insert.length === 1 && ins.insert[0].amount === 500 && ins.insert[0].reference === "TX-2" && ins.insert[0].created_by === "u-a", JSON.stringify(ins));
  ok("F5 记完欠款跟着变成 1500", /腓力\s*10月班\s*฿3,000\s*฿1,500\s*฿1,500/.test(await txt()));
  await setVal("#who", "cohort:10月班"); await setVal("#kind", "charge"); await setVal("#amt", "200"); await setVal("#cat", "教材费");
  await ev(`window.__SCEN.tables["finance_entries:insert"] = { data: [11,12].map((s,i) => ({ id: "b"+i, submission_id: s, kind: "charge", category: "教材费", amount: 200, currency: "THB",
            occurred_on: new Date().toISOString().slice(0,10), method: "", reference: "", note: "", created_at: new Date().toISOString() })) }; true`);
  await click("#add"); await sleep(200);
  ok("F6 整个班记账先确认人数", (await txt()).includes("2 位学员每人记一笔应收"));
  await click(".portal-modal [data-ok]"); await sleep(400);
  u = await upd(); const bat = u.filter((x) => x.table === "finance_entries" && x.insert).pop();
  ok("F7 整个班：每人一行、同一个批次号", bat.insert.length === 2 && bat.insert[0].batch_id && bat.insert[0].batch_id === bat.insert[1].batch_id);
  await setVal("#who", "11"); await setVal("#amt", "0"); await click("#add"); await sleep(200);
  ok("F8 金额为 0 不让记", (await txt()).includes("大于 0 的金额"));
  await ev(`window.__SCEN.tables["finance_entries:update"] = { data: [] }; true`);
  await click('[data-void="e1"]'); await sleep(200);
  await setVal("#ask-reason", "金额写错"); await click(".portal-modal [data-ok]"); await sleep(400);
  u = await upd(); const vd = u.filter((x) => x.table === "finance_entries" && x.patch).pop();
  ok("F9 作废只送作废时间与原因；没成功如实说", vd && Object.keys(vd.patch).sort().join() === "void_reason,voided_at" && vd.patch.void_reason === "金额写错" && (await txt()).includes("没有作废成功"));
  await shot("finance");
  await open("portal/admin/finance/", fscen({ finance_entries: { data: null, error: { message: "x" } } }));
  ok("F10 读失败如实说", (await txt()).includes("没能读到费用记录"));

  console.log("\n=== G 公告与课堂 ===");
  const SET = [{ key: "live_class", value: { enabled: false, allow_guests: true } }, { key: "intro_video", value: { enabled: false } }];
  const gscen = (t = {}) => Object.assign({}, ADMIN, { tables: Object.assign({ site_announcements: { data: [] }, site_settings: { data: SET },
    submission_cohorts: { data: [{ name: "10月班", phase: "in_session", show_on_site: true, sort: 1 }, { name: "11月班", phase: "enrolling", show_on_site: true, sort: 2 }] } }, t) });
  await open("portal/admin/board/", gscen());
  t = await txt();
  ok("G1 首页状态预览按班级写出", t.includes("10月班已开课 · 11月班招生中"));
  await ev(`document.getElementById("lvOn").checked = true; true`); await click("#lvSave"); await sleep(300);
  ok("G2 要显示课堂入口却没贴链接：不保存并提示", (await txt()).includes("请先贴上会议链接") && !(await upd()).some((x) => x.table === "site_settings"));
  await setVal("#lvUrl", "http://zoom.example/j/1"); await click("#lvSave"); await sleep(300);
  ok("G3 不是 https 的链接不收", (await txt()).includes("https://"));
  await setVal("#lvUrl", "https://zoom.example/j/1"); await setVal("#lvId", "123 456"); await setVal("#lvTitle", "周三晚课");
  await ev(`window.__SCEN.tables["site_settings:update"] = { data: [{ key: "live_class" }] }; true`);
  await click("#lvSave"); await sleep(400);
  const ls = (await upd()).filter((x) => x.table === "site_settings").pop();
  ok("G4 保存课堂入口：链接、会议号、允许旁听", ls && ls.patch.value.url === "https://zoom.example/j/1" && ls.patch.value.meeting_id === "123 456" && ls.patch.value.allow_guests === true && ls.patch.value.enabled === true);
  await ev(`window.__SCEN.tables["submission_cohorts:update"] = { data: [{ name: "11月班" }] }; const s = document.querySelector('[data-ph="11月班"]'); s.value = "in_session"; s.dispatchEvent(new Event("change")); true`);
  await sleep(400);
  ok("G5 改班级状态立即生效，预览跟着变", (await txt()).includes("10月班已开课 · 11月班已开课") && (await upd()).some((x) => x.table === "submission_cohorts" && x.patch.phase === "in_session"));
  await setVal("#anTitle", "下周三停课"); await setVal("#anBody", "放假一次"); await setVal("#anAud", "public");
  await ev(`window.__SCEN.tables["site_announcements:insert"] = { data: { id: "a1", title: "下周三停课", body: "放假一次", audience: "public", pinned: false, published: true, created_at: new Date().toISOString() } }; true`);
  await click("#anSave"); await sleep(400);
  const ai = (await upd()).find((x) => x.table === "site_announcements" && x.insert);
  ok("G6 发布公告：标题、内容、公开", ai && ai.insert.title === "下周三停课" && ai.insert.audience === "public" && (await txt()).includes("公开"));
  await shot("board");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });

  console.log("\n=== S 学员端 ===");
  const STU = { session: { user: { id: "s1", email: "feili2026@student.amas.invalid" } }, aal: "aal1" };
  const sscen = (rpc) => Object.assign({}, STU, { rpc: Object.assign({ my_roles: { data: [{ role: "student" }] },
    my_student_record: { data: [{ status: "active", student_number: "B26-017", program_code: "bth", created_at: "2026-10-26T00:00:00Z", activated_at: "2026-10-26T00:00:00Z" }] },
    my_student_timeline: { data: [] }, my_action_items: { data: [] }, my_learning: { data: [] }, my_courses: { data: [] }, my_progress: { data: null } }, rpc),
    tables: { program_catalog: { data: [{ code: "bth", name_zh: "神学学士" }] } } });
  await open("portal/student/", sscen({ portal_board: { data: {
    live_class: { enabled: true, url: "https://zoom.example/j/1", title: "周三晚课", meeting_id: "123" },
    intro_video: { enabled: true, title: "开学导言", china: "https://www.bilibili.com/video/x" },
    announcements: [{ title: "作业提醒", body: "周五前交", pinned: true, created_at: "2026-10-26T00:00:00Z" }] } } }));
  t = await txt();
  ok("S1 学员首页：课堂入口、导言视频、公告", t.includes("线上课堂 · 周三晚课") && t.includes("会议号：123") && t.includes("开学导言") && t.includes("国内观看") &&
     !t.includes("YouTube 观看") && t.includes("作业提醒"));
  await open("portal/student/", sscen({ portal_board: { error: { message: "x" } } }));
  ok("S2 公告读不到：首页其余照常", (await txt()).includes("B26-017") && !(await txt()).includes("线上课堂"));
  const PROG = { credits_required: 77, credits_earned: 0, status: "active", practicum: [], missing_courses: [] };
  await open("portal/student/records/", sscen({ my_progress: { data: PROG }, my_grades: { data: [] },
    my_cohort_record: { data: [{ cohort: "10月班", held_on: "2026-10-20", title: "第 4 课", source: "zoom", attendance: "present", homework: "done" },
                               { cohort: "10月班", held_on: "2026-10-13", title: "第 3 课", source: "whatsapp", attendance: "absent", homework: "missing" }] },
    my_finance: { data: { balance: { THB: 2000 }, entries: [{ kind: "charge", category: "学费", amount: 3000, currency: "THB", occurred_on: "2026-10-01" },
                                                              { kind: "payment", category: "学费", amount: 1000, currency: "THB", occurred_on: "2026-10-05", reference: "TX-1" }] } } }));
  t = await txt();
  ok("S3 成绩与进度：出勤与作业统计和每次明细", t.includes("上课出勤与作业 · 10月班") && t.includes("出勤 1 / 2 次，作业完成 1 / 2 次") && t.includes("第 3 课") && t.includes("缺席"));
  ok("S4 我的费用：待缴金额与明细", t.includes("待缴 ฿2,000") && t.includes("−฿1,000") && t.includes("TX-1"));
  await open("portal/student/records/", sscen({ my_progress: { data: PROG }, my_grades: { data: [] }, my_cohort_record: { error: { message: "x" } }, my_finance: { data: { entries: [], balance: {} } } }));
  t = await txt();
  ok("S5 出勤读不到如实说；没有账就不显示费用", t.includes("没能读到你的出勤与作业记录") && !t.includes("我的费用"));

  ok("O1 全程没有请求离开本机", h.external() === 0);
} catch (e) {
  h.fail("测试过程抛错：" + e.message);
}
process.exit((await h.close("FINANCE & BOARD")) ? 1 : 0);
