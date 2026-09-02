// AMAS · 受保护登录代理：邮箱/学号 + 密码（规范 §5.3 / §13；加固版）
// 部署：supabase functions deploy login-by-identifier --no-verify-jwt
// 密钥由平台注入（SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY），绝不进前端/Git。
//
// 限流（甲方审查 #2）：
//   * 计数持久化在 Postgres public.security_events —— 跨 Edge 实例共享，非内存/Map；
//   * 放行判定走 RPC public.auth_rate_check：pg_advisory_xact_lock 按标识串行化，杜绝并发竞态；
//   * 成功登录写 login_success，作为该标识新的计数起点（失败计数即刻清零）；
//   * 到期清理：auth_rate_check 内机会式删除 48h 前记录；
//   * IP 说明：x-forwarded-for 由 Supabase 边缘网关注入，取第一跳；因客户端侧头部可伪造，
//     IP 仅作宽阈值(20)辅助维度，主维度是标识(5)——伪造头无法绕过标识限流。

import { createClient } from "npm:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const fail = (status: number, code: string) =>
  new Response(JSON.stringify({ error: code }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

function normalize(id: string): string {
  return id.trim().toUpperCase().replace(/\s+/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  let body: { identifier?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return fail(400, "bad_request");
  }
  const rawId = String(body.identifier ?? "");
  const password = String(body.password ?? "");
  if (!rawId || !password || rawId.length > 190 || password.length > 200) {
    return fail(400, "bad_request");
  }

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawId.trim());
  const identKey = isEmail ? rawId.trim().toLowerCase() : normalize(rawId);

  // --- 原子限流（Postgres advisory lock，见文件头说明）---
  const { data: gate, error: gateErr } = await admin.rpc("auth_rate_check", {
    p_identifier: identKey,
    p_ip: ip,
  });
  if (gateErr) return fail(500, "server_error");
  if (!gate?.allowed) return fail(429, "rate_limited");

  // --- 解析登录邮箱 ---
  let email = isEmail ? identKey : "";
  let aliasUser: string | null = null;
  if (!isEmail) {
    const { data: alias } = await admin
      .from("login_aliases")
      .select("user_id")
      .eq("alias_normalized", identKey)
      .is("revoked_at", null)
      .maybeSingle();
    if (alias) {
      aliasUser = alias.user_id;
      const { data: prof } = await admin
        .from("profiles")
        .select("email, account_status")
        .eq("id", alias.user_id)
        .maybeSingle();
      if (prof && prof.account_status === "active") email = prof.email;
    }
  } else {
    const { data: prof } = await admin
      .from("profiles")
      .select("id, account_status")
      .eq("email", email)
      .maybeSingle();
    if (prof && ["locked", "suspended", "disabled"].includes(prof.account_status)) {
      email = ""; // 统一失败分支，不泄露状态
    }
  }

  // --- 密码校验（无有效邮箱时执行哑校验，均衡时序）---
  const authClient = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: signIn, error } = await authClient.auth.signInWithPassword({
    email: email || `nonexistent+${crypto.randomUUID()}@invalid.amas`,
    password,
  });

  if (error || !signIn.session) {
    await admin.rpc("auth_record_attempt", {
      p_identifier: identKey, p_ip: ip, p_ok: false, p_user: aliasUser,
    });
    return fail(401, "bad_credentials");
  }

  await admin.rpc("auth_record_attempt", {
    p_identifier: identKey, p_ip: ip, p_ok: true, p_user: signIn.user?.id ?? null,
  });
  await admin.from("audit_logs").insert({
    actor_id: signIn.user?.id ?? null,
    event_type: "login",
    target_type: "auth",
    target_id: isEmail ? "email" : "alias",
    category: "security",
    ip,
  });

  return new Response(
    JSON.stringify({
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
    }),
    { headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
