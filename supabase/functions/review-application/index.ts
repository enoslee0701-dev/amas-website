// AMAS · 招生审核（PORTAL-1）
// 调用者：registrar / academic_admin / super_admin，且 JWT 必须 aal2。
// 写库全部委托 public.review_application —— 状态迁移校验、补件条目、时间线、审计同事务。
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
    requirements?: Array<{ label: string; detail?: string }>; internal_note?: string;
  };
  try { body = await req.json(); } catch { return fail(400, "bad_request"); }
  if (!body.application_id || !ACTIONS.includes(String(body.action))) return fail(400, "bad_request");

  // 要求补充资料时必须给出至少一条条目（避免空要求让申请人无从下手）
  if (body.action === "needs_information" && (!body.requirements || body.requirements.length === 0)) {
    return fail(400, "requirements_required");
  }

  const { data, error } = await admin.rpc("review_application", {
    p_app: body.application_id,
    p_reviewer: userData.user.id,
    p_action: body.action,
    p_message: body.message ?? null,
    p_requirements: body.requirements ? JSON.stringify(body.requirements) : null,
    p_internal_note: body.internal_note ?? null,
  });

  if (error) {
    if (/invalid application transition/i.test(error.message)) return fail(409, "invalid_state");
    if (/not_found/i.test(error.message)) return fail(404, "not_found");
    return fail(500, "server_error");
  }
  return new Response(JSON.stringify(data), { headers: { ...CORS, "Content-Type": "application/json" } });
});
