#!/usr/bin/env node
// 管理后台新界面截图（本机 stub，不连真实后端）：宽屏 1280 与手机 390。
// 运行：SHOT_DIR=<目录> node scripts/shot-admin-ui.mjs --shots
import { startHarness, sleep } from "./lib/sis-harness.mjs";
const h = await startHarness({ profilePrefix: "amas-ui-", shotPrefix: "ui" });
const { open, shot, send, click } = h;
const ADMIN = { session: { user: { id: "u-a", email: "a@example.invalid" } }, aal: "aal2",
  rpc: { my_roles: { data: [{ role: "super_admin" }] } } };
const COH = [{ name: "10月班", starts_on: null, progress: "已开课。新信徒教材：已学完第 4 课。", sort: 1, updated_at: "2026-10-26T03:45:00Z" },
             { name: "11月班", starts_on: "2026-10-28", progress: "2026-10-28（周三）正式开课。", sort: 2, updated_at: "2026-10-26T03:45:00Z" }];
const ROWS = [{ id: 1, created_at: "2026-10-25T23:29:00Z", type: "application", name: "示例学员", contact: "13800000000", program: "bth", status: "已录取",
  note: "", cohort: "11月班", school_form: {}, data: { fullName: "示例学员", _source: "email_import" } },
  { id: 2, created_at: "2026-10-19T07:58:00Z", type: "application", name: "示例学员二", contact: "x@example.invalid", program: "bth", status: "已录取",
  note: "", cohort: "10月班", school_form: {}, data: { fullName: "示例学员二" } }];
const scen = Object.assign({}, ADMIN, { tables: { submissions: { data: ROWS }, submission_cohorts: { data: COH } } });
try {
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await open("portal/admin/inbox/", scen); await sleep(300); await shot("inbox-wide");
  await open("portal/admin/", scen); await sleep(600); await shot("home-wide");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await open("portal/admin/inbox/", scen); await sleep(300); await shot("inbox-phone");
  await click("#shellMenu"); await sleep(400); await shot("drawer-phone");
} catch (e) { h.fail(e.message); }
process.exit((await h.close("ADMIN UI SHOTS")) ? 1 : 0);
