// AMAS · 审核教师验证（规范 §6.7 / §13 / §18.5-6）
// 调用者：academic_admin 或 super_admin，且 JWT 必须 aal2。
// 实际写库全部委托数据库函数 public.review_teacher_verification —— 状态迁移校验、
// 教师档案、角色授予/撤销、学号别名与审计在同一事务内完成。
// 部署：supabase functions deploy review-teacher-verification

import { createClient } from "npm:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const fail = (s: number, c: string) =>
  new Response(JSON.stringify({ error: c }), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const ACTIONS = ["approve", "needs_information", "reject", "suspend", "reinstate", "revoke"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: uerr } = await admin.auth.getUser(jwt);
  if (uerr || !userData.user) return fail(401, "unauthenticated");

  // aal2 强制（甲方审查 #8：前端引导、此处强制、DB 函数再验角色）
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.aal !== "aal2") return fail(403, "mfa_required");
  } catch { return fail(401, "unauthenticated"); }

  const { data: roles } = await admin.from("user_roles").select("role")
    .eq("user_id", userData.user.id).is("revoked_at", null);
  const names = (roles ?? []).map((r: { role: string }) => r.role);
  if (!names.includes("academic_admin") && !names.includes("super_admin")) {
    return fail(403, "forbidden");
  }

  let body: {
    request_id?: string; action?: string; message?: string;
    staff_number?: string; grant_mentor?: boolean; internal_note?: string;
  };
  try { body = await req.json(); } catch { return fail(400, "bad_request"); }
  if (!body.request_id || !ACTIONS.includes(String(body.action))) return fail(400, "bad_request");

  const { data, error } = await admin.rpc("review_teacher_verification", {
    p_request: body.request_id,
    p_reviewer: userData.user.id,
    p_action: body.action,
    p_message: body.message ?? null,
    p_staff_number: body.staff_number ?? null,
    p_grant_mentor: !!body.grant_mentor,
    p_internal_note: body.internal_note ?? null,
  });
  if (error) {
    if (/invalid teacher verification transition/.test(error.message)) return fail(409, "invalid_state");
    return fail(500, "server_error");
  }
  return new Response(JSON.stringify(data), { headers: { ...CORS, "Content-Type": "application/json" } });
});
