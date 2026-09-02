// AMAS · 受保护登录代理：邮箱/学号 + 密码（规范 §5.3 / §13）
// 部署：supabase functions deploy login-by-identifier --no-verify-jwt
// 环境（由 Supabase 平台注入，绝不进入前端/Git）：
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// 安全：学号→邮箱映射仅在本函数内完成；统一错误不泄露账号是否存在；15 分钟 5 次限流。

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

const RATE_WINDOW_MIN = 15;
const RATE_MAX = 5;

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
  const since = new Date(Date.now() - RATE_WINDOW_MIN * 60_000).toISOString();

  // --- 限流：同一标识或同一 IP，15 分钟内最多 5 次失败（§5.3）---
  const [{ count: cId }, { count: cIp }] = await Promise.all([
    admin.from("security_events").select("id", { count: "exact", head: true })
      .eq("event_type", "login_failed").eq("identifier", identKey).gte("created_at", since),
    admin.from("security_events").select("id", { count: "exact", head: true })
      .eq("event_type", "login_failed").eq("ip", ip).gte("created_at", since),
  ]);
  if ((cId ?? 0) >= RATE_MAX || (cIp ?? 0) >= RATE_MAX) {
    await admin.from("security_events").insert({
      event_type: "login_locked", identifier: identKey, ip,
    });
    return fail(429, "rate_limited");
  }

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
        .from("profiles").select("email, account_status")
        .eq("id", alias.user_id).maybeSingle();
      if (prof && prof.account_status === "active") email = prof.email;
    }
  }

  // --- 账号状态检查（邮箱路径）---
  if (isEmail) {
    const { data: prof } = await admin
      .from("profiles").select("id, account_status")
      .eq("email", email).maybeSingle();
    if (prof && ["locked", "suspended", "disabled"].includes(prof.account_status)) {
      email = ""; // 统一走失败分支，不泄露状态
    }
  }

  // --- 密码校验（无有效邮箱时也执行一次哑操作，尽量均衡时序）---
  const authClient = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: signIn, error } = await authClient.auth.signInWithPassword({
    email: email || `nonexistent+${crypto.randomUUID()}@invalid.amas`,
    password,
  });

  if (error || !signIn.session) {
    await admin.from("security_events").insert({
      event_type: "login_failed", identifier: identKey, ip,
      user_id: aliasUser,
    });
    return fail(401, "bad_credentials");
  }

  await admin.from("security_events").insert({
    event_type: "login_success", identifier: identKey, ip, user_id: signIn.user?.id ?? null,
  });
  await admin.from("audit_logs").insert({
    actor_id: signIn.user?.id ?? null, event_type: "login",
    target_type: "auth", target_id: isEmail ? "email" : "alias", ip,
  });

  return new Response(
    JSON.stringify({
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
    }),
    { headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
