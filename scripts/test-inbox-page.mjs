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
    status: "待处理", note: "", cohort: "", data: { fullName: "陈恩典", gender: "female", churchType: "house", program: "bth", phone: "+86 138 0000 0000",
    motivation: "蒙召服事", _autoresponse: "感谢", _subject: "AMAS 入学申请 [bth] — 陈恩典" } },
  { id: 2, created_at: "2026-10-01T08:00:00Z", type: "application", name: "<img src=x onerror=window.__x=1>", contact: "x@example.invalid",
    program: "mdiv", lang: "zh", status: "已联系", note: "已电话联系", cohort: "10月班", data: { fullName: "<img src=x onerror=window.__x=1>", _source: "email_import" } },
  { id: 1, created_at: "2026-09-21T08:00:00Z", type: "contact", name: "李弟兄", contact: "13900000000", program: "", lang: "zh",
    status: "待处理", note: "", data: { name: "李弟兄", message: "想了解学费" } },
];
const COH = [{ name: "10月班", starts_on: null, progress: "新信徒教材：已学完第 4 课", sort: 1, updated_at: "2026-10-26T03:00:00Z" },
             { name: "11月班", starts_on: "2026-10-28", progress: "", sort: 2, updated_at: "2026-10-26T03:00:00Z" }];
