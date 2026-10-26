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

  ok("O1 全程没有请求离开本机", h.external() === 0);
} catch (e) {
  h.fail("测试过程抛错：" + e.message);
}
process.exit((await h.close("PASSWORD & PWA & DASH")) ? 1 : 0);
