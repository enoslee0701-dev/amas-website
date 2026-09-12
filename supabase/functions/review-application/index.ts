// AMAS · 招生审核（PORTAL-1）
// 调用者：registrar / academic_admin / super_admin，且 JWT 必须 aal2。
// 写库全部委托 public.review_application —— 状态迁移校验、补件条目、时间线、审计同事务。
// G1：另有一条与 action **严格互斥**的 op="assign" 分支，委托
//     public.assign_application_reviewer（0027）——只记录分工，不改任何人的访问权。
//     角色闸与 aal2 闸原样复用，不另开第二条。
// ⚠ 本改动在编写它的那次会话里**没有部署**，也没有对任何真实环境执行过：NOT_RUN。
// 部署：supabase functions deploy review-application

import { createClient } from "npm:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const fail = (s: number, c: string, extra?: Record<string, unknown>) =>
  new Response(JSON.stringify({ error: c, ...(extra || {}) }), {
    status: s, headers: { ...CORS, "Content-Type": "application/json" },
  });

const ACTIONS = ["start_review", "needs_information", "accept", "reject"];
const REVIEWER_ROLES = ["registrar", "academic_admin", "super_admin"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: uerr } = await admin.auth.getUser(jwt);
  if (uerr || !userData.user) return fail(401, "unauthenticated");

  // aal2 强制（前端引导、此处强制、DB 再验角色）
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.aal !== "aal2") return fail(403, "mfa_required");
  } catch { return fail(401, "unauthenticated"); }

  const { data: roles } = await admin.from("user_roles").select("role")
    .eq("user_id", userData.user.id).is("revoked_at", null);
  const names = (roles ?? []).map((r: { role: string }) => r.role);
  if (!names.some((n) => REVIEWER_ROLES.includes(n))) return fail(403, "forbidden");

  let body: {
    application_id?: string; action?: string; message?: string;
    // field 可选：填写后该表单字段在 needs_information 阶段解锁，供申请人修改（见 0011）
    requirements?: Array<{ label: string; detail?: string; field?: string }>; internal_note?: string;
    // G1 指派分支（与 action 互斥）
    op?: string; reviewer_id?: string | null; expected_reviewer?: string | null; note?: string;
  };
  try { body = await req.json(); } catch { return fail(400, "bad_request"); }
  if (!body.application_id) return fail(400, "bad_request");

  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  /* 两个分支**严格互斥**：同时带 op 与 action 一律拒绝，不允许「猜哪个是他想要的」。
     op 只认 "assign"，别的值也拒绝。 */
  const wantsAssign = has("op");
  const wantsAction = has("action") && body.action !== undefined && body.action !== null;
  if (wantsAssign && wantsAction) return fail(400, "bad_request");
  if (wantsAssign && body.op !== "assign") return fail(400, "bad_request");

  if (wantsAssign) {
    /* expected_reviewer 必须**显式提供**（null 表示「我看到的是未指派」）。
       缺这个键就不能当 null —— 那等于让调用方在不知道当前值的情况下盲写。 */
    if (!has("expected_reviewer")) return fail(400, "expected_required");
    if (!has("reviewer_id")) return fail(400, "bad_request");
    const rid = body.reviewer_id ?? null;
    const exp = body.expected_reviewer ?? null;
    if (rid !== null && typeof rid !== "string") return fail(400, "bad_request");
    if (exp !== null && typeof exp !== "string") return fail(400, "bad_request");

    const { data, error } = await admin.rpc("assign_application_reviewer", {
      p_app: body.application_id,
      p_actor: userData.user.id,
      p_reviewer: rid,
      p_expected: exp,
      p_note: body.note ?? null,
    });
    if (error) {
      if (/not_found/i.test(error.message)) return fail(404, "not_found");
      return fail(500, "server_error");
    }
    // 业务性拒绝（terminal_state / reassigned / not_a_reviewer）由 RPC 以 {ok:false} 200 返回
    return new Response(JSON.stringify(data), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  if (!ACTIONS.includes(String(body.action))) return fail(400, "bad_request");

  // 要求补充资料时必须给出至少一条条目（避免空要求让申请人无从下手）
  if (body.action === "needs_information" && (!body.requirements || body.requirements.length === 0)) {
    return fail(400, "requirements_required");
  }

  const { data, error } = await admin.rpc("review_application", {
    p_app: body.application_id,
    p_reviewer: userData.user.id,
    p_action: body.action,
    p_message: body.message ?? null,
    p_requirements: body.requirements ?? null,
    p_internal_note: body.internal_note ?? null,
  });

  if (error) {
    if (/invalid application transition/i.test(error.message)) return fail(409, "invalid_state");
    if (/not_found/i.test(error.message)) return fail(404, "not_found");
    return fail(500, "server_error");
  }
  return new Response(JSON.stringify(data), { headers: { ...CORS, "Content-Type": "application/json" } });
});
