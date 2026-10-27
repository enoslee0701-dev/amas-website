// AMAS · 创建教师邀请（规范 §6.4 / §13）
// 调用者：academic_admin 或 super_admin，且 JWT 必须为 aal2（已完成 MFA）。
// 数据库只保存邀请码 sha256 哈希；明文一次性返回给管理员，由其经可信渠道转交教师。
// 部署：supabase functions deploy create-teacher-invitation

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";

// 两步验证开关（0035_mfa_switch）：只有库里明确设为 false 才放行 aal1；读不到、出错一律按「要求」处理
type RpcClient = { rpc: (fn: string) => PromiseLike<{ data: unknown; error: unknown }> };
const mfaRequired = async (c: RpcClient) => {
  try { const { data, error } = await c.rpc("mfa_required"); return !!error || data !== false; }
  catch { return true; }
};

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

/** 校验调用者：返回 {id} 或 null。要求管理员角色 + aal2（甲方审查 #8 第二层）。 */
async function requireAdminAal2(req: Request, admin: SupabaseClient) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) return null;
  // aal 声明在 JWT payload 中
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.aal !== "aal2" && await mfaRequired(admin)) return { id: data.user.id, aalFail: true } as const;
  } catch { return null; }
  const { data: roles } = await admin.from("user_roles").select("role,expires_at")
    .eq("user_id", data.user.id).is("revoked_at", null);
  const names = (Array.isArray(roles) ? roles : []).filter((r: { role: string; expires_at?: string | null }) =>
    r && (r.expires_at == null || Date.parse(r.expires_at) > Date.now())).map((r: { role: string }) => r.role);
  if (!names.includes("academic_admin") && !names.includes("super_admin")) return null;
  return { id: data.user.id } as const;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const caller = await requireAdminAal2(req, admin);
  if (!caller) return fail(403, "forbidden");
  if ("aalFail" in caller && caller.aalFail) return fail(403, "mfa_required");

  let body: { email?: string; expected_name?: string; staff_number?: string; expires_days?: number };
  try { body = await req.json(); } catch { return fail(400, "bad_request"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "bad_request");
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, "bad_email");
  const requestedDays = Number(body.expires_days ?? 14);
  if (!Number.isFinite(requestedDays)) return fail(400, "bad_request");
  const days = Math.min(Math.max(Math.floor(requestedDays), 1), 60);

  // 明文邀请码：仅此响应返回一次
  const raw = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const tokenHash = await sha256b64url(token);

  // The database sees the caller's JWT and rechecks roles/MFA atomically.
  const callerClient = createClient(URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization")! } },
    auth: { persistSession: false },
  });
  const { data: inv, error } = await callerClient.rpc("create_teacher_invitation", {
    p_email: email, p_token_hash: tokenHash, p_expected_name: String(body.expected_name ?? "").slice(0,80),
    p_staff_number: body.staff_number ? String(body.staff_number).slice(0,40) : null, p_days: days,
  });
  if (error) return fail(error.code === "42501" ? 403 : 500, error.code === "42501" ? "forbidden" : "server_error");
  if (!inv || inv.ok !== true || !inv.id || !inv.expires_at) return fail(400, "bad_request");

  const origin = req.headers.get("origin") ?? "";
  return new Response(JSON.stringify({
    invitation_id: inv.id,
    token,                                     // 一次性明文，库中只有哈希
    link: origin ? `${origin}/faculty/verify/?code=${token}` : null,
    expires_at: inv.expires_at,
  }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