const scen = (tables = {}) => Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] } },
  tables: Object.assign({ submissions: { data: JSON.parse(JSON.stringify(ROWS)) }, submission_cohorts: { data: JSON.parse(JSON.stringify(COH)) } }, tables) });
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

  // 分班（0037）
  t = await txt();
  const fc = await ev(`[...document.querySelectorAll("#fc option")].map(o => o.textContent).join("|")`);
  ok("I16 卡片显示班级，班级筛选带人数", t.includes("10月班") && fc === "全部|10月班（1）|11月班（0）|未分班（2）", fc);
  await setVal("#fc", "10月班"); await ev(`document.querySelector("#fc").dispatchEvent(new Event("change")); true`); await sleep(150);
  t = await txt();
  ok("I17 按班级筛选", !t.includes("陈恩典") && (await ev(`document.querySelectorAll("#list .of").length`)) === 1);
  await setVal("#fc", ""); await ev(`document.querySelector("#fc").dispatchEvent(new Event("change")); true`); await sleep(150);
  await ev(`window.__SCEN.tables["submissions:update"] = { data: [Object.assign({}, window.__SCEN.tables.submissions.data[0], { status: "已联系", note: "下周面谈", cohort: "11月班" })] }; true`);
  await click('[data-id="3"][data-cohort]'); await sleep(200);
  await setVal("#ask-cohort", "11月班"); await click(".portal-modal [data-ok]"); await sleep(400);
  u = await upd();
  ok("I18 分班只改 cohort，页面随之更新", JSON.stringify(u[u.length - 1].patch) === '{"cohort":"11月班"}' &&
     (await ev(`document.querySelector("#s-3").textContent.includes("11月班")`)));

  // 班级与课程进度（0038）
  t = await txt();
  ok("I19 班级区显示开课日、进度与人数", t.includes("新信徒教材：已学完第 4 课") && t.includes("开课：2026-10-28") && t.includes("还没有记录课程进度"));
  await ev(`window.__SCEN.tables["submission_cohorts:update"] = { data: [Object.assign({}, window.__SCEN.tables.submission_cohorts.data[0], { progress: "新信徒教材：已学完第 5 课" })] }; true`);
  await click('[data-cname="10月班"]'); await sleep(200);
  await setVal("#ask-progress", "新信徒教材：已学完第 5 课"); await click(".portal-modal [data-ok]"); await sleep(400);
  u = await upd();
  ok("I20 更新进度写 submission_cohorts，页面随之更新", u[u.length - 1].table === "submission_cohorts" && u[u.length - 1].patch.progress === "新信徒教材：已学完第 5 课" &&
     (await txt()).includes("已学完第 5 课"));
  await ev(`window.__SCEN.tables["submission_cohorts:insert"] = { data: { name: "12月班", starts_on: null, progress: "", sort: 3 } }; true`);
  await click("#newCohort"); await sleep(200);
  await setVal("#ask-name", "12月班"); await click(".portal-modal [data-ok]"); await sleep(400);
  u = await upd();
  ok("I21 新建班级后可在分班里选到", u[u.length - 1].insert && u[u.length - 1].insert.name === "12月班" &&
     (await ev(`[...document.querySelectorAll("#fc option")].some(o => o.textContent.startsWith("12月班"))`)));
  ok("I22 入学申请才有申请表入口", (await ev(`!!document.querySelector('#s-3 a[href="form/?id=3"]')`)));

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

  // ═══ 入学申请表 ═══
  console.log("\n=== F 入学申请表 ===");
  const FROW = Object.assign({}, ROWS[0], { id: 3, cohort: "11月班", school_form: {}, data: Object.assign({}, ROWS[0].data,
    { englishName: "Grace", nationality: "C", birth: "1990-05", language: "mandarin", location: "清迈", church: "恩典堂", role: "司琴",
      eduSchool: "清迈大学", eduLevel: "bachelor", conversionDate: "2005-10", baptismDate: "2006-01", referrer: "李牧师", submittedAt: "2026-10-20T08:00:00Z" }) });
  const fscen = (row, extra = {}) => Object.assign({}, ADMIN, { rpc: { my_roles: { data: [{ role: "registrar" }] } },
    tables: Object.assign({ submissions: { data: row } }, extra) });
  await open("portal/admin/inbox/form/?id=3", fscen(FROW));
  const fv = (k) => ev(`(document.querySelector('[data-k="${k}"]') || {}).innerText`);
  const pressed = () => ev(`[...document.querySelectorAll('.ck[aria-pressed="true"]')].map(b => b.dataset.ck + "=" + b.dataset.v).join("|")`);
  ok("F1 表头与总校表格一致", (await txt()).includes("神学校入学申请表") && (await txt()).includes("自我介绍及信仰见证") && (await txt()).includes("家庭状况"));
  ok("F2 按报名资料预填", (await fv("name_zh")) === "陈恩典" && (await fv("name_en")) === "Grace" && (await fv("mobile")) === "+86 138 0000 0000" &&
     (await fv("edu0_school")) === "清迈大学" && (await fv("edu0_degree")) === "本科" && (await fv("work0_title")) === "司琴" &&
     (await fv("apply_date")) === "2026-10-20" && (await fv("testimony")) === "蒙召服事" && (await fv("referrer")) === "李牧师");
  ok("F3 国籍 C 写成中国", (await fv("nationality")) === "中国");
  ok("F4 勾选项预填：课程、性别、语言、教会种类", (await pressed()) === "course=大学（B.TH）|gender=女|language=普通话|church_type=家庭", await pressed());
  await ev(`document.querySelector('[data-k="health"]').innerText = "良好"; document.querySelector('[data-k="health"]').dispatchEvent(new Event("input")); true`);
  await click('.ck[data-ck="gender"][data-v="男"]');
  await ev(`window.__SCEN.tables["submissions:update"] = { data: [{ id: 3 }] }; true`);
  await click("#save"); await sleep(400);
  let fu = (await upd()).pop();
  ok("F5 保存只写 school_form，包含补填与改动", fu && Object.keys(fu.patch).join() === "school_form" && fu.patch.school_form.health === "良好" &&
     fu.patch.school_form.gender === "男" && fu.patch.school_form.name_zh === "陈恩典" && !("vision" in fu.patch.school_form));
  ok("F6 保存后提示已保存", (await txt()).includes("已保存"));
  await ev(`window.__SCEN.tables["submissions:update"] = { data: [] }; true`);
  await click("#save"); await sleep(400);
  ok("F7 没存成如实说", (await txt()).includes("没有保存成功"));
  await open("portal/admin/inbox/form/?id=3", fscen(Object.assign({}, FROW, { school_form: { name_zh: "陈恩典", health: "良好", gender: "男" } })));
  ok("F8 已保存的以保存内容为准，不再用报名资料补", (await fv("health")) === "良好" && (await pressed()).includes("gender=男") && (await fv("name_en")) === "Grace");
  await ev(`window.__printed = 0; window.print = function(){ window.__printed++; }; true`);
  await click("#print");
  ok("F9 打印按钮调用浏览器打印", (await ev("window.__printed")) === 1);
  await send("Emulation.setEmulatedMedia", { media: "print" });
  ok("F10 打印时隐藏导航与按钮", await ev(`["nav.pn","header.ph",".af-acts"].every(s => { const e = document.querySelector(s); return !e || getComputedStyle(e).display === "none"; })`));
  await send("Emulation.setEmulatedMedia", { media: "" });
  await shot("form");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  await open("portal/admin/inbox/form/?id=3", fscen(FROW));
  const fsw = await ev("document.documentElement.scrollWidth");
  ok("F11 360px 页面不横向滚动（表格在框内滑动）", fsw <= 360, `scrollWidth=${fsw}`);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
  await open("portal/admin/inbox/form/?id=3", fscen(null, {}));
  ok("F12 找不到记录时如实说", (await txt()).includes("找不到这份报名"));
  await open("portal/admin/inbox/form/?id=3", fscen(null, { submissions: { data: null, error: { message: "x" } } }));
  ok("F13 读失败如实说", (await txt()).includes("没能读到这份报名"));

  // 官网新表（与总校表同栏位名）原样带入
  const NROW = Object.assign({}, FROW, { school_form: {}, data: Object.assign({}, FROW.data, { program: "missionary", eduLevel: "master",
    phone_fixed: "053-111111", health: "良好", vision: "回乡宣教", fam0_rel: "配偶", fam0_name: "王弟兄",
    edu0_school: "神学院", edu1_school: "清迈大学", work0_org: "恩典堂", work0_title: "传道" }) });
  await open("portal/admin/inbox/form/?id=3", fscen(NROW));
  ok("F14 官网新栏位直接带入申请表", (await fv("phone_fixed")) === "053-111111" && (await fv("health")) === "良好" && (await fv("vision")) === "回乡宣教" &&
     (await fv("fam0_name")) === "王弟兄" && (await fv("edu1_school")) === "清迈大学" && (await fv("edu0_degree")) === "硕士及以上" &&
     (await fv("work0_title")) === "传道" && (await pressed()).startsWith("course=宣教士训练"));

  ok("O1 全程没有请求离开本机", h.external() === 0);
} catch (e) {
  h.fail("测试过程抛错：" + e.message);
}
process.exit((await h.close("ADMIN INBOX PAGE")) ? 1 : 0);
