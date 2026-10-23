// AMAS · 学员管理系统第一期教务写入（开课 / 排教授 / 编班 / 学籍状态）
// 调用者：registrar / academic_admin / super_admin，且 JWT 必须 aal2。
// 与 student-lifecycle 同一模式：入口只验身份、角色、aal2 与参数形状，业务规则全在 0030 的 RPC 里。
// 部署：supabase functions deploy sis-admin

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

const ADMIN_ROLES = ["registrar", "academic_admin", "super_admin"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isId = (v: unknown) => typeof v === "string" && UUID.test(v);
const optDate = (v: unknown) => v === undefined || v === null || v === "" ? null
  : (typeof v === "string" && DATE.test(v) ? v : undefined);
const optText = (v: unknown, max: number) => v === undefined || v === null ? null
  : (typeof v === "string" && v.length <= max ? v : undefined);
const optInt = (v: unknown) => v === undefined || v === null || v === "" ? null
  : (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

type Body = Record<string, unknown>;

// 每个动作：参数检查 + 对应 RPC。返回 null 表示参数不合格。
const ACTIONS: Record<string, (b: Body, actor: string) => [string, Record<string, unknown>] | null> = {
  create_offering: (b, actor) => {
    const s = optDate(b.starts_on), e = optDate(b.ends_on), cap = optInt(b.capacity);
    const note = optText(b.schedule_note, 200), sec = optText(b.section_label, 40);
    if (typeof b.course_code !== "string" || typeof b.academic_year !== "string" ||
        [s, e, cap, note, sec].includes(undefined)) return null;
    return ["sis_create_offering", {
      p_actor: actor, p_course_code: b.course_code, p_academic_year: b.academic_year,
      p_delivery_mode: typeof b.delivery_mode === "string" ? b.delivery_mode : "online",
      p_starts_on: s, p_ends_on: e, p_schedule_note: note, p_section_label: sec, p_capacity: cap,
    }];
  },
  update_offering: (b, actor) => {
    const s = optDate(b.starts_on), e = optDate(b.ends_on), cap = optInt(b.capacity);
    const note = optText(b.schedule_note, 200), sec = optText(b.section_label, 40);
    if (!isId(b.offering_id) || [s, e, cap, note, sec].includes(undefined)) return null;
    return ["sis_update_offering", {
      p_offering: b.offering_id, p_actor: actor,
      p_delivery_mode: typeof b.delivery_mode === "string" ? b.delivery_mode : null,
      p_starts_on: s, p_ends_on: e, p_schedule_note: note, p_section_label: sec, p_capacity: cap,
    }];
  },
  set_offering_status: (b, actor) => {
    if (!isId(b.offering_id) || typeof b.status !== "string") return null;
    return ["sis_set_offering_status", {
      p_offering: b.offering_id, p_actor: actor, p_status: b.status, p_reason: optText(b.reason, 500) ?? null,
    }];
  },
  assign_teacher: (b, actor) => {
    if (!isId(b.offering_id) || !isId(b.teacher_id)) return null;
    return ["sis_assign_teacher", {
      p_offering: b.offering_id, p_actor: actor, p_teacher: b.teacher_id,
      p_role: b.role === "assistant" ? "assistant" : "lead",
    }];
  },
  remove_teacher: (b, actor) => {
    if (!isId(b.offering_id) || !isId(b.teacher_id)) return null;
    return ["sis_remove_teacher", {
      p_offering: b.offering_id, p_actor: actor, p_teacher: b.teacher_id,
      p_reason: optText(b.reason, 500) ?? null,
    }];
  },
  enroll_students: (b, actor) => {
    const ids = b.student_ids;
    if (!isId(b.offering_id) || !Array.isArray(ids) || ids.length === 0 || ids.length > 200 ||
        !ids.every(isId)) return null;
    return ["sis_enroll_students", { p_offering: b.offering_id, p_actor: actor, p_students: ids }];
  },
  drop_enrollment: (b, actor) => {
    if (!isId(b.enrollment_id) || typeof b.reason !== "string" || !b.reason.trim()) return null;
    return ["sis_drop_enrollment", { p_enrollment: b.enrollment_id, p_actor: actor, p_reason: b.reason }];
  },
  change_student_status: (b, actor) => {
    if (!isId(b.student_id) || !["on_leave", "active", "withdrawn"].includes(String(b.to)) ||
        typeof b.reason !== "string" || !b.reason.trim()) return null;
    return ["sis_change_student_status", {
      p_student: b.student_id, p_actor: actor, p_to: b.to, p_reason: b.reason,
      p_message: optText(b.message, 500) ?? null,
    }];
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: uerr } = await admin.auth.getUser(jwt);
  if (uerr || !userData.user) return fail(401, "unauthenticated");

  try {
    const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.aal !== "aal2") return fail(403, "mfa_required");
  } catch { return fail(401, "unauthenticated"); }

  const { data: roles } = await admin.from("user_roles").select("role")
    .eq("user_id", userData.user.id).is("revoked_at", null);
  const names = (roles ?? []).map((r: { role: string }) => r.role);
  if (!names.some((n) => ADMIN_ROLES.includes(n))) return fail(403, "forbidden");

  let body: Body;
  try { body = await req.json(); } catch { return fail(400, "bad_request"); }
  const build = ACTIONS[String(body?.action)];
  if (!build) return fail(400, "bad_request");
  const call = build(body, userData.user.id);
  if (!call) return fail(400, "bad_request");

  const { data, error } = await admin.rpc(call[0], call[1]);
  if (error) {
    if (/not_found/i.test(error.message)) return fail(404, "not_found");
    if (/lacks admin role/i.test(error.message)) return fail(403, "forbidden");
    if (/invalid student transition/i.test(error.message)) return fail(409, "invalid_state");
    return fail(500, "server_error");
  }
  // RPC 的业务拒绝（ok:false）原样返回 409，前端按 error 码给出说明
  if (data && data.ok === false) return fail(409, String(data.error || "rejected"), data);
  return new Response(JSON.stringify(data), { headers: { ...CORS, "Content-Type": "application/json" } });
});
