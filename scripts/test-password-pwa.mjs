#!/usr/bin/env node
// 强制改密码（统一开的学员账号）、「加到手机桌面」引导、管理后台数据总览（本机 stub，见 lib/sis-harness.mjs）。
// 运行：node scripts/test-password-pwa.mjs
import { startHarness, sleep } from "./lib/sis-harness.mjs";

const h = await startHarness({ profilePrefix: "amas-pwpwa-", shotPrefix: "pwpwa" });
const { ok, open, txt, click, setVal, ev, send } = h;
const stu = (must) => ({ session: { user: { id: "s1", email: "feili2026@student.amas.invalid", user_metadata: must ? { must_change_password: true } : {} } }, aal: "aal1",
  rpc: { my_roles: { data: [{ role: "student" }] }, my_student_record: { data: [] } } });
const upd = () => ev("JSON.stringify(window.__upd || [])").then(JSON.parse);

try {
  console.log("\n=== P 强制改密码 ===");
  await open("portal/student/records/", stu(true), 1500);
  ok("P1 带标记的账号进任何页都先去改密码，并记住原来要去哪", (await ev("location.pathname")).endsWith("/portal/password/") &&
     decodeURIComponent(await ev("location.search")).includes("/portal/student/records/"));
  await setVal("#p1", "short"); await setVal("#p2", "short"); await click("#go"); await sleep(200);
  ok("P2 少于 8 位不提交", (await txt()).includes("至少 8 位") && !(await upd()).length);
  await setVal("#p1", "mypass2026"); await setVal("#p2", "mypass2027"); await click("#go"); await sleep(200);
  ok("P3 两次不一致不提交", (await txt()).includes("不一样") && !(await upd()).length);
  await ev(`window.__SCEN.updateUser = { error: { code: "same_password", message: "New password should be different" } }; true`);
  await setVal("#p1", "feili1234"); await setVal("#p2", "feili1234"); await click("#go"); await sleep(400);
  ok("P4 和初始密码一样时说清楚", (await txt()).includes("不能和初始密码一样"));
  await ev(`window.__SCEN.updateUser = { data: { user: {} } }; window.__SCEN.session.user.user_metadata = {}; true`);
  /* 真实 SDK 改完会更新本地会话；stub 每次换页都重放场景，所以给之后的页面补一句「标记已清」 */
  const later = await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN && window.__SCEN.session && (window.__SCEN.session.user.user_metadata = {});" });
  await setVal("#p1", "mypass2026"); await setVal("#p2", "mypass2026"); await click("#go"); await sleep(1500);
  const last = JSON.parse((await ev(`sessionStorage.getItem("__updUser")`)) || "null");   // 已换页，按会话存储里记下的那次读
  ok("P5 改密码同时清掉标记", last && last.password === "mypass2026" && last.data && last.data.must_change_password === false, JSON.stringify(last));
  ok("P6 改完回到原来要去的页面", (await ev("location.pathname")).endsWith("/portal/student/records/"));
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: (later.result || later).identifier });
  await open("portal/student/records/", stu(false), 1200);
  ok("P7 没有标记的账号不受影响", (await ev("location.pathname")).endsWith("/portal/student/records/"));

  console.log("\n=== W 加到手机桌面 ===");
  ok("W1 门户页挂上 manifest 与苹果图标", (await ev(`!!document.querySelector('link[rel=manifest][href$="manifest.webmanifest"]') && !!document.querySelector('link[rel=apple-touch-icon]')`)));
  ok("W2 电脑上不弹引导", !(await ev(`!!document.getElementById("pwaGuide")`)));
  await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  await ev(`localStorage.removeItem("amas-pwa-guide-done"); true`);
  await open("portal/student/records/", stu(false), 3200);
  ok("W3 iPhone 第一次打开：底部出引导，教「分享 → 添加到主屏幕」", (await ev(`(document.getElementById("pwaGuide")||{}).textContent||""`)).includes("添加到主屏幕"));
  await click("#pwaOk"); await sleep(200);
  await open("portal/student/records/", stu(false), 3200);
  ok("W4 点过「知道了」不再出现", !(await ev(`!!document.getElementById("pwaGuide")`)));
  await send("Emulation.setUserAgentOverride", { userAgent: "" });

  console.log("\n=== D 数据总览 ===");
  const ADMIN = { session: { user: { id: "u-a", email: "a@example.invalid" } }, aal: "aal2", rpc: { my_roles: { data: [{ role: "super_admin" }] } },
    tables: { student_records: { data: [] }, cohort_sessions: { data: [{ id: "c1", cohort: "10月班", held_on: "2026-10-20", title: "第 4 课" }] },
      cohort_marks: { data: [{ attendance: "present" }, { attendance: "late" }, { attendance: "absent" }, { attendance: "present" }] },
      finance_entries: { data: [{ kind: "charge", amount: 3000, currency: "THB" }, { kind: "payment", amount: 1000, currency: "THB" }] },
      submissions: { data: [{ cohort: "10月班" }, { cohort: "10月班" }, { cohort: "11月班" }] } } };
  await open("portal/admin/", ADMIN, 2500);
  ok("D1 最近一次上课出勤率 75%", (await ev(`document.getElementById("dAtt").textContent`)) === "75%" && (await txt()).includes("10月班 10-20"));
  ok("D2 未收学费 ฿2,000", (await ev(`document.getElementById("dOwe").textContent`)) === "฿2,000");
  ok("D3 各班人数，点进去是上课记录", (await ev(`[...document.querySelectorAll("#dCoh a")].map(a => a.textContent + "@" + a.getAttribute("href")).join("|")`)) ===
     "10月班 2 人@cohort/?name=10%E6%9C%88%E7%8F%AD|11月班 1 人@cohort/?name=11%E6%9C%88%E7%8F%AD");
  ok("D4 读不到的项留「—」不写 0", (await ev(`document.getElementById("dStu").textContent`)) === "—" || /^\d+$/.test(await ev(`document.getElementById("dStu").textContent`)));
  ok("D5 总览有公告与课堂、费用管理入口", (await ev(`!!document.querySelector('.hub a[href="board/"]') && !!document.querySelector('.hub a[href="finance/"]')`)));


  console.log("\n=== T 待办提醒 ===");
  const TODO = { ...ADMIN, rpc: { ...ADMIN.rpc, admin_initial_password_list: { data: [{ name: "张培", cohort: "10月班" }, { name: "姜莹", cohort: "10月班" }] } },
    tables: { ...ADMIN.tables, submissions: { data: [{ cohort: "10月班" }], count: 1 }, submission_cohorts: { data: [{ name: "10月班", phase: "in_session" }, { name: "11月班", phase: "enrolling" }] },
      cohort_sessions: { data: [] }, finance_entries: { data: [], count: 0 }, site_announcements: { data: [], count: 0 }, site_settings: { data: { value: { enabled: false } } } } };
  await open("portal/admin/", TODO, 2500);
  const todo = await ev(`document.getElementById("todo").hidden ? "" : document.getElementById("todoList").innerText`);
  ok("T1 新报名待处理、已录取未分班", todo.includes("1 份报名 / 留言待处理") && todo.includes("1 名已录取学员还没分班"));
  ok("T2 开课的班没有上课记录要提醒，招生中的班不提", todo.includes("10月班已开课，但还没有任何上课记录") && !todo.includes("11月班"));
  ok("T3 没发过公告要提；学费未定、课堂每次才开，这两样不当待办（Enos 2026-10-28）", todo.includes("还没有发布过公告") && !todo.includes("学费") && !todo.includes("课堂入口"));
  ok("T4 列出还没改初始密码的人", todo.includes("2 名学员还没改初始密码") && todo.includes("张培、姜莹"));
  ok("T5 上课记录提醒点进去是那个班", (await ev(`[...document.querySelectorAll("#todoList a")].some(a => a.getAttribute("href") === "cohort/?name=10%E6%9C%88%E7%8F%AD")`)));
  const recent = new Date(Date.now() - 864e5 * 5).toISOString().slice(0, 10);
  const DONE = { ...TODO, rpc: { ...ADMIN.rpc, admin_initial_password_list: { data: [] } },
    tables: { ...TODO.tables, submissions: { data: [], count: 0 }, cohort_sessions: { data: [{ cohort: "10月班", held_on: new Date().toISOString().slice(0, 10) }] },
      finance_entries: { data: [], count: 3 }, site_announcements: { data: [], count: 1 }, site_settings: { data: { value: { enabled: true } } } } };
  await open("portal/admin/", DONE, 2500);
  ok("T6 都做了就显示「暂无待办」", (await ev(`document.getElementById("todo").hidden ? "" : document.getElementById("todo").innerText`)).includes("暂无待办"));
  await open("portal/admin/", { ...DONE, tables: { ...DONE.tables, cohort_sessions: { data: [{ cohort: "10月班", held_on: recent }] } } }, 2500);
  ok("T7 最近上课记录是 5 天前要提醒", (await ev(`document.getElementById("todoList").innerText`)).includes("最近一次上课记录是 5 天前"));
  const FAIL = { ...ADMIN, rpc: { ...ADMIN.rpc, admin_initial_password_list: { error: { message: "x" } } },
    tables: Object.fromEntries(["submissions", "submission_cohorts", "cohort_sessions", "finance_entries", "site_announcements", "site_settings"].map((k) => [k, { error: { message: "x" } }])) };
  await open("portal/admin/", FAIL, 2500);
  ok("T8 全都读不到就整块不出现，下面的入口照常", (await ev(`document.getElementById("todo").hidden`)) && (await ev(`!!document.querySelector('.hub a[href="inbox/"]')`)));

  console.log("\n=== L 线上课堂一步开关 ===");
  const soon = new Date(Date.now() + 3 * 36e5).toISOString();
  const LIVE = { ...DONE, tables: { ...DONE.tables, site_settings: { data: { value: { enabled: false, allow_guests: true, title: "周三神学课", url: "https://zoom.us/j/111", meeting_id: "111", passcode: "9" } } },
    "site_settings:update": { data: [{ value: { enabled: true, allow_guests: true, title: "周三神学课", url: "https://zoom.us/j/222", close_at: soon } }] } } };
  await open("portal/admin/", LIVE, 2500);
  ok("L1 没开时显示「没有开」，上次的链接已经填好", (await ev(`document.getElementById("lvState").textContent`)) === "没有开" &&
     (await ev(`document.getElementById("lvQuickUrl").value`)) === "https://zoom.us/j/111");
  await ev(`document.getElementById("lvQuickUrl").value = "zoom.us/j/222"`); await click("#lvOpen"); await sleep(300);
  ok("L2 链接不是 https 开头不保存", (await upd()).length === 0 && (await ev(`document.getElementById("lvMsg").textContent`)).includes("https://"));
  await ev(`document.getElementById("lvQuickUrl").value = "https://zoom.us/j/222"; document.getElementById("lvHours").value = "2"`);
  await click("#lvOpen"); await sleep(500);
  const w = (await upd()).find((u) => u.table === "site_settings");
  const closeIn = w && (new Date(w.patch.value.close_at) - Date.now()) / 36e5;
  ok("L3 开课堂：写入新链接、约 2 小时后自动关，标题等原设置保留，旧会议号 / 密码清掉",
     !!w && w.patch.value.enabled === true && w.patch.value.url === "https://zoom.us/j/222" && closeIn > 1.9 && closeIn <= 2 &&
     w.patch.value.title === "周三神学课" && w.patch.value.allow_guests === true && !("meeting_id" in w.patch.value) && !("passcode" in w.patch.value), JSON.stringify(w));
  ok("L4 保存后显示「开着」与自动关闭时间，出现「现在关闭」", /● 开着，\d\d:\d\d 自动关闭/.test(await ev(`document.getElementById("lvState").textContent`)) &&
     !(await ev(`document.getElementById("lvClose").hidden`)));
  await open("portal/admin/", { ...LIVE, tables: { ...LIVE.tables, site_settings: { data: { value: { enabled: true, url: "https://zoom.us/j/1", close_at: new Date(Date.now() - 6e4).toISOString() } } } } }, 2500);
  ok("L5 过了自动关闭时间就显示「没有开」", (await ev(`document.getElementById("lvState").textContent`)) === "没有开");
  await open("portal/admin/", { ...LIVE, tables: { ...LIVE.tables, site_settings: { data: null, error: { message: "x" } } } }, 2500);
  ok("L6 读不到设置就不显示这一块（不猜开没开）", await ev(`document.getElementById("live").hidden`));

  ok("O1 全程没有请求离开本机", h.external() === 0);
} catch (e) {
  h.fail("测试过程抛错：" + e.message);
}
process.exit((await h.close("PASSWORD & PWA & DASH")) ? 1 : 0);
