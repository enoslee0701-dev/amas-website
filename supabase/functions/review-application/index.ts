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

/* 请求形状校验单独成文件，好让它能被离线执行、被反例打 ——
   scripts/test-edge-validate.mjs import 的就是这一个文件，不是抄一份。 */
import { validateBody } from "./validate.mjs";

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

  let raw: unknown;
  try { raw = await req.json(); } catch { return fail(400, "bad_request"); }

  /* 形状不对是**确定的拒绝**，一律 400。不能让它退化成异常 → 500 ——
     客户端按既有判据会把 500 当「结果不明」并永久锁住那一条。 */
  const v = validateBody(raw);
  if (!v.ok) return fail(v.status, v.code);

  if (v.mode === "assign") {
    const { data, error } = await admin.rpc("assign_application_reviewer", {
      p_app: v.application_id,
      p_actor: userData.user.id,
      p_reviewer: v.reviewer_id,
      p_expected: v.expected_reviewer,
      p_note: v.note,
    });
    if (error) {
      if (/not_found/i.test(error.message)) return fail(404, "not_found");
      return fail(500, "server_error");
    }
    // 业务性拒绝（not_assignable / reassigned / not_a_reviewer）由 RPC 以 {ok:false} 200 返回
    return new Response(JSON.stringify(data), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const { data, error } = await admin.rpc("review_application", {
    p_app: v.application_id,
    p_reviewer: userData.user.id,
    p_action: v.action,
    p_message: v.message,
    p_requirements: v.requirements,
    p_internal_note: v.internal_note,
  });

  if (error) {
    if (/invalid application transition/i.test(error.message)) return fail(409, "invalid_state");
    if (/not_found/i.test(error.message)) return fail(404, "not_found");
    return fail(500, "server_error");
  }
  return new Response(JSON.stringify(data), { headers: { ...CORS, "Content-Type": "application/json" } });
});
