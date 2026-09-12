/* review-application 的**请求形状校验**，单独成文件的唯一目的：
   让它能被离线执行、被反例打。Edge 处理器 import 它，测试也 import 同一个文件 ——
   不是抄一份到测试里比对，那样改一处忘一处就没人发现。

   这里只管「这个请求长得对不对」。授权（角色 / aal2）与业务判断（终态、并发、
   被指派人是否仍有角色）都不在这里 —— 它们分别在处理器与 0027 的 RPC 里。 */

export const ACTIONS = ["start_review", "needs_information", "accept", "reject"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = { ok: false, status: 400, code: "bad_request" };
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);
const isNullOrUuid = (v) => v === null || isUuid(v);
const isNullOrString = (v) => v === null || typeof v === "string";

/** @param body 已经 JSON.parse 过的东西（可能是 null / 数组 / 字符串 —— 都要挡住） */
export function validateBody(body) {
  /* req.json() 对 "null" 这个合法 JSON 会返回 null；对 "[]" 返回数组。
     不先挡住，后面 body.application_id 就是一次 TypeError ——
     Deno 把它变成 500，客户端按既有判据会把它当「结果不明」并**永久锁住**那一条。
     形状不对是**确定的拒绝**，必须回 400，不能让它退化成不明。 */
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad;

  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!isUuid(body.application_id)) return bad;

  /* 两条分支按**键是否存在**严格互斥。
     用值判断（!== null && !== undefined）会放过 {op:"assign", action:null} —— 
     那正是「同时带 op 与 action」的一种写法。 */
  const wantsAssign = has("op");
  const wantsAction = has("action");
  if (wantsAssign && wantsAction) return bad;

  if (wantsAssign) {
    if (body.op !== "assign") return bad;
    /* expected_reviewer 必须显式提供（null = 我看到的是未指派）。
       缺键不能当 null —— 那等于在不知道当前值的情况下盲写。 */
    if (!has("expected_reviewer")) return { ok: false, status: 400, code: "expected_required" };
    if (!has("reviewer_id")) return bad;
    if (!isNullOrUuid(body.reviewer_id)) return bad;
    if (!isNullOrUuid(body.expected_reviewer)) return bad;
    if (has("note") && !isNullOrString(body.note)) return bad;
    return {
      ok: true, mode: "assign",
      application_id: body.application_id,
      reviewer_id: body.reviewer_id,
      expected_reviewer: body.expected_reviewer,
      note: has("note") ? body.note : null,
    };
  }

  if (!wantsAction) return bad;
  if (typeof body.action !== "string" || !ACTIONS.includes(body.action)) return bad;
  if (has("message") && !isNullOrString(body.message)) return bad;
  if (has("internal_note") && !isNullOrString(body.internal_note)) return bad;
  if (has("requirements") && body.requirements !== null && !Array.isArray(body.requirements)) return bad;
  // 要求补充资料时必须给出至少一条条目（避免空要求让申请人无从下手）
  if (body.action === "needs_information" &&
      (!Array.isArray(body.requirements) || body.requirements.length === 0)) {
    return { ok: false, status: 400, code: "requirements_required" };
  }
  return {
    ok: true, mode: "action",
    application_id: body.application_id,
    action: body.action,
    message: has("message") ? body.message : null,
    requirements: has("requirements") ? body.requirements : null,
    internal_note: has("internal_note") ? body.internal_note : null,
  };
}
