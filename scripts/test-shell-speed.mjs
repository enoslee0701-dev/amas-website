#!/usr/bin/env node
// 门户外壳提速回归（2026-10-26 Enos：切换板块慢）。本机 stub，见 lib/sis-harness.mjs。
//   S1 外壳先画：身份还没确认完，顶栏与菜单已经出来，主区是骨架
//   S2 身份确认不通过：外壳被拿掉，只剩停靠页（与提速前一致）
//   S3 my_roles 与 mfa_required 同时发出，不再一条等一条
//   S4 aal2 时不发 mfa_required（与提速前一致）
//   S5 顶栏名字：上一页读到过就先显示，退出登录清掉
//   S6 菜单项悬停即预取那一页
// 运行：node scripts/test-shell-speed.mjs
import { startHarness, sleep } from "./lib/sis-harness.mjs";

const h = await startHarness({ profilePrefix: "amas-speed-", shotPrefix: "speed" });
const { ok, open, ev, txt } = h;
const U = { session: { user: { id: "u-a", email: "a@example.invalid" } } };
const ROLES = { data: [{ role: "registrar" }] };
const PROFILE = { data: { display_name: "AMAS清迈分院院长", email: "a@example.invalid" } };
const base = (rpc, aal = "aal1") => Object.assign({}, U, { aal, rpc: Object.assign({ my_roles: ROLES, my_profile: PROFILE, mfa_required: { data: false } }, rpc),
  tables: { submissions: { data: [] }, submission_cohorts: { data: [] } } });

try {
  console.log("\n=== 外壳先画 ===");
  await open("portal/admin/inbox/", base({ my_roles: Object.assign({ delay: 1500 }, ROLES) }), 500);
  const early = await ev(`({ nav: !!document.querySelector(".portal-shell nav.pn a.nv"), sk: !!document.querySelector("#main .skeleton"),
                            busy: document.querySelector("#main")?.getAttribute("aria-busy") })`);
  ok("S1 身份还在确认时，顶栏与菜单已显示、主区是骨架", early.nav && early.sk && early.busy === "true", JSON.stringify(early));
  await sleep(1800);
  const late = await ev(`({ busy: document.querySelector("#main")?.hasAttribute("aria-busy"), h1: document.querySelector("#main h1")?.textContent })`);
  ok("S1b 确认完成后主区换成页面内容", !late.busy && late.h1 === "官网报名收件箱", JSON.stringify(late));

  await open("portal/admin/inbox/", base({ my_roles: { error: { message: "x" } } }));
  const blocked = await ev(`({ shell: !!document.querySelector(".portal-shell"), t: document.getElementById("portalBlockedTitle")?.textContent })`);
  ok("S2 身份读不到：外壳拿掉，只剩停靠页", !blocked.shell && /没能确认你的权限/.test(blocked.t || ""), JSON.stringify(blocked));
  await open("portal/admin/inbox/", Object.assign({}, U, { aal: "aal1", rpc: { my_roles: { data: [{ role: "student" }] }, my_profile: PROFILE } }));
  ok("S2b 没有这页的身份：外壳不留下教务菜单", !(await txt()).includes("报名收件箱") || !(await ev(`!!document.querySelector('.pn a[href*="admin/inbox"]')`)));

  console.log("\n=== 请求并行 ===");
  await open("portal/admin/inbox/", base({ my_roles: Object.assign({ delay: 600 }, ROLES), mfa_required: { data: false, delay: 600 } }), 2200);
  const calls = await ev(`(window.__rpc||[]).filter(r => ["my_roles","mfa_required","my_profile"].includes(r.name)).map(r => ({ n: r.name, t: Math.round(r.t) }))`);
  const t = (n) => (calls.find((c) => c.n === n) || {}).t;
  ok("S3 my_roles、mfa_required、my_profile 同时发出（相差 < 300ms）",
     [t("my_roles"), t("mfa_required"), t("my_profile")].every((x) => x != null) &&
     Math.max(t("my_roles"), t("mfa_required"), t("my_profile")) - Math.min(t("my_roles"), t("mfa_required"), t("my_profile")) < 300, JSON.stringify(calls));
  ok("S3b 页面照常进入（开关为 false，不跳两步验证）", (await ev(`location.pathname`)).endsWith("/portal/admin/inbox/"));
  await open("portal/admin/inbox/", base({}, "aal2"));
  ok("S4 已是 aal2 时不发 mfa_required", (await ev(`(window.__rpc||[]).filter(r => r.name === "mfa_required").length`)) === 0);
  await open("portal/admin/inbox/", base({ mfa_required: { data: true } }));
  ok("S4b 开关要求两步验证、本次是 aal1：照旧去两步验证页", (await ev(`location.pathname`)).includes("/portal/mfa/"));

  console.log("\n=== 顶栏名字与预取 ===");
  await open("portal/admin/inbox/", base({}));
  ok("S5 读到资料后显示名字并记住", (await ev(`document.querySelector(".ph-who")?.textContent`)).includes("AMAS清迈分院院长") &&
     (await ev(`sessionStorage.getItem("amas.shell-who")`))?.includes("AMAS清迈分院院长"));
  await open("portal/admin/", base({ my_roles: Object.assign({ delay: 1500 }, ROLES) }), 400);
  ok("S5b 下一页身份还没确认完就先显示名字", (await ev(`document.querySelector(".ph-who")?.textContent`)).includes("AMAS清迈分院院长"));
  await sleep(1600);
  await ev(`(()=>{ const a=document.querySelector('.pn a[href*="admin/offerings"]'); a.dispatchEvent(new PointerEvent("pointerenter")); return true; })()`);
  ok("S6 悬停菜单项即预取那一页", await ev(`[...document.querySelectorAll('link[rel=prefetch]')].some(l => l.href.includes("/portal/admin/offerings/"))`));
  await ev(`window.AmasAuth.signOut(); true`); await sleep(600);
  ok("S5c 退出登录后清掉记住的名字", (await ev(`sessionStorage.getItem("amas.shell-who")`)) === null);

  ok("O1 全程没有请求离开本机", h.external() === 0);
} catch (e) {
  h.fail("测试过程抛错：" + e.message);
}
process.exit((await h.close("SHELL SPEED")) ? 1 : 0);
