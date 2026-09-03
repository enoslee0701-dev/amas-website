// AMAS · 学籍生命周期（PORTAL-2）
// 调用者：registrar / academic_admin / super_admin，且 JWT 必须 aal2。
// 写库全部委托 public.* RPC —— HQ 审核门禁、状态机白名单、学号登记簿、别名同步、审计同事务。
// 本函数不含任何业务判断：角色与 aal 是入口门禁，真正的规则在 DB。
// 部署：supabase functions deploy student-lifecycle

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

const ACTIONS = [
  "confirm_hq_approval", "create_student_record", "activate_student", "correct_student_number",
  // 学号纯行政误录纠错：双人控制，发起与确认必须是不同的人（0015）
  "request_number_void", "approve_number_void", "reject_number_void",
];
const ADMIN_ROLES = ["registrar", "academic_admin", "super_admin"];
// 纠错流程只对 registrar / super_admin 开放；academic_admin 不参与身份标识级操作
const VOID_ROLES = ["registrar", "super_admin"];

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
  if (!names.some((n) => ADMIN_ROLES.includes(n))) return fail(403, "forbidden");

  let body: {
    action?: string; application_id?: string; student_id?: string;
    hq_status?: string; approval_reference?: string; visible_note?: string; internal_note?: string;
    student_number?: string; program_code?: string; message?: string; reason?: string;
    request_id?: string; replacement_number?: string; evidence_reference?: string; note?: string;
  };
  try { body = await req.json(); } catch { return fail(400, "bad_request"); }
  if (!ACTIONS.includes(String(body.action))) return fail(400, "bad_request");

  const actor = userData.user.id;
  let rpc: string, args: Record<string, unknown>;

  switch (body.action) {
    case "confirm_hq_approval":
      if (!body.application_id || !["pending", "approved", "rejected"].includes(String(body.hq_status))) {
        return fail(400, "bad_request");
      }
      rpc = "confirm_hq_approval";
      args = {
        p_app: body.application_id, p_actor: actor, p_status: body.hq_status,
        p_reference: body.approval_reference ?? null,
        p_visible_note: body.visible_note ?? null,
        p_internal_note: body.internal_note ?? null,
      };
      break;

    case "create_student_record":
      if (!body.application_id) return fail(400, "bad_request");
      rpc = "create_student_record";
      args = {
        p_app: body.application_id, p_actor: actor,
        p_student_number: body.student_number ?? null,
        p_program_code: body.program_code ?? null,
      };
      break;

    case "activate_student":
      if (!body.student_id) return fail(400, "bad_request");
      rpc = "activate_student";
      args = {
        p_student: body.student_id, p_actor: actor,
        p_message: body.message ?? null, p_internal_note: body.internal_note ?? null,
      };
      break;

    case "correct_student_number":
      // 更正必须给出原因：审计要留下"为什么改"，不是只留"改成什么"
      if (!body.student_id || !body.student_number || !String(body.reason ?? "").trim()) {
        return fail(400, "reason_required");
      }
      rpc = "correct_student_number";
      args = {
        p_student: body.student_id, p_actor: actor,
        p_new_number: body.student_number, p_reason: body.reason,
      };
      break;

    case "request_number_void":
      // 条件 3/4/6 在入口先挡一次，DB 内还会原子重验一遍
      if (!body.student_id || !body.replacement_number ||
          !String(body.reason ?? "").trim() || !String(body.evidence_reference ?? "").trim()) {
        return fail(400, "reason_and_evidence_required");
      }
      if (!names.some((n) => VOID_ROLES.includes(n))) return fail(403, "forbidden");
      rpc = "request_student_number_void";
      args = {
        p_student: body.student_id, p_actor: actor,
        p_replacement_number: body.replacement_number,
        p_reason: body.reason, p_evidence: body.evidence_reference,
      };
      break;

    case "approve_number_void":
      if (!body.request_id) return fail(400, "bad_request");
      if (!names.some((n) => VOID_ROLES.includes(n))) return fail(403, "forbidden");
      rpc = "approve_student_number_void";
      args = { p_request: body.request_id, p_actor: actor, p_note: body.note ?? null };
      break;

    case "reject_number_void":
      if (!body.request_id) return fail(400, "bad_request");
      if (!names.some((n) => VOID_ROLES.includes(n))) return fail(403, "forbidden");
      rpc = "reject_student_number_void";
      args = { p_request: body.request_id, p_actor: actor, p_note: body.note ?? null };
      break;

    default:
      return fail(400, "bad_request");
  }

  const { data, error } = await admin.rpc(rpc, args);
  if (error) {
    if (/not_found/i.test(error.message)) return fail(404, "not_found");
    if (/lacks admin role/i.test(error.message)) return fail(403, "forbidden");
    if (/invalid_state|not accepted|invalid student transition/i.test(error.message)) return fail(409, "invalid_state");
    if (/reason required|evidence required|student number required|replacement number required/i.test(error.message)) return fail(400, "bad_request");
    return fail(500, "server_error");
  }
  return new Response(JSON.stringify(data), { headers: { ...CORS, "Content-Type": "application/json" } });
});
