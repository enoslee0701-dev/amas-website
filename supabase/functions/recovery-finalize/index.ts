// AMAS · Recovery Finalization（D-AUTH-R6）
//
// 目标不是证明 Supabase 永远只消费一次 recovery credential，而是保证：
//   **即使底层 verification 在极端并发下出现多个成功结果，
//     AMAS 最终 password finalization 仍然最多执行一次。**
//
// 顺序（不可颠倒）：
//   1. 用调用者的 recovery session 验明身份（Supabase getUser —— 真正的认证在这里）
//   2. **原子 claim** flow：pending|failed_retryable → processing（由 DB 条件 UPDATE 裁决）
//   3. 只有抢到的那一个调用才执行 Auth password update
//   4. 成功 → completed；失败 → failed_retryable（受控可重试，不锁死用户）
//
// ★ recovery_flow_id 是**非秘密**的，不构成认证凭据 —— 光有 flow_id 什么也做不了，
//   必须同时持有该用户的有效 session，且 flow 归属必须匹配。
//
// ★ 密码处理边界：为实现 server-enforced idempotency，密码必须经过本函数进程内存。
//   这是允许的（Supabase Auth 自己同样要处理密码）。但**绝不**：
//   log / audit 明文 / 写 DB / 进 security_events / 进 tracing payload /
//   进 error message / 以任何形式持久化。请求结束后不留副本。
//   原则是「开发者不能获知或保存用户密码」，不是「密码字节绝不能进入认证服务器内存」。
//
// 部署：supabase functions deploy recovery-finalize

import { createClient } from "npm:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
/** 错误响应只含分类码，绝不回显密码或任何输入内容。 */
const fail = (s: number, code: string, extra?: Record<string, unknown>) =>
  new Response(JSON.stringify({ ok: false, error: code, ...(extra ?? {}) }), {
    status: s, headers: { ...CORS, "Content-Type": "application/json" },
  });

const MIN_PASSWORD = 8;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

  // ---- 1. 身份：真正的认证由 Supabase 完成，不靠 flow_id ----
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return fail(401, "unauthenticated");
  const { data: userData, error: uerr } = await admin.auth.getUser(jwt);
  if (uerr || !userData.user) return fail(401, "unauthenticated");
  const userId = userData.user.id;

  // ---- 2. 入参 ----
  // password 从这里开始只存在于本作用域的局部变量中。
  let flowId = "";
  let password = "";
  try {
    const body = await req.json() as { flow_id?: string; password?: string };
    flowId = String(body.flow_id ?? "");
    password = String(body.password ?? "");
  } catch {
    return fail(400, "bad_request");
  }
  if (!/^[0-9a-f-]{36}$/i.test(flowId)) return fail(400, "bad_request");
  if (password.length < MIN_PASSWORD) {
    // 只回长度不足这一分类，不回显任何输入
    return fail(400, "password_too_short");
  }

  // ---- 3. ★ 原子 claim：并发只有一个能从 pending → processing ----
  const { data: claim, error: cerr } = await admin.rpc("claim_recovery_flow", {
    p_flow: flowId, p_user: userId,
  });
  if (cerr) return fail(500, "server_error");
  const claimed = claim as { ok: boolean; error?: string; status?: string };
  if (!claimed.ok) {
    const code = claimed.error ?? "conflict";
    // already_completed / already_processing / conflict / flow_not_found / flow_not_owned
    const http = code === "already_completed" ? 409
      : code === "already_processing" ? 409
      : code === "flow_not_found" || code === "flow_not_owned" ? 404
      : 409;
    return fail(http, code, { status: claimed.status });
  }

  // ---- 4. 只有抢到的调用才真正改密码 ----
  let updateFailed: string | null = null;
  try {
    const { error: perr } = await admin.auth.admin.updateUserById(userId, { password });
    if (perr) {
      // ★ 只记录分类，不记录 perr.message 里可能回显的输入内容
      updateFailed = /weak|password/i.test(perr.message) ? "password_rejected" : "auth_update_failed";
    }
  } catch {
    updateFailed = "auth_update_failed";
  } finally {
    // 尽早解除本作用域对密码的引用；不写任何地方
    password = "";
  }

  if (updateFailed) {
    // 受控可重试：不因一次失败把用户永久锁死
    await admin.rpc("fail_recovery_flow", {
      p_flow: flowId, p_user: userId, p_reason: updateFailed,
    });
    return fail(502, updateFailed, { retryable: true });
  }

  const { data: done } = await admin.rpc("complete_recovery_flow", {
    p_flow: flowId, p_user: userId,
  });
  const completed = done as { ok: boolean } | null;
  if (!completed?.ok) {
    // 密码已改但状态未落定：不再重复改密码，如实回报
    return fail(500, "finalize_state_error");
  }

  return new Response(JSON.stringify({ ok: true, status: "completed" }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
