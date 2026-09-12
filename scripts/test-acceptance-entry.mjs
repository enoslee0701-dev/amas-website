/* 验收入口**自己**的判定逻辑（监督在 3655d7c 上提的三条）。
   全程离线：只喂合成的 stdout 与退出码，不开浏览器、不跑任何套件。

   要验的三件事：
     A  KNOWN_BASELINE_FAIL 必须严格匹配已知断言指纹 ——
        不能把该套件**任何**新增失败都一并豁免掉。
     B  汇总行认不出来时，不能当成总体成功。
     C  固定 SHA：若运行当中工作树或 HEAD 变了，结果不能归属到那个 SHA。
*/
import * as M from "./acceptance-offline.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  ← " + detail : "")); }
};
/* 拿不到那个导出就算这条红 —— 缺一条保证和判错一样严重，
   但不能让整个套件崩掉。 */
const call = (fn, ...a) => {
  if (typeof M[fn] !== "function") return { __missing: fn };
  try { return M[fn](...a); } catch (e) { return { __threw: String(e && e.message) }; }
};
const stateOf = (r) => (r && r.state) || (r && r.__missing ? "缺少导出 " + r.__missing : JSON.stringify(r));

// touch-targets 的两条既有失败，取自 evidence/web-round17 的原始输出（逐字）
const T0 = "FAIL T0 负向控制：还原本轮 CSS 后，六个入口精确回到修复前实测的 64x27 / 52x25 | 下载 新生手册 量到 66x25，修复前记录是 64x27";
const T5 = "FAIL T5 跳转链接聚焦后出现在屏幕上、完整可见、且合格（>= 44x44） | 聚焦=false 128x44 完整在视口内=false";
const BASE_OUT = [T0, T5, "", "18/20 通过"].join("\n");
const B = M.KNOWN_BASELINE_FAIL;

console.log("\n=== A 既有基线只豁免登记过的那几条 ===");
const a1 = call("classify", { suite: "touch-targets", code: 1, out: BASE_OUT }, B);
ok("A1 原样的两条既有失败仍算「既有基线」", stateOf(a1) === "既有基线", stateOf(a1));

const NEWFAIL = "FAIL T9 底部导航在 390px 下被遮住 | 实测 overlap=12px";
const a2 = call("classify", { suite: "touch-targets", code: 1,
  out: [T0, T5, NEWFAIL, "", "17/20 通过"].join("\n") }, B);
ok("A2 同一套件里**新增**一条失败时，不再豁免", stateOf(a2) === "失败", stateOf(a2));

const a3 = call("classify", { suite: "touch-targets", code: 1,
  out: [NEWFAIL, "", "19/20 通过"].join("\n") }, B);
ok("A3 只剩一条**没登记过**的失败时，也不豁免", stateOf(a3) === "失败", stateOf(a3));

const a4 = call("classify", { suite: "portal-pages", code: 1,
  out: ["FAIL 随便什么", "", "111/112 通过"].join("\n") }, B);
ok("A4 没登记基线的套件失败就是失败（对照）", stateOf(a4) === "失败", stateOf(a4));

const a5 = call("classify", { suite: "touch-targets", code: 0, out: "20/20 通过" }, B);
ok("A5 既有失败不再复现时算通过，不因为「和登记的不一样」而判红",
   stateOf(a5) === "通过", stateOf(a5));

const a6 = call("classify", { suite: "touch-targets", code: 1,
  out: [T5, "", "19/20 通过"].join("\n") }, B);
ok("A6 登记了两条、这次只复现一条，仍算既有基线（改好了不该判红）",
   stateOf(a6) === "既有基线", stateOf(a6));

console.log("\n=== B 汇总认不出来就不能算成功 ===");
const b1 = call("classify", { suite: "whatever", code: 0,
  out: "启动完成\n做了一些事情\n再见" }, B);
ok("B1 退出码 0 但汇总认不出来时，不算「通过」", stateOf(b1) !== "通过", stateOf(b1));
ok("B1b 而且要计入失败（不能悄悄放过）",
   typeof M.isFailure === "function" && M.isFailure(stateOf(b1)) === true, stateOf(b1));

const b2 = call("classify", { suite: "whatever", code: 0, out: "  PASS 5  FAIL 0" }, B);
ok("B2 正常的汇总仍然算通过（对照）", stateOf(b2) === "通过", stateOf(b2));

const b3 = call("classify", { suite: "whatever", code: 0, out: "  PASS 3  FAIL 2" }, B);
ok("B3 退出码说成功、汇总却报了 2 条失败：不算通过", stateOf(b3) !== "通过", stateOf(b3));

const b4 = call("classify", { suite: "whatever", code: 0, out: "\n0/0 通过" }, B);
ok("B4 一条断言都没跑过的「0/0 通过」不算通过", stateOf(b4) !== "通过", stateOf(b4));

const b5 = call("classify", { suite: "whatever", code: 0, out: "112/112 通过" }, B);
ok("B5 另一种汇总格式也照常识别（对照）", stateOf(b5) === "通过", stateOf(b5));

console.log("\n=== C 运行当中 HEAD/工作树变了，结果不能归属那个 SHA ===");
const same = { head: "a".repeat(40), dirty: "" };
const c1 = call("attribution", same, same);
ok("C1 前后一致时可以归属", c1 && c1.ok === true, JSON.stringify(c1));

const c2 = call("attribution", same, { head: "b".repeat(40), dirty: "" });
ok("C2 运行中 HEAD 变了就拒绝归属", c2 && c2.ok === false, JSON.stringify(c2));

const c3 = call("attribution", same, { head: "a".repeat(40), dirty: "M x.html" });
ok("C3 运行中工作树被改动也拒绝归属", c3 && c3.ok === false, JSON.stringify(c3));

const c5 = call("attribution", { head: "a".repeat(40), dirty: "M x.html" },
                              { head: "a".repeat(40), dirty: "M x.html" });
ok("C5 全程没变、但一直带着未提交改动：同样不归属那个 SHA",
   c5 && c5.ok === false, JSON.stringify(c5));

ok("C4 拒绝时说得出是哪一项变了",
   !!(c2 && typeof c2.reason === "string" && /HEAD/.test(c2.reason)), JSON.stringify(c2));

console.log(`\n  PASS ${pass}  FAIL ${fail}`);
console.log("本套件全程离线：只喂合成的 stdout 与退出码，未启动浏览器、未跑任何被测套件。");
process.exit(fail ? 1 : 0);
