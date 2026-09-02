// AMAS · 提交教师验证（规范 §6.4 步骤 4-6 / §13）
// 调用者：已登录且邮箱已验证的用户。校验：邀请码哈希匹配 + 未过期未撤销未用尽 +
// 邀请邮箱与账号邮箱一致（一次性核销为原子操作）。成功后写入/更新验证申请为 submitted。
// 部署：supabase functions deploy submit-teacher-verification

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

async function sha256b64url(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 白名单化提交资料（§6.5，不收集证件/证书文件；避免任意字段注入）
const FIELDS = ["name","name_en","phone","organization","teaching_areas","country","timezone","bio","languages","consent_terms"] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: uerr } = await admin.auth.getUser(jwt);
  if (uerr || !userData.user) return fail(401, "unauthenticated");
  const user = userData.user;
  if (!user.email_confirmed_at) return fail(403, "email_unverified");

  let body: { token?: string; form?: Record<string, unknown> };
  try { body = await req.json(); } catch { return fail(400, "bad_request"); }
  const token = String(body.token ?? "").trim();
  if (!token || token.length > 200) return fail(400, "bad_request");

  const form: Record<string, unknown> = {};
  for (const k of FIELDS) {
    const v = (body.form ?? {})[k];
    if (typeof v === "string") form[k] = v.slice(0, 500);
    if (typeof v === "boolean") form[k] = v;
  }
  if (!form.name || !form.consent_terms) return fail(400, "missing_required");

  // 原子核销邀请（一次性/限时/邮箱绑定；库中只有哈希）
  const tokenHash = await sha256b64url(token);
  const { data: invId, error: cerr } = await admin.rpc("consume_teacher_invitation", {
    p_token_hash: tokenHash, p_email: user.email ?? "",
  });
  if (cerr) {
    await admin.from("security_events").insert({
      event_type: "teacher_invite_rejected", identifier: (user.email ?? "").toLowerCase(),
      user_id: user.id,
    });
    return fail(403, "invitation_invalid");
  }

  // 建/转 submitted（触发器保证状态机合法）
  const { data: existing } = await admin.from("teacher_verification_requests")
    .select("id, status").eq("user_id", user.id)
    .not("status", "in", "(rejected,expired,revoked)").maybeSingle();

  let reqId = existing?.id as string | undefined;
  if (!reqId) {
    const { data: ins, error } = await admin.from("teacher_verification_requests").insert({
      user_id: user.id, invitation_id: invId, status: "draft", submitted_data: form,
    }).select("id").single();
    if (error) return fail(500, "server_error");
    reqId = ins.id;
  }
  const { error: uperr } = await admin.from("teacher_verification_requests").update({
    invitation_id: invId, submitted_data: form,
    status: "submitted", submitted_at: new Date().toISOString(),
  }).eq("id", reqId);
  if (uperr) return fail(409, "invalid_state");

  await admin.from("audit_logs").insert({
    actor_id: user.id, event_type: "teacher_verification_submitted",
    target_type: "teacher_verification_requests", target_id: reqId, category: "academic",
  });

  return new Response(JSON.stringify({ ok: true, request_id: reqId }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
