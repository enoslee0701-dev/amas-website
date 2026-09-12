/* review-application 的请求形状校验 —— 打的是**真实那份代码**：
   本套件 import 的就是 Edge 处理器自己 import 的
   supabase/functions/review-application/validate.mjs，不是抄一份到测试里比对。

   全程离线：不开浏览器、不联网、不起 Deno、不碰任何数据库。
   ⚠ 它验的是「请求长得对不对」。授权（角色 / aal2）与业务判断（终态、并发、
     被指派人是否仍有角色）不在这里，也不在本套件的范围内 —— 那些仍是 NOT_RUN。 */
import { validateBody, ACTIONS } from "../supabase/functions/review-application/validate.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  ← " + detail : "")); }
};
/* 校验函数**不许抛** —— 抛出去在 Deno 里就是 500，而客户端按既有判据会把 500
   当「结果不明」并永久锁住那一条。抛了也算红。 */
const V = (body) => {
  try { return validateBody(body); }
  catch (e) { return { __threw: String((e && e.message) || e) }; }
};
const A = "11111111-2222-3333-4444-555555555555";   // application_id
const R = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";   // reviewer_id
const R2 = "99999999-8888-7777-6666-555555555555";
const code = (r) => (r && (r.__threw ? "抛了：" + r.__threw : (r.ok ? "ok:" + r.mode : r.code))) || String(r);

console.log("\n=== J 请求体本身站不站得住 ===");
for (const [label, body] of [["null", null], ["数组", []], ["字符串", "hi"], ["数字", 7]]) {
  const r = V(body);
  ok("J1 " + label + " 体不抛异常，明确 400", r && r.ok === false && r.status === 400 && !r.__threw, code(r));
}
ok("J2 少了 application_id → 400", code(V({ action: "accept" })) === "bad_request");
ok("J3 application_id 不是 UUID → 400", code(V({ application_id: "app-1", action: "accept" })) === "bad_request");

console.log("\n=== K 两条分支按「键是否存在」严格互斥 ===");
/* 监督点名的那一条：用值判断会放过 action:null。 */
ok("K1 {op:'assign', action:null} 被拒（这是「同时带 op 与 action」的一种写法）",
   code(V({ application_id: A, op: "assign", action: null, reviewer_id: R, expected_reviewer: null }))
   === "bad_request");
ok("K1b {op:'assign', action:undefined} 同样被拒（键存在就算）",
   code(V({ application_id: A, op: "assign", action: undefined, reviewer_id: R, expected_reviewer: null }))
   === "bad_request");
ok("K2 {op:'assign', action:'accept'} 被拒",
   code(V({ application_id: A, op: "assign", action: "accept", reviewer_id: R, expected_reviewer: null }))
   === "bad_request");
ok("K3 op 不是 'assign' 被拒",
   code(V({ application_id: A, op: "unassign", reviewer_id: R, expected_reviewer: null })) === "bad_request");

console.log("\n=== L 指派分支的字段 ===");
ok("L1 缺 expected_reviewer 这个键 → expected_required（不当成 null）",
   code(V({ application_id: A, op: "assign", reviewer_id: R })) === "expected_required");
ok("L2 显式 expected_reviewer:null 通过（表示「我看到的是未指派」）",
   code(V({ application_id: A, op: "assign", reviewer_id: R, expected_reviewer: null })) === "ok:assign");
ok("L3 缺 reviewer_id 这个键 → 400",
   code(V({ application_id: A, op: "assign", expected_reviewer: null })) === "bad_request");
ok("L4 reviewer_id:null 通过（取消指派）",
   code(V({ application_id: A, op: "assign", reviewer_id: null, expected_reviewer: R })) === "ok:assign");
ok("L5 reviewer_id 不是 UUID → 400",
   code(V({ application_id: A, op: "assign", reviewer_id: "u-ok1", expected_reviewer: null })) === "bad_request");
ok("L6 expected_reviewer 不是 UUID → 400",
   code(V({ application_id: A, op: "assign", reviewer_id: R, expected_reviewer: "somebody" })) === "bad_request");
ok("L7 note 不是字符串也不是 null → 400",
   code(V({ application_id: A, op: "assign", reviewer_id: R, expected_reviewer: null, note: 5 })) === "bad_request");
ok("L8 重新指派（两端都是 UUID）通过",
   code(V({ application_id: A, op: "assign", reviewer_id: R, expected_reviewer: R2 })) === "ok:assign");

console.log("\n=== M 审核动作分支 ===");
ok("M1 未知 action → 400", code(V({ application_id: A, action: "delete_everything" })) === "bad_request");
ok("M2 action 不是字符串 → 400", code(V({ application_id: A, action: 3 })) === "bad_request");
ok("M3 needs_information 不给条目 → requirements_required",
   code(V({ application_id: A, action: "needs_information" })) === "requirements_required");
ok("M4 needs_information 给空数组 → requirements_required",
   code(V({ application_id: A, action: "needs_information", requirements: [] })) === "requirements_required");
ok("M5 needs_information 给了条目 → 通过",
   code(V({ application_id: A, action: "needs_information", requirements: [{ label: "补受洗证明" }] })) === "ok:action");
ok("M6 message 类型不对 → 400",
   code(V({ application_id: A, action: "accept", message: { a: 1 } })) === "bad_request");
ok("M7 requirements 类型不对 → 400",
   code(V({ application_id: A, action: "accept", requirements: "两条" })) === "bad_request");

console.log("\n=== N 对照：客户端**实际发出**的两种请求必须通过 ===");
/* 形状取自 portal/admin/admissions/index.html 里 act() 与 saveAssign() 的调用。 */
ok("N1 act() 的审核请求（message/requirements/internal_note 都是 null）",
   code(V({ application_id: A, action: "accept", message: null, requirements: null, internal_note: null }))
   === "ok:action");
ok("N2 act() 的补件请求",
   code(V({ application_id: A, action: "needs_information", message: "请补一份受洗证明",
            requirements: [{ label: "受洗证明", detail: "", field: null }], internal_note: null }))
   === "ok:action");
ok("N3 saveAssign() 的指派请求", 
   code(V({ application_id: A, op: "assign", reviewer_id: R, expected_reviewer: null, note: null }))
   === "ok:assign");
ok("N4 saveAssign() 的取消指派请求",
   code(V({ application_id: A, op: "assign", reviewer_id: null, expected_reviewer: R, note: null }))
   === "ok:assign");
ok("N5 四个动作名一个都没少", ACTIONS.length === 4 &&
   ["start_review", "needs_information", "accept", "reject"].every(a => ACTIONS.includes(a)), JSON.stringify(ACTIONS));

console.log(`\n  PASS ${pass}  FAIL ${fail}`);
console.log("本套件只跑真实的 validate.mjs：未开浏览器、未联网、未起 Deno、未碰数据库。");
console.log("NOT_RUN：Edge 处理器整体、授权（角色/aal2）、0027 的 RPC —— 本轮都没有执行过。");
process.exit(fail ? 1 : 0);
