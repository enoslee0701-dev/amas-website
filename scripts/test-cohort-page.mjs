#!/usr/bin/env node
// 班级上课记录页（portal/admin/cohort/，0040）的本地功能测试（本机 stub，见 lib/sis-harness.mjs）。
// 运行：node scripts/test-cohort-page.mjs [--shots]
import { startHarness, sleep } from "./lib/sis-harness.mjs";

const h = await startHarness({ profilePrefix: "amas-cohort-", shotPrefix: "cohort" });
const { ok, open, txt, click, setVal, ev, shot, send } = h;
const ADMIN = { session: { user: { id: "u-a", email: "a@example.invalid" } }, aal: "aal2", rpc: { my_roles: { data: [{ role: "registrar" }] } } };
const ROSTER = [{ id: 11, name: "腓力", student_user_id: "s1", created_at: "2026-09-04T08:00:00Z" },
                { id: 12, name: "<b>姜莹</b>", student_user_id: "s2", created_at: "2026-09-05T08:00:00Z" },
                { id: 13, name: "未建档者", student_user_id: null, created_at: "2026-09-06T08:00:00Z" }];
const SESS = [{ id: "c1", held_on: "2026-10-20", title: "第 4 课", source: "zoom", note: "" }];
const MARKS = [{ session_id: "c1", submission_id: 11, attendance: "present", homework: "done" },
               { session_id: "c1", submission_id: 12, attendance: "absent", homework: "missing", attendance_note: "已提前请假 <b>考勤备注</b>" }];
const scen = (t = {}) => Object.assign({}, ADMIN, { tables: Object.assign({
  submissions: { data: ROSTER }, cohort_sessions: { data: SESS }, cohort_marks: { data: MARKS },
  student_records: { data: [{ user_id: "s1", student_number: "B26-017" }, { user_id: "s2", student_number: "B26-014" }] } }, t) });
const upd = () => ev("JSON.stringify(window.__upd || [])").then(JSON.parse);
const pick = (k, pid, v) => click(`.seg button[data-k="${k}"][data-p="${pid}"][data-v="${v}"]`);

