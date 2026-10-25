#!/usr/bin/env node
// 官网报名收件箱（portal/admin/inbox/）的本地功能测试（本机 stub，见 lib/sis-harness.mjs）。
// 运行：node scripts/test-inbox-page.mjs [--shots]
import { startHarness, sleep } from "./lib/sis-harness.mjs";

const h = await startHarness({ profilePrefix: "amas-inbox-", shotPrefix: "inbox" });
const { ok, open, txt, click, setVal, ev, shot, send } = h;
const ADMIN = { session: { user: { id: "u-admin", email: "a@example.invalid" } }, aal: "aal2" };
const STU = { session: { user: { id: "s-u1", email: "st@example.invalid" } }, aal: "aal1" };
const ROWS = [
  { id: 3, created_at: "2026-10-20T08:00:00Z", type: "application", name: "陈恩典", contact: "en@example.invalid", program: "bth", lang: "zh",
    status: "待处理", note: "", data: { fullName: "陈恩典", gender: "female", churchType: "house", program: "bth", phone: "+86 138 0000 0000",
    motivation: "蒙召服事", _autoresponse: "感谢", _subject: "AMAS 入学申请 [bth] — 陈恩典" } },
  { id: 2, created_at: "2026-10-01T08:00:00Z", type: "application", name: "<img src=x onerror=window.__x=1>", contact: "x@example.invalid",
    program: "mdiv", lang: "zh", status: "已联系", note: "已电话联系", data: { fullName: "<img src=x onerror=window.__x=1>", _source: "email_import" } },
  { id: 1, created_at: "2026-09-21T08:00:00Z", type: "contact", name: "李弟兄", contact: "13900000000", program: "", lang: "zh",
    status: "待处理", note: "", data: { name: "李弟兄", message: "想了解学费" } },
];
const scen = (tables = {}) => Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] } },
  tables: Object.assign({ submissions: { data: JSON.parse(JSON.stringify(ROWS)) } }, tables) });
const upd = () => ev("JSON.stringify(window.__upd || [])").then(JSON.parse);

try {
  console.log("\n=== I 官网报名收件箱 ===");
  await open("portal/admin/inbox/", scen());
  let t = await txt();
  ok("I1 默认显示入学申请：姓名、课程名称、联系方式", t.includes("陈恩典") && t.includes("神学学士 B.Th") && t.includes("en@example.invalid") && !t.includes("李弟兄"));
  ok("I2 分类标签带待处理数", t.includes("入学申请（1 待处理）") && t.includes("咨询留言（1 待处理）"));
  ok("I3 资料译成中文、隐藏表单内部字段", t.includes("性别") && t.includes("女") && t.includes("家庭教会") && t.includes("报读动机") &&
     !t.includes("_autoresponse") && !t.includes("感谢"));
  ok("I4 从邮箱补录的有标记，备注显示", t.includes("从邮箱补录") && t.includes("备注：已电话联系"));
  ok("I5 姓名里的 HTML 不被执行", (await ev("window.__x === undefined")) && t.includes("<img src=x"));

  await click('#ft button[data-t="contact"]'); await sleep(150);
  t = await txt();
  ok("I6 切到咨询留言", t.includes("李弟兄") && t.includes("想了解学费") && !t.includes("陈恩典"));
  await click('#ft button[data-t=""]'); await sleep(150);
  await setVal("#q", "1390000"); await ev(`document.querySelector("#q").dispatchEvent(new Event("input")); true`); await sleep(150);
  t = await txt();
  ok("I7 按电话搜索", t.includes("李弟兄") && !t.includes("陈恩典"));
  await setVal("#q", ""); await ev(`document.querySelector("#q").dispatchEvent(new Event("input")); true`);
  await click('#ft button[data-t="application"]'); await sleep(150);

  // 改状态：stub 回改好的那一行
  await ev(`window.__SCEN.tables["submissions:update"] = { data: [Object.assign({}, window.__SCEN.tables.submissions.data[0], { status: "已联系" })] }; true`);
  await click('[data-id="3"][data-s="已联系"]'); await sleep(400);
  let u = await upd();
  t = await txt();
  ok("I8 标为已联系：只改 status，页面随之更新", u.length === 1 && u[0].table === "submissions" && JSON.stringify(u[0].patch) === '{"status":"已联系"}' &&
     t.includes("入学申请（") === false && !(await ev(`!!document.querySelector('[data-id="3"][data-s="已联系"]')`)));

  // RLS 拦下：PostgREST 回空数组
  await ev(`window.__SCEN.tables["submissions:update"] = { data: [] }; true`);
  await click('[data-id="3"][data-s="已录取"]'); await sleep(400);
  t = await txt();
  ok("I9 没改成（空结果）如实说没保存，状态不变", t.includes("没有保存") && (await ev(`!!document.querySelector('[data-id="3"][data-s="已录取"]')`)));

  await ev(`window.__SCEN.tables["submissions:update"] = { data: [Object.assign({}, window.__SCEN.tables.submissions.data[0], { status: "已联系", note: "下周面谈" })] }; true`);
  await click('[data-id="3"][data-note]'); await sleep(200);
  await setVal("#ask-note", "下周面谈"); await click(".portal-modal [data-ok]"); await sleep(400);
  u = await upd();
  ok("I10 写备注只改 note", JSON.stringify(u[u.length - 1].patch) === '{"note":"下周面谈"}' && (await txt()).includes("备注：下周面谈"));

  await shot("inbox");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  await open("portal/admin/inbox/", scen());
  await click("details summary"); await sleep(100);
  const sw = await ev("document.documentElement.scrollWidth");
  ok("I11 360px 无横向滚动", sw <= 360, `scrollWidth=${sw}`);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });

  await open("portal/admin/inbox/", scen({ submissions: { data: null, error: { message: "x" } } }));
  t = await txt();
  ok("I12 读失败如实说，不显示「还没有记录」", t.includes("没能读到收件箱") && !t.includes("还没有记录"));
  await open("portal/admin/inbox/", scen({ submissions: { data: [] } }));
  ok("I13 真没有记录时说明会自动出现", (await txt()).includes("会自动出现在这里"));

  await open("portal/admin/inbox/", Object.assign({}, STU, { rpc: { my_roles: { data: [{ role: "student" }] } },
    tables: { submissions: { data: ROWS } } }));
  t = await txt();
  ok("I14 学员进不来、看不到报名", !t.includes("陈恩典") && !t.includes("官网报名收件箱（"));

  await open("portal/admin/", Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] } } }));
  ok("I15 管理后台首页有收件箱入口", await ev(`!!document.querySelector('.hub a[href="inbox/"]')`));

  ok("O1 全程没有请求离开本机", h.external() === 0);
} catch (e) {
  h.fail("测试过程抛错：" + e.message);
}
process.exit((await h.close("ADMIN INBOX PAGE")) ? 1 : 0);