try {
  console.log("\n=== C 班级上课记录 ===");
  await open("portal/admin/cohort/?name=" + encodeURIComponent("10月班"), scen());
  let t = await txt();
  ok("C1 标题、人数与历次上课", t.includes("10月班 · 上课记录") && t.includes("3 位学员、1 次上课") && t.includes("2026-10-20 · 第 4 课") && t.includes("Zoom"));
  ok("C2 汇总表：学号、出勤与作业比", t.includes("B26-017") && /腓力\s*B26-017\s*1 \/ 1\s*1 \/ 1/.test(t) && /B26-014\s*0 \/ 1\s*0 \/ 1/.test(t), t.slice(0, 400));
  ok("C3 单次统计：出勤 1/3、作业 1/3", t.includes("出勤 1 / 3") && t.includes("作业 1 / 3"));
  ok("C4 姓名里的 HTML 不被执行", t.includes("<b>姜莹</b>"));

  await click("#add"); await sleep(200);
  ok("C5 新记录默认今天、默认「第 2 课」、默认 Zoom", (await ev(`document.querySelector("#t").value`)) === "第 2 课" &&
     (await ev(`document.querySelector("#src").value`)) === "zoom" && (await ev(`document.querySelector("#d").value`)) === new Date().toISOString().slice(0, 10));
  await click("#allP"); await click("#allH"); await sleep(100);
  await pick("a", 12, "late"); await pick("h", 13, "missing"); await setVal("#src", "whatsapp");
  await ev(`window.__SCEN.tables["cohort_sessions:insert"] = { data: { id: "c2", held_on: document.querySelector("#d").value, title: "第 2 课", source: "whatsapp", note: "" } };
            window.__SCEN.tables["cohort_marks:upsert"] = { data: [
              { session_id: "c2", submission_id: 11, attendance: "present", homework: "done" },
              { session_id: "c2", submission_id: 12, attendance: "late", homework: "done" },
              { session_id: "c2", submission_id: 13, attendance: "present", homework: "missing" }] }; true`);
  await click("#save"); await sleep(500);
  let u = await upd();
  const ins = u.find((x) => x.table === "cohort_sessions" && x.insert), ups = u.find((x) => x.table === "cohort_marks" && x.upsert);
  ok("C6 保存：先建上课记录，再一次写入全班出勤与作业", ins && ins.insert.cohort === "10月班" && ins.insert.source === "whatsapp" &&
     ups && ups.upsert.length === 3 && ups.opts.onConflict === "session_id,submission_id", JSON.stringify(u));
  ok("C7 每人的选择按点的来（全部出席后单独改迟到；全部已交后单独改未交）",
     JSON.stringify(ups.upsert.map((r) => [r.submission_id, r.attendance, r.homework])) === '[[11,"present","done"],[12,"late","done"],[13,"present","missing"]]');
  t = await txt();
  ok("C8 保存后列表多一次，汇总更新", t.includes("2 次上课") && t.includes("WhatsApp") && /B26-014\s*1 \/ 2/.test(t));

  // 写入没存全：如实说
  await click('[data-edit="c1"]'); await sleep(200);
  await ev(`window.__SCEN.tables["cohort_sessions:update"] = { data: [{ id: "c1", held_on: "2026-10-20", title: "第 4 课", source: "zoom", note: "" }] };
            window.__SCEN.tables["cohort_marks:upsert"] = { data: [] }; true`);
  await click("#save"); await sleep(400);
  ok("C9 出勤没存全时说清楚，让再保存一次", (await txt()).includes("没存全"));
  ok("C9b 修改时带出原来的勾选", (await ev(`document.querySelector('.seg button[data-k="a"][data-p="12"][data-v="absent"]')?.getAttribute("aria-pressed")`)) === "true");

  ok("C9c 教务能看到考勤专用备注且 HTML 不执行", (await txt()).includes("已提前请假 <b>考勤备注</b>") && !(await ev(`!!document.querySelector(".gr .nm b b")`)));

  // 删除：权限不够（删了 0 行）要说没删成
  await ev(`document.querySelector("#cancel").click(); window.__SCEN.tables["cohort_sessions:delete"] = { data: [] }; true`);
  await click('[data-del="c1"]'); await sleep(200);
  await click(".portal-modal [data-ok]"); await sleep(400);
  ok("C10 删除没成功（0 行）如实说", (await txt()).includes("没有删除成功") && (await txt()).includes("2026-10-20 · 第 4 课"));

  await shot("cohort");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  await open("portal/admin/cohort/?name=" + encodeURIComponent("10月班"), scen());
  await click("#add"); await sleep(200);
  const sw = await ev("document.documentElement.scrollWidth");
  ok("C11 360px 无横向滚动（含编辑区）", sw <= 360, `scrollWidth=${sw}`);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });

  await open("portal/admin/cohort/?name=" + encodeURIComponent("10月班"), scen({ cohort_sessions: { data: null, error: { message: "x" } } }));
  ok("C12 读失败如实说", (await txt()).includes("没能读到这个班的记录"));
  await open("portal/admin/cohort/", scen());
  ok("C13 没给班级名时说明从哪里进", (await txt()).includes("没有指定班级"));
  await open("portal/admin/cohort/?name=x", Object.assign({}, scen(), { rpc: { my_roles: { data: [{ role: "student" }] } } }));
  ok("C14 学员进不来", !(await txt()).includes("上课记录"));

  ok("O1 全程没有请求离开本机", h.external() === 0);
} catch (e) {
  h.fail("测试过程抛错：" + e.message);
}
process.exit((await h.close("COHORT PAGE")) ? 1 : 0);
